export type CloudCatalogLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

export const DEMO_OVERWRITE_COLLECTIONS = [
  'products',
  'variants',
  'offers',
  'findings',
  'actions',
  'evidence',
] as const;

export interface DemoOverwriteProtectionInput {
  isCloudWorkspace: boolean;
  cloudCatalogStatus: CloudCatalogLoadStatus;
  catalogVersion?: number;
  productsCount: number;
  variantsCount: number;
  offersCount: number;
  findingsCount: number;
  actionsCount: number;
  evidenceCount: number;
}

export interface DemoOverwriteCategoryCount {
  key: (typeof DEMO_OVERWRITE_COLLECTIONS)[number];
  label: string;
  count: number;
}

export interface DemoOverwriteProtectionEvaluation {
  requiresConfirmation: boolean;
  isUnknownState: boolean;
  isInitializedCatalog: boolean;
  hasExistingCatalogData: boolean;
  totalExistingEntities: number;
  nonEmptyCategories: DemoOverwriteCategoryCount[];
  replacedCollections: readonly (typeof DEMO_OVERWRITE_COLLECTIONS)[number][];
}

export function evaluateDemoOverwriteProtection(
  input: DemoOverwriteProtectionInput
): DemoOverwriteProtectionEvaluation {
  const counts: DemoOverwriteCategoryCount[] = [
    { key: 'products', label: 'products', count: Math.max(0, Number(input.productsCount) || 0) },
    { key: 'variants', label: 'variants', count: Math.max(0, Number(input.variantsCount) || 0) },
    { key: 'offers', label: 'commercial offers', count: Math.max(0, Number(input.offersCount) || 0) },
    { key: 'findings', label: 'audit findings', count: Math.max(0, Number(input.findingsCount) || 0) },
    { key: 'actions', label: 'remediation actions', count: Math.max(0, Number(input.actionsCount) || 0) },
    { key: 'evidence', label: 'evidence documents', count: Math.max(0, Number(input.evidenceCount) || 0) },
  ];

  const nonEmptyCategories = counts.filter(c => c.count > 0);
  const totalExistingEntities = counts.reduce((sum, c) => sum + c.count, 0);
  const hasExistingCatalogData = totalExistingEntities > 0;
  const isInitializedCatalog =
    typeof input.catalogVersion === 'number' && input.catalogVersion > 1;
  const isUnknownState =
    input.isCloudWorkspace && input.cloudCatalogStatus !== 'loaded';

  const requiresConfirmation =
    input.isCloudWorkspace &&
    (isUnknownState || hasExistingCatalogData || isInitializedCatalog);

  return {
    requiresConfirmation,
    isUnknownState,
    isInitializedCatalog,
    hasExistingCatalogData,
    totalExistingEntities,
    nonEmptyCategories,
    replacedCollections: DEMO_OVERWRITE_COLLECTIONS,
  };
}
