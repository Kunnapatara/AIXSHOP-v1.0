import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApp } from './app';
import { MemoryRepository } from './db/memoryRepository';
import { resolveNavigationPageFromLocation } from '../context/AppContext';
import { AppContext, AppContextType } from '../context/AppContext';
import { PrivacyPolicyPage } from '../pages/PrivacyPolicyPage';
import { TermsOfServicePage } from '../pages/TermsOfServicePage';
import { NotFoundPage } from '../pages/NotFoundPage';
import {
  createRequestCorrelationMiddleware,
  OpsAlertService,
  redactMonitoringText,
  sanitizeMonitoringPayload,
  structuredLog,
} from './services/monitoringService';

function createStubAppContext(overrides: Partial<AppContextType> = {}): AppContextType {
  return {
    currentPage: 'landing',
    previousPage: 'home',
    selectedProductId: null,
    selectedActionId: null,
    storeProfile: {
      name: 'Test Store',
      domain: 'test.example',
      websiteUrl: 'https://test.example',
      platform: 'shopify',
      sourceClassification: 'demo',
      shopifyConnected: false,
      currency: 'USD',
      skuCount: 0,
      skuLimit: 250,
      catalogCompletenessAvg: 0,
      truthBoundaryStrictness: 'standard',
      tier: 'Free Audit',
      connectors: [],
    },
    products: [],
    variantsCount: 0,
    offersCount: 0,
    findings: [],
    actionItems: [],
    evidenceCount: 0,
    toasts: [],
    quickCheckResult: null,
    lastIngestionResult: null,
    isCheckingStore: false,
    selectedProduct: null,
    mobileMenuOpen: false,
    isReadOnlyMode: false,
    readOnlyReason: null,
    storageLoadResult: null,
    isDurableStorage: false,
    isCloudWorkspace: false,
    cloudCatalogStatus: 'idle',
    demoOverwriteProtection: { shouldProtect: false, reason: 'none' } as any,
    setMobileMenuOpen: () => {},
    setSelectedActionId: () => {},
    navigateTo: () => {},
    viewProductDetail: () => {},
    returnFromProductDetail: () => {},
    runStoreCheck: async () => {},
    importDiscoveredProducts: async () => null,
    approveAction: () => {},
    dismissAction: () => {},
    recheckAction: () => {},
    recheckProduct: () => {},
    updateStoreProfile: () => ({ success: true }),
    toggleConnectorSync: () => ({ success: true }),
    migrateDemoDataToCloud: async () => false,
    runAudit: async () => null,
    addToast: () => {},
    removeToast: () => {},
    resetToSeedData: () => {},
    reloadWorkspaceCatalog: async () => {},
    ...overrides,
  };
}

describe('Approved Groups 2 & 3: Legal Drafts, SEO Assets, HTTP 404 & Lightweight Monitoring', () => {
  let server: http.Server;
  let baseUrl: string;
  let repo: MemoryRepository;

  before(async () => {
    repo = new MemoryRepository(false);
    const app = createApp(repo);
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  test('Group 2: /robots.txt, /sitemap.xml, and /favicon.svg serve valid SEO & brand responses', async () => {
    const robotsRes = await fetch(`${baseUrl}/robots.txt`);
    assert.equal(robotsRes.status, 200);
    assert.match(robotsRes.headers.get('content-type') || '', /text\/plain/i);
    const robotsText = await robotsRes.text();
    assert.match(robotsText, /User-agent:\s*\*/);
    assert.match(robotsText, /Allow:\s*\/privacy/);
    assert.match(robotsText, /Allow:\s*\/terms/);
    assert.match(robotsText, /Disallow:\s*\/api\//);

    const sitemapRes = await fetch(`${baseUrl}/sitemap.xml`);
    assert.equal(sitemapRes.status, 200);
    assert.match(sitemapRes.headers.get('content-type') || '', /application\/xml/i);
    const sitemapXml = await sitemapRes.text();
    assert.match(sitemapXml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.match(sitemapXml, /<loc>.*\/privacy<\/loc>/);
    assert.match(sitemapXml, /<loc>.*\/terms<\/loc>/);

    const faviconRes = await fetch(`${baseUrl}/favicon.svg`);
    assert.equal(faviconRes.status, 200);
    assert.match(faviconRes.headers.get('content-type') || '', /image\/svg\+xml/i);
    const faviconSvg = await faviconRes.text();
    assert.match(faviconSvg, /<svg/);
  });

  test('Group 2: Unknown /api/* routes return HTTP 404 JSON with API_ROUTE_NOT_FOUND and X-Request-Id', async () => {
    const getRes = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(getRes.status, 404);
    assert.match(getRes.headers.get('content-type') || '', /application\/json/i);
    const headerReqId = getRes.headers.get('x-request-id');
    assert.ok(headerReqId && headerReqId.startsWith('req_'));
    const body = await getRes.json();
    assert.equal(body.code, 'API_ROUTE_NOT_FOUND');
    assert.equal(body.requestId, headerReqId);

    const postRes = await fetch(`${baseUrl}/api/unknown/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({}),
    });
    assert.equal(postRes.status, 404);
    const postBody = await postRes.json();
    assert.equal(postBody.code, 'API_ROUTE_NOT_FOUND');
  });

  test('Group 2: Frontend route resolver resolves legal, known workspace, and 404 paths accurately', () => {
    assert.equal(resolveNavigationPageFromLocation('/', ''), 'home');
    assert.equal(resolveNavigationPageFromLocation('/landing', ''), 'landing');
    assert.equal(resolveNavigationPageFromLocation('/settings', ''), 'settings');
    assert.equal(resolveNavigationPageFromLocation('/privacy', ''), 'privacy');
    assert.equal(resolveNavigationPageFromLocation('/privacy-policy/', ''), 'privacy');
    assert.equal(resolveNavigationPageFromLocation('/terms', ''), 'terms');
    assert.equal(resolveNavigationPageFromLocation('/terms-of-service/', ''), 'terms');
    assert.equal(resolveNavigationPageFromLocation('/', '?page=privacy'), 'privacy');
    assert.equal(resolveNavigationPageFromLocation('/', '?page=terms'), 'terms');
    assert.equal(resolveNavigationPageFromLocation('/', '?page=audit'), 'audit');
    assert.equal(resolveNavigationPageFromLocation('/nonexistent-route', ''), 'not-found');
    assert.equal(resolveNavigationPageFromLocation('/', '?page=bogus_view'), 'not-found');
  });

  test('Group 2: Draft Privacy Policy, Draft Terms of Service, and Custom 404 render honest draft notices without guarantee claims', () => {
    const stubCtx = createStubAppContext();
    const privacyHtml = renderToStaticMarkup(
      React.createElement(
        AppContext.Provider,
        { value: stubCtx },
        React.createElement(PrivacyPolicyPage)
      )
    );
    assert.match(privacyHtml, /Draft Document — Legal Review Required Before Commercial Publication/i);
    assert.match(privacyHtml, /does not guarantee compliance/i);

    const termsHtml = renderToStaticMarkup(
      React.createElement(
        AppContext.Provider,
        { value: stubCtx },
        React.createElement(TermsOfServicePage)
      )
    );
    assert.match(termsHtml, /Draft Document — Legal Review Required Before Commercial Publication/i);
    assert.match(termsHtml, /does not guarantee compliance/i);

    const notFoundHtml = renderToStaticMarkup(
      React.createElement(
        AppContext.Provider,
        { value: stubCtx },
        React.createElement(NotFoundPage)
      )
    );
    assert.match(notFoundHtml, /HTTP 404/);
    assert.match(notFoundHtml, /Return to Store Overview/);
  });

  test('Group 3: Correlation ID validation, structured JSON logging, and secret/PII redaction', async () => {
    // Valid X-Request-Id is echoed back unchanged
    const validId = 'corr-trace-abc-12345';
    const okRes = await fetch(`${baseUrl}/api/health/live`, {
      headers: { 'X-Request-Id': validId },
    });
    assert.equal(okRes.status, 200);
    assert.equal(okRes.headers.get('x-request-id'), validId);
    const liveJson = await okRes.json();
    assert.equal(liveJson.requestId, validId);
    assert.equal(liveJson.monitoring.structuredLogging, true);
    assert.equal(liveJson.monitoring.correlationHeader, 'X-Request-Id');

    // Malicious/invalid X-Request-Id is replaced by a fresh generated req_* ID
    const badRes = await fetch(`${baseUrl}/api/health/live`, {
      headers: { 'X-Request-Id': 'bad<script>id' },
    });
    const regeneratedId = badRes.headers.get('x-request-id') || '';
    assert.match(regeneratedId, /^req_[a-f0-9]{16}$/);

    // Secret & PII scrubbing check
    const dirty =
      'Failed connecting postgres://admin:super_pg_pw@db.internal:5432/prod with sk_live_51AbcDefGhi, whsec_topsecret123, shpat_1234567890, Bearer eyJhbGciOi.secret.tok, user alice.smith@merchant.com';
    const clean = redactMonitoringText(dirty);
    assert.doesNotMatch(clean, /super_pg_pw/);
    assert.doesNotMatch(clean, /sk_live_51AbcDefGhi/);
    assert.doesNotMatch(clean, /whsec_topsecret123/);
    assert.doesNotMatch(clean, /shpat_1234567890/);
    assert.doesNotMatch(clean, /eyJhbGciOi/);
    assert.doesNotMatch(clean, /alice\.smith@merchant\.com/);
    assert.match(clean, /a\*\*\*@merchant\.com/);

    const sanitizedObj = sanitizeMonitoringPayload({
      password: 'plain_password',
      recipientEmail: 'bob@example.com',
      nested: { authorization: 'Bearer secret_tok', safeCount: 3 },
    }) as Record<string, any>;
    assert.equal(sanitizedObj.password, '[REDACTED]');
    assert.equal(sanitizedObj.recipientEmail, 'b***@example.com');
    assert.equal(sanitizedObj.nested.authorization, '[REDACTED]');
    assert.equal(sanitizedObj.nested.safeCount, 3);

    // Structured JSON logger middleware sink test
    const capturedLines: string[] = [];
    const mw = createRequestCorrelationMiddleware({
      logRequests: true,
      logSink: (line) => capturedLines.push(line),
    });
    const fakeHeaders: Record<string, string> = {};
    const finishHandlers: Array<() => void> = [];
    const fakeReq: any = {
      method: 'GET',
      originalUrl: '/api/health/ready?token=secret_query_tok',
      path: '/api/health/ready',
      header: () => 'custom-req-98765432',
    };
    const fakeRes: any = {
      statusCode: 200,
      setHeader: (k: string, v: string) => {
        fakeHeaders[k] = v;
      },
      on: (ev: string, fn: () => void) => {
        if (ev === 'finish') finishHandlers.push(fn);
      },
    };
    mw(fakeReq, fakeRes, () => {});
    for (const fn of finishHandlers) fn();
    assert.equal(fakeHeaders['X-Request-Id'], 'custom-req-98765432');
    assert.equal(capturedLines.length, 1);
    const parsedLog = JSON.parse(capturedLines[0]);
    assert.equal(parsedLog.event, 'http_request');
    assert.equal(parsedLog.requestId, 'custom-req-98765432');
    assert.equal(parsedLog.path, '/api/health/ready');
    assert.doesNotMatch(capturedLines[0], /secret_query_tok/);

    const directLog = structuredLog(
      'warn',
      'custom_test_event',
      { email: 'owner@store.io', secret: 'do_not_leak' },
      () => {}
    );
    assert.equal(directLog.email, 'o***@store.io');
    assert.equal(directLog.secret, '[REDACTED]');
  });

  test('Group 3: OpsAlertService delivers redacted alerts, enforces dedup/throttling, and isolates network failures', async () => {
    const deliveredBodies: any[] = [];
    let currentTime = 1_000_000;
    let shouldFailFetch = false;

    const alertService = new OpsAlertService({
      webhookUrl: 'https://hooks.example.test/services/ops-alerts',
      throttleMs: 60_000,
      nowFn: () => currentTime,
      fetchImpl: (async (_url: any, init: any) => {
        if (shouldFailFetch) {
          throw new Error('ECONNREFUSED');
        }
        deliveredBodies.push(JSON.parse(init.body));
        return new Response('ok', { status: 200 });
      }) as typeof fetch,
    });

    // First alert succeeds with redacted summary/details
    const first = await alertService.sendAlert({
      severity: 'error',
      alertKey: 'api_5xx:GET:/api/audit',
      title: 'Unhandled API 500',
      summary: 'Error for alice@merchant.com using sk_test_51SecretKeyValue',
      requestId: 'req_12345678',
      details: { token: 'secret_abc', skuCount: 12 },
    });
    assert.equal(first.sent, true);
    assert.equal(deliveredBodies.length, 1);
    assert.doesNotMatch(deliveredBodies[0].summary, /alice@merchant\.com/);
    assert.doesNotMatch(deliveredBodies[0].summary, /sk_test_51SecretKeyValue/);
    assert.equal(deliveredBodies[0].details.token, '[REDACTED]');
    assert.equal(deliveredBodies[0].details.skuCount, 12);

    // Same alertKey inside throttle window is deduplicated/throttled
    currentTime += 10_000;
    const second = await alertService.sendAlert({
      severity: 'error',
      alertKey: 'api_5xx:GET:/api/audit',
      title: 'Unhandled API 500',
      summary: 'Repeated error',
    });
    assert.equal(second.sent, false);
    assert.equal(second.reason, 'throttled');
    assert.equal(deliveredBodies.length, 1);

    // Different alertKey fires immediately
    const otherKey = await alertService.sendAlert({
      severity: 'critical',
      alertKey: 'health_readiness_degraded',
      title: 'Readiness degraded',
      summary: 'DB unreachable',
    });
    assert.equal(otherKey.sent, true);
    assert.equal(deliveredBodies.length, 2);

    // After throttle window expires, original alertKey can fire again
    currentTime += 65_000;
    shouldFailFetch = true;
    const afterCooldown = await alertService.sendAlert({
      severity: 'error',
      alertKey: 'api_5xx:GET:/api/audit',
      title: 'Unhandled API 500',
      summary: 'Error persisted after cooldown',
    });
    assert.equal(afterCooldown.sent, false);
    assert.equal(afterCooldown.reason, 'network_error');

    // Invalid non-HTTPS external URL rejected fail-closed
    const invalidService = new OpsAlertService({
      webhookUrl: 'http://insecure.external.example/hook',
    });
    const invalidRes = await invalidService.sendAlert({
      severity: 'warning',
      alertKey: 'test',
      title: 'test',
      summary: 'test',
    });
    assert.equal(invalidRes.sent, false);
    assert.equal(invalidRes.reason, 'invalid_webhook_url');
  });
});
