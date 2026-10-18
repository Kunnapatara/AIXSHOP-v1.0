import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { apiClient, AuthUser, WorkspaceSummary } from '../api/client';

interface AuthContextType {
  user: AuthUser | null;
  activeWorkspace: WorkspaceSummary | null;
  workspaces: WorkspaceSummary[];
  isAuthenticated: boolean;
  isLoading: boolean;
  authModalOpen: boolean;
  authModalMode: 'login' | 'register';
  openAuthModal: (mode?: 'login' | 'register') => void;
  closeAuthModal: () => void;
  login: (email: string, pass: string) => Promise<{ success: boolean; error?: string }>;
  register: (data: { email: string; password: string; fullName: string; workspaceName: string }) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  switchWorkspace: (workspaceId: string) => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceSummary | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [authModalMode, setAuthModalMode] = useState<'login' | 'register'>('login');

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

  const openAuthModal = (mode: 'login' | 'register' = 'login') => {
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
        openAuthModal,
        closeAuthModal,
        login,
        register,
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
