import net from 'node:net';
import { EvidenceDocument, ExternalVerificationStatus } from '../../types';

export type ExternalRegistryOutcome =
  | 'verified'
  | 'mismatched'
  | 'ambiguous'
  | 'timeout'
  | 'unavailable'
  | 'malformed'
  | 'unconfigured'
  | 'rejected';

export interface ExternalRegistryQueryInput {
  workspaceId: string;
  productId: string;
  evidenceId: string;
  title: string;
  type: EvidenceDocument['type'];
  issuer: string;
  url?: string;
  barcodes: string[];
  brand?: string;
  requestedReference?: string;
}

export interface ExternalRegistryProviderResponse {
  outcome: ExternalRegistryOutcome;
  providerName: string;
  providerRef?: string;
  requestAt: string;
  responseAt: string;
  matchedIdentifier?: string;
  matchedRecordSummary?: {
    issuer?: string;
    brand?: string;
    status?: string;
    registryCode?: string;
  };
  reason?: string;
}

export interface ExternalRegistryProviderAdapter {
  readonly providerName: string;
  verifyRecord(
    input: ExternalRegistryQueryInput,
    options?: { timeoutMs?: number }
  ): Promise<ExternalRegistryProviderResponse>;
}

export interface ExternalRegistryVerificationEvaluation {
  verified: boolean;
  outcome: ExternalRegistryOutcome;
  nextExternalStatus: ExternalVerificationStatus;
  providerName?: string;
  providerRef?: string;
  requestAt?: string;
  responseAt?: string;
  matchedIdentifier?: string;
  sanitizedEvidence?: Record<string, any>;
  reason: string;
}

function isDisallowedHostnameOrIp(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower) return true;
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) {
    return true;
  }
  const ipVer = net.isIP(lower);
  if (ipVer === 4) {
    const parts = lower.split('.').map(Number);
    if (parts[0] === 127 || parts[0] === 10 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
  } else if (ipVer === 6) {
    if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
      return true;
    }
  }
  return false;
}

export function validateExternalRegistryProviderUrl(rawUrl: string): { valid: boolean; normalized?: string; error?: string } {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: 'External registry provider URL must use HTTPS.' };
    }
    if (isDisallowedHostnameOrIp(parsed.hostname)) {
      return { valid: false, error: 'External registry provider URL cannot target loopback or private network addresses.' };
    }
    return { valid: true, normalized: parsed.toString() };
  } catch {
    return { valid: false, error: 'External registry provider URL is malformed.' };
  }
}

/**
 * HTTP-backed external registry adapter activated ONLY when explicit server credentials
 * (AIXSHOP_EXTERNAL_REGISTRY_PROVIDER_URL and AIXSHOP_EXTERNAL_REGISTRY_API_KEY) are configured.
 * Never returns fabricated verification when unconfigured.
 */
export class ConfiguredHttpExternalRegistryProvider implements ExternalRegistryProviderAdapter {
  readonly providerName: string;
  private readonly endpointUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    providerName: string;
    endpointUrl: string;
    apiKey: string;
    fetchImpl?: typeof fetch;
  }) {
    this.providerName = options.providerName;
    this.endpointUrl = options.endpointUrl;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async verifyRecord(
    input: ExternalRegistryQueryInput,
    options?: { timeoutMs?: number }
  ): Promise<ExternalRegistryProviderResponse> {
    const timeoutMs = Math.max(500, Math.min(15000, options?.timeoutMs ?? 5000));
    const requestAt = new Date().toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
        body: JSON.stringify({
          evidenceId: input.evidenceId,
          type: input.type,
          title: input.title,
          issuer: input.issuer,
          url: input.url,
          barcodes: input.barcodes,
          brand: input.brand,
          reference: input.requestedReference,
        }),
        signal: controller.signal,
      });

      const responseAt = new Date().toISOString();
      if (!response.ok) {
        return {
          outcome: response.status >= 500 ? 'unavailable' : 'rejected',
          providerName: this.providerName,
          requestAt,
          responseAt,
          reason: `External registry returned HTTP ${response.status}.`,
        };
      }

      let body: any;
      try {
        body = await response.json();
      } catch {
        return {
          outcome: 'malformed',
          providerName: this.providerName,
          requestAt,
          responseAt,
          reason: 'External registry response was not valid JSON.',
        };
      }

      if (!body || typeof body !== 'object' || typeof body.status !== 'string') {
        return {
          outcome: 'malformed',
          providerName: this.providerName,
          requestAt,
          responseAt,
          reason: 'External registry response is missing required verification fields.',
        };
      }

      const rawStatus = body.status.trim().toLowerCase();
      const providerRef = typeof body.referenceId === 'string' ? body.referenceId.trim() : undefined;
      const matchedIdentifier =
        typeof body.matchedIdentifier === 'string' ? body.matchedIdentifier.trim() : undefined;

      if (rawStatus === 'verified') {
        return {
          outcome: 'verified',
          providerName: this.providerName,
          providerRef,
          requestAt,
          responseAt,
          matchedIdentifier,
          matchedRecordSummary: {
            issuer: typeof body.issuer === 'string' ? body.issuer.trim() : undefined,
            brand: typeof body.brand === 'string' ? body.brand.trim() : undefined,
            status: rawStatus,
            registryCode: typeof body.registryCode === 'string' ? body.registryCode.trim() : undefined,
          },
          reason: typeof body.reason === 'string' ? body.reason.trim() : 'Verified by external registry provider.',
        };
      }

      if (rawStatus === 'ambiguous' || rawStatus === 'mismatched' || rawStatus === 'rejected') {
        return {
          outcome: rawStatus,
          providerName: this.providerName,
          providerRef,
          requestAt,
          responseAt,
          matchedIdentifier,
          reason: typeof body.reason === 'string' ? body.reason.trim() : `External registry returned "${rawStatus}".`,
        };
      }

      return {
        outcome: 'malformed',
        providerName: this.providerName,
        requestAt,
        responseAt,
        reason: `Unrecognized external registry response status "${rawStatus}".`,
      };
    } catch (err: any) {
      const responseAt = new Date().toISOString();
      if (err?.name === 'AbortError' || /abort|timeout/i.test(String(err?.message || ''))) {
        return {
          outcome: 'timeout',
          providerName: this.providerName,
          requestAt,
          responseAt,
          reason: `External registry request timed out after ${timeoutMs}ms.`,
        };
      }
      return {
        outcome: 'unavailable',
        providerName: this.providerName,
        requestAt,
        responseAt,
        reason: 'External registry provider connection failed.',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function getConfiguredExternalRegistryProvider(): ExternalRegistryProviderAdapter | null {
  const url = process.env.AIXSHOP_EXTERNAL_REGISTRY_PROVIDER_URL?.trim() || '';
  const apiKey = process.env.AIXSHOP_EXTERNAL_REGISTRY_API_KEY?.trim() || '';
  const providerName =
    process.env.AIXSHOP_EXTERNAL_REGISTRY_PROVIDER_NAME?.trim() || 'configured_external_registry';

  if (!url || !apiKey) {
    return null;
  }

  const urlCheck = validateExternalRegistryProviderUrl(url);
  if (!urlCheck.valid || !urlCheck.normalized) {
    return null;
  }

  return new ConfiguredHttpExternalRegistryProvider({
    providerName,
    endpointUrl: urlCheck.normalized,
    apiKey,
  });
}

function normalizeIdToken(val: string | undefined): string {
  return String(val || '').trim().toLowerCase();
}

/**
 * Validates that an external provider response strictly corresponds to the submitted evidence
 * or product identifier before allowing `external_registry_verified`.
 */
export function evaluateExternalRegistryResponse(
  input: ExternalRegistryQueryInput,
  response: ExternalRegistryProviderResponse | null | undefined
): ExternalRegistryVerificationEvaluation {
  if (!response) {
    return {
      verified: false,
      outcome: 'malformed',
      nextExternalStatus: 'not_externally_verified',
      reason: 'External registry returned an empty response.',
    };
  }

  const providerName = String(response.providerName || '').trim();
  const providerRef = response.providerRef ? String(response.providerRef).trim() : undefined;
  const requestAt = response.requestAt;
  const responseAt = response.responseAt;

  if (!providerName || !requestAt || !responseAt) {
    return {
      verified: false,
      outcome: 'malformed',
      nextExternalStatus: 'not_externally_verified',
      providerName: providerName || undefined,
      requestAt,
      responseAt,
      reason: 'External registry response omitted required provider identity or timestamps.',
    };
  }

  if (response.outcome !== 'verified') {
    return {
      verified: false,
      outcome: response.outcome,
      nextExternalStatus: 'not_externally_verified',
      providerName,
      providerRef,
      requestAt,
      responseAt,
      matchedIdentifier: response.matchedIdentifier,
      reason: response.reason || `External registry returned outcome "${response.outcome}".`,
    };
  }

  if (!providerRef) {
    return {
      verified: false,
      outcome: 'malformed',
      nextExternalStatus: 'not_externally_verified',
      providerName,
      requestAt,
      responseAt,
      reason: 'External registry verified response is missing required provider reference ID.',
    };
  }

  // Validate returned identifier corresponds to submitted evidence/barcodes/brand/reference
  const matched = normalizeIdToken(response.matchedIdentifier);
  if (!matched) {
    return {
      verified: false,
      outcome: 'malformed',
      nextExternalStatus: 'not_externally_verified',
      providerName,
      providerRef,
      requestAt,
      responseAt,
      reason: 'External registry verified response did not include matchedIdentifier.',
    };
  }

  const allowedCandidates = new Set<string>([
    normalizeIdToken(input.evidenceId),
    normalizeIdToken(input.requestedReference),
    normalizeIdToken(input.brand),
    normalizeIdToken(input.issuer),
    ...input.barcodes.map(normalizeIdToken),
  ]);
  allowedCandidates.delete('');

  if (!allowedCandidates.has(matched)) {
    return {
      verified: false,
      outcome: 'mismatched',
      nextExternalStatus: 'not_externally_verified',
      providerName,
      providerRef,
      requestAt,
      responseAt,
      matchedIdentifier: response.matchedIdentifier,
      reason: `External registry matched identifier "${response.matchedIdentifier}" does not correspond to the submitted product or evidence record.`,
    };
  }

  // Also ensure issuer summary (when provided) does not conflict wildly or stay empty
  const sanitizedEvidence: Record<string, any> = {
    matchedIdentifier: response.matchedIdentifier,
    providerName,
    providerRef,
    requestAt,
    responseAt,
    outcome: 'verified',
  };
  if (response.matchedRecordSummary?.issuer) {
    sanitizedEvidence.issuer = String(response.matchedRecordSummary.issuer).slice(0, 200);
  }
  if (response.matchedRecordSummary?.brand) {
    sanitizedEvidence.brand = String(response.matchedRecordSummary.brand).slice(0, 200);
  }
  if (response.matchedRecordSummary?.registryCode) {
    sanitizedEvidence.registryCode = String(response.matchedRecordSummary.registryCode).slice(0, 120);
  }

  return {
    verified: true,
    outcome: 'verified',
    nextExternalStatus: 'external_registry_verified',
    providerName,
    providerRef,
    requestAt,
    responseAt,
    matchedIdentifier: response.matchedIdentifier,
    sanitizedEvidence,
    reason: response.reason || `Externally verified by ${providerName} (ref=${providerRef}).`,
  };
}
