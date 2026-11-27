import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const SENSITIVE_KEY_RE =
  /^(password|passwd|pwd|secret|token|accessToken|refreshToken|apiKey|api_key|authorization|cookie|set-cookie|signature|client_secret|smtpPass|webhookUrl|webhook_url)$/i;

export type StructuredLogLevel = 'info' | 'warn' | 'error';

export type OpsAlertSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface OpsAlertPayload {
  severity: OpsAlertSeverity;
  alertKey: string;
  title: string;
  summary: string;
  requestId?: string;
  workspaceId?: string;
  details?: Record<string, unknown>;
}

export interface OpsAlertDeliveryResult {
  sent: boolean;
  reason?: 'unconfigured' | 'invalid_webhook_url' | 'throttled' | 'http_error' | 'network_error';
  statusCode?: number;
}

export function maskEmailAddress(email: string): string {
  const trimmed = email.trim();
  const atIdx = trimmed.indexOf('@');
  if (atIdx <= 0 || atIdx >= trimmed.length - 1) {
    return '[REDACTED_EMAIL]';
  }
  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);
  return `${local[0]}***@${domain}`;
}

export function redactMonitoringText(input: unknown): string {
  const raw =
    input instanceof Error
      ? input.message
      : typeof input === 'string'
      ? input
      : String(input ?? '');

  let text = raw
    .replace(/\b(sk|rk)_(live|test)_[A-Za-z0-9_]+\b/g, '[REDACTED_STRIPE_KEY]')
    .replace(/\bwhsec_[A-Za-z0-9_]+\b/g, '[REDACTED_WEBHOOK_SECRET]')
    .replace(/\b(shpat|shpca|shpss|shpua)_[A-Za-z0-9_]+\b/g, '[REDACTED_SHOPIFY_TOKEN]')
    .replace(/(postgres(?:ql)?:\/\/)([^:\s/@]+):([^@\s]+)@/gi, '$1***:***@')
    .replace(/(https?:\/\/)([^:\s/@]+):([^@\s]+)@/gi, '$1***:***@')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED_TOKEN]')
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key|signature|cookie|authorization)\s*([:=])\s*([^\s,;]+)/gi,
      '$1$2[REDACTED]'
    )
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (match) => maskEmailAddress(match))
    .replace(/[\r\n\t]+/g, ' ')
    .trim();

  if (text.length > 600) {
    text = `${text.slice(0, 597)}...`;
  }
  return text;
}

export function sanitizeMonitoringPayload(
  value: unknown,
  depth: number = 0
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactMonitoringText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[TRUNCATED]';

  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => sanitizeMonitoringPayload(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = '[REDACTED]';
      } else if (/email/i.test(key) && typeof val === 'string') {
        out[key] = maskEmailAddress(val);
      } else {
        out[key] = sanitizeMonitoringPayload(val, depth + 1);
      }
    }
    return out;
  }

  return redactMonitoringText(String(value));
}

export function getOrCreateRequestId(req: Pick<Request, 'header'>): string {
  const incoming = typeof req.header === 'function' ? req.header('x-request-id') : undefined;
  const trimmed = typeof incoming === 'string' ? incoming.trim() : '';
  if (trimmed && SAFE_REQUEST_ID_RE.test(trimmed)) {
    return trimmed;
  }
  return `req_${crypto.randomBytes(8).toString('hex')}`;
}

export function structuredLog(
  level: StructuredLogLevel,
  event: string,
  details: Record<string, unknown> = {},
  sink?: (line: string, level: StructuredLogLevel) => void
): Record<string, unknown> {
  const sanitized = sanitizeMonitoringPayload(details) as Record<string, unknown>;
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    event,
    service: 'aixshop-api',
    ...sanitized,
  };

  const line = JSON.stringify(record);
  if (sink) {
    sink(line, level);
  } else if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }

  return record;
}

export function isAllowedAlertWebhookUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const isProd = process.env.NODE_ENV === 'production';
    if (parsed.protocol === 'https:') {
      return Boolean(parsed.hostname);
    }
    if (
      !isProd &&
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface OpsAlertServiceOptions {
  webhookUrl?: string;
  throttleMs?: number;
  maxKeys?: number;
  fetchImpl?: typeof fetch;
  nowFn?: () => number;
}

export class OpsAlertService {
  private readonly webhookUrlOverride?: string;
  private readonly throttleMsOverride?: number;
  private readonly maxKeys: number;
  private readonly fetchImpl: typeof fetch;
  private readonly nowFn: () => number;
  private readonly lastAlertAtByKey = new Map<string, number>();

  constructor(options: OpsAlertServiceOptions = {}) {
    this.webhookUrlOverride = options.webhookUrl;
    this.throttleMsOverride = options.throttleMs;
    this.maxKeys = options.maxKeys ?? 500;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  private resolveWebhookUrl(): string {
    return (
      this.webhookUrlOverride !== undefined
        ? this.webhookUrlOverride
        : process.env.OPS_ALERT_WEBHOOK_URL || ''
    ).trim();
  }

  resolveThrottleMs(): number {
    if (
      typeof this.throttleMsOverride === 'number' &&
      Number.isFinite(this.throttleMsOverride) &&
      this.throttleMsOverride >= 0
    ) {
      return this.throttleMsOverride;
    }
    const parsed = Number.parseInt(process.env.OPS_ALERT_THROTTLE_MS || '300000', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300_000;
  }

  isConfigured(): { configured: boolean; valid: boolean } {
    const url = this.resolveWebhookUrl();
    if (!url) return { configured: false, valid: false };
    return { configured: true, valid: isAllowedAlertWebhookUrl(url) };
  }

  private pruneIfNeeded(now: number, throttleMs: number): void {
    if (this.lastAlertAtByKey.size < this.maxKeys) return;
    for (const [key, ts] of this.lastAlertAtByKey.entries()) {
      if (now - ts >= throttleMs) {
        this.lastAlertAtByKey.delete(key);
      }
    }
    if (this.lastAlertAtByKey.size >= this.maxKeys) {
      const oldestKey = this.lastAlertAtByKey.keys().next().value;
      if (oldestKey) this.lastAlertAtByKey.delete(oldestKey);
    }
  }

  async sendAlert(payload: OpsAlertPayload): Promise<OpsAlertDeliveryResult> {
    const webhookUrl = this.resolveWebhookUrl();
    if (!webhookUrl) {
      return { sent: false, reason: 'unconfigured' };
    }
    if (!isAllowedAlertWebhookUrl(webhookUrl)) {
      return { sent: false, reason: 'invalid_webhook_url' };
    }

    const now = this.nowFn();
    const throttleMs = this.resolveThrottleMs();
    const lastSentAt = this.lastAlertAtByKey.get(payload.alertKey);
    if (lastSentAt !== undefined && now - lastSentAt < throttleMs) {
      return { sent: false, reason: 'throttled' };
    }

    this.pruneIfNeeded(now, throttleMs);
    this.lastAlertAtByKey.set(payload.alertKey, now);

    const safeBody = {
      service: 'AIXSHOP v1.0',
      environment: process.env.NODE_ENV || 'development',
      severity: payload.severity,
      alertKey: redactMonitoringText(payload.alertKey),
      title: redactMonitoringText(payload.title),
      summary: redactMonitoringText(payload.summary),
      ...(payload.requestId ? { requestId: redactMonitoringText(payload.requestId) } : {}),
      ...(payload.workspaceId ? { workspaceId: redactMonitoringText(payload.workspaceId) } : {}),
      ...(payload.details ? { details: sanitizeMonitoringPayload(payload.details) } : {}),
      timestamp: new Date(now).toISOString(),
    };

    try {
      const res = await this.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'AIXSHOP-OpsAlert/1.0',
        },
        body: JSON.stringify(safeBody),
        signal: AbortSignal.timeout(4000),
      });

      if (!res.ok) {
        return { sent: false, reason: 'http_error', statusCode: res.status };
      }
      return { sent: true, statusCode: res.status };
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        structuredLog('warn', 'ops_alert_delivery_failed', {
          alertKey: payload.alertKey,
          error: redactMonitoringText(err),
        });
      }
      return { sent: false, reason: 'network_error' };
    }
  }
}

export const defaultOpsAlertService = new OpsAlertService();

export function getMonitoringDiagnostics() {
  const webhookStatus = defaultOpsAlertService.isConfigured();
  return {
    structuredLogging: true,
    correlationHeader: 'X-Request-Id',
    alertWebhookConfigured: webhookStatus.configured,
    alertWebhookValid: webhookStatus.valid,
    alertThrottleMs: defaultOpsAlertService.resolveThrottleMs(),
  };
}

export interface RequestCorrelationMiddlewareOptions {
  logRequests?: boolean;
  logSink?: (line: string, level: StructuredLogLevel) => void;
}

export function createRequestCorrelationMiddleware(
  options: RequestCorrelationMiddlewareOptions = {}
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const startNs = process.hrtime.bigint();
    const requestId = getOrCreateRequestId(req);
    (req as any).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const shouldLog =
      options.logRequests !== undefined
        ? options.logRequests
        : process.env.NODE_ENV !== 'test' && process.env.AIXSHOP_SILENCE_REQUEST_LOGS !== 'true';

    if (shouldLog) {
      res.on('finish', () => {
        const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
        const rawPath = String(req.originalUrl || req.path || '/').split('?')[0];
        const statusCode = res.statusCode;
        const level: StructuredLogLevel =
          statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
        structuredLog(
          level,
          'http_request',
          {
            requestId,
            method: req.method,
            path: rawPath,
            statusCode,
            durationMs: Math.round(elapsedMs * 100) / 100,
            workspaceId: (req as any).workspace?.id || undefined,
          },
          options.logSink
        );
      });
    }

    next();
  };
}
