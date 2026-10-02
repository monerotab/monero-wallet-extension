import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { WalletService, type TransferMarker } from './service.ts';
import { OffscreenWalletHost } from './offscreen-host.ts';
import { WalletPortClient } from './transport-client.ts';
import { PORT_NAME, type RuntimePort } from './transport.ts';
import type { EngineClient } from './engine-client.ts';
import type { Status, Snapshot, Draft } from '../lib/types.ts';

// Regression fixtures use the real service, AES/IDB vault, host and port client.
// Native keys, balances, signing, relay and every network response are synthetic.
const EXTENSION = 'a'.repeat(32);
const ADDRESS = '4' + '1'.repeat(94);
const HASH = 'b'.repeat(64);
const PASSWORD = 'identity-test-password';
const originalFetch = globalThis.fetch;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function tick() { await new Promise(resolve => setImmediate(resolve)); }
class Event<T extends (...args: never[]) => unknown> {
  listeners = new Set<T>();
  addListener = (listener: T) => { this.listeners.add(listener); };
  removeListener = (listener: T) => { this.listeners.delete(listener); };
  emit(...args: Parameters<T>) { for (const listener of this.listeners) listener(...args); }
}
class Port {
  name = PORT_NAME;
  sender = { id: EXTENSION, url: `chrome-extension://${EXTENSION}/index.html?popup=1`, origin: `chrome-extension://${EXTENSION}`, frameId: 0 };
  onMessage = new Event<(value: unknown) => void>();
  onDisconnect = new Event<() => void>();
  peer!: Port;
  disconnected = false;
  postMessage(value: unknown) {
    if (this.disconnected) throw new Error('Synthetic port closed');
    const copy: unknown = structuredClone(value);
    queueMicrotask(() => { if (!this.disconnected && !this.peer.disconnected) this.peer.onMessage.emit(copy); });
  }
  disconnect() {
    if (this.disconnected) return;
    this.disconnected = true; this.peer.disconnected = true;
    this.onDisconnect.emit(); this.peer.onDisconnect.emit();
  }
  asPort() { return this as unknown as RuntimePort; }
}
interface NativeState { password: string; network: number; seed: string }
let nativeSerial = 0;
class MemoryEngine {
  disposed = false;
  synced = false;
  state?: NativeState;
  calls: string[] = [];
  drafts = new Map<string, Draft>();
  dataBlock?: { entered: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred> };
  relayBlock?: { entered: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred> };
  relayFails = false;
  onFatal?: () => void;
  onProgress?: EngineClient['onProgress'];
  async call<T = unknown>(_id: string, method: string, args: unknown[] = []): Promise<T> {
    assert.equal(this.disposed, false);
    this.calls.push(method);
    let value: unknown;
    switch (method) {
      case 'extInit': value = { version: 'synthetic identity fixture' }; break;
      case 'createWalletFull': {
        const config = args[0] as { password: string; networkType: number };
        this.state = { password: config.password, network: config.networkType, seed: `synthetic-seed-${++nativeSerial}` }; break;
      }
      case 'openWalletData': this.state = JSON.parse(new TextDecoder().decode(args[3] as Uint8Array)) as NativeState; break;
      case 'getNetworkType': value = this.state!.network; break;
      case 'getRestoreHeight': value = 0; break;
      case 'getData': {
        const block = this.dataBlock; this.dataBlock = undefined;
        if (block) { block.entered.resolve(); await block.gate.promise; }
        value = [new TextEncoder().encode(JSON.stringify(this.state)), new Uint8Array([1, 2, 3])]; break;
      }
      case 'getSeed': value = this.state!.seed; break;
      case 'getHeight': case 'getDaemonHeight': value = 10; break;
      case 'isSynced': case 'isDaemonSynced': value = this.synced; break;
      case 'sync': this.synced = true; break;
      case 'extSnapshot': value = {
        balance: '9999999999999', unlockedBalance: '9999999999999', blocksToUnlock: 0,
        height: 10, synced: this.synced, network: 'mainnet', address: ADDRESS,
        accounts: [], addresses: [], transactions: [], contacts: [],
      } satisfies Snapshot; break;
      case 'extPrepare': {
        const params = args[0] as { amount: string; address: string };
        const draft: Draft = { draftId: crypto.randomUUID(), amount: params.amount, address: params.address,
          fee: '10', txHash: HASH, expiresAt: Date.now() + 300_000 };
        this.drafts.set(draft.draftId, draft); value = draft; break;
      }
      case 'extConfirm': {
        const draft = this.drafts.get(args[0] as string); assert.ok(draft);
        this.drafts.delete(draft.draftId);
        if (this.relayBlock) { this.relayBlock.entered.resolve(); await this.relayBlock.gate.promise; }
        if (this.relayFails) throw Object.assign(new Error('Synthetic unknown broadcast'), { code: 'RELAY_UNCERTAIN' });
        value = { txHash: draft.txHash }; break;
      }
      case 'extCancel': this.drafts.delete(args[0] as string); break;
      case 'extConfigureNode': case 'extInvalidateDrafts': this.drafts.clear(); break;
      case 'addListener': case 'extNetwork': case 'moneroUtilsValidateAddress': break;
      default: throw new Error(`Unexpected synthetic native method: ${method}`);
    }
    return value as T;
  }
  dispose() { this.disposed = true; this.state = undefined; }
}
beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), configurable: true });
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://xmr-node.cakewallet.com:18081/json_rpc');
    assert.equal(JSON.parse(init!.body as string).method, 'get_info');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'extension-node-check',
      result: { status: 'OK', nettype: 'mainnet', height: 10, synchronized: true } }));
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });
function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const engines: MemoryEngine[] = [];
  let owned = false;
  let marker: TransferMarker | null = null;
  const service = new WalletService({
    engineFactory: () => { const engine = new MemoryEngine(); engines.push(engine); return engine as unknown as EngineClient; },
    claimLock: async () => { assert.equal(owned, false); owned = true; return () => { assert.equal(owned, true); owned = false; }; },
    getPendingTransfer: async () => marker && { ...marker },
    setPendingTransfer: async value => { assert.equal(owned, true); marker = value && { ...value }; },
  });
  const host = new OffscreenWalletHost(service, EXTENSION);
  const clients: WalletPortClient[] = [];
  const connect = () => {
    const ui = new Port(), engine = new Port(); ui.peer = engine; engine.peer = ui;
    const client = new WalletPortClient(ui.asPort());
    assert.equal(host.accept(engine.asPort()), true); clients.push(client); return client;
  };
  t.after(async () => { for (const client of clients) client.close(); await tick(); service.dispose(); });
  const current = () => engines.at(-1)!;
  const create = async (client: WalletPortClient, filename: string) => {
    await client.request('wallet.create', { filename, password: PASSWORD, network: 'mainnet' }, null);
    const status = await client.request<Status>('status'); assert.ok(status.vaultId); return status.vaultId;
  };
  const sync = async (client: WalletPortClient, id: string) => {
    await client.request('node.select', { nodeId: 'cake-mainnet', acknowledgePrivacy: true }, id);
    await client.request('wallet.refresh', {}, id);
    await (service as unknown as { syncTask: Promise<void> }).syncTask;
    assert.equal((await client.request<Status>('status')).synced, true);
  };
  return { service, host, connect, current, create, sync, marker: () => marker };
}
const transfer = { accountIndex: 0, address: ADDRESS, amount: '1', priority: 0 };

test('a recovery clear submitted DURING relay is rejected, not deferred until an uncertain relay ends', async t => {
  const f = fixture(t), a = f.connect(), b = f.connect();
  const id = await f.create(a, 'identity-active-relay-wallet'); await f.sync(a, id);
  const draft = await a.request<Draft>('tx.prepare', transfer, id);
  const engine = f.current(); const block = { entered: deferred(), gate: deferred() };
  engine.relayBlock = block; engine.relayFails = true; t.after(() => block.gate.resolve());
  const confirmation = assert.rejects(a.request('tx.confirm', { draftId: draft.draftId }, id), { code: 'RELAY_UNCERTAIN' });
  await block.entered.promise;
  const resolution = assert.rejects(b.request('tx.resolve', { txHash: HASH }), { code: 'RELAY_IN_PROGRESS' });
  // Attach a rejection handler before yielding so a deliberately failing regression
  // reports cleanly rather than surfacing as an unhandled rejection.
  void resolution.catch(() => undefined);
  await tick(); block.gate.resolve(); await confirmation; await resolution;
  assert.equal(f.marker()?.txHash, HASH);
});

test('stale view cannot reveal seed, read another receiving snapshot, prepare, or close a replacement wallet', async t => {
  const f = fixture(t), a = f.connect(), b = f.connect();
  const idA = await f.create(a, 'identity-wallet-A');
  await b.request('wallet.close', {}, idA);
  const idB = await f.create(b, 'identity-wallet-B'); await f.sync(b, idB);
  const engineB = f.current(); const before = [...engineB.calls];
  // A background status poll observing B must not replace the identity supplied
  // by a still-rendered A screen or its outstanding event-handler closure.
  assert.equal((await a.request<Status>('status')).vaultId, idB);
  for (const [action, params] of [
    ['wallet.seed', {}], ['snapshot', { accountIndex: 0 }], ['tx.prepare', transfer], ['wallet.close', {}],
  ] as const) await assert.rejects(a.request(action, params, idA), { code: 'WALLET_CHANGED' });
  assert.deepEqual(engineB.calls, before, 'Identity refusal must precede all native calls');
  assert.deepEqual(await b.request('wallet.seed', {}, idB), { seed: engineB.state!.seed });
});

test('wallet identity is checked at dequeue after a queued close/open, not only before awaiting', async t => {
  const f = fixture(t), a = f.connect(), b = f.connect();
  const idB = await f.create(b, 'queue-wallet-B'); await b.request('wallet.close', {}, idB);
  const idA = await f.create(a, 'queue-wallet-A');
  const block = { entered: deferred(), gate: deferred() }; f.current().dataBlock = block;
  t.after(() => block.gate.resolve());
  const saving = a.request('wallet.save', {}, idA); await block.entered.promise;
  const closing = b.request('wallet.close', {}, idA);
  const opening = b.request('wallet.open', { vaultId: idB, password: PASSWORD }, null);
  const staleSeed = assert.rejects(a.request('wallet.seed', {}, idA), { code: 'WALLET_CHANGED' });
  await tick(); block.gate.resolve();
  await Promise.all([saving, closing, opening, staleSeed]);
  assert.equal((await b.request<Status>('status')).vaultId, idB);
  assert.equal(f.current().calls.includes('getSeed'), false);
});

test('scoped requests without an explicit rendered identity fail closed', async t => {
  const f = fixture(t), a = f.connect(); await f.create(a, 'missing-identity-wallet');
  for (const action of ['wallet.seed', 'wallet.export', 'wallet.save', 'wallet.close'])
    await assert.rejects(a.request(action), { code: 'WALLET_CHANGED' });
  assert.equal((await a.request<Status>('status')).walletOpen, true);
  assert.equal(f.current().calls.includes('getSeed'), false);
});

test('identity guard preserves one-shot unknown relay and its marker after owner disconnect', async t => {
  const f = fixture(t), a = f.connect(); const id = await f.create(a, 'identity-relay-wallet'); await f.sync(a, id);
  const draft = await a.request<Draft>('tx.prepare', transfer, id);
  const engine = f.current(); const block = { entered: deferred(), gate: deferred() };
  engine.relayBlock = block; engine.relayFails = true; t.after(() => block.gate.resolve());
  const confirmation = a.request('tx.confirm', { draftId: draft.draftId }, id);
  const lost = assert.rejects(confirmation, { code: 'TRANSPORT_LOST' });
  await block.entered.promise;
  assert.equal(f.marker()?.txHash, HASH, 'Public recovery marker must exist before native relay');
  a.close(); await lost; block.gate.resolve();
  await (f.service as unknown as { tail: Promise<unknown> }).tail; await tick();
  const reopened = f.connect();
  await assert.rejects(reopened.request('tx.prepare', transfer, id), { code: 'PENDING_TRANSFER' });
  assert.equal(f.marker()?.txHash, HASH);
  assert.equal(engine.calls.filter(method => method === 'extConfirm').length, 1);
  assert.equal((await reopened.request<Status>('status')).walletOpen, true);
});

test('stale or unscoped views cannot label, edit contacts, sign, verify or read tx keys of a replacement wallet', async t => {
  const f = fixture(t), a = f.connect(), b = f.connect();
  const idA = await f.create(a, 'identity-tools-A');
  await b.request('wallet.close', {}, idA);
  const idB = await f.create(b, 'identity-tools-B');
  const engineB = f.current(); const before = [...engineB.calls];
  for (const [action, params] of [
    ['address.label', { accountIndex: 0, addressIndex: 0, label: 'stale' }],
    ['contact.add', { address: ADDRESS, description: '' }],
    ['contact.edit', { index: 0, expectedAddress: ADDRESS, address: ADDRESS, description: '' }],
    ['contact.delete', { index: 0, expectedAddress: ADDRESS }],
    ['message.sign', { message: 'stale', accountIndex: 0, addressIndex: 0, mode: 'spend' }],
    ['message.verify', { message: 'stale', address: ADDRESS, signature: 'SigV2abc' }],
    ['tx.key', { txid: HASH }],
    ['tx.prepare', { ...transfer, subtractFee: true }],
  ] as const) {
    await assert.rejects(a.request(action, params, idA), { code: 'WALLET_CHANGED' }, action);
    await assert.rejects(a.request(action, params), { code: 'WALLET_CHANGED' }, `${action} without identity`);
  }
  assert.deepEqual(engineB.calls, before, 'Identity refusal must precede all native calls');
  assert.equal((await b.request<Status>('status')).vaultId, idB);
});

test('custom node add/remove are identity-scoped; a stale view cannot change or read another wallet\'s nodes', async t => {
  const f = fixture(t), a = f.connect(), b = f.connect();
  const idA = await f.create(a, 'identity-nodes-A');
  const added = await a.request<{ nodes: { id: string; kind: string; url: string }[] }>('node.custom.add', { name: 'A node', url: 'http://127.0.0.1:18081' }, idA);
  const nodeA = added.nodes.find(node => node.kind === 'custom')!;
  await b.request('wallet.close', {}, idA);
  const idB = await f.create(b, 'identity-nodes-B');
  const engineB = f.current(); const before = [...engineB.calls];
  for (const [action, params] of [
    ['node.custom.add', { name: 'Stale node', url: 'http://127.0.0.1:18089' }],
    ['node.custom.remove', { nodeId: nodeA.id }],
    ['node.select', { nodeId: nodeA.id, acknowledgePrivacy: true }],
  ] as const) {
    await assert.rejects(a.request(action, params, idA), { code: 'WALLET_CHANGED' }, action);
    await assert.rejects(a.request(action, params), { code: 'WALLET_CHANGED' }, `${action} without identity`);
  }
  assert.deepEqual(engineB.calls, before, 'Identity refusal must precede all native calls');
  // Wallet B never lists, checks or selects wallet A's custom node.
  const list = await b.request<{ nodes: { id: string }[] }>('node.list');
  assert.equal(list.nodes.some(node => node.id === nodeA.id), false);
  await assert.rejects(b.request('node.check', { nodeId: nodeA.id, acknowledgePrivacy: true }), { code: 'INVALID_NODE' });
  await assert.rejects(b.request('node.select', { nodeId: nodeA.id, acknowledgePrivacy: true }, idB), { code: 'INVALID_NODE' });
});

test('stale or unscoped views cannot rename, configure, reveal keys, rescan, integrate or delete a replacement wallet', async t => {
  const f = fixture(t), a = f.connect(), b = f.connect();
  const idA = await f.create(a, 'identity-manage-A');
  await b.request('wallet.close', {}, idA);
  const idB = await f.create(b, 'identity-manage-B');
  const engineB = f.current(); const before = [...engineB.calls];
  for (const [action, params] of [
    ['wallet.rename', { name: 'stale rename' }],
    ['wallet.settings', { autoLockMinutes: 60 }],
    ['wallet.keys', { password: PASSWORD }],
    ['wallet.seed', { password: PASSWORD }],
    ['wallet.rescan', { restoreHeight: 0 }],
    ['address.integrated', {}],
    ['wallet.delete', { password: PASSWORD }],
  ] as const) {
    await assert.rejects(a.request(action, params, idA), { code: 'WALLET_CHANGED' }, action);
    await assert.rejects(a.request(action, params), { code: 'WALLET_CHANGED' }, `${action} without identity`);
  }
  assert.deepEqual(engineB.calls, before, 'Identity refusal must precede all native calls');
  const status = await b.request<Status>('status');
  assert.equal(status.vaultId, idB); assert.equal(status.walletName, 'identity-manage-B'); assert.equal(status.autoLockMinutes, 5);
  assert.equal((await b.request<{ wallets: unknown[] }>('wallet.list')).wallets.length, 2);
});

test('wallet.delete ends with no wallet identity, like close; a wrong password keeps the wallet and its identity', async t => {
  const f = fixture(t), a = f.connect(), b = f.connect();
  const id = await f.create(a, 'identity-delete-wallet');
  await assert.rejects(a.request('wallet.delete', { password: 'not-the-password' }, id), { code: 'WRONG_PASSWORD' });
  assert.equal((await b.request<Status>('status')).vaultId, id);
  assert.deepEqual(await a.request('wallet.delete', { password: PASSWORD }, id), {});
  const status = await b.request<Status>('status');
  assert.equal(status.walletOpen, false); assert.equal(status.vaultId, undefined);
  assert.deepEqual((await b.request<{ wallets: unknown[] }>('wallet.list')).wallets, []);
  // The deleted identity is gone for every view.
  await assert.rejects(b.request('wallet.seed', { password: PASSWORD }, id), { code: 'WALLET_CHANGED' });
  await assert.rejects(a.request('wallet.delete', { password: PASSWORD }, id), { code: 'WALLET_CHANGED' });
});
