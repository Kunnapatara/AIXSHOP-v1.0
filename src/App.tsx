/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AuthProvider } from './context/AuthContext';
import { AppProvider, useApp } from './context/AppContext';
import { AppShell } from './components/layout/AppShell';
import { AuthModal } from './components/auth/AuthModal';
import { LandingPage } from './pages/LandingPage';
import { HomePage } from './pages/HomePage';
import { AuditPage } from './pages/AuditPage';
import { ProductsPage } from './pages/ProductsPage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { ActionsPage } from './pages/ActionsPage';
import { SettingsPage } from './pages/SettingsPage';
import { AiDiscoveryPage } from './pages/AiDiscoveryPage';
import { FeedReadinessPage } from './pages/FeedReadinessPage';
import { BusinessProfilePage } from './pages/BusinessProfilePage';
import { AiVisibilityPage } from './pages/AiVisibilityPage';

const AppContent: React.FC = () => {
  const { currentPage } = useApp();

  const renderCurrentPage = () => {
    switch (currentPage) {
      case 'landing':
        return <LandingPage />;
      case 'home':
        return <HomePage />;
      case 'audit':
        return <AuditPage />;
      case 'products':
        return <ProductsPage />;
      case 'product-detail':
        return <ProductDetailPage />;
      case 'actions':
        return <ActionsPage />;
      case 'ai-discovery':
        return <AiDiscoveryPage />;
      case 'feed-readiness':
        return <FeedReadinessPage />;
      case 'business-profile':
        return <BusinessProfilePage />;
      case 'ai-visibility':
        return <AiVisibilityPage />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <HomePage />;
    }
  };

  return (
    <AppShell>
      {renderCurrentPage()}
      <AuthModal />
    </AppShell>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <AppProvider>
        <AppContent />
      </AppProvider>
    </AuthProvider>
  );
}
