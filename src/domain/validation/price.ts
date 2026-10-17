/**
 * Shared Canonical Two-Decimal Price Validation & Normalization Module for AIXSHOP v1.0.
 * 
 * Enforces a consistent two-decimal-place monetary precision policy across:
 * - Public Store Ingestion (storeIngestion.ts)
 * - Merchant Action Mutation & Approval (catalogMutationService.ts)
 * - Action Verification & Re-check (catalogMutationService.ts)
 * - Catalog Storage & Persistence (storageAdapter.ts)
 * 
 * Rounding Policy:
 * - Deterministic decimal half-up rounding to exactly two decimal places (e.g. 1.234 -> 1.23, 1.235 -> 1.24).
 * - Avoids binary floating-point multiplication errors by operating directly on decimal digits.
 * - Valid prices with more than two decimal digits are normalized, not rejected.
 * - Missing, negative, non-finite, out-of-range, and malformed inputs are strictly rejected.
 */

/**
 * Strict regex for valid merchant decimal prices:
 * - One or more decimal digits optionally followed by a single decimal dot and one or more decimal digits.
 * - Accepts: '0', '0.00', '1', '1.2', '1.23', '1.235', '199.99'
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
  formattedPrice?: string;
  rawString: string;
  reason?: string;
}

/**
 * Formats a JavaScript IEEE-754 finite number into a canonical plain decimal string
 * without scientific/exponential notation (e.g. converting 1e-7 to '0.0000001').
 */
export function numberToPlainDecimal(num: number): string {
  const str = String(num);
  if (!str.includes('e') && !str.includes('E')) {
    return str;
  }
  const [lead, expStr] = str.toLowerCase().split('e');
  const exp = parseInt(expStr, 10);
  const [intPart, fracPart = ''] = lead.split('.');
  if (exp < 0) {
    const totalLeadingZeros = -exp;
    return '0.' + '0'.repeat(totalLeadingZeros - 1) + intPart + fracPart;
  } else {
    const moved = fracPart.slice(0, exp);
    const remainingFrac = fracPart.slice(exp);
    const fullInt = intPart + moved + '0'.repeat(Math.max(0, exp - fracPart.length));
    return remainingFrac ? fullInt + '.' + remainingFrac : fullInt;
  }
}

/**
 * Normalizes a valid decimal string to its canonical mathematical decimal representation:
 * - Strips redundant leading zeros from integer part (preserving single '0')
 * - Strips redundant trailing zeros from fractional part
 * - Strips lone decimal point if all fractional digits were zeros
 */
export function toCanonicalDecimal(decimalStr: string): string {
  const parts = decimalStr.split('.');
  let intPart = parts[0].replace(/^0+(?=\d)/, '');
  if (parts.length === 1) return intPart;
  const fracPart = parts[1].replace(/0+$/, '');
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

/**
 * Normalizes a decimal string to two decimal places using deterministic half-up rounding.
 * Operates directly on decimal digits to avoid binary floating-point multiplication distortion.
 * 
 * Examples:
 * - '1' -> formatted: '1.00', numeric: 1
 * - '1.2' -> formatted: '1.20', numeric: 1.2
 * - '1.23' -> formatted: '1.23', numeric: 1.23
 * - '1.234' -> formatted: '1.23', numeric: 1.23
 * - '1.235' -> formatted: '1.24', numeric: 1.24
 * - '1.236' -> formatted: '1.24', numeric: 1.24
 * - '0.1' -> formatted: '0.10', numeric: 0.1
 * - '0.0000001' -> formatted: '0.00', numeric: 0
 * - '0' -> formatted: '0.00', numeric: 0
 * - '0.9999999999999999' -> formatted: '1.00', numeric: 1
 */
export function roundHalfUpToTwoDecimals(decimalStr: string): { formatted: string; numeric: number } {
  const parts = decimalStr.split('.');
  const intPart = parts[0].replace(/^0+(?=\d)/, '') || '0';
  const fracPart = parts[1] || '';

  if (fracPart.length <= 2) {
    const paddedFrac = (fracPart + '00').slice(0, 2);
    const formatted = `${intPart}.${paddedFrac}`;
    return { formatted, numeric: Number(formatted) };
  }

  // Decimal half-up rounding on the 3rd decimal digit
  const d1 = parseInt(fracPart[0], 10);
  const d2 = parseInt(fracPart[1], 10);
  const d3 = parseInt(fracPart[2], 10);

  let fracNum = d1 * 10 + d2;
  let carry = 0;

  if (d3 >= 5) {
    fracNum += 1;
    if (fracNum === 100) {
      fracNum = 0;
      carry = 1;
    }
  }

  const finalInt = BigInt(intPart) + BigInt(carry);
  const finalFracStr = String(fracNum).padStart(2, '0');
  const formatted = `${finalInt}.${finalFracStr}`;
  return { formatted, numeric: Number(formatted) };
}

/**
 * Parses, validates, and normalizes an unknown raw price value according to the
 * shared two-decimal-place monetary precision policy.
 * 
 * Rules:
 * 1. Legitimate zero prices (0, '0', '0.00', etc.) are accepted and normalized to 0 (formatted '0.00').
 * 2. Negative zero (-0) is safely normalized to 0.
 * 3. Never invents zero for missing, null, empty, or malformed inputs.
 * 4. Rejects values exceeding JavaScript's IEEE-754 safe numeric limit (Number.MAX_SAFE_INTEGER: 9007199254740991).
 * 5. Rejects all negative values, non-finite values (NaN, Infinity, -Infinity).
 * 6. Rejects all non-decimal bases, scientific notation strings, currency symbols, and non-numeric characters.
 * 7. Applies deterministic decimal half-up rounding to two decimal places for valid prices.
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
    if (rawPrice > Number.MAX_SAFE_INTEGER || Math.floor(rawPrice) > Number.MAX_SAFE_INTEGER) {
      return {
        isValid: false,
        price: null,
        rawString: String(rawPrice),
        reason: `Price exceeds maximum safe numeric value (Number.MAX_SAFE_INTEGER: ${Number.MAX_SAFE_INTEGER}).`,
      };
    }
    if (rawPrice === 0 || Object.is(rawPrice, -0)) {
      return { isValid: true, price: 0, formattedPrice: '0.00', rawString: String(rawPrice) };
    }

    const plain = numberToPlainDecimal(rawPrice);
    const rounded = roundHalfUpToTwoDecimals(plain);
    if (rounded.numeric > Number.MAX_SAFE_INTEGER) {
      return {
        isValid: false,
        price: null,
        rawString: String(rawPrice),
        reason: `Price exceeds maximum safe numeric value (Number.MAX_SAFE_INTEGER: ${Number.MAX_SAFE_INTEGER}).`,
      };
    }
    return { isValid: true, price: rounded.numeric, formattedPrice: rounded.formatted, rawString: String(rawPrice) };
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

    const rounded = roundHalfUpToTwoDecimals(trimmed);
    if (rounded.numeric > Number.MAX_SAFE_INTEGER) {
      return {
        isValid: false,
        price: null,
        rawString: rawPrice,
        reason: `Price exceeds maximum safe numeric value (Number.MAX_SAFE_INTEGER: ${Number.MAX_SAFE_INTEGER}).`,
      };
    }

    return { isValid: true, price: rounded.numeric, formattedPrice: rounded.formatted, rawString: rawPrice };
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
  const parsed = parseDecimalPrice(value);
  return parsed.isValid && parsed.price !== null;
}
