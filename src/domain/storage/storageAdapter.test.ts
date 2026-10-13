import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { 
  CatalogStorageAdapter, 
  MemoryStorageBackend, 
  LocalStorageBackend,
  STORAGE_KEY, 
  CURRENT_SCHEMA_VERSION, 
  APP_VERSION, 
  DEFAULT_TENANT_ID,
  validateStoragePayload,
  sanitizePayloadAllowlist,
  isLocalStorageAvailable
} from './storageAdapter';
import { StoragePayloadV1, StorageEnvelopeV1 } from './storageTypes';
import { initialProducts, initialFindings, initialActionItems, initialStoreProfile } from '../../data/mockData';

function createSamplePayload(): StoragePayloadV1 {
  return JSON.parse(JSON.stringify({
    products: initialProducts,
    variants: initialProducts.flatMap(p => p.variants || []),
    offers: initialProducts.flatMap(p => p.offers || []),
    findings: initialFindings,
    actions: initialActionItems,
    evidence: initialProducts.flatMap(p => p.evidenceDocuments || []),
    storeProfile: initialStoreProfile,
  }));
}

describe('Storage Adapter & Persistence (Domain Contract v1.2 Remediation)', () => {
  let backend: MemoryStorageBackend;
  let adapter: CatalogStorageAdapter;

  beforeEach(() => {
    backend = new MemoryStorageBackend();
    adapter = new CatalogStorageAdapter(backend);
  });

  describe('Empty / Uninitialized Storage', () => {
    it('returns not_found when storage key is missing', () => {
      const result = adapter.load();
      assert.equal(result.type, 'not_found');
    });

    it('returns not_found when storage key is whitespace or empty string', () => {
      backend.setItem(STORAGE_KEY, '   ');
      const result = adapter.load();
      assert.equal(result.type, 'not_found');
    });
  });

  describe('Storage Availability & Durability Reporting (Requirement 3)', () => {
    it('isLocalStorageAvailable() executes safely inside exception handling', () => {
      const available = isLocalStorageAvailable();
      assert.equal(typeof available, 'boolean');
    });

    it('MemoryStorageBackend reports isDurable = false', () => {
      const mem = new MemoryStorageBackend();
      assert.equal(mem.isDurable, false);
      const memAdapter = new CatalogStorageAdapter(mem);
      assert.equal(memAdapter.isDurable(), false);

      const saveResult = memAdapter.save(createSamplePayload());
      assert.equal(saveResult.success, true);
      if (saveResult.success) {
        assert.equal(saveResult.isDurable, false, 'Memory write must never be reported as durable');
      }
    });

    it('LocalStorageBackend reports isDurable = true and save reflects durability', () => {
      // Mock window.localStorage for node test runner
      const mockStorage = new Map<string, string>();
      const globalWindow = globalThis as unknown as { window: unknown };
      const originalWindow = globalWindow.window;

      globalWindow.window = {
        localStorage: {
          getItem: (k: string) => mockStorage.get(k) ?? null,
          setItem: (k: string, v: string) => mockStorage.set(k, v),
          removeItem: (k: string) => mockStorage.delete(k),
          clear: () => mockStorage.clear(),
          get length() { return mockStorage.size; },
          key: (i: number) => Array.from(mockStorage.keys())[i] ?? null,
        }
      };

      try {
        const localBackend = new LocalStorageBackend();
        assert.equal(localBackend.isDurable, true);

        const localAdapter = new CatalogStorageAdapter(localBackend);
        assert.equal(localAdapter.isDurable(), true);

        const saveRes = localAdapter.save(createSamplePayload());
        assert.equal(saveRes.success, true);
        if (saveRes.success) {
          assert.equal(saveRes.isDurable, true);
        }
      } finally {
        globalWindow.window = originalWindow;
      }
    });

    it('returns storage_failure on getter/read exception', () => {
      const brokenBackend = new MemoryStorageBackend();
      brokenBackend.getItem = () => {
        throw new Error('Access denied by browser security sandbox');
      };

      const failingAdapter = new CatalogStorageAdapter(brokenBackend);
      const res = failingAdapter.load();
      assert.equal(res.type, 'storage_failure');
      if (res.type === 'storage_failure') {
        assert.equal(res.isRecoverable, true);
        assert.ok(res.error.includes('Access denied'));
      }
    });
  });

  describe('Non-Destructive Corruption Recovery (Requirement 2 / AT-10)', () => {
    it('preserves corrupted data in backup key and clears primary slot on clean recovery', () => {
      const corruptRaw = '{"schemaVersion": 1, "appVersion": "1.0.0", invalid_json...';
      backend.setItem(STORAGE_KEY, corruptRaw);

      const result = adapter.load();
      assert.equal(result.type, 'corrupt');
      if (result.type === 'corrupt') {
        assert.equal(result.error, 'JSON_PARSE_ERROR');
        assert.equal(result.rawValue, corruptRaw);
        assert.equal(result.backupPreserved, true);
        assert.equal(result.primaryCleared, true);
        assert.ok(result.backupKey);
        assert.ok(result.backupKey.startsWith(`${STORAGE_KEY}_corrupt_`));

        // Corrupt content preserved in backup
        assert.equal(backend.getItem(result.backupKey), corruptRaw);
        // Standard primary slot cleared
        assert.equal(backend.getItem(STORAGE_KEY), null);
      }
    });

    it('NEVER removes original corrupted value if backup-write fails', () => {
      const corruptRaw = '{"schemaVersion": 1, "invalid_payload_json';
      backend.setItem(STORAGE_KEY, corruptRaw);

      // Force backup setItem to throw (e.g. disk quota or permissions error)
      const originalSetItem = backend.setItem.bind(backend);
      backend.setItem = (key: string, val: string) => {
        if (key.startsWith(`${STORAGE_KEY}_corrupt_`)) {
          throw new Error('Disk quota exceeded: cannot write corruption backup');
        }
        originalSetItem(key, val);
      };

      const result = adapter.load();
      assert.equal(result.type, 'corrupt');
      if (result.type === 'corrupt') {
        assert.equal(result.backupPreserved, false);
        assert.equal(result.primaryCleared, false);
        assert.equal(result.backupKey, undefined);

        // CRITICAL: The primary storage key MUST NOT be removed!
        // We do not discard the only recoverable copy of merchant data.
        assert.equal(backend.getItem(STORAGE_KEY), corruptRaw);
      }
    });

    it('reports accurate structured flags if primary-key removal fails after backup succeeded', () => {
      const corruptRaw = '{"schemaVersion": 1, "bad_syntax';
      backend.setItem(STORAGE_KEY, corruptRaw);

      // Backup write succeeds, but primary removeItem fails
      backend.removeItem = (key: string) => {
        if (key === STORAGE_KEY) {
          throw new Error('Storage lock: cannot remove key');
        }
      };

      const result = adapter.load();
      assert.equal(result.type, 'corrupt');
      if (result.type === 'corrupt') {
        assert.equal(result.backupPreserved, true);
        assert.equal(result.primaryCleared, false);
        assert.ok(result.backupKey);

        // Backup exists and primary key still exists
        assert.equal(backend.getItem(result.backupKey), corruptRaw);
        assert.equal(backend.getItem(STORAGE_KEY), corruptRaw);
      }
    });

    it('recovers from primitive and array envelope types', () => {
      backend.setItem(STORAGE_KEY, '42');
      const numRes = adapter.load();
      assert.equal(numRes.type, 'corrupt');
      if (numRes.type === 'corrupt') {
        assert.equal(numRes.error, 'INVALID_ENVELOPE_TYPE');
        assert.equal(numRes.backupPreserved, true);
      }

      backend.setItem(STORAGE_KEY, '["not", "an", "object"]');
      const arrRes = adapter.load();
      assert.equal(arrRes.type, 'corrupt');
      if (arrRes.type === 'corrupt') {
        assert.equal(arrRes.error, 'INVALID_ENVELOPE_TYPE');
      }
    });

    it('lists created corruption backup keys via getBackupKeys()', () => {
      backend.setItem(STORAGE_KEY, '{corrupt_one');
      adapter.load();

      backend.setItem(STORAGE_KEY, '{corrupt_two');
      adapter.load();

      const backupKeys = adapter.getBackupKeys();
      assert.ok(backupKeys.length >= 2);
      assert.ok(backupKeys.every(k => k.startsWith(`${STORAGE_KEY}_corrupt_`)));
    });
  });

  describe('Runtime Validation & Envelope Verification (Requirement 4)', () => {
    it('rejects envelope with missing or non-integer schemaVersion', () => {
      const corruptEnvelope = {
        schemaVersion: '1', // string instead of number
        appVersion: '1.0.0',
        tenantId: 'tenant_demo',
        timestamp: new Date().toISOString(),
        payload: createSamplePayload(),
      };
      backend.setItem(STORAGE_KEY, JSON.stringify(corruptEnvelope));

      const result = adapter.load();
      assert.equal(result.type, 'corrupt');
      if (result.type === 'corrupt') {
        assert.equal(result.error, 'MISSING_SCHEMA_VERSION');
      }
    });

    it('rejects envelope with empty required tenantId or appVersion', () => {
      const badTenant = {
        schemaVersion: 1,
        appVersion: '1.0.0',
        tenantId: '   ', // whitespace
        timestamp: new Date().toISOString(),
        payload: createSamplePayload(),
      };
      backend.setItem(STORAGE_KEY, JSON.stringify(badTenant));

      const res = adapter.load();
      assert.equal(res.type, 'corrupt');
      if (res.type === 'corrupt') {
        assert.equal(res.error, 'INVALID_ENVELOPE_METADATA');
      }
    });

    it('rejects envelope with non-ISO timestamp', () => {
      const badTimestamp = {
        schemaVersion: 1,
        appVersion: '1.0.0',
        tenantId: 'tenant_demo',
        timestamp: 'yesterday-afternoon',
        payload: createSamplePayload(),
      };
      backend.setItem(STORAGE_KEY, JSON.stringify(badTimestamp));

      const res = adapter.load();
      assert.equal(res.type, 'corrupt');
      if (res.type === 'corrupt') {
        assert.equal(res.error, 'INVALID_ENVELOPE_METADATA');
      }
    });

    it('rejects malformed product fields in payload structure', () => {
      const sample = createSamplePayload();
      // Introduce invalid product (missing required SKU and invalid attributes)
      (sample.products[0] as any).sku = '';
      (sample.products[0] as any).attributes = 'not-an-object';

      const badProductEnvelope = {
        schemaVersion: 1,
        appVersion: '1.0.0',
        tenantId: 'tenant_demo',
        timestamp: new Date().toISOString(),
        payload: sample,
      };
      backend.setItem(STORAGE_KEY, JSON.stringify(badProductEnvelope));

      const res = adapter.load();
      assert.equal(res.type, 'corrupt');
      if (res.type === 'corrupt') {
        assert.equal(res.error, 'INVALID_PAYLOAD_STRUCTURE');
      }
    });

    it('rejects malformed storeProfile in payload', () => {
      const sample = createSamplePayload();
      (sample.storeProfile as any).platform = ''; // empty platform

      const badStoreEnvelope = {
        schemaVersion: 1,
        appVersion: '1.0.0',
        tenantId: 'tenant_demo',
        timestamp: new Date().toISOString(),
        payload: sample,
      };
      backend.setItem(STORAGE_KEY, JSON.stringify(badStoreEnvelope));

      const res = adapter.load();
      assert.equal(res.type, 'corrupt');
      if (res.type === 'corrupt') {
        assert.equal(res.error, 'INVALID_PAYLOAD_STRUCTURE');
      }
    });

    it('validates well-formed payload completely', () => {
      const sample = createSamplePayload();
      assert.equal(validateStoragePayload(sample), true);
    });
  });

  describe('Future-Schema Protection & Read-Only Compatibility Mode (Requirement 1 & AT-11)', () => {
    it('DOES NOT reject future schema as corruption, preserves primary key untouched', () => {
      const futureEnvelope = {
        schemaVersion: 2,
        appVersion: '2.0.0-future',
        tenantId: 'tenant_demo',
        timestamp: '2027-06-01T12:00:00.000Z',
        futureCollections: ['ai_prompts', 'vector_embeddings'],
        payload: {
          products: [],
          storeProfile: { name: 'Future Store', platform: 'future', currency: 'USD' },
        },
      };
      const futureRaw = JSON.stringify(futureEnvelope);
      backend.setItem(STORAGE_KEY, futureRaw);

      const result = adapter.load();

      // Must be unsupported_version, NOT corrupt
      assert.equal(result.type, 'unsupported_version');
      if (result.type === 'unsupported_version') {
        assert.equal(result.foundVersion, 2);
      }

      // CRITICAL: Primary storage slot untouched
      assert.equal(backend.getItem(STORAGE_KEY), futureRaw);
      // No corruption backups created
      assert.equal(adapter.getBackupKeys().length, 0);

      // Adapter enters read-only compatibility mode
      assert.equal(adapter.isReadOnly(), true);
    });

    it('blocks save() operations while in read-only mode to prevent overwriting future data', () => {
      const futureRaw = JSON.stringify({ schemaVersion: 99, payload: {} });
      backend.setItem(STORAGE_KEY, futureRaw);

      adapter.load();
      assert.equal(adapter.isReadOnly(), true);

      const saveAttempt = adapter.save(createSamplePayload());
      assert.equal(saveAttempt.success, false);
      if (!saveAttempt.success) {
        assert.equal(saveAttempt.isBlockedByReadOnly, true);
      }

      // Primary key remains pristine
      assert.equal(backend.getItem(STORAGE_KEY), futureRaw);
    });

    it('refuses to clear() storage while in read-only mode', () => {
      const futureRaw = JSON.stringify({ schemaVersion: 3, payload: {} });
      backend.setItem(STORAGE_KEY, futureRaw);

      adapter.load();
      assert.equal(adapter.isReadOnly(), true);

      const clearRes = adapter.clear();
      assert.equal(clearRes, false);
      assert.equal(backend.getItem(STORAGE_KEY), futureRaw);
    });
  });

  describe('Recursive Sanitization Allowlist (Requirement 4)', () => {
    it('recursively strips sensitive key variants from nested objects and arrays', () => {
      const dirtyPayload: any = {
        ...createSamplePayload(),
        apiKey: 'secret_root_key',
        API_KEY: 'secret_caps_key',
        auth_token: 'auth_tok_123',
        private_key: 'priv_key_456',
        products: [
          {
            ...initialProducts[0],
            client_secret: 'nested_secret_in_prod',
            attributes: {
              ...initialProducts[0].attributes,
              api_key: 'nested_api_key',
              pwd: 'password123',
              safeAttribute: 'certified organic cotton',
            },
            variants: [
              {
                id: 'var_01',
                productId: 'prod_01',
                title: 'Variant 1',
                sku: 'SKU-01',
                price: 24.00,
                bearer_token: 'token_in_variant',
              }
            ]
          }
        ],
        storeProfile: {
          ...initialStoreProfile,
          password: 'store_password',
          oauthToken: 'store_oauth_token',
        }
      };

      const sanitized = sanitizePayloadAllowlist(dirtyPayload);

      // Root level stripped
      assert.equal((sanitized as any).apiKey, undefined);
      assert.equal((sanitized as any).API_KEY, undefined);
      assert.equal((sanitized as any).auth_token, undefined);
      assert.equal((sanitized as any).private_key, undefined);

      // Nested product level stripped
      assert.equal((sanitized.products[0] as any).client_secret, undefined);

      // Nested attributes stripped
      assert.equal((sanitized.products[0].attributes as any).api_key, undefined);
      assert.equal((sanitized.products[0].attributes as any).pwd, undefined);
      // Safe attribute retained
      assert.equal((sanitized.products[0].attributes as any).safeAttribute, 'certified organic cotton');

      // Nested variant stripped
      assert.equal(((sanitized.products[0] as any).variants[0] as any).bearer_token, undefined);

      // Store profile stripped
      assert.equal((sanitized.storeProfile as any).password, undefined);
      assert.equal((sanitized.storeProfile as any).oauthToken, undefined);
      assert.equal(sanitized.storeProfile.name, initialStoreProfile.name);
    });
  });

  describe('Storage Failure & Quota Handling', () => {
    it('gracefully handles quota exceeded error on write without throwing', () => {
      const quotaBackend = new MemoryStorageBackend();
      quotaBackend.setItem = () => {
        const err = new Error('QuotaExceededError: local storage limit reached');
        err.name = 'QuotaExceededError';
        throw err;
      };

      const quotaAdapter = new CatalogStorageAdapter(quotaBackend);
      const res = quotaAdapter.save(createSamplePayload());

      assert.equal(res.success, false);
      if (!res.success) {
        assert.equal(res.isQuotaExceeded, true);
        assert.ok(res.error.includes('QuotaExceededError'));
      }
    });
  });
});
