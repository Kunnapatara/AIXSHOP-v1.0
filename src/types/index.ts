export type NavigationPage = 
  | 'landing' 
  | 'home' 
  | 'audit' 
  | 'products' 
  | 'product-detail' 
  | 'actions' 
  | 'settings';

export type PrimaryMerchantPage = 'home' | 'audit' | 'products' | 'actions';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';
export type FindingScope = 'store' | 'catalog' | 'product';
export type FindingType = 
  | 'missing_information' 
  | 'inconsistent_attributes' 
  | 'conflicting_claims' 
  | 'unverified_evidence';

export interface Variant {
  id: string;
  sku: string;
  title: string;
  barcode: string; // GTIN / EAN / UPC
  price: number;
  inventoryCount: number;
  attributes: Record<string, string>;
}

export interface Offer {
  id: string;
  channel: 'Direct Storefront' | 'Google Shopping Feed' | 'B2B Wholesale' | 'Marketplace';
  price: number;
  currency: string;
  availability: 'in_stock' | 'out_of_stock' | 'preorder';
  condition: 'new' | 'refurbished';
  url: string;
  merchantId: string;
  lastSync: string;
}

export interface EvidenceDocument {
  id: string;
  title: string;
  type: 'lab_report' | 'manufacturer_spec' | 'organic_certificate' | 'fair_trade_doc' | 'fda_label';
  issuer: string;
  dateVerified: string;
  url?: string;
  status: 'verified' | 'unverified' | 'expired';
}

export interface Product {
  id: string;
  title: string;
  brand: string;
  category: string;
  description: string;
  image: string;
  status: 'active' | 'draft' | 'archived';
  completenessScore: number; // 0-100 catalog completeness
  evidenceCoverageScore: number; // 0-100 evidence-backed specifications
  externalDiscoveryStatus: 'observed_in_sample' | 'unindexed' | 'insufficient_evidence';
  attributes: Record<string, string>;
  variants: Variant[];
  offers: Offer[];
  evidenceDocuments: EvidenceDocument[];
  findingsCount: number;
  lastAudited: string;
}

export interface Finding {
  id: string;
  scope: FindingScope;
  productId?: string;
  productTitle?: string;
  type: FindingType;
  severity: FindingSeverity;
  title: string;
  description: string;
  observedEvidence: string;
  derivedConclusion: string;
  merchantVerified: boolean;
  whyItMatters: string;
  suggestedCorrection?: string;
  targetField?: string;
  currentValue?: string;
  recommendedValue?: string;
  actionItemId?: string;
}

export type ActionStatus = 'pending_review' | 'approved' | 'applied_externally' | 'dismissed';
export type VerificationStatus = 'unverified' | 'recheck_required' | 'verified_in_catalog' | 'verification_failed';

export interface ActionItem {
  id: string;
  findingId: string;
  productId?: string;
  productTitle?: string;
  title: string;
  severity: FindingSeverity;
  status: ActionStatus;
  evidenceRequired: boolean;
  evidenceProvided?: string;
  proposedChange: {
    field: string;
    from: string;
    to: string;
  };
  verificationStatus: VerificationStatus;
  recheckNotes?: string;
  lastRecheckTimestamp?: string;
  approvedAt?: string;
  dismissedAt?: string;
}

export interface StoreConnector {
  id: string;
  name: string;
  type: 'shopify' | 'google_merchant' | 'meta_catalog' | 'custom_erp';
  status: 'connected' | 'disconnected' | 'read_only' | 'error';
  lastSync: string;
  productCountSynced: number;
  writeBackAuthorized: boolean;
}

export interface StoreProfile {
  name: string;
  domain: string;
  platform: string;
  skuCount: number;
  skuLimit: number;
  tier: string;
  lastAuditDate: string;
  currency: string;
  connectors: StoreConnector[];
  catalogCompletenessAvg: number;
  evidenceCoverageAvg: number;
  truthBoundaryStrictness: 'strict' | 'standard' | 'relaxed';
  catalogPolicy?: {
    units?: string;
    [key: string]: unknown;
  };
  shippingSla?: Record<string, string>;
}

export interface QuickHealthCheckResult {
  url: string;
  timestamp: string;
  catalogCompletenessEstimate: number;
  schemaFound: boolean;
  gtinPresentRatio: number;
  conflictingClaimsCount: number;
  missingAttributesCount: number;
  detectedPlatform: string;
  sampleIssues: string[];
  scanStatus?: 'real_scan' | 'partial_scan' | 'unsupported_store' | 'network_failure' | 'demo_fixture';
  notice?: string;
  ingestionResult?: StoreIngestionResult;
}

export type CandidateEligibilityStatus = 'eligible' | 'duplicate' | 'conflict' | 'rejected';

export interface CandidateProductStatus {
  productId: string;
  sourceId: string;
  title: string;
  brand: string;
  category: string;
  status: CandidateEligibilityStatus;
  reasons: string[];
  product?: Product;
}

export interface StoreIngestionResult {
  healthCheck: QuickHealthCheckResult;
  candidateProducts: Product[];
  evaluationDetails: CandidateProductStatus[];
  source: {
    platform: string;
    origin: string;
    endpoint: string;
    timestamp: string;
    isPartialSample: boolean;
    sampleLimit: number;
    discoveredCount: number;
    parsedCount: number;
  };
  warnings: string[];
}

export interface CatalogImportResult {
  success: boolean;
  importedCount: number;
  skippedCount: number;
  rejectedCount: number;
  conflictCount: number;
  message: string;
  importedProducts: Product[];
  nextProducts: Product[];
  nextStoreProfile: StoreProfile;
  details: CandidateProductStatus[];
}

