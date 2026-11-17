import { getDatabaseRepository } from '../db/index';
import { getBillingProvider } from './providerAdapter';
import {
  BillingService,
  DEFAULT_BILLING_RECOVERY_POLICY,
  sanitizeBillingErrorMessage,
  WebhookProcessingResult,
  WebhookRecoverySummary,
} from '../services/billingService';

export interface BillingRecoveryCliOptions {
  eventId?: string;
  limit?: number;
  maxAttempts?: number;
}

export function parseRecoveryCliArgs(argv: string[]): BillingRecoveryCliOptions {
  const options: BillingRecoveryCliOptions = {};
  for (const arg of argv) {
    if (arg.startsWith('--event-id=')) {
      const val = arg.slice('--event-id='.length).trim();
      if (val) options.eventId = val;
    } else if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = parsed;
      }
    } else if (arg.startsWith('--max-attempts=')) {
      const parsed = Number.parseInt(arg.slice('--max-attempts='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.maxAttempts = parsed;
      }
    }
  }
  return options;
}

export async function runBillingWebhookRecoveryCli(
  argv: string[] = process.argv.slice(2)
): Promise<WebhookRecoverySummary | WebhookProcessingResult> {
  const opts = parseRecoveryCliArgs(argv);
  const envMaxAttempts = process.env.BILLING_RECOVERY_MAX_ATTEMPTS
    ? Number.parseInt(process.env.BILLING_RECOVERY_MAX_ATTEMPTS, 10)
    : undefined;
  const maxAttempts =
    opts.maxAttempts ??
    (envMaxAttempts && Number.isFinite(envMaxAttempts) && envMaxAttempts > 0
      ? envMaxAttempts
      : DEFAULT_BILLING_RECOVERY_POLICY.maxAttempts);

  const repo = getDatabaseRepository();
  try {
    const provider = getBillingProvider();
    const billingService = new BillingService(repo, provider, undefined, { maxAttempts });

    if (opts.eventId) {
      const replayResult = await billingService.reprocessBillingEvent(opts.eventId, {
        allowPermanentlyFailed: true,
        maxAttempts,
        leaseOwner: `cli_replay_${Date.now()}`,
      });
      console.log('[AIXSHOP Billing Recovery CLI] Controlled event replay completed:', {
        eventId: opts.eventId,
        success: replayResult.success,
        action: replayResult.action,
        permanentlyFailed: Boolean(replayResult.permanentlyFailed),
        message: replayResult.message,
      });
      return replayResult;
    }

    const summary = await billingService.recoverPendingWebhookEvents({
      limit: opts.limit ?? 50,
      maxAttempts,
      leaseOwnerPrefix: 'cli_recovery',
    });
    console.log('[AIXSHOP Billing Recovery CLI] Recovery sweep completed:', {
      scanned: summary.scanned,
      recovered: summary.recovered,
      ignored: summary.ignored,
      retriedFailed: summary.retriedFailed,
      permanentlyFailed: summary.permanentlyFailed,
      skippedContended: summary.skippedContended,
      leaseLost: summary.leaseLost,
    });
    return summary;
  } finally {
    if (repo.close) {
      await repo.close().catch(() => {});
    }
  }
}

const isDirectExecution = (() => {
  if (typeof process === 'undefined' || !Array.isArray(process.argv) || !process.argv[1]) {
    return false;
  }
  const normalizedArg = process.argv[1].replace(/\\/g, '/');
  return normalizedArg.endsWith('/billing/recoverWebhooks.ts') || normalizedArg.endsWith('/billing/recoverWebhooks.js');
})();

if (isDirectExecution) {
  runBillingWebhookRecoveryCli(process.argv.slice(2))
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('[AIXSHOP Billing Recovery CLI] Failed:', sanitizeBillingErrorMessage(err));
      process.exit(1);
    });
}
