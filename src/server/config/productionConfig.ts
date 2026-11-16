import { Request } from 'express';
import { getPostgresPoolConfig } from '../db/index';
import { getEncryptionKey } from '../security/encryption';

export interface ProductionConfigValidationResult {
  valid: boolean;
  environment: string;
  missingOrInvalid: string[];
  checks: {
    postgresConfigured: boolean;
    appUrlValid: boolean;
    encryptionKeyValid: boolean;
    billingConfigValid: boolean;
    shopifyConfigValid: boolean;
    trustProxyValid: boolean;
    devOverridesDisabled: boolean;
    rateLimitPolicyValid: boolean;
  };
}

export type AuthRateLimitFailureMode = 'fail_closed' | 'fallback_local';

/**
 * Resolves the explicit failure policy for shared authentication rate limiting.
 * - Default in production (`NODE_ENV=production`): 'fail_closed' (HTTP 503 on shared store outage).
 * - Default in development/test: 'fallback_local' (bounded in-memory fallback).
 * - Can be explicitly overridden with `AUTH_RATE_LIMIT_FAILURE_MODE=fail_closed|fallback_local`.
 */
export function resolveAuthRateLimitFailurePolicy(
  env = process.env.NODE_ENV,
  configuredMode = process.env.AUTH_RATE_LIMIT_FAILURE_MODE
): {
  valid: boolean;
  mode: AuthRateLimitFailureMode;
  failClosedOnStorageError: boolean;
  explicitOverride: boolean;
  error?: string;
} {
  const isProd = env === 'production';
  const raw = configuredMode?.trim().toLowerCase();

  if (!raw) {
    return {
      valid: true,
      mode: isProd ? 'fail_closed' : 'fallback_local',
      failClosedOnStorageError: isProd,
      explicitOverride: false,
    };
  }

  if (raw === 'fail_closed') {
    return {
      valid: true,
      mode: 'fail_closed',
      failClosedOnStorageError: true,
      explicitOverride: true,
    };
  }

  if (raw === 'fallback_local') {
    return {
      valid: true,
      mode: 'fallback_local',
      failClosedOnStorageError: false,
      explicitOverride: true,
    };
  }

  return {
    valid: false,
    mode: isProd ? 'fail_closed' : 'fallback_local',
    failClosedOnStorageError: isProd,
    explicitOverride: false,
    error: `Unsupported AUTH_RATE_LIMIT_FAILURE_MODE setting "${configuredMode}". Expected "fail_closed" or "fallback_local".`,
  };
}

const KNOWN_PLACEHOLDER_URLS = new Set(['MY_APP_URL', 'http://localhost:3000', 'https://example.com']);

/**
 * Validates and normalizes an application base URL.
 * In production, enforces HTTPS, no embedded credentials, no query/hash, and rejects dev placeholders.
 */
export function validateProductionAppUrl(
  rawUrl: string | undefined,
  options: { allowHttpLocal?: boolean; varName?: string } = {}
): { valid: boolean; normalizedUrl?: string; origin?: string; error?: string } {
  const varName = options.varName || 'APP_URL';
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { valid: false, error: `${varName} is not configured.` };
  }

  const trimmed = rawUrl.trim();
  if (KNOWN_PLACEHOLDER_URLS.has(trimmed)) {
    return { valid: false, error: `${varName} uses placeholder/local value "${trimmed}".` };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: `${varName} is not a valid URL.` };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: `${varName} must not contain credentials.` };
  }

  if (parsed.search || parsed.hash) {
    return { valid: false, error: `${varName} must not contain query parameters or fragments.` };
  }

  const isLocalHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (!options.allowHttpLocal) {
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: `${varName} must use https:// in production.` };
    }
    if (isLocalHost) {
      return { valid: false, error: `${varName} must not point to localhost in production.` };
    }
  } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, error: `${varName} must use http:// or https://.` };
  }

  const normalizedUrl = `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')}`;
  return { valid: true, normalizedUrl, origin: parsed.origin };
}

export interface ShopifyUrlConfigResult {
  valid: boolean;
  appUrl: string;
  redirectUri: string;
  webhookUrl: string;
  error?: string;
}

function validateShopifyEndpointOverride(
  rawUrl: string,
  varName: string,
  trustedBaseUrl: string,
  isProd: boolean
): { valid: boolean; normalizedUrl?: string; error?: string } {
  const trimmed = rawUrl.trim();
  if (KNOWN_PLACEHOLDER_URLS.has(trimmed)) {
    return { valid: false, error: `${varName} uses placeholder/local value "${trimmed}".` };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: `${varName} is not a valid URL.` };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: `${varName} must not contain credentials.` };
  }

  if (parsed.hash) {
    return { valid: false, error: `${varName} must not contain fragments.` };
  }

  const isLocalHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (isProd) {
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: `${varName} must use https:// in production.` };
    }
    if (isLocalHost) {
      return { valid: false, error: `${varName} must not point to localhost in production.` };
    }
    const allowedOrigins = getAllowedRedirectOrigins(trustedBaseUrl);
    if (!allowedOrigins.has(parsed.origin)) {
      return { valid: false, error: `${varName} origin (${parsed.origin}) does not match trusted app origin (${new URL(trustedBaseUrl).origin}).` };
    }
  } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, error: `${varName} must use http:// or https://.` };
  }

  return { valid: true, normalizedUrl: parsed.toString() };
}

/**
 * Validates and resolves Shopify OAuth & webhook URLs from environment variables.
 * - Precedence: SHOPIFY_APP_URL > APP_URL (> http://localhost:3000 in development/test only).
 * - In production (NODE_ENV=production): strictly requires valid HTTPS non-localhost URLs,
 *   never falls back to localhost, and never uses request Host/X-Forwarded-* headers.
 */
export function validateShopifyUrlConfig(): ShopifyUrlConfigResult {
  const isProd = process.env.NODE_ENV === 'production';
  const rawShopifyAppUrl = process.env.SHOPIFY_APP_URL?.trim() || '';
  const rawAppUrl = process.env.APP_URL?.trim() || '';
  const rawRedirectUri = process.env.SHOPIFY_REDIRECT_URI?.trim() || '';
  const rawWebhookUrl = process.env.SHOPIFY_WEBHOOK_URL?.trim() || '';

  let appUrl = '';

  if (isProd) {
    const candidate = rawShopifyAppUrl || rawAppUrl;
    const sourceVar = rawShopifyAppUrl ? 'SHOPIFY_APP_URL' : (rawAppUrl ? 'APP_URL' : 'SHOPIFY_APP_URL (or APP_URL)');
    const baseCheck = validateProductionAppUrl(candidate, { allowHttpLocal: false, varName: sourceVar });
    if (!baseCheck.valid || !baseCheck.normalizedUrl) {
      return {
        valid: false,
        appUrl: '',
        redirectUri: '',
        webhookUrl: '',
        error: baseCheck.error || 'Trusted production Shopify app URL is not configured.',
      };
    }
    appUrl = baseCheck.normalizedUrl;
  } else {
    if (rawShopifyAppUrl && rawShopifyAppUrl !== 'MY_APP_URL') {
      const devCheck = validateProductionAppUrl(rawShopifyAppUrl, { allowHttpLocal: true, varName: 'SHOPIFY_APP_URL' });
      if (!devCheck.valid || !devCheck.normalizedUrl) {
        return {
          valid: false,
          appUrl: '',
          redirectUri: '',
          webhookUrl: '',
          error: devCheck.error || 'SHOPIFY_APP_URL is invalid.',
        };
      }
      appUrl = devCheck.normalizedUrl;
    } else if (rawAppUrl && rawAppUrl !== 'MY_APP_URL') {
      const devAppCheck = validateProductionAppUrl(rawAppUrl, { allowHttpLocal: true, varName: 'APP_URL' });
      if (devAppCheck.valid && devAppCheck.normalizedUrl) {
        appUrl = devAppCheck.normalizedUrl;
      } else {
        appUrl = 'http://localhost:3000';
      }
    } else {
      appUrl = 'http://localhost:3000';
    }
  }

  let redirectUri = `${appUrl}/api/shopify/callback`;
  if (rawRedirectUri) {
    const redirectCheck = validateShopifyEndpointOverride(rawRedirectUri, 'SHOPIFY_REDIRECT_URI', appUrl, isProd);
    if (!redirectCheck.valid || !redirectCheck.normalizedUrl) {
      return {
        valid: false,
        appUrl,
        redirectUri: '',
        webhookUrl: '',
        error: redirectCheck.error,
      };
    }
    redirectUri = redirectCheck.normalizedUrl;
  }

  let webhookUrl = `${appUrl}/api/shopify/webhooks`;
  if (rawWebhookUrl) {
    const webhookCheck = validateShopifyEndpointOverride(rawWebhookUrl, 'SHOPIFY_WEBHOOK_URL', appUrl, isProd);
    if (!webhookCheck.valid || !webhookCheck.normalizedUrl) {
      return {
        valid: false,
        appUrl,
        redirectUri,
        webhookUrl: '',
        error: webhookCheck.error,
      };
    }
    webhookUrl = webhookCheck.normalizedUrl;
  }

  return { valid: true, appUrl, redirectUri, webhookUrl };
}

/**
 * Returns trusted Shopify OAuth & webhook URLs or throws an explicit configuration error.
 */
export function getTrustedShopifyUrls(): { appUrl: string; redirectUri: string; webhookUrl: string } {
  const result = validateShopifyUrlConfig();
  if (!result.valid) {
    const err: any = new Error(
      `[AIXSHOP Shopify Config] Trusted Shopify URL configuration invalid: ${result.error}`
    );
    err.statusCode = 500;
    err.code = process.env.NODE_ENV === 'production' ? 'INVALID_PRODUCTION_SHOPIFY_URL' : 'INVALID_SHOPIFY_URL';
    throw err;
  }
  return {
    appUrl: result.appUrl,
    redirectUri: result.redirectUri,
    webhookUrl: result.webhookUrl,
  };
}

/**
 * Parses explicit comma-separated ALLOWED_APP_ORIGINS whitelist.
 */
export function getAllowedRedirectOrigins(baseUrl: string): Set<string> {
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(baseUrl).origin);
  } catch {
    // ignore
  }

  const extra = process.env.ALLOWED_APP_ORIGINS || '';
  if (extra.trim()) {
    for (const part of extra.split(',')) {
      const candidate = part.trim();
      if (!candidate) continue;
      try {
        const parsed = new URL(candidate);
        if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
          continue;
        }
        allowed.add(parsed.origin);
      } catch {
        // ignore invalid entries
      }
    }
  }
  return allowed;
}

/**
 * Derives trusted base URL for checkout / portal / OAuth redirects.
 * - Production: strictly requires valid HTTPS APP_URL; NEVER inspects Host or X-Forwarded-* headers.
 * - Non-production: uses valid APP_URL if set, or safely falls back to sanitized local host.
 */
export function getTrustedBaseUrl(req?: Pick<Request, 'headers' | 'protocol'>): string {
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    const check = validateProductionAppUrl(process.env.APP_URL, { allowHttpLocal: false });
    if (!check.valid || !check.normalizedUrl) {
      const err: any = new Error(`Trusted production APP_URL configuration invalid: ${check.error}`);
      err.statusCode = 500;
      err.code = 'INVALID_PRODUCTION_APP_URL';
      throw err;
    }
    return check.normalizedUrl;
  }

  if (process.env.APP_URL && process.env.APP_URL.trim() && process.env.APP_URL.trim() !== 'MY_APP_URL') {
    const devCheck = validateProductionAppUrl(process.env.APP_URL, { allowHttpLocal: true });
    if (devCheck.valid && devCheck.normalizedUrl) {
      return devCheck.normalizedUrl;
    }
  }

  const rawHost = String(req?.headers?.host || 'localhost:3000').trim();
  const safeHost = /^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(rawHost) ? rawHost : 'localhost:3000';
  const rawProto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http').split(',')[0].trim().toLowerCase();
  const protocol = rawProto === 'https' ? 'https' : 'http';
  return `${protocol}://${safeHost}`;
}

/**
 * Resolves client-supplied redirect URL against trusted base URL and optional origin allowlist.
 * Rejects protocol-relative redirects (e.g. //evil.com), backslashes, and cross-origin hosts.
 */
export function resolveTrustedRedirectUrl(
  baseUrl: string,
  clientUrl: string | undefined,
  defaultPath: string
): string {
  const fallback = `${baseUrl}${defaultPath}`;
  if (!clientUrl || typeof clientUrl !== 'string') {
    return fallback;
  }

  const trimmed = clientUrl.trim();
  if (!trimmed || /[\r\n\0\\]/.test(trimmed)) {
    return fallback;
  }

  // Reject protocol-relative paths like //evil.com
  if (trimmed.startsWith('/')) {
    if (trimmed.startsWith('//')) {
      return fallback;
    }
    try {
      const resolved = new URL(trimmed, baseUrl);
      if (resolved.origin === new URL(baseUrl).origin) {
        return resolved.toString();
      }
    } catch {
      return fallback;
    }
    return fallback;
  }

  try {
    const parsedClient = new URL(trimmed);
    const allowedOrigins = getAllowedRedirectOrigins(baseUrl);
    if (process.env.NODE_ENV === 'production' && parsedClient.protocol !== 'https:') {
      return fallback;
    }
    if (allowedOrigins.has(parsedClient.origin)) {
      return parsedClient.toString();
    }
  } catch {
    return fallback;
  }

  return fallback;
}

/**
 * Parses explicit Express trust proxy configuration from environment.
 */
export function parseTrustProxySetting(raw = process.env.TRUST_PROXY, env = process.env.NODE_ENV): {
  valid: boolean;
  value: boolean | number | string;
  error?: string;
} {
  if (raw === undefined || raw.trim() === '') {
    // Explicit default: trust 1 reverse-proxy hop in production (Cloud Run / LB), disabled in local dev
    return { valid: true, value: env === 'production' ? 1 : false };
  }

  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'false' || trimmed === '0') {
    return { valid: true, value: false };
  }
  if (trimmed === 'true') {
    // Bare 'true' trusts all proxies which permits IP spoofing unless intentionally isolated; warn/reject in prod
    if (env === 'production') {
      return { valid: false, value: 1, error: 'TRUST_PROXY="true" trusts arbitrary proxy chains; specify an explicit hop count (e.g. "1") or CIDR subnet.' };
    }
    return { valid: true, value: true };
  }
  if (/^\d+$/.test(trimmed)) {
    const hops = Number(trimmed);
    if (hops >= 0 && hops <= 10) {
      return { valid: true, value: hops };
    }
    return { valid: false, value: 1, error: 'TRUST_PROXY hop count must be between 0 and 10.' };
  }
  if (['loopback', 'linklocal', 'uniquelocal'].includes(trimmed)) {
    return { valid: true, value: trimmed };
  }

  return { valid: false, value: 1, error: `Unsupported TRUST_PROXY setting "${raw}".` };
}

/**
 * Secret-safe production environment and dependency configuration validation.
 * Never returns credential values in errors or payloads.
 */
export function validateProductionConfig(): ProductionConfigValidationResult {
  const env = process.env.NODE_ENV || 'development';
  const isProd = env === 'production';

  const missingOrInvalid: string[] = [];

  // 1. PostgreSQL
  const postgresConfigured = Boolean(getPostgresPoolConfig());
  if (isProd && !postgresConfigured) {
    missingOrInvalid.push('DATABASE_URL (or SQL_HOST / PGHOST)');
  }

  // 2. APP_URL
  const appUrlCheck = validateProductionAppUrl(process.env.APP_URL, { allowHttpLocal: !isProd });
  const appUrlValid = isProd ? appUrlCheck.valid : true;
  if (isProd && !appUrlCheck.valid) {
    missingOrInvalid.push('APP_URL (valid HTTPS URL required)');
  }

  // 3. Encryption Key
  let encryptionKeyValid = true;
  try {
    getEncryptionKey();
  } catch {
    encryptionKeyValid = false;
  }
  if (isProd && !encryptionKeyValid) {
    missingOrInvalid.push('SHOPIFY_TOKEN_ENCRYPTION_KEY (64-char hex / 32-byte key required)');
  }

  // 4. Billing
  const billingProvider = (process.env.BILLING_PROVIDER || '').trim().toLowerCase();
  const billingDevDisabled = billingProvider !== 'sandbox';
  const hasStripeSecrets = Boolean(process.env.STRIPE_SECRET_KEY?.trim() && process.env.STRIPE_WEBHOOK_SECRET?.trim());
  const billingConfigValid = isProd ? (billingDevDisabled && hasStripeSecrets) : true;
  if (isProd && !billingDevDisabled) {
    missingOrInvalid.push('BILLING_PROVIDER (sandbox prohibited in production)');
  }
  if (isProd && !hasStripeSecrets) {
    missingOrInvalid.push('STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET');
  }

  // 5. Shopify (validate key/secret pair and production Shopify URL configuration when Shopify is enabled or URLs overridden)
  const hasShopifyKey = Boolean(process.env.SHOPIFY_API_KEY?.trim());
  const hasShopifySecret = Boolean(process.env.SHOPIFY_API_SECRET?.trim());
  const hasShopifyUrlsConfigured = Boolean(
    process.env.SHOPIFY_APP_URL?.trim() ||
    process.env.SHOPIFY_REDIRECT_URI?.trim() ||
    process.env.SHOPIFY_WEBHOOK_URL?.trim()
  );
  let shopifyConfigValid = hasShopifyKey === hasShopifySecret;
  if (!shopifyConfigValid) {
    missingOrInvalid.push('SHOPIFY_API_KEY / SHOPIFY_API_SECRET (both required when Shopify is enabled)');
  }
  if (isProd && (hasShopifyKey || hasShopifySecret || hasShopifyUrlsConfigured)) {
    const shopifyUrlCheck = validateShopifyUrlConfig();
    if (!shopifyUrlCheck.valid) {
      shopifyConfigValid = false;
      missingOrInvalid.push(`SHOPIFY_APP_URL / SHOPIFY_REDIRECT_URI / SHOPIFY_WEBHOOK_URL (${shopifyUrlCheck.error})`);
    }
  }

  // 6. Proxy trust
  const proxySetting = parseTrustProxySetting(process.env.TRUST_PROXY, env);
  const trustProxyValid = proxySetting.valid;
  if (!trustProxyValid) {
    missingOrInvalid.push('TRUST_PROXY');
  }

  // 7. No dev flags active in production
  const devOverridesDisabled = isProd
    ? process.env.DISABLE_AUTH !== 'true' && process.env.ALLOW_INSECURE_HTTP !== 'true'
    : true;
  if (isProd && !devOverridesDisabled) {
    missingOrInvalid.push('Development security overrides must not be active in production');
  }

  // 8. Auth rate limiter failure policy
  const rateLimitPolicy = resolveAuthRateLimitFailurePolicy(env, process.env.AUTH_RATE_LIMIT_FAILURE_MODE);
  const rateLimitPolicyValid = rateLimitPolicy.valid;
  if (!rateLimitPolicyValid) {
    missingOrInvalid.push('AUTH_RATE_LIMIT_FAILURE_MODE');
  }

  return {
    valid: missingOrInvalid.length === 0,
    environment: env,
    missingOrInvalid,
    checks: {
      postgresConfigured,
      appUrlValid,
      encryptionKeyValid,
      billingConfigValid,
      shopifyConfigValid,
      trustProxyValid,
      devOverridesDisabled,
      rateLimitPolicyValid,
    },
  };
}
