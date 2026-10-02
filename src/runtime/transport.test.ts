import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { OffscreenWalletHost } from './offscreen-host.ts';
import { WalletPortClient } from './transport-client.ts';
import { PortWire } from './transport-wire.ts';
import { CONTROL_CHANNEL, MAX_CLIENTS, MAX_PENDING_REQUESTS, MAX_MESSAGE_CHARS, PORT_NAME, SESSION_IDLE_MS,
  trustedSender, validMarker, type RuntimePort, type WalletRuntime } from './transport.ts';

import { ACTIONS, CLOSE_ACTIONS, MAX_SESSION_IDLE_MS, NEUTRAL_ACTIONS, OPEN_ACTIONS, POLL_ACTIONS, READ_ACTIONS, sessionIdleMs, validRequest,
  validResultIdentity } from './transport.ts';

const EXTENSION = 'a'.repeat(32);
const UI = { id: EXTENSION, url: `chrome-extension://${EXTENSION}/index.html?popup=1`, origin: `chrome-extension://${EXTENSION}`, frameId: 0 };
const OFFSCREEN = { id: EXTENSION, url: `chrome-extension://${EXTENSION}/offscreen.html`, origin: `chrome-extension://${EXTENSION}`, documentId: 'offscreen-document-A' };
const VAULT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HASH = 'b'.repeat(64);
const DRAFT = '00000000-0000-4000-8000-000000000001';
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve };
}
async function tick() { await new Promise(resolve => setImmediate(resolve)); }
class Event<T extends (...args: never[]) => unknown> {
  listeners = new Set<T>();
  addListener = (listener: T) => { this.listeners.add(listener); };
  removeListener = (listener: T) => { this.listeners.delete(listener); };
  emit(...args: Parameters<T>) { for (const listener of this.listeners) listener(...args); }
}
class FakePort {
  name = PORT_NAME;
  sender = UI;
  onMessage = new Event<(value: unknown) => void>();
  onDisconnect = new Event<() => void>();
  peer!: FakePort;
  disconnected = false;
  sent: unknown[] = [];
  postMessage(value: unknown) {
    if (this.disconnected) throw new Error('Port closed');
    this.sent.push(value);
    queueMicrotask(() => { if (!this.disconnected && !this.peer.disconnected) this.peer.onMessage.emit(value); });
  }
  disconnect() {
    if (this.disconnected) return;
    this.disconnected = true; this.peer.disconnected = true;
    this.onDisconnect.emit(); this.peer.onDisconnect.emit();
  }
  asPort() { return this as unknown as RuntimePort; }
}
function pair() { const ui = new FakePort(), host = new FakePort(); ui.peer = host; host.peer = ui; return { ui, host }; }
class FakeService implements WalletRuntime {
  calls: { action: string; params: Record<string, unknown> }[] = [];
  walletOpen = false;
  syncing = false;
  handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  async request(action: string, params: Record<string, unknown> = {}) {
    this.calls.push({ action, params });
    if (this.handlers.has(action)) return this.handlers.get(action)!(params);
    if (action === 'status') return { walletOpen: this.walletOpen, syncing: this.syncing, ...(this.walletOpen ? { vaultId: VAULT } : {}) };
    if (action === 'wallet.open') this.walletOpen = true;
    if (action === 'wallet.close') this.walletOpen = false;
    if (action === 'wallet.refresh') this.syncing = true;
    if (action === 'tx.prepare') return { draftId: DRAFT };
    return {};
  }
}
function setup(service = new FakeService(), now?: () => number) {
  const host = new OffscreenWalletHost(service, EXTENSION, now);
  const ports = pair();
  const client = new WalletPortClient(ports.ui.asPort());
  assert.equal(host.accept(ports.host.asPort()), true);
  return { service, runtime: host, client, ...ports };
}

test('exact extension UI and offscreen URL allowlists reject content scripts and frames', () => {
  assert.equal(trustedSender(UI, EXTENSION, 'ui'), true);
  for (const path of ['index.html', 'index.html?popup=1', 'onboarding.html', 'onboarding.html?mode=create', 'onboarding.html?mode=restore', 'onboarding.html?mode=import'])
    assert.equal(trustedSender({ ...UI, url: `chrome-extension://${EXTENSION}/${path}` }, EXTENSION, 'ui'), true, path);
  for (const url of ['https://example.org/index.html', `chrome-extension://${EXTENSION}/index.html.evil`, `chrome-extension://${EXTENSION}/index.html?iframe=1`,
    `chrome-extension://${EXTENSION}/index.html#frame`, `chrome-extension://${EXTENSION}/onboarding.html?mode=unknown`, `chrome-extension://${EXTENSION}/offscreen.html`])
    assert.equal(trustedSender({ ...UI, url }, EXTENSION, 'ui'), false, url);
  for (const sender of [{ ...UI, id: 'b'.repeat(32) }, { ...UI, frameId: 1 }, { ...UI, origin: 'https://example.org' }, { ...UI, documentLifecycle: 'prerender' as const }])
    assert.equal(trustedSender(sender, EXTENSION, 'ui'), false);
  assert.equal(trustedSender(OFFSCREEN, EXTENSION, 'offscreen'), true);
  assert.equal(trustedSender({ ...OFFSCREEN, tab: { id: 1 } as chrome.tabs.Tab }, EXTENSION, 'offscreen'), false);
});

test('recovery markers accept only public hash and safe timestamp', () => {
  assert.deepEqual(validMarker({ txHash: HASH, createdAt: 10 }), { txHash: HASH, createdAt: 10 });
  assert.equal(validMarker(undefined), null);
  for (const marker of [{ txHash: HASH, createdAt: -1 }, { txHash: HASH, createdAt: NaN }, { txHash: 'bad', createdAt: 10 },
    { txHash: HASH, createdAt: 10, seed: 'must never persist' }]) assert.throws(() => validMarker(marker));
});

test('correlates out-of-order responses without serializing UI requests', async () => {
  const { service, client } = setup();
  const first = deferred(), second = deferred();
  service.handlers.set('wallet.list', () => first.promise); service.handlers.set('node.list', () => second.promise);
  const a = client.request('wallet.list'), b = client.request('node.list'); await tick();
  second.resolve({ nodes: [] }); assert.deepEqual(await b, { nodes: [] });
  first.resolve({ wallets: [] }); assert.deepEqual(await a, { wallets: [] }); client.close();
});

test('popup disconnect preserves unlocked service and sync for a new UI port', async () => {
  const { service, runtime, client } = setup();
  await client.request('wallet.open', {}, null); await client.request('wallet.refresh', {}, VAULT); client.close(); await tick();
  assert.equal(service.walletOpen, true); assert.equal(service.syncing, true);
  assert.equal(service.calls.some(call => call.action === 'wallet.close'), false);
  const next = pair(); const reopened = new WalletPortClient(next.ui.asPort()); runtime.accept(next.host.asPort());
  assert.deepEqual(await reopened.request('status'), { walletOpen: true, syncing: true, vaultId: VAULT }); reopened.close();
});

test('a replacement offscreen host starts locked and never auto-unlocks', async () => {
  const original = setup(); await original.client.request('wallet.open', {}, null); original.client.close();
  const replacement = setup(); assert.deepEqual(await replacement.client.request('status'), { walletOpen: false, syncing: false });
  assert.deepEqual(replacement.service.calls.map(call => call.action), ['status']); replacement.client.close();
});

test('disconnect rejects unknown confirmation once, without cancel, retry or relay interruption', async () => {
  const { service, client } = setup();
  await client.request('wallet.open', {}, null); await client.request('tx.prepare', {}, VAULT);
  const relay = deferred(); service.handlers.set('tx.confirm', () => relay.promise);
  const confirmation = client.request('tx.confirm', { draftId: DRAFT }, VAULT);
  const rejected = assert.rejects(confirmation, { code: 'TRANSPORT_LOST' }); await tick();
  client.close(); await rejected;
  assert.equal(service.calls.filter(call => call.action === 'tx.confirm').length, 1);
  assert.equal(service.calls.some(call => call.action === 'tx.cancel' || call.action === 'wallet.close'), false);
  relay.resolve({ txHash: HASH }); await tick();
  assert.equal(service.calls.filter(call => call.action === 'tx.confirm').length, 1);
  await assert.rejects(client.request('tx.confirm', { draftId: DRAFT }, VAULT), { code: 'TRANSPORT_LOST' });
});

test('disconnect cancels its unconfirmed review, including prepare completing after disconnect', async () => {
  const first = setup(); await first.client.request('wallet.open', {}, null); await first.client.request('tx.prepare', {}, VAULT); first.client.close(); await tick();
  assert.deepEqual(first.service.calls.filter(call => call.action === 'tx.cancel').map(call => call.params), [{ draftId: DRAFT }]);
  const late = setup(); await late.client.request('wallet.open', {}, null); const prepared = deferred(); late.service.handlers.set('tx.prepare', () => prepared.promise);
  const request = late.client.request('tx.prepare', {}, VAULT); const rejected = assert.rejects(request, { code: 'TRANSPORT_LOST' }); await tick();
  late.client.close(); await rejected; prepared.resolve({ draftId: DRAFT }); await tick();
  assert.equal(late.service.calls.filter(call => call.action === 'tx.cancel').length, 1);
});

test('transaction reviews cannot be consumed by another UI port', async () => {
  const { runtime, service, client } = setup(); await client.request('wallet.open', {}, null); await client.request('tx.prepare', {}, VAULT);
  const ports = pair(); const other = new WalletPortClient(ports.ui.asPort()); runtime.accept(ports.host.asPort());
  await assert.rejects(other.request('tx.confirm', { draftId: DRAFT }, VAULT), { code: 'DRAFT_NOT_FOUND' });
  assert.equal(service.calls.some(call => call.action === 'tx.confirm'), false); other.close(); client.close();
});

test('seed result after disconnection is discarded and never sent or retained for another port', async () => {
  const setupResult = setup(); const { service, client, host: serverPort } = setupResult; await client.request('wallet.open', {}, null);
  const seed = deferred(); service.handlers.set('wallet.seed', () => seed.promise);
  const response = client.request('wallet.seed', {}, VAULT); const rejected = assert.rejects(response, { code: 'TRANSPORT_LOST' }); await tick();
  client.close(); await rejected; seed.resolve({ seed: 'sensitive never delivered' }); await tick();
  assert.equal(JSON.stringify(serverPort.sent).includes('sensitive'), false);
});

test('status polling does not extend five-minute inactivity, while activity does', async () => {
  let time = 100;
  const service = new FakeService(); const runtime = new OffscreenWalletHost(service, EXTENSION, () => time);
  const ports = pair(); const client = new WalletPortClient(ports.ui.asPort()); runtime.accept(ports.host.asPort());
  await client.request('wallet.open', {}, null);
  time += SESSION_IDLE_MS - 1; await client.request('status'); await runtime.checkIdle(); assert.equal(service.walletOpen, true);
  client.activity(); await tick(); time += SESSION_IDLE_MS - 1; await runtime.checkIdle(); assert.equal(service.walletOpen, true);
  time += 2; await client.request('status'); await runtime.checkIdle(); await tick(); assert.equal(service.walletOpen, false);
  assert.equal(service.calls.filter(call => call.action === 'wallet.close').length, 1); client.close();
});

test('expired session waits for explicit sync checkpoint, then closes while no UI remains', async () => {
  let time = 1;
  const service = new FakeService(); const runtime = new OffscreenWalletHost(service, EXTENSION, () => time);
  const ports = pair(); const client = new WalletPortClient(ports.ui.asPort()); runtime.accept(ports.host.asPort());
  await client.request('wallet.open', {}, null); await client.request('wallet.refresh', {}, VAULT); client.close(); await tick();
  time += SESSION_IDLE_MS + 1; await runtime.checkIdle(); assert.equal(service.walletOpen, true);
  service.syncing = false; await runtime.checkIdle(); assert.equal(service.walletOpen, false);
});

test('inactivity never interrupts already-begun confirmation; closes after relay settles', async () => {
  let time = 1;
  const service = new FakeService(); const runtime = new OffscreenWalletHost(service, EXTENSION, () => time);
  const ports = pair(); const client = new WalletPortClient(ports.ui.asPort()); runtime.accept(ports.host.asPort());
  await client.request('wallet.open', {}, null); await client.request('tx.prepare', {}, VAULT); const relay = deferred(); service.handlers.set('tx.confirm', () => relay.promise);
  const response = client.request('tx.confirm', { draftId: DRAFT }, VAULT); await tick();
  time += SESSION_IDLE_MS + 1; await runtime.checkIdle(); assert.equal(service.walletOpen, true);
  await assert.rejects(client.request('wallet.seed', {}, VAULT), { code: 'SESSION_EXPIRED' });
  relay.resolve({ txHash: HASH }); await response; await tick(); assert.equal(service.walletOpen, false); client.close();
});

test('request and connection capacity is bounded and unauthorized ports never reach service', async () => {
  const service = new FakeService(); const runtime = new OffscreenWalletHost(service, EXTENSION);
  const clients: WalletPortClient[] = [];
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const ports = pair(); clients.push(new WalletPortClient(ports.ui.asPort())); assert.equal(runtime.accept(ports.host.asPort()), true);
  }
  const extra = pair(); assert.equal(runtime.accept(extra.host.asPort()), false); assert.equal(extra.host.disconnected, true);
  const gate = deferred(); service.handlers.set('node.list', () => gate.promise);
  const requests = Array.from({ length: MAX_PENDING_REQUESTS }, () => clients[0].request('node.list')); await tick();
  await assert.rejects(clients[0].request('node.list'), { code: 'QUEUE_FULL' });
  gate.resolve({ nodes: [] }); await Promise.all(requests); for (const client of clients) client.close();
  const forbidden = pair(); forbidden.host.sender = { ...UI, url: 'https://example.org/' };
  assert.equal(runtime.accept(forbidden.host.asPort()), false);
});

test('duplicate request IDs disconnect the client instead of replaying an operation', async () => {
  const service = new FakeService(); const runtime = new OffscreenWalletHost(service, EXTENSION); const ports = pair(); runtime.accept(ports.host.asPort());
  const request = { kind: 'request', id: 1, action: 'wallet.open', params: {}, expectedVaultId: null };
  ports.ui.postMessage(request); await tick(); ports.ui.postMessage(request); await tick();
  assert.equal(ports.ui.disconnected, true); assert.equal(service.calls.filter(call => call.action === 'wallet.open').length, 1);
});

test('large encrypted import and export use bounded acknowledged chunks, not oversized Chrome messages', async () => {
  const { client, service, ui, host } = setup(); await client.request('wallet.open', {}, null); const content = 'x'.repeat(MAX_MESSAGE_CHARS + 100);
  service.handlers.set('wallet.import', async params => { assert.equal(params.content, content); return { imported: true }; });
  service.handlers.set('wallet.export', async () => ({ filename: 'wallet.json', content }));
  assert.deepEqual(await client.request('wallet.import', { content }), { imported: true });
  assert.deepEqual(await client.request('wallet.export', {}, VAULT), { filename: 'wallet.json', content });
  for (const message of [...ui.sent, ...host.sent]) assert.ok(JSON.stringify(message).length <= MAX_MESSAGE_CHARS);
  client.close(); assert.equal(ui.onMessage.listeners.size, 0); assert.equal(host.onMessage.listeners.size, 0);
});

test('malformed or oversized chunk streams fail closed with no service call', async () => {
  const ports = pair(); const received: unknown[] = [];
  const wire = new PortWire(ports.host.asPort(), value => received.push(value), () => {});
  ports.ui.postMessage({ kind: 'wire-start', id: 1, length: 180_100_000 }); await tick();
  assert.equal(ports.ui.disconnected, true); assert.deepEqual(received, []); wire.close();
});

async function backgroundFixture() {
  let listener!: (message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean;
  let contexts: unknown[] = []; let created = 0; let marker: unknown; let writes = 0; let reads = 0; const tabs: chrome.tabs.Tab[] = [];
  let accessBlock: { entered: ReturnType<typeof deferred<void>>; gate: ReturnType<typeof deferred<void>> } | undefined;
  let removeBlock: typeof accessBlock;
  const replaceOffscreen = (documentId: string) => { contexts = [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: OFFSCREEN.url, documentId }]; };
  const createGate = deferred<void>();
  const chromeMock = {
    runtime: { id: EXTENSION, getURL: (path: string) => `chrome-extension://${EXTENSION}/${path}`,
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' }, getContexts: async () => contexts,
      onMessage: { addListener: (fn: typeof listener) => { listener = fn; } }, onInstalled: { addListener: () => {} } },
    offscreen: { Reason: { WORKERS: 'WORKERS' }, createDocument: async (options: { reasons: string[] }) => {
      assert.deepEqual([...options.reasons], ['WORKERS']); created++; await createGate.promise; replaceOffscreen(OFFSCREEN.documentId);
    } },
    storage: { local: { get: async () => { reads++; return { unresolvedTransfer: marker }; }, setAccessLevel: async () => {
      const block = accessBlock; accessBlock = undefined; if (block) { block.entered.resolve(); await block.gate.promise; }
    },
      set: async (value: { unresolvedTransfer: unknown }) => { writes++; marker = structuredClone(value.unresolvedTransfer); },
      remove: async () => { const block = removeBlock; removeBlock = undefined; if (block) { block.entered.resolve(); await block.gate.promise; } writes++; marker = undefined; } }, session: { remove: async () => {} } },
    tabs: { query: async () => tabs, update: async () => {}, create: async (tab: { url: string }) => { tabs.push({ id: tabs.length + 1, windowId: 1, ...tab } as chrome.tabs.Tab); } },
    windows: { update: async () => {} },
  };
  const bundle = await build({ entryPoints: ['src/runtime/transport-background.ts'], bundle: true, format: 'iife', platform: 'browser', write: false });
  vm.runInNewContext(bundle.outputFiles[0].text, { chrome: chromeMock, URL, Error, Object, Number, Set });
  async function message(action: string, sender: unknown = UI, extra: Record<string, unknown> = {}) {
    return new Promise<Record<string, unknown> | undefined>(resolve => {
      const actor = sender && typeof sender === 'object' && 'url' in sender && sender.url === OFFSCREEN.url && action.startsWith('marker.')
        ? { documentId: 'documentId' in sender ? sender.documentId : undefined } : {};
      const kept = listener({ channel: CONTROL_CHANNEL, action, ...actor, ...extra }, sender, response => resolve(structuredClone(response) as Record<string, unknown>));
      if (!kept) resolve(undefined);
    });
  }
  return { message, createGate, tabs, created: () => created, writes: () => writes, reads: () => reads, marker: () => marker, replaceOffscreen,
    blockAccess: () => { accessBlock = { entered: deferred<void>(), gate: deferred<void>() }; return accessBlock; },
    blockRemove: () => { removeBlock = { entered: deferred<void>(), gate: deferred<void>() }; return removeBlock; } };
}

test('background ensure is single-flight and uses WORKERS; marker writes require exact offscreen sender', async () => {
  const fixture = await backgroundFixture();
  const a = fixture.message('ensureOffscreen'), b = fixture.message('ensureOffscreen'); await tick(); assert.equal(fixture.created(), 1);
  fixture.createGate.resolve(); assert.equal((await a)?.ok, true); assert.equal((await b)?.ok, true);
  assert.equal((await fixture.message('ensureOffscreen'))?.ok, true); assert.equal(fixture.created(), 1);
  assert.equal(await fixture.message('marker.write', UI, { value: { txHash: HASH, createdAt: 1 } }), undefined);
  assert.equal(await fixture.message('marker.write', { ...OFFSCREEN, url: 'https://example.org' }, { value: null }), undefined);
  assert.equal(fixture.writes(), 0);
  assert.equal((await fixture.message('marker.write', OFFSCREEN, { value: { txHash: HASH, createdAt: 1 } }))?.ok, true);
  assert.deepEqual((await fixture.message('marker.read'))?.result, { txHash: HASH, createdAt: 1 });
  assert.equal((await fixture.message('marker.write', OFFSCREEN, { value: { txHash: HASH, createdAt: 1, seed: 'forbidden' } }))?.ok, false);
  assert.equal(fixture.writes(), 1);
  assert.equal((await fixture.message('marker.write', OFFSCREEN, { value: null }))?.ok, true);
  assert.equal(fixture.marker(), undefined);
});

test('stale offscreen clears and overwrites cannot race a replacement marker across awaited access setup', async () => {
  for (const oldValue of [null, { txHash: HASH, createdAt: 1 }]) {
    const fixture = await backgroundFixture(); fixture.replaceOffscreen(OFFSCREEN.documentId);
    assert.equal((await fixture.message('marker.write', OFFSCREEN, { value: { txHash: HASH, createdAt: 1 } }))?.ok, true);
    const block = fixture.blockAccess();
    const oldWrite = fixture.message('marker.write', OFFSCREEN, { value: oldValue }); await block.entered.promise;
    const replacement = { ...OFFSCREEN, documentId: 'offscreen-document-B' }; fixture.replaceOffscreen(replacement.documentId);
    let readSettled = false, writeSettled = false;
    const nextRead = fixture.message('marker.read', replacement).then(result => { readSettled = true; return result; });
    const nextMarker = { txHash: 'c'.repeat(64), createdAt: 2 };
    const nextWrite = fixture.message('marker.write', replacement, { value: nextMarker }).then(result => { writeSettled = true; return result; });
    await tick(); assert.equal(readSettled, false); assert.equal(writeSettled, false); assert.equal(fixture.reads(), 0);
    block.gate.resolve();
    assert.equal((await oldWrite)?.ok, false, 'Dead document must be rejected after awaited access setup');
    assert.deepEqual((await nextRead)?.result, { txHash: HASH, createdAt: 1 });
    assert.equal((await nextWrite)?.ok, true); assert.deepEqual(fixture.marker(), nextMarker); assert.equal(fixture.writes(), 2);
  }
});

test('marker queue stays held until an already-issued stale clear actually settles, including new reads', async () => {
  const fixture = await backgroundFixture(); fixture.replaceOffscreen(OFFSCREEN.documentId);
  await fixture.message('marker.write', OFFSCREEN, { value: { txHash: HASH, createdAt: 1 } });
  const block = fixture.blockRemove(); const oldClear = fixture.message('marker.write', OFFSCREEN, { value: null }); await block.entered.promise;
  const replacement = { ...OFFSCREEN, documentId: 'offscreen-document-B' }; fixture.replaceOffscreen(replacement.documentId);
  let readSettled = false;
  const nextRead = fixture.message('marker.read', replacement).then(result => { readSettled = true; return result; });
  const nextMarker = { txHash: 'c'.repeat(64), createdAt: 2 };
  const nextWrite = fixture.message('marker.write', replacement, { value: nextMarker });
  await tick(); assert.equal(readSettled, false); assert.equal(fixture.reads(), 0); assert.equal(fixture.writes(), 1);
  block.gate.resolve(); assert.equal((await oldClear)?.ok, true); assert.equal((await nextRead)?.result, null);
  assert.equal((await nextWrite)?.ok, true); assert.deepEqual(fixture.marker(), nextMarker);
});

test('offscreen marker capability requires a current document ID, not just its extension URL', async () => {
  const fixture = await backgroundFixture(); fixture.replaceOffscreen(OFFSCREEN.documentId);
  for (const documentId of [undefined, 'forged-or-obsolete-document']) {
    assert.equal((await fixture.message('marker.read', { ...OFFSCREEN, documentId }))?.ok, false);
    assert.equal((await fixture.message('marker.write', { ...OFFSCREEN, documentId }, { value: null }))?.ok, false);
  }
  assert.equal(fixture.reads(), 0); assert.equal(fixture.writes(), 0);
});

test('Chrome offscreen sender without native documentId uses its fixed bootstrap actor, not a replacement document', async () => {
  const fixture = await backgroundFixture(); fixture.replaceOffscreen(OFFSCREEN.documentId);
  const chromeSender = { ...OFFSCREEN, documentId: undefined };
  assert.equal((await fixture.message('offscreen.identify', chromeSender))?.result, OFFSCREEN.documentId);
  assert.equal(await fixture.message('offscreen.identify', UI), undefined, 'Only the actual offscreen document may obtain its bootstrap actor');
  const marker = { txHash: HASH, createdAt: 1 };
  assert.equal((await fixture.message('marker.write', chromeSender, { documentId: OFFSCREEN.documentId, value: marker }))?.ok, true);
  assert.deepEqual((await fixture.message('marker.read', chromeSender, { documentId: OFFSCREEN.documentId }))?.result, marker);
  fixture.replaceOffscreen('offscreen-document-B');
  assert.equal((await fixture.message('marker.write', chromeSender, { documentId: OFFSCREEN.documentId, value: null }))?.ok, false);
  assert.equal((await fixture.message('marker.write', OFFSCREEN, { documentId: 'offscreen-document-B', value: null }))?.ok, false, 'Native and declared IDs must agree when native ID exists');
  assert.deepEqual(fixture.marker(), marker);
});

test('background controls cannot invoke wallet operations or accept arbitrary navigation', async () => {
  const fixture = await backgroundFixture();
  assert.equal(await fixture.message('tx.confirm', UI, { draftId: DRAFT }), undefined);
  assert.equal(await fixture.message('openOnboarding', UI, { mode: 'https://evil.example' }), undefined);
  assert.equal(await fixture.message('openOnboarding', OFFSCREEN, { mode: 'create' }), undefined);
  assert.equal((await fixture.message('openOnboarding', UI, { mode: 'restore' }))?.ok, true);
  assert.equal((await fixture.message('openOnboarding', UI, { mode: 'restore' }))?.ok, true);
  assert.equal(fixture.tabs.length, 1); assert.equal(fixture.tabs[0].url, `chrome-extension://${EXTENSION}/onboarding.html?mode=restore`);
  assert.equal((await fixture.message('openWalletWindow'))?.ok, true); assert.equal(fixture.tabs.length, 2);
});

test('wallet tools are identity-scoped actions, never neutral, open, poll or read-only', () => {
  for (const action of ['address.label', 'contact.add', 'contact.edit', 'contact.delete', 'message.sign', 'message.verify', 'tx.key',
    'node.custom.add', 'node.custom.remove']) {
    assert.equal(ACTIONS.has(action), true, action);
    for (const set of [NEUTRAL_ACTIONS, OPEN_ACTIONS, POLL_ACTIONS, READ_ACTIONS]) assert.equal(set.has(action), false, action);
  }
  const prepare = (params: Record<string, unknown>) => ({ kind: 'request', id: 1, action: 'tx.prepare', params, expectedVaultId: VAULT });
  assert.equal(validRequest(prepare({ accountIndex: 0, address: 'x', amount: '1', priority: 0, subtractFee: true })), true);
  for (const subtractFee of [[true], { value: true }, null]) assert.equal(validRequest(prepare({ subtractFee })), false);
  assert.equal(validRequest({ kind: 'request', id: 1, action: 'wallet.tools', params: {}, expectedVaultId: VAULT }), false);
});

test('wallet management actions are identity-scoped; delete, like close, leaves no wallet identity', () => {
  for (const action of ['wallet.rename', 'wallet.settings', 'wallet.keys', 'wallet.delete', 'wallet.rescan', 'address.integrated']) {
    assert.equal(ACTIONS.has(action), true, action);
    for (const set of [NEUTRAL_ACTIONS, OPEN_ACTIONS, POLL_ACTIONS, READ_ACTIONS]) assert.equal(set.has(action), false, action);
  }
  assert.deepEqual([...CLOSE_ACTIONS].sort(), ['wallet.close', 'wallet.delete']);
  for (const action of ['wallet.close', 'wallet.delete']) {
    assert.equal(validResultIdentity(action, VAULT, null), true, action);
    assert.equal(validResultIdentity(action, VAULT, VAULT), false, `${action} must not leave the wallet open`);
    assert.equal(validResultIdentity(action, null, null), false, `${action} needs a rendered identity`);
  }
  for (const action of ['wallet.rename', 'wallet.settings', 'wallet.keys', 'wallet.rescan', 'address.integrated']) {
    assert.equal(validResultIdentity(action, VAULT, VAULT), true, action);
    assert.equal(validResultIdentity(action, VAULT, null), false, action);
  }
});

test('auto-lock uses the open wallet setting (1 to 60 minutes); anything else is the five-minute default', () => {
  assert.equal(sessionIdleMs({ walletOpen: true, autoLockMinutes: 1 }), 60_000);
  assert.equal(sessionIdleMs({ walletOpen: true, autoLockMinutes: 60 }), MAX_SESSION_IDLE_MS);
  for (const minutes of [undefined, 0, 2, 61, 120, '15', Infinity, NaN]) assert.equal(sessionIdleMs({ walletOpen: true, autoLockMinutes: minutes }), SESSION_IDLE_MS, String(minutes));
  assert.equal(sessionIdleMs(null), SESSION_IDLE_MS);
});

class SettingsService extends FakeService {
  minutes: number | undefined;
  async request(action: string, params: Record<string, unknown> = {}) {
    if (action === 'status') { this.calls.push({ action, params }); return { walletOpen: this.walletOpen, syncing: this.syncing,
      ...(this.walletOpen ? { vaultId: VAULT, autoLockMinutes: this.minutes } : {}) }; }
    if (action === 'wallet.settings') {
      this.calls.push({ action, params });
      if (typeof params.autoLockMinutes === 'number') this.minutes = params.autoLockMinutes;
      return { autoLockMinutes: this.minutes ?? 5, confirmWithPassword: false };
    }
    return super.request(action, params);
  }
}
test('a one-minute wallet locks after one idle minute; polls never extend it', async () => {
  let time = 1;
  const service = new SettingsService(); service.minutes = 1;
  const runtime = new OffscreenWalletHost(service, EXTENSION, () => time);
  const ports = pair(); const client = new WalletPortClient(ports.ui.asPort()); runtime.accept(ports.host.asPort());
  await client.request('wallet.open', {}, null);
  time += 60_000 - 1; await client.request('status'); await runtime.checkIdle(); assert.equal(service.walletOpen, true);
  time += 2; await client.request('status'); await runtime.checkIdle(); await tick(); assert.equal(service.walletOpen, false);
  client.activity(); await tick(); await client.request('wallet.open', {}, null);
  time += 60_001; await assert.rejects(client.request('wallet.seed', {}, VAULT), { code: 'SESSION_EXPIRED', message: /after one minute without interaction/ });
  client.close();
});

test('a sixty-minute setting keeps the wallet open past five minutes, then locks; the next wallet gets its own limit', async () => {
  let time = 1;
  const service = new SettingsService();
  const runtime = new OffscreenWalletHost(service, EXTENSION, () => time);
  const ports = pair(); const client = new WalletPortClient(ports.ui.asPort()); runtime.accept(ports.host.asPort());
  const open = async (minutes?: number) => { service.minutes = minutes; client.activity(); await tick(); await client.request('wallet.open', {}, null); };
  await open();
  assert.deepEqual(await client.request('wallet.settings', { autoLockMinutes: 60 }, VAULT), { autoLockMinutes: 60, confirmWithPassword: false });
  time += SESSION_IDLE_MS + 1; await runtime.checkIdle(); assert.equal(service.walletOpen, true);
  time += MAX_SESSION_IDLE_MS - SESSION_IDLE_MS; await runtime.checkIdle(); await tick(); assert.equal(service.walletOpen, false);
  // A wallet without its own setting gets the five-minute default again.
  await open();
  time += SESSION_IDLE_MS - 1; await runtime.checkIdle(); assert.equal(service.walletOpen, true);
  time += 2; await runtime.checkIdle(); await tick(); assert.equal(service.walletOpen, false);
  // Delete ends the session like close: no expiry is carried over to the next unlock.
  await open(60);
  service.handlers.set('wallet.delete', async () => { service.walletOpen = false; return {}; });
  assert.deepEqual(await client.request('wallet.delete', { password: 'x' }, VAULT), {});
  service.handlers.delete('wallet.delete');
  await open(15);
  time += SESSION_IDLE_MS + 1; await runtime.checkIdle(); assert.equal(service.walletOpen, true);
  time += 10 * 60_000; await runtime.checkIdle(); await tick(); assert.equal(service.walletOpen, false);
  client.close();
});
