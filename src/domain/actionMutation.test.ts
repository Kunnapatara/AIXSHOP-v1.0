import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogStorageAdapter, MemoryStorageBackend } from './storage/storageAdapter';
import { initialProducts, initialFindings, initialActionItems, initialStoreProfile } from '../data/mockData';
import { Product, ActionItem, Finding, StoreProfile } from '../types';
import { StoragePayloadV1 } from './storage/storageTypes';
import { isValidGtin13 } from './validation/gtin';
import {
  executeActionApproval,
  executeActionDismissal,
  executeActionRecheck,
  executeProductRecheck,
  validateMutationField,
  calculateProductCompleteness,
  calculateStoreCompletenessAvg,
} from './catalog/catalogMutationService';
import {
  normalizeStoreUrl,
  evaluateProductsCatalog,
  ingestAndAnalyzeStore,
} from './ingestion/storeIngestion';

/**
 * Production-identical orchestrator that directly invokes the shared domain
 * functions and storage adapter used by AppContext.
 * Zero duplicated domain logic inside the test file.
 */
class ProductionActionCoordinator {
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
    const res = executeActionApproval(actionId, customApprovedValue, {
      products: this.products,
      findings: this.findings,
      actionItems: this.actionItems,
      storeProfile: this.storeProfile,
      isReadOnly: this.isReadOnlyMode,
    });

    if (!res.success) {
      this.addToast(
        res.errorCode === 'READ_ONLY_MODE' ? 'Action Disabled' : 'Action Failed',
        res.message,
        res.errorCode === 'READ_ONLY_MODE' ? 'warning' : 'error'
      );
      return res;
    }

    // Attempt atomic persistence
    const saveRes = this.persistState(
      res.nextProducts,
      res.nextFindings,
      res.nextActions,
      res.nextStoreProfile
    );

    if (!saveRes.success) {
      // Atomic rollback: preserve existing state without partial in-memory corruption
      this.addToast(
        'Persistence Failed (Rolled Back)',
        `Could not persist approval: ${saveRes.error}. State preserved.`,
        'error'
      );
      return { ...res, success: false, rolledBack: true };
    }

    // Persist succeeded: commit in-memory state
    this.products = res.nextProducts;
    this.findings = res.nextFindings;
    this.actionItems = res.nextActions;
    this.storeProfile = res.nextStoreProfile;
    this.addToast('Remediation Approved', res.message, 'success');
    return res;
  }

  public dismissAction(actionId: string) {
    const res = executeActionDismissal(actionId, {
      products: this.products,
      findings: this.findings,
      actionItems: this.actionItems,
      storeProfile: this.storeProfile,
      isReadOnly: this.isReadOnlyMode,
    });

    if (!res.success) {
      this.addToast('Action Disabled', res.message, 'warning');
      return res;
    }

    const saveRes = this.persistState(
      res.nextProducts,
      res.nextFindings,
      res.nextActions,
      res.nextStoreProfile
    );

    if (!saveRes.success) {
      this.addToast('Persistence Failed', `Could not persist dismissal: ${saveRes.error}`, 'error');
      return { ...res, success: false, rolledBack: true };
    }

    this.products = res.nextProducts;
    this.findings = res.nextFindings;
    this.actionItems = res.nextActions;
    this.storeProfile = res.nextStoreProfile;
    this.addToast('Action Dismissed', res.message, 'info');
    return res;
  }

  public recheckAction(actionId: string) {
    const res = executeActionRecheck(actionId, {
      products: this.products,
      findings: this.findings,
      actionItems: this.actionItems,
      storeProfile: this.storeProfile,
      isReadOnly: this.isReadOnlyMode,
    });

    if (!res.success) {
      this.addToast(
        res.errorCode === 'READ_ONLY_MODE' ? 'Re-check Disabled' : 'Re-check Failed',
        res.message,
        res.errorCode === 'READ_ONLY_MODE' ? 'warning' : 'error'
      );
      return res;
    }

    const saveRes = this.persistState(this.products, res.nextFindings, res.nextActions, this.storeProfile);
    if (!saveRes.success) {
      this.addToast('Persistence Failed', `Could not persist re-check results: ${saveRes.error}`, 'error');
      return { ...res, success: false, rolledBack: true };
    }

    this.actionItems = res.nextActions;
    this.findings = res.nextFindings;
    this.addToast(
      res.isVerified ? 'Re-check Verified' : 'Re-check Inconclusive',
      res.message,
      res.isVerified ? 'success' : 'warning'
    );
    return res;
  }
}

describe('Phase 2 Remediation & Production Domain Integrity Suite', () => {
  let coordinator: ProductionActionCoordinator;

  beforeEach(() => {
    coordinator = new ProductionActionCoordinator();
  });

  describe('Phase B: Separation of Approval from Verification', () => {
    it('approving an action sets status=approved but leaves verificationStatus=recheck_required', () => {
      const actionBefore = coordinator.actionItems.find(a => a.id === 'act_01')!;
      assert.equal(actionBefore.status, 'pending_review');
      assert.equal(actionBefore.verificationStatus, 'unverified');

      const res = coordinator.approveAction('act_01');
      assert.equal(res.success, true);

      const actionAfter = coordinator.actionItems.find(a => a.id === 'act_01')!;
      assert.equal(actionAfter.status, 'approved');
      // Crucial Phase B requirement: Approval DOES NOT establish verification
      assert.equal(actionAfter.verificationStatus, 'recheck_required');
      assert.notEqual(actionAfter.verificationStatus, 'verified_in_catalog');
      assert.ok(actionAfter.recheckNotes?.includes('Re-check required'));
    });

    it('approving an action keeps finding.merchantVerified as false until genuine re-check', () => {
      const findingBefore = coordinator.findings.find(f => f.actionItemId === 'act_01')!;
      assert.equal(findingBefore.merchantVerified, false);

      coordinator.approveAction('act_01');

      const findingAfter = coordinator.findings.find(f => f.actionItemId === 'act_01')!;
      // Crucial Phase B requirement: Approval must NOT set merchantVerified: true
      assert.equal(findingAfter.merchantVerified, false);
    });

    it('re-check after approval validates catalog state and establishes verified_in_catalog', () => {
      coordinator.approveAction('act_01');
      const recheckRes = coordinator.recheckAction('act_01');

      assert.equal(recheckRes.success, true);
      assert.equal(recheckRes.isVerified, true);
      assert.equal(recheckRes.verificationStatus, 'verified_in_catalog');

      const action = coordinator.actionItems.find(a => a.id === 'act_01')!;
      assert.equal(action.verificationStatus, 'verified_in_catalog');

      const finding = coordinator.findings.find(f => f.actionItemId === 'act_01')!;
      assert.equal(finding.merchantVerified, true);
    });

    it('re-check fails if target product is deleted after approval', () => {
      coordinator.approveAction('act_01');
      // Simulate target product removal
      coordinator.products = coordinator.products.filter(p => p.id !== 'prod_solstice_04');

      const recheckRes = coordinator.recheckAction('act_01');
      assert.equal(recheckRes.isVerified, false);
      assert.equal(recheckRes.verificationStatus, 'verification_failed');

      const action = coordinator.actionItems.find(a => a.id === 'act_01')!;
      assert.equal(action.verificationStatus, 'verification_failed');
      assert.ok(action.recheckNotes?.includes('not found in catalog'));

      const finding = coordinator.findings.find(f => f.actionItemId === 'act_01')!;
      assert.equal(finding.merchantVerified, false);
    });

    it('re-check fails if barcode check digit is invalid', () => {
      // Approve action with a custom value having invalid check digit
      coordinator.approveAction('act_01', '0850029381089');

      const recheckRes = coordinator.recheckAction('act_01');
      assert.equal(recheckRes.isVerified, false);
      assert.equal(recheckRes.verificationStatus, 'verification_failed');
      assert.ok(recheckRes.recheckNotes.includes('fails GTIN-13 check digit validation'));
    });

    it('re-check fails if catalog attribute value diverges from approved value', () => {
      coordinator.approveAction('act_02');
      // Tamper with attribute
      const mug = coordinator.products.find(p => p.id === 'prod_solstice_02')!;
      mug.attributes.microwaveSafe = 'Unspecified';

      const recheckRes = coordinator.recheckAction('act_02');
      assert.equal(recheckRes.isVerified, false);
      assert.equal(recheckRes.verificationStatus, 'verification_failed');
      assert.ok(recheckRes.recheckNotes.includes('does not match approved value'));
    });

    it('re-check on unapproved pending action leaves status as recheck_required', () => {
      const recheckRes = coordinator.recheckAction('act_01'); // unapproved item
      assert.equal(recheckRes.isVerified, false);
      assert.equal(recheckRes.verificationStatus, 'recheck_required');
      assert.equal(recheckRes.errorCode, 'ACTION_PENDING');

      const action = coordinator.actionItems.find(a => a.id === 'act_01')!;
      assert.equal(action.status, 'pending_review');
      assert.equal(action.verificationStatus, 'recheck_required');
    });
  });

  describe('P0: Variant Field-to-Property Integrity & Validation', () => {
    it('variants[0].barcode updates only barcode and leaves sku, price, title untouched', () => {
      const candle = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      const originalSku = candle.variants[0].sku;
      const originalPrice = candle.variants[0].price;
      const originalTitle = candle.variants[0].title;

      const res = coordinator.approveAction('act_01');
      assert.equal(res.success, true);

      const candleAfter = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleAfter.variants[0].barcode, '0850029381082');
      assert.equal(candleAfter.variants[0].sku, originalSku, 'SKU must not be touched');
      assert.equal(candleAfter.variants[0].price, originalPrice, 'Price must not be touched');
      assert.equal(candleAfter.variants[0].title, originalTitle, 'Title must not be touched');
    });

    it('variants[0].sku updates only SKU and leaves barcode, price, title untouched', () => {
      coordinator.actionItems.push({
        id: 'act_var_sku',
        findingId: 'find_var_sku',
        productId: 'prod_solstice_04',
        title: 'Update Variant SKU',
        severity: 'medium',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].sku',
          from: 'SOL-CNDL-AMB-01',
          to: 'SOL-CNDL-AMB-REV2',
        },
        verificationStatus: 'unverified',
      });

      const candleBefore = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      const originalBarcode = candleBefore.variants[0].barcode;
      const originalPrice = candleBefore.variants[0].price;
      const originalTitle = candleBefore.variants[0].title;

      const res = coordinator.approveAction('act_var_sku');
      assert.equal(res.success, true);

      const candleAfter = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleAfter.variants[0].sku, 'SOL-CNDL-AMB-REV2');
      assert.equal(candleAfter.variants[0].barcode, originalBarcode, 'Barcode must not be overwritten with SKU');
      assert.equal(candleAfter.variants[0].price, originalPrice, 'Price must not be touched');
      assert.equal(candleAfter.variants[0].title, originalTitle, 'Title must not be touched');

      // Re-check verifies exact SKU
      const recheck = coordinator.recheckAction('act_var_sku');
      assert.equal(recheck.success, true);
      assert.equal(recheck.isVerified, true);
      assert.equal(recheck.verificationStatus, 'verified_in_catalog');
    });

    it('variants[0].price updates price and strictly validates all numeric and string boundaries', () => {
      const candle = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      const originalPrice = candle.variants[0].price;
      const originalBarcode = candle.variants[0].barcode;

      // 1. Rejects empty string (both via proposedChange.to and customApprovedValue)
      coordinator.actionItems.push({
        id: 'act_empty_price',
        findingId: 'find_empty_price',
        productId: 'prod_solstice_04',
        title: 'Set Empty Price',
        severity: 'medium',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].price',
          from: '34',
          to: '',
        },
        verificationStatus: 'unverified',
      });

      const resEmpty = coordinator.approveAction('act_empty_price');
      assert.equal(resEmpty.success, false, 'Empty string price must be rejected');
      assert.equal(resEmpty.errorCode, 'UNSUPPORTED_FIELD');
      assert.equal(candle.variants[0].price, originalPrice, 'Stored price must not be modified by empty string');
      assert.equal(coordinator.actionItems.find(a => a.id === 'act_empty_price')?.status, 'pending_review');

      // Also reject when customApprovedValue is empty string
      coordinator.actionItems.push({
        id: 'act_custom_empty_price',
        findingId: 'find_custom_empty_price',
        productId: 'prod_solstice_04',
        title: 'Set Custom Empty Price',
        severity: 'medium',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].price',
          from: '34',
          to: '45.00',
        },
        verificationStatus: 'unverified',
      });
      const resCustomEmpty = coordinator.approveAction('act_custom_empty_price', '');
      assert.equal(resCustomEmpty.success, false, 'Custom empty string price must be rejected');
      assert.equal(resCustomEmpty.errorCode, 'UNSUPPORTED_FIELD');
      assert.equal(candle.variants[0].price, originalPrice, 'Stored price must not be modified by custom empty string');

      // 2. Rejects whitespace-only string (spaces, tabs, newlines)
      coordinator.actionItems.push({
        id: 'act_whitespace_price',
        findingId: 'find_ws_price',
        productId: 'prod_solstice_04',
        title: 'Set Whitespace Price',
        severity: 'medium',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].price',
          from: '34',
          to: '   \t  \n  ',
        },
        verificationStatus: 'unverified',
      });

      const resWs = coordinator.approveAction('act_whitespace_price');
      assert.equal(resWs.success, false, 'Whitespace-only price must be rejected');
      assert.equal(resWs.errorCode, 'UNSUPPORTED_FIELD');
      assert.equal(candle.variants[0].price, originalPrice, 'Stored price must not be modified by whitespace-only string');
      assert.equal(coordinator.actionItems.find(a => a.id === 'act_whitespace_price')?.status, 'pending_review');

      // 3. Rejects negative values, non-numeric values, signs, non-decimal bases, scientific notation, and values exceeding MAX_SAFE_INTEGER
      const invalidPriceValues = [
        '-10.50',
        '-0.01',
        '-1',
        '+1',
        '+12.50',
        '-0',
        '.5',
        '1.',
        '1e3',
        '2.5E2',
        '0x10',
        '0X1A',
        '0b101',
        '0o77',
        '$12.50',
        '12..50',
        'invalid_price_abc',
        'NaN',
        'Infinity',
        '-Infinity',
        '9007199254740992', // Exceeds Number.MAX_SAFE_INTEGER (9007199254740991)
        '0.10000000000000001', // Precision loss: cannot be represented without floating-point distortion
        '1.234567890123456789', // Precision loss: truncated by IEEE-754 binary64
        '0.30000000000000004', // Binary floating-point calculation artifact: 0.1 + 0.2
        '0.6000000000000001', // Binary floating-point calculation artifact: 0.2 + 0.4
        '0.9999999999999999', // Binary floating-point calculation artifact: 0.7 + 0.1 + 0.1 + 0.1
      ];
      for (const [idx, badVal] of invalidPriceValues.entries()) {
        const badId = `act_bad_val_${idx}`;
        coordinator.actionItems.push({
          id: badId,
          findingId: `find_bad_val_${idx}`,
          productId: 'prod_solstice_04',
          title: `Set Bad Price ${badVal}`,
          severity: 'medium',
          status: 'pending_review',
          evidenceRequired: false,
          proposedChange: {
            field: 'variants[0].price',
            from: '34',
            to: badVal,
          },
          verificationStatus: 'unverified',
        });

        const resBad = coordinator.approveAction(badId);
        assert.equal(resBad.success, false, `Price value "${badVal}" must be rejected`);
        assert.equal(resBad.errorCode, 'UNSUPPORTED_FIELD');
        assert.equal(candle.variants[0].price, originalPrice, `Stored price must not be modified by "${badVal}"`);
        assert.equal(coordinator.actionItems.find(a => a.id === badId)?.status, 'pending_review');
      }

      // 3b. Re-check rejects invalid expected prices without treating them as valid numbers
      coordinator.actionItems.push({
        id: 'act_recheck_bad_expected',
        findingId: 'find_recheck_bad_expected',
        productId: 'prod_solstice_04',
        title: 'Recheck Action with Invalid Expected Price',
        severity: 'medium',
        status: 'approved',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].price',
          from: '34',
          to: '0x10',
        },
        verificationStatus: 'recheck_required',
      });
      const recheckBadExpected = coordinator.recheckAction('act_recheck_bad_expected');
      assert.equal(recheckBadExpected.success, true);
      assert.equal(recheckBadExpected.isVerified, false, 'Recheck must not verify invalid expected price "0x10"');
      assert.equal(recheckBadExpected.verificationStatus, 'verification_failed');

      // 3c. Re-check rejects expected price suffering floating-point precision loss
      coordinator.actionItems.push({
        id: 'act_recheck_precision_loss',
        findingId: 'find_recheck_precision_loss',
        productId: 'prod_solstice_04',
        title: 'Recheck Action with Precision Loss Expected Price',
        severity: 'medium',
        status: 'approved',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].price',
          from: '34',
          to: '0.10000000000000001',
        },
        verificationStatus: 'recheck_required',
      });
      const recheckPrecLoss = coordinator.recheckAction('act_recheck_precision_loss');
      assert.equal(recheckPrecLoss.success, true);
      assert.equal(recheckPrecLoss.isVerified, false, 'Recheck must not verify precision loss expected price');
      assert.equal(recheckPrecLoss.verificationStatus, 'verification_failed');

      // 3d. Re-check rejects expected price containing floating-point calculation artifact
      coordinator.actionItems.push({
        id: 'act_recheck_artifact',
        findingId: 'find_recheck_artifact',
        productId: 'prod_solstice_04',
        title: 'Recheck Action with Calculation Artifact Expected Price',
        severity: 'medium',
        status: 'approved',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].price',
          from: '34',
          to: '0.30000000000000004',
        },
        verificationStatus: 'recheck_required',
      });
      const recheckArtifact = coordinator.recheckAction('act_recheck_artifact');
      assert.equal(recheckArtifact.success, true);
      assert.equal(recheckArtifact.isVerified, false, 'Recheck must not verify floating-point calculation artifact expected price');
      assert.equal(recheckArtifact.verificationStatus, 'verification_failed');

      // 4. Accepts valid numeric zero and updates variant.price as number 0
      coordinator.actionItems.push({
        id: 'act_zero_price',
        findingId: 'find_zero_price',
        productId: 'prod_solstice_04',
        title: 'Set Promotional Zero Price',
        severity: 'low',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].price',
          from: '34',
          to: '0',
        },
        verificationStatus: 'unverified',
      });

      const resZero = coordinator.approveAction('act_zero_price');
      assert.equal(resZero.success, true, 'Valid numeric zero price must be accepted');
      const candleZero = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleZero.variants[0].price, 0);
      assert.equal(typeof candleZero.variants[0].price, 'number');

      // Re-check verifies numeric zero
      const recheckZero = coordinator.recheckAction('act_zero_price');
      assert.equal(recheckZero.success, true);
      assert.equal(recheckZero.isVerified, true);
      assert.equal(recheckZero.verificationStatus, 'verified_in_catalog');

      // 5. Accepts a valid positive price and updates variant.price as number
      coordinator.actionItems.push({
        id: 'act_valid_price',
        findingId: 'find_valid_price',
        productId: 'prod_solstice_04',
        title: 'Update Variant Price',
        severity: 'medium',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].price',
          from: '0',
          to: '38.50',
        },
        verificationStatus: 'unverified',
      });

      const resValid = coordinator.approveAction('act_valid_price');
      assert.equal(resValid.success, true);

      const candlePositive = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candlePositive.variants[0].price, 38.5);
      assert.equal(typeof candlePositive.variants[0].price, 'number');
      assert.equal(candlePositive.variants[0].barcode, originalBarcode, 'Barcode must not be overwritten with price');

      // Re-check verifies exact price
      const recheck = coordinator.recheckAction('act_valid_price');
      assert.equal(recheck.success, true);
      assert.equal(recheck.isVerified, true);
      assert.equal(recheck.verificationStatus, 'verified_in_catalog');

      // 6. Accepts small valid fractional price 0.0000001 without scientific notation false rejection
      coordinator.actionItems.push({
        id: 'act_small_frac_price',
        findingId: 'find_small_frac_price',
        productId: 'prod_solstice_04',
        title: 'Set Micro-Price 0.0000001',
        severity: 'low',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].price',
          from: '38.50',
          to: '0.0000001',
        },
        verificationStatus: 'unverified',
      });
      const resSmallFrac = coordinator.approveAction('act_small_frac_price');
      assert.equal(resSmallFrac.success, true, 'Small fraction 0.0000001 must be accepted');
      const candleSmallFrac = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleSmallFrac.variants[0].price, 0.0000001);

      const recheckSmallFrac = coordinator.recheckAction('act_small_frac_price');
      assert.equal(recheckSmallFrac.success, true);
      assert.equal(recheckSmallFrac.isVerified, true);
      assert.equal(recheckSmallFrac.verificationStatus, 'verified_in_catalog');

      // 7. Equivalent decimal representation: re-check verifies '0.10' against stored 0.1
      coordinator.actionItems.push({
        id: 'act_equiv_cents',
        findingId: 'find_equiv_cents',
        productId: 'prod_solstice_04',
        title: 'Set Ten Cents',
        severity: 'low',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].price',
          from: '0.0000001',
          to: '0.1',
        },
        verificationStatus: 'unverified',
      });
      coordinator.approveAction('act_equiv_cents');

      // Recheck with '0.10' as expected value
      coordinator.actionItems.push({
        id: 'act_recheck_ten_cents',
        findingId: 'find_recheck_ten_cents',
        productId: 'prod_solstice_04',
        title: 'Verify Ten Cents Representation',
        severity: 'low',
        status: 'approved',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].price',
          from: '0',
          to: '0.10',
        },
        verificationStatus: 'recheck_required',
      });
      const recheckTenCents = coordinator.recheckAction('act_recheck_ten_cents');
      assert.equal(recheckTenCents.success, true);
      assert.equal(recheckTenCents.isVerified, true, 'Stored 0.1 must verify against approved "0.10"');

      // 8. Atomic rollback on price mutation failure when backend storage write fails
      const priceBeforeFail = coordinator.products.find(p => p.id === 'prod_solstice_04')!.variants[0].price;
      coordinator.backend.setItem = () => {
        throw new Error('Storage write failed (quota exceeded)');
      };
      coordinator.actionItems.push({
        id: 'act_price_rollback_test',
        findingId: 'find_price_rollback',
        productId: 'prod_solstice_04',
        title: 'Price Mutation Failing Storage',
        severity: 'medium',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].price',
          from: String(priceBeforeFail),
          to: '45.00',
        },
        verificationStatus: 'unverified',
      });
      const resRollback = coordinator.approveAction('act_price_rollback_test');
      assert.equal(resRollback.success, false);
      assert.equal((resRollback as { rolledBack?: boolean }).rolledBack, true);
      const candleAfterFail = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleAfterFail.variants[0].price, priceBeforeFail, 'Price must rollback if storage persistence fails');
      assert.equal(coordinator.actionItems.find(a => a.id === 'act_price_rollback_test')?.status, 'pending_review');

      // Restore backend.setItem for subsequent tests
      coordinator.backend.setItem = (k: string, v: string) => {
        (coordinator.backend as unknown as { store: Map<string, string> }).store.set(k, v);
      };
    });

    it('variants[0].title updates only title property', () => {
      coordinator.actionItems.push({
        id: 'act_var_title',
        findingId: 'find_var_title',
        productId: 'prod_solstice_04',
        title: 'Update Variant Title',
        severity: 'low',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].title',
          from: '8 oz Standard Jar',
          to: '8 oz Amber Glass Tumbler',
        },
        verificationStatus: 'unverified',
      });

      const candleBefore = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      const originalBarcode = candleBefore.variants[0].barcode;

      const res = coordinator.approveAction('act_var_title');
      assert.equal(res.success, true);

      const candleAfter = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleAfter.variants[0].title, '8 oz Amber Glass Tumbler');
      assert.equal(candleAfter.variants[0].barcode, originalBarcode, 'Barcode must not be overwritten with title');

      // Re-check verifies exact title
      const recheck = coordinator.recheckAction('act_var_title');
      assert.equal(recheck.success, true);
      assert.equal(recheck.isVerified, true);
    });

    it('rejects unsupported variant property with UNSUPPORTED_FIELD', () => {
      coordinator.actionItems.push({
        id: 'act_bad_prop',
        findingId: 'find_bad_prop',
        productId: 'prod_solstice_04',
        title: 'Update Unsupported Property',
        severity: 'low',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[0].unsupportedProperty',
          from: '',
          to: 'value',
        },
        verificationStatus: 'unverified',
      });

      const res = coordinator.approveAction('act_bad_prop');
      assert.equal(res.success, false);
      assert.equal(res.errorCode, 'UNSUPPORTED_FIELD');
    });
  });

  describe('P0: Global Fields & Claim Routing Integrity', () => {
    it('store.catalogPolicy.units updates storeProfile.catalogPolicy.units and re-check confirms it', () => {
      const res = coordinator.approveAction('act_04');
      assert.equal(res.success, true);

      assert.equal(coordinator.storeProfile.catalogPolicy?.units, 'Dual-unit standard: Metric (Imperial)');

      const recheck = coordinator.recheckAction('act_04');
      assert.equal(recheck.success, true);
      assert.equal(recheck.isVerified, true);
      assert.equal(recheck.verificationStatus, 'verified_in_catalog');
    });

    it('connectors.gmc.shipping_sla updates storeProfile.shippingSla.gmc and re-check confirms it', () => {
      const res = coordinator.approveAction('act_06');
      assert.equal(res.success, true);

      assert.equal(coordinator.storeProfile.shippingSla?.gmc, '2 business days');

      const recheck = coordinator.recheckAction('act_06');
      assert.equal(recheck.success, true);
      assert.equal(recheck.isVerified, true);
      assert.equal(recheck.verificationStatus, 'verified_in_catalog');
    });

    it('unsupported global field fails without mutating storeProfile, actions, or catalog', () => {
      coordinator.actionItems.push({
        id: 'act_bad_global',
        findingId: 'find_bad_global',
        title: 'Unsupported Global Config',
        severity: 'low',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'store.unsupportedGlobalConfig',
          from: 'a',
          to: 'b',
        },
        verificationStatus: 'unverified',
      });

      const storeSnapshot = JSON.stringify(coordinator.storeProfile);
      const catalogSnapshot = JSON.stringify(coordinator.products);

      const res = coordinator.approveAction('act_bad_global');
      assert.equal(res.success, false);
      assert.equal(res.errorCode, 'UNSUPPORTED_FIELD');

      assert.equal(JSON.stringify(coordinator.storeProfile), storeSnapshot);
      assert.equal(JSON.stringify(coordinator.products), catalogSnapshot);
      assert.equal(coordinator.actionItems.find(a => a.id === 'act_bad_global')!.status, 'pending_review');
    });

    it('explicit title / marketing claims reconciles to verifiedBurnTime without ambiguous routing', () => {
      const res = coordinator.approveAction('act_07');
      assert.equal(res.success, true);

      const candle = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candle.attributes.verifiedBurnTime, 'Up to 50 Hours (Verified Lab Burn Rate)');

      const recheck = coordinator.recheckAction('act_07');
      assert.equal(recheck.success, true);
      assert.equal(recheck.isVerified, true);
      assert.equal(recheck.verificationStatus, 'verified_in_catalog');
    });
  });

  describe('Phase C: Mutation Validation & Target Safeguards', () => {
    it('rejects unsupported field without mutating catalog or action status', () => {
      coordinator.actionItems.push({
        id: 'act_malicious',
        findingId: 'find_malicious',
        productId: 'prod_solstice_01',
        title: 'Inject Custom Field',
        severity: 'high',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'unsupported.injected_field',
          from: '',
          to: 'exploit',
        },
        verificationStatus: 'unverified',
      });

      const catalogSnapshot = JSON.stringify(coordinator.products);
      const res = coordinator.approveAction('act_malicious');

      assert.equal(res.success, false);
      assert.equal(res.errorCode, 'UNSUPPORTED_FIELD');
      assert.equal(JSON.stringify(coordinator.products), catalogSnapshot);

      const action = coordinator.actionItems.find(a => a.id === 'act_malicious')!;
      assert.equal(action.status, 'pending_review');
      assert.equal(action.verificationStatus, 'unverified');
    });

    it('rejects unlisted structured attribute without mutating catalog', () => {
      coordinator.actionItems.push({
        id: 'act_bad_attr',
        findingId: 'find_bad_attr',
        productId: 'prod_solstice_01',
        title: 'Unknown Attribute',
        severity: 'low',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'attributes.unregisteredRandomAttribute',
          from: '',
          to: 'xyz',
        },
        verificationStatus: 'unverified',
      });

      const res = coordinator.approveAction('act_bad_attr');
      assert.equal(res.success, false);
      assert.equal(res.errorCode, 'UNSUPPORTED_FIELD');
    });

    it('rejects missing target product with PRODUCT_NOT_FOUND', () => {
      coordinator.actionItems.push({
        id: 'act_missing_prod',
        findingId: 'find_missing_prod',
        productId: 'prod_does_not_exist_999',
        title: 'Missing Product Action',
        severity: 'medium',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'attributes.microwaveSafe',
          from: '',
          to: 'True',
        },
        verificationStatus: 'unverified',
      });

      const res = coordinator.approveAction('act_missing_prod');
      assert.equal(res.success, false);
      assert.equal(res.errorCode, 'PRODUCT_NOT_FOUND');
    });

    it('rejects out-of-bounds variant index and NEVER silently falls back to variant[0]', () => {
      coordinator.actionItems.push({
        id: 'act_out_of_bounds_variant',
        findingId: 'find_oob_var',
        productId: 'prod_solstice_04',
        title: 'Mutate Non-Existent Variant 99',
        severity: 'high',
        status: 'pending_review',
        evidenceRequired: false,
        proposedChange: {
          field: 'variants[99].barcode',
          from: '',
          to: '0850029381082',
        },
        verificationStatus: 'unverified',
      });

      const candleBefore = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      const barcodeBefore = candleBefore.variants[0].barcode;

      const res = coordinator.approveAction('act_out_of_bounds_variant');
      assert.equal(res.success, false);
      assert.equal(res.errorCode, 'VARIANT_OUT_OF_BOUNDS');

      const candleAfter = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleAfter.variants[0].barcode, barcodeBefore, 'Variant[0] must NOT be silently mutated');
    });

    it('mutates only the intended variant on the intended product', () => {
      const mugBefore = coordinator.products.find(p => p.id === 'prod_solstice_02')!;
      const coffeeBefore = coordinator.products.find(p => p.id === 'prod_solstice_01')!;
      const coffeeSnapshot = JSON.stringify(coffeeBefore);

      coordinator.approveAction('act_02'); // Mutates mug microwaveSafe

      const mugAfter = coordinator.products.find(p => p.id === 'prod_solstice_02')!;
      const coffeeAfter = coordinator.products.find(p => p.id === 'prod_solstice_01')!;

      assert.equal(mugAfter.attributes.microwaveSafe, 'True (Tested up to 900W)');
      assert.equal(JSON.stringify(coffeeAfter), coffeeSnapshot, 'Unrelated product must not be touched');
    });

    it('recalculates product completeness accurately using domain rules', () => {
      const candle = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      const initialScore = candle.completenessScore;
      assert.equal(initialScore, 71);

      coordinator.approveAction('act_01'); // assigns valid GTIN barcode to candle variant

      const candleAfter = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      const recalculated = calculateProductCompleteness(candleAfter);
      assert.equal(candleAfter.completenessScore, recalculated);
      assert.ok(candleAfter.completenessScore > initialScore);
      assert.ok(candleAfter.completenessScore <= 100);
    });

    it('no-op mutation does not increase completeness score', () => {
      coordinator.approveAction('act_02');
      const mugAfterFirst = coordinator.products.find(p => p.id === 'prod_solstice_02')!;
      const scoreFirst = mugAfterFirst.completenessScore;

      const scoreRecheck = calculateProductCompleteness(mugAfterFirst);
      assert.equal(scoreRecheck, scoreFirst);
    });
  });

  describe('Phase E: Storage, Durability & Atomic Persistence', () => {
    it('blocks mutations when in read-only compatibility mode', () => {
      const roCoordinator = new ProductionActionCoordinator(true);
      assert.equal(roCoordinator.isReadOnlyMode, true);

      const candleBefore = roCoordinator.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleBefore.variants[0].barcode, '');

      const res = roCoordinator.approveAction('act_01');
      assert.equal(res.success, false);
      assert.equal(res.errorCode, 'READ_ONLY_MODE');

      const candleAfter = roCoordinator.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleAfter.variants[0].barcode, '');
      assert.ok(roCoordinator.toasts.some(t => t.title === 'Action Disabled'));
    });

    it('blocks re-check when in read-only mode', () => {
      const roCoordinator = new ProductionActionCoordinator(true);
      const res = roCoordinator.recheckAction('act_01');
      assert.equal(res.success, false);
      assert.equal(res.errorCode, 'READ_ONLY_MODE');
      assert.ok(roCoordinator.toasts.some(t => t.title === 'Re-check Disabled'));
    });

    it('blocks dismissal when in read-only mode', () => {
      const roCoordinator = new ProductionActionCoordinator(true);
      const res = roCoordinator.dismissAction('act_01');
      assert.equal(res.success, false);
      assert.equal(res.errorCode, 'READ_ONLY_MODE');
    });

    it('rolls back in-memory state atomically if persistence fails', () => {
      coordinator.backend.setItem = () => {
        throw new Error('Disk quota exceeded');
      };

      const candleBefore = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleBefore.variants[0].barcode, '');

      const res = coordinator.approveAction('act_01');
      assert.equal(res.success, false);
      assert.equal((res as { rolledBack?: boolean }).rolledBack, true);

      const candleAfter = coordinator.products.find(p => p.id === 'prod_solstice_04')!;
      assert.equal(candleAfter.variants[0].barcode, '', 'In-memory catalog must roll back on save failure');

      const actionAfter = coordinator.actionItems.find(a => a.id === 'act_01')!;
      assert.equal(actionAfter.status, 'pending_review', 'Action status must roll back on save failure');
      assert.ok(coordinator.toasts.some(t => t.title.includes('Rolled Back')));
    });

    it('persists successful mutation and reloads accurately from storage envelope', () => {
      coordinator.approveAction('act_01');

      const loaded = coordinator.adapter.load();
      assert.equal(loaded.type, 'valid');
      if (loaded.type === 'valid') {
        const candle = loaded.envelope.payload.products.find(p => p.id === 'prod_solstice_04')!;
        assert.equal(candle.variants[0].barcode, '0850029381082');

        const act = loaded.envelope.payload.actions.find(a => a.id === 'act_01')!;
        assert.equal(act.status, 'approved');
        assert.equal(act.verificationStatus, 'recheck_required');
      }
    });

    it('recovers from corrupt persisted data non-destructively', () => {
      coordinator.backend.setItem('aixshop_catalog_v1', '{malformed_json:::');

      const loaded = coordinator.adapter.load();
      assert.equal(loaded.type, 'corrupt');
      assert.ok(loaded.type === 'corrupt' && loaded.backupKey);
      if (loaded.type === 'corrupt' && loaded.backupKey) {
        assert.ok(loaded.backupKey.startsWith('aixshop_catalog_v1_corrupt_'));
        const backupVal = coordinator.backend.getItem(loaded.backupKey);
        assert.equal(backupVal, '{malformed_json:::');
      }
    });
  });

  describe('P1: Truthful Store Check & Non-Fabricated Metrics', () => {
    it('normalizes store URLs correctly with various protocols and trailing paths', () => {
      const res1 = normalizeStoreUrl('solsticemercantile.com');
      assert.equal(res1.isValid, true);
      assert.equal(res1.hostname, 'solsticemercantile.com');
      assert.equal(res1.origin, 'https://solsticemercantile.com');

      const res2 = normalizeStoreUrl('http://my-shop.myshopify.com/collections/all');
      assert.equal(res2.isValid, true);
      assert.equal(res2.hostname, 'my-shop.myshopify.com');
      assert.equal(res2.origin, 'http://my-shop.myshopify.com');

      const res3 = normalizeStoreUrl('');
      assert.equal(res3.isValid, false);

      const res4 = normalizeStoreUrl('not_a_valid_url');
      assert.equal(res4.isValid, false);
    });

    it('evaluates Solstice demo fixture cleanly as demo_fixture without mock fabrication', async () => {
      const check = await ingestAndAnalyzeStore('https://solstice.store');
      assert.equal(check.scanStatus, 'demo_fixture');
      assert.equal(check.detectedPlatform, 'Solstice Mercantile (Demo Fixture Feed)');
      assert.ok(check.catalogCompletenessEstimate > 70);
      assert.ok(check.gtinPresentRatio > 50);
      assert.ok(check.sampleIssues.length > 0);
    });

    it('assigns 0% completeness to empty store catalog without inventing points', async () => {
      const customFetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ products: [] }),
      } as unknown as Response);

      const res = await ingestAndAnalyzeStore('https://empty-store.myshopify.com', {
        customFetch: customFetch as unknown as typeof fetch,
      });

      assert.equal(res.scanStatus, 'real_scan');
      assert.equal(res.catalogCompletenessEstimate, 0, 'Empty catalog must have 0 completeness');
      assert.equal(res.gtinPresentRatio, 0);
      assert.ok(res.sampleIssues.some(i => i.includes('0 active public products')));
    });

    it('ingests and evaluates real Shopify catalog feed without fabricating inventory or evidence', async () => {
      const mockShopifyResponse = {
        products: [
          {
            id: 101,
            title: 'Organic Wool Throw Blanket',
            vendor: 'North Weavers',
            product_type: 'Home Goods',
            body_html: '<p>Handcrafted 100% natural organic wool blanket made from heritage sheep wool.</p>',
            variants: [
              {
                id: 201,
                title: 'Charcoal',
                sku: 'NW-WOOL-CHR',
                barcode: '0850029381082', // Valid GTIN-13
                price: '120.00',
                available: true,
              },
            ],
          },
          {
            id: 102,
            title: 'Campfire Enamel Cup',
            vendor: '', // Missing vendor
            product_type: '', // Missing product type
            body_html: '<p>Steel cup.</p>', // Short description (<20 chars)
            variants: [
              {
                id: 202,
                title: 'Default Title',
                sku: 'TF-CUP-01',
                barcode: '', // Missing barcode
                price: '18.00',
                available: false,
              },
            ],
          },
        ],
      };

      const customFetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockShopifyResponse,
      } as unknown as Response);

      const result = await ingestAndAnalyzeStore('https://trail-and-forge.myshopify.com', {
        customFetch: customFetch as unknown as typeof fetch,
      });

      assert.equal(result.scanStatus, 'real_scan');
      assert.equal(result.schemaFound, true);
      // 1 out of 2 variants has valid GTIN = 50%
      assert.equal(result.gtinPresentRatio, 50);
      // Sample label correctly documents sample scope
      assert.ok(result.detectedPlatform.includes('Shopify Public Storefront Sample'));
      // Identified genuine missing fields
      assert.ok(result.sampleIssues.some(i => i.includes('Missing GTIN/UPC')));
      assert.ok(result.sampleIssues.some(i => i.includes('description')));
      assert.ok(result.sampleIssues.some(i => i.includes('brand')));
      assert.ok(result.sampleIssues.some(i => i.includes('taxonomy')));
    });

    it('handles restricted / non-public storefront gracefully as unsupported_store', async () => {
      const customFetch = async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({}),
      } as unknown as Response);

      const result = await ingestAndAnalyzeStore('https://private-store.com', {
        customFetch: customFetch as unknown as typeof fetch,
      });

      assert.equal(result.scanStatus, 'unsupported_store');
      assert.ok(result.sampleIssues.some(i => i.includes('HTTP 403 Forbidden')));
      assert.ok(result.notice?.includes('Settings'));
    });

    it('handles network / CORS fetch failure gracefully as network_failure without claiming scan succeeded', async () => {
      const customFetch = async () => {
        throw new Error('Failed to fetch (CORS header missing)');
      };

      const result = await ingestAndAnalyzeStore('https://cors-blocked-store.com', {
        customFetch: customFetch as unknown as typeof fetch,
      });

      assert.equal(result.scanStatus, 'network_failure');
      assert.equal(result.catalogCompletenessEstimate, 0);
      assert.ok(result.sampleIssues.some(i => i.includes('CORS')));
    });
  });

  describe('Phase D: End-to-End Workflow & Regression Verification', () => {
    it('executes the full lifecycle: inspect -> approve -> persist -> re-check -> verify', () => {
      const action = coordinator.actionItems.find(a => a.id === 'act_01')!;
      const finding = coordinator.findings.find(f => f.actionItemId === action.id)!;
      const product = coordinator.products.find(p => p.id === action.productId)!;

      assert.equal(action.status, 'pending_review');
      assert.equal(action.verificationStatus, 'unverified');
      assert.equal(finding.merchantVerified, false);
      assert.equal(product.variants[0].barcode, '');
      const initialScore = product.completenessScore;

      // Approval
      const approveRes = coordinator.approveAction('act_01');
      assert.equal(approveRes.success, true);

      // Post-Approval State Check
      const approvedAction = coordinator.actionItems.find(a => a.id === 'act_01')!;
      const updatedFinding = coordinator.findings.find(f => f.actionItemId === action.id)!;
      const updatedProduct = coordinator.products.find(p => p.id === action.productId)!;

      assert.equal(approvedAction.status, 'approved');
      assert.equal(approvedAction.verificationStatus, 'recheck_required');
      assert.equal(updatedFinding.merchantVerified, false);
      assert.equal(updatedProduct.variants[0].barcode, '0850029381082');
      assert.ok(updatedProduct.completenessScore > initialScore);

      // Persistence Verification
      const loaded = coordinator.adapter.load();
      assert.equal(loaded.type, 'valid');
      if (loaded.type === 'valid') {
        const persistedProduct = loaded.envelope.payload.products.find(p => p.id === product.id)!;
        assert.equal(persistedProduct.variants[0].barcode, '0850029381082');
      }

      // Re-check Execution
      const recheckRes = coordinator.recheckAction('act_01');
      assert.equal(recheckRes.success, true);
      assert.equal(recheckRes.isVerified, true);
      assert.equal(recheckRes.verificationStatus, 'verified_in_catalog');

      // Final Verified State
      const verifiedAction = coordinator.actionItems.find(a => a.id === 'act_01')!;
      const verifiedFinding = coordinator.findings.find(f => f.actionItemId === action.id)!;

      assert.equal(verifiedAction.verificationStatus, 'verified_in_catalog');
      assert.equal(verifiedFinding.merchantVerified, true);
    });
  });
});
