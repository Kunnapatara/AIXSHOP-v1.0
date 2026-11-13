import { Router, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware, requireRole } from '../middleware/auth';
import { AuthRequest } from '../types';
import { WorkspaceBusinessProfile } from '../../domain/businessProfile/types';

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
        verificationStatus: 'unverified',
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

  // PUT /api/business-profile — Update workspace business profile
  router.put('/', requireAuth, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const existing = await repo.getWorkspaceBusinessProfile(workspaceId);
      const body = req.body || {};

      const str = (val: any, fallback = '') => (typeof val === 'string' ? val.trim() : fallback);

      const profile: WorkspaceBusinessProfile = {
        id: existing?.id || `bp_${workspaceId}`,
        workspaceId,
        legalBusinessName: str(body.legalBusinessName, existing?.legalBusinessName || ''),
        publicBrandName: str(body.publicBrandName ?? body.brandName, existing?.publicBrandName || ''),
        brandDescription: str(body.brandDescription, existing?.brandDescription || ''),
        officialWebsite: str(body.officialWebsite ?? body.websiteUrl, existing?.officialWebsite || ''),
        primaryDomain: str(body.primaryDomain, existing?.primaryDomain || ''),
        contactEmail: str(body.contactEmail ?? body.supportEmail, existing?.contactEmail || ''),
        contactPhone: str(body.contactPhone ?? body.supportPhone, existing?.contactPhone || ''),
        businessAddress: str(body.businessAddress ?? body.registeredAddress, existing?.businessAddress || ''),
        supportUrl: str(body.supportUrl, existing?.supportUrl || ''),
        shippingPolicyUrl: str(body.shippingPolicyUrl, existing?.shippingPolicyUrl || ''),
        returnPolicyUrl: str(body.returnPolicyUrl ?? body.returnRefundPolicyUrl, existing?.returnPolicyUrl || ''),
        refundPolicyUrl: str(body.refundPolicyUrl ?? body.returnRefundPolicyUrl, existing?.refundPolicyUrl || ''),
        privacyPolicyUrl: str(body.privacyPolicyUrl, existing?.privacyPolicyUrl || ''),
        termsOfServiceUrl: str(body.termsOfServiceUrl, existing?.termsOfServiceUrl || ''),
        logoUrl: str(body.logoUrl, existing?.logoUrl || ''),
        socialProfiles: Array.isArray(body.socialProfiles)
          ? body.socialProfiles.filter((s: any) => s && typeof s.platform === 'string' && typeof s.url === 'string')
          : existing?.socialProfiles || [],
        verificationStatus:
          body.verificationStatus === 'merchant_verified' ||
          body.verificationStatus === 'conflict_detected' ||
          body.verificationStatus === 'unverified'
            ? body.verificationStatus
            : existing?.verificationStatus || 'unverified',
        lastVerifiedAt:
          body.verificationStatus === 'merchant_verified'
            ? new Date().toISOString()
            : existing?.lastVerifiedAt || null,
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
