import { 
  StorageEnvelopeV1, 
  StoragePayloadV1, 
  StorageLoadResult, 
  StorageSaveResult, 
  StorageBackend 
} from './storageTypes';
import { Product, StoreProfile } from '../../types';

export const STORAGE_KEY = 'aixshop_catalog_v1';
export const CURRENT_SCHEMA_VERSION = 1;
export const APP_VERSION = '1.0.0';
export const DEFAULT_TENANT_ID = 'tenant_solstice_demo';

// Safe memory storage fallback for environments without localStorage (e.g. SSR or testing)
export class MemoryStorageBackend implements StorageBackend {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  key(index: number): string | null {
    const keys = Array.from(this.store.keys());
    return keys[index] ?? null;
  }

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

export function getDefaultBackend(): StorageBackend {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      // Test storage accessibility
      const testKey = '__aixshop_storage_test__';
      window.localStorage.setItem(testKey, '1');
      window.localStorage.removeItem(testKey);
      return window.localStorage;
    } catch {
      // localStorage is blocked (e.g. strict private mode or quota exception)
      return new MemoryStorageBackend();
    }
  }
  return new MemoryStorageBackend();
}

/**
 * Validates the structural integrity of a candidate StoragePayloadV1.
 */
export function validateStoragePayload(payload: unknown): payload is StoragePayloadV1 {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const p = payload as Record<string, unknown>;

  // Products collection check
  if (!Array.isArray(p.products)) {
    return false;
  }
  for (const item of p.products) {
    if (!item || typeof item !== 'object') return false;
    const prod = item as Partial<Product>;
    if (typeof prod.id !== 'string' || typeof prod.title !== 'string' || typeof prod.attributes !== 'object') {
      return false;
    }
  }

  // Collections type assertions
  if (!Array.isArray(p.variants) || !Array.isArray(p.offers)) {
    return false;
  }
  if (!Array.isArray(p.findings) || !Array.isArray(p.actions)) {
    return false;
  }
  if (!Array.isArray(p.evidence)) {
    return false;
  }

  // StoreProfile assertion
  if (!p.storeProfile || typeof p.storeProfile !== 'object') {
    return false;
  }
  const store = p.storeProfile as Partial<StoreProfile>;
  if (typeof store.name !== 'string' || typeof store.platform !== 'string' || typeof store.currency !== 'string') {
    return false;
  }

  return true;
}

/**
 * Filters payload against an explicit allowlist to prevent arbitrary state
 * or sensitive credentials from entering client storage.
 */
export function sanitizePayloadAllowlist(payload: StoragePayloadV1): StoragePayloadV1 {
  const SENSITIVE_KEYS = ['apiKey', 'oauthToken', 'clientSecret', 'password', 'bearerToken', 'secret'];

  const cleanObject = <T>(obj: T): T => {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(cleanObject) as unknown as T;

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (!SENSITIVE_KEYS.includes(key)) {
        result[key] = val;
      }
    }
    return result as T;
  };

  return {
    products: cleanObject(payload.products),
    variants: cleanObject(payload.variants),
    offers: cleanObject(payload.offers),
    findings: cleanObject(payload.findings),
    actions: cleanObject(payload.actions),
    evidence: cleanObject(payload.evidence),
    storeProfile: cleanObject(payload.storeProfile),
  };
}

export class CatalogStorageAdapter {
  private backend: StorageBackend;
  private readOnlyMode: boolean = false;
  private readOnlyReason: string | null = null;

  constructor(customBackend?: StorageBackend) {
    this.backend = customBackend || getDefaultBackend();
  }

  public isReadOnly(): boolean {
    return this.readOnlyMode;
  }

  public getReadOnlyReason(): string | null {
    return this.readOnlyReason;
  }

  public resetReadOnly(): void {
    this.readOnlyMode = false;
    this.readOnlyReason = null;
  }

  /**
   * Safe corruption backup helper: persists corrupt raw data to a timestamped backup key
   * and clears the standard storage slot.
   */
  private backupAndClear(raw: string): string {
    const backupKey = `${STORAGE_KEY}_corrupt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    try {
      this.backend.setItem(backupKey, raw);
      this.backend.removeItem(STORAGE_KEY);
    } catch {
      // Ignore backup write failure if backend is write-restricted
    }
    return backupKey;
  }

  /**
   * Loads and validates persisted state according to Domain Contract v1.2.
   */
  public load(): StorageLoadResult {
    let raw: string | null = null;
    try {
      raw = this.backend.getItem(STORAGE_KEY);
    } catch (e) {
      return {
        type: 'storage_failure',
        error: (e as Error).message || 'Failed to access storage',
        isRecoverable: true,
      };
    }

    if (raw === null || raw.trim() === '') {
      return { type: 'not_found' };
    }

    // 1. JSON parsing check
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const backupKey = this.backupAndClear(raw);
      return {
        type: 'corrupt',
        error: 'JSON_PARSE_ERROR',
        rawValue: raw,
        backupKey,
      };
    }

    // 2. Object validation
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const backupKey = this.backupAndClear(raw);
      return {
        type: 'corrupt',
        error: 'INVALID_ENVELOPE_TYPE',
        rawValue: raw,
        backupKey,
      };
    }

    const envelope = parsed as Record<string, unknown>;

    // 3. Schema version verification
    if (
      typeof envelope.schemaVersion !== 'number' || 
      !Number.isInteger(envelope.schemaVersion) || 
      envelope.schemaVersion < 1
    ) {
      const backupKey = this.backupAndClear(raw);
      return {
        type: 'corrupt',
        error: 'MISSING_SCHEMA_VERSION',
        rawValue: raw,
        backupKey,
      };
    }

    // 4. Future schema version protection
    if (envelope.schemaVersion > CURRENT_SCHEMA_VERSION) {
      // PRESERVE the key untouched! Do not overwrite with seed data or delete!
      this.readOnlyMode = true;
      this.readOnlyReason = `Stored data uses future schema version ${envelope.schemaVersion} (supported: ${CURRENT_SCHEMA_VERSION}). Local mutations are disabled.`;
      return {
        type: 'unsupported_version',
        foundVersion: envelope.schemaVersion,
        rawEnvelope: parsed,
      };
    }

    // 5. Envelope metadata and payload structural validation
    if (
      typeof envelope.appVersion !== 'string' || 
      typeof envelope.tenantId !== 'string' ||
      typeof envelope.timestamp !== 'string'
    ) {
      const backupKey = this.backupAndClear(raw);
      return {
        type: 'corrupt',
        error: 'INVALID_ENVELOPE_METADATA',
        rawValue: raw,
        backupKey,
      };
    }

    if (!envelope.payload || !validateStoragePayload(envelope.payload)) {
      const backupKey = this.backupAndClear(raw);
      return {
        type: 'corrupt',
        error: 'INVALID_PAYLOAD_STRUCTURE',
        rawValue: raw,
        backupKey,
      };
    }

    return {
      type: 'valid',
      envelope: parsed as StorageEnvelopeV1,
    };
  }

  /**
   * Serializes and persists catalog state within an allowlisted envelope.
   */
  public save(payload: StoragePayloadV1): StorageSaveResult {
    if (this.readOnlyMode) {
      return {
        success: false,
        error: this.readOnlyReason || 'Storage is in read-only compatibility mode.',
        isBlockedByReadOnly: true,
      };
    }

    const sanitizedPayload = sanitizePayloadAllowlist(payload);

    const envelope: StorageEnvelopeV1 = {
      schemaVersion: 1,
      appVersion: APP_VERSION,
      timestamp: new Date().toISOString(),
      tenantId: DEFAULT_TENANT_ID,
      payload: sanitizedPayload,
    };

    try {
      const serialized = JSON.stringify(envelope);
      this.backend.setItem(STORAGE_KEY, serialized);
      return { success: true, timestamp: envelope.timestamp };
    } catch (e) {
      const errorMsg = (e as Error).message || 'Write failed';
      const isQuota = errorMsg.toLowerCase().includes('quota') || (e as Error).name === 'QuotaExceededError';
      return {
        success: false,
        error: errorMsg,
        isQuotaExceeded: isQuota,
      };
    }
  }

  /**
   * Non-destructively clears standard storage.
   * If in read-only compatibility mode, refuses to delete the future-version envelope.
   */
  public clear(): boolean {
    if (this.readOnlyMode) {
      return false;
    }
    try {
      this.backend.removeItem(STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Helper to inspect any preserved corruption backup keys.
   */
  public getBackupKeys(): string[] {
    const keys: string[] = [];
    if (!this.backend.length || !this.backend.key) {
      return keys;
    }
    for (let i = 0; i < this.backend.length; i++) {
      const k = this.backend.key(i);
      if (k && k.startsWith(`${STORAGE_KEY}_corrupt_`)) {
        keys.push(k);
      }
    }
    return keys;
  }
}
