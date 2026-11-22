import { StoreProfile, StoreConnector } from '../../types';

export interface SettingsMutationResult {
  success: boolean;
  errorCode?: 'READ_ONLY_MODE' | 'CONNECTOR_NOT_FOUND' | 'INTEGRATION_UNAVAILABLE' | 'VALIDATION_FAILED' | 'PERSISTENCE_FAILED';
  message: string;
  nextProfile?: StoreProfile;
}

export interface ConnectorSyncExecutionOptions {
  /**
   * If a real, verified external synchronization operation was executed,
   * its verified payload can be passed to apply the resulting verified state.
   */
  verifiedResult?: {
    syncedCount: number;
    timestamp: string;
    writeBackAuthorized?: boolean;
  };
}

/**
 * Validates and produces updated StoreProfile without prematurely mutating inputs.
 */
export function validateAndApplyProfileUpdate(
  currentProfile: StoreProfile,
  updates: Partial<StoreProfile>,
  isReadOnly: boolean
): SettingsMutationResult {
  if (isReadOnly) {
    return {
      success: false,
      errorCode: 'READ_ONLY_MODE',
      message: 'Store settings cannot be changed while read-only mode is active.',
    };
  }

  if (updates.name !== undefined && updates.name.trim() === '') {
    return {
      success: false,
      errorCode: 'VALIDATION_FAILED',
      message: 'Store name cannot be empty.',
    };
  }

  let nextDomain = currentProfile.domain;
  if (updates.domain !== undefined) {
    const rawDomain = updates.domain.trim();
    if (rawDomain === '') {
      nextDomain = '';
    } else {
      const withScheme = /^https?:\/\//i.test(rawDomain) ? rawDomain : `https://${rawDomain}`;
      try {
        const parsed = new URL(withScheme);
        const host = parsed.hostname.toLowerCase();
        if (!host || (!host.includes('.') && host !== 'localhost')) {
          return {
            success: false,
            errorCode: 'VALIDATION_FAILED',
            message: 'Please enter a valid website domain (e.g., store.com or https://store.com).',
          };
        }
        nextDomain = rawDomain;
      } catch {
        return {
          success: false,
          errorCode: 'VALIDATION_FAILED',
          message: 'Please enter a valid website domain (e.g., store.com or https://store.com).',
        };
      }
    }
  }

  const nextProfile: StoreProfile = {
    ...currentProfile,
    ...updates,
    name: updates.name !== undefined ? updates.name.trim() : currentProfile.name,
    domain: nextDomain,
    websiteUrl: updates.websiteUrl !== undefined ? updates.websiteUrl.trim() : nextDomain,
  };

  return {
    success: true,
    message: 'Store profile validated successfully.',
    nextProfile,
  };
}

/**
 * Applies honest connector state transition.
 * 
 * Rules:
 * 1. Read-only mode strictly blocks any modification.
 * 2. If connector is not found, returns CONNECTOR_NOT_FOUND error.
 * 3. Never transitions to 'connected' or updates lastSync/productCount/writeBack unless
 *    a real, verified integration succeeds. Since no live external connector integration exists,
 *    attempting to connect returns INTEGRATION_UNAVAILABLE without mutating state.
 * 4. Disconnecting a currently connected connector is permitted as a safe local state transition,
 *    setting status to 'disconnected' and writeBackAuthorized to false.
 */
export function applyConnectorToggle(
  currentProfile: StoreProfile,
  connectorId: string,
  isReadOnly: boolean = false,
  syncOptions?: ConnectorSyncExecutionOptions
): SettingsMutationResult {
  if (isReadOnly) {
    return {
      success: false,
      errorCode: 'READ_ONLY_MODE',
      message: 'Connectors cannot be modified while read-only mode is active.',
    };
  }

  const connector = currentProfile.connectors.find(c => c.id === connectorId);
  if (!connector) {
    return {
      success: false,
      errorCode: 'CONNECTOR_NOT_FOUND',
      message: `Connector "${connectorId}" was not found.`,
    };
  }

  // If connector is disconnected or not_configured, connecting requires live OAuth / API integration
  if (connector.status === 'disconnected' || connector.status === 'not_configured') {
    // Check if a real verified result was supplied by an actual integration
    if (!syncOptions?.verifiedResult) {
      return {
        success: false,
        errorCode: 'INTEGRATION_UNAVAILABLE',
        message: `Live integration for "${connector.name}" is not configured in this environment. External OAuth and synchronization APIs are unavailable.`,
        nextProfile: currentProfile,
      };
    }

    const { syncedCount, timestamp, writeBackAuthorized } = syncOptions.verifiedResult;
    const nextConnectors = currentProfile.connectors.map(c => {
      if (c.id === connectorId) {
        return {
          ...c,
          status: 'connected' as const,
          lastSync: timestamp,
          productCountSynced: syncedCount,
          writeBackAuthorized: writeBackAuthorized ?? c.writeBackAuthorized,
        };
      }
      return c;
    });

    return {
      success: true,
      message: `Connector "${connector.name}" connected and synchronized.`,
      nextProfile: {
        ...currentProfile,
        connectors: nextConnectors,
      },
    };
  }

  // If connected or read_only, safely disconnect it
  const nextConnectors = currentProfile.connectors.map(c => {
    if (c.id === connectorId) {
      return {
        ...c,
        status: 'disconnected' as const,
        writeBackAuthorized: false,
      };
    }
    return c;
  });

  const nextProfile: StoreProfile = {
    ...currentProfile,
    connectors: nextConnectors,
  };

  return {
    success: true,
    message: `Connector "${connector.name}" has been disconnected.`,
    nextProfile,
  };
}
