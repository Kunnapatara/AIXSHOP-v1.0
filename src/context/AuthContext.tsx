import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { apiClient, AuthUser, WorkspaceSummary } from '../api/client';

export type AuthModalMode = 'login' | 'register' | 'forgot' | 'reset';

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

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location && typeof window.location.search === 'string') {
      try {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('reset_token');
        if (token && token.trim()) {
          setPendingResetToken(token.trim());
          setAuthModalMode('reset');
          setAuthModalOpen(true);
        }
      } catch {
        // Ignore restricted URL environments
      }
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    async function checkSession() {
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
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    checkSession();
    return () => {
      isMounted = false;
    };
  }, []);

  const clearPendingResetToken = () => {
    setPendingResetToken(null);
    if (typeof window !== 'undefined' && window.location && typeof window.history?.replaceState === 'function') {
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('reset_token')) {
          url.searchParams.delete('reset_token');
          const nextSearch = url.searchParams.toString();
          const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash || ''}`;
          window.history.replaceState({}, typeof document !== 'undefined' ? document.title : '', nextUrl);
        }
      } catch {
        // Ignore invalid URL environments
      }
    }
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
