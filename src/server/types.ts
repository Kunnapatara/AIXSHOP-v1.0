import { Request } from 'express';
import { 
  Product, 
  Variant, 
  Offer, 
  EvidenceDocument, 
  Finding, 
  ActionItem, 
  StoreProfile 
} from '../types';
import { StoragePayloadV1 } from '../domain/storage/storageTypes';

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMembershipRecord {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  sessionTokenHash: string;
  userId: string;
  activeWorkspaceId: string;
  expiresAt: string;
  createdAt: string;
  lastActiveAt: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface StoreRecord {
  id: string;
  workspaceId: string;
  name: string;
  domain: string;
  currency: string;
  skuCount: number;
  skuLimit?: number | null;
  catalogCompletenessAvg: number;
  truthBoundaryStrictness: 'conservative' | 'balanced' | 'permissive';
  tier: 'Free Audit' | 'Growth' | 'Enterprise';
  connectorsJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
}

export interface AuthenticatedWorkspace {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
}

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
  workspace?: AuthenticatedWorkspace;
  sessionId?: string;
}
