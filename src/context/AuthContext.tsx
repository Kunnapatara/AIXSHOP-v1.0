import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { apiClient, AuthUser, WorkspaceSummary } from '../api/client';

export type AuthModalMode = 'login' | 'register' | 'forgot' | 'reset';

const SESSION_PRESENCE_COOKIE_NAME = 'aixshop_has_session';

export function readSessionPresenceMarker(cookieSource?: string): '1' | '0' | 'missing' {
  const rawCookie =
    typeof cookieSource === 'string'
      ? cookieSource
      : typeof document !== 'undefined' && typeof document.cookie === 'string'
      ? document.cookie
      : '';

  if (!rawCookie) return 'missing';

  const parts = rawCookie.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const name = trimmed.slice(0, eqIndex).trim();
    if (name !== SESSION_PRESENCE_COOKIE_NAME) continue;
    let value = trimmed.slice(eqIndex + 1).trim();
    try {
      value = decodeURIComponent(value).trim();
    } catch {
      // Keep raw value if malformed
    }
    if (value === '1') return '1';
    if (value === '0') return '0';
    return 'missing';
  }

  return 'missing';
}

interface AuthContextType {
  user: AuthUser | null;
  activeWorkspace: WorkspaceSummary | null;
  workspaces: WorkspaceSummary[];
  isAuthenticated: boolean;
  isLoading: boolean;
  authModalOpen: boolean;
  authModalMode: AuthModalMode;
  pendingResetToken?: string | null;
  openAuthModal: (mode?: AuthModalMode) => void;
  closeAuthModal: () => void;
  clearPendingResetToken?: () => void;
  login: (email: string, pass: string) => Promise<{ success: boolean; error?: string }>;
  register: (data: { email: string; password: string; fullName: string; workspaceName: string }) => Promise<{ success: boolean; error?: string }>;
  forgotPassword?: (email: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  resetPassword?: (token: string, newPassword: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  logout: () => Promise<void>;
  switchWorkspace: (workspaceId: string) => Promise<boolean>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceSummary | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [authModalMode, setAuthModalMode] = useState<AuthModalMode>('login');
  const [pendingResetToken, setPendingResetToken] = useState<string | null>(null);
  const userRef = useRef<AuthUser | null>(null);
  const syncInFlightRef = useRef<boolean>(false);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const stripResetTokenFromUrl = () => {
    if (typeof window !== 'undefined' && window.location && typeof window.history?.replaceState === 'function') {
      try {
        const url = new URL(window.location.href);
        let modified = false;
        if (url.searchParams.has('reset_token')) {
          url.searchParams.delete('reset_token');
          modified = true;
        }
        if (url.hash && url.hash.includes('reset_token=')) {
          const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
          if (hashParams.has('reset_token')) {
            hashParams.delete('reset_token');
            const remainingHash = hashParams.toString();
            url.hash = remainingHash ? `#${remainingHash}` : '';
            modified = true;
          }
        }
        if (modified) {
          const nextSearch = url.searchParams.toString();
          const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash || ''}`;
          window.history.replaceState({}, typeof document !== 'undefined' ? document.title : '', nextUrl);
        }
      } catch {
        // Ignore invalid URL environments
      }
    }
  };

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location) {
      try {
        let token: string | null = null;
        if (typeof window.location.hash === 'string' && window.location.hash.length > 1) {
          const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
          token = hashParams.get('reset_token');
        }
        if (!token && typeof window.location.search === 'string' && window.location.search.length > 1) {
          const searchParams = new URLSearchParams(window.location.search);
          token = searchParams.get('reset_token');
        }
        if (token && token.trim()) {
          setPendingResetToken(token.trim());
          setAuthModalMode('reset');
          setAuthModalOpen(true);
          stripResetTokenFromUrl();
        }
      } catch {
        // Ignore restricted URL environments
      }
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function verifyServerSession() {
      if (syncInFlightRef.current) return;
      syncInFlightRef.current = true;
      try {
        const session = await apiClient.getSession();
        if (isMounted) {
          if (session) {
            setUser(session.user);
            setActiveWorkspace(session.workspace);
            setWorkspaces(session.workspaces || [session.workspace]);
          } else {
            setUser(null);
            setActiveWorkspace(null);
            setWorkspaces([]);
          }
        }
      } catch (err) {
        console.warn('[AIXSHOP Auth] Session check encountered error:', err);
      } finally {
        syncInFlightRef.current = false;
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    const initialMarker = readSessionPresenceMarker();
    if (initialMarker === '0') {
      setUser(null);
      setActiveWorkspace(null);
      setWorkspaces([]);
      setIsLoading(false);
    } else {
      void verifyServerSession();
    }

    const syncAcrossTabs = () => {
      if (!isMounted || syncInFlightRef.current) return;
      const marker = readSessionPresenceMarker();
      if (marker === '0') {
        if (userRef.current !== null) {
          setUser(null);
          setActiveWorkspace(null);
          setWorkspaces([]);
        }
        return;
      }
      if (marker === '1') {
        void verifyServerSession();
      }
    };

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        syncAcrossTabs();
      }
    };

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('focus', syncAcrossTabs);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      isMounted = false;
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('focus', syncAcrossTabs);
      }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, []);

  const clearPendingResetToken = () => {
    setPendingResetToken(null);
    stripResetTokenFromUrl();
  };

  const openAuthModal = (mode: AuthModalMode = 'login') => {
    setAuthModalMode(mode);
    setAuthModalOpen(true);
  };

  const closeAuthModal = () => {
    setAuthModalOpen(false);
  };

  const login = async (email: string, pass: string) => {
    try {
      const res = await apiClient.login({ email, password: pass });
      setUser(res.user);
      setActiveWorkspace(res.workspace);
      setWorkspaces(res.workspaces || [res.workspace]);
      closeAuthModal();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Login failed' };
    }
  };

  const register = async (data: { email: string; password: string; fullName: string; workspaceName: string }) => {
    try {
      const res = await apiClient.register(data);
      setUser(res.user);
      setActiveWorkspace(res.workspace);
      setWorkspaces(res.workspaces || [res.workspace]);
      closeAuthModal();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Registration failed' };
    }
  };

  const forgotPassword = async (email: string) => {
    try {
      const res = await apiClient.forgotPassword(email);
      return { success: true, message: res.message };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unable to process password reset request' };
    }
  };

  const resetPassword = async (token: string, newPassword: string) => {
    try {
      const res = await apiClient.resetPassword(token, newPassword);
      setUser(null);
      setActiveWorkspace(null);
      setWorkspaces([]);
      clearPendingResetToken();
      return { success: true, message: res.message };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unable to reset password' };
    }
  };

  const logout = async () => {
    try {
      await apiClient.logout();
    } finally {
      setUser(null);
      setActiveWorkspace(null);
      setWorkspaces([]);
    }
  };

  const switchWorkspace = async (workspaceId: string): Promise<boolean> => {
    try {
      const res = await apiClient.switchWorkspace(workspaceId);
      if (res.success) {
        setActiveWorkspace(res.workspace);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        activeWorkspace,
        workspaces,
        isAuthenticated: !!user,
        isLoading,
        authModalOpen,
        authModalMode,
        pendingResetToken,
        openAuthModal,
        closeAuthModal,
        clearPendingResetToken,
        login,
        register,
        forgotPassword,
        resetPassword,
        logout,
        switchWorkspace,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
