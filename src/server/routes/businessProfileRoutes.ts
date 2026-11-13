import { Router, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware, requireRole } from '../middleware/auth';
import { AuthRequest } from '../types';
import { WorkspaceBusinessProfile } from '../../domain/businessProfile/types';

/**
 * Trusted server-side helper for recording independent external verification
 * (e.g. DNS TXT record proof, Shopify shop domain verification, or signed API attestation).
 * Must never be exposed directly to arbitrary merchant PUT payloads.
 */
export async function recordIndependentBusinessVerification(
  repo: DatabaseRepository,
  workspaceId: string,
  source: string,
  evidence: Record<string, any>
): Promise<WorkspaceBusinessProfile> {
  if (!source || !source.trim()) {
    throw new Error('Verification source is required for independent verification.');
  }
  const existing = await repo.getWorkspaceBusinessProfile(workspaceId);
  if (!existing) {
    throw new Error(`Business profile not found for workspace ${workspaceId}.`);
  }

  const nowIso = new Date().toISOString();
  return repo.saveWorkspaceBusinessProfile({
    ...existing,
    verificationStatus: 'independently_verified',
    verificationSource: source.trim(),
    verificationEvidence: evidence,
    lastVerifiedAt: nowIso,
    updatedAt: nowIso,
  });
}

export function createBusinessProfileRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);

  // GET /api/business-profile — Get workspace business & brand profile
  router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const profile = await repo.getWorkspaceBusinessProfile(workspaceId);
      const store = await repo.getStoreByWorkspace(workspaceId);

      const defaultProfile: WorkspaceBusinessProfile = {
        id: `bp_${workspaceId}`,
        workspaceId,
        legalBusinessName: '',
        publicBrandName: store?.name || '',
        brandDescription: '',
        officialWebsite: store?.domain ? (store.domain.startsWith('http') ? store.domain : `https://${store.domain}`) : '',
        primaryDomain: store?.domain || '',
        contactEmail: '',
        contactPhone: '',
        businessAddress: '',
        supportUrl: '',
        shippingPolicyUrl: '',
        returnPolicyUrl: '',
        refundPolicyUrl: '',
        privacyPolicyUrl: '',
        termsOfServiceUrl: '',
        logoUrl: '',
        socialProfiles: [],
        verificationStatus: 'not_verified',
        verificationSource: null,
        verificationEvidence: null,
        lastVerifiedAt: null,
        updatedAt: new Date().toISOString(),
      };

      return res.json({
        success: true,
        profile: profile || defaultProfile,
      });
    } catch (err: any) {
      console.error('[Business Profile API] Error retrieving profile:', err);
      return res.status(500).json({ error: 'Failed to retrieve business profile' });
    }
  });

  // PUT /api/business-profile — Update workspace business profile (merchants cannot self-declare independent verification)
  router.put('/', requireAuth, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const existing = await repo.getWorkspaceBusinessProfile(workspaceId);
      const body = req.body || {};

      // Reject explicit client attempts to spoof protected verification fields or timestamps
      const requestedStatus = typeof body.verificationStatus === 'string' ? body.verificationStatus.trim() : '';
      const hasProtectedStatusTampering = requestedStatus === 'independently_verified';
      const hasProtectedSourceTampering =
        body.verificationSource !== undefined &&
        body.verificationSource !== null &&
        body.verificationSource !== (existing?.verificationSource ?? null) &&
        String(body.verificationSource).trim() !== '';
      const hasProtectedEvidenceTampering =
        body.verificationEvidence !== undefined &&
        body.verificationEvidence !== null &&
        JSON.stringify(body.verificationEvidence) !== JSON.stringify(existing?.verificationEvidence ?? null);
      const hasProtectedTimestampTampering =
        body.lastVerifiedAt !== undefined &&
        body.lastVerifiedAt !== null &&
        body.lastVerifiedAt !== (existing?.lastVerifiedAt ?? null);

      if (
        hasProtectedStatusTampering ||
        hasProtectedSourceTampering ||
        hasProtectedEvidenceTampering ||
        hasProtectedTimestampTampering
      ) {
        return res.status(403).json({
          error:
            'Forbidden: verificationStatus="independently_verified", verificationSource, verificationEvidence, and lastVerifiedAt are server-controlled fields.',
          code: 'PROTECTED_VERIFICATION_FIELD',
        });
      }

      const str = (val: any, fallback = '') => (typeof val === 'string' ? val.trim() : fallback);

      const legalBusinessName = str(body.legalBusinessName, existing?.legalBusinessName || '');
      const publicBrandName = str(body.publicBrandName ?? body.brandName, existing?.publicBrandName || '');
      const brandDescription = str(body.brandDescription, existing?.brandDescription || '');
      const officialWebsite = str(body.officialWebsite ?? body.websiteUrl, existing?.officialWebsite || '');
      const primaryDomain = str(body.primaryDomain, existing?.primaryDomain || '');
      const contactEmail = str(body.contactEmail ?? body.supportEmail, existing?.contactEmail || '');
      const contactPhone = str(body.contactPhone ?? body.supportPhone, existing?.contactPhone || '');
      const businessAddress = str(body.businessAddress ?? body.registeredAddress, existing?.businessAddress || '');
      const supportUrl = str(body.supportUrl, existing?.supportUrl || '');
      const shippingPolicyUrl = str(body.shippingPolicyUrl, existing?.shippingPolicyUrl || '');
      const returnPolicyUrl = str(body.returnPolicyUrl ?? body.returnRefundPolicyUrl, existing?.returnPolicyUrl || '');
      const refundPolicyUrl = str(body.refundPolicyUrl ?? body.returnRefundPolicyUrl, existing?.refundPolicyUrl || '');
      const privacyPolicyUrl = str(body.privacyPolicyUrl, existing?.privacyPolicyUrl || '');
      const termsOfServiceUrl = str(body.termsOfServiceUrl, existing?.termsOfServiceUrl || '');
      const logoUrl = str(body.logoUrl, existing?.logoUrl || '');

      const hasAnyMerchantDeclaration = Boolean(
        legalBusinessName ||
          publicBrandName ||
          officialWebsite ||
          primaryDomain ||
          contactEmail ||
          businessAddress
      );

      // Preserve existing independently_verified status ONLY if already verified by server and domain/legal name didn't change
      const existingWasVerified = existing?.verificationStatus === 'independently_verified';
      const identityChanged =
        existingWasVerified &&
        (legalBusinessName !== (existing?.legalBusinessName || '') ||
          primaryDomain !== (existing?.primaryDomain || '') ||
          officialWebsite !== (existing?.officialWebsite || ''));

      const nextStatus: WorkspaceBusinessProfile['verificationStatus'] =
        existingWasVerified && !identityChanged
          ? 'independently_verified'
          : hasAnyMerchantDeclaration
          ? 'merchant_self_declared'
          : 'not_verified';

      const profile: WorkspaceBusinessProfile = {
        id: existing?.id || `bp_${workspaceId}`,
        workspaceId,
        legalBusinessName,
        publicBrandName,
        brandDescription,
        officialWebsite,
        primaryDomain,
        contactEmail,
        contactPhone,
        businessAddress,
        supportUrl,
        shippingPolicyUrl,
        returnPolicyUrl,
        refundPolicyUrl,
        privacyPolicyUrl,
        termsOfServiceUrl,
        logoUrl,
        socialProfiles: Array.isArray(body.socialProfiles)
          ? body.socialProfiles.filter((s: any) => s && typeof s.platform === 'string' && typeof s.url === 'string')
          : existing?.socialProfiles || [],
        verificationStatus: nextStatus,
        verificationSource: nextStatus === 'independently_verified' ? (existing?.verificationSource ?? null) : null,
        verificationEvidence: nextStatus === 'independently_verified' ? (existing?.verificationEvidence ?? null) : null,
        lastVerifiedAt: nextStatus === 'independently_verified' ? (existing?.lastVerifiedAt ?? null) : null,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const saved = await repo.saveWorkspaceBusinessProfile(profile);

      return res.json({
        success: true,
        profile: saved,
      });
    } catch (err: any) {
      console.error('[Business Profile API] Error saving profile:', err);
      return res.status(500).json({ error: 'Failed to save business profile' });
    }
  });

  return router;
}
