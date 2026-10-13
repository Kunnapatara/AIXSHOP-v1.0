import { 
  Product, 
  Variant, 
  Offer, 
  EvidenceDocument, 
  Finding, 
  ActionItem, 
  StoreProfile 
} from '../../types';

export interface StoragePayloadV1 {
  products: Product[];
  variants: Variant[];
  offers: Offer[];
  findings: Finding[];
  actions: ActionItem[];
  evidence: EvidenceDocument[];
  storeProfile: StoreProfile;
}

export interface StorageEnvelopeV1 {
  schemaVersion: 1;
  appVersion: string;
  timestamp: string; // ISO 8601
  tenantId: string;
  payload: StoragePayloadV1;
}

export type StorageLoadResult =
  | { type: 'valid'; envelope: StorageEnvelopeV1 }
  | { type: 'not_found' }
  | { 
      type: 'corrupt'; 
      error: string; 
      rawValue: string | null; 
      backupKey?: string;
      backupPreserved: boolean;
      primaryCleared: boolean;
    }
  | { type: 'unsupported_version'; foundVersion: number; rawEnvelope: unknown }
  | { type: 'storage_failure'; error: string; isRecoverable: boolean };

export type StorageSaveResult =
  | { success: true; timestamp: string; isDurable: boolean }
  | { success: false; error: string; isBlockedByReadOnly?: boolean; isQuotaExceeded?: boolean; isDurable?: boolean };

export interface StorageBackend {
  readonly isDurable: boolean;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key?(index: number): string | null;
  length?: number;
  clear?(): void;
}
