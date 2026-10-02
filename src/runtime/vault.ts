/**
 * Standalone browser vault. Only authenticated ciphertext and explicitly public
 * metadata enter IndexedDB; no companion, filesystem, chrome.storage, or Node APIs.
 *
 * Payload cap: 128 MiB including keys, cache, framing and at most 64 KiB settings.
 * A save needs multiple in-memory copies; callers should debounce large cache saves.
 * List/import metadata is UNVERIFIED until unlock authenticates the AES-GCM tag.
 */
export const VAULT_DB_NAME = 'monero-extension-encrypted-vaults';
export const VAULT_STORE_NAME = 'vaults';
export const VAULT_SCHEMA_VERSION = 1 as const;
export const VAULT_KDF_ITERATIONS = 600_000;
export const VAULT_MAX_PLAINTEXT_BYTES = 128 * 1024 * 1024;
export const VAULT_MAX_SETTINGS_BYTES = 64 * 1024;
export const VAULT_MAX_BACKUP_CHARS = 4 * Math.ceil((VAULT_MAX_PLAINTEXT_BYTES + 16) / 3) + 16_384;
const FORMAT = 'monero-extension-vault';
const META_INDEX = 'public-metadata';
const NAME_INDEX = 'unique-name';
const HEADER_BYTES = 16;
const MAX_REVISION = 0xffffffff;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export type VaultNetwork = 'mainnet' | 'stagenet' | 'testnet';
export type VaultJson = null | boolean | number | string | VaultJson[] | { [key: string]: VaultJson };
export interface VaultMeta {
  id: string; name: string; network: VaultNetwork;
  createdAt: number; updatedAt: number; schemaVersion: 1; revision: number;
}
export interface VaultData {
  keysData: Uint8Array;
  cacheData: Uint8Array;
  selectedNodeId?: string;
  restoreHeight?: number;
  settings?: Record<string, VaultJson>;
}
export interface CreateVaultOptions extends VaultData { name: string; network: VaultNetwork; password: string }
declare const sessionBrand: unique symbol;
/** Opaque, non-serializable capability. Close it explicitly when locking. */
export interface VaultSession { readonly id: string; readonly [sessionBrand]: true }
export type VaultErrorCode = 'WRONG_PASSWORD_OR_CORRUPT' | 'NOT_FOUND' | 'STORAGE_FAILED' | 'CONFLICT' |
  'DUPLICATE_ID' | 'DUPLICATE_NAME' | 'INVALID_INPUT' | 'INVALID_BACKUP' | 'LIMIT_EXCEEDED' |
  'CRYPTO_UNAVAILABLE' | 'CRYPTO_FAILED' | 'SESSION_CLOSED';
const messages: Record<VaultErrorCode, string> = {
  WRONG_PASSWORD_OR_CORRUPT: 'Incorrect password or damaged encrypted wallet.',
  NOT_FOUND: 'Encrypted wallet was not found.',
  STORAGE_FAILED: 'Browser wallet storage failed. No successful save is confirmed.',
  CONFLICT: 'The wallet changed in another session. Reload and unlock it before saving again.',
  DUPLICATE_ID: 'This encrypted wallet already exists. Import never overwrites a wallet.',
  DUPLICATE_NAME: 'A wallet with this name already exists.',
  INVALID_INPUT: 'Wallet input is invalid.',
  INVALID_BACKUP: 'Encrypted wallet backup has an invalid or unsupported format.',
  LIMIT_EXCEEDED: 'Wallet data exceeds the supported size or revision limit.',
  CRYPTO_UNAVAILABLE: 'Secure browser cryptography is unavailable.',
  CRYPTO_FAILED: 'Wallet encryption failed. No successful save is confirmed.',
  SESSION_CLOSED: 'The wallet session is locked or unavailable.',
};
export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode) { super(messages[code]); this.name = 'VaultError'; this.code = code; }
}
interface VaultRecord {
  format: typeof FORMAT;
  meta: VaultMeta;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: typeof VAULT_KDF_ITERATIONS; salt: ArrayBuffer };
  cipher: { name: 'AES-GCM'; tagLength: 128; iv: ArrayBuffer; ciphertext: ArrayBuffer };
}
interface SessionState {
  key: CryptoKey; // Nonextractable PBKDF2 key, not a password string or exportable AES key.
  meta: VaultMeta;
  stamp: string;
  salt: Uint8Array;
  iv: Uint8Array;
  active: boolean;
}
const sessions = new WeakMap<object, SessionState>();
function fail(code: VaultErrorCode): never { throw new VaultError(code); }
function mapped(error: unknown, code: VaultErrorCode): VaultError { return error instanceof VaultError ? error : new VaultError(code); }
function cryptoProvider(): Crypto {
  const provider = globalThis.crypto;
  if (!provider?.subtle || typeof provider.getRandomValues !== 'function' || typeof provider.randomUUID !== 'function') fail('CRYPTO_UNAVAILABLE');
  return provider;
}
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exact(value: unknown, names: readonly string[], code: VaultErrorCode): asserts value is Record<string, unknown> {
  if (!plain(value) || Reflect.ownKeys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) fail(code);
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
/** Wallet display-name rules shared by create, import and rename. */
export function validVaultName(value: unknown): value is string { return validName(value); }
function validName(value: unknown): value is string {
  // Display names, never paths. Exact names are globally unique across networks.
  return typeof value === 'string' && value.length >= 1 && value.length <= 64 && value.trim() === value &&
    !/[\u0000-\u001f\u007f/\\]/.test(value) && !['.', '..'].includes(value);
}
function validateMeta(value: unknown, code: VaultErrorCode): VaultMeta {
  exact(value, ['id', 'name', 'network', 'createdAt', 'updatedAt', 'schemaVersion', 'revision'], code);
  if (typeof value.id !== 'string' || !UUID.test(value.id) || !validName(value.name) ||
      !['mainnet', 'stagenet', 'testnet'].includes(value.network as string) ||
      value.schemaVersion !== VAULT_SCHEMA_VERSION || !integer(value.createdAt, 0) ||
      !integer(value.updatedAt, value.createdAt) || !integer(value.revision, 1, MAX_REVISION)) fail(code);
  return { id: value.id, name: value.name, network: value.network as VaultNetwork,
    createdAt: value.createdAt, updatedAt: value.updatedAt, schemaVersion: 1, revision: value.revision };
}
function publicMeta(meta: VaultMeta): VaultMeta { return Object.freeze({ ...meta }); }
function buffer(value: unknown, min: number, max: number, code: VaultErrorCode): asserts value is ArrayBuffer {
  if (!(value instanceof ArrayBuffer) || value.byteLength < min || value.byteLength > max) fail(code);
}
function validateRecord(value: unknown, code: VaultErrorCode): VaultRecord {
  exact(value, ['format', 'meta', 'kdf', 'cipher'], code);
  if (value.format !== FORMAT) fail(code);
  const meta = validateMeta(value.meta, code);
  exact(value.kdf, ['name', 'hash', 'iterations', 'salt'], code);
  exact(value.cipher, ['name', 'tagLength', 'iv', 'ciphertext'], code);
  if (value.kdf.name !== 'PBKDF2' || value.kdf.hash !== 'SHA-256' || value.kdf.iterations !== VAULT_KDF_ITERATIONS ||
      value.cipher.name !== 'AES-GCM' || value.cipher.tagLength !== 128) fail(code);
  buffer(value.kdf.salt, 16, 16, code); buffer(value.cipher.iv, 12, 12, code);
  buffer(value.cipher.ciphertext, HEADER_BYTES + 2 + 1 + 16, VAULT_MAX_PLAINTEXT_BYTES + 16, code);
  return { format: FORMAT, meta,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: VAULT_KDF_ITERATIONS, salt: value.kdf.salt },
    cipher: { name: 'AES-GCM', tagLength: 128, iv: value.cipher.iv, ciphertext: value.cipher.ciphertext } };
}
function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  // Multiple of 3, below browser argument-count limits; no giant binary strings.
  for (let i = 0; i < bytes.length; i += 49_152) parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 49_152))));
  return parts.join('');
}
function unbase64(value: unknown, minBytes: number, maxBytes: number): ArrayBuffer {
  if (typeof value !== 'string' || value.length % 4 !== 0 || value.length > 4 * Math.ceil(maxBytes / 3) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('INVALID_BACKUP');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const length = value.length / 4 * 3 - padding;
  if (length < minBytes || length > maxBytes) fail('INVALID_BACKUP');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if ((padding === 2 && (alphabet.indexOf(value[value.length - 3]) & 15) !== 0) ||
      (padding === 1 && (alphabet.indexOf(value[value.length - 2]) & 3) !== 0)) fail('INVALID_BACKUP');
  const bytes = new Uint8Array(length);
  try {
    let offset = 0;
    for (let i = 0; i < value.length; i += 65_536) {
      const part = atob(value.slice(i, i + 65_536));
      for (let j = 0; j < part.length; j++) bytes[offset++] = part.charCodeAt(j);
    }
  } catch { bytes.fill(0); fail('INVALID_BACKUP'); }
  return bytes.buffer;
}
function authenticatedHeader(record: Omit<VaultRecord, never>): string {
  // Fixed construction order; all public metadata, algorithms and crypto parameters
  // are authenticated. Ciphertext is authenticated by GCM itself.
  return JSON.stringify({ format: FORMAT, meta: validateMeta(record.meta, 'WRONG_PASSWORD_OR_CORRUPT'),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: VAULT_KDF_ITERATIONS, salt: base64(new Uint8Array(record.kdf.salt)) },
    cipher: { name: 'AES-GCM', tagLength: 128, iv: base64(new Uint8Array(record.cipher.iv)) } });
}
function recordStamp(record: VaultRecord): string {
  return `${authenticatedHeader(record)}:${base64(new Uint8Array(record.cipher.ciphertext).slice(-16))}`;
}
function cloneJson(value: unknown, budget: { nodes: number; characters: number }, depth = 0): VaultJson {
  if (++budget.nodes > 4096 || depth > 16) fail('LIMIT_EXCEEDED');
  budget.characters += typeof value === 'string' ? value.length + 2 : 8;
  if (budget.characters > VAULT_MAX_SETTINGS_BYTES) fail('LIMIT_EXCEEDED');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 4096) fail('LIMIT_EXCEEDED');
    return value.map(item => cloneJson(item, budget, depth + 1));
  }
  if (!plain(value)) fail('INVALID_INPUT');
  const result: Record<string, VaultJson> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('INVALID_INPUT');
    budget.characters += key.length + 3;
    if (budget.characters > VAULT_MAX_SETTINGS_BYTES) fail('LIMIT_EXCEEDED');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('INVALID_INPUT');
    result[key] = cloneJson(descriptor.value, budget, depth + 1);
  }
  return result;
}
function payloadSettings(data: Pick<VaultData, 'selectedNodeId' | 'restoreHeight' | 'settings'>): Record<string, VaultJson> {
  const result: Record<string, VaultJson> = Object.create(null);
  if (data.selectedNodeId !== undefined) {
    if (typeof data.selectedNodeId !== 'string' || data.selectedNodeId.length > 256 || /[\u0000-\u001f\u007f]/.test(data.selectedNodeId)) fail('INVALID_INPUT');
    result.selectedNodeId = data.selectedNodeId;
  }
  if (data.restoreHeight !== undefined) {
    if (!integer(data.restoreHeight, 0)) fail('INVALID_INPUT');
    result.restoreHeight = data.restoreHeight;
  }
  if (data.settings !== undefined) {
    if (!plain(data.settings)) fail('INVALID_INPUT');
    result.settings = cloneJson(data.settings, { nodes: 0, characters: 0 });
  }
  return result;
}
function encodeData(data: VaultData): Uint8Array {
  if (!plain(data) || !(data.keysData instanceof Uint8Array) || !(data.cacheData instanceof Uint8Array) || !data.keysData.byteLength) fail('INVALID_INPUT');
  const keysLength = data.keysData.byteLength, cacheLength = data.cacheData.byteLength;
  if (keysLength + cacheLength + HEADER_BYTES > VAULT_MAX_PLAINTEXT_BYTES) fail('LIMIT_EXCEEDED');
  const settings = encoder.encode(JSON.stringify(payloadSettings(data)));
  if (settings.byteLength > VAULT_MAX_SETTINGS_BYTES || HEADER_BYTES + keysLength + cacheLength + settings.byteLength > VAULT_MAX_PLAINTEXT_BYTES) {
    settings.fill(0); fail('LIMIT_EXCEEDED');
  }
  const bytes = new Uint8Array(HEADER_BYTES + keysLength + cacheLength + settings.length);
  try {
    bytes.set([0x4d, 0x57, 0x56, 0x31]);
    const header = new DataView(bytes.buffer);
    header.setUint32(4, keysLength, true); header.setUint32(8, cacheLength, true); header.setUint32(12, settings.length, true);
    bytes.set(data.keysData, HEADER_BYTES); bytes.set(data.cacheData, HEADER_BYTES + keysLength);
    bytes.set(settings, HEADER_BYTES + keysLength + cacheLength);
    return bytes;
  } catch (error) { bytes.fill(0); throw mapped(error, 'INVALID_INPUT'); }
  finally { settings.fill(0); }
}
function decodeData(bytes: Uint8Array): VaultData {
  let keysData: Uint8Array | undefined; let cacheData: Uint8Array | undefined;
  try {
    if (bytes.length < HEADER_BYTES || bytes.length > VAULT_MAX_PLAINTEXT_BYTES ||
        ![0x4d, 0x57, 0x56, 0x31].every((value, index) => bytes[index] === value)) fail('WRONG_PASSWORD_OR_CORRUPT');
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const keysLength = header.getUint32(4, true), cacheLength = header.getUint32(8, true), settingsLength = header.getUint32(12, true);
    if (!keysLength || settingsLength > VAULT_MAX_SETTINGS_BYTES || HEADER_BYTES + keysLength + cacheLength + settingsLength !== bytes.length) fail('WRONG_PASSWORD_OR_CORRUPT');
    const parsed: unknown = JSON.parse(decoder.decode(bytes.subarray(HEADER_BYTES + keysLength + cacheLength)));
    if (!plain(parsed) || Object.keys(parsed).some(key => !['selectedNodeId', 'restoreHeight', 'settings'].includes(key))) fail('WRONG_PASSWORD_OR_CORRUPT');
    const checked = payloadSettings(parsed as Pick<VaultData, 'selectedNodeId' | 'restoreHeight' | 'settings'>);
    keysData = bytes.slice(HEADER_BYTES, HEADER_BYTES + keysLength);
    cacheData = bytes.slice(HEADER_BYTES + keysLength, HEADER_BYTES + keysLength + cacheLength);
    return { keysData, cacheData, ...checked } as VaultData;
  } catch { keysData?.fill(0); cacheData?.fill(0); fail('WRONG_PASSWORD_OR_CORRUPT'); }
}
async function passwordKey(password: string, requireStrong: boolean): Promise<CryptoKey> {
  if (typeof password !== 'string' || password.length > 1024 || (requireStrong && password.trim().length < 8)) fail('INVALID_INPUT');
  const bytes = encoder.encode(password);
  try {
    if (bytes.length > 1024) fail('INVALID_INPUT');
    return await cryptoProvider().subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
  } catch (error) { throw mapped(error, 'CRYPTO_FAILED'); }
  finally { bytes.fill(0); }
}
function randomBytes(length: number, previous?: Uint8Array): Uint8Array {
  for (let i = 0; i < 8; i++) {
    const bytes = cryptoProvider().getRandomValues(new Uint8Array(length));
    if (!previous || bytes.some((byte, index) => byte !== previous[index])) return bytes;
  }
  fail('CRYPTO_FAILED');
}
async function aesKey(key: CryptoKey, salt: ArrayBuffer): Promise<CryptoKey> {
  return cryptoProvider().subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: VAULT_KDF_ITERATIONS, salt },
    key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encrypt(meta: VaultMeta, key: CryptoKey, bytes: Uint8Array, previous?: SessionState): Promise<VaultRecord> {
  try {
    const record: VaultRecord = { format: FORMAT, meta: { ...meta },
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: VAULT_KDF_ITERATIONS, salt: randomBytes(16, previous?.salt).buffer as ArrayBuffer },
      cipher: { name: 'AES-GCM', tagLength: 128, iv: randomBytes(12, previous?.iv).buffer as ArrayBuffer, ciphertext: new ArrayBuffer(0) } };
    const derived = await aesKey(key, record.kdf.salt);
    record.cipher.ciphertext = await cryptoProvider().subtle.encrypt({ name: 'AES-GCM', tagLength: 128,
      iv: record.cipher.iv, additionalData: encoder.encode(authenticatedHeader(record)) }, derived, bytes);
    return record;
  } catch (error) { throw mapped(error, 'CRYPTO_FAILED'); }
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest; let settled = false;
    const error = () => { if (!settled) { settled = true; reject(new VaultError('STORAGE_FAILED')); } };
    try {
      if (!globalThis.indexedDB) { error(); return; }
      request = globalThis.indexedDB.open(VAULT_DB_NAME, 1);
      request.onupgradeneeded = () => {
        try {
          const store = request.result.createObjectStore(VAULT_STORE_NAME, { keyPath: 'meta.id' });
          store.createIndex(NAME_INDEX, 'meta.name', { unique: true });
          store.createIndex(META_INDEX, ['meta.id', 'meta.name', 'meta.network', 'meta.createdAt', 'meta.updatedAt', 'meta.schemaVersion', 'meta.revision']);
        } catch { request.transaction?.abort(); error(); }
      };
      request.onsuccess = () => { if (settled) request.result.close(); else { settled = true; resolve(request.result); } };
      request.onerror = error;
      request.onblocked = error;
    } catch { error(); }
  });
}
async function transaction<T>(mode: IDBTransactionMode, execute: (store: IDBObjectStore, setResult: (value: T) => void, abort: (error: VaultError) => void) => void): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction; let result: T; let hasResult = false; let cause: VaultError | undefined;
    const abort = (error: VaultError) => { cause ??= error; try { tx.abort(); } catch { db.close(); reject(cause); } };
    try {
      tx = db.transaction(VAULT_STORE_NAME, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      tx.oncomplete = () => { db.close(); if (hasResult) resolve(result); else reject(new VaultError('STORAGE_FAILED')); };
      tx.onabort = () => { db.close(); reject(cause ?? new VaultError('STORAGE_FAILED')); };
      tx.onerror = () => { cause ??= new VaultError('STORAGE_FAILED'); };
      execute(tx.objectStore(VAULT_STORE_NAME), value => { result = value; hasResult = true; }, abort);
    } catch (error) {
      db.close();
      // A transaction may have started before a synchronous request failure.
      try { tx!.abort(); } catch { /* best-effort */ }
      reject(mapped(error, 'STORAGE_FAILED'));
    }
  });
}
async function readRecord(id: string): Promise<VaultRecord> {
  if (typeof id !== 'string' || !UUID.test(id)) fail('INVALID_INPUT');
  return transaction('readonly', (store, result, abort) => {
    const request = store.get(id);
    request.onsuccess = () => {
      try { if (!request.result) fail('NOT_FOUND'); result(validateRecord(request.result, 'WRONG_PASSWORD_OR_CORRUPT')); }
      catch (error) { abort(mapped(error, 'STORAGE_FAILED')); }
    };
  });
}
async function insert(record: VaultRecord): Promise<void> {
  return transaction('readwrite', (store, result, abort) => {
    const existing = store.getKey(record.meta.id);
    existing.onsuccess = () => {
      try {
        if (existing.result !== undefined) { abort(new VaultError('DUPLICATE_ID')); return; }
        const name = store.index(NAME_INDEX).getKey(record.meta.name);
        name.onsuccess = () => {
          try {
            if (name.result !== undefined) { abort(new VaultError('DUPLICATE_NAME')); return; }
            const request = store.add(record); request.onsuccess = () => result(undefined);
          } catch (error) { abort(mapped(error, 'STORAGE_FAILED')); }
        };
      } catch (error) { abort(mapped(error, 'STORAGE_FAILED')); }
    };
  });
}
function stateOf(session: VaultSession): SessionState {
  if (!session || typeof session !== 'object') fail('SESSION_CLOSED');
  const state = sessions.get(session);
  if (!state?.active) fail('SESSION_CLOSED');
  return state;
}
function newSession(record: VaultRecord, key: CryptoKey): VaultSession {
  const session = Object.freeze({ id: record.meta.id }) as VaultSession;
  sessions.set(session, { key, meta: { ...record.meta }, stamp: recordStamp(record),
    salt: new Uint8Array(record.kdf.salt).slice(), iv: new Uint8Array(record.cipher.iv).slice(), active: true });
  return session;
}
function nextMeta(state: SessionState): VaultMeta {
  if (state.meta.revision >= MAX_REVISION || state.meta.updatedAt === Number.MAX_SAFE_INTEGER) fail('LIMIT_EXCEEDED');
  return { ...state.meta, revision: state.meta.revision + 1, updatedAt: Math.max(Date.now(), state.meta.updatedAt + 1) };
}
async function compareAndSwap(record: VaultRecord, expected: string, state: SessionState): Promise<void> {
  return transaction('readwrite', (store, result, abort) => {
    const existing = store.get(record.meta.id);
    existing.onsuccess = () => {
      try {
        if (!state.active) fail('SESSION_CLOSED');
        if (!existing.result) fail('NOT_FOUND');
        const current = validateRecord(existing.result, 'WRONG_PASSWORD_OR_CORRUPT');
        if (current.meta.revision + 1 !== record.meta.revision || recordStamp(current) !== expected) fail('CONFLICT');
        const put = () => { const request = store.put(record); request.onsuccess = () => result(undefined); };
        if (current.meta.name === record.meta.name) { put(); return; }
        // Rename: the unique name index is checked inside the same transaction, so a
        // name taken by another wallet aborts with nothing written.
        const owner = store.index(NAME_INDEX).getKey(record.meta.name);
        owner.onsuccess = () => {
          try {
            if (owner.result !== undefined && owner.result !== record.meta.id) fail('DUPLICATE_NAME');
            put();
          } catch (error) { abort(mapped(error, 'STORAGE_FAILED')); }
        };
      } catch (error) { abort(mapped(error, 'STORAGE_FAILED')); }
    };
  });
}

/** Metadata only; the IndexedDB key cursor does not copy potentially huge ciphertexts. */
export async function listVaults(): Promise<VaultMeta[]> {
  return transaction('readonly', (store, result, abort) => {
    const metadata: VaultMeta[] = [];
    const request = store.index(META_INDEX).openKeyCursor();
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (!cursor) { result(metadata.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))); return; }
        if (!Array.isArray(cursor.key) || cursor.key.length !== 7) fail('WRONG_PASSWORD_OR_CORRUPT');
        const [id, name, network, createdAt, updatedAt, schemaVersion, revision] = cursor.key;
        metadata.push(publicMeta(validateMeta({ id, name, network, createdAt, updatedAt, schemaVersion, revision }, 'WRONG_PASSWORD_OR_CORRUPT')));
        cursor.continue();
      } catch (error) { abort(mapped(error, 'STORAGE_FAILED')); }
    };
  });
}
export async function createVault(options: CreateVaultOptions): Promise<{ meta: VaultMeta; session: VaultSession }> {
  if (!plain(options) || !validName(options.name) || !['mainnet', 'stagenet', 'testnet'].includes(options.network)) fail('INVALID_INPUT');
  const bytes = encodeData(options);
  try {
    const key = await passwordKey(options.password, true);
    const now = Date.now();
    const meta = validateMeta({ id: cryptoProvider().randomUUID(), name: options.name, network: options.network,
      createdAt: now, updatedAt: now, schemaVersion: 1, revision: 1 }, 'INVALID_INPUT');
    const record = await encrypt(meta, key, bytes);
    await insert(record);
    return { meta: publicMeta(meta), session: newSession(record, key) };
  } finally { bytes.fill(0); }
}
export async function unlockVault(id: string, password: string): Promise<{ meta: VaultMeta; data: VaultData; session: VaultSession }> {
  const record = await readRecord(id);
  const key = await passwordKey(password, false);
  let plaintext: Uint8Array | undefined;
  try {
    const derived = await aesKey(key, record.kdf.salt);
    const decrypted = await cryptoProvider().subtle.decrypt({ name: 'AES-GCM', tagLength: 128, iv: record.cipher.iv,
      additionalData: encoder.encode(authenticatedHeader(record)) }, derived, record.cipher.ciphertext);
    plaintext = new Uint8Array(decrypted);
    const data = decodeData(plaintext);
    return { meta: publicMeta(record.meta), data, session: newSession(record, key) };
  } catch (error) {
    if (error instanceof VaultError && error.code === 'CRYPTO_UNAVAILABLE') throw error;
    throw new VaultError('WRONG_PASSWORD_OR_CORRUPT');
  } finally { plaintext?.fill(0); }
}
/** Commit the session's wallet. `rename` changes the authenticated display name in the same revision. */
export async function saveVault(session: VaultSession, data: VaultData, rename?: string): Promise<VaultMeta> {
  const state = stateOf(session);
  if (rename !== undefined && !validName(rename)) fail('INVALID_INPUT');
  const expected = state.stamp;
  const meta = { ...nextMeta(state), ...(rename !== undefined ? { name: rename } : {}) };
  const bytes = encodeData(data);
  try {
    const record = await encrypt(meta, state.key, bytes, state);
    await compareAndSwap(record, expected, state);
    // Update this capability only after the IDB transaction has committed.
    state.meta = { ...meta }; state.stamp = recordStamp(record);
    state.salt = new Uint8Array(record.kdf.salt).slice(); state.iv = new Uint8Array(record.cipher.iv).slice();
    return publicMeta(meta);
  } finally { bytes.fill(0); }
}
export async function changeVaultPassword(session: VaultSession, newPassword: string, newData: VaultData): Promise<{ meta: VaultMeta; session: VaultSession }> {
  const state = stateOf(session);
  const expected = state.stamp;
  const meta = nextMeta(state);
  const bytes = encodeData(newData);
  try {
    const key = await passwordKey(newPassword, true);
    const record = await encrypt(meta, key, bytes, state);
    await compareAndSwap(record, expected, state);
    // A failed encryption/commit never invalidates the old working session.
    closeVaultSession(session);
    return { meta: publicMeta(meta), session: newSession(record, key) };
  } finally { bytes.fill(0); }
}
/** Revoke an in-memory capability. Await outstanding saves before locking where possible. */
export function closeVaultSession(session: VaultSession): void {
  if (!session || typeof session !== 'object') return;
  const state = sessions.get(session);
  if (state) { state.active = false; state.salt.fill(0); state.iv.fill(0); sessions.delete(session); }
}
/**
 * Check a password against the session's own stored, authenticated record. Nothing is
 * written or retained: a correct password decrypts the AES-GCM record (plaintext is
 * zeroed immediately); anything else is simply `false`.
 */
export async function verifyVaultPassword(session: VaultSession, password: string): Promise<boolean> {
  const state = stateOf(session);
  if (typeof password !== 'string' || !password || password.length > 1024) return false;
  const record = await readRecord(state.meta.id);
  if (!state.active) fail('SESSION_CLOSED');
  if (recordStamp(record) !== state.stamp) fail('CONFLICT');
  let plaintext: Uint8Array | undefined;
  try {
    const key = await passwordKey(password, false);
    const derived = await aesKey(key, record.kdf.salt);
    plaintext = new Uint8Array(await cryptoProvider().subtle.decrypt({ name: 'AES-GCM', tagLength: 128, iv: record.cipher.iv,
      additionalData: encoder.encode(authenticatedHeader(record)) }, derived, record.cipher.ciphertext));
    return true;
  } catch (error) {
    if (error instanceof VaultError && error.code === 'CRYPTO_UNAVAILABLE') throw error;
    return false;
  } finally { plaintext?.fill(0); }
}
/**
 * Permanently delete the session's wallet record in one IndexedDB transaction, only if it
 * is still exactly the record this session committed. The capability is revoked afterwards.
 */
export async function deleteVault(session: VaultSession): Promise<void> {
  const state = stateOf(session);
  const expected = state.stamp, id = state.meta.id;
  await transaction<void>('readwrite', (store, result, abort) => {
    const existing = store.get(id);
    existing.onsuccess = () => {
      try {
        if (!state.active) fail('SESSION_CLOSED');
        if (!existing.result) fail('NOT_FOUND');
        if (recordStamp(validateRecord(existing.result, 'WRONG_PASSWORD_OR_CORRUPT')) !== expected) fail('CONFLICT');
        const request = store.delete(id); request.onsuccess = () => result(undefined);
      } catch (error) { abort(mapped(error, 'STORAGE_FAILED')); }
    };
  });
  closeVaultSession(session);
}
/** Only encrypted bytes and public authenticated metadata are exported. */
export async function exportVault(id: string): Promise<string> {
  const record = await readRecord(id);
  return JSON.stringify({ format: FORMAT, meta: record.meta,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: VAULT_KDF_ITERATIONS, salt: base64(new Uint8Array(record.kdf.salt)) },
    cipher: { name: 'AES-GCM', tagLength: 128, iv: base64(new Uint8Array(record.cipher.iv)), ciphertext: base64(new Uint8Array(record.cipher.ciphertext)) } });
}
/**
 * Validate and atomically import an ENCRYPTED backup; never overwrite an ID/name.
 * This does NOT verify password, ciphertext integrity, or Monero wallet validity.
 * Those are checked later by unlockVault and the Monero engine respectively.
 */
export async function importVault(json: string): Promise<VaultMeta> {
  let record: VaultRecord;
  try {
    if (typeof json !== 'string' || json.length > VAULT_MAX_BACKUP_CHARS) fail('INVALID_BACKUP');
    const backup: unknown = JSON.parse(json);
    exact(backup, ['format', 'meta', 'kdf', 'cipher'], 'INVALID_BACKUP');
    if (backup.format !== FORMAT) fail('INVALID_BACKUP');
    const meta = validateMeta(backup.meta, 'INVALID_BACKUP');
    exact(backup.kdf, ['name', 'hash', 'iterations', 'salt'], 'INVALID_BACKUP');
    exact(backup.cipher, ['name', 'tagLength', 'iv', 'ciphertext'], 'INVALID_BACKUP');
    if (backup.kdf.name !== 'PBKDF2' || backup.kdf.hash !== 'SHA-256' || backup.kdf.iterations !== VAULT_KDF_ITERATIONS ||
        backup.cipher.name !== 'AES-GCM' || backup.cipher.tagLength !== 128) fail('INVALID_BACKUP');
    // Validate cheap crypto parameters before allocating large ciphertext buffers.
    const salt = unbase64(backup.kdf.salt, 16, 16), iv = unbase64(backup.cipher.iv, 12, 12);
    const ciphertext = unbase64(backup.cipher.ciphertext, HEADER_BYTES + 2 + 1 + 16, VAULT_MAX_PLAINTEXT_BYTES + 16);
    record = { format: FORMAT, meta,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: VAULT_KDF_ITERATIONS, salt },
      cipher: { name: 'AES-GCM', tagLength: 128, iv, ciphertext } };
  } catch { fail('INVALID_BACKUP'); }
  await insert(record);
  return publicMeta(record.meta);
}
