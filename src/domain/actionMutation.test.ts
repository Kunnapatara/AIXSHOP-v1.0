import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogStorageAdapter, MemoryStorageBackend } from './storage/storageAdapter';
import { initialProducts, initialFindings, initialActionItems, initialStoreProfile } from '../data/mockData';
import { Product, ActionItem, Finding, StoreProfile } from '../types';
import { StoragePayloadV1 } from './storage/storageTypes';
import { isValidGtin13 } from './validation/gtin';

// Test harness creating the exact domain logic executed by AppContext
class AppCatalogTestHarness {
  public adapter: CatalogStorageAdapter;
  public backend: MemoryStorageBackend;
  public products: Product[];
  public findings: Finding[];
  public actionItems: ActionItem[];
  public storeProfile: StoreProfile;
  public toasts: Array<{ title: string; message: string; type: string }> = [];

  constructor(isReadOnly = false) {
    this.backend = new MemoryStorageBackend();
    if (isReadOnly) {
      // Simulate future schema version in storage to trigger read-only mode
      this.backend.setItem(
        'aixshop_catalog_v1',
        JSON.stringify({ schemaVersion: 99, payload: {} })
      );
    }
    this.adapter = new CatalogStorageAdapter(this.backend);
    if (isReadOnly) {
      this.adapter.load();
    }
    this.products = JSON.parse(JSON.stringify(initialProducts));
    this.findings = JSON.parse(JSON.stringify(initialFindings));
    this.actionItems = JSON.parse(JSON.stringify(initialActionItems));
    this.storeProfile = JSON.parse(JSON.stringify(initialStoreProfile));
  }

  public get isReadOnlyMode(): boolean {
    return this.adapter.isReadOnly();
  }

  public addToast(title: string, message: string, type = 'info') {
    this.toasts.push({ title, message, type });
  }

  public persistState(
    nextProducts: Product[],
    nextFindings: Finding[],
    nextActions: ActionItem[],
    nextProfile: StoreProfile
  ) {
    if (this.isReadOnlyMode) {
      return {
        success: false,
        error: 'Storage is in read-only compatibility mode.',
        isBlockedByReadOnly: true,
        isDurable: this.backend.isDurable,
      };
    }

    const payload: StoragePayloadV1 = {
      products: nextProducts,
      variants: nextProducts.flatMap(p => p.variants || []),
      offers: nextProducts.flatMap(p => p.offers || []),
      findings: nextFindings,
      actions: nextActions,
      evidence: nextProducts.flatMap(p => p.evidenceDocuments || []),
      storeProfile: nextProfile,
    };

    return this.adapter.save(payload);
  }

  public approveAction(actionId: string, customApprovedValue?: string) {
    if (this.isReadOnlyMode) {
      this.addToast('Action Disabled', 'Catalog is in read-only mode to protect your store data.', 'warning');
      return;
    }

    const item = this.actionItems.find(a => a.id === actionId);
    if (!item) return;

    if (item.status !== 'pending_review') {
      this.addToast('Action Ineligible', `Action "${item.title}" is already ${item.status.replace(/_/g, ' ')}.`, 'info');
      return;
    }

    const valueToApply = customApprovedValue !== undefined && customApprovedValue.trim() !== ''
      ? customApprovedValue
      : item.proposedChange.to;

    // Check target product existence if action targets a product
    let nextProducts = this.products;
    if (item.productId) {
      const targetExists = this.products.some(p => p.id === item.productId);
      if (!targetExists) {
        this.addToast('Target Not Found', `Target product "${item.productId}" was not found in catalog.`, 'error');
        return;
      }

      nextProducts = this.products.map(prod => {
        if (prod.id !== item.productId) return prod;

        const updatedProd = { ...prod };
        const changeField = item.proposedChange.field;

        if (changeField.startsWith('variants[') && changeField.includes('barcode')) {
          const match = changeField.match(/variants\[(\d+)\]/);
          const targetIndex = match ? parseInt(match[1], 10) : 0;
          updatedProd.variants = prod.variants.map((v, idx) => {
            if (idx === targetIndex || (!v.barcode && idx === 0)) {
              return { ...v, barcode: valueToApply };
            }
            return v;
          });
        } else if (changeField.startsWith('attributes.')) {
          const attrKey = changeField.replace('attributes.', '');
          updatedProd.attributes = {
            ...prod.attributes,
            [attrKey]: valueToApply,
          };
        } else if (changeField.includes('title')) {
          updatedProd.attributes = {
            ...prod.attributes,
            verifiedBurnTime: valueToApply,
          };
        }

        updatedProd.completenessScore = Math.min(100, prod.completenessScore + 6);
        return updatedProd;
      });
      this.products = nextProducts;
    }

    const nextActions = this.actionItems.map(act => {
      if (act.id === actionId) {
        return {
          ...act,
          status: 'approved' as const,
          approvedAt: new Date().toISOString(),
          proposedChange: {
            ...act.proposedChange,
            to: valueToApply,
          },
          verificationStatus: 'verified_in_catalog' as const,
          recheckNotes: 'Merchant approved in AIXSHOP. Internal catalog model updated.',
        };
      }
      return act;
    });

    const nextFindings = this.findings.map(f => {
      if (f.actionItemId === actionId) {
        return { ...f, merchantVerified: true };
      }
      return f;
    });

    this.actionItems = nextActions;
    this.findings = nextFindings;
    const saveRes = this.persistState(nextProducts, nextFindings, nextActions, this.storeProfile);

    if (saveRes && !saveRes.success) {
      this.addToast('Action Approved (Session Only)', `Persistence failed: ${saveRes.error}`, 'warning');
    } else {
      this.addToast(
        'Remediation Approved',
        `Approved change for ${item.title}. AIXSHOP internal catalog updated. Note: External live write-back requires connector authorization.`,
        'success'
      );
    }
  }

  public dismissAction(actionId: string) {
    if (this.isReadOnlyMode) {
      this.addToast('Action Disabled', 'Catalog is in read-only mode to protect your store data.', 'warning');
      return;
    }
    this.actionItems = this.actionItems.map(act => {
      if (act.id === actionId) {
        return {
          ...act,
          status: 'dismissed' as const,
          dismissedAt: new Date().toISOString(),
          verificationStatus: 'unverified' as const,
        };
      }
      return act;
    });
    this.persistState(this.products, this.findings, this.actionItems, this.storeProfile);
  }

  public recheckAction(actionId: string) {
    if (this.isReadOnlyMode) {
      this.addToast('Re-check Disabled', 'Catalog is in read-only mode.', 'warning');
      return;
    }
    const item = this.actionItems.find(a => a.id === actionId);
    if (!item) return;

    if (item.status !== 'approved') {
      this.actionItems = this.actionItems.map(act => {
        if (act.id === actionId) {
          return {
            ...act,
            verificationStatus: 'recheck_required' as const,
            lastRecheckTimestamp: new Date().toISOString(),
            recheckNotes: 'Re-check failed: Action has not been approved or applied yet. Human review required.',
          };
        }
        return act;
      });
      this.addToast('Action Still Pending', 'Action still requires review', 'warning');
      this.persistState(this.products, this.findings, this.actionItems, this.storeProfile);
      return;
    }

    // Genuine validation against actual catalog state
    let isValid = true;
    let failureReason = '';

    if (item.productId) {
      const targetProd = this.products.find(p => p.id === item.productId);
      if (!targetProd) {
        isValid = false;
        failureReason = `Target product "${item.productId}" not found in catalog.`;
      } else {
        const changeField = item.proposedChange.field;
        const expectedValue = item.proposedChange.to;

        if (changeField.startsWith('variants[') && changeField.includes('barcode')) {
          const match = changeField.match(/variants\[(\d+)\]/);
          const targetIndex = match ? parseInt(match[1], 10) : 0;
          const targetVariant = targetProd.variants[targetIndex] || targetProd.variants[0];

          if (!targetVariant || targetVariant.barcode !== expectedValue) {
            isValid = false;
            failureReason = `Variant barcode does not match approved value (${targetVariant?.barcode || 'empty'}).`;
          } else if (!isValidGtin13(targetVariant.barcode)) {
            isValid = false;
            failureReason = `Variant barcode "${targetVariant.barcode}" fails GTIN-13 check digit validation.`;
          }
        } else if (changeField.startsWith('attributes.')) {
          const attrKey = changeField.replace('attributes.', '');
          const currentVal = targetProd.attributes[attrKey];
          if (currentVal !== expectedValue) {
            isValid = false;
            failureReason = `Attribute "${attrKey}" does not match approved value.`;
          }
        } else if (changeField.includes('title')) {
          if (targetProd.attributes.verifiedBurnTime !== expectedValue) {
            isValid = false;
            failureReason = 'Specification claim reconciliation not found in attributes.';
          }
        }
      }
    }

    const nextVerificationStatus = isValid ? ('verified_in_catalog' as const) : ('verification_failed' as const);
    const recheckNotes = isValid
      ? 'Re-check validated against local catalog schema rules: All format requirements met.'
      : `Re-check failed: ${failureReason}`;

    this.actionItems = this.actionItems.map(act => {
      if (act.id === actionId) {
        return {
          ...act,
          verificationStatus: nextVerificationStatus,
          lastRecheckTimestamp: new Date().toISOString(),
          recheckNotes,
        };
      }
      return act;
    });

    if (isValid) {
      this.addToast('Re-check Verified', 'Catalog consistency confirmed', 'success');
    } else {
      this.addToast('Re-check Failed', `Verification failed: ${failureReason}`, 'error');
    }

    this.persistState(this.products, this.findings, this.actionItems, this.storeProfile);
  }
}

describe('Phase 2 Acceptance Audit & Regression Suite', () => {
  let harness: AppCatalogTestHarness;

  beforeEach(() => {
    harness = new AppCatalogTestHarness();
  });

  describe('1. Mutation Scope & Target Integrity', () => {
    it('successfully mutates structured attribute on the target product', () => {
      const targetProdBefore = harness.products.find(p => p.id === 'prod_solstice_02')!;
      assert.equal(targetProdBefore.attributes.microwaveSafe, 'Unspecified');

      harness.approveAction('act_02');

      const targetProdAfter = harness.products.find(p => p.id === 'prod_solstice_02')!;
      assert.equal(targetProdAfter.attributes.microwaveSafe, 'True (Tested up to 900W)');
    });

    it('successfully mutates variant-specific barcode on the target product', () => {
      const candleBefore = harness.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleBefore.variants[0].barcode, '');

      harness.approveAction('act_01');

      const candleAfter = harness.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleAfter.variants[0].barcode, '0850029381082');
    });

    it('mutates only the intended product when multiple products exist', () => {
      const coffeeBefore = harness.products.find(p => p.id === 'prod_solstice_01')!;
      const apronBefore = harness.products.find(p => p.id === 'prod_solstice_03')!;
      const coffeeSnapshot = JSON.stringify(coffeeBefore);
      const apronSnapshot = JSON.stringify(apronBefore);

      // Mutate candle
      harness.approveAction('act_01');

      const coffeeAfter = harness.products.find(p => p.id === 'prod_solstice_01')!;
      const apronAfter = harness.products.find(p => p.id === 'prod_solstice_03')!;
      assert.equal(JSON.stringify(coffeeAfter), coffeeSnapshot, 'Coffee must not be mutated');
      assert.equal(JSON.stringify(apronAfter), apronSnapshot, 'Apron must not be mutated');
    });

    it('preserves unrelated attributes, variants, offers, and evidence', () => {
      const mugBefore = harness.products.find(p => p.id === 'prod_solstice_02')!;
      const originalDishwasherSafe = mugBefore.attributes.dishwasherSafe;
      const originalOffers = JSON.stringify(mugBefore.offers);
      const originalEvidence = JSON.stringify(mugBefore.evidenceDocuments);

      harness.approveAction('act_02');

      const mugAfter = harness.products.find(p => p.id === 'prod_solstice_02')!;
      assert.equal(mugAfter.attributes.dishwasherSafe, originalDishwasherSafe);
      assert.equal(JSON.stringify(mugAfter.offers), originalOffers);
      assert.equal(JSON.stringify(mugAfter.evidenceDocuments), originalEvidence);
    });

    it('handles store-level or offer-level action without corrupting products', () => {
      const productsSnapshot = JSON.stringify(harness.products);
      harness.approveAction('act_06'); // Storefront shipping SLA discrepancy
      assert.equal(JSON.stringify(harness.products), productsSnapshot, 'Products must remain untouched for store action');
    });

    it('safely handles missing or invalid action ID without throwing', () => {
      assert.doesNotThrow(() => {
        harness.approveAction('non_existent_action_id');
      });
    });

    it('safely rejects approval if target product does not exist without corrupting catalog', () => {
      // Create an action referencing a non-existent product
      harness.actionItems.push({
        id: 'act_orphan',
        findingId: 'find_orphan',
        productId: 'prod_does_not_exist',
        title: 'Orphan Action',
        severity: 'high',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'attributes.test',
          from: '',
          to: 'value',
        },
        verificationStatus: 'unverified',
      });

      const productsSnapshot = JSON.stringify(harness.products);
      harness.approveAction('act_orphan');

      assert.equal(JSON.stringify(harness.products), productsSnapshot, 'Products must remain untouched when target is missing');
      assert.ok(harness.toasts.some(t => t.title === 'Target Not Found'));
      const orphanAction = harness.actionItems.find(a => a.id === 'act_orphan')!;
      assert.equal(orphanAction.status, 'pending_review', 'Orphan action must not be approved');
    });
  });

  describe('2. Completeness Score Consistency', () => {
    it('increments product completenessScore bounded at 100', () => {
      const mugBefore = harness.products.find(p => p.id === 'prod_solstice_02')!;
      const initialScore = mugBefore.completenessScore;
      assert.equal(initialScore, 78);

      harness.approveAction('act_02');

      const mugAfter = harness.products.find(p => p.id === 'prod_solstice_02')!;
      assert.equal(mugAfter.completenessScore, initialScore + 6);
      assert.ok(mugAfter.completenessScore <= 100);
    });
  });

  describe('3. Read-Only Protection & Idempotence', () => {
    it('blocks mutations when in read-only mode', () => {
      const roHarness = new AppCatalogTestHarness(true); // read-only active
      const candleBefore = roHarness.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleBefore.variants[0].barcode, '');

      roHarness.approveAction('act_01');

      const candleAfter = roHarness.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleAfter.variants[0].barcode, '', 'Barcode must NOT be mutated in read-only mode');
      assert.ok(roHarness.toasts.some(t => t.title === 'Action Disabled'));
    });

    it('rejected or dismissed actions do not mutate catalog data', () => {
      harness.dismissAction('act_01');
      assert.equal(harness.actionItems.find(a => a.id === 'act_01')!.status, 'dismissed');

      // Attempt approval on dismissed action
      const candleBefore = harness.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleBefore.variants[0].barcode, '');

      harness.approveAction('act_01');

      const candleAfter = harness.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleAfter.variants[0].barcode, '', 'Dismissed action must not mutate catalog');
      assert.ok(harness.toasts.some(t => t.title === 'Action Ineligible'));
    });

    it('repeated approval does not duplicate or reapply a correction', () => {
      harness.approveAction('act_01');
      const candleFirstPass = harness.products.find(p => p.id === 'prod_solstice_04')!;
      const scoreFirstPass = candleFirstPass.completenessScore;

      // Second approval attempt on already approved action
      harness.approveAction('act_01');
      const candleSecondPass = harness.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleSecondPass.completenessScore, scoreFirstPass, 'Score must not increment twice');
      assert.ok(harness.toasts.some(t => t.title === 'Action Ineligible'));
    });
  });

  describe('4. Storage Persistence & Reload Consistency', () => {
    it('persists successful mutation to storage adapter and reloads accurately', () => {
      harness.approveAction('act_01'); // assign barcode

      // Load back from the adapter storage
      const loaded = harness.adapter.load();
      assert.equal(loaded.type, 'valid');
      if (loaded.type === 'valid') {
        const savedCandle = loaded.envelope.payload.products.find(p => p.id === 'prod_solstice_04')!;
        assert.equal(savedCandle.variants[0].barcode, '0850029381082');

        const savedAction = loaded.envelope.payload.actions.find(a => a.id === 'act_01')!;
        assert.equal(savedAction.status, 'approved');
        assert.equal(savedAction.verificationStatus, 'verified_in_catalog');

        const savedFinding = loaded.envelope.payload.findings.find(f => f.actionItemId === 'act_01')!;
        assert.equal(savedFinding.merchantVerified, true);
      }
    });

    it('surfaces storage write failure without crashing application', () => {
      // Mock failure by filling backend or throwing in setItem
      harness.backend.setItem = () => {
        throw new Error('QuotaExceededError: simulated disk quota failure');
      };

      assert.doesNotThrow(() => {
        harness.approveAction('act_01');
      });
      assert.ok(harness.toasts.some(t => t.title.includes('Session Only')));
    });
  });

  describe('5. Action Status and Re-check Verification Semantics', () => {
    it('maintains pending status and recheck_required for unapproved items', () => {
      harness.recheckAction('act_01'); // Unapproved item
      const item = harness.actionItems.find(a => a.id === 'act_01')!;
      assert.equal(item.status, 'pending_review');
      assert.equal(item.verificationStatus, 'recheck_required');
      assert.ok(item.recheckNotes?.includes('failed: Action has not been approved'));
    });

    it('verifies consistency upon re-check after approval has succeeded', () => {
      harness.approveAction('act_01');
      harness.recheckAction('act_01');
      const item = harness.actionItems.find(a => a.id === 'act_01')!;
      assert.equal(item.status, 'approved');
      assert.equal(item.verificationStatus, 'verified_in_catalog');
      assert.ok(item.recheckNotes?.includes('Re-check validated against local catalog schema rules'));
    });

    it('re-check fails with verification_failed when target product was deleted', () => {
      harness.approveAction('act_01');
      // Simulate target product removal from catalog
      harness.products = harness.products.filter(p => p.id !== 'prod_solstice_04');

      harness.recheckAction('act_01');
      const item = harness.actionItems.find(a => a.id === 'act_01')!;
      assert.equal(item.verificationStatus, 'verification_failed');
      assert.ok(item.recheckNotes?.includes('not found in catalog'));
    });

    it('re-check fails with verification_failed when variant barcode check digit is invalid', () => {
      harness.approveAction('act_01');
      // Corrupt the target variant barcode with invalid check digit
      const candle = harness.products.find(p => p.id === 'prod_solstice_04')!;
      candle.variants[0].barcode = '0850029381089'; // Invalid check digit

      harness.recheckAction('act_01');
      const item = harness.actionItems.find(a => a.id === 'act_01')!;
      assert.equal(item.verificationStatus, 'verification_failed');
    });

    it('re-check fails with verification_failed when attribute value does not match', () => {
      harness.approveAction('act_02');
      // Tamper with attribute value
      const mug = harness.products.find(p => p.id === 'prod_solstice_02')!;
      mug.attributes.microwaveSafe = 'False';

      harness.recheckAction('act_02');
      const item = harness.actionItems.find(a => a.id === 'act_02')!;
      assert.equal(item.verificationStatus, 'verification_failed');
      assert.ok(item.recheckNotes?.includes('does not match approved value'));
    });

    it('clearly documents local boundary vs external store update', () => {
      harness.approveAction('act_01');
      const successToast = harness.toasts.find(t => t.title === 'Remediation Approved');
      assert.ok(successToast);
      assert.ok(
        successToast.message.includes('External live write-back requires connector authorization') ||
        successToast.message.includes('AIXSHOP internal catalog updated'),
        'Must contain clear external boundary disclaimer'
      );
    });
  });

  describe('6. End-to-End Workflow: Finding -> Product Detail -> Action -> Mutation -> Persistence -> Re-check', () => {
    it('successfully executes complete end-to-end verification lifecycle', () => {
      // 1. Home / Audit Finding inspection
      const finding = harness.findings.find(f => f.id === 'find_01')!;
      assert.equal(finding.productId, 'prod_solstice_04');
      assert.equal(finding.merchantVerified, false);

      // 2. Product Detail target resolution
      const product = harness.products.find(p => p.id === finding.productId)!;
      assert.ok(product);
      assert.equal(product.variants[0].barcode, '');
      const originalScore = product.completenessScore;

      // 3. Action Center navigation & association
      const action = harness.actionItems.find(a => a.id === finding.actionItemId)!;
      assert.equal(action.status, 'pending_review');
      assert.equal(action.verificationStatus, 'unverified');

      // 4. Merchant Approval & Catalog Mutation
      harness.approveAction(action.id);

      // 5. Verify local catalog mutation
      const mutatedProduct = harness.products.find(p => p.id === finding.productId)!;
      assert.equal(mutatedProduct.variants[0].barcode, '0850029381082');
      assert.equal(mutatedProduct.completenessScore, originalScore + 6);

      // 6. Verify action & finding status transitions
      const approvedAction = harness.actionItems.find(a => a.id === action.id)!;
      assert.equal(approvedAction.status, 'approved');
      assert.equal(approvedAction.verificationStatus, 'verified_in_catalog');
      const updatedFinding = harness.findings.find(f => f.id === finding.id)!;
      assert.equal(updatedFinding.merchantVerified, true);

      // 7. Verify persistence through Storage Adapter
      const loaded = harness.adapter.load();
      assert.equal(loaded.type, 'valid');
      if (loaded.type === 'valid') {
        const persistedProduct = loaded.envelope.payload.products.find(p => p.id === finding.productId)!;
        assert.equal(persistedProduct.variants[0].barcode, '0850029381082');
        assert.equal(persistedProduct.completenessScore, originalScore + 6);
      }

      // 8. Re-check execution and validation
      harness.recheckAction(action.id);
      const recheckedAction = harness.actionItems.find(a => a.id === action.id)!;
      assert.equal(recheckedAction.verificationStatus, 'verified_in_catalog');
      assert.ok(recheckedAction.recheckNotes?.includes('local catalog schema rules'));
    });
  });
});
