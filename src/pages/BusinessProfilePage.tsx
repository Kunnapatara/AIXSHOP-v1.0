import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../api/client';
import { WorkspaceBusinessProfile } from '../domain/businessProfile/types';
import { Save, Building2, AlertCircle, CheckCircle2, Globe } from 'lucide-react';

export const BusinessProfilePage: React.FC = () => {
  const { addToast } = useApp();
  const { isAuthenticated, openAuthModal } = useAuth();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Partial<WorkspaceBusinessProfile>>({
    legalBusinessName: '',
    publicBrandName: '',
    brandDescription: '',
    officialWebsite: '',
    primaryDomain: '',
    contactEmail: '',
    contactPhone: '',
    businessAddress: '',
    supportUrl: '',
    shippingPolicyUrl: '',
    returnPolicyUrl: '',
    refundPolicyUrl: '',
    privacyPolicyUrl: '',
    termsOfServiceUrl: '',
    logoUrl: '',
    verificationStatus: 'unverified',
  });

  useEffect(() => {
    if (!isAuthenticated) return;
    let active = true;
    setLoading(true);
    apiClient
      .getBusinessProfile()
      .then((res) => {
        if (active && res.profile) {
          setProfile(res.profile);
        }
      })
      .catch((err) => {
        if (active) setError(err.message || 'Failed to load business profile');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isAuthenticated]);

  const handleChange = (field: keyof WorkspaceBusinessProfile, value: string) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated) {
      openAuthModal('login');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiClient.updateBusinessProfile(profile);
      setProfile(res.profile);
      addToast('Business Profile Saved', 'Merchant brand and policy metadata persisted to workspace.', 'success');
    } catch (err: any) {
      setError(err.message || 'Failed to save business profile');
      addToast('Save Failed', err.message || 'Could not update business profile.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-200">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-950">
            Brand & Business Profile
          </h1>
          <p className="text-xs text-stone-500 mt-1">
            Authoritative merchant identity, customer service contacts, and public policy URLs required for AI Commerce Business Hubs.
          </p>
        </div>
      </div>

      {!isAuthenticated && (
        <div className="p-5 bg-amber-50 border border-amber-200 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-amber-950">Workspace Sign-In Required</h2>
            <p className="text-xs text-amber-800">
              Sign in to persist your legal business entity details and verification URLs to PostgreSQL.
            </p>
          </div>
          <button
            onClick={() => openAuthModal('login')}
            className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            Sign In to Edit
          </button>
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="h-96 bg-white border border-stone-200 rounded-xl animate-pulse" />
      ) : (
        <form onSubmit={handleSubmit} className="bg-white border border-stone-200 rounded-xl p-6 space-y-8">
          {/* Identity */}
          <section className="space-y-4">
            <h2 className="text-sm font-bold text-stone-900 pb-2 border-b border-stone-100">
              01. Legal & Public Brand Identity
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-stone-800 mb-1">Legal Business Entity Name</label>
                <input
                  type="text"
                  value={profile.legalBusinessName || ''}
                  onChange={(e) => handleChange('legalBusinessName', e.target.value)}
                  placeholder="e.g. Solstice Mercantile LLC"
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg text-xs text-stone-900"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-stone-800 mb-1">Public Brand Name</label>
                <input
                  type="text"
                  value={profile.publicBrandName || ''}
                  onChange={(e) => handleChange('publicBrandName', e.target.value)}
                  placeholder="e.g. Solstice Mercantile"
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg text-xs text-stone-900"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-stone-800 mb-1">Official Website (HTTPS)</label>
                <input
                  type="url"
                  value={profile.officialWebsite || ''}
                  onChange={(e) => handleChange('officialWebsite', e.target.value)}
                  placeholder="https://example.com"
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg text-xs font-mono text-stone-900"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-stone-800 mb-1">Primary Canonical Domain</label>
                <input
                  type="text"
                  value={profile.primaryDomain || ''}
                  onChange={(e) => handleChange('primaryDomain', e.target.value)}
                  placeholder="example.com"
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg text-xs font-mono text-stone-900"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-stone-800 mb-1">Brand Description</label>
              <textarea
                rows={3}
                value={profile.brandDescription || ''}
                onChange={(e) => handleChange('brandDescription', e.target.value)}
                placeholder="Factual overview of catalog focus, manufacturing standards, and merchant location..."
                className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg text-xs text-stone-900"
              />
            </div>
          </section>

          {/* Contact */}
          <section className="space-y-4">
            <h2 className="text-sm font-bold text-stone-900 pb-2 border-b border-stone-100">
              02. Merchant Support & Contact Channels
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-stone-800 mb-1">Business Contact Email</label>
                <input
                  type="email"
                  value={profile.contactEmail || ''}
                  onChange={(e) => handleChange('contactEmail', e.target.value)}
                  placeholder="support@example.com"
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg text-xs font-mono text-stone-900"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-stone-800 mb-1">Support Telephone</label>
                <input
                  type="text"
                  value={profile.contactPhone || ''}
                  onChange={(e) => handleChange('contactPhone', e.target.value)}
                  placeholder="+1 (555) 010-2000"
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg text-xs font-mono text-stone-900"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-stone-800 mb-1">Registered Business Address</label>
                <input
                  type="text"
                  value={profile.businessAddress || ''}
                  onChange={(e) => handleChange('businessAddress', e.target.value)}
                  placeholder="Street, City, Postal Code, Country"
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg text-xs text-stone-900"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-stone-800 mb-1">Customer Support Help Center URL</label>
                <input
                  type="url"
                  value={profile.supportUrl || ''}
                  onChange={(e) => handleChange('supportUrl', e.target.value)}
                  placeholder="https://example.com/support"
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg text-xs font-mono text-stone-900"
                />
              </div>
            </div>
          </section>

          {/* Policy URLs */}
          <section className="space-y-4">
            <h2 className="text-sm font-bold text-stone-900 pb-2 border-b border-stone-100">
              03. Public Commerce Policy URLs
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-stone-800 mb-1">Privacy Policy URL</label>
                <input
                  type="url"
                  value={profile.privacyPolicyUrl || ''}
                  onChange={(e) => handleChange('privacyPolicyUrl', e.target.value)}
                  placeholder="https://example.com/policies/privacy-policy"
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg text-xs font-mono text-stone-900"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-stone-800 mb-1">Terms of Service URL</label>
                <input
                  type="url"
                  value={profile.termsOfServiceUrl || ''}
                  onChange={(e) => handleChange('termsOfServiceUrl', e.target.value)}
                  placeholder="https://example.com/policies/terms-of-service"
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg text-xs font-mono text-stone-900"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-stone-800 mb-1">Shipping Policy URL</label>
                <input
                  type="url"
                  value={profile.shippingPolicyUrl || ''}
                  onChange={(e) => handleChange('shippingPolicyUrl', e.target.value)}
                  placeholder="https://example.com/policies/shipping-policy"
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg text-xs font-mono text-stone-900"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-stone-800 mb-1">Return & Refund Policy URL</label>
                <input
                  type="url"
                  value={profile.returnPolicyUrl || ''}
                  onChange={(e) => handleChange('returnPolicyUrl', e.target.value)}
                  placeholder="https://example.com/policies/refund-policy"
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg text-xs font-mono text-stone-900"
                />
              </div>
            </div>
          </section>

          <div className="pt-4 border-t border-stone-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <label className="text-xs font-semibold text-stone-700">Verification Status:</label>
              <select
                value={profile.verificationStatus || 'unverified'}
                onChange={(e) => handleChange('verificationStatus', e.target.value)}
                className="px-3 py-1.5 bg-stone-50 border border-stone-300 rounded-lg text-xs font-medium text-stone-900"
              >
                <option value="unverified">Unverified</option>
                <option value="merchant_verified">Merchant Verified</option>
                <option value="conflict_detected">Conflict Detected</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={saving || !isAuthenticated}
              className="px-5 py-2.5 bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{saving ? 'Saving...' : 'Save Business Profile'}</span>
            </button>
          </div>
        </form>
      )}
    </div>
  );
};
