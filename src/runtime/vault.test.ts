import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import {
  VAULT_DB_NAME, VAULT_STORE_NAME, VAULT_KDF_ITERATIONS, VAULT_MAX_SETTINGS_BYTES,
  VaultError, createVault, listVaults, unlockVault, saveVault, changeVaultPassword,
  closeVaultSession, exportVault, importVault, verifyVaultPassword, deleteVault, validVaultName,
} from './vault.ts';
import type { VaultData, VaultErrorCode, VaultSession } from './vault.ts';

const password = 'local-only-strong-test-password';
const secret = 'seed-wallet-secret-never-persist-this-in-plaintext-9f31d76b';
const address = 'private-address-fixture-not-a-real-Monero-wallet-address';
const text = new TextEncoder();
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
function setGlobal(name: 'crypto' | 'indexedDB', value: unknown) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}
function freshStorage() { setGlobal('indexedDB', new IDBFactory()); }
beforeEach(() => { setGlobal('crypto', webcrypto); freshStorage(); });
afterEach(() => {
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else Reflect.deleteProperty(globalThis, 'crypto');
  if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB);
  else Reflect.deleteProperty(globalThis, 'indexedDB');
});
function payload(label = 'initial'): VaultData {
  return { keysData: text.encode(secret), cacheData: text.encode(`${address}:${label}:12000000000000`),
    selectedNodeId: 'private-node-selection', restoreHeight: 123456,
    settings: { label, nested: { privateNote: 'encrypted-note-only', enabled: true }, values: [null, 123, 'amount'] } };
}
function create(name = 'Wallet', data = payload()) { return createVault({ name, network: 'stagenet', password, ...data }); }
function expectCode(code: VaultErrorCode) {
  return (error: unknown) => { assert.ok(error instanceof VaultError); assert.equal(error.code, code); return true; };
}
function equalData(actual: VaultData, expected: VaultData) {
  assert.deepEqual(actual.keysData, expected.keysData);
  assert.deepEqual(actual.cacheData, expected.cacheData);
  assert.equal(actual.selectedNodeId, expected.selectedNodeId);
  assert.equal(actual.restoreHeight, expected.restoreHeight);
  assert.deepEqual(JSON.parse(JSON.stringify(actual.settings)), JSON.parse(JSON.stringify(expected.settings)));
}
async function rawDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_DB_NAME, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function rawRecords(): Promise<unknown[]> {
  const db = await rawDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE_NAME, 'readonly');
    const req = tx.objectStore(VAULT_STORE_NAME).getAll();
    tx.oncomplete = () => { db.close(); resolve(req.result); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}
function flattenPersistence(value: unknown): string {
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (Array.isArray(value)) return value.map(flattenPersistence).join('|');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => key + ':' + flattenPersistence(item)).join('|');
  return String(value);
}
async function abortWrites<T>(operation: () => Promise<T>): Promise<T> {
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
    const request = original.apply(this, args);
    request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  try { return await operation(); } finally { IDBObjectStore.prototype.put = original; }
}

test('browser-only module is lazy, metadata lists do not require crypto, and empty storage is honest', async () => {
  setGlobal('crypto', undefined);
  assert.deepEqual(await listVaults(), []);
  setGlobal('indexedDB', undefined);
  await assert.rejects(listVaults(), expectCode('STORAGE_FAILED'));
});

test('create/unlock preserves real opaque wallet bytes and encrypted settings, without mutating caller buffers', async () => {
  const data = payload();
  // Non-ASCII name (accents and an emoji) checks Unicode round-tripping.
  const unicodeName = 'Caf\u00e9 wallet \u2014 d\u00e9j\u00e0 vu \u{1F511}';
  const { meta, session } = await create(unicodeName, data);
  assert.equal(meta.name, unicodeName); assert.equal(meta.network, 'stagenet');
  assert.equal(meta.schemaVersion, 1); assert.equal(meta.revision, 1);
  assert.match(meta.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await listVaults(), [meta]);
  assert.deepEqual(Object.keys(session), ['id']);
  assert.equal(JSON.stringify(session), JSON.stringify({ id: meta.id }));
  assert.equal(Object.isFrozen(session), true); assert.equal(Object.isFrozen(meta), true);
  equalData((await unlockVault(meta.id, password)).data, data);
  assert.equal(new TextDecoder().decode(data.keysData), secret);
  const stored = flattenPersistence(await rawRecords());
  for (const forbidden of [secret, address, password, 'private-node-selection', 'encrypted-note-only', '12000000000000']) {
    assert.equal(stored.includes(forbidden), false, `Plaintext persisted: ${forbidden}`);
  }
  const backup = await exportVault(meta.id);
  for (const forbidden of [secret, address, password, 'private-node-selection', 'encrypted-note-only']) assert.equal(backup.includes(forbidden), false);
});

test('crypto uses nonextractable PBKDF2/AES-256 keys, 600000 iterations, 16-byte salt and 12-byte IV', async () => {
  const imported: CryptoKey[] = [], derived: CryptoKey[] = [];
  const derivations: unknown[][] = [], encryptions: unknown[][] = [];
  const subtle = new Proxy(webcrypto.subtle, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      return async (...args: unknown[]) => {
        if (property === 'deriveKey') derivations.push(args);
        if (property === 'encrypt') encryptions.push(args);
        const result = await member.apply(target, args);
        if (property === 'importKey') imported.push(result);
        if (property === 'deriveKey') derived.push(result);
        return result;
      };
    },
  });
  setGlobal('crypto', { subtle, getRandomValues: webcrypto.getRandomValues.bind(webcrypto), randomUUID: webcrypto.randomUUID.bind(webcrypto) });
  const { session } = await create();
  await saveVault(session, payload('new'));
  assert.equal(imported.length, 1); assert.equal(imported[0].extractable, false);
  assert.equal(imported[0].algorithm.name, 'PBKDF2'); assert.deepEqual(imported[0].usages, ['deriveKey']);
  for (const key of derived) { assert.equal(key.extractable, false); assert.equal(key.algorithm.name, 'AES-GCM'); assert.equal((key.algorithm as AesKeyAlgorithm).length, 256); }
  for (const args of derivations) {
    const options = args[0] as Pbkdf2Params;
    assert.equal(options.iterations, 600000); assert.equal(options.hash, 'SHA-256'); assert.equal(options.salt.byteLength, 16);
  }
  for (const args of encryptions) {
    const options = args[0] as AesGcmParams;
    assert.equal(options.iv.byteLength, 12); assert.equal(options.tagLength, 128);
    assert.ok(options.additionalData && options.additionalData.byteLength > 100);
  }
});

test('every save rotates salt, IV and ciphertext and survives a fresh unlock with the original password', async () => {
  const { meta, session } = await create();
  const first = JSON.parse(await exportVault(meta.id));
  const secondMeta = await saveVault(session, payload('second'));
  const second = JSON.parse(await exportVault(meta.id));
  const thirdMeta = await saveVault(session, payload('third'));
  const third = JSON.parse(await exportVault(meta.id));
  assert.equal(secondMeta.revision, 2); assert.equal(thirdMeta.revision, 3);
  assert.ok(thirdMeta.updatedAt > secondMeta.updatedAt);
  assert.equal(new Set([first.kdf.salt, second.kdf.salt, third.kdf.salt]).size, 3);
  assert.equal(new Set([first.cipher.iv, second.cipher.iv, third.cipher.iv]).size, 3);
  assert.equal(new Set([first.cipher.ciphertext, second.cipher.ciphertext, third.cipher.ciphertext]).size, 3);
  equalData((await unlockVault(meta.id, password)).data, payload('third'));
});

test('wrong or empty password fails safely without changing stored bytes', async () => {
  const { meta } = await create();
  const backup = await exportVault(meta.id);
  await assert.rejects(unlockVault(meta.id, 'wrong'), expectCode('WRONG_PASSWORD_OR_CORRUPT'));
  await assert.rejects(unlockVault(meta.id, ''), expectCode('WRONG_PASSWORD_OR_CORRUPT'));
  assert.equal(await exportVault(meta.id), backup);
});

test('metadata, salt, IV and ciphertext are authenticated; structurally valid import is not claimed verified', async () => {
  const { meta } = await create();
  const original = JSON.parse(await exportVault(meta.id));
  const tweaks = [
    (b: typeof original) => { b.meta.name = 'Changed name'; },
    (b: typeof original) => { b.meta.network = 'mainnet'; },
    (b: typeof original) => { b.meta.id = webcrypto.randomUUID(); },
    (b: typeof original) => { b.meta.createdAt -= 1; },
    (b: typeof original) => { b.meta.updatedAt += 1; },
    (b: typeof original) => { b.meta.revision += 1; },
    (b: typeof original) => { const bytes = Buffer.from(b.kdf.salt, 'base64'); bytes[0] ^= 1; b.kdf.salt = bytes.toString('base64'); },
    (b: typeof original) => { const bytes = Buffer.from(b.cipher.iv, 'base64'); bytes[0] ^= 1; b.cipher.iv = bytes.toString('base64'); },
    (b: typeof original) => { const bytes = Buffer.from(b.cipher.ciphertext, 'base64'); bytes[0] ^= 1; b.cipher.ciphertext = bytes.toString('base64'); },
  ];
  for (const tweak of tweaks) {
    const backup = structuredClone(original); tweak(backup); freshStorage();
    const imported = await importVault(JSON.stringify(backup)); // Structure only, not authentication.
    assert.equal(imported.id, backup.meta.id);
    await assert.rejects(unlockVault(imported.id, password), expectCode('WRONG_PASSWORD_OR_CORRUPT'));
  }
});

test('two independent stale sessions cannot silently overwrite a newer commit', async () => {
  const { meta, session: first } = await create();
  const { session: second } = await unlockVault(meta.id, password);
  await saveVault(first, payload('first commit'));
  await assert.rejects(saveVault(second, payload('stale overwrite')), expectCode('CONFLICT'));
  equalData((await unlockVault(meta.id, password)).data, payload('first commit'));
});

test('concurrent saves from the very same session use captured revisions rather than last-completion wins', async () => {
  const { meta, session } = await create();
  const results = await Promise.allSettled([saveVault(session, payload('one')), saveVault(session, payload('two'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  expectCode('CONFLICT')(rejected.reason);
  const unlocked = await unlockVault(meta.id, password);
  assert.equal(unlocked.meta.revision, 2);
  assert.ok(['one', 'two'].includes(unlocked.data.settings?.label as string));
});

test('transaction abort AFTER put success leaves old ciphertext and expected session revision intact', async () => {
  const { meta, session } = await create();
  const before = await exportVault(meta.id);
  await assert.rejects(abortWrites(() => saveVault(session, payload('must not commit'))), expectCode('STORAGE_FAILED'));
  assert.equal(await exportVault(meta.id), before);
  assert.equal((await saveVault(session, payload('retry intentional'))).revision, 2);
  equalData((await unlockVault(meta.id, password)).data, payload('retry intentional'));
});

test('password rotation commits atomically, revokes old capability, and stale sessions cannot roll it back', async () => {
  const { meta, session } = await create();
  const stale = (await unlockVault(meta.id, password)).session;
  const changed = await changeVaultPassword(session, 'new-long-test-password', payload('new native key export'));
  assert.equal(changed.meta.revision, 2);
  await assert.rejects(unlockVault(meta.id, password), expectCode('WRONG_PASSWORD_OR_CORRUPT'));
  await assert.rejects(saveVault(session, payload()), expectCode('SESSION_CLOSED'));
  await assert.rejects(saveVault(stale, payload()), expectCode('CONFLICT'));
  equalData((await unlockVault(meta.id, 'new-long-test-password')).data, payload('new native key export'));
  await saveVault(changed.session, payload('after password change'));
  equalData((await unlockVault(meta.id, 'new-long-test-password')).data, payload('after password change'));
});

test('failed password rotation preserves old working session and old unlock password', async () => {
  const { meta, session } = await create();
  await assert.rejects(abortWrites(() => changeVaultPassword(session, 'new-long-test-password', payload('new'))), expectCode('STORAGE_FAILED'));
  equalData((await unlockVault(meta.id, password)).data, payload());
  await assert.rejects(unlockVault(meta.id, 'new-long-test-password'), expectCode('WRONG_PASSWORD_OR_CORRUPT'));
  assert.equal((await saveVault(session, payload('still open'))).revision, 2);
});

test('closing a session is idempotent and revokes even an encrypting, not-yet-committed save', async () => {
  const { meta, session } = await create();
  const inFlight = saveVault(session, payload('late'));
  closeVaultSession(session); closeVaultSession(session);
  await assert.rejects(inFlight, expectCode('SESSION_CLOSED'));
  await assert.rejects(saveVault(session, payload()), expectCode('SESSION_CLOSED'));
  await assert.rejects(saveVault({ id: meta.id } as VaultSession, payload()), expectCode('SESSION_CLOSED'));
  assert.equal((await unlockVault(meta.id, password)).meta.revision, 1);
});

test('encrypted backup round-trip preserves identity and never overwrites IDs or unique names', async () => {
  const { meta } = await create();
  const backup = await exportVault(meta.id);
  await assert.rejects(importVault(backup), expectCode('DUPLICATE_ID'));
  await assert.rejects(create(), expectCode('DUPLICATE_NAME'));
  const nameCollision = JSON.parse(backup); nameCollision.meta.id = webcrypto.randomUUID();
  await assert.rejects(importVault(JSON.stringify(nameCollision)), expectCode('DUPLICATE_NAME'));
  assert.equal((await listVaults()).length, 1);
  freshStorage();
  assert.deepEqual(await importVault(backup), meta);
  assert.equal(await exportVault(meta.id), backup);
  equalData((await unlockVault(meta.id, password)).data, payload());
});

test('backup validation rejects dangerous or unbounded crypto parameters before KDF/decryption or persistence', async () => {
  const { meta } = await create();
  const good = JSON.parse(await exportVault(meta.id));
  const bad = [
    (b: typeof good) => { b.kdf.iterations = 10 ** 12; },
    (b: typeof good) => { b.kdf.iterations = VAULT_KDF_ITERATIONS - 1; },
    (b: typeof good) => { b.kdf.hash = 'SHA-1'; },
    (b: typeof good) => { b.kdf.salt = 'AA=='; },
    (b: typeof good) => { b.cipher.iv = 'AA=='; },
    (b: typeof good) => { b.cipher.tagLength = 32; },
    (b: typeof good) => { b.cipher.ciphertext = [1, 2, 3]; },
    (b: typeof good) => { b.cipher.ciphertext = 'AAAA==='; },
    (b: typeof good) => { b.cipher.name = 'AES-CBC'; },
    (b: typeof good) => { b.meta.schemaVersion = 2; },
    (b: typeof good) => { b.meta.revision = -1; },
    (b: typeof good) => { b.meta.name = '../wallet'; },
    (b: typeof good) => { b.meta.network = 'custom'; },
    (b: typeof good) => { b.meta.id = '../../keys'; },
    (b: typeof good) => { b.path = '/tmp/wallet'; },
    (b: typeof good) => { Object.defineProperty(b.meta, '__proto__', { value: {}, enumerable: true }); },
    (b: typeof good) => { b.kdf.extra = 'unexpected'; },
  ];
  freshStorage(); setGlobal('crypto', undefined); // Import validation must not even need a crypto provider.
  for (const tweak of bad) {
    const backup = structuredClone(good); tweak(backup);
    await assert.rejects(importVault(JSON.stringify(backup)), expectCode('INVALID_BACKUP'));
  }
  for (const text of ['', '{', 'null', '[]', '{"__proto__":{"polluted":true}}']) await assert.rejects(importVault(text), expectCode('INVALID_BACKUP'));
  assert.deepEqual(await listVaults(), []); assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('invalid names, passwords, binary inputs, restore heights and settings fail without persistence', async () => {
  const cases = [
    { name: '' }, { name: ' leading' }, { name: 'trailing ' }, { name: 'x'.repeat(65) }, { name: '../path' },
    { password: 'short' }, { password: ' '.repeat(12) }, { password: 'x'.repeat(1025) },
    { network: 'unknown' }, { keysData: new Uint8Array() }, { keysData: [1, 2, 3] }, { cacheData: undefined },
    { restoreHeight: -1 }, { restoreHeight: 1.5 }, { selectedNodeId: 'bad\nnode' },
    { settings: { value: 1n } }, { settings: JSON.parse('{"__proto__":{"polluted":true}}') },
  ];
  for (const patch of cases) {
    await assert.rejects(createVault({ name: 'Wallet', network: 'stagenet', password, ...payload(), ...patch } as Parameters<typeof createVault>[0]), expectCode('INVALID_INPUT'));
  }
  await assert.rejects(create('Large settings', { ...payload(), settings: { secret: 'x'.repeat(VAULT_MAX_SETTINGS_BYTES + 1) } }), expectCode('LIMIT_EXCEEDED'));
  assert.deepEqual(await listVaults(), []);
});

test('missing records, crypto failure, and IndexedDB errors have typed errors without upstream secret messages', async () => {
  await assert.rejects(unlockVault(webcrypto.randomUUID(), password), expectCode('NOT_FOUND'));
  await assert.rejects(unlockVault('../path', password), expectCode('INVALID_INPUT'));
  setGlobal('crypto', undefined);
  await assert.rejects(create(), expectCode('CRYPTO_UNAVAILABLE'));
  setGlobal('crypto', webcrypto);
  setGlobal('indexedDB', { open() { throw new Error(`quota failure ${secret} ${password}`); } });
  try { await create(); assert.fail('Storage error expected'); }
  catch (error) {
    expectCode('STORAGE_FAILED')(error);
    assert.equal(String(error).includes(secret), false); assert.equal(String(error).includes(password), false);
  }
});

test('password verification reads the stored record, writes nothing and never unlocks a closed or stale session', async () => {
  const { meta, session } = await create();
  const before = await exportVault(meta.id);
  assert.equal(await verifyVaultPassword(session, password), true);
  for (const wrong of ['wrong', '', ' ' + password, password.toUpperCase(), 'x'.repeat(2000)]) assert.equal(await verifyVaultPassword(session, wrong), false);
  assert.equal(await exportVault(meta.id), before, 'Verification never rewrites the record');
  // Another session committed a newer revision: this capability is stale, not a password oracle for it.
  const { session: other } = await unlockVault(meta.id, password);
  await saveVault(other, payload('newer'));
  await assert.rejects(verifyVaultPassword(session, password), expectCode('CONFLICT'));
  assert.equal(await verifyVaultPassword(other, password), true);
  closeVaultSession(other);
  await assert.rejects(verifyVaultPassword(other, password), expectCode('SESSION_CLOSED'));
});

test('rename commits the authenticated name with the data in one revision; taken names change nothing', async () => {
  const { meta, session } = await create('Original');
  await create('Taken');
  const renamed = await saveVault(session, payload('renamed'), 'Renamed wallet');
  assert.equal(renamed.name, 'Renamed wallet'); assert.equal(renamed.revision, meta.revision + 1);
  assert.deepEqual((await listVaults()).map(item => item.name).sort(), ['Renamed wallet', 'Taken']);
  const reopened = await unlockVault(meta.id, password);
  assert.equal(reopened.meta.name, 'Renamed wallet'); equalData(reopened.data, payload('renamed'));
  closeVaultSession(reopened.session);
  const before = await exportVault(meta.id);
  await assert.rejects(saveVault(session, payload('dup'), 'Taken'), expectCode('DUPLICATE_NAME'));
  assert.equal(await exportVault(meta.id), before, 'A duplicate name aborts the whole transaction');
  // The session stays usable after a refused rename; the old name is free again after a rename.
  await saveVault(session, payload('still usable'));
  for (const bad of ['', ' padded ', 'a/b', 'a\\b', 'tab\there', '.', '..', 'x'.repeat(65)]) {
    assert.equal(validVaultName(bad), false, JSON.stringify(bad));
    await assert.rejects(saveVault(session, payload('bad'), bad), expectCode('INVALID_INPUT'));
  }
  assert.equal(validVaultName('Savings \u2713'), true);
  await create('Original');
});

test('delete removes only the committed record of an active session and revokes the session', async () => {
  const { meta, session } = await create('Delete me');
  const kept = await create('Keep me');
  await deleteVault(session);
  assert.deepEqual((await listVaults()).map(item => item.id), [kept.meta.id]);
  await assert.rejects(unlockVault(meta.id, password), expectCode('NOT_FOUND'));
  await assert.rejects(saveVault(session, payload()), expectCode('SESSION_CLOSED'));
  await assert.rejects(deleteVault(session), expectCode('SESSION_CLOSED'));
  // A stale session (another session committed since) cannot delete the newer record.
  const { session: stale } = await unlockVault(kept.meta.id, password);
  await saveVault(kept.session, payload('newer'));
  await assert.rejects(deleteVault(stale), expectCode('CONFLICT'));
  assert.equal((await listVaults()).length, 1);
  await create('Delete me');
});
