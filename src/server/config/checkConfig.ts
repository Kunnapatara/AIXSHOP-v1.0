import 'dotenv/config';
import {
  resolveAuthRateLimitFailurePolicy,
  validateProductionConfig,
  validateShopifyUrlConfig,
} from './productionConfig';

export interface SecretSafeConfigCheckReport {
  valid: boolean;
  strictMode: boolean;
  environment: string;
  checks: {
    postgresConfigured: boolean;
    appUrlValid: boolean;
    encryptionKeyValid: boolean;
    billingConfigValid: boolean;
    shopifyConfigValid: boolean;
    shopifyUrlsValid: boolean;
    trustProxyValid: boolean;
    devOverridesDisabled: boolean;
    rateLimitPolicyValid: boolean;
  };
  missingOrInvalid: string[];
  optionalIntegrations: {
    stripeConfigured: boolean;
    stripePriceIdsConfigured: boolean;
    shopifyAppConfigured: boolean;
    smtpConfigured: boolean;
    smtpStarttlsMode: string;
    reviewerSecretConfigured: boolean;
    rateLimitFailureMode: string;
  };
}

/**
 * Computes a secret-safe configuration report.
 * Strictly returns booleans and validation status names—never emits credential values.
 */
export function runSecretSafeConfigCheck(options: { strict?: boolean } = {}): SecretSafeConfigCheckReport {
  const prodValidation = validateProductionConfig();
  const isProd = prodValidation.environment === 'production';
  const strictMode = Boolean(options.strict || isProd);

  const hasShopifyCredentials = Boolean(
    process.env.SHOPIFY_API_KEY?.trim() || process.env.SHOPIFY_API_SECRET?.trim()
  );
  const shopifyUrlCheck = validateShopifyUrlConfig();
  const shopifyUrlsValid = isProd && hasShopifyCredentials ? shopifyUrlCheck.valid : shopifyUrlCheck.valid || !isProd;

  const missingOrInvalid = [...prodValidation.missingOrInvalid];
  if (strictMode && !isProd) {
    if (!prodValidation.checks.postgresConfigured && !missingOrInvalid.some((m) => m.includes('DATABASE_URL'))) {
      missingOrInvalid.push('DATABASE_URL (or SQL_HOST / PGHOST)');
    }
    if (!prodValidation.checks.encryptionKeyValid && !missingOrInvalid.some((m) => m.includes('SHOPIFY_TOKEN_ENCRYPTION_KEY'))) {
      missingOrInvalid.push('SHOPIFY_TOKEN_ENCRYPTION_KEY (64-char hex / 32-byte key required)');
    }
    if (!process.env.STRIPE_SECRET_KEY?.trim() || !process.env.STRIPE_WEBHOOK_SECRET?.trim()) {
      if (!missingOrInvalid.some((m) => m.includes('STRIPE_SECRET_KEY'))) {
        missingOrInvalid.push('STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET');
      }
    }
    if (!shopifyUrlCheck.valid && !missingOrInvalid.some((m) => m.includes('SHOPIFY_APP_URL'))) {
      missingOrInvalid.push(`SHOPIFY_APP_URL / APP_URL (${shopifyUrlCheck.error})`);
    }
  }

  const rateLimitPolicy = resolveAuthRateLimitFailurePolicy();
  const reviewerSecret = process.env.AIXSHOP_PLATFORM_REVIEWER_SECRET?.trim() || '';

  return {
    valid: strictMode ? missingOrInvalid.length === 0 : prodValidation.valid,
    strictMode,
    environment: prodValidation.environment,
    checks: {
      ...prodValidation.checks,
      shopifyUrlsValid,
    },
    missingOrInvalid,
    optionalIntegrations: {
      stripeConfigured: Boolean(
        process.env.STRIPE_SECRET_KEY?.trim() && process.env.STRIPE_WEBHOOK_SECRET?.trim()
      ),
      stripePriceIdsConfigured: Boolean(
        process.env.STRIPE_PRICE_STARTER?.trim() &&
          process.env.STRIPE_PRICE_GROWTH?.trim() &&
          process.env.STRIPE_PRICE_ENTERPRISE?.trim()
      ),
      shopifyAppConfigured: Boolean(
        process.env.SHOPIFY_API_KEY?.trim() && process.env.SHOPIFY_API_SECRET?.trim()
      ),
      smtpConfigured: Boolean(process.env.SMTP_HOST?.trim()),
      smtpStarttlsMode: process.env.SMTP_STARTTLS?.trim() || 'opportunistic_default',
      reviewerSecretConfigured: reviewerSecret.length >= 32,
      rateLimitFailureMode: rateLimitPolicy.mode,
    },
  };
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1]?.includes('checkConfig');

if (isDirectExecution) {
  const strict = process.argv.includes('--strict');
  const report = runSecretSafeConfigCheck({ strict });
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid) {
    process.exitCode = 1;
  }
}
