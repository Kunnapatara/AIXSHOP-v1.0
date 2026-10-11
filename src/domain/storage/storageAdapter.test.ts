import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { 
  CatalogStorageAdapter, 
  MemoryStorageBackend, 
  STORAGE_KEY, 
  CURRENT_SCHEMA_VERSION, 
  APP_VERSION, 
  DEFAULT_TENANT_ID,
  validateStoragePayload,
  sanitizePayloadAllowlist
} from './storageAdapter';
import { StoragePayloadV1, StorageEnvelopeV1 } from './storageTypes';
import { initialProducts, initialFindings, initialActionItems, initialStoreProfile } from '../../data/mockData';

function createSamplePayload(): StoragePayloadV1 {
  return {
    products: initialProducts,
    variants: initialProducts.flatMap(p => p.variants || []),
    offers: initialProducts.flatMap(p => p.offers || []),
    findings: initialFindings,
    actions: initialActionItems,
    evidence: initialProducts.flatMap(p => p.evidenceDocuments || []),
    storeProfile: initialStoreProfile,
  };
}

describe('Storage Adapter & Persistence (Domain Contract v1.2)', () => {
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

  describe('Valid Persistence Round-Trip', () => {
    it('saves valid payload and wraps in StorageEnvelopeV1', () => {
      const payload = createSamplePayload();
      const saveResult = adapter.save(payload);

      assert.equal(saveResult.success, true);
      assert.ok('timestamp' in saveResult && saveResult.timestamp);

      const raw = backend.getItem(STORAGE_KEY);
      assert.ok(raw);

      const envelope: StorageEnvelopeV1 = JSON.parse(raw!);
      assert.equal(envelope.schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(envelope.appVersion, APP_VERSION);
      assert.equal(envelope.tenantId, DEFAULT_TENANT_ID);
      assert.ok(envelope.timestamp);
      assert.equal(envelope.payload.products.length, payload.products.length);
      assert.equal(envelope.payload.storeProfile.name, payload.storeProfile.name);
    });

    it('loads previously saved valid envelope successfully', () => {
      const payload = createSamplePayload();
      adapter.save(payload);

      const loadResult = adapter.load();
      assert.equal(loadResult.type, 'valid');
      if (loadResult.type === 'valid') {
        assert.equal(loadResult.envelope.schemaVersion, 1);
        assert.equal(loadResult.envelope.payload.products.length, initialProducts.length);
        assert.equal(loadResult.envelope.payload.storeProfile.name, initialStoreProfile.name);
      }
    });

    it('clears storage successfully when not in read-only mode', () => {
      const payload = createSamplePayload();
      adapter.save(payload);
      assert.ok(backend.getItem(STORAGE_KEY));

      const cleared = adapter.clear();
      assert.equal(cleared, true);
      assert.equal(backend.getItem(STORAGE_KEY), null);
    });
  });

  describe('AT-10: Safe Corruption Recovery', () => {
    it('recovers from unparseable JSON without throwing, preserves backup, and clears primary key', () => {
      const corruptRaw = '{"schemaVersion": 1, "appVersion": "1.0.0", invalid_json...';
      backend.setItem(STORAGE_KEY, corruptRaw);

      const result = adapter.load();
      assert.equal(result.type, 'corrupt');
      if (result.type === 'corrupt') {
        assert.equal(result.error, 'JSON_PARSE_ERROR');
        assert.equal(result.rawValue, corruptRaw);
        assert.ok(result.backupKey);
        assert.ok(result.backupKey.startsWith(`${STORAGE_KEY}_corrupt_`));

        // Corrupt content is preserved in the backup key
        assert.equal(backend.getItem(result.backupKey), corruptRaw);

        // Standard storage key is cleared to allow clean recovery
        assert.equal(backend.getItem(STORAGE_KEY), null);
      }
    });

    it('recovers from primitive or non-object envelope types', () => {
      backend.setItem(STORAGE_KEY, '12345');
      const numResult = adapter.load();
      assert.equal(numResult.type, 'corrupt');
      if (numResult.type === 'corrupt') {
        assert.equal(numResult.error, 'INVALID_ENVELOPE_TYPE');
        assert.equal(backend.getItem(STORAGE_KEY), null);
      }

      backend.setItem(STORAGE_KEY, '["array", "envelope"]');
      const arrResult = adapter.load();
      assert.equal(arrResult.type, 'corrupt');
      if (arrResult.type === 'corrupt') {
        assert.equal(arrResult.error, 'INVALID_ENVELOPE_TYPE');
        assert.equal(backend.getItem(STORAGE_KEY), null);
      }
    });

    it('recovers when schemaVersion is missing or non-number', () => {
      const corruptEnvelope = {
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
        assert.equal(backend.getItem(STORAGE_KEY), null);
      }
    });

    it('recovers when envelope metadata fields are missing or invalid', () => {
      const corruptMetadataEnvelope = {
        schemaVersion: 1,
        // missing appVersion, tenantId, timestamp
        payload: createSamplePayload(),
      };
      backend.setItem(STORAGE_KEY, JSON.stringify(corruptMetadataEnvelope));

      const result = adapter.load();
      assert.equal(result.type, 'corrupt');
      if (result.type === 'corrupt') {
        assert.equal(result.error, 'INVALID_ENVELOPE_METADATA');
        assert.equal(backend.getItem(STORAGE_KEY), null);
      }
    });

    it('recovers when payload structure fails validation', () => {
      const corruptPayloadEnvelope = {
        schemaVersion: 1,
        appVersion: '1.0.0',
        tenantId: 'tenant_solstice_demo',
        timestamp: new Date().toISOString(),
        payload: {
          products: 'corrupt_not_an_array',
          storeProfile: null,
        },
      };
      backend.setItem(STORAGE_KEY, JSON.stringify(corruptPayloadEnvelope));

      const result = adapter.load();
      assert.equal(result.type, 'corrupt');
      if (result.type === 'corrupt') {
        assert.equal(result.error, 'INVALID_PAYLOAD_STRUCTURE');
        assert.equal(backend.getItem(STORAGE_KEY), null);
        assert.ok(result.backupKey);
      }
    });

    it('lists created corruption backup keys via getBackupKeys()', () => {
      backend.setItem(STORAGE_KEY, '{invalid1');
      adapter.load();

      backend.setItem(STORAGE_KEY, '{invalid2');
      adapter.load();

      const backupKeys = adapter.getBackupKeys();
      assert.ok(backupKeys.length >= 2);
      assert.ok(backupKeys.every(k => k.startsWith(`${STORAGE_KEY}_corrupt_`)));
    });
  });

  describe('AT-11: Future-Schema Protection and Read-Only Compatibility Mode', () => {
    it('detects future schema version without overwriting or deleting stored data', () => {
      const futureEnvelope = {
        schemaVersion: 2,
        appVersion: '2.0.0-future',
        tenantId: 'tenant_solstice_demo',
        timestamp: '2027-01-01T00:00:00.000Z',
        futureCollections: ['ai_agents', 'dynamic_pricing_rules'],
        payload: {
          products: [],
          storeProfile: { name: 'Future Store', platform: 'future', currency: 'USD' },
        },
      };
      const futureRaw = JSON.stringify(futureEnvelope);
      backend.setItem(STORAGE_KEY, futureRaw);

      const result = adapter.load();

      // Must identify unsupported version
      assert.equal(result.type, 'unsupported_version');
      if (result.type === 'unsupported_version') {
        assert.equal(result.foundVersion, 2);
      }

      // CRITICAL: The primary storage slot MUST remain intact with future data!
      assert.equal(backend.getItem(STORAGE_KEY), futureRaw);

      // CRITICAL: No corruption backups should have been created
      assert.equal(adapter.getBackupKeys().length, 0);

      // Adapter must enter read-only compatibility mode
      assert.equal(adapter.isReadOnly(), true);
      assert.ok(adapter.getReadOnlyReason()?.includes('future schema version 2'));
    });

    it('blocks subsequent save() operations when in read-only mode to prevent overwriting future data', () => {
      const futureRaw = JSON.stringify({
        schemaVersion: 3,
        payload: {},
      });
      backend.setItem(STORAGE_KEY, futureRaw);

      // Load to trigger read-only mode
      adapter.load();
      assert.equal(adapter.isReadOnly(), true);

      // Attempt to save new v1 state
      const saveAttempt = adapter.save(createSamplePayload());

      // Save must fail with blocked flag
      assert.equal(saveAttempt.success, false);
      if (!saveAttempt.success) {
        assert.equal(saveAttempt.isBlockedByReadOnly, true);
        assert.ok(saveAttempt.error);
      }

      // CRITICAL: Future data remains pristine in storage
      assert.equal(backend.getItem(STORAGE_KEY), futureRaw);
    });

    it('refuses to clear() storage when in read-only mode to preserve future schema state', () => {
      const futureRaw = JSON.stringify({
        schemaVersion: 5,
        payload: {},
      });
      backend.setItem(STORAGE_KEY, futureRaw);

      adapter.load();
      assert.equal(adapter.isReadOnly(), true);

      const clearResult = adapter.clear();
      assert.equal(clearResult, false);

      // Future data is not deleted
      assert.equal(backend.getItem(STORAGE_KEY), futureRaw);
    });
  });

  describe('Sanitization Allowlist & Security Boundaries', () => {
    it('strips sensitive credentials and tokens before storage', () => {
      const dirtyPayload: any = {
        ...createSamplePayload(),
        apiKey: 'sk-secret-12345',
        oauthToken: 'oauth-bearer-token',
        storeProfile: {
          ...initialStoreProfile,
          clientSecret: 'secret_client_key_999',
          bearerToken: 'tok_bearer_111',
          password: 'plain_password',
        },
      };

      const sanitized = sanitizePayloadAllowlist(dirtyPayload);

      assert.equal((sanitized as any).apiKey, undefined);
      assert.equal((sanitized as any).oauthToken, undefined);
      assert.equal((sanitized.storeProfile as any).clientSecret, undefined);
      assert.equal((sanitized.storeProfile as any).bearerToken, undefined);
      assert.equal((sanitized.storeProfile as any).password, undefined);
      assert.equal(sanitized.storeProfile.name, initialStoreProfile.name);
    });
  });

  describe('Storage Failure & Quota Handling', () => {
    it('gracefully handles quota exceeded error on write without crashing', () => {
      const quotaBackend: MemoryStorageBackend = new MemoryStorageBackend();
      quotaBackend.setItem = () => {
        const err = new Error('QuotaExceededError: storage is full');
        err.name = 'QuotaExceededError';
        throw err;
      };

      const quotaAdapter = new CatalogStorageAdapter(quotaBackend);
      const result = quotaAdapter.save(createSamplePayload());

      assert.equal(result.success, false);
      if (!result.success) {
        assert.equal(result.isQuotaExceeded, true);
        assert.ok(result.error.includes('QuotaExceededError'));
      }
    });

    it('returns storage_failure if backend.getItem throws', () => {
      const faultyBackend: MemoryStorageBackend = new MemoryStorageBackend();
      faultyBackend.getItem = () => {
        throw new Error('Access to localStorage denied by security policy');
      };

      const faultyAdapter = new CatalogStorageAdapter(faultyBackend);
      const result = faultyAdapter.load();

      assert.equal(result.type, 'storage_failure');
      if (result.type === 'storage_failure') {
        assert.ok(result.error.includes('Access to localStorage denied'));
        assert.equal(result.isRecoverable, true);
      }
    });
  });

  describe('Structural Validation Helper', () => {
    it('rejects invalid payload objects', () => {
      assert.equal(validateStoragePayload(null), false);
      assert.equal(validateStoragePayload(undefined), false);
      assert.equal(validateStoragePayload('string'), false);
      assert.equal(validateStoragePayload([]), false);
      assert.equal(validateStoragePayload({ products: 'not-array' }), false);
      assert.equal(validateStoragePayload({ products: [{ title: 'missing id' }] }), false);
    });

    it('accepts well-formed payload object', () => {
      const payload = createSamplePayload();
      assert.equal(validateStoragePayload(payload), true);
    });
  });
});
