import { 
  StorageEnvelopeV1, 
  StoragePayloadV1, 
  StorageLoadResult, 
  StorageSaveResult, 
  StorageBackend 
} from './storageTypes';
import { 
  Product, 
  Variant, 
  Offer, 
  Finding, 
  ActionItem, 
  EvidenceDocument, 
  StoreProfile 
} from '../../types';

export const STORAGE_KEY = 'aixshop_catalog_v1';
export const CURRENT_SCHEMA_VERSION = 1;
export const APP_VERSION = '1.0.0';
export const DEFAULT_TENANT_ID = 'tenant_solstice_demo';

/**
 * Safely tests whether window.localStorage is accessible in the current execution context.
 * Any access exception (e.g. security policy, private mode, iframe block) is safely caught.
 */
export function isLocalStorageAvailable(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const storage = window.localStorage;
    if (!storage) return false;
    const testKey = '__aixshop_storage_test__';
    storage.setItem(testKey, '1');
    const val = storage.getItem(testKey);
    storage.removeItem(testKey);
    return val === '1';
  } catch {
    return false;
  }
}

/**
 * Persistent browser storage backend wrapping window.localStorage.
 */
export class LocalStorageBackend implements StorageBackend {
  readonly isDurable = true;

  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      throw new Error(`LocalStorage read failed: ${(e as Error).message}`);
    }
  }

  setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      throw e;
    }
  }

  removeItem(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch (e) {
      throw e;
    }
  }

  key(index: number): string | null {
    try {
      return window.localStorage.key(index);
    } catch {
      return null;
    }
  }

  get length(): number {
    try {
      return window.localStorage.length;
    } catch {
      return 0;
    }
  }

  clear(): void {
    try {
      window.localStorage.clear();
    } catch (e) {
      throw e;
    }
  }
}

/**
 * Safe in-memory storage fallback for environments without durable storage.
 */
export class MemoryStorageBackend implements StorageBackend {
  readonly isDurable = false;
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
  if (isLocalStorageAvailable()) {
    return new LocalStorageBackend();
  }
  return new MemoryStorageBackend();
}

/**
 * Validates the structural integrity and required domain fields of a candidate StoragePayloadV1.
 */
export function validateStoragePayload(payload: unknown): payload is StoragePayloadV1 {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }

  const p = payload as Record<string, unknown>;

  // 1. Products collection check
  if (!Array.isArray(p.products)) {
    return false;
  }
  for (const item of p.products) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const prod = item as Partial<Product>;
    if (
      typeof prod.id !== 'string' || prod.id.trim() === '' ||
      typeof prod.title !== 'string' || prod.title.trim() === '' ||
      typeof prod.brand !== 'string' || prod.brand.trim() === '' ||
      typeof prod.category !== 'string' || prod.category.trim() === '' ||
      !prod.attributes || typeof prod.attributes !== 'object' || Array.isArray(prod.attributes) ||
      typeof prod.completenessScore !== 'number' || isNaN(prod.completenessScore)
    ) {
      return false;
    }
  }

  // 2. Variants collection check
  if (!Array.isArray(p.variants)) {
    return false;
  }
  for (const item of p.variants) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const v = item as Partial<Variant>;
    if (
      typeof v.id !== 'string' || v.id.trim() === '' ||
      typeof v.title !== 'string' || v.title.trim() === '' ||
      typeof v.sku !== 'string' || v.sku.trim() === '' ||
      typeof v.price !== 'number' || isNaN(v.price)
    ) {
      return false;
    }
  }

  // 3. Offers collection check
  if (!Array.isArray(p.offers)) {
    return false;
  }
  for (const item of p.offers) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const o = item as Partial<Offer>;
    if (
      typeof o.id !== 'string' || o.id.trim() === '' ||
      typeof o.price !== 'number' || isNaN(o.price) ||
      typeof o.currency !== 'string' || o.currency.trim() === '' ||
      typeof o.availability !== 'string' || o.availability.trim() === ''
    ) {
      return false;
    }
  }

  // 4. Findings collection check
  if (!Array.isArray(p.findings)) {
    return false;
  }
  for (const item of p.findings) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const f = item as Partial<Finding>;
    if (
      typeof f.id !== 'string' || f.id.trim() === '' ||
      typeof f.title !== 'string' || f.title.trim() === '' ||
      typeof f.severity !== 'string' || f.severity.trim() === '' ||
      typeof f.scope !== 'string' || f.scope.trim() === ''
    ) {
      return false;
    }
  }

  // 5. Actions collection check
  if (!Array.isArray(p.actions)) {
    return false;
  }
  for (const item of p.actions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const a = item as Partial<ActionItem>;
    if (
      typeof a.id !== 'string' || a.id.trim() === '' ||
      typeof a.title !== 'string' || a.title.trim() === '' ||
      typeof a.status !== 'string' || a.status.trim() === ''
    ) {
      return false;
    }
  }

  // 6. Evidence collection check
  if (!Array.isArray(p.evidence)) {
    return false;
  }
  for (const item of p.evidence) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const e = item as Partial<EvidenceDocument>;
    if (
      typeof e.id !== 'string' || e.id.trim() === '' ||
      typeof e.title !== 'string' || e.title.trim() === '' ||
      typeof e.type !== 'string' || e.type.trim() === ''
    ) {
      return false;
    }
  }

  // 7. StoreProfile assertion
  if (!p.storeProfile || typeof p.storeProfile !== 'object' || Array.isArray(p.storeProfile)) {
    return false;
  }
  const store = p.storeProfile as Partial<StoreProfile>;
  if (
    typeof store.name !== 'string' || store.name.trim() === '' ||
    typeof store.domain !== 'string' || store.domain.trim() === '' ||
    typeof store.platform !== 'string' || store.platform.trim() === '' ||
    typeof store.currency !== 'string' || store.currency.trim() === '' ||
    !Array.isArray(store.connectors)
  ) {
    return false;
  }

  return true;
}

/**
 * Regex identifying sensitive key patterns in any casing or separator style.
 */
const SENSITIVE_KEY_PATTERN = /^(api[-_]?key|oauth[-_]?token|client[-_]?secret|password|pwd|bearer[-_]?token|secret|token|auth[-_]?token|authorization|private[-_]?key)$/i;

/**
 * Recursively removes sensitive credential keys from objects and nested arrays.
 */
export function sanitizeValue<T>(val: T): T {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) {
    return val.map(item => sanitizeValue(item)) as unknown as T;
  }
  if (typeof val === 'object') {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (!SENSITIVE_KEY_PATTERN.test(k)) {
        res[k] = sanitizeValue(v);
      }
    }
    return res as T;
  }
  return val;
}

/**
 * Filters payload against an explicit allowlist and recursively strips sensitive keys.
 */
export function sanitizePayloadAllowlist(payload: StoragePayloadV1): StoragePayloadV1 {
  return {
    products: sanitizeValue(payload.products || []),
    variants: sanitizeValue(payload.variants || []),
    offers: sanitizeValue(payload.offers || []),
    findings: sanitizeValue(payload.findings || []),
    actions: sanitizeValue(payload.actions || []),
    evidence: sanitizeValue(payload.evidence || []),
    storeProfile: sanitizeValue(payload.storeProfile || {} as StoreProfile),
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

  public isDurable(): boolean {
    return this.backend.isDurable;
  }

  public getReadOnlyReason(): string | null {
    return this.readOnlyReason;
  }

  public resetReadOnly(): void {
    this.readOnlyMode = false;
    this.readOnlyReason = null;
  }

  /**
   * Safe, non-destructive corruption recovery handler:
   * 1. Attempts to persist corrupted raw data to a timestamped backup key.
   * 2. NEVER removes the original corrupted value from the primary key unless
   *    the backup has been successfully verified/persisted.
   * 3. Returns an accurate structured result reflecting backupPreserved and primaryCleared.
   */
  private handleCorruption(raw: string, errorReason: string): StorageLoadResult {
    const backupKey = `${STORAGE_KEY}_corrupt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    let backupPreserved = false;
    let primaryCleared = false;

    // 1. Attempt to write to backup key first
    try {
      this.backend.setItem(backupKey, raw);
      backupPreserved = true;
    } catch {
      // Backup preservation failed (e.g. disk quota or permission)
      backupPreserved = false;
    }

    // 2. ONLY remove primary key IF backup was successfully preserved!
    // Never discard the only recoverable copy of merchant data.
    if (backupPreserved) {
      try {
        this.backend.removeItem(STORAGE_KEY);
        primaryCleared = true;
      } catch {
        primaryCleared = false;
      }
    }

    return {
      type: 'corrupt',
      error: errorReason,
      rawValue: raw,
      backupKey: backupPreserved ? backupKey : undefined,
      backupPreserved,
      primaryCleared,
    };
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
      return this.handleCorruption(raw, 'JSON_PARSE_ERROR');
    }

    // 2. Object validation
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return this.handleCorruption(raw, 'INVALID_ENVELOPE_TYPE');
    }

    const envelope = parsed as Record<string, unknown>;

    // 3. Schema version verification
    if (
      typeof envelope.schemaVersion !== 'number' || 
      !Number.isInteger(envelope.schemaVersion) || 
      envelope.schemaVersion < 1
    ) {
      return this.handleCorruption(raw, 'MISSING_SCHEMA_VERSION');
    }

    // 4. Future schema version protection
    // CRITICAL: Preserve the future-version primary key and value unchanged!
    // Do NOT treat as corruption, do not overwrite, and do not remove!
    if (envelope.schemaVersion > CURRENT_SCHEMA_VERSION) {
      this.readOnlyMode = true;
      this.readOnlyReason = `Stored data uses future schema version ${envelope.schemaVersion} (supported: ${CURRENT_SCHEMA_VERSION}). Local mutations are disabled.`;
      return {
        type: 'unsupported_version',
        foundVersion: envelope.schemaVersion,
        rawEnvelope: parsed,
      };
    }

    // 5. Envelope metadata validation for v1
    const isValidIsoDate = (str: unknown): boolean => {
      if (typeof str !== 'string' || str.trim() === '') return false;
      const parsedTime = Date.parse(str);
      return !isNaN(parsedTime) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(str);
    };

    if (
      typeof envelope.appVersion !== 'string' || envelope.appVersion.trim() === '' ||
      typeof envelope.tenantId !== 'string' || envelope.tenantId.trim() === '' ||
      !isValidIsoDate(envelope.timestamp)
    ) {
      return this.handleCorruption(raw, 'INVALID_ENVELOPE_METADATA');
    }

    // 6. Payload structural validation
    if (!envelope.payload || !validateStoragePayload(envelope.payload)) {
      return this.handleCorruption(raw, 'INVALID_PAYLOAD_STRUCTURE');
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
        isDurable: this.backend.isDurable,
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
      return { 
        success: true, 
        timestamp: envelope.timestamp, 
        isDurable: this.backend.isDurable 
      };
    } catch (e) {
      const errorMsg = (e as Error).message || 'Write failed';
      const isQuota = errorMsg.toLowerCase().includes('quota') || (e as Error).name === 'QuotaExceededError';
      return {
        success: false,
        error: errorMsg,
        isQuotaExceeded: isQuota,
        isDurable: this.backend.isDurable,
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
