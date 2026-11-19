import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { X, Lock, Mail, User, Building, ArrowRight, AlertCircle, CheckCircle2, KeyRound } from 'lucide-react';

export const AuthModal: React.FC = () => {
  const {
    authModalOpen,
    authModalMode,
    pendingResetToken,
    closeAuthModal,
    openAuthModal,
    clearPendingResetToken,
    login,
    register,
    forgotPassword,
    resetPassword,
  } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetTokenInput, setResetTokenInput] = useState('');
  const [fullName, setFullName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (pendingResetToken) {
      setResetTokenInput(pendingResetToken);
    }
  }, [pendingResetToken]);

  if (!authModalOpen) return null;

  const switchMode = (nextMode: 'login' | 'register' | 'forgot' | 'reset', keepNotice = false) => {
    setError(null);
    if (!keepNotice) setNotice(null);
    openAuthModal(nextMode);
  };

  const handleClose = () => {
    setError(null);
    setNotice(null);
    clearPendingResetToken?.();
    closeAuthModal();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);

    try {
      if (authModalMode === 'login') {
        const res = await login(email, password);
        if (!res.success) {
          setError(res.error || 'Invalid credentials');
        }
      } else if (authModalMode === 'register') {
        if (password.length < 8) {
          setError('Password must be at least 8 characters long');
          return;
        }
        const res = await register({
          email,
          password,
          fullName,
          workspaceName: workspaceName || `${fullName.split(' ')[0]}'s Workspace`,
        });
        if (!res.success) {
          setError(res.error || 'Registration failed');
        }
      } else if (authModalMode === 'forgot') {
        if (!forgotPassword) {
          setError('Password reset service unavailable.');
          return;
        }
        const res = await forgotPassword(email);
        if (!res.success) {
          setError(res.error || 'Unable to process password reset request.');
        } else {
          setNotice(
            res.message ||
              'If an account with that email exists, password reset instructions have been sent.'
          );
        }
      } else if (authModalMode === 'reset') {
        if (!resetPassword) {
          setError('Password reset service unavailable.');
          return;
        }
        if (!resetTokenInput.trim()) {
          setError('Reset token is required.');
          return;
        }
        if (password.length < 8) {
          setError('New password must be at least 8 characters long');
          return;
        }
        if (password !== confirmPassword) {
          setError('Password confirmation does not match.');
          return;
        }
        const res = await resetPassword(resetTokenInput.trim(), password);
        if (!res.success) {
          setError(res.error || 'Password reset failed.');
        } else {
          setPassword('');
          setConfirmPassword('');
          setResetTokenInput('');
          setNotice(res.message || 'Password updated. Please sign in with your new password.');
          switchMode('login', true);
        }
      }
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const titleText =
    authModalMode === 'login'
      ? 'Sign In to Workspace'
      : authModalMode === 'register'
      ? 'Create Merchant Account'
      : authModalMode === 'forgot'
      ? 'Recover Workspace Access'
      : 'Set New Password';

  const subtitleText =
    authModalMode === 'login'
      ? 'Access your isolated multi-tenant cloud catalog'
      : authModalMode === 'register'
      ? 'Get started with isolated workspace and cloud storage'
      : authModalMode === 'forgot'
      ? 'Request a single-use password reset link'
      : 'Enter your recovery token and choose a new password';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/50 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-stone-200 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-stone-100 flex items-center justify-between bg-stone-50/70">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-orange-600 flex items-center justify-center text-white font-bold text-sm">
              AX
            </div>
            <div>
              <h2 className="text-base font-bold text-stone-900">{titleText}</h2>
              <p className="text-xs text-stone-500">{subtitleText}</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-lg transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Success Notice */}
        {notice && (
          <div className="mx-6 mt-4 p-3 bg-emerald-50 border border-emerald-200 rounded-xl flex items-start gap-2.5 text-xs text-emerald-900">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Account Recovery</p>
              <p className="mt-0.5">{notice}</p>
            </div>
          </div>
        )}

        {/* Error Alert */}
        {error && (
          <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-xl flex items-start gap-2.5 text-xs text-red-800">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Authentication Error</p>
              <p className="mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {authModalMode === 'register' && (
            <>
              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Full Name
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={e => setFullName(e.target.value)}
                    placeholder="Jane Merchant"
                    className="w-full pl-9 pr-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Workspace / Store Name
                </label>
                <div className="relative">
                  <Building className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    value={workspaceName}
                    onChange={e => setWorkspaceName(e.target.value)}
                    placeholder="Solstice Mercantile"
                    className="w-full pl-9 pr-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all"
                  />
                </div>
              </div>
            </>
          )}

          {(authModalMode === 'login' || authModalMode === 'register' || authModalMode === 'forgot') && (
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="merchant@example.com"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all"
                />
              </div>
            </div>
          )}

          {authModalMode === 'reset' && (
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Recovery Token
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  required
                  value={resetTokenInput}
                  onChange={e => setResetTokenInput(e.target.value)}
                  placeholder="Paste single-use recovery token"
                  className="w-full pl-9 pr-3 py-2 text-xs font-mono bg-stone-50 border border-stone-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all"
                />
              </div>
            </div>
          )}

          {(authModalMode === 'login' || authModalMode === 'register' || authModalMode === 'reset') && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-semibold text-stone-700">
                  {authModalMode === 'reset' ? 'New Password' : 'Password'}{' '}
                  {(authModalMode === 'register' || authModalMode === 'reset') && (
                    <span className="text-stone-400 font-normal">(min 8 characters)</span>
                  )}
                </label>
                {authModalMode === 'login' && (
                  <button
                    type="button"
                    onClick={() => switchMode('forgot')}
                    className="text-xs font-semibold text-orange-600 hover:text-orange-700"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <div className="relative">
                <Lock className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  required
                  minLength={authModalMode === 'register' || authModalMode === 'reset' ? 8 : undefined}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all"
                />
              </div>
            </div>
          )}

          {authModalMode === 'reset' && (
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Confirm New Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all"
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full mt-2 py-2.5 px-4 bg-orange-600 hover:bg-orange-700 text-white font-semibold text-sm rounded-xl shadow-xs transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {submitting ? (
              <span className="inline-block animate-spin mr-1">↻</span>
            ) : (
              <>
                <span>
                  {authModalMode === 'login'
                    ? 'Sign In'
                    : authModalMode === 'register'
                    ? 'Create Workspace Account'
                    : authModalMode === 'forgot'
                    ? 'Send Reset Link'
                    : 'Update Password'}
                </span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        {/* Footer / Toggle mode */}
        <div className="px-6 py-4 bg-stone-50 border-t border-stone-100 flex items-center justify-between text-xs text-stone-500">
          {authModalMode === 'forgot' || authModalMode === 'reset' ? (
            <>
              <button
                type="button"
                onClick={() => switchMode(authModalMode === 'forgot' ? 'reset' : 'forgot')}
                className="font-medium text-stone-600 hover:text-stone-900"
              >
                {authModalMode === 'forgot' ? 'Have a recovery token?' : 'Request a new link'}
              </button>
              <button
                type="button"
                onClick={() => switchMode('login')}
                className="font-semibold text-orange-600 hover:text-orange-700"
              >
                Back to Sign In
              </button>
            </>
          ) : (
            <>
              <span>
                {authModalMode === 'login'
                  ? "Don't have an account yet?"
                  : 'Already have a merchant account?'}
              </span>
              <button
                type="button"
                onClick={() => switchMode(authModalMode === 'login' ? 'register' : 'login')}
                className="font-semibold text-orange-600 hover:text-orange-700"
              >
                {authModalMode === 'login' ? 'Sign Up' : 'Sign In'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
