import { getDatabaseRepository } from '../db/index';
import {
  DEFAULT_BILLING_EMAIL_RETRY_POLICY,
  retryFailedBillingEmails,
  RetryBillingEmailsSummary,
} from '../services/billingService';
import { sanitizeSmtpErrorMessage } from '../services/emailService';

export interface BillingEmailRecoveryCliOptions {
  limit?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export function parseEmailRetryCliArgs(argv: string[]): BillingEmailRecoveryCliOptions {
  const options: BillingEmailRecoveryCliOptions = {};
  for (const arg of argv) {
    if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = parsed;
      }
    } else if (arg.startsWith('--max-attempts=')) {
      const parsed = Number.parseInt(arg.slice('--max-attempts='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.maxAttempts = parsed;
      }
    } else if (arg.startsWith('--base-backoff-ms=')) {
      const parsed = Number.parseInt(arg.slice('--base-backoff-ms='.length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        options.baseBackoffMs = parsed;
      }
    } else if (arg.startsWith('--max-backoff-ms=')) {
      const parsed = Number.parseInt(arg.slice('--max-backoff-ms='.length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        options.maxBackoffMs = parsed;
      }
    }
  }
  return options;
}

export async function runBillingEmailRetryCli(
  argv: string[] = process.argv.slice(2)
): Promise<RetryBillingEmailsSummary> {
  const opts = parseEmailRetryCliArgs(argv);
  const envMaxAttempts = process.env.BILLING_EMAIL_RETRY_MAX_ATTEMPTS
    ? Number.parseInt(process.env.BILLING_EMAIL_RETRY_MAX_ATTEMPTS, 10)
    : undefined;
  const maxAttempts =
    opts.maxAttempts ??
    (envMaxAttempts && Number.isFinite(envMaxAttempts) && envMaxAttempts > 0
      ? envMaxAttempts
      : DEFAULT_BILLING_EMAIL_RETRY_POLICY.maxAttempts);

  const repo = getDatabaseRepository();
  try {
    const summary = await retryFailedBillingEmails(repo, {
      limit: opts.limit ?? 50,
      maxAttempts,
      baseBackoffMs: opts.baseBackoffMs,
      maxBackoffMs: opts.maxBackoffMs,
    });
    console.log('[AIXSHOP Billing Email Retry CLI] Retry sweep completed:', {
      scanned: summary.scanned,
      retried: summary.retried,
      sent: summary.sent,
      failed: summary.failed,
      permanentlyFailed: summary.permanentlyFailed,
      skippedContended: summary.skippedContended,
    });
    return summary;
  } finally {
    if (repo.close) {
      await repo.close().catch(() => {});
    }
  }
}

export function resolveBillingEmailRetryCliExitCode(summary: RetryBillingEmailsSummary): 0 | 1 {
  if (summary.failed > 0 || summary.permanentlyFailed > 0) {
    return 1;
  }
  return 0;
}

const isDirectExecution = (() => {
  if (typeof process === 'undefined' || !Array.isArray(process.argv) || !process.argv[1]) {
    return false;
  }
  const normalizedArg = process.argv[1].replace(/\\/g, '/');
  return (
    normalizedArg.endsWith('/billing/recoverEmails.ts') ||
    normalizedArg.endsWith('/billing/recoverEmails.js')
  );
})();

if (isDirectExecution) {
  runBillingEmailRetryCli(process.argv.slice(2))
    .then((summary) => {
      process.exit(resolveBillingEmailRetryCliExitCode(summary));
    })
    .catch((err) => {
      console.error('[AIXSHOP Billing Email Retry CLI] Failed:', sanitizeSmtpErrorMessage(err));
      process.exit(1);
    });
}
