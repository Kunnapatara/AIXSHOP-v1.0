export type GtinFormat = 'GTIN-8' | 'GTIN-12' | 'GTIN-13' | 'GTIN-14';

export interface GtinValidationResult {
  isValid: boolean;
  format: GtinFormat | null;
  normalized: string;
  reason?: string;
}

const LENGTH_TO_FORMAT: Readonly<Record<number, GtinFormat>> = {
  8: 'GTIN-8',
  12: 'GTIN-12',
  13: 'GTIN-13',
  14: 'GTIN-14',
};

/**
 * Computes and verifies the standard GS1 Modulo-10 check digit for
 * GTIN-8 (EAN-8), GTIN-12 (UPC-A), GTIN-13 (EAN-13), and GTIN-14.
 * Preserves leading zeros (e.g., UPC-A / EAN-13 leading zero codes).
 */
export function validateGtin(barcode: string): GtinValidationResult {
  if (!barcode || typeof barcode !== 'string') {
    return {
      isValid: false,
      format: null,
      normalized: '',
      reason: 'Barcode is missing or not a string.',
    };
  }

  const trimmed = barcode.trim();
  if (!trimmed) {
    return {
      isValid: false,
      format: null,
      normalized: '',
      reason: 'Barcode is empty.',
    };
  }

  if (!/^\d+$/.test(trimmed)) {
    return {
      isValid: false,
      format: null,
      normalized: trimmed,
      reason: 'Barcode must contain digits only.',
    };
  }

  const format = LENGTH_TO_FORMAT[trimmed.length] || null;
  if (!format) {
    return {
      isValid: false,
      format: null,
      normalized: trimmed,
      reason: `Unsupported GTIN length (${trimmed.length} digits). Expected 8, 12, 13, or 14 digits.`,
    };
  }

  if (/^0+$/.test(trimmed)) {
    return {
      isValid: false,
      format,
      normalized: trimmed,
      reason: 'All-zero dummy barcode is not a valid GS1 GTIN.',
    };
  }

  // Standard GS1 right-to-left alternating weights (3, 1, 3, 1...) from the last payload digit
  const payloadLength = trimmed.length - 1;
  let sum = 0;
  for (let i = payloadLength - 1; i >= 0; i--) {
    const digit = parseInt(trimmed[i], 10);
    const positionFromRight = payloadLength - 1 - i;
    const weight = positionFromRight % 2 === 0 ? 3 : 1;
    sum += digit * weight;
  }

  const expectedCheckDigit = (10 - (sum % 10)) % 10;
  const actualCheckDigit = parseInt(trimmed[payloadLength], 10);

  if (expectedCheckDigit !== actualCheckDigit) {
    return {
      isValid: false,
      format,
      normalized: trimmed,
      reason: `Check digit mismatch for ${format}: expected ${expectedCheckDigit}, got ${actualCheckDigit}.`,
    };
  }

  return {
    isValid: true,
    format,
    normalized: trimmed,
  };
}

/**
 * Validates any standard GS1 GTIN format (GTIN-8, GTIN-12 / UPC-A, GTIN-13 / EAN-13, GTIN-14).
 */
export function isValidGtin(barcode: string): boolean {
  return validateGtin(barcode).isValid;
}

/**
 * Canonical GTIN-13 check digit validation function.
 * Implements the standard GS1 mod-10 check digit calculation for 13-digit EAN/GTIN-13.
 */
export function isValidGtin13(barcode: string): boolean {
  const result = validateGtin(barcode);
  return result.isValid && result.format === 'GTIN-13';
}
