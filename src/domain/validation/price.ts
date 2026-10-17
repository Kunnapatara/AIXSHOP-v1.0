/**
 * Canonical Decimal Price Validation Primitive for AIXSHOP v1.0.
 * 
 * Shared neutral domain module used across:
 * - Public Store Ingestion (storeIngestion.ts)
 * - Merchant Action Mutation & Approval (catalogMutationService.ts)
 * - Action Verification & Re-check (catalogMutationService.ts)
 * 
 * Eliminates circular dependencies between ingestion and catalog mutation.
 */

/**
 * Strict regex for valid merchant decimal prices:
 * - One or more decimal digits optionally followed by a single decimal dot and one or more decimal digits.
 * - Accepts: '0', '0.00', '1', '12.34', '199.99'
 * - Rejects:
 *   - Empty and whitespace-only strings
 *   - Leading dot without digits: '.5'
 *   - Trailing dot without digits: '1.'
 *   - Leading signs: '+1', '-1', '-0'
 *   - Currency symbols: '$12.34', '€10'
 *   - Hexadecimal: '0x10', '0X1A'
 *   - Binary: '0b101'
 *   - Octal: '0o77'
 *   - Exponential / scientific notation: '1e3', '2.5E2'
 *   - Multiple decimal points: '12..34', '12.34.56'
 *   - Alphabetic characters and garbage: '12.34usd', 'free'
 */
export const DECIMAL_PRICE_REGEX = /^\d+(\.\d+)?$/;

export interface ParsedPriceResult {
  isValid: boolean;
  price: number | null;
  rawString: string;
  reason?: string;
}

/**
 * Parses and validates an unknown raw price value against canonical decimal price constraints.
 * 
 * Guarantees:
 * 1. Legitimate zero prices (0, '0', '0.00') are accepted and preserved as numeric 0.
 * 2. Negative zero (-0) is safely normalized to ordinary 0.
 * 3. Never invents zero for missing, null, empty, or malformed inputs.
 * 4. Rejects values exceeding JavaScript's IEEE-754 safe numeric limit (Number.MAX_SAFE_INTEGER).
 * 5. Rejects all non-decimal bases, scientific notation, signs, currency symbols, and non-numeric characters.
 */
export function parseDecimalPrice(rawPrice: unknown): ParsedPriceResult {
  if (rawPrice === undefined || rawPrice === null) {
    return {
      isValid: false,
      price: null,
      rawString: String(rawPrice),
      reason: 'Price is missing or null.',
    };
  }

  if (typeof rawPrice === 'number') {
    if (isNaN(rawPrice)) {
      return { isValid: false, price: null, rawString: 'NaN', reason: 'Price is NaN.' };
    }
    if (!isFinite(rawPrice)) {
      return { isValid: false, price: null, rawString: String(rawPrice), reason: `Price must be finite (received ${rawPrice}).` };
    }
    if (rawPrice < 0) {
      return { isValid: false, price: null, rawString: String(rawPrice), reason: `Price cannot be negative (received ${rawPrice}).` };
    }
    if (rawPrice > Number.MAX_SAFE_INTEGER) {
      return {
        isValid: false,
        price: null,
        rawString: String(rawPrice),
        reason: `Price exceeds maximum safe numeric value (Number.MAX_SAFE_INTEGER: ${Number.MAX_SAFE_INTEGER}).`,
      };
    }
    // Normalize -0 to 0
    const normalizedPrice = (rawPrice === 0 || Object.is(rawPrice, -0)) ? 0 : rawPrice;
    return { isValid: true, price: normalizedPrice, rawString: String(rawPrice) };
  }

  if (typeof rawPrice === 'string') {
    const trimmed = rawPrice.trim();
    if (trimmed === '') {
      return {
        isValid: false,
        price: null,
        rawString: rawPrice,
        reason: 'Price is empty or whitespace-only.',
      };
    }

    if (!DECIMAL_PRICE_REGEX.test(trimmed)) {
      return {
        isValid: false,
        price: null,
        rawString: rawPrice,
        reason: `Malformed price string "${rawPrice}": must be a valid non-negative decimal merchant price without currency symbols, letters, signs, exponential notation, or non-decimal bases.`,
      };
    }

    const num = Number(trimmed);
    if (isNaN(num)) {
      return {
        isValid: false,
        price: null,
        rawString: rawPrice,
        reason: `Malformed price string "${rawPrice}".`,
      };
    }
    if (!isFinite(num)) {
      return {
        isValid: false,
        price: null,
        rawString: rawPrice,
        reason: `Price must be finite (received "${rawPrice}").`,
      };
    }
    if (num < 0) {
      return {
        isValid: false,
        price: null,
        rawString: rawPrice,
        reason: `Price cannot be negative (received "${rawPrice}").`,
      };
    }
    if (num > Number.MAX_SAFE_INTEGER) {
      return {
        isValid: false,
        price: null,
        rawString: rawPrice,
        reason: `Price exceeds maximum safe numeric value (Number.MAX_SAFE_INTEGER: ${Number.MAX_SAFE_INTEGER}).`,
      };
    }

    const normalizedPrice = (num === 0 || Object.is(num, -0)) ? 0 : num;
    return { isValid: true, price: normalizedPrice, rawString: rawPrice };
  }

  return {
    isValid: false,
    price: null,
    rawString: String(rawPrice),
    reason: `Invalid price data type: ${typeof rawPrice}.`,
  };
}

/**
 * Backward-compatible alias for existing ingestion and catalog import callers.
 */
export const parseSourcePrice = parseDecimalPrice;

/**
 * Returns true if the string represents a strictly valid, non-negative decimal price within safe numeric bounds.
 */
export function isValidDecimalPriceString(value: string): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!DECIMAL_PRICE_REGEX.test(trimmed)) return false;
  const num = Number(trimmed);
  return !isNaN(num) && isFinite(num) && num >= 0 && num <= Number.MAX_SAFE_INTEGER;
}
