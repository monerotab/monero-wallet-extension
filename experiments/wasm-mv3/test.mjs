import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const here = path.dirname(fileURLToPath(import.meta.url));
const reports = [];
for (const variant of ['dist-original', 'dist']) {
  const extension = path.join(here, variant);
  const profile = await mkdtemp(path.join(here, '.profile-'));
  let context;
  const requests = [];
  const runtimeErrors = [];
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox', '--disable-background-networking'],
    });
    await context.route(/^https?:\/\//, route => { requests.push(route.request().url()); return route.abort(); });
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    page.on('pageerror', error => runtimeErrors.push({ name: error.name, cspError: /unsafe-eval|Content Security Policy|EvalError/.test(error.message) }));
    await page.goto(`chrome-extension://${extensionId}/index.html`);
    await page.waitForFunction(() => window.proofResult?.status !== 'running', { timeout: 180000 });
    const report = await page.evaluate(() => window.proofResult);
    const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.content_security_policy.extension_pages.includes("'wasm-unsafe-eval'"));
    assert.ok(!manifest.content_security_policy.extension_pages.includes("'unsafe-eval'"));
    assert.equal(requests.length, 0, 'Offline wallet unexpectedly attempted an HTTP request');
    if (variant === 'dist-original') {
      assert.equal(report.status, 'failed', 'Unpatched package unexpectedly became MV3 compatible; re-audit patch');
      assert.equal(report.cspError, true, 'Expected original dynamic-code CSP failure');
    } else {
      assert.equal(report.status, 'passed', `Patched proof failed at ${report.stage}`);
      assert.equal(report.crossOriginIsolated, false);
      assert.ok(report.heartbeat > 0, 'WASM blocked main UI thread');
      assert.equal(runtimeErrors.length, 0);
      await page.screenshot({ path: path.join(here, 'proof.png'), fullPage: true });
    }
    reports.push({ variant, report, outboundHttpRequests: requests.length, runtimeErrors, csp: manifest.content_security_policy.extension_pages });
    console.log(JSON.stringify(reports.at(-1), null, 2));
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    await writeFile(path.join(here, 'test-results.json'), JSON.stringify(reports, null, 2));
  }
}
