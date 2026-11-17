import { DatabaseRepository } from '../db/repository';
import { 
  IBillingProvider, 
  SubscriptionRecord, 
  BillingEventRecord, 
  PlanTier, 
  AUTHORITATIVE_PLANS,
  WebhookEventPayload 
} from '../billing/types';
import { findPlanByPriceId } from '../billing/providerAdapter';
import { StoreProfile } from '../../types';

export interface WebhookProcessingResult {
  success: boolean;
  action: 'processed' | 'ignored' | 'duplicate';
  message: string;
  inProgress?: boolean;
  retryable?: boolean;
  permanentlyFailed?: boolean;
  subscription?: SubscriptionRecord;
}

export interface BillingRecoveryPolicy {
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export const DEFAULT_BILLING_RECOVERY_POLICY: Required<BillingRecoveryPolicy> = {
  maxAttempts: 5,
  baseBackoffMs: 30_000,
  maxBackoffMs: 3_600_000,
};

export interface RecoverWebhookOptions extends BillingLeaseConfig, BillingRecoveryPolicy {
  limit?: number;
  leaseOwnerPrefix?: string;
}

export interface WebhookRecoveryDetail {
  eventId: string;
  eventType: string;
  attemptCount: number;
  outcome: 'recovered' | 'ignored' | 'retried_failed' | 'permanently_failed' | 'skipped_contended' | 'lease_lost';
  message?: string;
}

export interface WebhookRecoverySummary {
  scanned: number;
  recovered: number;
  ignored: number;
  retriedFailed: number;
  permanentlyFailed: number;
  skippedContended: number;
  leaseLost: number;
  details: WebhookRecoveryDetail[];
}

export function sanitizeBillingErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
      ? err
      : String(err ?? 'Unknown billing processing error');
  let sanitized = raw
    .replace(/\b(sk|rk)_(live|test)_[A-Za-z0-9_]+\b/g, '[REDACTED_STRIPE_KEY]')
    .replace(/\bwhsec_[A-Za-z0-9_]+\b/g, '[REDACTED_WEBHOOK_SECRET]')
    .replace(/(postgres(?:ql)?:\/\/)([^:\s/@]+):([^@\s]+)@/gi, '$1***@')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/\b(password|passwd|secret|token|api[_-]?key|signature)\s*([:=])\s*([^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  if (!sanitized) {
    sanitized = 'Billing processing failed.';
  }
  if (sanitized.length > 500) {
    sanitized = `${sanitized.slice(0, 497)}...`;
  }
  return sanitized;
}

export function classifyWebhookProcessingError(err: any): { retryable: boolean; reason: string } {
  const msg = typeof err?.message === 'string' ? err.message : '';
  if (err?.code === 'BILLING_LEASE_LOST' || /lease ownership lost or expired/i.test(msg)) {
    return { retryable: true, reason: 'lease_lost' };
  }
  if (err?.nonRetryable === true) {
    return { retryable: false, reason: 'explicit_non_retryable' };
  }
  const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : undefined;
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429) {
    return { retryable: false, reason: 'deterministic_client_or_payload_error' };
  }
  return { retryable: true, reason: 'transient_processing_error' };
}

export function computeNextRetryAt(
  attemptCount: number,
  baseBackoffMs: number = DEFAULT_BILLING_RECOVERY_POLICY.baseBackoffMs,
  maxBackoffMs: number = DEFAULT_BILLING_RECOVERY_POLICY.maxBackoffMs,
  nowMs: number = Date.now()
): string {
  const safeBase = Number.isFinite(baseBackoffMs) && baseBackoffMs >= 0 ? baseBackoffMs : DEFAULT_BILLING_RECOVERY_POLICY.baseBackoffMs;
  const safeMax = Number.isFinite(maxBackoffMs) && maxBackoffMs >= 0 ? maxBackoffMs : DEFAULT_BILLING_RECOVERY_POLICY.maxBackoffMs;
  const exponent = Math.max(0, Math.floor(attemptCount) - 1);
  const rawDelay = safeBase * Math.pow(2, exponent);
  const boundedDelay = Math.min(safeMax, Math.max(0, rawDelay));
  return new Date(nowMs + boundedDelay).toISOString();
}

export interface NormalizedStripeSubscriptionStatus {
  status: SubscriptionRecord['status'];
  isKnownStatus: boolean;
  isAuthorizedPaidTier: boolean;
  rawStatus: string;
}

/**
 * Strictly maps Stripe subscription statuses with explicit fail-closed behavior.
 * Only 'active' and 'trialing' authorize paid tier entitlements.
 * Unknown, missing, empty, or non-string statuses fail closed to 'incomplete' (unauthorized).
 */
export function normalizeStripeSubscriptionStatus(rawStatusInput: unknown): NormalizedStripeSubscriptionStatus {
  const normalized = typeof rawStatusInput === 'string' ? rawStatusInput.trim().toLowerCase() : '';
  switch (normalized) {
    case 'active':
      return { status: 'active', isKnownStatus: true, isAuthorizedPaidTier: true, rawStatus: normalized };
    case 'trialing':
      return { status: 'trialing', isKnownStatus: true, isAuthorizedPaidTier: true, rawStatus: normalized };
    case 'past_due':
      return { status: 'past_due', isKnownStatus: true, isAuthorizedPaidTier: false, rawStatus: normalized };
    case 'canceled':
    case 'cancelled':
      return { status: 'canceled', isKnownStatus: true, isAuthorizedPaidTier: false, rawStatus: normalized };
    case 'unpaid':
      return { status: 'unpaid', isKnownStatus: true, isAuthorizedPaidTier: false, rawStatus: normalized };
    case 'incomplete':
      return { status: 'incomplete', isKnownStatus: true, isAuthorizedPaidTier: false, rawStatus: normalized };
    case 'incomplete_expired':
    case 'expired':
      return { status: 'expired', isKnownStatus: true, isAuthorizedPaidTier: false, rawStatus: normalized };
    case 'pending':
      return { status: 'pending', isKnownStatus: true, isAuthorizedPaidTier: false, rawStatus: normalized };
    default:
      return {
        status: 'incomplete',
        isKnownStatus: false,
        isAuthorizedPaidTier: false,
        rawStatus: normalized || '(missing_or_invalid)',
      };
  }
}

export interface BillingLeaseConfig {
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
}

const DEFAULT_LEASE_DURATION_MS = 300_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const MIN_LEASE_DURATION_MS = 50;
const MIN_HEARTBEAT_INTERVAL_MS = 10;

export function validateBillingLeaseConfig(
  config?: BillingLeaseConfig,
  baseConfig?: { leaseDurationMs: number; heartbeatIntervalMs: number }
): { leaseDurationMs: number; heartbeatIntervalMs: number } {
  const leaseDurationMs = config?.leaseDurationMs ?? baseConfig?.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  if (typeof leaseDurationMs !== 'number' || !Number.isFinite(leaseDurationMs) || leaseDurationMs < MIN_LEASE_DURATION_MS) {
    throw new Error(
      `[AIXSHOP Billing] Invalid leaseDurationMs (${leaseDurationMs}): must be a finite number >= ${MIN_LEASE_DURATION_MS}ms.`
    );
  }

  let heartbeatIntervalMs: number;
  if (config?.heartbeatIntervalMs !== undefined) {
    heartbeatIntervalMs = config.heartbeatIntervalMs;
  } else if (config?.leaseDurationMs !== undefined) {
    // Derive a safe heartbeat shorter than custom leaseDurationMs when caller only overrides leaseDurationMs
    const preferred = baseConfig?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    heartbeatIntervalMs = preferred < leaseDurationMs
      ? preferred
      : Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(leaseDurationMs / 3));
  } else {
    heartbeatIntervalMs = baseConfig?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  if (
    typeof heartbeatIntervalMs !== 'number' ||
    !Number.isFinite(heartbeatIntervalMs) ||
    heartbeatIntervalMs < MIN_HEARTBEAT_INTERVAL_MS ||
    heartbeatIntervalMs >= leaseDurationMs
  ) {
    throw new Error(
      `[AIXSHOP Billing] Invalid heartbeatIntervalMs (${heartbeatIntervalMs}): must be finite, >= ${MIN_HEARTBEAT_INTERVAL_MS}ms, and strictly less than leaseDurationMs (${leaseDurationMs}ms).`
    );
  }

  return { leaseDurationMs, heartbeatIntervalMs };
}

export class BillingService {
  private repo: DatabaseRepository;
  private provider: IBillingProvider;
  private leaseConfig: { leaseDurationMs: number; heartbeatIntervalMs: number };
  private recoveryPolicy: Required<BillingRecoveryPolicy>;

  constructor(
    repo: DatabaseRepository,
    provider: IBillingProvider,
    leaseConfig?: BillingLeaseConfig,
    recoveryPolicy?: BillingRecoveryPolicy
  ) {
    this.repo = repo;
    this.provider = provider;
    this.leaseConfig = validateBillingLeaseConfig(leaseConfig);
    this.recoveryPolicy = {
      maxAttempts: Math.max(1, recoveryPolicy?.maxAttempts ?? DEFAULT_BILLING_RECOVERY_POLICY.maxAttempts),
      baseBackoffMs:
        recoveryPolicy?.baseBackoffMs !== undefined && recoveryPolicy.baseBackoffMs >= 0
          ? recoveryPolicy.baseBackoffMs
          : DEFAULT_BILLING_RECOVERY_POLICY.baseBackoffMs,
      maxBackoffMs:
        recoveryPolicy?.maxBackoffMs !== undefined && recoveryPolicy.maxBackoffMs >= 0
          ? recoveryPolicy.maxBackoffMs
          : DEFAULT_BILLING_RECOVERY_POLICY.maxBackoffMs,
    };
  }

  async createCheckoutSession(
    workspaceId: string, 
    tier: PlanTier, 
    successUrl: string, 
    cancelUrl: string
  ) {
    const planKey = Object.keys(AUTHORITATIVE_PLANS).find(
      k => AUTHORITATIVE_PLANS[k].tier === tier
    );
    const plan = planKey ? AUTHORITATIVE_PLANS[planKey] : null;

    if (!plan || plan.priceCents <= 0) {
      throw new Error(`Invalid plan tier "${tier}". Paid checkout is not available for free tiers.`);
    }

    const store = await this.repo.getStoreByWorkspace(workspaceId);
    if (!store) {
      throw new Error(`Workspace store not found for ${workspaceId}`);
    }

    const existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
    const customerId = existingSub?.customerId;

    return this.provider.createCheckoutSession({
      workspaceId,
      tier,
      successUrl,
      cancelUrl,
      customerId,
    });
  }

  async createPortalSession(workspaceId: string, returnUrl: string) {
    const subscription = await this.repo.getSubscriptionByWorkspace(workspaceId);
    const customerId = subscription?.customerId;
    if (this.provider.providerName === 'stripe') {
      if (!customerId || !customerId.startsWith('cus_')) {
        throw new Error(`[Billing] Workspace "${workspaceId}" does not have an active customer or subscription record.`);
      }
    }
    return this.provider.createPortalSession(workspaceId, customerId || `cust_${workspaceId}`, returnUrl);
  }

  async renewEventLease(
    eventId: string,
    leaseOwner: string,
    extendMs: number = 300000
  ): Promise<boolean> {
    return this.repo.renewBillingEventLease(eventId, leaseOwner, extendMs);
  }

  async handleWebhook(
    rawBody: string | Buffer,
    signatureHeader: string,
    options?: { leaseOwner?: string; leaseDurationMs?: number; heartbeatIntervalMs?: number }
  ): Promise<WebhookProcessingResult> {
    const effectiveLease = validateBillingLeaseConfig(
      {
        leaseDurationMs: options?.leaseDurationMs,
        heartbeatIntervalMs: options?.heartbeatIntervalMs,
      },
      this.leaseConfig
    );

    // 1. Resolve webhook secret safely without insecure production fallback
    let secret = '';
    if (this.provider.providerName === 'stripe') {
      secret = (this.provider as any).getWebhookSecret?.() || process.env.STRIPE_WEBHOOK_SECRET || '';
    } else {
      secret = (this.provider as any).getWebhookSecret?.() || process.env.BILLING_WEBHOOK_SECRET || '';
      if (!secret && process.env.NODE_ENV !== 'production') {
        secret = 'sandbox_test_webhook_secret_key_123';
      }
    }

    if (!secret) {
      const err: any = new Error(
        process.env.NODE_ENV === 'production'
          ? 'Production billing webhook secret is not configured.'
          : 'Billing webhook secret is not configured.'
      );
      err.statusCode = 500;
      throw err;
    }

    // 2. Verify cryptographic webhook signature against original raw request bytes
    const isValidSignature = await this.provider.verifyWebhookSignature(rawBody, signatureHeader, secret);

    if (!isValidSignature) {
      const err: any = new Error('Invalid webhook signature verification failed.');
      err.statusCode = 400;
      throw err;
    }

    // 3. Parse event payload safely
    let event: WebhookEventPayload;
    try {
      event = this.provider.parseWebhookEvent(rawBody);
    } catch (parseErr: any) {
      if (parseErr && typeof parseErr === 'object' && parseErr.statusCode === undefined) {
        parseErr.statusCode = 400;
      }
      throw parseErr;
    }

    // 4. Atomic Event Claim with durable lease ownership (PostgreSQL concurrency & idempotency guard)
    const claimRecord: BillingEventRecord = {
      id: `bevt_${event.id}`,
      provider: this.provider.providerName,
      eventId: event.id,
      eventType: event.type,
      idempotencyKey: event.id,
      payload: event,
      status: 'processing',
      processedAt: new Date().toISOString(),
    };

    const claim = await this.repo.claimBillingEvent(claimRecord, {
      leaseOwner: options?.leaseOwner,
      leaseDurationMs: effectiveLease.leaseDurationMs,
    });

    if (!claim.claimed) {
      const existingStatus = claim.event?.status;
      if (existingStatus === 'processed') {
        return {
          success: true,
          action: 'duplicate',
          message: `Webhook event ${event.id} was already processed (idempotent no-op).`,
        };
      }
      if (existingStatus === 'ignored') {
        return {
          success: true,
          action: 'ignored',
          message: `Webhook event ${event.id} was previously ignored.`,
        };
      }
      if (existingStatus === 'permanently_failed') {
        return {
          success: false,
          action: 'duplicate',
          inProgress: false,
          retryable: false,
          permanentlyFailed: true,
          message: `Webhook event ${event.id} exceeded maximum recovery retries or failed permanently and requires manual replay.`,
        };
      }
      return {
        success: false,
        action: 'duplicate',
        inProgress: true,
        retryable: true,
        message:
          existingStatus === 'processing'
            ? `Webhook event ${event.id} is currently being processed by another worker and has not completed yet; retry safely later.`
            : `Webhook event ${event.id} could not be claimed in state "${existingStatus || 'unknown'}"; retry safely later.`,
      };
    }

    const leaseOwner = claim.leaseOwner;
    if (!leaseOwner) {
      throw new Error(`[AIXSHOP Billing] Claimed billing event ${event.id} without lease owner.`);
    }

    const attemptCount = claim.event?.attemptCount ?? 1;
    return this.executeClaimedWebhookEvent(
      event,
      leaseOwner,
      effectiveLease,
      attemptCount,
      this.recoveryPolicy,
      'webhook'
    );
  }

  /**
   * Scans durable billing_events storage for abandoned 'processing' (expired lease) or retry-ready
   * 'failed' webhook events, atomically claims each via compare-and-set lease acquisition,
   * and executes the authoritative billing state transition cleanly with exponential backoff or dead-lettering.
   */
  async recoverPendingWebhookEvents(options?: RecoverWebhookOptions): Promise<WebhookRecoverySummary> {
    const effectiveLease = validateBillingLeaseConfig(
      {
        leaseDurationMs: options?.leaseDurationMs,
        heartbeatIntervalMs: options?.heartbeatIntervalMs,
      },
      this.leaseConfig
    );
    const effectiveRecovery: Required<BillingRecoveryPolicy> = {
      maxAttempts: Math.max(1, options?.maxAttempts ?? this.recoveryPolicy.maxAttempts),
      baseBackoffMs:
        options?.baseBackoffMs !== undefined && options.baseBackoffMs >= 0
          ? options.baseBackoffMs
          : this.recoveryPolicy.baseBackoffMs,
      maxBackoffMs:
        options?.maxBackoffMs !== undefined && options.maxBackoffMs >= 0
          ? options.maxBackoffMs
          : this.recoveryPolicy.maxBackoffMs,
    };
    const limit = Math.max(1, Math.min(500, options?.limit ?? 50));
    const leasePrefix = options?.leaseOwnerPrefix || 'recovery_worker';

    const finalizedExhausted = await this.repo.finalizeExpiredExhaustedBillingEvents({
      maxAttempts: effectiveRecovery.maxAttempts,
      limit,
      provider: this.provider.providerName,
    });

    const summary: WebhookRecoverySummary = {
      scanned: finalizedExhausted.length,
      recovered: 0,
      ignored: 0,
      retriedFailed: 0,
      permanentlyFailed: finalizedExhausted.length,
      skippedContended: 0,
      leaseLost: 0,
      details: [],
    };

    for (const finalized of finalizedExhausted) {
      console.warn('[AIXSHOP Billing Recovery]', {
        eventId: finalized.eventId,
        eventType: finalized.eventType,
        currentStatus: 'processing',
        targetStatus: 'permanently_failed',
        attemptCount: finalized.attemptCount ?? effectiveRecovery.maxAttempts,
        maxAttempts: effectiveRecovery.maxAttempts,
        previousLeaseOwner: finalized.leaseOwner || null,
        classification: 'final_attempt_lease_expired',
        failureStatePersisted: true,
      });
      summary.details.push({
        eventId: finalized.eventId,
        eventType: finalized.eventType,
        attemptCount: finalized.attemptCount ?? effectiveRecovery.maxAttempts,
        outcome: 'permanently_failed',
        message:
          finalized.lastError ||
          `Worker lease expired on final attempt (maxAttempts=${effectiveRecovery.maxAttempts}); finalized to permanently_failed.`,
      });
    }

    const remainingLimit = Math.max(0, limit - finalizedExhausted.length);
    const candidates =
      remainingLimit > 0
        ? await this.repo.listRecoverableBillingEvents({
            maxAttempts: effectiveRecovery.maxAttempts,
            limit: remainingLimit,
            provider: this.provider.providerName,
          })
        : [];
    summary.scanned += candidates.length;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const leaseOwner = `${leasePrefix}_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`;

      const claim = await this.repo.claimBillingEventForRecovery(candidate.eventId, {
        leaseOwner,
        leaseDurationMs: effectiveLease.leaseDurationMs,
        maxAttempts: effectiveRecovery.maxAttempts,
        provider: this.provider.providerName,
      });

      if (!claim.claimed || !claim.event || !claim.leaseOwner) {
        summary.skippedContended += 1;
        summary.details.push({
          eventId: candidate.eventId,
          eventType: candidate.eventType,
          attemptCount: candidate.attemptCount ?? 0,
          outcome: 'skipped_contended',
          message: 'Claimed concurrently or no longer eligible for recovery.',
        });
        continue;
      }

      const claimedRecord = claim.event;
      const attemptCount = claimedRecord.attemptCount ?? 1;
      const payload = claimedRecord.payload as WebhookEventPayload | undefined;

      if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || typeof payload.type !== 'string') {
        const sanitizedMsg = sanitizeBillingErrorMessage('Stored webhook payload is invalid or missing event metadata.');
        const persistOutcome = await this.recordBillingFailureState({
          eventId: claimedRecord.eventId,
          leaseOwner: claim.leaseOwner,
          targetStatus: 'permanently_failed',
          errorMessage: sanitizedMsg,
          nextRetryAt: null,
          attemptCount,
          classification: 'invalid_stored_payload',
          operation: 'recovery_sweep',
        });

        if (persistOutcome.persisted) {
          summary.permanentlyFailed += 1;
          summary.details.push({
            eventId: claimedRecord.eventId,
            eventType: claimedRecord.eventType,
            attemptCount,
            outcome: 'permanently_failed',
            message: sanitizedMsg,
          });
        } else if (persistOutcome.leaseLost) {
          summary.leaseLost += 1;
          summary.details.push({
            eventId: claimedRecord.eventId,
            eventType: claimedRecord.eventType,
            attemptCount,
            outcome: 'lease_lost',
            message: `Lease lost before invalid-payload failure could be persisted (${persistOutcome.persistenceError}); original error: ${sanitizedMsg}`,
          });
        } else {
          summary.retriedFailed += 1;
          summary.details.push({
            eventId: claimedRecord.eventId,
            eventType: claimedRecord.eventType,
            attemptCount,
            outcome: 'retried_failed',
            message: `Failure-state persistence failed (${persistOutcome.persistenceError}); event remains in processing for lease-expiry recovery. Original error: ${sanitizedMsg}`,
          });
        }
        continue;
      }

      try {
        const result = await this.executeClaimedWebhookEvent(
          payload,
          claim.leaseOwner,
          effectiveLease,
          attemptCount,
          effectiveRecovery,
          'recovery_sweep'
        );
        if (result.action === 'ignored') {
          summary.ignored += 1;
          summary.details.push({
            eventId: claimedRecord.eventId,
            eventType: claimedRecord.eventType,
            attemptCount,
            outcome: 'ignored',
            message: result.message,
          });
        } else {
          summary.recovered += 1;
          summary.details.push({
            eventId: claimedRecord.eventId,
            eventType: claimedRecord.eventType,
            attemptCount,
            outcome: 'recovered',
            message: result.message,
          });
        }
      } catch (err: any) {
        if (err?.code === 'BILLING_LEASE_LOST') {
          summary.leaseLost += 1;
          summary.details.push({
            eventId: claimedRecord.eventId,
            eventType: claimedRecord.eventType,
            attemptCount,
            outcome: 'lease_lost',
            message: sanitizeBillingErrorMessage(err),
          });
        } else if (err?.permanentlyFailed && err?.failureStatePersisted !== false) {
          summary.permanentlyFailed += 1;
          summary.details.push({
            eventId: claimedRecord.eventId,
            eventType: claimedRecord.eventType,
            attemptCount,
            outcome: 'permanently_failed',
            message: sanitizeBillingErrorMessage(err),
          });
        } else {
          summary.retriedFailed += 1;
          const baseMessage = sanitizeBillingErrorMessage(err);
          summary.details.push({
            eventId: claimedRecord.eventId,
            eventType: claimedRecord.eventType,
            attemptCount,
            outcome: 'retried_failed',
            message:
              err?.failureStatePersisted === false
                ? `${baseMessage} (failure-state persistence error: ${err.persistenceError || 'unknown'})`
                : baseMessage,
          });
        }
      }
    }

    return summary;
  }

  /**
   * Controlled manual replay for a specific stored billing event (e.g., an operator replaying
   * a 'permanently_failed' dead-lettered event after fixing an upstream workspace or catalog issue).
   * Strictly refuses already-'processed' or 'ignored' events and preserves active processing leases.
   */
  async reprocessBillingEvent(
    eventId: string,
    options?: BillingLeaseConfig & BillingRecoveryPolicy & { leaseOwner?: string; allowPermanentlyFailed?: boolean }
  ): Promise<WebhookProcessingResult> {
    const existing = await this.repo.getBillingEventById(eventId);
    if (!existing) {
      const err: any = new Error(`Billing event "${eventId}" not found.`);
      err.statusCode = 404;
      err.code = 'BILLING_EVENT_NOT_FOUND';
      throw err;
    }

    if (existing.provider !== this.provider.providerName) {
      const err: any = new Error(
        `Billing event "${eventId}" belongs to provider "${existing.provider}", expected "${this.provider.providerName}".`
      );
      err.statusCode = 409;
      err.code = 'BILLING_PROVIDER_MISMATCH';
      throw err;
    }

    if (existing.status === 'processed') {
      return {
        success: true,
        action: 'duplicate',
        message: `Webhook event ${eventId} was already processed (idempotent no-op).`,
      };
    }

    if (existing.status === 'ignored') {
      return {
        success: true,
        action: 'ignored',
        message: `Webhook event ${eventId} was previously ignored.`,
      };
    }

    const effectiveLease = validateBillingLeaseConfig(
      {
        leaseDurationMs: options?.leaseDurationMs,
        heartbeatIntervalMs: options?.heartbeatIntervalMs,
      },
      this.leaseConfig
    );
    const effectiveRecovery: Required<BillingRecoveryPolicy> = {
      maxAttempts: Math.max(1, options?.maxAttempts ?? this.recoveryPolicy.maxAttempts),
      baseBackoffMs:
        options?.baseBackoffMs !== undefined && options.baseBackoffMs >= 0
          ? options.baseBackoffMs
          : this.recoveryPolicy.baseBackoffMs,
      maxBackoffMs:
        options?.maxBackoffMs !== undefined && options.maxBackoffMs >= 0
          ? options.maxBackoffMs
          : this.recoveryPolicy.maxBackoffMs,
    };

    const allowReplay = options?.allowPermanentlyFailed ?? true;
    const claim = await this.repo.claimBillingEventForRecovery(eventId, {
      leaseOwner: options?.leaseOwner,
      leaseDurationMs: effectiveLease.leaseDurationMs,
      maxAttempts: effectiveRecovery.maxAttempts,
      allowReplayFailed: allowReplay,
      provider: this.provider.providerName,
    });

    if (!claim.claimed || !claim.event || !claim.leaseOwner) {
      const latestStatus = claim.event?.status;
      if (latestStatus === 'processed') {
        return {
          success: true,
          action: 'duplicate',
          message: `Webhook event ${eventId} was already processed (idempotent no-op).`,
        };
      }
      if (latestStatus === 'ignored') {
        return {
          success: true,
          action: 'ignored',
          message: `Webhook event ${eventId} was previously ignored.`,
        };
      }
      if (latestStatus === 'permanently_failed') {
        return {
          success: false,
          action: 'duplicate',
          inProgress: false,
          retryable: false,
          permanentlyFailed: true,
          message: `Webhook event ${eventId} is in permanently_failed state and replay was not enabled.`,
        };
      }
      return {
        success: false,
        action: 'duplicate',
        inProgress: true,
        retryable: true,
        message: `Webhook event ${eventId} is currently held under an active processing lease; retry safely later.`,
      };
    }

    const payload = claim.event.payload as WebhookEventPayload | undefined;
    const replayAttemptCount = claim.event.attemptCount ?? 1;
    if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || typeof payload.type !== 'string') {
      const sanitizedMsg = sanitizeBillingErrorMessage('Stored webhook payload is invalid or missing event metadata.');
      const persistOutcome = await this.recordBillingFailureState({
        eventId: claim.event.eventId,
        leaseOwner: claim.leaseOwner,
        targetStatus: 'permanently_failed',
        errorMessage: sanitizedMsg,
        nextRetryAt: null,
        attemptCount: replayAttemptCount,
        classification: 'invalid_stored_payload',
        operation: 'manual_replay',
      });
      const err: any = new Error(sanitizedMsg);
      err.statusCode = persistOutcome.persisted ? 400 : 503;
      err.permanentlyFailed = persistOutcome.persisted;
      err.failureStatePersisted = persistOutcome.persisted;
      if (!persistOutcome.persisted) {
        err.persistenceError = persistOutcome.persistenceError;
      }
      throw err;
    }

    return this.executeClaimedWebhookEvent(
      payload,
      claim.leaseOwner,
      effectiveLease,
      replayAttemptCount,
      effectiveRecovery,
      'manual_replay'
    );
  }

  private async recordBillingFailureState(params: {
    eventId: string;
    leaseOwner?: string;
    targetStatus: 'failed' | 'permanently_failed';
    errorMessage: string;
    nextRetryAt: string | null;
    attemptCount: number;
    classification: string;
    operation: 'webhook' | 'recovery_sweep' | 'manual_replay';
  }): Promise<{ persisted: boolean; leaseLost: boolean; persistenceError?: string }> {
    try {
      await this.repo.markBillingEventFailure({
        eventId: params.eventId,
        leaseOwner: params.leaseOwner,
        status: params.targetStatus,
        errorMessage: params.errorMessage,
        nextRetryAt: params.nextRetryAt,
      });
      return { persisted: true, leaseLost: false };
    } catch (persistErr: any) {
      const persistenceError = sanitizeBillingErrorMessage(persistErr);
      const leaseLost =
        persistErr?.code === 'BILLING_LEASE_LOST' ||
        /lease ownership lost or expired/i.test(typeof persistErr?.message === 'string' ? persistErr.message : '');
      console.error('[AIXSHOP Billing Error Persistence]', {
        eventId: params.eventId,
        currentStatus: 'processing',
        targetStatus: params.targetStatus,
        attemptCount: params.attemptCount,
        classification: params.classification,
        operation: params.operation,
        leaseOwner: params.leaseOwner || null,
        failureStatePersisted: false,
        leaseLost,
        persistenceError,
        originalError: params.errorMessage,
      });
      return {
        persisted: false,
        leaseLost,
        persistenceError,
      };
    }
  }

  private async executeClaimedWebhookEvent(
    event: WebhookEventPayload,
    leaseOwner: string,
    effectiveLease: { leaseDurationMs: number; heartbeatIntervalMs: number },
    attemptCount: number,
    recoveryPolicy: Required<BillingRecoveryPolicy>,
    operation: 'webhook' | 'recovery_sweep' | 'manual_replay' = 'webhook'
  ): Promise<WebhookProcessingResult> {
    // Automatic lease heartbeat lifecycle + guarded dispatch
    const hb = {
      leaseLost: false,
      leaseLostReason: '',
      stopped: false,
      inFlightRenewal: null as Promise<void> | null,
      token: 0,
    };
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const stopHeartbeat = () => {
      hb.stopped = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const triggerHeartbeatRenewal = () => {
      if (hb.stopped || hb.leaseLost || hb.inFlightRenewal) {
        return;
      }
      const myToken = ++hb.token;
      hb.inFlightRenewal = (async () => {
        try {
          const renewed = await this.renewEventLease(
            event.id,
            leaseOwner,
            effectiveLease.leaseDurationMs
          );
          if (!renewed) {
            hb.leaseLost = true;
            hb.leaseLostReason = 'lease renewal returned false (expired or reclaimed)';
            stopHeartbeat();
            console.warn('[AIXSHOP Billing Heartbeat]', {
              eventId: event.id,
              leaseOwner,
              classification: 'lease_renewal_rejected',
            });
          }
        } catch (renewErr: any) {
          hb.leaseLost = true;
          hb.leaseLostReason = `lease renewal exception (${renewErr?.name || 'Error'})`;
          stopHeartbeat();
          console.error('[AIXSHOP Billing Heartbeat]', {
            eventId: event.id,
            leaseOwner,
            classification: 'lease_renewal_error',
            errorName: renewErr?.name || 'Error',
          });
        } finally {
          if (hb.token === myToken) {
            hb.inFlightRenewal = null;
          }
        }
      })();
    };

    heartbeatTimer = setInterval(triggerHeartbeatRenewal, effectiveLease.heartbeatIntervalMs);
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }

    const beforeCommitGuard = async () => {
      stopHeartbeat();
      if (hb.inFlightRenewal) {
        await hb.inFlightRenewal;
      }
      if (hb.leaseLost) {
        const lostErr: any = new Error(
          `Billing lease ownership lost for event ${event.id}: worker "${leaseOwner}" aborted (${hb.leaseLostReason}).`
        );
        lostErr.code = 'BILLING_LEASE_LOST';
        lostErr.statusCode = 503;
        throw lostErr;
      }
    };

    let result: WebhookProcessingResult;
    try {
      result = await this.processEvent(event, leaseOwner, beforeCommitGuard);

      if (result.action === 'ignored') {
        await beforeCommitGuard();
        await this.repo.updateBillingEventStatus(event.id, 'ignored', undefined, leaseOwner);
      }
    } catch (err: any) {
      stopHeartbeat();
      if (hb.inFlightRenewal) {
        await hb.inFlightRenewal.catch(() => {});
      }
      const isLeaseLost =
        hb.leaseLost ||
        err?.code === 'BILLING_LEASE_LOST' ||
        (typeof err?.message === 'string' && /lease ownership lost or expired/i.test(err.message));
      if (isLeaseLost && err && typeof err === 'object') {
        err.code = err.code || 'BILLING_LEASE_LOST';
        err.statusCode = 503;
      }
      if (!isLeaseLost) {
        const classification = classifyWebhookProcessingError(err);
        const shouldMarkPermanent = !classification.retryable || attemptCount >= recoveryPolicy.maxAttempts;
        const failureStatus: 'failed' | 'permanently_failed' = shouldMarkPermanent
          ? 'permanently_failed'
          : 'failed';
        const nextRetryAt = shouldMarkPermanent
          ? null
          : computeNextRetryAt(attemptCount, recoveryPolicy.baseBackoffMs, recoveryPolicy.maxBackoffMs);
        const errorMessage = sanitizeBillingErrorMessage(err);

        const persistOutcome = await this.recordBillingFailureState({
          eventId: event.id,
          leaseOwner,
          targetStatus: failureStatus,
          errorMessage,
          nextRetryAt,
          attemptCount,
          classification: classification.reason,
          operation,
        });

        if (err && typeof err === 'object') {
          err.failureStatePersisted = persistOutcome.persisted;
          if (persistOutcome.persisted) {
            err.permanentlyFailed = shouldMarkPermanent;
          } else {
            // Never claim an event is permanently failed unless DB confirmed the state transition.
            err.permanentlyFailed = false;
            err.persistenceError = persistOutcome.persistenceError;
          }
        }
      }
      throw err;
    } finally {
      stopHeartbeat();
      if (hb.inFlightRenewal) {
        await hb.inFlightRenewal.catch(() => {});
      }
    }

    return result;
  }

  private async processEvent(
    event: WebhookEventPayload,
    leaseOwner?: string,
    beforeCommitGuard?: () => Promise<void>
  ): Promise<WebhookProcessingResult> {
    const dataObj = event.data?.object || {};
    const eventCreated = event.created || Math.floor(Date.now() / 1000);

    switch (event.type) {
      case 'checkout.session.completed': {
        const workspaceId = dataObj.client_reference_id || dataObj.metadata?.workspaceId || dataObj.workspaceId;
        if (!workspaceId) {
          return { success: false, action: 'ignored', message: 'Missing workspace reference in checkout session.' };
        }

        const workspace = await this.repo.getWorkspaceById(workspaceId);
        if (!workspace) {
          return { success: false, action: 'ignored', message: `Workspace "${workspaceId}" not found in database.` };
        }

        // Validate real Stripe customer and subscription IDs (no fabricated placeholders in Stripe mode)
        const isStripe = this.provider.providerName === 'stripe';
        const customerId = dataObj.customer || dataObj.customerId;
        const subscriptionId = dataObj.subscription || dataObj.subscriptionId;

        if (isStripe) {
          if (!customerId || typeof customerId !== 'string' || !customerId.startsWith('cus_')) {
            const err: any = new Error(`[Billing] Stripe checkout session ${event.id} missing valid customer ID (must start with cus_).`);
            err.statusCode = 400;
            throw err;
          }
          if (!subscriptionId || typeof subscriptionId !== 'string' || !subscriptionId.startsWith('sub_')) {
            const err: any = new Error(`[Billing] Stripe checkout session ${event.id} missing valid subscription ID (must start with sub_).`);
            err.statusCode = 400;
            throw err;
          }
        } else {
          if (!customerId) {
            return { success: false, action: 'ignored', message: 'Missing customer reference in checkout session.' };
          }
        }

        // Verify Price ID if present against authoritative catalog
        const priceId = dataObj.line_items?.data?.[0]?.price?.id || dataObj.priceId || dataObj.metadata?.priceId;
        let planFromPrice = priceId ? findPlanByPriceId(priceId) : null;
        if (priceId && !planFromPrice && isStripe) {
          const err: any = new Error(`[Billing] Configured price ID "${priceId}" is not associated with an authoritative plan.`);
          err.statusCode = 400;
          throw err;
        }

        const tierName = planFromPrice?.tier || dataObj.metadata?.tier || dataObj.tier || 'Starter';
        const planKey = Object.keys(AUTHORITATIVE_PLANS).find(
          k => AUTHORITATIVE_PLANS[k].tier.toLowerCase() === tierName.toLowerCase()
        );
        const plan = planKey ? AUTHORITATIVE_PLANS[planKey] : AUTHORITATIVE_PLANS['starter'];

        // Evaluate payment status: in Stripe mode, missing/invalid payment_status fails closed;
        // only 'paid' or 'no_payment_required' grant paid store entitlements.
        const paymentStatus =
          typeof dataObj.payment_status === 'string'
            ? dataObj.payment_status.trim().toLowerCase()
            : isStripe
            ? ''
            : dataObj.payment_status === undefined
            ? 'paid'
            : '';
        let subStatus: SubscriptionRecord['status'] = 'incomplete';
        let grantTier = false;

        if (paymentStatus === 'paid') {
          subStatus = 'active';
          grantTier = true;
        } else if (paymentStatus === 'no_payment_required') {
          subStatus = 'trialing';
          grantTier = true;
        } else {
          // Delayed, unpaid, missing (in Stripe mode), or unknown payment status fails closed
          subStatus = 'incomplete';
          grantTier = false;
        }

        // Out-of-order check
        const existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
        if (existingSub && existingSub.lastEventCreated && eventCreated < existingSub.lastEventCreated) {
          return {
            success: true,
            action: 'ignored',
            message: `Stale checkout event (${eventCreated} < ${existingSub.lastEventCreated}) safely ignored.`,
          };
        }

        const now = new Date();
        const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        const subscriptionRecord: SubscriptionRecord = {
          id: existingSub?.id || `subrec_${workspaceId}`,
          workspaceId,
          provider: this.provider.providerName,
          customerId: customerId || `cust_${workspaceId}`,
          subscriptionId: subscriptionId || `sub_${Date.now()}`,
          tier: plan.tier,
          status: subStatus,
          currentPeriodStart: now.toISOString(),
          currentPeriodEnd: periodEnd.toISOString(),
          cancelAtPeriodEnd: false,
          lastEventCreated: eventCreated,
          createdAt: existingSub?.createdAt || now.toISOString(),
          updatedAt: now.toISOString(),
        };

        const storeProfileUpdate = grantTier ? {
          tier: plan.tier,
          skuLimit: plan.skuLimit === Infinity ? undefined : plan.skuLimit,
        } : undefined;

        if (beforeCommitGuard) await beforeCommitGuard();
        await this.repo.applyBillingTransition({
          eventId: event.id,
          subscription: subscriptionRecord,
          storeProfileUpdate,
          markProcessed: true,
          leaseOwner,
        });

        return {
          success: true,
          action: 'processed',
          message: grantTier 
            ? `Workspace ${workspaceId} successfully upgraded to ${plan.tier} plan.`
            : `Workspace ${workspaceId} checkout recorded with status ${subStatus} (unpaid; tier not elevated).`,
          subscription: subscriptionRecord,
        };
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subId = dataObj.id;
        let workspaceId = dataObj.metadata?.workspaceId || dataObj.workspaceId;

        let existingSub: SubscriptionRecord | null = null;
        if (workspaceId) {
          existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
        } else if (subId) {
          existingSub = await this.repo.getSubscriptionBySubscriptionId(subId);
          if (existingSub) {
            workspaceId = existingSub.workspaceId;
          }
        }

        if (!workspaceId) {
          return { success: false, action: 'ignored', message: 'Missing workspaceId in subscription update.' };
        }

        // Out-of-order event check
        if (existingSub?.lastEventCreated && eventCreated < existingSub.lastEventCreated) {
          return {
            success: true,
            action: 'ignored',
            message: `Stale subscription update event (${eventCreated} < ${existingSub.lastEventCreated}) safely ignored.`,
          };
        }

        const tier: PlanTier = dataObj.metadata?.tier || dataObj.tier || existingSub?.tier || 'Starter';
        const statusEval = normalizeStripeSubscriptionStatus(dataObj.status);
        const status: SubscriptionRecord['status'] = statusEval.status;
        const cancelAtPeriodEnd = Boolean(dataObj.cancel_at_period_end);

        // Do not resurrect already canceled subscriptions unless explicitly reactivated as 'active'
        if (existingSub?.status === 'canceled' && status !== 'active') {
          return {
            success: true,
            action: 'ignored',
            message: `Subscription for workspace ${workspaceId} is already canceled. Status "${statusEval.rawStatus}" ignored.`,
          };
        }

        const planKey = Object.keys(AUTHORITATIVE_PLANS).find(
          k => AUTHORITATIVE_PLANS[k].tier.toLowerCase() === tier.toLowerCase()
        );
        const plan = planKey ? AUTHORITATIVE_PLANS[planKey] : AUTHORITATIVE_PLANS['starter'];

        const subRecord: SubscriptionRecord = {
          id: existingSub?.id || `subrec_${workspaceId}`,
          workspaceId,
          provider: this.provider.providerName,
          customerId: dataObj.customer || existingSub?.customerId || `cust_${workspaceId}`,
          subscriptionId: dataObj.id || existingSub?.subscriptionId || `sub_${Date.now()}`,
          tier: plan.tier,
          status,
          currentPeriodStart: dataObj.current_period_start ? new Date(dataObj.current_period_start * 1000).toISOString() : new Date().toISOString(),
          currentPeriodEnd: dataObj.current_period_end ? new Date(dataObj.current_period_end * 1000).toISOString() : new Date(Date.now() + 30 * 86400000).toISOString(),
          cancelAtPeriodEnd,
          lastEventCreated: eventCreated,
          createdAt: existingSub?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        // Fail-closed entitlement synchronization:
        // - Only 'active' or 'trialing' authorize paid tier entitlements.
        // - 'past_due' restricts new SKU imports via entitlementService while preserving tier metadata for payment recovery.
        // - Any other status ('canceled', 'expired', 'unpaid', 'incomplete', 'pending', or unknown/missing) immediately downgrades store tier to 'Free Audit'.
        let storeProfileUpdate: { tier: PlanTier; skuLimit?: number } | undefined = undefined;

        if (statusEval.isAuthorizedPaidTier) {
          storeProfileUpdate = {
            tier: plan.tier,
            skuLimit: plan.skuLimit === Infinity ? undefined : plan.skuLimit,
          };
        } else if (status !== 'past_due') {
          storeProfileUpdate = {
            tier: 'Free Audit',
            skuLimit: AUTHORITATIVE_PLANS['free_audit'].skuLimit,
          };
        }

        if (beforeCommitGuard) await beforeCommitGuard();
        await this.repo.applyBillingTransition({
          eventId: event.id,
          subscription: subRecord,
          storeProfileUpdate,
          markProcessed: true,
          leaseOwner,
        });

        return {
          success: true,
          action: 'processed',
          message: cancelAtPeriodEnd
            ? `Subscription set to cancel at period end; paid access preserved until ${subRecord.currentPeriodEnd}.`
            : `Subscription updated for workspace ${workspaceId} to status: ${status}.`,
          subscription: subRecord,
        };
      }

      case 'customer.subscription.deleted': {
        const subId = dataObj.id;
        let workspaceId = dataObj.metadata?.workspaceId || dataObj.workspaceId;

        let existingSub: SubscriptionRecord | null = null;
        if (workspaceId) {
          existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
        } else if (subId) {
          existingSub = await this.repo.getSubscriptionBySubscriptionId(subId);
          if (existingSub) {
            workspaceId = existingSub.workspaceId;
          }
        }

        if (!workspaceId) {
          return { success: false, action: 'ignored', message: 'Missing workspaceId in subscription deletion.' };
        }

        // Out-of-order check
        if (existingSub?.lastEventCreated && eventCreated < existingSub.lastEventCreated) {
          return {
            success: true,
            action: 'ignored',
            message: `Stale subscription deletion event (${eventCreated} < ${existingSub.lastEventCreated}) safely ignored.`,
          };
        }

        const updatedSub: SubscriptionRecord = {
          id: existingSub?.id || `subrec_${workspaceId}`,
          workspaceId,
          provider: this.provider.providerName,
          customerId: dataObj.customer || existingSub?.customerId || `cust_${workspaceId}`,
          subscriptionId: dataObj.id || existingSub?.subscriptionId || `sub_${Date.now()}`,
          tier: existingSub?.tier || 'Free Audit',
          status: 'canceled',
          currentPeriodStart: existingSub?.currentPeriodStart || new Date().toISOString(),
          currentPeriodEnd: existingSub?.currentPeriodEnd || new Date().toISOString(),
          cancelAtPeriodEnd: true,
          lastEventCreated: eventCreated,
          createdAt: existingSub?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        // Downgrade store to Free Audit without deleting existing products
        if (beforeCommitGuard) await beforeCommitGuard();
        await this.repo.applyBillingTransition({
          eventId: event.id,
          subscription: updatedSub,
          storeProfileUpdate: {
            tier: 'Free Audit',
            skuLimit: AUTHORITATIVE_PLANS['free_audit'].skuLimit,
          },
          markProcessed: true,
          leaseOwner,
        });

        return {
          success: true,
          action: 'processed',
          message: `Subscription for workspace ${workspaceId} was canceled and safely downgraded to Free Audit without data loss.`,
          subscription: updatedSub,
        };
      }

      case 'invoice.payment_succeeded': {
        const subId = dataObj.subscription;
        let workspaceId = dataObj.subscription_details?.metadata?.workspaceId || dataObj.metadata?.workspaceId || dataObj.workspaceId;

        let existingSub: SubscriptionRecord | null = null;
        if (workspaceId) {
          existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
        } else if (subId) {
          existingSub = await this.repo.getSubscriptionBySubscriptionId(subId);
          if (existingSub) {
            workspaceId = existingSub.workspaceId;
          }
        }

        if (workspaceId && existingSub) {
          // Out-of-order event check
          if (existingSub.lastEventCreated && eventCreated < existingSub.lastEventCreated) {
            return { success: true, action: 'ignored', message: 'Stale invoice payment event safely ignored.' };
          }

          // Do not resurrect canceled subscription
          if (existingSub.status === 'past_due') {
            const updatedSub: SubscriptionRecord = {
              ...existingSub,
              status: 'active',
              lastEventCreated: eventCreated,
              updatedAt: new Date().toISOString(),
            };

            const planDef = AUTHORITATIVE_PLANS[existingSub.tier.toLowerCase().replace(' ', '_')];
            const rawLimit = planDef?.skuLimit;
            const safeSkuLimit = (rawLimit === Infinity || rawLimit === undefined) ? undefined : rawLimit;

            if (beforeCommitGuard) await beforeCommitGuard();
            await this.repo.applyBillingTransition({
              eventId: event.id,
              subscription: updatedSub,
              storeProfileUpdate: {
                tier: existingSub.tier,
                skuLimit: safeSkuLimit,
              },
              markProcessed: true,
              leaseOwner,
            });
            return { success: true, action: 'processed', message: 'Invoice payment succeeded recorded and subscription reactivated.', subscription: updatedSub };
          }
        }
        if (leaseOwner) {
          if (beforeCommitGuard) await beforeCommitGuard();
          await this.repo.updateBillingEventStatus(event.id, 'processed', undefined, leaseOwner);
        }
        return { success: true, action: 'processed', message: 'Invoice payment succeeded recorded.' };
      }

      case 'invoice.payment_failed': {
        const subId = dataObj.subscription;
        let workspaceId = dataObj.subscription_details?.metadata?.workspaceId || dataObj.metadata?.workspaceId || dataObj.workspaceId;

        let existingSub: SubscriptionRecord | null = null;
        if (workspaceId) {
          existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
        } else if (subId) {
          existingSub = await this.repo.getSubscriptionBySubscriptionId(subId);
          if (existingSub) {
            workspaceId = existingSub.workspaceId;
          }
        }

        if (workspaceId && existingSub) {
          // Out-of-order event check
          if (existingSub.lastEventCreated && eventCreated < existingSub.lastEventCreated) {
            return { success: true, action: 'ignored', message: 'Stale invoice payment failure event safely ignored.' };
          }

          if (existingSub.status !== 'canceled') {
            const updatedSub: SubscriptionRecord = {
              ...existingSub,
              status: 'past_due',
              lastEventCreated: eventCreated,
              updatedAt: new Date().toISOString(),
            };

            if (beforeCommitGuard) await beforeCommitGuard();
            await this.repo.applyBillingTransition({
              eventId: event.id,
              subscription: updatedSub,
              markProcessed: true,
              leaseOwner,
            });
            return { success: true, action: 'processed', message: 'Invoice payment failure processed; status marked past_due.', subscription: updatedSub };
          }
        }
        if (leaseOwner) {
          if (beforeCommitGuard) await beforeCommitGuard();
          await this.repo.updateBillingEventStatus(event.id, 'processed', undefined, leaseOwner);
        }
        return { success: true, action: 'processed', message: 'Invoice payment failure processed; status marked past_due.' };
      }

      case 'charge.refunded': {
        const subId = dataObj.subscription;
        let workspaceId = dataObj.metadata?.workspaceId || dataObj.workspaceId;

        let existingSub: SubscriptionRecord | null = null;
        if (workspaceId) {
          existingSub = await this.repo.getSubscriptionByWorkspace(workspaceId);
        } else if (subId) {
          existingSub = await this.repo.getSubscriptionBySubscriptionId(subId);
          if (existingSub) {
            workspaceId = existingSub.workspaceId;
          }
        }

        if (!workspaceId || !existingSub) {
          return { success: true, action: 'ignored', message: 'No matching workspace subscription found for refund event.' };
        }

        if (existingSub.lastEventCreated && eventCreated < existingSub.lastEventCreated) {
          return {
            success: true,
            action: 'ignored',
            message: `Stale charge.refunded event (${eventCreated} < ${existingSub.lastEventCreated}) safely ignored.`,
          };
        }

        const isFullRefund = Boolean(
          dataObj.refunded === true ||
          (typeof dataObj.amount === 'number' &&
            dataObj.amount > 0 &&
            typeof dataObj.amount_refunded === 'number' &&
            dataObj.amount_refunded >= dataObj.amount)
        );

        if (isFullRefund) {
          const updatedSub: SubscriptionRecord = {
            ...existingSub,
            status: 'canceled',
            cancelAtPeriodEnd: true,
            lastEventCreated: eventCreated,
            updatedAt: new Date().toISOString(),
          };

          if (beforeCommitGuard) await beforeCommitGuard();
          await this.repo.applyBillingTransition({
            eventId: event.id,
            subscription: updatedSub,
            storeProfileUpdate: {
              tier: 'Free Audit',
              skuLimit: AUTHORITATIVE_PLANS['free_audit'].skuLimit,
            },
            markProcessed: true,
            leaseOwner,
          });

          return {
            success: true,
            action: 'processed',
            message: `Full refund processed for workspace ${workspaceId}; subscription canceled and downgraded to Free Audit without data loss.`,
            subscription: updatedSub,
          };
        }

        if (leaseOwner) {
          if (beforeCommitGuard) await beforeCommitGuard();
          await this.repo.updateBillingEventStatus(event.id, 'processed', undefined, leaseOwner);
        }
        return {
          success: true,
          action: 'processed',
          message: `Partial refund recorded for workspace ${workspaceId}; existing plan preserved.`,
          subscription: existingSub,
        };
      }

      default:
        return { success: true, action: 'ignored', message: `Unhandled event type "${event.type}" safely ignored.` };
    }
  }
}
