export type BusinessVerificationStatus =
  | 'not_verified'
  | 'merchant_self_declared'
  | 'verification_pending'
  | 'verification_failed'
  | 'independently_verified';

export interface WorkspaceBusinessProfile {
  id: string;
  workspaceId: string;
  legalBusinessName: string;
  publicBrandName: string;
  brandDescription: string;
  officialWebsite: string;
  primaryDomain: string;
  contactEmail: string;
  contactPhone: string;
  businessAddress: string;
  supportUrl: string;
  shippingPolicyUrl: string;
  returnPolicyUrl: string;
  refundPolicyUrl: string;
  privacyPolicyUrl: string;
  termsOfServiceUrl: string;
  logoUrl: string;
  socialProfiles: Array<{ platform: string; url: string }>;
  verificationStatus: BusinessVerificationStatus;
  verificationSource?: string | null;
  verificationEvidence?: Record<string, any> | null;
  lastVerifiedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface BusinessHubChecklistResult {
  checklistItems: Array<{
    id: string;
    category: 'identity' | 'contact' | 'policies' | 'catalog';
    title: string;
    status: 'ready' | 'missing' | 'action_required';
    dataOrigin?: 'merchant_self_declared' | 'measured_catalog_data' | 'independently_verified';
    currentValue?: string;
    requirementDescription: string;
  }>;
  overallReadinessScore: number; // 0-100
  checklistType: 'merchant_preparation_checklist';
  officialIntegrationConnected: false;
  limitationsNotice: string;
  exportableMerchantPackage: Record<string, any>;
}
