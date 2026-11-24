import 'dotenv/config';
import {
  resolveAuthRateLimitFailurePolicy,
  validateProductionConfig,
  validateShopifyUrlConfig,
} from './productionConfig';
import { validateStripePriceConfiguration } from '../billing/providerAdapter';
import { SmtpReadinessReport, validateSmtpConfig, verifySmtpConnection } from '../services/emailService';

export interface SecretSafeConfigCheckReport {
  valid: boolean;
  strictMode: boolean;
  environment: string;
  checks: {
    postgresConfigured: boolean;
    appUrlValid: boolean;
    encryptionKeyValid: boolean;
    billingConfigValid: boolean;
    stripePriceIdsValid: boolean;
    smtpConfigValid: boolean;
    shopifyConfigValid: boolean;
    shopifyUrlsValid: boolean;
    trustProxyValid: boolean;
    devOverridesDisabled: boolean;
    rateLimitPolicyValid: boolean;
  };
  missingOrInvalid: string[];
  smtpReadiness: {
    smtp_configuration_valid: boolean;
    smtp_connection_verified: boolean;
    smtp_message_accepted: boolean | null;
    inbox_delivery_confirmed: false;
    connectionError?: string;
  };
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

  const stripePriceCheck = validateStripePriceConfiguration();
  const smtpCheck = validateSmtpConfig({ isProd });

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
    if (!stripePriceCheck.valid) {
      for (const item of stripePriceCheck.missingOrInvalid) {
        if (!missingOrInvalid.includes(item)) {
          missingOrInvalid.push(item);
        }
      }
    }
    if (!smtpCheck.valid) {
      for (const item of smtpCheck.missingOrInvalid) {
        if (!missingOrInvalid.includes(item)) {
          missingOrInvalid.push(item);
        }
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
      stripePriceIdsValid: strictMode ? stripePriceCheck.valid : prodValidation.checks.stripePriceIdsValid,
      smtpConfigValid: strictMode ? smtpCheck.valid : prodValidation.checks.smtpConfigValid,
      shopifyUrlsValid,
    },
    missingOrInvalid,
    smtpReadiness: {
      smtp_configuration_valid: smtpCheck.valid,
      // Configuration validity alone NEVER implies a verified SMTP connection or inbox delivery.
      smtp_connection_verified: false,
      smtp_message_accepted: null,
      inbox_delivery_confirmed: false,
    },
    optionalIntegrations: {
      stripeConfigured: Boolean(
        process.env.STRIPE_SECRET_KEY?.trim() && process.env.STRIPE_WEBHOOK_SECRET?.trim()
      ),
      stripePriceIdsConfigured: stripePriceCheck.valid,
      shopifyAppConfigured: Boolean(
        process.env.SHOPIFY_API_KEY?.trim() && process.env.SHOPIFY_API_SECRET?.trim()
      ),
      smtpConfigured: smtpCheck.configured && smtpCheck.valid,
      smtpStarttlsMode: process.env.SMTP_STARTTLS?.trim() || smtpCheck.starttlsMode,
      reviewerSecretConfigured: reviewerSecret.length >= 32,
      rateLimitFailureMode: rateLimitPolicy.mode,
    },
  };
}

export async function runSecretSafeConfigCheckWithSmtpProbe(
  options: { strict?: boolean; timeoutMs?: number } = {}
): Promise<SecretSafeConfigCheckReport> {
  const report = runSecretSafeConfigCheck({ strict: options.strict });
  const probe: SmtpReadinessReport = await verifySmtpConnection({ timeoutMs: options.timeoutMs });
  return {
    ...report,
    smtpReadiness: {
      smtp_configuration_valid: probe.smtp_configuration_valid,
      smtp_connection_verified: probe.smtp_connection_verified,
      smtp_message_accepted: probe.smtp_message_accepted,
      inbox_delivery_confirmed: probe.inbox_delivery_confirmed,
      ...(probe.connectionError ? { connectionError: probe.connectionError } : {}),
    },
  };
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1]?.includes('checkConfig');

if (isDirectExecution) {
  const strict = process.argv.includes('--strict');
  const probeSmtp = process.argv.includes('--verify-smtp');
  if (probeSmtp) {
    runSecretSafeConfigCheckWithSmtpProbe({ strict })
      .then((report) => {
        console.log(JSON.stringify(report, null, 2));
        if (!report.valid || !report.smtpReadiness.smtp_connection_verified) {
          process.exitCode = 1;
        }
      })
      .catch((err) => {
        console.error('[AIXSHOP Config Check] Unexpected probe error:', err?.message || 'Unknown error');
        process.exitCode = 1;
      });
  } else {
    const report = runSecretSafeConfigCheck({ strict });
    console.log(JSON.stringify(report, null, 2));
    if (!report.valid) {
      process.exitCode = 1;
    }
  }
}
