/**
 * Canonical GTIN-13 check digit validation function.
 * Implements the standard GS1 mod-10 check digit calculation.
 */
export function isValidGtin13(barcode: string): boolean {
  if (!barcode || typeof barcode !== 'string') return false;
  const trimmed = barcode.trim();
  if (!/^\d{13}$/.test(trimmed)) return false;

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(trimmed[i], 10);
    sum += digit * (i % 2 === 0 ? 1 : 3);
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(trimmed[12], 10);
}
