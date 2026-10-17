import { Product } from '../../types';
import { isValidGtin13 } from '../validation/gtin';

/**
 * Calculates a deterministic catalog completeness score (0-100) based on actual product fields.
 * 
 * Rules:
 * 1. Core entity properties (up to 40 pts)
 * 2. Structured attributes (up to 30 pts)
 * 3. Variant integrity and valid GTIN-13 barcodes (up to 20 pts)
 * 4. Evidence documents verified (up to 10 pts)
 */
export function calculateProductCompleteness(product: Product): number {
  if (!product) return 0;
  let score = 0;

  // 1. Core entity properties (up to 40 pts)
  if (product.title && product.title.trim().length >= 3 && product.title.trim() !== 'Untitled Product') score += 10;
  if (product.brand && product.brand.trim().length > 0 && product.brand.trim() !== 'Unknown Brand' && product.brand.trim() !== 'Unspecified') score += 8;
  if (product.category && product.category.trim().length > 0 && product.category.trim() !== 'General Merchandise' && product.category.trim() !== 'Unspecified') score += 8;
  if (product.description && product.description.trim().length >= 10) score += 8;
  if (product.image && product.image.trim().length > 0) score += 6;

  // 2. Structured attributes (up to 30 pts)
  const attributes = product.attributes || {};
  const filledAttrs = Object.entries(attributes).filter(([, v]) => {
    if (!v || typeof v !== 'string') return false;
    const trimmed = v.trim();
    return trimmed !== '' && trimmed !== 'Unspecified' && trimmed !== '(none)';
  });
  score += Math.min(30, filledAttrs.length * 6);

  // 3. Variant integrity (up to 20 pts)
  if (product.variants && product.variants.length > 0) {
    const validVariants = product.variants.filter(
      v => v.barcode && isValidGtin13(v.barcode)
    ).length;
    const ratio = validVariants / product.variants.length;
    score += Math.round(ratio * 20);
  }

  // 4. Evidence documents (up to 10 pts)
  if (product.evidenceDocuments && product.evidenceDocuments.length > 0) {
    const verifiedDocs = product.evidenceDocuments.filter(d => d.status === 'verified').length;
    score += Math.min(10, verifiedDocs * 5);
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Calculates the average completeness score across all canonical products in the catalog.
 */
export function calculateStoreCompletenessAvg(products: Product[]): number {
  if (!products || products.length === 0) return 0;
  const total = products.reduce((acc, p) => acc + calculateProductCompleteness(p), 0);
  return Math.round(total / products.length);
}
