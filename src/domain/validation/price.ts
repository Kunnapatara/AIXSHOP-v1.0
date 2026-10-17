/**
 * Canonical Decimal Price Validation Primitive for AIXSHOP v1.0.
 * 
 * Shared neutral domain module used across:
 * - Public Store Ingestion (storeIngestion.ts)
 * - Merchant Action Mutation & Approval (catalogMutationService.ts)
 * - Action Verification & Re-check (catalogMutationService.ts)
 * 
 * Eliminates circular dependencies and enforces monetary decimal precision invariants.
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
 * Normalizes a valid decimal string to its canonical mathematical decimal representation:
 * - Strips redundant leading zeros from integer part (preserving single '0')
 * - Strips redundant trailing zeros from fractional part
 * - Strips lone decimal point if all fractional digits were zeros
 * 
 * Examples:
 * - '007.50' -> '7.5'
 * - '0.10' -> '0.1'
 * - '0.00' -> '0'
 * - '12.3400' -> '12.34'
 */
export function toCanonicalDecimal(decimalStr: string): string {
  const parts = decimalStr.split('.');
  let intPart = parts[0].replace(/^0+(?=\d)/, '');
  if (parts.length === 1) return intPart;
  const fracPart = parts[1].replace(/0+$/, '');
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

/**
 * Formats a JavaScript IEEE-754 finite number into a canonical plain decimal string
 * without scientific/exponential notation (e.g. converting 1e-7 to '0.0000001').
 * Prevents false rejection of small valid fractions whose default String(num) uses scientific notation.
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
 * Parses and validates an unknown raw price value against canonical decimal price constraints.
 * 
 * Monetary Precision Invariants:
 * 1. Legitimate zero prices (0, '0', '0.00') are accepted and preserved as numeric 0.
 * 2. Negative zero (-0) is safely normalized to ordinary 0.
 * 3. Never invents zero for missing, null, empty, or malformed inputs.
 * 4. Rejects values exceeding JavaScript's IEEE-754 safe numeric limit (Number.MAX_SAFE_INTEGER: 9007199254740991).
 * 5. Rejects decimal values that suffer floating-point precision loss (e.g. '0.10000000000000001' or '1.234567890123456789')
 *    where JavaScript binary64 cannot represent the exact mathematical decimal value.
 * 6. Rejects all non-decimal bases, scientific notation, signs, currency symbols, and non-numeric characters.
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

    const canonicalStr = toCanonicalDecimal(trimmed);
    const num = Number(canonicalStr);

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
    if (num > Number.MAX_SAFE_INTEGER || Math.floor(num) > Number.MAX_SAFE_INTEGER) {
      return {
        isValid: false,
        price: null,
        rawString: rawPrice,
        reason: `Price exceeds maximum safe numeric value (Number.MAX_SAFE_INTEGER: ${Number.MAX_SAFE_INTEGER}).`,
      };
    }

    // Precision Invariant: Verify that binary floating-point representation does not silently alter
    // or truncate the decimal precision of the intended monetary value.
    // Convert to plain decimal string to prevent false rejection of small valid fractions (e.g. 0.0000001 / 1e-7).
    const plainDecimal = numberToPlainDecimal(num);
    if (plainDecimal !== canonicalStr) {
      return {
        isValid: false,
        price: null,
        rawString: rawPrice,
        reason: `Price string "${rawPrice}" cannot be represented safely without floating-point precision loss.`,
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
 * Returns true if the string represents a strictly valid, non-negative decimal price within safe numeric bounds
 * without floating-point precision loss.
 */
export function isValidDecimalPriceString(value: string): boolean {
  if (typeof value !== 'string') return false;
  const parsed = parseDecimalPrice(value);
  return parsed.isValid && parsed.price !== null;
}
