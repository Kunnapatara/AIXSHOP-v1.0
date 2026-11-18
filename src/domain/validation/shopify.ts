export type ShopDomainValidationResult =
  | { valid: true; shopDomain: string }
  | { valid: false; error: string };

/**
 * Normalizes a raw Shopify store input into a canonical *.myshopify.com hostname.
 * Mirrors server-side normalization without importing Node/process globals.
 */
export function normalizeShopDomain(rawShop: string): string {
  if (!rawShop || typeof rawShop !== 'string') return '';
  let cleaned = rawShop.trim().toLowerCase();
  if (!cleaned) return '';

  // Reject dangerous URI schemes or whitespace before normalization
  if (/[\s]/.test(cleaned) || /^(javascript|data|vbscript|file):/i.test(cleaned)) {
    return '';
  }

  if (cleaned.startsWith('https://')) cleaned = cleaned.slice(8);
  else if (cleaned.startsWith('http://')) cleaned = cleaned.slice(7);

  cleaned = cleaned.split('/')[0];
  cleaned = cleaned.split('?')[0];
  cleaned = cleaned.split('#')[0];
  cleaned = cleaned.split(':')[0];

  if (!cleaned) return '';

  if (!cleaned.includes('.')) {
    cleaned = `${cleaned}.myshopify.com`;
  }

  return cleaned;
}

/**
 * Checks whether a hostname strictly matches the canonical Shopify store format:
 * [a-zA-Z0-9][a-zA-Z0-9-]*.myshopify.com
 */
export function isValidShopDomain(shop: string): boolean {
  if (!shop || typeof shop !== 'string') return false;
  const trimmed = shop.trim().toLowerCase();
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(trimmed);
}

/**
 * Validates and normalizes user-entered Shopify domain input before making an API request.
 */
export function validateAndNormalizeShopDomain(rawShop: string): ShopDomainValidationResult {
  if (!rawShop || typeof rawShop !== 'string' || !rawShop.trim()) {
    return {
      valid: false,
      error: 'Please enter your Shopify store domain (e.g. my-store.myshopify.com).',
    };
  }

  const normalized = normalizeShopDomain(rawShop);
  if (!normalized || !isValidShopDomain(normalized)) {
    return {
      valid: false,
      error: 'Please enter a valid Shopify store domain ending in .myshopify.com (or store handle).',
    };
  }

  return {
    valid: true,
    shopDomain: normalized,
  };
}

/**
 * Validates that an external redirect URL returned by the backend (Checkout / Portal)
 * is a well-formed absolute HTTP/HTTPS URL with no embedded credentials or dangerous schemes.
 */
export function isValidExternalHttpUrl(
  rawUrl: unknown,
  options?: { requireHttps?: boolean }
): rawUrl is string {
  if (typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed || /[\s]/.test(trimmed)) return false;

  try {
    const parsed = new URL(trimmed);
    const allowedProtocols = options?.requireHttps ? ['https:'] : ['https:', 'http:'];
    if (!allowedProtocols.includes(parsed.protocol)) {
      return false;
    }
    if (!parsed.hostname) {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates that a Shopify OAuth authorization URL returned by GET /api/shopify/connect
 * is a strict HTTPS Shopify OAuth URL before redirecting the browser.
 */
export function isValidShopifyAuthUrl(rawUrl: unknown): rawUrl is string {
  if (!isValidExternalHttpUrl(rawUrl, { requireHttps: true })) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl.trim());
    const hostname = parsed.hostname.toLowerCase();
    const isShopifyHost = isValidShopDomain(hostname) || hostname === 'admin.shopify.com';
    if (!isShopifyHost) {
      return false;
    }
    const isOAuthPath =
      parsed.pathname.startsWith('/admin/oauth/authorize') ||
      (hostname === 'admin.shopify.com' && parsed.pathname.includes('/oauth/authorize'));
    return isOAuthPath;
  } catch {
    return false;
  }
}

/**
 * Safely navigates the browser to a validated external URL.
 */
export function redirectBrowser(url: string): void {
  if (typeof window !== 'undefined' && window.location) {
    window.location.href = url;
  }
}
