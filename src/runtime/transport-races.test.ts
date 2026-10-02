import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { CONTROL_CHANNEL, type PendingTransfer } from './transport.ts';

// Fault-injected asynchronous storage schedules; no browser/user storage, native
// keys, public node access, or assumption about observed Chromium task timing.
const EXTENSION = 'a'.repeat(32);
const URL_OFFSCREEN = `chrome-extension://${EXTENSION}/offscreen.html`;
const OLD_DOCUMENT = '00000000-0000-4000-8000-000000000001';
const NEW_DOCUMENT = '00000000-0000-4000-8000-000000000002';
const HASH_A = 'a'.repeat(64), HASH_B = 'b'.repeat(64);
const oldSender = { id: EXTENSION, url: URL_OFFSCREEN, origin: `chrome-extension://${EXTENSION}`, documentId: OLD_DOCUMENT };
const newSender = { ...oldSender, documentId: NEW_DOCUMENT };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve };
}
async function tick() { await new Promise(resolve => setImmediate(resolve)); }
interface Response { ok: boolean; result?: unknown; error?: { code?: string; message: string } }
async function coordinatorFixture(phase?: 'permission' | 'remove') {
  let listener!: (message: unknown, sender: unknown, respond: (value: Response) => void) => boolean;
  let documentId = OLD_DOCUMENT;
  let marker: PendingTransfer | undefined = { txHash: HASH_A, createdAt: 1 };
  let writes = 0, created = 0;
  let shouldBlock = true;
  const entered = deferred(), gate = deferred();
  const maybeBlock = async (at: string) => {
    if (shouldBlock && phase === at) { shouldBlock = false; entered.resolve(); await gate.promise; }
  };
  const chromeMock = {
    runtime: { id: EXTENSION, getURL: (path: string) => `chrome-extension://${EXTENSION}/${path}`,
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      getContexts: async () => [{ documentId, documentUrl: URL_OFFSCREEN, contextType: 'OFFSCREEN_DOCUMENT' }],
      onMessage: { addListener: (fn: typeof listener) => { listener = fn; } }, onInstalled: { addListener: () => {} } },
    offscreen: { Reason: { WORKERS: 'WORKERS' }, createDocument: async () => { created++; } },
    storage: { local: {
      get: async () => ({ unresolvedTransfer: marker && { ...marker } }),
      setAccessLevel: async () => { await maybeBlock('permission'); },
      set: async (value: { unresolvedTransfer: PendingTransfer }) => { writes++; marker = structuredClone(value.unresolvedTransfer); },
      remove: async () => { await maybeBlock('remove'); writes++; marker = undefined; },
    }, session: { remove: async () => {} } },
  };
  const bundle = await build({ entryPoints: ['src/runtime/transport-background.ts'], bundle: true, format: 'iife', platform: 'browser', write: false });
  const restart = () => vm.runInNewContext(bundle.outputFiles[0].text, { chrome: chromeMock, URL, Error, Object, Number, Set });
  restart();
  const control = (sender: { url?: string; documentId?: string }, action: string, extra: Record<string, unknown> = {}) => new Promise<Response | undefined>(resolve => {
    // Model the actor captured once at offscreen bootstrap, not a lookup of the
    // current replacement document. Native sender identity is independently kept.
    const actor = sender.url === URL_OFFSCREEN && action.startsWith('marker.') ? { documentId: sender.documentId } : {};
    const kept = listener({ channel: CONTROL_CHANNEL, action, ...actor, ...extra }, sender, response => resolve(structuredClone(response)));
    if (!kept) resolve(undefined);
  });
  return { control, entered, gate, restart, replace: () => { documentId = NEW_DOCUMENT; },
    marker: () => marker && { ...marker }, writes: () => writes, created: () => created };
}

test('old offscreen clear awaiting permission cannot overtake replacement read or erase its new transfer hash', async t => {
  const f = await coordinatorFixture('permission'); t.after(() => f.gate.resolve());
  const oldClear = f.control(oldSender, 'marker.write', { value: null });
  await Promise.race([f.entered.promise, oldClear.then(() => { throw new Error('Clear must reach the held storage operation before completing'); })]); f.replace();
  let replacementReadFinished = false;
  const replacement = (async () => {
    const read = await f.control(newSender, 'marker.read'); replacementReadFinished = true;
    assert.deepEqual(read?.result, { txHash: HASH_A, createdAt: 1 }, 'Dead document must not clear A after its permission await');
    assert.equal((await f.control(newSender, 'marker.write', { value: null }))?.ok, true);
    assert.equal((await f.control(newSender, 'marker.write', { value: { txHash: HASH_B, createdAt: 2 } }))?.ok, true);
  })();
  void replacement.catch(() => undefined);
  await tick(); assert.equal(replacementReadFinished, false, 'Replacement reads must join the outstanding marker fence');
  f.gate.resolve();
  const oldResult = await oldClear; assert.equal(oldResult?.ok, false); assert.equal(oldResult?.error?.code, 'PENDING_STORAGE_ERROR');
  await replacement;
  assert.deepEqual(f.marker(), { txHash: HASH_B, createdAt: 2 });
});

test('old clear already inside Chrome storage retains its fence until the actual remove settles', async t => {
  const f = await coordinatorFixture('remove'); t.after(() => f.gate.resolve());
  const oldClear = f.control(oldSender, 'marker.write', { value: null });
  await Promise.race([f.entered.promise, oldClear.then(() => { throw new Error('Clear must reach the held storage operation before completing'); })]); f.replace();
  let replacementReadFinished = false;
  const replacement = (async () => {
    const read = await f.control(newSender, 'marker.read'); replacementReadFinished = true;
    assert.equal(read?.result, null, 'Replacement observes the old accepted clear only after it actually settles');
    assert.equal((await f.control(newSender, 'marker.write', { value: { txHash: HASH_B, createdAt: 2 } }))?.ok, true);
  })();
  void replacement.catch(() => undefined);
  await tick(); assert.equal(replacementReadFinished, false);
  f.gate.resolve(); assert.equal((await oldClear)?.ok, true); await replacement;
  assert.deepEqual(f.marker(), { txHash: HASH_B, createdAt: 2 });
});

test('same URL from a superseded offscreen document cannot mutate the replacement marker', async () => {
  const f = await coordinatorFixture(); f.replace();
  assert.equal((await f.control(newSender, 'marker.write', { value: { txHash: HASH_B, createdAt: 2 } }))?.ok, true);
  const writes = f.writes();
  const stale = await f.control(oldSender, 'marker.write', { value: null });
  assert.equal(stale?.ok, false); assert.equal(stale?.error?.code, 'PENDING_STORAGE_ERROR');
  const missingDocument = await f.control({ ...newSender, documentId: undefined }, 'marker.write', { value: null });
  assert.equal(missingDocument?.ok, false);
  assert.equal(f.writes(), writes); assert.deepEqual(f.marker(), { txHash: HASH_B, createdAt: 2 });
});

test('a restarted coordinator rediscovers current offscreen identity without losing its stored marker', async () => {
  const f = await coordinatorFixture(); f.replace();
  assert.equal((await f.control(newSender, 'marker.write', { value: { txHash: HASH_B, createdAt: 2 } }))?.ok, true);
  f.restart();
  assert.deepEqual((await f.control(newSender, 'marker.read'))?.result, { txHash: HASH_B, createdAt: 2 });
  const ui = { id: EXTENSION, url: `chrome-extension://${EXTENSION}/index.html?popup=1`, origin: `chrome-extension://${EXTENSION}`, frameId: 0 };
  assert.equal((await f.control(ui, 'ensureOffscreen'))?.ok, true);
  assert.equal(f.created(), 0); assert.equal(f.writes(), 1);
  assert.deepEqual(f.marker(), { txHash: HASH_B, createdAt: 2 });
});
