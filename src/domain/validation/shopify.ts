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

export type BillingRedirectFlow = 'checkout' | 'portal';

export interface BillingRedirectValidationOptions {
  flow?: BillingRedirectFlow;
  provider?: string;
  requireHttps?: boolean;
  trustedCheckoutDomains?: string[];
  trustedPortalDomains?: string[];
  trustedCustomDomains?: string[];
  currentOrigin?: string;
}

const TRUSTED_STRIPE_CHECKOUT_HOSTS = new Set<string>(['checkout.stripe.com']);
const TRUSTED_STRIPE_PORTAL_HOSTS = new Set<string>(['billing.stripe.com']);
const LOCAL_SANDBOX_HOSTS = new Set<string>(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Detects whether the frontend or test runtime is executing in production mode.
 */
export function isProductionEnvironment(): boolean {
  try {
    const metaEnv = (import.meta as any)?.env;
    if (metaEnv && (metaEnv.PROD === true || metaEnv.MODE === 'production')) {
      return true;
    }
  } catch {
    // Ignore import.meta access errors in non-ESM contexts
  }

  if (typeof process !== 'undefined' && process?.env?.NODE_ENV === 'production') {
    return true;
  }

  return false;
}

function isIpOrLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    LOCAL_SANDBOX_HOSTS.has(normalized) ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true;
  }
  // Reject IPv4 literals and bracketed IPv6 literals
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) {
    return true;
  }
  if (normalized.startsWith('[') || normalized.includes(':')) {
    return true;
  }
  return false;
}

function normalizeTrustedCustomDomainEntry(rawEntry: string): string | null {
  if (typeof rawEntry !== 'string') return null;
  const trimmed = rawEntry.trim();
  if (!trimmed || /[\s\\*]/.test(trimmed)) return null;

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const candidateUrl = hasScheme ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(candidateUrl);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username || parsed.password || parsed.port) {
      return null;
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (
      !hostname ||
      hostname.endsWith('.') ||
      hostname.includes('..') ||
      !hostname.includes('.') ||
      isIpOrLocalHostname(hostname)
    ) {
      return null;
    }

    // Strict label validation (prevent invalid characters or lookalike control tricks)
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) {
      return null;
    }

    return hostname;
  } catch {
    return null;
  }
}

/**
 * Parses an explicit list or comma-separated string of trusted Stripe custom domains
 * into exact normalized HTTPS hostnames. Invalid, wildcard, HTTP, IP, or local entries are ignored.
 */
export function parseTrustedStripeCustomDomains(rawConfig?: string | string[] | null): Set<string> {
  const result = new Set<string>();
  if (!rawConfig) return result;

  const entries = Array.isArray(rawConfig)
    ? rawConfig
    : typeof rawConfig === 'string'
    ? rawConfig.split(',')
    : [];

  for (const entry of entries) {
    const normalized = normalizeTrustedCustomDomainEntry(entry);
    if (normalized) {
      result.add(normalized);
    }
  }

  return result;
}

function readEnvVar(name: 'VITE_STRIPE_CHECKOUT_DOMAINS' | 'VITE_STRIPE_PORTAL_DOMAINS'): string | undefined {
  let raw: string | undefined;

  try {
    const metaEnv = (import.meta as any)?.env;
    if (typeof metaEnv?.[name] === 'string' && metaEnv[name].trim()) {
      raw = metaEnv[name];
    }
  } catch {
    // Ignore import.meta access errors
  }

  if (!raw && typeof process !== 'undefined' && typeof process.env?.[name] === 'string') {
    raw = process.env[name];
  }

  return raw;
}

/**
 * Reads explicitly configured trusted Stripe custom domains from Vite client config
 * (VITE_STRIPE_CHECKOUT_DOMAINS / VITE_STRIPE_PORTAL_DOMAINS) or Node env fallback.
 * Strictly separates Checkout and Customer Portal custom domain allowlists by flow.
 */
export function getConfiguredStripeCustomDomains(flow?: BillingRedirectFlow): Set<string> {
  if (flow === 'checkout') {
    return parseTrustedStripeCustomDomains(readEnvVar('VITE_STRIPE_CHECKOUT_DOMAINS'));
  }
  if (flow === 'portal') {
    return parseTrustedStripeCustomDomains(readEnvVar('VITE_STRIPE_PORTAL_DOMAINS'));
  }

  const combined = new Set<string>();
  for (const host of parseTrustedStripeCustomDomains(readEnvVar('VITE_STRIPE_CHECKOUT_DOMAINS'))) {
    combined.add(host);
  }
  for (const host of parseTrustedStripeCustomDomains(readEnvVar('VITE_STRIPE_PORTAL_DOMAINS'))) {
    combined.add(host);
  }
  return combined;
}

/**
 * Validates that an external HTTP(S) URL is well-formed with no embedded credentials or dangerous schemes.
 */
export function isValidExternalHttpUrl(
  rawUrl: unknown,
  options?: { requireHttps?: boolean }
): rawUrl is string {
  if (typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed || /[\s\\]/.test(trimmed)) return false;

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
 * Strictly validates Stripe Checkout and Customer Portal redirect URLs returned by billing endpoints.
 * - Requires HTTPS in production and for all Stripe / custom-domain redirects.
 * - Matches hostnames strictly (exact equality, no suffix wildcards) against trusted Stripe domains
 *   (checkout.stripe.com / billing.stripe.com) and explicitly configured custom domains.
 * - Rejects arbitrary external hostnames, lookalike domains, embedded credentials, and malformed URLs.
 * - Permits SandboxBillingProvider local-origin redirects ONLY in explicit non-production mode.
 */
export function isValidBillingRedirectUrl(
  rawUrl: unknown,
  options?: BillingRedirectValidationOptions
): rawUrl is string {
  const isProd = isProductionEnvironment();
  const requireHttps = options?.requireHttps ?? isProd;

  if (!isValidExternalHttpUrl(rawUrl, { requireHttps })) {
    return false;
  }

  try {
    const parsed = new URL(rawUrl.trim());
    const hostname = parsed.hostname.toLowerCase();

    // Reject trailing dots (e.g. checkout.stripe.com.) or empty hostnames
    if (!hostname || hostname.endsWith('.')) {
      return false;
    }

    // Explicit non-production SandboxBillingProvider allowance restricted strictly to local/current origin
    if (options?.provider === 'sandbox' && !isProd && !options?.requireHttps) {
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return false;
      }

      if (LOCAL_SANDBOX_HOSTS.has(hostname)) {
        return true;
      }

      const originToCheck =
        options.currentOrigin ||
        (typeof window !== 'undefined' && window.location ? window.location.origin : undefined);

      if (originToCheck && isValidExternalHttpUrl(originToCheck)) {
        try {
          const parsedOrigin = new URL(originToCheck);
          if (parsed.origin === parsedOrigin.origin) {
            return true;
          }
        } catch {
          return false;
        }
      }

      return false;
    }

    // All real Stripe / custom-domain redirects strictly require HTTPS with standard port (no HTTP downgrade)
    if (parsed.protocol !== 'https:' || parsed.port !== '') {
      return false;
    }

    const flow = options?.flow;
    if (flow === 'checkout') {
      if (TRUSTED_STRIPE_CHECKOUT_HOSTS.has(hostname)) {
        return true;
      }
      const checkoutDomains =
        options?.trustedCheckoutDomains !== undefined
          ? parseTrustedStripeCustomDomains(options.trustedCheckoutDomains)
          : getConfiguredStripeCustomDomains('checkout');
      return checkoutDomains.has(hostname);
    }

    if (flow === 'portal') {
      if (TRUSTED_STRIPE_PORTAL_HOSTS.has(hostname)) {
        return true;
      }
      const portalDomains =
        options?.trustedPortalDomains !== undefined
          ? parseTrustedStripeCustomDomains(options.trustedPortalDomains)
          : getConfiguredStripeCustomDomains('portal');
      return portalDomains.has(hostname);
    }

    if (TRUSTED_STRIPE_CHECKOUT_HOSTS.has(hostname) || TRUSTED_STRIPE_PORTAL_HOSTS.has(hostname)) {
      return true;
    }

    const customDomains =
      options?.trustedCustomDomains !== undefined
        ? parseTrustedStripeCustomDomains(options.trustedCustomDomains)
        : getConfiguredStripeCustomDomains();

    if (customDomains.has(hostname)) {
      return true;
    }

    return false;
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
  if (!isValidExternalHttpUrl(url)) {
    return;
  }
  if (typeof window !== 'undefined' && window.location) {
    window.location.href = url;
  }
}
