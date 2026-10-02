import { test as base, expect, chromium, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Recovery phrases exist only in browser/runner memory. In particular, Playwright's
// failure DOM prompt must not serialize the revealed phrase or restore inputs.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
const PASSWORD = 'test-only-browser-password-123';
const POPUP_SIZE = { width: 800, height: 600 };
const ONBOARDING_SIZE = { width: 1280, height: 900 };
const CONTROL_CHANNEL = 'monero-wallet-control-v2.1';
type Extension = {
  page: Page; context: BrowserContext; url: string; directory: string;
  external: string[]; errors: string[]; checks: string[]; allowNodeChecks: boolean;
  watchOffscreen: () => Promise<void>;
};

function healthResponse(extension: Extension, url: string, method: string, body?: string | null): string | undefined {
  if (!extension.allowNodeChecks || url !== 'http://node.sethforprivacy.com:38089/json_rpc' || method !== 'POST') return;
  const rpc = body ? JSON.parse(body) : null;
  if (rpc?.method !== 'get_info') return;
  extension.checks.push(url);
  return JSON.stringify({ jsonrpc: '2.0', id: rpc.id,
    result: { status: 'OK', nettype: 'stagenet', stagenet: true, height: 2_212_000, target_height: 0, synchronized: true } });
}
async function installOffscreenGuard(extension: Extension) {
  // Chrome exposes offscreen documents as background_page targets, which neither
  // context.pages() nor context.route() currently covers. Intercept the actual
  // network boundary with CDP; never replace fetch, wallet APIs, or WASM results.
  const cdp = await extension.context.browser()!.newBrowserCDPSession();
  let serial = 0;
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const watched = new Set<string>();
  function send(sessionId: string, method: string, params: Record<string, unknown>) {
    const id = ++serial;
    return new Promise<void>((resolveCommand, reject) => {
      pending.set(id, { resolve: resolveCommand, reject });
      void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
        .catch(error => { pending.delete(id); reject(error); });
    });
  }
  cdp.on('Target.receivedMessageFromTarget', event => {
    const message = JSON.parse(event.message);
    if (message.id) {
      const command = pending.get(message.id); if (!command) return;
      pending.delete(message.id);
      if (message.error) command.reject(new Error(message.error.message)); else command.resolve();
    } else if (message.method === 'Fetch.requestPaused') {
      const { request, requestId } = message.params;
      const content = healthResponse(extension, request.url, request.method, request.postData);
      if (!content) extension.external.push(request.url);
      void send(event.sessionId, content ? 'Fetch.fulfillRequest' : 'Fetch.failRequest', content
        ? { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(content).toString('base64') }
        : { requestId, errorReason: 'BlockedByClient' })
        .catch(error => extension.errors.push(`Offscreen network interception failed: ${error.message}`));
    }
  });
  extension.watchOffscreen = async () => {
    let targetId = '';
    await expect.poll(async () => {
      targetId = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'background_page' && target.url === extension.url.replace('index.html?popup=1', 'offscreen.html'))?.targetId || '';
      return targetId;
    }).not.toBe('');
    if (watched.has(targetId)) return;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId });
    await send(sessionId, 'Fetch.enable', { patterns: [{ urlPattern: 'http*', requestStage: 'Request' }] });
    watched.add(targetId);
  };
  await extension.watchOffscreen();
}

async function launchExtension(): Promise<Extension> {
  const directory = await mkdtemp(`${tmpdir()}/monero-popup-ui-`);
  const path = resolve('dist');
  const context = await chromium.launchPersistentContext(directory, {
    channel: 'chromium', headless: true, viewport: POPUP_SIZE, reducedMotion: 'reduce',
    // Defense in depth: an offscreen/worker request that escapes interception must
    // still never reach a public node. Only explicitly stubbed get_info is allowed.
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`, '--host-resolver-rules=MAP * ~NOTFOUND', '--screen-info={1920x1080}'],
    screen: { width: 1920, height: 1080 },
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const url = `chrome-extension://${new URL(worker.url()).host}/index.html?popup=1`;
  const external: string[] = []; const errors: string[] = []; const checks: string[] = [];
  const page = await context.newPage();
  const extension: Extension = { page, context, url, directory, external, errors, checks, allowNodeChecks: false,
    watchOffscreen: async () => { throw new Error('Offscreen network guard is not installed'); } };
  context.on('page', next => next.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  await context.route(/^https?:/, async route => {
    const request = route.request();
    const content = healthResponse(extension, request.url(), request.method(), request.postData());
    if (content) await route.fulfill({ status: 200, contentType: 'application/json', body: content });
    else { external.push(request.url()); await route.abort(); }
  });
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Welcome to Monero', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create a new wallet', exact: true })).toBeEnabled();
  await installOffscreenGuard(extension);
  return extension;
}
async function dispose(extension: Extension) {
  try { await extension.context.close(); }
  finally { await rm(extension.directory, { recursive: true, force: true }); }
}
const test = base.extend<{ extension: Extension }>({
  extension: async ({}, use) => {
    const extension = await launchExtension();
    try { await use(extension); }
    finally { await dispose(extension); }
  },
});
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Wallet navigation' }).getByRole('button', { name, exact: true });
async function navigate(page: Page, name: string) {
  await nav(page, name).click();
  await expect(nav(page, name)).toHaveAttribute('aria-current', 'page');
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (await page.locator('.gui-workspace').count()) {
    expect(await page.locator('.gui-workspace').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
}
async function screenshot(page: Page, name: string) {
  // Fail closed: never create a screenshot with a seed or sensitive text input.
  expect(await page.locator('.seed-grid,.ob-seed-grid').count()).toBe(0);
  expect(await page.locator('input[type=password],textarea[name=recovery-phrase],input[name^=backup-word-]').evaluateAll(inputs =>
    inputs.every(input => !(input as HTMLInputElement).value))).toBe(true);
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: `artifacts/popup-${name}.png`, animations: 'disabled' });
}
/** Dismiss visible notifications through their real close button (no timers mocked). */
async function dismissToasts(page: Page) {
  const button = page.locator('.toast').getByRole('button', { name: 'Dismiss notification', exact: true });
  while (await button.count()) await button.first().click();
  await expect(page.locator('.toast')).toHaveCount(0);
}
async function secretInput(input: Locator, value: string) {
  // locator.fill(value) includes the plaintext value in its failure call log.
  // The native setter + input event exercises React without putting it in logs.
  await input.evaluate((element, secret) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, secret);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
async function onboard(extension: Extension, mode: 'create' | 'restore' | 'import') {
  const { page, context } = extension;
  const button = mode === 'create' ? page.getByRole('button', { name: /^Create (a )?new wallet$/ })
    : page.getByRole('button', { name: mode === 'restore' ? 'Restore from recovery phrase' : 'Import encrypted wallet', exact: true });
  const opened = context.waitForEvent('page');
  await button.click();
  const wizard = await opened;
  await wizard.setViewportSize(ONBOARDING_SIZE);
  await wizard.bringToFront();
  await expect(wizard).toHaveURL(extension.url.replace('index.html?popup=1', `onboarding.html?mode=${mode}`));
  await expect(wizard.getByRole('heading', { name: mode === 'create' ? 'Create a new wallet' : mode === 'restore' ? 'Restore from recovery phrase' : 'Import an encrypted wallet', exact: true })).toBeVisible();
  return wizard;
}
async function details(wizard: Page, name: string) {
  await wizard.getByLabel('Wallet name', { exact: true }).fill(name);
  await wizard.getByLabel('Network', { exact: true }).selectOption('stagenet');
  await secretInput(wizard.getByLabel('Wallet password', { exact: true }), PASSWORD);
  await secretInput(wizard.getByLabel('Confirm password', { exact: true }), PASSWORD);
  await wizard.getByRole('checkbox', { name: /I will keep my recovery phrase offline/ }).check();
}
async function finishBackup(wizard: Page, create = false) {
  await expect(wizard.getByRole('heading', { name: 'Save an encrypted backup', exact: true })).toBeVisible();
  const next = wizard.getByRole('button', { name: create ? 'Verify recovery phrase' : 'Finish setup', exact: true });
  await expect(next).toBeDisabled();
  await wizard.getByRole('checkbox').check();
  await next.click();
}
async function create(extension: Extension, name = 'Browser test wallet', retainForRestore = false): Promise<string> {
  const wizard = await onboard(extension, 'create');
  await details(wizard, name);
  await wizard.getByRole('button', { name: 'Create wallet offline', exact: true }).click();
  await expect(wizard.getByRole('heading', { name: 'Write down your recovery phrase', exact: true })).toBeVisible();
  const reveal = wizard.getByRole('button', { name: 'Reveal recovery phrase', exact: true });
  await expect(reveal).toBeDisabled();
  await expect(wizard.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await expect(wizard.locator('.ob-seed-grid')).toHaveCount(0);
  await wizard.getByRole('checkbox', { name: /I am in a private place/ }).check();
  await reveal.click();
  await expect(wizard.locator('.ob-seed-grid > li')).toHaveCount(25);
  let seed = await wizard.locator('.ob-seed-grid > li').evaluateAll(elements => elements.map(element => element.lastChild!.textContent!.trim()).join(' '));
  expect(seed.trim().split(/\s+/).length === 25).toBe(true);
  await wizard.getByRole('checkbox', { name: /I have written down all 25 words/ }).check();
  await wizard.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(wizard.locator('.ob-seed-grid')).toHaveCount(0);
  await finishBackup(wizard, true);
  await expect(wizard.getByRole('heading', { name: 'Check your recovery phrase', exact: true })).toBeVisible();
  const challenges = wizard.locator('input[name^=backup-word-]');
  await expect(challenges).toHaveCount(3);
  const positions = await challenges.evaluateAll(inputs => inputs.map(input => Number(input.getAttribute('name')!.replace('backup-word-', ''))));
  expect(new Set(positions).size).toBe(3);
  expect(positions.every(position => position >= 1 && position <= 25)).toBe(true);
  // A wrong answer must not advance or retain any of the answers.
  for (const input of await challenges.all()) await input.fill('not-a-monero-word');
  await wizard.getByRole('button', { name: 'Verify and finish', exact: true }).click();
  await expect(wizard.getByRole('alert')).toContainText('Those words do not match');
  expect(await challenges.evaluateAll(inputs => inputs.every(input => !(input as HTMLInputElement).value))).toBe(true);
  const words = seed.split(' ');
  try {
    for (let index = 0; index < positions.length; index++) await secretInput(challenges.nth(index), words[positions[index] - 1]);
    await wizard.getByRole('button', { name: 'Verify and finish', exact: true }).click();
    await expect(wizard.getByRole('heading', { name: 'Your wallet is ready', exact: true })).toBeVisible();
    await expect(wizard.getByText('Verified', { exact: true })).toBeVisible();
    await expect(challenges).toHaveCount(0);
    await wizard.close();
    await extension.page.bringToFront();
    await expect(extension.page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    await expect(extension.page.locator('.titlebar-brand')).toContainText(name);
    return retainForRestore ? seed : '';
  } finally { words.fill(''); seed = ''; }
}
async function lock(page: Page) {
  await page.locator('.gui-titlebar').getByRole('button', { name: 'Lock wallet', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save & lock', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Open your wallet', exact: true })).toBeVisible();
}
async function unlock(page: Page, password = PASSWORD, walletName?: string) {
  await expect(page.getByRole('heading', { name: 'Open your wallet', exact: true })).toBeVisible();
  if (walletName) await page.getByLabel('Wallet', { exact: true }).selectOption({ label: `${walletName} · stagenet` });
  await secretInput(page.getByLabel('Password', { exact: true }), password);
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
}
async function address(page: Page) {
  await navigate(page, 'Receive');
  await expect(page.locator('.real-qr svg:has(> title)')).toBeVisible();
  const value = (await page.locator('.address-display').innerText()).replace(/\s/g, '');
  expect(value).toMatch(/^[57][1-9A-HJ-NP-Za-km-z]{94}$/);
  return value;
}
async function walletSettings(page: Page) {
  await navigate(page, 'Settings');
  await page.getByRole('tab', { name: 'Wallet', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Wallet', exact: true })).toBeVisible();
}
async function reopen(extension: Extension) {
  await extension.page.close();
  extension.page = await extension.context.newPage();
  await extension.page.goto(extension.url);
  await expect(extension.page.locator('.gui-titlebar').getByRole('button', { name: 'Lock wallet', exact: true })).toBeEnabled();
  return extension.page;
}
async function focusTrap(page: Page, last: Locator) {
  const dialog = page.getByRole('dialog');
  const first = dialog.getByRole('button', { name: 'Close dialog', exact: true });
  await expect(first).toBeFocused();
  expect(await page.locator('.gui-workspace').evaluate(element => (element as HTMLElement).inert)).toBe(true);
  await page.keyboard.press('Shift+Tab'); await expect(last).toBeFocused();
  await page.keyboard.press('Tab'); await expect(first).toBeFocused();
  await noOverflow(page);
}
async function storedSecretsAbsent(extension: Extension, seed: string) {
  // Return booleans, never storage contents or a phrase in assertion diagnostics.
  const clean = await extension.page.evaluate(async ({ password, phrase }) => {
    const data = JSON.stringify({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null),
      localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage } });
    return !data.includes(password) && !data.includes(phrase);
  }, { password: PASSWORD, phrase: seed });
  expect(clean).toBe(true);
}
async function restartCoordinator(extension: Extension) {
  const { page, context } = extension;
  const previous = context.serviceWorkers()[0]; const workerUrl = previous.url();
  const ownerBefore = await previous.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).map(owner => owner.documentId));
  expect(ownerBefore).toHaveLength(1);
  await previous.evaluate(() => Reflect.set(globalThis, '__moneroUiTestLifetime', true));
  const session = await context.newCDPSession(page);
  let versionId = ''; let stopped = false; let restarted = false;
  session.on('ServiceWorker.workerVersionUpdated', event => {
    const current = event.versions.find(item => item.scriptURL === workerUrl);
    if (!current) return;
    versionId = current.versionId;
    if (current.runningStatus === 'stopped') stopped = true;
    if (stopped && current.runningStatus === 'running') restarted = true;
  });
  await session.send('ServiceWorker.enable');
  await expect.poll(() => versionId).not.toBe('');
  await session.send('ServiceWorker.stopWorker', { versionId });
  await expect.poll(() => stopped).toBe(true);
  const response = await page.evaluate(channel => chrome.runtime.sendMessage({ channel, action: 'ensureOffscreen' }), CONTROL_CHANNEL);
  expect(response.ok).toBe(true);
  await expect.poll(() => restarted).toBe(true);
  // Chrome may reuse its DevTools target/Playwright Worker object across an actual
  // stop/start. Verify the JS realm was destroyed, not wrapper object inequality.
  const replacement = context.serviceWorkers().find(worker => worker.url() === workerUrl)!;
  expect(replacement).toBeDefined();
  expect(await replacement.evaluate(() => Reflect.get(globalThis, '__moneroUiTestLifetime'))).toBeUndefined();
  expect(await replacement.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).map(owner => owner.documentId))).toEqual(ownerBefore);
  await session.detach();
  return replacement;
}

test('MV3 action opens the real popup; dark/light UI, focus trap and separate onboarding routes fit', async ({ extension }) => {
  const { page, context, url } = extension;
  const manifest = await page.evaluate(() => chrome.runtime.getManifest() as chrome.runtime.ManifestV3);
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.version).toBe('2.3.0');
  expect(manifest.action?.default_popup).toBe('index.html?popup=1');
  expect(manifest.permissions).toEqual(expect.arrayContaining(['storage', 'offscreen']));
  expect(manifest.permissions).not.toEqual(expect.arrayContaining(['nativeMessaging']));
  expect(manifest.host_permissions?.some(value => /localhost|127\.0\.0\.1|<all_urls>/.test(value))).toBe(false);
  expect(manifest.content_security_policy?.extension_pages).toContain("'wasm-unsafe-eval'");
  expect(manifest.content_security_policy?.extension_pages).not.toContain("'unsafe-eval'");
  expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(POPUP_SIZE);
  await expect(page.locator('html')).toHaveClass(/extension-popup/);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await noOverflow(page);
  await screenshot(page, 'locked');
  await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  const help = page.getByRole('button', { name: 'Help and security', exact: true });
  await help.click();
  await focusTrap(page, page.getByRole('dialog').getByRole('link', { name: 'Monero documentation' }));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(help).toBeFocused();

  // Chrome 127+ supports action.openPopup. Assert a genuine POPUP context, not a
  // tab masquerading as one. The UI flows below use its exact URL at 800x600.
  const cdp = await context.browser()!.newBrowserCDPSession();
  // The default headless display is only 800x600 including browser chrome. Give
  // the real toolbar popup enough physical screen space; tab viewport stays 800x600.
  const pageCdp = await context.newCDPSession(page);
  const { windowId } = await pageCdp.send('Browser.getWindowForTarget');
  await pageCdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1400, height: 1000 } });
  await pageCdp.detach();
  const before = new Set((await cdp.send('Target.getTargets')).targetInfos.map(target => target.targetId));
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => chrome.action.openPopup());
  const actualPopups = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.POPUP] }));
  expect(actualPopups.map(popup => popup.documentUrl)).toEqual([url]);
  const actualTarget = (await cdp.send('Target.getTargets')).targetInfos.find(target => !before.has(target.targetId) && target.url === url);
  expect(actualTarget).toBeDefined();
  // Toolbar popups are not exposed as Playwright Page objects in headless Chrome.
  // Inspect the real target with CDP rather than pretending the direct tab is it.
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: actualTarget!.targetId });
  const dimensions = new Promise<unknown>((resolveDimensions, reject) => cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.id !== 1) return;
    if (message.error || message.result.exceptionDetails) reject(new Error('Could not inspect the real action popup'));
    else resolveDimensions(message.result.result.value);
  }));
  await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: 'new Promise(resolve => { const done = () => requestAnimationFrame(() => resolve({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth > innerWidth})); if (document.readyState === "complete") done(); else addEventListener("load", done, {once:true}); })',
    awaitPromise: true, returnByValue: true,
  } }) });
  expect(await dimensions).toEqual({ ...POPUP_SIZE, overflow: false });
  expect((await cdp.send('Target.closeTarget', { targetId: actualTarget!.targetId })).success).toBe(true);
  await cdp.detach();

  for (const mode of ['create', 'restore', 'import'] as const) {
    const wizard = await onboard(extension, mode);
    await noOverflow(wizard);
    await wizard.setViewportSize(POPUP_SIZE); await noOverflow(wizard);
    await wizard.setViewportSize({ width: 390, height: 844 }); await noOverflow(wizard);
    await wizard.setViewportSize(ONBOARDING_SIZE);
    if (mode === 'create') await screenshot(wizard, 'onboarding');
    await wizard.close(); await page.bringToFront();
  }
  expect(extension.external).toEqual([]); expect(extension.errors).toEqual([]);
});

test('real WASM accounts, subaddress and QR survive popup closure, SW restart and offscreen loss', async ({ extension }) => {
  test.setTimeout(150_000);
  await create(extension);
  let page = extension.page;
  await screenshot(page, 'overview');
  await navigate(page, 'Send');
  await screenshot(page, 'send');
  // Motion's useReducedMotion reads the preference when a component mounts.
  // Reload the view after changing the browser preference; the owner stays open.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Send', exact: true })).toBeVisible();
  await expect(page.locator('.page-transition')).toHaveCSS('opacity', '1');
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
  const motionFrames = page.evaluate(() => new Promise<{ opacity: number; offset: number }[]>(resolveFrames => {
    const frames: { opacity: number; offset: number }[] = []; const started = performance.now();
    const sample = () => {
      const panel = document.querySelector('.page-transition');
      if (panel) {
        const style = getComputedStyle(panel);
        frames.push({ opacity: Number(style.opacity), offset: style.transform === 'none' ? 0 : new DOMMatrixReadOnly(style.transform).m41 });
      }
      if (performance.now() - started < 450) requestAnimationFrame(sample); else resolveFrames(frames);
    };
    requestAnimationFrame(sample);
  }));
  await navigate(page, 'Receive');
  const frames = await motionFrames;
  expect(frames.some(frame => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
  expect(frames.some(frame => Math.abs(frame.offset) > 0.1)).toBe(true);
  await expect(page.locator('.page-transition')).toHaveCSS('opacity', '1');
  await expect(page.locator('.page-transition')).toHaveCSS('transform', 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Receive', exact: true })).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  const primary = await address(page);
  const initialQr = await page.locator('.real-qr svg:has(> title)').innerHTML();
  await page.getByLabel('Requested amount').fill('1.250000000001');
  await page.getByLabel('Description (optional)', { exact: true }).fill('Offline invoice');
  await expect(page.locator('.real-qr svg:has(> title)')).not.toHaveJSProperty('innerHTML', initialQr);
  await extension.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy payment link', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`monero:${primary}?tx_amount=1.250000000001&tx_description=Offline%20invoice`);
  await page.getByLabel('Requested amount').fill('1.0000000000001');
  await expect(page.locator('.real-qr svg:has(> title)')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy payment link', exact: true })).toBeDisabled();
  await page.getByLabel('Requested amount').fill('1.250000000001');
  await expect(page.locator('.real-qr svg:has(> title)')).toBeVisible();
  await screenshot(page, 'receive');
  await page.getByRole('button', { name: 'Create new address', exact: true }).click();
  await focusTrap(page, page.getByRole('dialog').getByRole('button', { name: 'Create subaddress', exact: true }));
  await page.getByLabel('Address label').fill('Private receive');
  await page.getByRole('dialog').getByRole('button', { name: 'Create subaddress', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.qr-caption')).toHaveText('Private receive');
  const subaddress = await address(page); expect(subaddress).not.toBe(primary);
  await navigate(page, 'Account');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Account name').fill('Savings');
  await page.getByRole('dialog').getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Rename Savings', exact: true }).click();
  await page.getByLabel('Account name').fill('Savings renamed');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const savings = page.locator('.account-card').filter({ has: page.getByRole('heading', { name: 'Savings renamed', exact: true }) });
  await expect(savings).toBeVisible();
  await savings.getByRole('button', { name: 'Use this account', exact: true }).click();
  await expect(page.locator('.account-card-top')).toContainText('Savings renamed');
  const savingsAddress = await address(page);
  expect(savingsAddress).not.toBe(primary);
  await expect(page.locator('.sidebar-balance strong')).toHaveText('0.000000000000');
  await walletSettings(page);
  await page.getByRole('button', { name: 'Save wallet', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Encrypted wallet saved');
  page = await reopen(extension);
  await expect(page.locator('.account-card-top')).toContainText('Savings renamed');
  expect(await address(page)).toBe(savingsAddress);
  await expect(page.locator('.sidebar-balance strong')).toHaveText('0.000000000000');
  await navigate(page, 'Account');
  await expect(page.getByRole('heading', { name: 'Savings renamed', exact: true })).toBeVisible();
  const worker = await restartCoordinator(extension);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your accounts', exact: true })).toBeVisible();
  await expect(page.locator('.account-card-top')).toContainText('Savings renamed');
  expect(await address(page)).toBe(savingsAddress);
  await navigate(page, 'Account');
  await page.locator('.account-card').first().getByRole('button', { name: 'Use this account', exact: true }).click();
  await expect(page.locator('.account-card').first().getByRole('button', { name: 'Selected account', exact: true })).toBeVisible();
  // Terminating the owner, unlike closing a UI or restarting the coordinator,
  // must destroy decrypted keys but retain the encrypted IndexedDB wallet.
  await worker.evaluate(() => chrome.offscreen.closeDocument());
  await expect(page.getByRole('heading', { name: 'Open your wallet', exact: true })).toBeVisible();
  await page.reload();
  await extension.watchOffscreen();
  await unlock(page, 'wrong-password');
  await expect(page.getByRole('alert')).toContainText('Incorrect password');
  await unlock(page);
  await expect(page.getByRole('heading', { name: 'Your accounts', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Savings renamed', exact: true })).toBeVisible();
  expect(await address(page)).toBe(primary);
  await page.getByRole('button', { name: '#1 Private receive', exact: true }).click();
  expect(await address(page)).toBe(subaddress);
  await navigate(page, 'Send');
  await expect(page.getByRole('button', { name: 'Review transaction', exact: true })).toBeDisabled();
  await noOverflow(page);
  await navigate(page, 'Transactions');
  await expect(page.getByRole('heading', { name: 'Transaction history', exact: true })).toBeVisible();
  await expect(page.locator('.history-error')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Nothing to see. Yet.', exact: true })).toBeVisible();
  await expect(page.locator('.history-sync-note')).toContainText('Start Sync to discover new transactions');
  await expect(page.locator('.history-notice')).toContainText('Incoming payments appear after their first mined block');
  await expect(page.getByRole('button', { name: 'Export CSV', exact: true })).toBeDisabled();
  await noOverflow(page);
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
  expect(extension.external).toEqual([]); expect(extension.errors).toEqual([]);
});

test('address labels, encrypted address book, send validation and offline message signing use the real engine', async ({ extension }) => {
  test.setTimeout(150_000);
  await create(extension);
  const { page } = extension;
  await expect(page.locator('.hero-card')).toContainText('Primary account');
  await dismissToasts(page);
  await noOverflow(page); await screenshot(page, 'overview');
  // Create and relabel a subaddress through the native wallet; the QR caption follows.
  const primary = await address(page);
  await page.getByRole('button', { name: 'Create new address', exact: true }).click();
  await page.getByLabel('Address label').fill('Donations');
  await page.getByRole('dialog').getByRole('button', { name: 'Create subaddress', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.qr-caption')).toHaveText('Donations');
  await page.getByRole('button', { name: 'Rename Donations', exact: true }).click();
  await page.getByLabel('Address label', { exact: true }).fill('Donations 2025');
  await page.getByRole('dialog').getByRole('button', { name: 'Save label', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.qr-caption')).toHaveText('Donations 2025');
  await expect(page.locator('.address-table .fresh-tag')).toHaveCount(2);
  // Address book: add, reject duplicate/wrong network, edit, send prefill, delete.
  const mainnet = '4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge';
  await navigate(page, 'Address book');
  await expect(page.getByRole('heading', { name: 'No contacts yet', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Alice');
  await page.getByLabel('Monero address', { exact: true }).fill(mainnet);
  await expect(page.getByRole('dialog')).toContainText('Your wallet uses Stagenet');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Save contact', exact: true })).toBeDisabled();
  await page.getByLabel('Monero address', { exact: true }).fill(primary);
  await expect(page.getByRole('dialog')).toContainText('Valid Stagenet standard address');
  await page.getByRole('dialog').getByRole('button', { name: 'Save contact', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.contact-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit Alice', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Alice Cooper');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('.contact-row')).toContainText('Alice Cooper');
  await dismissToasts(page); await noOverflow(page); await screenshot(page, 'contacts');
  await page.locator('.contact-row').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Send', exact: true })).toBeVisible();
  await expect(page.getByLabel('Recipient address')).toHaveValue(primary);
  await expect(page.locator('#send-address-help')).toContainText('Alice Cooper');
  // Payment links fill the form; a typo is caught offline; nothing can be prepared unsynced.
  await page.getByLabel('Recipient address').fill(`monero:${primary}?tx_amount=0.5&tx_description=Lunch%20money`);
  await expect(page.getByLabel('Recipient address')).toHaveValue(primary);
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('0.5');
  await page.getByLabel('Recipient address').fill(primary.slice(0, 50) + (primary[50] === 'A' ? 'B' : 'A') + primary.slice(51));
  await expect(page.locator('#send-address-help')).toContainText('Checksum mismatch');
  await expect(page.getByRole('button', { name: 'Review transaction', exact: true })).toBeDisabled();
  await noOverflow(page);
  await navigate(page, 'Address book');
  await page.getByRole('button', { name: 'Delete Alice Cooper', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete contact', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No contacts yet', exact: true })).toBeVisible();
  // Offline sign/verify with the real native wallet keys.
  await navigate(page, 'Settings');
  await page.getByRole('tab', { name: 'Tools', exact: true }).click();
  await page.getByLabel('Message to sign', { exact: true }).fill('I own this wallet');
  await page.getByRole('button', { name: 'Sign message', exact: true }).click();
  const signature = (await page.locator('.result-box code').innerText()).trim();
  expect(signature).toMatch(/^SigV2/);
  const panel = page.getByRole('tabpanel', { name: 'Tools', exact: true });
  await panel.getByLabel('Signed message', { exact: true }).fill('I own this wallet');
  await panel.getByLabel('Address', { exact: true }).fill(primary);
  await panel.getByLabel('Signature', { exact: true }).fill(signature);
  await page.getByRole('button', { name: 'Verify signature', exact: true }).click();
  await expect(page.locator('.verify-result')).toContainText('Valid signature made with the spend key');
  await panel.getByLabel('Signed message', { exact: true }).fill('I own this wallet!');
  await page.getByRole('button', { name: 'Verify signature', exact: true }).click();
  await expect(page.locator('.verify-result')).toContainText('does not match');
  await dismissToasts(page); await noOverflow(page); await screenshot(page, 'tools');
  // Wallet management: rename, settings persisted in the encrypted vault, password-gated keys.
  await page.getByRole('tab', { name: 'Wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Rename wallet', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Wallet name', { exact: true }).fill('Renamed wallet');
  await page.getByRole('dialog').getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.titlebar-brand')).toContainText('Renamed wallet');
  await page.getByLabel('Automatic lock', { exact: true }).selectOption('15');
  await expect(page.getByLabel('Automatic lock', { exact: true })).toHaveValue('15');
  await page.getByRole('switch', { name: 'Confirm payments with password', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Confirm payments with password', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Show keys', exact: true }).click();
  await secretInput(page.getByRole('dialog').getByLabel('Wallet password', { exact: true }), 'wrong-password');
  await page.getByRole('dialog').getByRole('button', { name: 'Show keys', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Incorrect password');
  await secretInput(page.getByRole('dialog').getByLabel('Wallet password', { exact: true }), PASSWORD);
  await page.getByRole('dialog').getByRole('button', { name: 'Show keys', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Private view key');
  expect(await page.getByRole('dialog').locator('code').first().innerText()).toBe(primary);
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
  // Settings survive a lock/unlock cycle because they live in the encrypted vault.
  await lock(page); await unlock(page);
  // Unlocking returns to the page the user was on.
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('.titlebar-brand')).toContainText('Renamed wallet');
  await page.getByRole('tab', { name: 'Wallet', exact: true }).click();
  await expect(page.getByLabel('Automatic lock', { exact: true })).toHaveValue('15');
  await expect(page.getByRole('switch', { name: 'Confirm payments with password', exact: true })).toHaveAttribute('aria-checked', 'true');
  // A user node is validated in the UI; malformed addresses never reach Chrome or the node.
  await page.getByRole('tab', { name: 'Node', exact: true }).click();
  await page.getByRole('button', { name: 'Add your own node', exact: true }).click();
  await page.getByLabel('Node address', { exact: true }).fill('ftp://example.com');
  await expect(page.locator('.custom-node-form')).toContainText('Only http:// and https://');
  await page.getByLabel('Node address', { exact: true }).fill('http://user:secret@example.com:18081');
  await expect(page.locator('.custom-node-form')).toContainText('Login credentials are not supported');
  await page.getByLabel('Node address', { exact: true }).fill('127.0.0.1:38081');
  await expect(page.locator('.custom-node-form')).toContainText('Will connect to http://127.0.0.1:38081');
  await dismissToasts(page);
  await noOverflow(page); await screenshot(page, 'custom-node');
  await page.locator('.custom-node-form').getByRole('button', { name: 'Cancel', exact: true }).click();
  // Integrated address generation stays local and uses the primary address.
  await navigate(page, 'Receive');
  await page.getByRole('button', { name: 'Integrated address', exact: true }).click();
  await page.getByLabel('Payment ID (optional)').fill('0123456789abcdef');
  await page.getByRole('dialog').getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('0123456789abcdef');
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Quick new address', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('created and selected');
  // Light theme across the new screens.
  await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await navigate(page, 'Overview');
  await dismissToasts(page); await screenshot(page, 'overview-light');
  await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  expect(extension.external).toEqual([]); expect(extension.errors).toEqual([]);
});

test('node consent is explicit; only stubbed health checks run, never automatic sync or polling traffic', async ({ extension }) => {
  await create(extension);
  extension.allowNodeChecks = true;
  const { page } = extension;
  await navigate(page, 'Settings');
  await expect(page.getByRole('tab', { name: 'Node', exact: true })).toHaveAttribute('aria-selected', 'true');
  const panel = page.locator('.node-settings'); const node = panel.locator('[data-node-id="seth-stagenet"]');
  await expect(node.getByRole('button', { name: 'Check node', exact: true })).toBeDisabled();
  await expect(node.getByRole('button', { name: 'Use node', exact: true })).toBeDisabled();
  expect(extension.checks).toEqual([]);
  await panel.getByRole('checkbox').check(); expect(extension.checks).toEqual([]);
  await node.getByRole('button', { name: 'Check node', exact: true }).click();
  await expect(node).toContainText('Reachable'); expect(extension.checks).toHaveLength(1);
  await node.getByRole('button', { name: 'Use node', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Check & save node', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(panel.locator('.node-active-summary')).toContainText('node.sethforprivacy.com:38089');
  expect(extension.checks).toHaveLength(2);
  await page.getByLabel('Browse network').selectOption('mainnet');
  await expect(panel.locator('[data-node-id="cake-mainnet"]').getByRole('button', { name: 'Use node', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Node', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Info', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Info', exact: true })).toContainText('Monero · WebAssembly');
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Wallet', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Wallet', exact: true })).toBeVisible();
  await noOverflow(page); await screenshot(page, 'settings');
  await lock(page); await screenshot(page, 'locked'); await unlock(page);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Node', exact: true }).click();
  await expect(panel.locator('.node-active-summary')).toContainText('node.sethforprivacy.com:38089');
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  // Deliberately span two real 3-second status polls. A web-first assertion alone
  // cannot prove the absence of delayed/background network access.
  await page.waitForTimeout(6500);
  expect(extension.checks).toHaveLength(2); expect(extension.external).toEqual([]); expect(extension.errors).toEqual([]);
});

test('native password change, encrypted export, 25-word restore and clean-profile import preserve addresses', async ({ extension }) => {
  test.setTimeout(180_000);
  let seed = await create(extension, 'Backup wallet', true);
  const { page } = extension; const primary = await address(page);
  await walletSettings(page);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await focusTrap(page, page.getByRole('dialog').getByRole('button', { name: 'Change password', exact: true }));
  await secretInput(page.getByLabel('Current password', { exact: true }), PASSWORD);
  await secretInput(page.getByLabel('New password', { exact: true }), PASSWORD + '-new');
  await secretInput(page.getByLabel('Confirm new password', { exact: true }), PASSWORD + '-new');
  await page.getByRole('dialog').getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export encrypted backup', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.monero-vault\.json$/);
  const file = resolve(extension.directory, 'backup.monero-vault.json'); await download.saveAs(file);
  const content = await readFile(file, 'utf8');
  expect(!content.includes(seed) && !content.includes(PASSWORD) && !content.includes(primary)).toBe(true);
  const encrypted = JSON.parse(content);
  expect(encrypted.cipher.name).toBe('AES-GCM'); expect(encrypted.kdf.name).toBe('PBKDF2');
  await storedSecretsAbsent(extension, seed);
  await lock(page); await unlock(page, PASSWORD);
  await expect(page.getByRole('alert')).toContainText('Incorrect password');
  await unlock(page, PASSWORD + '-new');
  expect(await address(page)).toBe(primary);
  await lock(page);
  const wizard = await onboard(extension, 'restore');
  await details(wizard, 'Seed restored wallet');
  await secretInput(wizard.getByLabel('25-word recovery phrase', { exact: true }), seed);
  await wizard.getByLabel('Restore height', { exact: true }).fill('0');
  await wizard.getByRole('button', { name: 'Restore wallet offline', exact: true }).click();
  await finishBackup(wizard);
  await expect(wizard.getByRole('heading', { name: 'Your wallet is ready', exact: true })).toBeVisible();
  await wizard.close(); await page.bringToFront();
  await expect(page.locator('.titlebar-brand')).toContainText('Seed restored wallet');
  expect(await address(page)).toBe(primary);
  seed = '';
  // Import into genuinely fresh extension storage, not by deleting a live vault.
  const imported = await launchExtension();
  try {
    const importer = await onboard(imported, 'import');
    await importer.getByLabel('Choose encrypted wallet backup', { exact: true }).setInputFiles(file);
    await secretInput(importer.getByLabel('Backup password', { exact: true }), 'wrong-password');
    await importer.getByRole('button', { name: 'Import and open wallet', exact: true }).click();
    await expect(importer.getByRole('alert')).toContainText('Incorrect password');
    await expect(importer.getByText('Backup imported · locked', { exact: true })).toBeVisible();
    await secretInput(importer.getByLabel('Backup password', { exact: true }), PASSWORD + '-new');
    await importer.getByRole('button', { name: 'Unlock imported wallet', exact: true }).click();
    await finishBackup(importer);
    await expect(importer.getByRole('heading', { name: 'Your wallet is ready', exact: true })).toBeVisible();
    await importer.close(); await imported.page.bringToFront();
    await expect(imported.page.locator('.titlebar-brand')).toContainText('Backup wallet');
    expect(await address(imported.page)).toBe(primary);
    await lock(imported.page); await unlock(imported.page, PASSWORD + '-new');
    expect(await address(imported.page)).toBe(primary);
    expect(imported.external).toEqual([]); expect(imported.errors).toEqual([]);
  } finally { await dispose(imported); }
  expect(extension.external).toEqual([]); expect(extension.errors).toEqual([]);
});

test('shared popup views retain one owner; seed reveal clears on leave and pending recovery is hash guarded', async ({ extension }) => {
  await create(extension);
  const { page, context, url } = extension;
  const other = await context.newPage(); await other.goto(url);
  await expect(other.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(other.locator('.titlebar-brand')).toContainText('Browser test wallet');
  const guardedSetup = await context.newPage();
  await guardedSetup.goto(url.replace('index.html?popup=1', 'onboarding.html?mode=create'));
  await expect(guardedSetup.getByRole('heading', { name: 'A wallet is already open', exact: true })).toBeVisible();
  await expect(guardedSetup.getByRole('button', { name: 'Create wallet offline', exact: true })).toBeDisabled();
  await guardedSetup.close();
  await other.close(); await page.bringToFront();
  await walletSettings(page);
  await page.getByRole('button', { name: 'Show seed', exact: true }).click();
  const reveal = page.getByRole('button', { name: 'Reveal recovery phrase', exact: true });
  await expect(reveal).toBeDisabled();
  await page.getByRole('dialog').getByRole('checkbox').check();
  await expect(reveal).toBeDisabled();
  // The service verifies the password against the encrypted vault before revealing.
  await secretInput(page.getByRole('dialog').getByLabel('Wallet password', { exact: true }), 'wrong-password');
  await reveal.click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Incorrect password');
  await expect(page.locator('.seed-grid')).toHaveCount(0);
  await secretInput(page.getByRole('dialog').getByLabel('Wallet password', { exact: true }), PASSWORD);
  await reveal.click();
  await expect(page.locator('.seed-grid > div')).toHaveCount(25);
  expect(await page.getByRole('dialog').locator('input[type=password]').count()).toBe(0);
  // Deterministic visibility regression: this dispatch only drives the browser UI
  // privacy handler; no engine, port response, or crypto operation is mocked.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.seed-grid')).toHaveCount(0);
  await expect(reveal).toBeDisabled();
  await expect(page.getByRole('dialog').getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByRole('dialog').getByLabel('Wallet password', { exact: true })).toHaveValue('');
  await page.evaluate(() => { delete (document as unknown as Record<string, unknown>).hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await lock(page);
  const worker = context.serviceWorkers()[0];
  const first = { txHash: 'a'.repeat(64), createdAt: Date.now() };
  const replacement = { txHash: 'b'.repeat(64), createdAt: Date.now() };
  // Test-only crash-recovery setup uses privileged SW storage, never a fake API
  // response or UI storage shim. The real service must perform guarded tx.resolve.
  await worker.evaluate(marker => chrome.storage.local.set({ unresolvedTransfer: marker }), first);
  await expect(page.getByText('Transfer outcome needs checking', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.pending-warning code')).toHaveText(first.txHash);
  await page.getByRole('button', { name: 'I have verified the outcome', exact: true }).click();
  await worker.evaluate(marker => chrome.storage.local.set({ unresolvedTransfer: marker }), replacement);
  await page.getByRole('dialog').getByRole('button', { name: 'Verified · clear warning', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('The recovery record changed');
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('unresolvedTransfer')).unresolvedTransfer)).toEqual(replacement);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.pending-warning code')).toHaveText(replacement.txHash);
  await page.getByRole('button', { name: 'I have verified the outcome', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Verified · clear warning', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Transfer outcome needs checking', { exact: true })).toHaveCount(0);
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('unresolvedTransfer')).unresolvedTransfer)).toBeUndefined();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Open your wallet', exact: true })).toBeVisible();
  await expect(page.locator('.pending-warning')).toHaveCount(0);
  expect(extension.external).toEqual([]); expect(extension.errors).toEqual([]);
});
