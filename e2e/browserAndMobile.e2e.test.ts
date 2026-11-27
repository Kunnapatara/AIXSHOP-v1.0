import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import { chromium, Browser, BrowserContext, Page } from 'playwright';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForServerReady(baseUrl: string, timeoutMs: number = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health/live`);
      if (res.ok) return;
    } catch {
      // Server still booting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for AIXSHOP server at ${baseUrl}`);
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert.ok(
    metrics.scrollWidth <= metrics.innerWidth,
    `Horizontal overflow detected at "${label}": scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`
  );
}

describe('Approved Group 5: Real Browser & Mobile E2E Verification (Playwright Chromium)', () => {
  let serverProc: ChildProcess | null = null;
  let browser: Browser | null = null;
  let baseUrl = '';
  const serverLogs: string[] = [];

  before(async () => {
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverProc = spawn('npx', ['tsx', 'server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'development',
        DISABLE_HMR: 'true',
        AIXSHOP_SILENCE_REQUEST_LOGS: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout?.on('data', (chunk) => serverLogs.push(chunk.toString()));
    serverProc.stderr?.on('data', (chunk) => serverLogs.push(chunk.toString()));

    await waitForServerReady(baseUrl, 45_000);
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          serverProc?.kill('SIGKILL');
          resolve();
        }, 5000);
        serverProc?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  });

  function attachErrorCollectors(page: Page, options: { allow404ConsoleError?: boolean } = {}) {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err.message || String(err));
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (options.allow404ConsoleError && /status of 404/i.test(text)) {
          return;
        }
        consoleErrors.push(text);
      }
    });
    return { pageErrors, consoleErrors };
  }

  test('Desktop (1280x800): Landing CTA, Legal Drafts, SEO/404 HTTP & Browser Navigation, Auth, Paywall, Shopify UI & Billing Settings', async () => {
    assert.ok(browser);
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const { pageErrors, consoleErrors } = attachErrorCollectors(page, {
      allow404ConsoleError: true,
    });

    try {
      // 1. Landing Page + Hero CTA above the fold + Pricing & Footer Legal Links
      await page.goto(`${baseUrl}/?page=landing`, { waitUntil: 'networkidle' });
      await page.waitForSelector('h1');
      const heroCta = page.getByRole('link', { name: /Start Free Store Check/i });
      await heroCta.waitFor({ state: 'visible' });
      const ctaBox = await heroCta.boundingBox();
      assert.ok(ctaBox && ctaBox.y + ctaBox.height <= 800, 'Hero CTA must be visible above the fold at 1280x800');
      await assertNoHorizontalOverflow(page, 'Desktop Landing');

      // Validate invalid store URL error state on Landing
      const urlInput = page.getByLabel('Online store URL');
      await urlInput.fill('not-a-domain');
      await page.getByRole('button', { name: /Inspect Catalog/i }).click();
      await page.getByText(/Please enter a valid store domain/i).waitFor({ state: 'visible' });

      // 2. Navigate via Footer to Draft Privacy Policy & Draft Terms of Service
      await page.getByRole('button', { name: /Privacy \(Draft\)/i }).click();
      await page.getByText(/Draft Document — Legal Review Required Before Commercial Publication/i).waitFor({ state: 'visible' });
      assert.ok(page.url().includes('/privacy'));
      await assertNoHorizontalOverflow(page, 'Desktop Privacy Policy Draft');

      await page.getByRole('button', { name: /Terms of Service \(Draft\)/i }).click();
      await page.getByText(/Terms of Service \(Draft Template\)/i).waitFor({ state: 'visible' });
      assert.ok(page.url().includes('/terms'));
      await assertNoHorizontalOverflow(page, 'Desktop Terms of Service Draft');

      // 3. SEO & API 404 checks over HTTP
      const robotsRes = await page.request.get(`${baseUrl}/robots.txt`);
      assert.equal(robotsRes.status(), 200);
      const sitemapRes = await page.request.get(`${baseUrl}/sitemap.xml`);
      assert.equal(sitemapRes.status(), 200);
      const faviconRes = await page.request.get(`${baseUrl}/favicon.svg`);
      assert.equal(faviconRes.status(), 200);
      const api404Res = await page.request.get(`${baseUrl}/api/nonexistent-endpoint-e2e`);
      assert.equal(api404Res.status(), 404);
      const api404Json = await api404Res.json();
      assert.equal(api404Json.code, 'API_ROUTE_NOT_FOUND');

      // 4. Unknown Browser route -> HTTP 404 + Custom 404 UI + Recovery navigation
      const notFoundNav = await page.goto(`${baseUrl}/nonexistent-browser-route-404`, {
        waitUntil: 'networkidle',
      });
      assert.equal(notFoundNav?.status(), 404);
      await page.getByText(/HTTP 404 · Page Not Found/i).waitFor({ state: 'visible' });
      await assertNoHorizontalOverflow(page, 'Desktop Custom 404');
      await page.getByRole('button', { name: /Return to Store Overview/i }).click();
      await page.getByText(/Store Overview/i).first().waitFor({ state: 'visible' });

      // 5. Desktop Workspace Navigation (Demo mode initially)
      await page.getByRole('button', { name: /^Products$/i }).first().click();
      await assertNoHorizontalOverflow(page, 'Desktop Products');
      await page.getByRole('button', { name: /^Actions$/i }).first().click();
      await assertNoHorizontalOverflow(page, 'Desktop Actions');

      // 6. Auth Flow: Register new user & isolated Free Audit Cloud Workspace
      await page.getByRole('button', { name: /Sign In/i }).click();
      await page.getByRole('button', { name: /Sign Up/i }).click();
      const uniqueEmail = `e2e-desktop-${crypto.randomBytes(4).toString('hex')}@example.test`;
      await page.getByPlaceholder('Jane Merchant').fill('Desktop E2E Merchant');
      await page.getByPlaceholder('Solstice Mercantile').fill('Nordic Gear E2E');
      await page.getByPlaceholder('merchant@example.com').fill(uniqueEmail);
      await page.getByPlaceholder('••••••••').fill('StrongPass!2026');
      await page.getByRole('button', { name: /Create Workspace Account/i }).click();

      // Verify Cloud Workspace becomes active & fresh workspace shows locked audit paywall
      await page.getByText(/Cloud DB Active/i).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: /Audit/i }).first().click();
      await page.getByText(/Paid Plan Required — Audit & Reports Locked/i).waitFor({ state: 'visible' });
      await assertNoHorizontalOverflow(page, 'Desktop Audit Paywall');

      // 7. Upgrade button routes cleanly to Billing Settings tab
      await page.getByRole('button', { name: /Upgrade Plan to Unlock/i }).click();
      await page.getByText(/Store & Catalog Configuration/i).waitFor({ state: 'visible' });
      await page.getByText(/Free Audit/i).first().waitFor({ state: 'visible' });
      await page.getByText(/Starter Plan/i).first().waitFor({ state: 'visible' });
      await assertNoHorizontalOverflow(page, 'Desktop Billing Settings');

      // 8. Shopify Connectors Tab UI & Honest Error Validation
      await page.getByRole('button', { name: /Connectors & Feeds/i }).click();
      const shopDomainInput = page.getByPlaceholder('e.g. solstice-mercantile.myshopify.com');
      await shopDomainInput.waitFor({ state: 'visible' });
      // Empty / invalid domain fails gracefully with inline alert without faking a store
      await page.getByRole('button', { name: /Connect Store/i }).click();
      await page.locator('[role="alert"]').first().waitFor({ state: 'visible' });
      await assertNoHorizontalOverflow(page, 'Desktop Shopify Connectors Settings');

      // 9. Sign Out & Sign In Verification
      await page.getByRole('button', { name: /Desktop/i }).first().click();
      await page.getByRole('button', { name: /Sign Out/i }).click();
      await page.getByText(/Demo Mode · Enable Cloud/i).waitFor({ state: 'visible' });

      await page.getByRole('button', { name: /Sign In/i }).click();
      await page.getByPlaceholder('merchant@example.com').fill(uniqueEmail);
      await page.getByPlaceholder('••••••••').fill('StrongPass!2026');
      await page.locator('form button[type="submit"]').click();
      await page.getByText(/Cloud DB Active/i).waitFor({ state: 'visible' });

      assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join(' | ')}`);
      assert.deepEqual(consoleErrors, [], `Unexpected console errors: ${consoleErrors.join(' | ')}`);
    } finally {
      await context.close();
    }
  });

  test('Mobile (390x844): Responsive Layout, Hamburger Drawer, Bottom Nav, Landing CTA, Legal Drafts, 404 & Zero Horizontal Overflow', async () => {
    assert.ok(browser);
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const { pageErrors, consoleErrors } = attachErrorCollectors(page, {
      allow404ConsoleError: true,
    });

    try {
      // 1. Mobile Landing Page + Hero CTA + Zero Overflow
      await page.goto(`${baseUrl}/?page=landing`, { waitUntil: 'networkidle' });
      await page.getByRole('link', { name: /Start Free Store Check/i }).waitFor({ state: 'visible' });
      await assertNoHorizontalOverflow(page, 'Mobile Landing 390x844');

      // 2. Enter Merchant App & Verify Mobile Bottom Nav + Hamburger Drawer
      await page.getByRole('button', { name: /Enter Merchant App/i }).click();
      await page.getByText(/Store Overview/i).first().waitFor({ state: 'visible' });
      await assertNoHorizontalOverflow(page, 'Mobile Home 390x844');

      const bottomNav = page.getByRole('navigation', { name: 'Mobile Bottom Navigation' });
      await bottomNav.waitFor({ state: 'visible' });
      await bottomNav.getByRole('button', { name: 'Audit' }).click();
      await assertNoHorizontalOverflow(page, 'Mobile Audit 390x844');

      // Open Hamburger Drawer
      await page.getByRole('button', { name: 'Open mobile navigation menu' }).click();
      await page.getByRole('button', { name: 'Close menu' }).waitFor({ state: 'visible' });
      await assertNoHorizontalOverflow(page, 'Mobile Drawer Open 390x844');
      await page.getByRole('button', { name: /Store \/ Settings/i }).last().click();
      await page.getByText(/Store & Catalog Configuration/i).waitFor({ state: 'visible' });
      await assertNoHorizontalOverflow(page, 'Mobile Settings 390x844');

      // 3. Mobile Legal & 404 Views
      await page.goto(`${baseUrl}/privacy`, { waitUntil: 'networkidle' });
      await page.getByText(/Draft Document — Legal Review Required/i).waitFor({ state: 'visible' });
      await assertNoHorizontalOverflow(page, 'Mobile Privacy 390x844');

      await page.goto(`${baseUrl}/terms`, { waitUntil: 'networkidle' });
      await page.getByText(/Terms of Service \(Draft Template\)/i).waitFor({ state: 'visible' });
      await assertNoHorizontalOverflow(page, 'Mobile Terms 390x844');

      const mobile404 = await page.goto(`${baseUrl}/mobile-missing-route-404`, {
        waitUntil: 'networkidle',
      });
      assert.equal(mobile404?.status(), 404);
      await page.getByText(/HTTP 404 · Page Not Found/i).waitFor({ state: 'visible' });
      await assertNoHorizontalOverflow(page, 'Mobile Custom 404 390x844');

      assert.deepEqual(pageErrors, [], `Unexpected mobile page errors: ${pageErrors.join(' | ')}`);
      assert.deepEqual(consoleErrors, [], `Unexpected mobile console errors: ${consoleErrors.join(' | ')}`);
    } finally {
      await context.close();
    }
  });
});
