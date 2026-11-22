export type NavigationPage = 
  | 'landing' 
  | 'home' 
  | 'audit' 
  | 'products' 
  | 'product-detail' 
  | 'actions' 
  | 'ai-discovery'
  | 'feed-readiness'
  | 'business-profile'
  | 'ai-visibility'
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
  price: number | null;
  inventoryCount?: number | null; // null or undefined indicates unknown/unavailable from source
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

export type EvidenceStatus = 'pending' | 'unverified' | 'verified' | 'rejected' | 'expired';
export type EvidencePurpose = 'gtin_exemption' | 'product_claim' | 'general';
export type EvidenceVerificationSource = 'client_submission' | 'server_reviewer' | 'external_registry';
export type EvidenceReviewDecision = 'pending' | 'approved' | 'rejected';

export interface EvidenceDocument {
  id: string;
  title: string;
  type: 'lab_report' | 'manufacturer_spec' | 'organic_certificate' | 'fair_trade_doc' | 'fda_label' | 'gtin_exemption_proof';
  issuer: string;
  dateVerified: string;
  url?: string;
  status: EvidenceStatus;
  evidencePurpose?: EvidencePurpose;
  verificationSource?: EvidenceVerificationSource;
  verifiedBy?: string;
  reviewedAt?: string;
  decision?: EvidenceReviewDecision;
  decisionReason?: string;
  integrityHash?: string;
  submittedByUserId?: string;
  createdAt?: string;
}

export interface EvidenceReviewAuditEntry {
  id: string;
  workspaceId: string;
  evidenceId: string;
  productId: string;
  action: 'submitted' | 'approved' | 'rejected';
  decision: EvidenceReviewDecision;
  reviewerId?: string | null;
  reviewerRole?: string | null;
  reason?: string | null;
  integrityHash: string;
  metadata?: Record<string, any>;
  createdAt: string;
}

export interface ShopifyProductProvenanceRecord {
  workspaceId: string;
  productId: string;
  shopDomain: string;
  shopifyProductId: string;
  shopifyGid: string;
  isGiftCard: boolean;
  sourceType: 'shopify_graphql_admin_api' | 'shopify_webhook';
  shopifyUpdatedAt?: string | null;
  verifiedAt: string;
  createdAt?: string;
  updatedAt?: string;
}

export type StoreSourceClassification =
  | 'shopify_oauth'
  | 'public_feed'
  | 'manual_import'
  | 'demo'
  | 'unconfigured';

export type ProductSourceClassification =
  | 'shopify_oauth'
  | 'public_feed'
  | 'manual_import'
  | 'demo';

export type CatalogAcquisitionMethod =
  | 'shopify_admin_graphql'
  | 'shopify_webhook'
  | 'public_products_json_sample'
  | 'manual_import'
  | 'demo_fixture';

export interface CatalogSourceMetadata {
  classification: StoreSourceClassification;
  origin?: string;
  acquisitionMethod?: CatalogAcquisitionMethod | 'none';
  shopDomain?: string;
  importedAt?: string;
  isPartialSample?: boolean;
  sampleLimit?: number;
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
  sourceClassification?: ProductSourceClassification;
  sourceOrigin?: string;
  acquisitionMethod?: CatalogAcquisitionMethod;
  attributes: Record<string, string>;
  variants: Variant[];
  offers: Offer[];
  evidenceDocuments: EvidenceDocument[];
  findingsCount: number;
  lastAudited: string;
}

export type GtinEligibilityStatus =
  | 'gtin_present'
  | 'verified_exempt'
  | 'declared_identifier_absence'
  | 'insufficient_evidence';

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
  ruleCode?: string;
  needsMerchantInput?: boolean;
  reviewStatus?: 'NEEDS_REVIEW';
  gtinEligibilityStatus?: GtinEligibilityStatus;
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
  needsMerchantInput?: boolean;
  recheckNotes?: string;
  lastRecheckTimestamp?: string;
  approvedAt?: string;
  dismissedAt?: string;
  auditLog?: any[];
}

export interface StoreConnector {
  id: string;
  name: string;
  type: 'shopify' | 'google_merchant' | 'meta_catalog' | 'custom_erp';
  status: 'connected' | 'disconnected' | 'read_only' | 'error' | 'not_configured';
  lastSync: string;
  productCountSynced: number;
  syncedSkuCount?: number;
  readOnly?: boolean;
  writeBackAuthorized: boolean;
  missingReason?: string;
}

export interface StoreProfile {
  name: string;
  domain: string;
  websiteUrl?: string;
  platform?: string;
  sourceClassification?: StoreSourceClassification;
  sourceMetadata?: CatalogSourceMetadata;
  shopifyConnected?: boolean;
  shopifyShopDomain?: string;
  skuCount: number;
  skuLimit?: number;
  tier: string;
  lastAuditDate?: string;
  currency: string;
  connectors: StoreConnector[];
  catalogCompletenessAvg: number;
  evidenceCoverageAvg?: number;
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
    classification?: StoreSourceClassification;
    acquisitionMethod?: CatalogAcquisitionMethod | 'none';
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

export type ProductCandidate = Product;


