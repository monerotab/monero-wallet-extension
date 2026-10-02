import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { WalletService, type TransferMarker } from './service.ts';
import type { EngineClient } from './engine-client.ts';
import { RuntimeError } from './errors.ts';
import type { Status, Snapshot, Draft, NodeSelection, NodeApplied } from '../lib/types.ts';

// Exercise the real AES-GCM/PBKDF2/IndexedDB vault through the service. Only the
// native worker and browser lock manager are fakes; no network or funded wallet.
const OLD_PASSWORD = 'old-test-password';
const NEW_PASSWORD = 'new-test-password';
const ADDRESS = '4' + '1'.repeat(94);
const OTHER_ADDRESS = '8' + '2'.repeat(94);
const WRONG_NETWORK_ADDRESS = '5' + '3'.repeat(94);
const DEAD_ENGINE_ADDRESS = '4' + '9'.repeat(94);
const HASH = 'b'.repeat(64);
const OTHER_HASH = 'c'.repeat(64);
const originalFetch = globalThis.fetch;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
interface NativeState { password: string; network: number; restoreHeight: number; labels: string[]; contacts: { address: string; description: string }[] }

class FakeEngine {
  disposed = false;
  failDataOnce = false;
  failPasswordAfterMutation = false;
  onChangePassword?: () => void;
  synced = false;
  networkEnabled = false;
  relayFails = false;
  relayEntered = deferred();
  relayGate?: ReturnType<typeof deferred>;
  beforeRelay?: () => void;
  blockData?: { entered: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred> };
  drafts = new Map<string, Draft>();
  prepared: { amount: string; subtractFee?: boolean }[] = [];
  signed: unknown[][] = [];
  contactReadBackFails = false;
  daemonHeight = 10;
  outgoingPending = false;
  rescanGate?: ReturnType<typeof deferred>;
  aborted = false;
  rescans: number[][] = [];
  integratedCalls: unknown[][] = [];
  /** Worker network arguments: [method, nodeId|null, customOrigin?]. */
  nodeCalls: unknown[][] = [];
  calls: string[] = [];
  exported: Uint8Array[][] = [];
  state?: NativeState;
  onFatal?: () => void;
  onProgress?: EngineClient['onProgress'];
  async call<T = unknown>(_id: string, method: string, args: unknown[] = []): Promise<T> {
    assert.equal(this.disposed, false, 'Never call a disposed native worker');
    this.calls.push(method);
    let value: unknown;
    switch (method) {
      case 'extInit': value = { version: 'in-memory native test fixture' }; break;
      case 'createWalletFull': {
        const config = args[0] as { password: string; networkType: number; restoreHeight?: number };
        this.state = { password: config.password, network: config.networkType, restoreHeight: config.restoreHeight ?? 0, labels: ['Primary account'], contacts: [] };
        break;
      }
      case 'openWalletData': {
        const state = JSON.parse(decoder.decode(args[3] as Uint8Array)) as NativeState;
        if (state.password !== args[1]) throw new RuntimeError('Synthetic native password differs.', 'WASM_ERROR');
        this.state = state;
        break;
      }
      case 'changePassword': {
        assert.equal(this.state?.password, args[0]);
        this.state!.password = args[1] as string;
        this.onChangePassword?.();
        if (this.failPasswordAfterMutation) throw new RuntimeError('Synthetic uncertain native mutation.', 'WASM_ERROR');
        break;
      }
      case 'getData': {
        if (this.blockData) {
          const block = this.blockData; this.blockData = undefined;
          block.entered.resolve(); await block.gate.promise;
        }
        if (this.failDataOnce) { this.failDataOnce = false; throw new RuntimeError('Synthetic nonfatal native export failure.', 'WASM_ERROR'); }
        const data = [encoder.encode(JSON.stringify(this.state)), new Uint8Array([1, 2, 3])];
        this.exported.push(data); value = data;
        break;
      }
      case 'getNetworkType': value = this.state!.network; break;
      case 'getRestoreHeight': value = this.state!.restoreHeight; break;
      case 'getHeight': value = this.synced ? 10 : 0; break;
      case 'getDaemonHeight': value = this.daemonHeight; break;
      case 'isSynced': case 'isDaemonSynced': value = this.synced; break;
      case 'sync': this.synced = true; break;
      case 'extNetwork': this.networkEnabled = typeof args[0] === 'string'; this.nodeCalls.push(['extNetwork', ...args]); break;
      case 'extConfigureNode': this.nodeCalls.push(['extConfigureNode', ...args]); this.drafts.clear(); break;
      case 'extInvalidateDrafts': this.drafts.clear(); break;
      case 'moneroUtilsValidateAddress':
        if (args[0] === WRONG_NETWORK_ADDRESS) throw new RuntimeError('Synthetic native network mismatch.', 'WASM_ERROR');
        if (args[0] === DEAD_ENGINE_ADDRESS) throw new RuntimeError('Synthetic engine failure.', 'ENGINE_FAILED');
        break;
      case 'extAddressLabel': {
        const [account, index, label] = args as [number, number, string];
        if (account >= this.state!.labels.length) throw new RuntimeError('Synthetic missing account.', 'INVALID_ACCOUNT');
        if (index !== 0) throw new RuntimeError('Synthetic missing subaddress.', 'INVALID_SUBADDRESS');
        this.state!.labels[account] = label; break;
      }
      case 'extContactAdd': {
        this.state!.contacts.push({ address: args[0] as string, description: args[1] as string });
        if (this.contactReadBackFails) throw new RuntimeError('Synthetic read-back mismatch.', 'CONTACT_UPDATE_FAILED');
        value = { index: this.state!.contacts.length - 1 }; break;
      }
      case 'extContactEdit': case 'extContactDelete': {
        const [index, expected, address, description] = args as [number, string, string, string];
        if (this.state!.contacts[index]?.address !== expected) throw new RuntimeError('Synthetic stale row.', 'STALE_CONTACT');
        if (method === 'extContactDelete') this.state!.contacts.splice(index, 1);
        else this.state!.contacts[index] = { address, description };
        value = method === 'extContactDelete' ? {} : { index }; break;
      }
      case 'extSign': this.signed.push(args); value = { signature: 'SigV2' + '1'.repeat(88), address: ADDRESS }; break;
      case 'extVerify': value = args[0] === 'signed message' ? { good: true, old: false, signatureType: 'spend', version: 2 } :
        { good: false, old: false, signatureType: null, version: null }; break;
      case 'extTxKey':
        if (args[0] !== HASH) throw new RuntimeError('Synthetic unknown key.', 'TX_KEY_UNAVAILABLE');
        value = { key: 'a'.repeat(64) }; break;
      case 'extPrepare': {
        assert.equal(this.networkEnabled, true);
        const params = args[0] as { address: string; amount: string; subtractFee?: boolean };
        this.prepared.push({ amount: params.amount, subtractFee: params.subtractFee });
        const draft: Draft = { draftId: crypto.randomUUID(), amount: params.subtractFee ? (BigInt(params.amount) - 10n).toString() : params.amount,
          address: params.address, fee: '10', txHash: HASH, expiresAt: Date.now() + 300_000, ...(params.subtractFee ? { subtractFee: true } : {}) };
        this.drafts.set(draft.draftId, draft); value = draft;
        break;
      }
      case 'extConfirm': {
        assert.equal(this.networkEnabled, true);
        const draft = this.drafts.get(args[0] as string); this.drafts.delete(args[0] as string);
        if (!draft) throw new RuntimeError('Synthetic draft is consumed.', 'DRAFT_NOT_FOUND');
        this.beforeRelay?.(); this.relayEntered.resolve();
        if (this.relayGate) await this.relayGate.promise;
        if (this.relayFails) throw new RuntimeError('Synthetic lost broadcast response.', 'RELAY_UNCERTAIN');
        value = { txHash: draft.txHash };
        break;
      }
      case 'extCancel': this.drafts.delete(args[0] as string); break;
      case 'createAccount': {
        const index = this.state!.labels.length;
        this.state!.labels.push(args[0] as string);
        value = { index, primaryAddress: ADDRESS };
        break;
      }
      case 'extSnapshot': value = {
        balance: '0', unlockedBalance: '0', height: this.synced ? 10 : 0, synced: this.synced,
        network: (['mainnet', 'testnet', 'stagenet'] as const)[this.state!.network],
        blocksToUnlock: 0, address: ADDRESS,
        accounts: this.state!.labels.map((label, index) => ({ index, label, balance: '0', unlockedBalance: '0', baseAddress: ADDRESS })),
        addresses: [{ index: 0, address: ADDRESS, label: this.state!.labels[0], used: false, balance: '0', unlockedBalance: '0', numUnspentOutputs: 0 }],
        transactions: [], contacts: this.state!.contacts.map((contact, index) => ({ index, ...contact })),
      } satisfies Snapshot; break;
      case 'addListener': break;
      case 'getSeed': value = 'synthetic recovery phrase'; break;
      case 'createSubaddress': value = { index: 1, address: OTHER_ADDRESS }; break;
      // A buggy engine answer that includes a private spend key must never pass the service.
      case 'extKeys': value = { primaryAddress: ADDRESS, publicViewKey: 'a'.repeat(64), privateViewKey: 'c'.repeat(64), publicSpendKey: 'd'.repeat(64), privateSpendKey: 'e'.repeat(64) }; break;
      case 'extIntegrated': this.integratedCalls.push(args);
        value = { integratedAddress: '4' + '2'.repeat(105), paymentId: (args[0] as string | null) ?? 'fedcba9876543210', standardAddress: ADDRESS }; break;
      case 'extRescanCheck':
        if (this.outgoingPending) throw new RuntimeError('Synthetic unconfirmed outgoing payment.', 'PENDING_OUTGOING');
        value = {}; break;
      case 'extAbortNetwork': this.networkEnabled = false; this.aborted = true; this.rescanGate?.resolve(); break;
      case 'extRescan': {
        assert.equal(this.networkEnabled, true, 'A rescan runs only inside the network gate');
        this.rescans.push(args as number[]); this.state!.restoreHeight = args[0] as number; // wallet2 applies the height first
        if (this.rescanGate) await this.rescanGate.promise;
        if (this.aborted) { this.aborted = false; throw new RuntimeError('Synthetic aborted rescan.', 'NODE_TIMEOUT'); }
        this.synced = true; value = { restoreHeight: args[0] }; break;
      }
      default: throw new Error(`Unexpected synthetic native method: ${method}`);
    }
    return value as T;
  }
  dispose() { this.disposed = true; this.state = undefined; }
}

class TabLock {
  owner: symbol | undefined;
  claims = 0;
  releases = 0;
  claim = async () => {
    this.claims++;
    if (this.owner) throw new RuntimeError('Synthetic wallet tab is already active.', 'WALLET_IN_USE');
    const owner = Symbol('wallet-tab'); this.owner = owner;
    return () => {
      assert.equal(this.owner, owner, 'A tab must release only its own lock, once');
      this.owner = undefined; this.releases++;
    };
  };
}

class MarkerStore {
  value: TransferMarker | null = null;
  writes: Array<TransferMarker | null> = [];
  failWriteOnce = false;
  failReadOnce = false;
  blockRead?: { entered: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred> };
  blockWrite?: { entered: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred> };
  async get() {
    if (this.failReadOnce) { this.failReadOnce = false; throw new RuntimeError('Synthetic unreadable marker.', 'PENDING_STORAGE_ERROR'); }
    // A storage response can contain an earlier snapshot even if callback delivery
    // is delayed until after an unrelated worker error event.
    const snapshot = this.value && { ...this.value };
    if (this.blockRead) {
      const block = this.blockRead; this.blockRead = undefined;
      block.entered.resolve(); await block.gate.promise;
    }
    return snapshot;
  }
  async set(value: TransferMarker | null) {
    if (this.failWriteOnce) { this.failWriteOnce = false; throw new RuntimeError('Synthetic marker write failure.', 'PENDING_STORAGE_ERROR'); }
    if (this.blockWrite) {
      const block = this.blockWrite; this.blockWrite = undefined;
      block.entered.resolve(); await block.gate.promise;
    }
    this.value = value && { ...value }; this.writes.push(this.value);
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), configurable: true });
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
  globalThis.fetch = async () => { throw new Error('External network is forbidden in service unit tests'); };
});
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture(t: { after(fn: () => void): void }, lock = new TabLock(), markers?: MarkerStore) {
  const engines: FakeEngine[] = [];
  const service = new WalletService({
    engineFactory: () => { const engine = new FakeEngine(); engines.push(engine); return engine as unknown as EngineClient; },
    claimLock: lock.claim,
    getPendingTransfer: async () => markers ? markers.get() : null,
    setPendingTransfer: async value => {
      assert.ok(markers, 'This test did not opt into synthetic transfers');
      assert.ok(lock.owner, 'Every recovery-marker write must own the wallet lock');
      await markers.set(value);
    },
  });
  t.after(() => service.dispose());
  const current = () => engines.at(-1)!;
  const status = async () => await service.request('status') as Status;
  const create = async () => {
    await service.request('wallet.create', { filename: 'synthetic-wallet', password: OLD_PASSWORD, network: 'mainnet' });
    return (await status()).vaultId!;
  };
  return { service, current, engines, status, create, lock };
}

async function prepareSyntheticTransfer(f: ReturnType<typeof fixture>) {
  await f.create();
  const disabledFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://xmr-node.cakewallet.com:18081/json_rpc');
    assert.equal(JSON.parse(init!.body as string).method, 'get_info');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'extension-node-check',
      result: { status: 'OK', nettype: 'mainnet', height: 10, synchronized: true } }));
  };
  try { await f.service.request('node.select', { nodeId: 'cake-mainnet', acknowledgePrivacy: true }); }
  finally { globalThis.fetch = disabledFetch; }
  await f.service.request('wallet.refresh');
  // Await the actual service's background task, without changing any private state.
  await (f.service as unknown as { syncTask: Promise<void> }).syncTask;
  assert.equal((await f.status()).synced, true);
  return await f.service.request('tx.prepare', { accountIndex: 0, address: ADDRESS, amount: '1', priority: 0 }) as Draft;
}

test('native password change followed by getData failure locks to the old committed vault', async t => {
  const f = fixture(t); const vaultId = await f.create(); const engine = f.current();
  engine.failDataOnce = true;
  await assert.rejects(f.service.request('wallet.password', { oldPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }), { code: 'WASM_ERROR' });
  assert.equal(engine.disposed, true);
  assert.equal(f.lock.owner, undefined);
  assert.equal((await f.status()).walletOpen, false);
  await assert.rejects(f.service.request('wallet.save'), { code: 'NO_WALLET' });
  await assert.rejects(f.service.request('wallet.open', { vaultId, password: NEW_PASSWORD }), { code: 'WRONG_PASSWORD_OR_CORRUPT' });
  await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  assert.equal((await f.status()).walletOpen, true);
  assert.equal(f.current().state!.password, OLD_PASSWORD);
});

test('uncertain native password mutation also locks without saving new keys under old AES password', async t => {
  const f = fixture(t); const vaultId = await f.create(); const engine = f.current();
  engine.failPasswordAfterMutation = true;
  await assert.rejects(f.service.request('wallet.password', { oldPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }), { code: 'WASM_ERROR' });
  assert.equal(engine.disposed, true);
  assert.equal(f.lock.owner, undefined);
  await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  assert.equal(f.current().state!.password, OLD_PASSWORD);
});

test('successful password change persists matching outer and native passwords and wipes exported buffers', async t => {
  const f = fixture(t); const vaultId = await f.create(); const engine = f.current();
  await f.service.request('wallet.password', { oldPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
  for (const data of engine.exported) for (const bytes of data) assert.ok(bytes.every(byte => byte === 0));
  await f.service.request('wallet.close');
  await assert.rejects(f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD }), { code: 'WRONG_PASSWORD_OR_CORRUPT' });
  await f.service.request('wallet.open', { vaultId, password: NEW_PASSWORD });
  assert.equal(f.current().state!.password, NEW_PASSWORD);
});

test('post-mutation native export failure cannot leave unsaved wallet changes active', async t => {
  const f = fixture(t); const vaultId = await f.create(); const engine = f.current();
  engine.failDataOnce = true;
  await assert.rejects(f.service.request('account.create', { label: 'must-not-appear-as-saved' }), { code: 'WASM_ERROR' });
  assert.equal(engine.calls.filter(method => method === 'createAccount').length, 1);
  assert.equal(engine.disposed, true);
  assert.equal(f.lock.owner, undefined);
  assert.equal((await f.status()).walletOpen, false);
  await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  const snapshot = await f.service.request('snapshot') as Snapshot;
  assert.deepEqual(snapshot.accounts.map(account => account.label), ['Primary account']);
});

test('a failed encrypted commit closes native state and preserves the prior saved vault', async t => {
  const f = fixture(t); const vaultId = await f.create(); const engine = f.current();
  const database = globalThis.indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
  try {
    await assert.rejects(f.service.request('account.create', { label: 'storage-failed' }), { code: 'STORAGE_FAILED' });
  } finally { Object.defineProperty(globalThis, 'indexedDB', { value: database, configurable: true }); }
  assert.equal(engine.disposed, true);
  assert.equal(f.lock.owner, undefined);
  for (const data of engine.exported) for (const bytes of data) assert.ok(bytes.every(byte => byte === 0));
  await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  assert.deepEqual(f.current().state!.labels, ['Primary account']);
});

test('password rotation whose encrypted commit fails preserves the old unlock password', async t => {
  const f = fixture(t); const vaultId = await f.create(); const engine = f.current();
  const database = globalThis.indexedDB;
  // Storage breaks after the old password was verified and the native password changed.
  engine.onChangePassword = () => Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
  try {
    await assert.rejects(f.service.request('wallet.password', { oldPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }), { code: 'STORAGE_FAILED' });
  } finally { Object.defineProperty(globalThis, 'indexedDB', { value: database, configurable: true }); }
  assert.equal(engine.calls.includes('changePassword'), true);
  assert.equal(engine.disposed, true);
  assert.equal(f.lock.owner, undefined);
  for (const data of engine.exported) for (const bytes of data) assert.ok(bytes.every(byte => byte === 0));
  await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  assert.equal(f.current().state!.password, OLD_PASSWORD);
});

test('locked status/list/node reads never claim the exclusive wallet lock', async t => {
  const f = fixture(t);
  await f.service.request('status');
  await f.service.request('wallet.list');
  await f.service.request('node.list');
  assert.equal(f.lock.claims, 0);
  assert.equal(f.lock.owner, undefined);
  assert.equal((await f.status()).walletOpen, false);
});

test('a second tab cannot unlock while keys are active, but lock plus polling permits handoff', async t => {
  const lock = new TabLock(); const first = fixture(t, lock); const second = fixture(t, lock);
  const vaultId = await first.create();
  assert.equal((await second.status()).walletOpen, false);
  await assert.rejects(second.service.request('wallet.open', { vaultId, password: OLD_PASSWORD }), { code: 'WALLET_IN_USE' });
  assert.equal((await first.status()).walletOpen, true);
  await first.service.request('wallet.close');
  assert.equal(lock.owner, undefined);
  const claimsAfterClose = lock.claims;
  await first.status(); await first.service.request('wallet.list'); await first.service.request('node.list');
  assert.equal(lock.claims, claimsAfterClose, 'UI polling must not reclaim the lock after closing the wallet');
  await second.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  assert.equal((await second.status()).walletOpen, true);
  assert.equal((await first.status()).walletOpen, false);
});

test('failed unlock and native worker disposal release lock ownership', async t => {
  const lock = new TabLock(); const first = fixture(t, lock); const second = fixture(t, lock);
  const vaultId = await first.create();
  await first.service.request('wallet.close');
  await assert.rejects(second.service.request('wallet.open', { vaultId, password: 'incorrect-password' }), { code: 'WRONG_PASSWORD_OR_CORRUPT' });
  assert.equal(lock.owner, undefined);
  await first.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  const engine = first.current(); engine.dispose(); engine.onFatal?.();
  assert.equal(lock.owner, undefined);
  await second.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  assert.equal((await second.status()).walletOpen, true);
});

test('locked reads leave markers untouched and stale resolve cannot clear a newer hash', async t => {
  const markers = new MarkerStore(); markers.value = { txHash: OTHER_HASH, createdAt: 1 };
  const f = fixture(t, new TabLock(), markers);
  await f.status(); await f.service.request('wallet.list'); await f.service.request('node.list');
  assert.equal(f.lock.claims, 0); assert.equal(markers.writes.length, 0);
  await assert.rejects(f.service.request('tx.resolve', { txHash: HASH }), { code: 'STALE_TRANSFER_MARKER' });
  assert.equal(markers.value?.txHash, OTHER_HASH);
  assert.equal(f.lock.claims, 1); assert.equal(f.lock.releases, 1); assert.equal(f.lock.owner, undefined);
  await f.service.request('tx.resolve', { txHash: OTHER_HASH });
  assert.equal(markers.value, null); assert.equal(f.lock.claims, 2); assert.equal(f.lock.releases, 2);
  await assert.rejects(f.service.request('tx.resolve', { txHash: OTHER_HASH }), { code: 'STALE_TRANSFER_MARKER' });
  assert.equal(f.lock.owner, undefined); assert.equal(f.lock.releases, 3);
});

test('temporary marker-resolution lock is released when recovery storage cannot be read or written', async t => {
  const markers = new MarkerStore(); markers.value = { txHash: HASH, createdAt: 1 };
  const f = fixture(t, new TabLock(), markers);
  for (const failure of ['failReadOnce', 'failWriteOnce'] as const) {
    markers[failure] = true;
    await assert.rejects(f.service.request('tx.resolve', { txHash: HASH }), { code: 'PENDING_STORAGE_ERROR' });
    assert.equal(markers.value?.txHash, HASH); assert.equal(f.lock.owner, undefined);
  }
  assert.equal(f.lock.claims, 2); assert.equal(f.lock.releases, 2);
});

test('a locked tab cannot erase another tab marker; owning unlocked tab resolves without nested lock', async t => {
  const markers = new MarkerStore(); markers.value = { txHash: HASH, createdAt: 1 };
  const lock = new TabLock(); const owner = fixture(t, lock, markers); const other = fixture(t, lock, markers);
  await owner.create(); await other.status();
  await assert.rejects(other.service.request('tx.resolve', { txHash: HASH }), { code: 'WALLET_IN_USE' });
  assert.equal(markers.value?.txHash, HASH); assert.equal(markers.writes.length, 0);
  const claims = lock.claims; const token = lock.owner;
  await owner.service.request('tx.resolve', { txHash: HASH });
  assert.equal(markers.value, null); assert.equal(lock.claims, claims); assert.equal(lock.owner, token);
});

test('pending marker is saved before relay and cannot be cleared during relay or cache persistence', async t => {
  const markers = new MarkerStore(); const f = fixture(t, new TabLock(), markers);
  const draft = await prepareSyntheticTransfer(f); const engine = f.current();
  const relayGate = deferred(); engine.relayGate = relayGate;
  const dataBlock = { entered: deferred(), gate: deferred() };
  t.after(() => { relayGate.resolve(); dataBlock.gate.resolve(); });
  engine.beforeRelay = () => { assert.equal(markers.value?.txHash, draft.txHash); };
  const confirmation = f.service.request('tx.confirm', { draftId: draft.draftId });
  await engine.relayEntered.promise;
  await assert.rejects(f.service.request('tx.resolve', { txHash: HASH }), { code: 'RELAY_IN_PROGRESS' });
  assert.equal(markers.value?.txHash, HASH);
  engine.blockData = dataBlock; relayGate.resolve(); await dataBlock.entered.promise;
  await assert.rejects(f.service.request('tx.resolve', { txHash: HASH }), { code: 'RELAY_IN_PROGRESS' });
  assert.equal(markers.value?.txHash, HASH, 'Known broadcast is still guarded until encrypted state commits');
  dataBlock.gate.resolve();
  assert.deepEqual(await confirmation, { txHash: HASH });
  assert.equal(markers.value, null); assert.equal(engine.networkEnabled, false);
  assert.equal(engine.calls.filter(method => method === 'extConfirm').length, 1);
  assert.equal(engine.drafts.size, 0);
});

test('marker write failure prevents broadcast and consumes both service and native draft', async t => {
  const markers = new MarkerStore(); const f = fixture(t, new TabLock(), markers);
  const draft = await prepareSyntheticTransfer(f); const engine = f.current();
  markers.failWriteOnce = true;
  await assert.rejects(f.service.request('tx.confirm', { draftId: draft.draftId }), { code: 'PENDING_STORAGE_ERROR' });
  assert.equal(engine.calls.includes('extConfirm'), false); assert.equal(engine.drafts.size, 0);
  assert.equal(markers.value, null);
  await assert.rejects(f.service.request('tx.confirm', { draftId: draft.draftId }), { code: 'DRAFT_NOT_FOUND' });
  assert.equal(engine.calls.includes('extConfirm'), false);
});

test('unknown relay retains the exact recovery hash and is one-shot with no automatic retry', async t => {
  const markers = new MarkerStore(); const f = fixture(t, new TabLock(), markers);
  const draft = await prepareSyntheticTransfer(f); const engine = f.current(); engine.relayFails = true;
  await assert.rejects(f.service.request('tx.confirm', { draftId: draft.draftId }), { code: 'RELAY_UNCERTAIN' });
  assert.equal(markers.value?.txHash, draft.txHash); assert.equal(engine.networkEnabled, false);
  assert.equal(engine.calls.filter(method => method === 'extConfirm').length, 1);
  assert.equal(engine.drafts.size, 0);
  await assert.rejects(f.service.request('tx.confirm', { draftId: draft.draftId }), { code: 'DRAFT_NOT_FOUND' });
  await assert.rejects(f.service.request('tx.prepare', { accountIndex: 0, address: ADDRESS, amount: '1', priority: 0 }), { code: 'PENDING_TRANSFER' });
  assert.equal(engine.calls.filter(method => method === 'extConfirm').length, 1);
  await f.service.request('tx.resolve', { txHash: draft.txHash });
  assert.equal(markers.value, null);
});

test('successful native relay followed by save failure keeps the marker and locks the wallet', async t => {
  const markers = new MarkerStore(); const f = fixture(t, new TabLock(), markers);
  const draft = await prepareSyntheticTransfer(f); const engine = f.current(); engine.failDataOnce = true;
  await assert.rejects(f.service.request('tx.confirm', { draftId: draft.draftId }), { code: 'WASM_ERROR' });
  assert.equal(engine.calls.filter(method => method === 'extConfirm').length, 1);
  assert.equal(markers.value?.txHash, draft.txHash);
  assert.equal(engine.disposed, true); assert.equal(f.lock.owner, undefined);
  assert.equal((await f.status()).walletOpen, false);
});

test('success must not clear a different marker observed after broadcast persistence', async t => {
  const markers = new MarkerStore(); const f = fixture(t, new TabLock(), markers);
  const draft = await prepareSyntheticTransfer(f); const engine = f.current();
  engine.beforeRelay = () => { markers.value = { txHash: OTHER_HASH, createdAt: 2 }; };
  await assert.rejects(f.service.request('tx.confirm', { draftId: draft.draftId }), { code: 'STALE_TRANSFER_MARKER' });
  assert.equal(markers.value?.txHash, OTHER_HASH);
  assert.equal(markers.writes.some(value => value === null), false);
  assert.equal(engine.calls.filter(method => method === 'extConfirm').length, 1);
});

for (const phase of ['read', 'write'] as const) {
  test(`worker failure during recovery-marker ${phase} retains ownership until storage settles`, async t => {
    const markers = new MarkerStore(); markers.value = { txHash: HASH, createdAt: 1 };
    const lock = new TabLock(); const first = fixture(t, lock, markers); const second = fixture(t, lock, markers);
    const vaultId = await first.create(); const failedEngine = first.current(); const originalOwner = lock.owner;
    const block = { entered: deferred(), gate: deferred() };
    t.after(() => block.gate.resolve());
    if (phase === 'read') markers.blockRead = block; else markers.blockWrite = block;
    const resolution = first.service.request('tx.resolve', { txHash: HASH });
    await block.entered.promise;
    // EngineClient disposes the worker before notifying WalletService.onFatal.
    failedEngine.dispose(); failedEngine.onFatal?.();
    assert.equal(failedEngine.disposed, true, 'Native keys are destroyed immediately');
    assert.equal(lock.owner, originalOwner, 'The storage critical section must retain the original physical lock');
    assert.equal(lock.releases, 0);
    const engineCount = first.engines.length;
    await assert.rejects(first.status(), { code: 'ENGINE_CLOSED' });
    assert.equal(first.engines.length, engineCount, 'Do not start another worker inside an unfinished fatal operation');
    await assert.rejects(second.service.request('wallet.open', { vaultId, password: OLD_PASSWORD }), { code: 'WALLET_IN_USE' });
    assert.equal(markers.value?.txHash, HASH);
    block.gate.resolve(); await resolution;
    assert.equal(markers.value, null); assert.equal(lock.owner, undefined); assert.equal(lock.releases, 1);

    // Only after the old clear has fully settled may a new wallet own storage and
    // write another transfer marker. No old callback may clear that new record.
    await second.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
    const newOwner = lock.owner; assert.ok(newOwner); assert.notEqual(newOwner, originalOwner);
    await markers.set({ txHash: OTHER_HASH, createdAt: 2 });
    await first.status(); // A locked-tab UI poll must not reclaim ownership.
    failedEngine.onFatal?.(); // A delayed duplicate event from the old worker is inert.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(lock.owner, newOwner); assert.equal((await markers.get())?.txHash, OTHER_HASH);
    assert.equal(markers.writes.filter(value => value === null).length, 1);
  });
}

test('closing the tab during a marker read holds ownership then rejects without clearing the marker', async t => {
  const markers = new MarkerStore(); markers.value = { txHash: HASH, createdAt: 1 };
  const lock = new TabLock(); const first = fixture(t, lock, markers); const second = fixture(t, lock, markers);
  const vaultId = await first.create(); const engine = first.current(); const originalOwner = lock.owner;
  const block = { entered: deferred(), gate: deferred() }; markers.blockRead = block;
  t.after(() => block.gate.resolve());
  const rejected = assert.rejects(first.service.request('tx.resolve', { txHash: HASH }), { code: 'REQUEST_ABORTED' });
  await block.entered.promise; first.service.dispose();
  assert.equal(engine.disposed, true); assert.equal(lock.owner, originalOwner);
  await assert.rejects(second.service.request('wallet.open', { vaultId, password: OLD_PASSWORD }), { code: 'WALLET_IN_USE' });
  block.gate.resolve(); await rejected;
  assert.equal(markers.value?.txHash, HASH); assert.equal(markers.writes.length, 0);
  assert.equal(lock.owner, undefined); assert.equal(lock.releases, 1);
  await second.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  await markers.set({ txHash: OTHER_HASH, createdAt: 2 });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(markers.value?.txHash, OTHER_HASH);
});

test('labels and address-book changes are saved one by one; readable prechecks keep the wallet open', async t => {
  const f = fixture(t); const vaultId = await f.create(); const engine = f.current();
  const saves = () => engine.calls.filter(method => method === 'getData').length;
  let expected = saves();
  const saved = async (action: string, params: Record<string, unknown>) => {
    const result = await f.service.request(action, params); assert.equal(saves(), ++expected, `${action} must commit the vault`); return result;
  };
  await saved('address.label', { accountIndex: 0, addressIndex: 0, label: 'Main address' });
  assert.deepEqual(await saved('contact.add', { address: ` ${ADDRESS} `, description: ' Alice ' }), { index: 0 });
  for (const [action, params, code] of [
    ['address.label', { accountIndex: 0, addressIndex: 5, label: 'missing' }, 'INVALID_SUBADDRESS'],
    ['address.label', { accountIndex: 7, addressIndex: 0, label: 'missing' }, 'INVALID_ACCOUNT'],
    ['contact.edit', { index: 0, expectedAddress: OTHER_ADDRESS, address: ADDRESS, description: 'x' }, 'STALE_CONTACT'],
    ['contact.delete', { index: 3, expectedAddress: ADDRESS }, 'STALE_CONTACT'],
  ] as const) await assert.rejects(f.service.request(action, params), { code });
  assert.equal(saves(), expected, 'Rejected prechecks never write the vault');
  assert.equal((await f.status()).walletOpen, true); assert.equal(engine.disposed, false);
  assert.deepEqual(await saved('contact.edit', { index: 0, expectedAddress: ADDRESS, address: OTHER_ADDRESS, description: 'Bob' }), { index: 0 });
  await f.service.request('wallet.close');
  await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  const reopened = f.current(); expected = reopened.calls.filter(method => method === 'getData').length;
  let snapshot = await f.service.request('snapshot') as Snapshot;
  assert.deepEqual(snapshot.contacts, [{ index: 0, address: OTHER_ADDRESS, description: 'Bob' }]);
  assert.equal(snapshot.addresses[0].label, 'Main address');
  assert.deepEqual(await f.service.request('contact.delete', { index: 0, expectedAddress: OTHER_ADDRESS }), {});
  assert.equal(reopened.calls.filter(method => method === 'getData').length, expected + 1);
  snapshot = await f.service.request('snapshot') as Snapshot;
  assert.deepEqual(snapshot.contacts, []);
});

test('addresses are checked for this wallet network before any native address-book, verify or send call', async t => {
  const f = fixture(t); await f.create(); const engine = f.current();
  for (const address of ['donate.getmonero.org', 'monero:' + ADDRESS, WRONG_NETWORK_ADDRESS]) {
    const before = engine.calls.length;
    for (const [action, params] of [
      ['contact.add', { address, description: '' }],
      ['contact.edit', { index: 0, expectedAddress: ADDRESS, address, description: '' }],
      ['message.verify', { message: 'signed message', address, signature: 'SigV2abc' }],
    ] as const) await assert.rejects(f.service.request(action, params), { code: 'INVALID_ADDRESS', message: 'This address is not valid for this mainnet wallet.' });
    const calls = engine.calls.slice(before);
    assert.deepEqual(calls.filter(method => method !== 'moneroUtilsValidateAddress'), [], 'Only the validator may see a rejected address');
    if (address !== WRONG_NETWORK_ADDRESS) assert.equal(calls.length, 0, 'OpenAlias names and URIs never reach native code');
  }
  // A dead engine is reported as such, never disguised as a bad address.
  await assert.rejects(f.service.request('contact.add', { address: DEAD_ENGINE_ADDRESS, description: '' }), { code: 'ENGINE_FAILED' });
});

test('new wallet actions have strict schemas and reject bad input before native calls', async t => {
  const f = fixture(t); await f.create(); const engine = f.current(); const before = engine.calls.length;
  for (const [action, params] of [
    ['address.label', { accountIndex: 0, addressIndex: -1, label: '' }],
    ['address.label', { accountIndex: 0, addressIndex: 0, label: '', extra: true }],
    ['address.label', { accountIndex: 0, addressIndex: 0, label: 'x'.repeat(201) }],
    ['contact.add', { address: ADDRESS, description: 'x'.repeat(201) }],
    ['contact.add', { address: ADDRESS, description: '', paymentId: 'a'.repeat(16) }],
    ['contact.edit', { index: 0, address: ADDRESS, description: '' }],
    ['contact.edit', { index: 0.5, expectedAddress: ADDRESS, address: ADDRESS, description: '' }],
    ['contact.delete', { index: 0, expectedAddress: 'not-an-address' }],
    ['contact.delete', { index: 0 }],
    ['message.sign', { message: '', accountIndex: 0, addressIndex: 0, mode: 'spend' }],
    ['message.sign', { message: 'x'.repeat(4001), accountIndex: 0, addressIndex: 0, mode: 'spend' }],
    ['message.sign', { message: 'x', accountIndex: 0, addressIndex: 0, mode: 'owner' }],
    ['message.verify', { message: 'x', address: ADDRESS, signature: '' }],
    ['message.verify', { message: 'x', address: ADDRESS, signature: 'S'.repeat(501) }],
    ['tx.key', { txid: 'z'.repeat(64) }],
    ['tx.key', { txid: HASH, accountIndex: 0 }],
    ['tx.prepare', { accountIndex: 0, address: ADDRESS, amount: '1', priority: 0, subtractFee: 'true' }],
  ] as const) await assert.rejects(f.service.request(action, params), { code: 'INVALID_PARAMS' }, action);
  assert.deepEqual(engine.calls.slice(before), []);
});

test('message signing, verification and tx keys stay local: no node, network or vault write', async t => {
  const f = fixture(t); await f.create(); const engine = f.current(); const before = engine.calls.length;
  assert.deepEqual(await f.service.request('message.sign', { message: ' exact bytes\n', accountIndex: 0, addressIndex: 0, mode: 'view' }),
    { signature: 'SigV2' + '1'.repeat(88), address: ADDRESS });
  assert.deepEqual(engine.signed, [[' exact bytes\n', 0, 0, 'view']], 'Signed text is never trimmed or normalized');
  assert.deepEqual(await f.service.request('message.verify', { message: 'signed message', address: ADDRESS, signature: 'SigV2abc' }),
    { good: true, old: false, signatureType: 'spend', version: 2 });
  assert.deepEqual(await f.service.request('message.verify', { message: 'tampered message', address: ADDRESS, signature: 'SigV2abc' }),
    { good: false, old: false, signatureType: null, version: null });
  assert.deepEqual(await f.service.request('tx.key', { txid: HASH }), { key: 'a'.repeat(64) });
  await assert.rejects(f.service.request('tx.key', { txid: OTHER_HASH }), { code: 'TX_KEY_UNAVAILABLE' });
  const calls = engine.calls.slice(before);
  for (const forbidden of ['extNetwork', 'extConfigureNode', 'getData']) assert.equal(calls.includes(forbidden), false, forbidden);
  assert.equal((await f.status()).walletOpen, true);
});

test('an uncertain native address-book change locks without saving it', async t => {
  const f = fixture(t); const vaultId = await f.create(); const engine = f.current();
  engine.contactReadBackFails = true;
  await assert.rejects(f.service.request('contact.add', { address: ADDRESS, description: 'uncertain' }), { code: 'CONTACT_UPDATE_FAILED' });
  assert.equal(engine.disposed, true); assert.equal(f.lock.owner, undefined);
  assert.equal((await f.status()).walletOpen, false);
  await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  assert.deepEqual((await f.service.request('snapshot') as Snapshot).contacts, []);
});

test('send max passes subtractFee to the one-shot native draft; the default stays off', async t => {
  const markers = new MarkerStore(); const f = fixture(t, new TabLock(), markers);
  const regular = await prepareSyntheticTransfer(f); const engine = f.current();
  assert.equal(regular.subtractFee, undefined); assert.equal(regular.amount, '1000000000000');
  await f.service.request('tx.cancel', { draftId: regular.draftId });
  const max = await f.service.request('tx.prepare', { accountIndex: 0, address: ADDRESS, amount: '2.5', priority: 0, subtractFee: true }) as Draft;
  assert.deepEqual(engine.prepared, [{ amount: '1000000000000', subtractFee: false }, { amount: '2500000000000', subtractFee: true }]);
  assert.equal(max.subtractFee, true);
  assert.equal(BigInt(max.amount) + BigInt(max.fee), 2_500_000_000_000n, 'The requested amount is the total debit');
  assert.deepEqual(await f.service.request('tx.confirm', { draftId: max.draftId }), { txHash: HASH });
  assert.equal(markers.value, null); assert.equal(engine.calls.filter(method => method === 'extConfirm').length, 1);
});

const LOCAL_NODE = 'http://127.0.0.1:18081';
function customNodeResponder(expectedUrl: string, nettype = 'mainnet', seen: string[] = []) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(String(input));
    assert.equal(String(input), `${expectedUrl}/json_rpc`);
    assert.equal(JSON.parse(init!.body as string).method, 'get_info');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'extension-node-check', result: { status: 'OK', nettype, height: 10, synchronized: true } }));
  };
}

test('custom nodes are saved per wallet, encrypted, and adding one never contacts it', async t => {
  const f = fixture(t); const vaultId = await f.create();
  let fetches = 0; globalThis.fetch = async () => { fetches++; throw new Error('Adding must not contact the node'); };
  const added = await f.service.request('node.custom.add', { name: '  My node  ', url: `${LOCAL_NODE}/` }) as NodeSelection;
  const custom = added.nodes.filter(node => node.kind === 'custom');
  assert.equal(custom.length, 1); assert.equal(fetches, 0);
  assert.deepEqual({ ...custom[0], id: '' }, { id: '', name: 'My node', url: LOCAL_NODE, network: 'mainnet', kind: 'custom', source: '' });
  assert.match(custom[0].id, /^custom-[a-f\d]{16}$/);
  assert.equal(added.nodes.filter(node => node.kind !== 'custom').length > 0, true, 'Bundled nodes stay listed');
  // Readable prechecks keep the wallet open and write nothing.
  const exports = f.current().exported.length;
  await assert.rejects(f.service.request('node.custom.add', { name: 'Again', url: 'HTTP://127.0.0.1:18081' }), { code: 'DUPLICATE_NODE' });
  await assert.rejects(f.service.request('node.custom.add', { name: 'Cake', url: 'https://xmr-node.cakewallet.com:18081/' }), { code: 'DUPLICATE_NODE' });
  await assert.rejects(f.service.request('node.custom.add', { name: 'Path', url: `${LOCAL_NODE}/json_rpc` }), { code: 'INVALID_NODE_URL' });
  await assert.rejects(f.service.request('node.custom.add', { name: 'Login', url: 'http://user:pw@127.0.0.1:18082' }), { code: 'INVALID_NODE_URL' });
  for (const params of [{ name: '', url: LOCAL_NODE }, { name: 'n'.repeat(41), url: LOCAL_NODE }, { name: 'Bad\nname', url: LOCAL_NODE },
    { name: 'x', url: 'h'.repeat(201) }, { name: 'x', url: LOCAL_NODE, network: 'stagenet' }, { name: 'x' }])
    await assert.rejects(f.service.request('node.custom.add', params), { code: 'INVALID_PARAMS' }, JSON.stringify(params));
  assert.equal(f.current().exported.length, exports); assert.equal((await f.status()).walletOpen, true);
  // The list is inside the encrypted vault record, never in plaintext global storage.
  const raw = JSON.stringify(await new Promise((resolve, reject) => {
    const open = indexedDB.open('monero-extension-encrypted-vaults');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const all = open.result.transaction('vaults').objectStore('vaults').getAll();
      all.onsuccess = () => resolve(all.result.map(record => ({ ...record, cipher: { ...record.cipher, ciphertext: [...new Uint8Array(record.cipher.ciphertext)] } })));
      all.onerror = () => reject(all.error);
    };
  }));
  assert.doesNotMatch(raw, /127\.0\.0\.1|My node|custom-/);
  // Survives lock and reopen; a different wallet does not see it.
  await f.service.request('wallet.close');
  const locked = await f.service.request('node.list') as NodeSelection;
  assert.equal(locked.nodes.some(node => node.kind === 'custom'), false, 'Locked views never list custom nodes');
  await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  const reopened = await f.service.request('node.list') as NodeSelection;
  assert.deepEqual(reopened.nodes.filter(node => node.kind === 'custom'), custom);
  await f.service.request('wallet.close');
  await f.service.request('wallet.create', { filename: 'other-wallet', password: OLD_PASSWORD, network: 'mainnet' });
  assert.equal((await f.service.request('node.list') as NodeSelection).nodes.some(node => node.kind === 'custom'), false);
  await assert.rejects(f.service.request('node.check', { nodeId: custom[0].id, acknowledgePrivacy: true }), { code: 'INVALID_NODE' });
});

test('custom node selection checks the exact origin, passes it to the worker, persists and syncs through it', async t => {
  const f = fixture(t); const vaultId = await f.create();
  const { nodes } = await f.service.request('node.custom.add', { name: 'Local monerod', url: LOCAL_NODE }) as NodeSelection;
  const id = nodes.find(node => node.kind === 'custom')!.id;
  const seen: string[] = []; globalThis.fetch = customNodeResponder(LOCAL_NODE, 'mainnet', seen);
  const check = await f.service.request('node.check', { nodeId: id, acknowledgePrivacy: true }) as { reachable: boolean; network: string };
  assert.equal(check.reachable, true); assert.equal(check.network, 'mainnet');
  const applied = await f.service.request('node.select', { nodeId: id, acknowledgePrivacy: true }) as NodeApplied;
  assert.equal(applied.selectedNodeId, id); assert.equal(typeof applied.appliedAt, 'number');
  assert.deepEqual(seen, [`${LOCAL_NODE}/json_rpc`, `${LOCAL_NODE}/json_rpc`]);
  // The worker receives the id AND its validated origin, and network access is revoked afterwards.
  assert.deepEqual(f.current().nodeCalls, [['extNetwork', id, LOCAL_NODE], ['extConfigureNode', id, LOCAL_NODE], ['extNetwork', null]]);
  let status = await f.status();
  assert.equal(status.nodeId, id); assert.equal(status.nodeName, 'Local monerod'); assert.equal(status.nodeUrl, LOCAL_NODE);
  globalThis.fetch = async () => { throw new Error('Sync uses the worker transport only'); };
  await f.service.request('wallet.refresh');
  await (f.service as unknown as { syncTask: Promise<void> }).syncTask;
  assert.equal((await f.status()).synced, true);
  assert.deepEqual(f.current().nodeCalls.slice(3), [['extNetwork', id, LOCAL_NODE], ['extConfigureNode', id, LOCAL_NODE], ['extNetwork', null]]);
  // The encrypted selection survives reopening.
  await f.service.request('wallet.close'); await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  status = await f.status();
  assert.equal(status.nodeId, id); assert.equal(status.nodeUrl, LOCAL_NODE); assert.equal(status.nodeName, 'Local monerod');
  // Bundled nodes keep the old one-argument worker protocol and expose their names.
  globalThis.fetch = async input => {
    assert.equal(String(input), 'https://xmr-node.cakewallet.com:18081/json_rpc');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'extension-node-check', result: { status: 'OK', nettype: 'mainnet', height: 10 } }));
  };
  await f.service.request('node.select', { nodeId: 'cake-mainnet', acknowledgePrivacy: true });
  assert.deepEqual(f.current().nodeCalls.slice(-3), [['extNetwork', 'cake-mainnet'], ['extConfigureNode', 'cake-mainnet'], ['extNetwork', null]]);
  status = await f.status(); assert.equal(status.nodeUrl, 'https://xmr-node.cakewallet.com:18081'); assert.ok(status.nodeName);
});

test('a custom node that is unreachable or on another network is never applied', async t => {
  const f = fixture(t); await f.create();
  const { nodes } = await f.service.request('node.custom.add', { name: 'Wrong', url: 'http://10.1.2.3:38081' }) as NodeSelection;
  const id = nodes.find(node => node.kind === 'custom')!.id;
  globalThis.fetch = customNodeResponder('http://10.1.2.3:38081', 'stagenet');
  await assert.rejects(f.service.request('node.select', { nodeId: id, acknowledgePrivacy: true }), { code: 'NODE_NETWORK_MISMATCH' });
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(f.service.request('node.select', { nodeId: id, acknowledgePrivacy: true }), error => {
    assert.equal((error as { code: string }).code, 'NODE_UNREACHABLE');
    assert.match((error as Error).message, /Allow access when Chrome asks/); assert.match((error as Error).message, /--rpc-bind-ip/);
    assert.match((error as Error).message, /No node was applied/); return true;
  });
  const status = await f.status();
  assert.equal(status.nodeId, null); assert.equal(status.walletOpen, true);
  assert.deepEqual(f.current().nodeCalls, [], 'The worker network gate never opened for a failed check');
});

test('removing the selected custom node clears the selection, invalidates drafts and persists', async t => {
  const f = fixture(t); const vaultId = await f.create();
  const { nodes } = await f.service.request('node.custom.add', { name: 'Home', url: LOCAL_NODE }) as NodeSelection;
  const id = nodes.find(node => node.kind === 'custom')!.id;
  const other = (await f.service.request('node.custom.add', { name: 'Other', url: 'http://[::1]:18081' }) as NodeSelection)
    .nodes.find(node => node.kind === 'custom' && node.id !== id)!.id;
  globalThis.fetch = customNodeResponder(LOCAL_NODE);
  await f.service.request('node.select', { nodeId: id, acknowledgePrivacy: true });
  await f.service.request('wallet.refresh'); await (f.service as unknown as { syncTask: Promise<void> }).syncTask;
  const draft = await f.service.request('tx.prepare', { accountIndex: 0, address: ADDRESS, amount: '1', priority: 0 }) as Draft;
  // Removing another node keeps the selection.
  let list = await f.service.request('node.custom.remove', { nodeId: other }) as NodeSelection;
  assert.equal(list.selectedNodeId, id); assert.equal(list.nodes.some(node => node.id === other), false);
  list = await f.service.request('node.custom.remove', { nodeId: id }) as NodeSelection;
  assert.equal(list.selectedNodeId, null); assert.equal(list.appliedAt, null);
  assert.equal(list.nodes.some(node => node.kind === 'custom'), false);
  const status = await f.status();
  assert.equal(status.nodeId, null); assert.equal(status.nodeName, undefined); assert.equal(status.synced, false);
  assert.equal(f.current().calls.includes('extInvalidateDrafts'), true);
  await assert.rejects(f.service.request('tx.confirm', { draftId: draft.draftId }), { code: 'DRAFT_NOT_FOUND' });
  await assert.rejects(f.service.request('wallet.refresh'), { code: 'NO_NODE' });
  await assert.rejects(f.service.request('node.custom.remove', { nodeId: id }), { code: 'INVALID_NODE' });
  for (const nodeId of ['cake-mainnet', 'custom-xyz', '']) await assert.rejects(f.service.request('node.custom.remove', { nodeId }), { code: 'INVALID_PARAMS' });
  await f.service.request('wallet.close'); await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  assert.equal((await f.status()).nodeId, null);
  assert.equal((await f.service.request('node.list') as NodeSelection).nodes.some(node => node.kind === 'custom'), false);
});

test('custom node changes are refused while syncing and when no wallet is open', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.request('node.custom.add', { name: 'Home', url: LOCAL_NODE }), { code: 'NO_WALLET' });
  await assert.rejects(f.service.request('node.check', { nodeId: 'custom-0123456789abcdef', acknowledgePrivacy: true }), { code: 'NO_WALLET' });
  await f.create();
  const { nodes } = await f.service.request('node.custom.add', { name: 'Home', url: LOCAL_NODE }) as NodeSelection;
  const id = nodes.find(node => node.kind === 'custom')!.id;
  globalThis.fetch = customNodeResponder(LOCAL_NODE);
  await f.service.request('node.select', { nodeId: id, acknowledgePrivacy: true });
  const block = { entered: deferred(), gate: deferred() }; t.after(() => block.gate.resolve());
  f.current().blockData = block;
  await f.service.request('wallet.refresh'); await block.entered.promise;
  for (const [action, params] of [['node.custom.add', { name: 'Late', url: 'http://127.0.0.1:18089' }], ['node.custom.remove', { nodeId: id }],
    ['node.select', { nodeId: id, acknowledgePrivacy: true }]] as const)
    await assert.rejects(f.service.request(action, params), { code: 'SYNC_BUSY' }, action);
  block.gate.resolve(); await (f.service as unknown as { syncTask: Promise<void> }).syncTask;
  assert.equal((await f.status()).nodeId, id);
});

test('a vault whose saved custom node disappeared or was tampered opens safely without it', async t => {
  const f = fixture(t); const vaultId = await f.create();
  const { nodes } = await f.service.request('node.custom.add', { name: 'Home', url: LOCAL_NODE }) as NodeSelection;
  const id = nodes.find(node => node.kind === 'custom')!.id;
  globalThis.fetch = customNodeResponder(LOCAL_NODE);
  await f.service.request('node.select', { nodeId: id, acknowledgePrivacy: true });
  // Simulate a damaged settings entry through the service's own persistence path.
  const internals = f.service as unknown as { extraSettings: Record<string, unknown>; persist(): Promise<void> };
  internals.extraSettings = { ...internals.extraSettings, customNodes: [{ id, name: 'Home', url: 'http://evil.example/json_rpc', network: 'mainnet', kind: 'custom', source: '' }] };
  await internals.persist();
  await f.service.request('wallet.close'); await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  const status = await f.status();
  assert.equal(status.walletOpen, true); assert.equal(status.nodeId, null, 'A dangling custom selection is dropped, never redirected');
  assert.equal((await f.service.request('node.list') as NodeSelection).nodes.some(node => node.kind === 'custom'), false);
});

const WRONG_PASSWORD = 'wrong-test-password';
async function selectLocalNode(f: ReturnType<typeof fixture>) {
  const { nodes } = await f.service.request('node.custom.add', { name: 'Local monerod', url: LOCAL_NODE }) as NodeSelection;
  const id = nodes.find(node => node.kind === 'custom')!.id;
  globalThis.fetch = customNodeResponder(LOCAL_NODE);
  await f.service.request('node.select', { nodeId: id, acknowledgePrivacy: true });
  return id;
}

test('wallet.rename changes the encrypted name; taken or invalid names keep the wallet open and unchanged', async t => {
  const f = fixture(t); await f.create(); await f.service.request('wallet.close');
  await f.service.request('wallet.create', { filename: 'second-wallet', password: OLD_PASSWORD, network: 'mainnet' });
  const vaultId = (await f.status()).vaultId!;
  assert.deepEqual(await f.service.request('wallet.rename', { name: '  Savings  ' }), {});
  assert.equal((await f.status()).walletName, 'Savings');
  assert.deepEqual(((await f.service.request('wallet.list')) as { wallets: { name: string }[] }).wallets.map(wallet => wallet.name).sort(), ['Savings', 'synthetic-wallet']);
  await assert.rejects(f.service.request('wallet.rename', { name: 'synthetic-wallet' }), { code: 'DUPLICATE_NAME', message: 'A wallet with this name already exists.' });
  for (const name of ['a/b', 'back\\slash', '..', '.', 'tab\there'])
    await assert.rejects(f.service.request('wallet.rename', { name }), { code: 'INVALID_NAME' }, JSON.stringify(name));
  for (const params of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(65) }, {}, { name: 'ok', extra: 1 }])
    await assert.rejects(f.service.request('wallet.rename', params), { code: 'INVALID_PARAMS' }, JSON.stringify(params));
  let status = await f.status();
  assert.equal(status.walletOpen, true); assert.equal(status.walletName, 'Savings'); assert.equal(f.current().disposed, false);
  const exports = f.current().exported.length;
  assert.deepEqual(await f.service.request('wallet.rename', { name: 'Savings' }), {});
  assert.equal(f.current().exported.length, exports, 'Renaming to the same name writes nothing');
  await f.service.request('wallet.close'); await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  status = await f.status(); assert.equal(status.walletName, 'Savings');
  await f.service.request('wallet.close');
  await assert.rejects(f.service.request('wallet.rename', { name: 'Again' }), { code: 'NO_WALLET' });
});

test('wallet.settings are stored encrypted, exposed in status while open, and turning confirmation off needs the password', async t => {
  const f = fixture(t); const vaultId = await f.create();
  let status = await f.status();
  assert.equal(status.autoLockMinutes, 5); assert.equal(status.confirmWithPassword, false); assert.equal(status.restoreHeight, 0); assert.equal(status.rescanning, false);
  const { nodes } = await f.service.request('node.custom.add', { name: 'Home', url: LOCAL_NODE }) as NodeSelection;
  assert.deepEqual(await f.service.request('wallet.settings', { autoLockMinutes: 15 }), { autoLockMinutes: 15, confirmWithPassword: false });
  assert.deepEqual(await f.service.request('wallet.settings', { confirmWithPassword: true }), { autoLockMinutes: 15, confirmWithPassword: true });
  await assert.rejects(f.service.request('wallet.settings', { confirmWithPassword: false }),
    { code: 'PASSWORD_REQUIRED', message: 'Enter your wallet password to turn off password confirmation for payments.' });
  await assert.rejects(f.service.request('wallet.settings', { confirmWithPassword: false, password: WRONG_PASSWORD }), { code: 'WRONG_PASSWORD', message: 'Incorrect password.' });
  // A supplied password is always verified, even when it is not required.
  await assert.rejects(f.service.request('wallet.settings', { autoLockMinutes: 60, password: WRONG_PASSWORD }), { code: 'WRONG_PASSWORD' });
  for (const params of [{ autoLockMinutes: 10 }, { autoLockMinutes: 0 }, { autoLockMinutes: '5' }, { confirmWithPassword: 'no' }, { theme: 'dark' }])
    await assert.rejects(f.service.request('wallet.settings', params), { code: 'INVALID_PARAMS' }, JSON.stringify(params));
  status = await f.status(); assert.equal(status.autoLockMinutes, 15); assert.equal(status.confirmWithPassword, true); assert.equal(status.walletOpen, true);
  await f.service.request('wallet.close');
  status = await f.status();
  assert.equal(status.autoLockMinutes, undefined); assert.equal(status.confirmWithPassword, undefined); assert.equal(status.restoreHeight, undefined);
  await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  status = await f.status(); assert.equal(status.autoLockMinutes, 15); assert.equal(status.confirmWithPassword, true);
  // Settings merge with, and never drop, the wallet's saved custom nodes.
  assert.deepEqual((await f.service.request('node.list') as NodeSelection).nodes.filter(node => node.kind === 'custom'), nodes.filter(node => node.kind === 'custom'));
  assert.deepEqual(await f.service.request('wallet.settings', { confirmWithPassword: false, password: OLD_PASSWORD }), { autoLockMinutes: 15, confirmWithPassword: false });
  assert.deepEqual(await f.service.request('wallet.settings', {}), { autoLockMinutes: 15, confirmWithPassword: false });
});

test('wallet.seed needs the password unless the wallet was created in this session under 30 minutes ago and never locked', async t => {
  const realNow = Date.now; let offset = 0; Date.now = () => realNow() + offset; t.after(() => { Date.now = realNow; });
  const f = fixture(t); const vaultId = await f.create();
  const required = { code: 'PASSWORD_REQUIRED', message: 'Enter your wallet password to view the recovery phrase.' };
  assert.deepEqual(await f.service.request('wallet.seed', {}), { seed: 'synthetic recovery phrase' });
  await assert.rejects(f.service.request('wallet.seed', { password: WRONG_PASSWORD }), { code: 'WRONG_PASSWORD', message: 'Incorrect password.' });
  assert.deepEqual(await f.service.request('wallet.seed', { password: OLD_PASSWORD }), { seed: 'synthetic recovery phrase' });
  await assert.rejects(f.service.request('wallet.seed', { extra: true }), { code: 'INVALID_PARAMS' });
  offset = 30 * 60_000;
  await assert.rejects(f.service.request('wallet.seed', {}), required);
  assert.deepEqual(await f.service.request('wallet.seed', { password: OLD_PASSWORD }), { seed: 'synthetic recovery phrase' });
  // Locking ends the window even inside the 30 minutes.
  await f.service.request('wallet.close'); offset = 0;
  await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  await assert.rejects(f.service.request('wallet.seed', {}), required);
  await f.service.request('wallet.close');
  await f.service.request('wallet.restore', { filename: 'restored-wallet', password: OLD_PASSWORD, network: 'mainnet', seed: 'w '.repeat(25).trim(), restoreHeight: 5 });
  await assert.rejects(f.service.request('wallet.seed', {}), required);
  await f.service.request('wallet.close');
  await f.service.request('wallet.create', { filename: 'fresh-wallet', password: OLD_PASSWORD, network: 'mainnet' });
  assert.deepEqual(await f.service.request('wallet.seed', {}), { seed: 'synthetic recovery phrase' });
  await f.service.request('wallet.password', { oldPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
  await assert.rejects(f.service.request('wallet.seed', {}), required, 'A password change ends the window');
  assert.deepEqual(await f.service.request('wallet.seed', { password: NEW_PASSWORD }), { seed: 'synthetic recovery phrase' });
});

test('wallet.keys requires the correct password and never returns the private spend key', async t => {
  const f = fixture(t); await f.create(); const engine = f.current();
  await assert.rejects(f.service.request('wallet.keys', {}), { code: 'PASSWORD_REQUIRED', message: 'Enter your wallet password to view the wallet keys.' });
  await assert.rejects(f.service.request('wallet.keys', { password: '' }), { code: 'PASSWORD_REQUIRED' });
  await assert.rejects(f.service.request('wallet.keys', { password: WRONG_PASSWORD }), { code: 'WRONG_PASSWORD', message: 'Incorrect password.' });
  await assert.rejects(f.service.request('wallet.keys', { password: OLD_PASSWORD, spend: true }), { code: 'INVALID_PARAMS' });
  assert.equal(engine.calls.includes('extKeys'), false, 'Keys are read only after verification');
  const keys = await f.service.request('wallet.keys', { password: OLD_PASSWORD });
  assert.deepEqual(keys, { primaryAddress: ADDRESS, publicViewKey: 'a'.repeat(64), privateViewKey: 'c'.repeat(64), publicSpendKey: 'd'.repeat(64) });
  assert.equal(JSON.stringify(keys).includes('e'.repeat(64)), false);
  assert.equal((await f.status()).walletOpen, true);
});

test('payment password confirmation is checked before any marker or relay; failures consume the review', async t => {
  const markers = new MarkerStore(); const f = fixture(t, new TabLock(), markers);
  let draft = await prepareSyntheticTransfer(f); const engine = f.current();
  const prepare = () => f.service.request('tx.prepare', { accountIndex: 0, address: ADDRESS, amount: '1', priority: 0 }) as Promise<Draft>;
  // With the setting off a supplied password is still verified.
  await assert.rejects(f.service.request('tx.confirm', { draftId: draft.draftId, password: WRONG_PASSWORD }),
    { code: 'WRONG_PASSWORD', message: 'Incorrect password. Nothing was sent; review the payment again.' });
  await f.service.request('wallet.settings', { confirmWithPassword: true });
  draft = await prepare();
  await assert.rejects(f.service.request('tx.confirm', { draftId: draft.draftId }),
    { code: 'PASSWORD_REQUIRED', message: 'Enter your wallet password to confirm this payment. Nothing was sent; review the payment again.' });
  await assert.rejects(f.service.request('tx.confirm', { draftId: draft.draftId, password: OLD_PASSWORD }), { code: 'DRAFT_NOT_FOUND' }, 'The review was consumed');
  draft = await prepare();
  await assert.rejects(f.service.request('tx.confirm', { draftId: draft.draftId, password: WRONG_PASSWORD }),
    { code: 'WRONG_PASSWORD', message: 'Incorrect password. Nothing was sent; review the payment again.' });
  assert.deepEqual(markers.writes, [], 'No recovery marker before a verified password');
  assert.equal(engine.calls.includes('extConfirm'), false); assert.equal(engine.drafts.size, 0); assert.equal(engine.networkEnabled, false);
  draft = await prepare();
  assert.deepEqual(await f.service.request('tx.confirm', { draftId: draft.draftId, password: OLD_PASSWORD }), { txHash: HASH });
  assert.equal(engine.calls.filter(method => method === 'extConfirm').length, 1); assert.equal(markers.value, null);
});

test('a wrong current password in wallet.password changes nothing and keeps the wallet open', async t => {
  const f = fixture(t); const vaultId = await f.create(); const engine = f.current();
  await assert.rejects(f.service.request('wallet.password', { oldPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD }), { code: 'WRONG_PASSWORD', message: 'Incorrect password.' });
  assert.equal(engine.calls.includes('changePassword'), false); assert.equal(engine.disposed, false);
  assert.equal((await f.status()).walletOpen, true); assert.ok(f.lock.owner);
  await f.service.request('wallet.close');
  await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
});

test('wallet.delete verifies the password, refuses busy or pending wallets, then deletes without saving', async t => {
  const markers = new MarkerStore(); const f = fixture(t, new TabLock(), markers);
  const other = await f.create(); await f.service.request('wallet.close');
  await f.service.request('wallet.create', { filename: 'delete-me', password: OLD_PASSWORD, network: 'mainnet' });
  const vaultId = (await f.status()).vaultId!; const engine = f.current();
  await assert.rejects(f.service.request('wallet.delete', {}), { code: 'PASSWORD_REQUIRED', message: 'Enter your wallet password to delete this wallet.' });
  await assert.rejects(f.service.request('wallet.delete', { password: WRONG_PASSWORD }), { code: 'WRONG_PASSWORD', message: 'Incorrect password.' });
  markers.value = { txHash: HASH, createdAt: 1 };
  await assert.rejects(f.service.request('wallet.delete', { password: OLD_PASSWORD }), { code: 'PENDING_TRANSFER', message: 'Resolve the pending transfer before deleting this wallet.' });
  markers.value = null;
  await selectLocalNode(f);
  const block = { entered: deferred(), gate: deferred() }; t.after(() => block.gate.resolve());
  engine.blockData = block; await f.service.request('wallet.refresh'); await block.entered.promise;
  await assert.rejects(f.service.request('wallet.delete', { password: OLD_PASSWORD }), { code: 'SYNC_BUSY' });
  block.gate.resolve(); await (f.service as unknown as { syncTask: Promise<void> }).syncTask;
  assert.equal((await f.status()).walletOpen, true);
  const exports = engine.exported.length;
  assert.deepEqual(await f.service.request('wallet.delete', { password: OLD_PASSWORD }), {});
  assert.equal(engine.exported.length, exports, 'Deleting never saves first'); assert.equal(engine.disposed, true);
  assert.equal(f.lock.owner, undefined);
  const status = await f.status(); assert.equal(status.walletOpen, false); assert.equal(status.vaultId, undefined);
  assert.deepEqual(((await f.service.request('wallet.list')) as { wallets: { id: string }[] }).wallets.map(wallet => wallet.id), [other]);
  await assert.rejects(f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD }), { code: 'NOT_FOUND' });
  await assert.rejects(f.service.request('wallet.delete', { password: OLD_PASSWORD }), { code: 'NO_WALLET' });
  // The name is free again.
  await f.service.request('wallet.create', { filename: 'delete-me', password: OLD_PASSWORD, network: 'mainnet' });
});

test('wallet.rescan validates node, height and pending payments, runs as a cancellable background sync and persists the height', async t => {
  const markers = new MarkerStore(); const f = fixture(t, new TabLock(), markers);
  const vaultId = await f.create(); const engine = f.current();
  await assert.rejects(f.service.request('wallet.rescan', {}), { code: 'NO_NODE' });
  const id = await selectLocalNode(f);
  for (const params of [{ restoreHeight: -1 }, { restoreHeight: 1.5 }, { restoreHeight: 1_000_000_000 }, { restoreHeight: '3' }, { from: 3 }])
    await assert.rejects(f.service.request('wallet.rescan', params), { code: 'INVALID_PARAMS' }, JSON.stringify(params));
  await assert.rejects(f.service.request('wallet.rescan', { restoreHeight: 11 }),
    { code: 'RESTORE_HEIGHT_TOO_HIGH', message: "Restore height 11 is above the node's current height 10. Choose a lower height." });
  assert.equal(engine.networkEnabled, false, 'The height check closes its network gate');
  markers.value = { txHash: HASH, createdAt: 1 };
  await assert.rejects(f.service.request('wallet.rescan', { restoreHeight: 3 }), { code: 'PENDING_TRANSFER' });
  markers.value = null; engine.outgoingPending = true;
  await assert.rejects(f.service.request('wallet.rescan', { restoreHeight: 3 }), { code: 'PENDING_OUTGOING' });
  engine.outgoingPending = false;
  assert.deepEqual(engine.rescans, []);
  const gate = deferred(); engine.rescanGate = gate; t.after(() => gate.resolve());
  assert.deepEqual(await f.service.request('wallet.rescan', { restoreHeight: 3 }), {});
  let status = await f.status(); assert.equal(status.rescanning, true); assert.equal(status.syncing, true); assert.equal(status.synced, false);
  await assert.rejects(f.service.request('wallet.rename', { name: 'busy' }), { code: 'SYNC_BUSY' });
  await assert.rejects(f.service.request('wallet.rescan', {}), { code: 'SYNC_BUSY' });
  engine.rescanGate = undefined; gate.resolve(); await (f.service as unknown as { syncTask: Promise<void> }).syncTask;
  status = await f.status();
  assert.equal(status.rescanning, false); assert.equal(status.syncing, false); assert.equal(status.synced, true); assert.equal(status.restoreHeight, 3);
  assert.deepEqual(engine.rescans, [[3, 10]]);
  assert.deepEqual(engine.nodeCalls.slice(-3), [['extNetwork', id, LOCAL_NODE], ['extConfigureNode', id, LOCAL_NODE], ['extNetwork', null]]);
  // Without a height the wallet's current restore height is used.
  await f.service.request('wallet.rescan', {}); await (f.service as unknown as { syncTask: Promise<void> }).syncTask;
  assert.deepEqual(engine.rescans.at(-1), [3, 10]);
  await f.service.request('wallet.close'); await f.service.request('wallet.open', { vaultId, password: OLD_PASSWORD });
  assert.equal((await f.status()).restoreHeight, 3, 'The rescan height is saved in the encrypted wallet');
  // Locking cancels a running rescan.
  const reopened = f.current(); const slow = deferred(); reopened.rescanGate = slow; t.after(() => slow.resolve());
  await f.service.request('wallet.rescan', { restoreHeight: 0 });
  assert.equal((await f.status()).rescanning, true);
  await f.service.request('wallet.close');
  assert.equal(reopened.calls.includes('extAbortNetwork'), true);
  status = await f.status(); assert.equal(status.walletOpen, false); assert.equal(status.rescanning, undefined);
});

test('address.integrated is local, built on the primary address, with a random or given payment ID', async t => {
  const f = fixture(t); await f.create(); const engine = f.current();
  assert.deepEqual(await f.service.request('address.integrated', {}), { integratedAddress: '4' + '2'.repeat(105), paymentId: 'fedcba9876543210' });
  assert.deepEqual(await f.service.request('address.integrated', { paymentId: 'ABCDEF0123456789' }), { integratedAddress: '4' + '2'.repeat(105), paymentId: 'abcdef0123456789' });
  assert.deepEqual(engine.integratedCalls, [[null], ['abcdef0123456789']]);
  for (const params of [{ paymentId: '0000000000000000' }, { paymentId: 'abc' }, { paymentId: 'g'.repeat(16) }, { paymentId: 'a'.repeat(64) }, { address: ADDRESS }])
    await assert.rejects(f.service.request('address.integrated', params), { code: 'INVALID_PARAMS' }, JSON.stringify(params));
  assert.deepEqual(engine.nodeCalls, [], 'No node or network permission is used');
  // Empty subaddress labels are allowed.
  assert.deepEqual(await f.service.request('address.create', { accountIndex: 0, label: '' }), { index: 1, address: OTHER_ADDRESS });
});
