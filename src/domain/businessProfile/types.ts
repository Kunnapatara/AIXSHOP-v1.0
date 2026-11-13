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
  verificationStatus: 'unverified' | 'merchant_verified' | 'conflict_detected';
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
    currentValue?: string;
    requirementDescription: string;
  }>;
  overallReadinessScore: number; // 0-100
  exportableMerchantPackage: Record<string, any>;
}
