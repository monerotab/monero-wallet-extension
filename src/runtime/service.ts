import { z } from 'zod';
import { EngineClient } from './engine-client.ts';
import { RuntimeError, requireCondition } from './errors.ts';
import { NODES, getNode, checkNode, appendCustomNode, validCustomNode, CUSTOM_NODE_ID, MAX_CUSTOM_NODES } from './nodes.ts';
import { createVault, unlockVault, saveVault, changeVaultPassword, closeVaultSession, listVaults, exportVault, importVault,
  verifyVaultPassword, deleteVault, validVaultName, VaultError, type VaultSession, type VaultMeta, type VaultData, type VaultJson } from './vault.ts';
import { toAtomic } from '../lib/money.ts';
import type { Status, Snapshot, Draft, NodeSelection, NodePreset, SyncProgress, MessageVerification,
  AutoLockMinutes, WalletSettings, WalletKeys, IntegratedAddress } from '../lib/types';

const empty = z.object({}).strict();
const name = z.string().trim().min(1).max(64);
const password = z.string().min(8).max(256).refine(value => value.trim().length >= 8);
const network = z.enum(['mainnet', 'stagenet', 'testnet']);
const index = z.number().int().min(0).max(100_000);
const label = z.string().max(200);
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{95}(?:[1-9A-HJ-NP-Za-km-z]{11})?$/; // base58 only: never an OpenAlias/URL
// User-entered addresses: WalletService.validateAddress enforces ADDRESS, then the wallet network.
const address = z.string().trim().min(1).max(256);
const knownAddress = z.string().regex(ADDRESS);
const txid = z.string().regex(/^[a-f\d]{64}$/i);
const description = z.string().trim().max(200).default('');
// Re-entered passwords are verified against the encrypted vault record; empty means PASSWORD_REQUIRED.
const reenter = z.string().max(256);
const nodeParams = z.object({ nodeId: z.string().min(1).max(64), acknowledgePrivacy: z.literal(true) }).strict();
// Custom node URLs are validated and normalized to an origin by customNodeOrigin (INVALID_NODE_URL).
const customNodeAdd = z.object({ name: z.string().trim().min(1).max(40).refine(value => !/[\u0000-\u001f\u007f]/.test(value)), url: z.string().max(200) }).strict();
const schemas = {
  status: empty, snapshot: z.object({ accountIndex: index.default(0) }).strict(),
  'wallet.list': empty,
  'wallet.create': z.object({ filename: name, password, network, language: z.literal('English').default('English') }).strict(),
  'wallet.restore': z.object({ filename: name, password, network, seed: z.string().trim().min(40).max(2000), restoreHeight: z.number().int().min(0).max(999_999_999) }).strict(),
  'wallet.open': z.object({ vaultId: z.string().uuid(), password: z.string().min(1).max(256) }).strict(),
  'wallet.close': empty, 'wallet.save': empty, 'wallet.refresh': empty, 'wallet.seed': z.object({ password: reenter.optional() }).strict(),
  'wallet.password': z.object({ oldPassword: z.string().min(1).max(256), newPassword: password }).strict(),
  'wallet.rename': z.object({ name }).strict(),
  'wallet.settings': z.object({ autoLockMinutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30), z.literal(60)]).optional(),
    confirmWithPassword: z.boolean().optional(), password: reenter.optional() }).strict(),
  // A missing password is PASSWORD_REQUIRED (readable), not INVALID_PARAMS.
  'wallet.keys': z.object({ password: reenter.optional() }).strict(),
  'wallet.delete': z.object({ password: reenter.optional() }).strict(),
  'wallet.rescan': z.object({ restoreHeight: z.number().int().min(0).max(999_999_999).optional() }).strict(),
  // Integrated addresses are built on the primary address only; a missing payment ID is random (CSPRNG).
  'address.integrated': z.object({ paymentId: z.string().regex(/^[a-f\d]{16}$/i).refine(value => !/^0{16}$/.test(value)).optional() }).strict(),
  'wallet.export': empty, 'wallet.import': z.object({ content: z.string().max(180_000_000) }).strict(),
  'node.list': empty, 'node.check': nodeParams, 'node.select': nodeParams,
  'node.custom.add': customNodeAdd, 'node.custom.remove': z.object({ nodeId: z.string().regex(CUSTOM_NODE_ID) }).strict(),
  'account.create': z.object({ label }).strict(), 'account.label': z.object({ accountIndex: index, label }).strict(),
  'account.rename': z.object({ accountIndex: index, label }).strict(),
  'address.create': z.object({ accountIndex: index, label }).strict(),
  'address.label': z.object({ accountIndex: index, addressIndex: index, label }).strict(),
  'contact.add': z.object({ address, description }).strict(),
  // expectedAddress is the row the UI rendered; indices shift after deletions.
  'contact.edit': z.object({ index, expectedAddress: knownAddress, address, description }).strict(),
  'contact.delete': z.object({ index, expectedAddress: knownAddress }).strict(),
  // Messages are signed byte-for-byte: never trimmed. Malformed signatures verify as not good.
  'message.sign': z.object({ message: z.string().min(1).max(4000), accountIndex: index, addressIndex: index, mode: z.enum(['spend', 'view']) }).strict(),
  'message.verify': z.object({ message: z.string().max(4000), address, signature: z.string().trim().min(1).max(500) }).strict(),
  'tx.key': z.object({ txid }).strict(),
  'tx.note': z.object({ txid, note: z.string().max(2000) }).strict(),
  // subtractFee (send max): the recipient receives amount minus the fee, so amount is the total debit.
  'tx.prepare': z.object({ accountIndex: index, address,
    amount: z.string().max(32), priority: z.number().int().min(0).max(4).default(0), subtractFee: z.boolean().default(false) }).strict(),
  'tx.confirm': z.object({ draftId: z.string().uuid(), password: reenter.optional() }).strict(), 'tx.cancel': z.object({ draftId: z.string().uuid() }).strict(),
  'tx.resolve': z.object({ txHash: z.string().regex(/^[a-f\d]{64}$/i) }).strict(),
};
type Action = keyof typeof schemas;
const NETWORK_NUMBER = { mainnet: 0, testnet: 1, stagenet: 2 } as const;
const SYNC_FRESH_MS = 120_000;
/** A NEW wallet's recovery phrase may be shown without its password only this long, and only until it is locked. */
const FRESH_SEED_MS = 30 * 60_000;
const AUTO_LOCK_MINUTES: readonly AutoLockMinutes[] = [1, 5, 15, 30, 60];
const PRECHECK_ERRORS = new Set(['INVALID_ACCOUNT', 'INVALID_SUBADDRESS', 'STALE_CONTACT', 'DUPLICATE_CONTACT', 'CONTACTS_FULL']);
export interface TransferMarker { txHash: string; createdAt: number }
export interface ServiceOptions {
  engineFactory?: () => EngineClient;
  claimLock?: () => Promise<() => void>;
  setPendingTransfer(value: TransferMarker | null): Promise<void>;
  getPendingTransfer(): Promise<TransferMarker | null>;
}

export async function acquireWalletTabLock(): Promise<() => void> {
  requireCondition(navigator.locks, 'This browser does not support safe wallet tab locking.', 'UNSUPPORTED_BROWSER');
  return new Promise((resolve, reject) => {
    void navigator.locks.request('monero-wallet-engine-v2', { ifAvailable: true }, async lock => {
      if (!lock) { reject(new RuntimeError('This wallet is already open in another tab. Close the other wallet tab, then retry.', 'WALLET_IN_USE')); return; }
      await new Promise<void>(release => resolve(release));
    }).catch(() => reject(new RuntimeError('The browser could not lock the wallet session.', 'WALLET_IN_USE')));
  });
}

/** A single tab owns a single native WASM wallet. All mutations are serialized. */
export class WalletService {
  private options: ServiceOptions;
  private client?: EngineClient;
  private releaseLock?: () => void;
  private activeOperations = 0;
  private deferredLockRelease = false;
  private initializing?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private disposed = false;
  private session?: VaultSession;
  private meta?: VaultMeta;
  private walletId = '';
  private nodeId: string | null = null;
  private appliedAt: number | null = null;
  private restoreHeight = 0;
  private extraSettings: Record<string, VaultJson> = {};
  private snapshots = new Map<number, Snapshot>();
  private drafts = new Map<string, Draft>();
  private version = '';
  private height = 0;
  private syncing = false;
  private relaying = false;
  private syncTask?: Promise<void>;
  private syncCancelled = false;
  private syncProgress?: SyncProgress;
  private lastSyncAt = 0;
  private syncError?: string;
  private synced = false;
  private rescanning = false;
  /** Set only by wallet.create; cleared by every lock, close, delete, failure and password change. */
  private freshSeed: { vaultId: string; until: number } | null = null;
  constructor(options: ServiceOptions) { this.options = options; }

  private releaseWalletLock() {
    // Storage calls may outlive a worker failure. Retain the physical Web Lock
    // until that operation settles; otherwise another tab's marker can be erased.
    if (this.activeOperations) { this.deferredLockRelease = true; return; }
    this.releaseLock?.(); this.releaseLock = undefined; this.deferredLockRelease = false;
  }
  private async initialize() {
    requireCondition(this.client || this.activeOperations === 0, 'The previous wallet operation is shutting down. Retry when it has finished.', 'ENGINE_CLOSED');
    requireCondition(!this.disposed, 'The wallet tab was closed. Reload to continue.', 'ENGINE_CLOSED');
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const client = (this.options.engineFactory ?? (() => new EngineClient()))(); this.client = client;
      client.onFatal = () => { if (this.client !== client) return; this.forgetWallet(); this.client = undefined; this.initializing = undefined; this.releaseWalletLock(); };
      client.onProgress = (id, progress) => { if (id === this.walletId && this.syncing) { this.syncProgress = progress; this.height = progress.height; } };
      const result = await client.call<{ version: string }>('engine', 'extInit'); this.version = result.version;
    })().catch(error => {
      this.client?.dispose(); this.client = undefined; this.releaseWalletLock(); this.initializing = undefined;
      throw error;
    });
    return this.initializing;
  }
  private call<T = unknown>(method: string, args: unknown[] = [], timeoutMs?: number): Promise<T> {
    requireCondition(this.client, 'The wallet engine is not available.', 'ENGINE_CLOSED');
    return this.client.call<T>(this.walletId || 'engine', method, args, timeoutMs);
  }
  private requireWallet() { requireCondition(this.meta && this.session && this.walletId, 'Unlock a wallet first.', 'NO_WALLET'); }
  private selectedNodeInfo(): { nodeName?: string; nodeUrl?: string } {
    if (!this.nodeId) return {};
    try { const node = getNode(this.nodeId, this.customNodes()); return { nodeName: node.name, nodeUrl: node.url }; }
    catch { return {}; }
  }
  private forgetWallet() {
    if (this.session) closeVaultSession(this.session);
    this.session = undefined; this.meta = undefined; this.walletId = ''; this.nodeId = null; this.appliedAt = null;
    this.snapshots.clear(); this.drafts.clear(); this.height = 0; this.synced = false; this.lastSyncAt = 0;
    this.syncProgress = undefined; this.extraSettings = {}; this.restoreHeight = 0; this.freshSeed = null;
  }
  /** Per-wallet preferences stored encrypted in the vault settings; anything unexpected reads as the defaults. */
  private settings(): WalletSettings {
    const minutes = this.extraSettings.autoLockMinutes;
    return { autoLockMinutes: AUTO_LOCK_MINUTES.includes(minutes as AutoLockMinutes) ? minutes as AutoLockMinutes : 5,
      confirmWithPassword: this.extraSettings.confirmWithPassword === true };
  }
  /** Re-check the unlock password against this wallet's own encrypted record (PBKDF2 + AES-GCM). Nothing is kept or logged. */
  private async verifyPassword(value: unknown, missing: string, wrong = 'Incorrect password.') {
    requireCondition(typeof value === 'string' && value.length > 0, missing, 'PASSWORD_REQUIRED');
    requireCondition(await verifyVaultPassword(this.session!, value), wrong, 'WRONG_PASSWORD');
  }
  private status(): Status {
    return { engineReady: !!this.client, walletOpen: !!this.meta, network: this.meta?.network ?? 'unknown', height: this.height,
      synced: this.synced && !this.syncing && Date.now() - this.lastSyncAt <= SYNC_FRESH_MS,
      version: this.version, walletName: this.meta?.name, vaultId: this.meta?.id, nodeId: this.nodeId, ...this.selectedNodeInfo(),
      syncing: this.syncing, syncProgress: this.syncProgress, lastSyncAt: this.lastSyncAt || undefined, syncError: this.syncError,
      ...(this.meta ? { restoreHeight: this.restoreHeight, ...this.settings(), rescanning: this.rescanning } : {}) };
  }
  private nodes(): NodeSelection {
    return { nodes: [...NODES, ...(this.meta ? this.customNodes() : [])], selectedNodeId: this.nodeId, appliedAt: this.appliedAt };
  }
  /** The open wallet's own custom nodes, stored encrypted in its vault settings (never global storage). */
  private customNodes(): NodePreset[] {
    const stored = this.extraSettings.customNodes;
    if (!this.meta || !Array.isArray(stored)) return [];
    return (stored as unknown[]).filter((node): node is NodePreset => validCustomNode(node))
      .filter(node => node.network === this.meta!.network).slice(0, MAX_CUSTOM_NODES).map(node => ({ ...node }));
  }
  private async saveCustomNodes(nodes: NodePreset[]) {
    this.extraSettings = { ...this.extraSettings,
      customNodes: nodes.map(node => ({ id: node.id, name: node.name, url: node.url, network: node.network, kind: 'custom', source: '' })) };
    await this.persist(); // A failed commit locks the wallet (fatalStorage), like every vault write.
  }
  /** Exact-origin worker arguments: bundled ids resolve in the worker; custom nodes pass their validated origin. */
  private nodeArgs(nodeId: string): [string] | [string, string] {
    const node = getNode(nodeId, this.customNodes());
    return node.kind === 'custom' ? [node.id, node.url] : [node.id];
  }
  private async networkOperation<T>(operation: () => Promise<T>): Promise<T> {
    requireCondition(this.nodeId, 'Choose a public node in Settings first.', 'NO_NODE');
    await this.call('extNetwork', this.nodeArgs(this.nodeId));
    try { return await operation(); }
    finally { if (this.client) await this.call('extNetwork', [null]).catch(() => undefined); }
  }
  private async data(): Promise<VaultData> {
    const [keysData, cacheData] = await this.call<Uint8Array[]>('getData');
    requireCondition(keysData instanceof Uint8Array && cacheData instanceof Uint8Array, 'The engine could not export this wallet.', 'WASM_ERROR');
    return { keysData, cacheData, restoreHeight: this.restoreHeight, ...(this.nodeId ? { selectedNodeId: this.nodeId } : {}),
      settings: { ...this.extraSettings, appliedAt: this.appliedAt } };
  }
  private async persist() {
    this.requireWallet();
    const session = this.session!; let data: VaultData | undefined;
    try { data = await this.data(); this.meta = await saveVault(session, data); }
    catch (error) { this.fatalStorage(); throw error; }
    finally { data?.keysData.fill(0); data?.cacheData.fill(0); }
  }
  /** Validate for this wallet's network before any native address-book, verify or transfer call. */
  private async validateAddress(value: string) {
    const network = this.meta!.network;
    const invalid = () => new RuntimeError(`This address is not valid for this ${network} wallet.`, 'INVALID_ADDRESS');
    if (!ADDRESS.test(value)) throw invalid(); // Never hand OpenAlias names or URLs to native code.
    try { await this.call('moneroUtilsValidateAddress', [value, NETWORK_NUMBER[network]]); }
    catch (error) {
      if ((error as { code?: unknown }).code !== 'WASM_ERROR') throw error; // Never mask a dead engine.
      throw invalid();
    }
  }
  /** Run a native wallet mutation, then commit it to the encrypted vault like account.create. */
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    let result: T;
    try { result = await operation(); }
    catch (error) {
      // Hooks reject PRECHECK_ERRORS before touching native state. Any other failure may
      // leave an unknown, unsaved native change: lock without saving, like a failed commit.
      if (!PRECHECK_ERRORS.has(String((error as { code?: unknown }).code))) this.fatalStorage();
      throw error;
    }
    await this.persist(); this.snapshots.clear(); return result;
  }
  private fatalStorage() {
    this.client?.dispose(); this.client = undefined; this.initializing = undefined;
    this.forgetWallet(); this.releaseWalletLock();
  }
  private async snapshot(accountIndex: number) {
    this.requireWallet();
    if (this.syncing) {
      const cached = this.snapshots.get(accountIndex);
      requireCondition(cached, 'Wait for synchronization before switching accounts.', 'SYNC_BUSY');
      return { ...cached, synced: false };
    }
    const result = await this.call<Snapshot>('extSnapshot', [accountIndex]);
    this.height = result.height; result.synced = this.status().synced;
    this.snapshots.set(accountIndex, result);
    return result;
  }
  private async closeWallet(save = true) {
    if (!this.meta) return {};
    if (save) await this.persist();
    // Destroying the worker releases its native keys, passwords and signed draft metadata.
    this.client?.dispose(); this.client = undefined; this.initializing = undefined;
    this.forgetWallet(); this.syncError = undefined; this.releaseWalletLock();
    return {};
  }
  /** Background sync; with `rescan`, first clears the scanned chain and rescans from its height (wallet.rescan). */
  private async startSync(rescan?: { from: number; tip: number }) {
    this.requireWallet(); requireCondition(this.nodeId, 'Choose a public node in Settings first.', 'NO_NODE');
    if (this.syncing) return {};
    await this.call('extInvalidateDrafts'); this.drafts.clear();
    this.syncing = true; this.rescanning = !!rescan;
    this.synced = false; this.syncCancelled = false; this.syncError = undefined; this.syncProgress = undefined;
    this.syncTask = (async () => {
      try {
        await this.networkOperation(async () => {
          await this.call('extConfigureNode', this.nodeArgs(this.nodeId!));
          // No full-scan timeout; each network request remains bounded. wallet.close aborts both.
          if (rescan) await this.call('extRescan', [rescan.from, rescan.tip], 0);
          else await this.call('sync', [undefined, false], 0);
          this.height = await this.call<number>('getHeight');
          const tip = await this.call<number>('getDaemonHeight');
          this.synced = await this.call<boolean>('isSynced') && await this.call<boolean>('isDaemonSynced') && this.height >= tip;
          if (this.synced) this.lastSyncAt = Date.now();
        });
      } catch (error) {
        this.synced = false;
        const code = (error as { code?: unknown } | null)?.code;
        this.syncError = this.syncCancelled ? 'Synchronization stopped. The last completed cache checkpoint is saved.' :
          rescan && (code === 'NODE_NOT_SYNCED' || code === 'PENDING_OUTGOING') ? (error as Error).message :
          'Synchronization did not finish. Check the selected node and try Sync again; no payment was sent.';
      } finally {
        if (this.meta && this.client) {
          try {
            this.height = await this.call<number>('getHeight');
            if (rescan) this.restoreHeight = await this.call<number>('getRestoreHeight');
            await this.persist();
          }
          catch { this.syncError = 'The wallet cache could not be saved. Unlock the last saved wallet again; keep your recovery phrase safe.'; }
        }
        this.syncing = false; this.rescanning = false;
        this.snapshots.clear();
      }
    })();
    return {};
  }

  async request(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    requireCondition(Object.hasOwn(schemas, action), 'This wallet operation is not allowed.', 'INVALID_ACTION');
    const parsed = schemas[action as Action].safeParse(params);
    requireCondition(parsed.success, 'Wallet request parameters are invalid.', 'INVALID_PARAMS');
    requireCondition(action !== 'tx.resolve' || !this.relaying, 'Wait for the active broadcast to finish before resolving its outcome.', 'RELAY_IN_PROGRESS');
    await this.initialize();
    if (action === 'status') return this.status();
    if (action === 'wallet.list') return { wallets: await listVaults() };
    if (action === 'node.list') return this.nodes();
    if (this.syncing) {
      if (action === 'snapshot') return this.snapshot((parsed.data as { accountIndex: number }).accountIndex);
      if (action === 'wallet.refresh') return {};
      if (action === 'wallet.close') {
        this.syncCancelled = true;
        await this.call('extAbortNetwork', [], 0);
        await this.syncTask;
      } else throw new RuntimeError('Synchronization is running. Wait, or lock the wallet to stop it.', 'SYNC_BUSY');
    }
    requireCondition(this.queued < 32, 'Too many wallet requests are queued.', 'QUEUE_FULL');
    this.queued++;
    const startedAt = Date.now();
    const task = this.tail.then(async () => {
      requireCondition(!this.disposed, 'The wallet tab was closed.', 'ENGINE_CLOSED');
      requireCondition(Date.now() - startedAt < 30_000, 'The wallet request waited too long and was not started.', 'QUEUE_TIMEOUT');
      requireCondition(!this.syncing, 'Synchronization is running. Wait for it to finish.', 'SYNC_BUSY');
      // Keep ownership across asynchronous storage even if the worker dies.
      this.activeOperations++;
      try { return await this.execute(action as Action, parsed.data as Record<string, never>); }
      finally {
        this.activeOperations--;
        if (this.deferredLockRelease) this.releaseWalletLock();
      }
    });
    this.tail = task.catch(() => undefined).finally(() => { this.queued--; });
    return task;
  }

  private async execute(action: Action, p: Record<string, never>): Promise<unknown> {
    if (action === 'snapshot') return this.snapshot(p.accountIndex);
    if (action === 'wallet.import') return importVault(p.content);
    if (action === 'tx.resolve') {
      requireCondition(!this.relaying, 'Wait for the active broadcast to finish.', 'RELAY_IN_PROGRESS');
      // A locked tab must claim the same lock used by every sending wallet. It
      // cannot erase a marker underneath another tab's active/unlocked engine.
      const release = this.meta && this.releaseLock ? undefined : await (this.options.claimLock ?? acquireWalletTabLock)();
      try {
        const pending = await this.options.getPendingTransfer();
        requireCondition(!this.disposed, 'The wallet tab was closed before recovery confirmation.', 'REQUEST_ABORTED');
        requireCondition(pending?.txHash === p.txHash, 'The recovery record changed. Reopen the warning and verify the displayed transaction ID.', 'STALE_TRANSFER_MARKER');
        await this.options.setPendingTransfer(null);
        return {};
      } finally { release?.(); }
    }
    // Custom ids resolve only against the OPEN wallet's own saved nodes.
    if (action === 'node.check') {
      if (CUSTOM_NODE_ID.test(p.nodeId)) this.requireWallet();
      return checkNode(p.nodeId, this.customNodes());
    }
    if (action === 'wallet.create' || action === 'wallet.restore' || action === 'wallet.open') {
      requireCondition(!this.meta, 'Lock the current wallet before opening another.', 'WALLET_ALREADY_OPEN');
      // Locked tabs may render/list vaults; the exclusive lock covers unlocked keys.
      this.releaseLock = await (this.options.claimLock ?? acquireWalletTabLock)();
      this.walletId = crypto.randomUUID(); this.syncError = undefined;
      try {
        if (action === 'wallet.open') {
          const opened = await unlockVault(p.vaultId, p.password);
          this.session = opened.session; this.meta = opened.meta;
          try { await this.call('openWalletData', ['', p.password, NETWORK_NUMBER[opened.meta.network], opened.data.keysData, opened.data.cacheData, undefined]); }
          finally { opened.data.keysData.fill(0); opened.data.cacheData.fill(0); }
          const actualNetwork = await this.call<number>('getNetworkType');
          requireCondition(actualNetwork === NETWORK_NUMBER[opened.meta.network], 'The native wallet network differs from its encrypted metadata.', 'INVALID_BACKUP');
          this.restoreHeight = await this.call<number>('getRestoreHeight');
          this.extraSettings = opened.data.settings ?? {};
          // A custom selection whose saved node is missing is dropped, never guessed or fatal.
          if (opened.data.selectedNodeId && (!CUSTOM_NODE_ID.test(opened.data.selectedNodeId) ||
            this.customNodes().some(node => node.id === opened.data.selectedNodeId))) {
            const node = getNode(opened.data.selectedNodeId, this.customNodes());
            requireCondition(node.network === opened.meta.network, 'Stored node network does not match the wallet.', 'INVALID_BACKUP');
            this.nodeId = node.id;
            this.appliedAt = typeof this.extraSettings.appliedAt === 'number' ? this.extraSettings.appliedAt : null;
          }
        } else {
          const config = { networkType: NETWORK_NUMBER[p.network as keyof typeof NETWORK_NUMBER], password: p.password, isTrustedDaemon: false,
            ...(action === 'wallet.restore' ? { seed: p.seed, restoreHeight: p.restoreHeight } : { language: 'English' }) };
          await this.call('createWalletFull', [config]);
          this.restoreHeight = await this.call<number>('getRestoreHeight');
          const data = await this.data();
          try {
            const created = await createVault({ ...data, name: p.filename, network: p.network, password: p.password });
            this.meta = created.meta; this.session = created.session;
            if (action === 'wallet.create') this.freshSeed = { vaultId: created.meta.id, until: Date.now() + FRESH_SEED_MS };
          } finally { data.keysData.fill(0); data.cacheData.fill(0); }
        }
        await this.call('addListener', ['extension']);
        this.height = await this.call<number>('getHeight'); this.synced = false; this.lastSyncAt = 0;
        await this.snapshot(0);
        return {};
      } catch (error) { this.fatalStorage(); throw error; }
    }
    if (action === 'wallet.close') return this.closeWallet();
    this.requireWallet();
    if (action === 'wallet.seed') {
      // A supplied password is always verified. Without one, only a wallet created by wallet.create in
      // this service session under 30 minutes ago, and never locked since, shows its phrase (backup step).
      const fresh = !!this.freshSeed && this.freshSeed.vaultId === this.meta!.id && Date.now() < this.freshSeed.until;
      if (p.password || !fresh) await this.verifyPassword(p.password, 'Enter your wallet password to view the recovery phrase.');
      return { seed: await this.call<string>('getSeed') };
    }
    if (action === 'wallet.keys') {
      await this.verifyPassword(p.password, 'Enter your wallet password to view the wallet keys.');
      // The worker hook never returns the private spend key.
      const keys = await this.call<WalletKeys>('extKeys');
      return { primaryAddress: keys.primaryAddress, publicViewKey: keys.publicViewKey, privateViewKey: keys.privateViewKey,
        publicSpendKey: keys.publicSpendKey } satisfies WalletKeys;
    }
    if (action === 'wallet.settings') {
      const current = this.settings();
      // Turning payment confirmation OFF needs the password; a supplied password is always verified.
      if (p.password || (current.confirmWithPassword && p.confirmWithPassword === false))
        await this.verifyPassword(p.password, 'Enter your wallet password to turn off password confirmation for payments.');
      const next: WalletSettings = { autoLockMinutes: p.autoLockMinutes ?? current.autoLockMinutes,
        confirmWithPassword: p.confirmWithPassword ?? current.confirmWithPassword };
      this.extraSettings = { ...this.extraSettings, ...next };
      await this.persist();
      return next;
    }
    if (action === 'wallet.rename') {
      const nextName = p.name as string;
      requireCondition(validVaultName(nextName), 'Wallet names cannot contain slashes or control characters, or be "." or "..".', 'INVALID_NAME');
      if (nextName === this.meta!.name) return {};
      const session = this.session!; let data: VaultData | undefined;
      try { data = await this.data(); this.meta = await saveVault(session, data, nextName); }
      catch (error) {
        // The unique-name check runs inside the aborted IDB transaction: nothing was written, so the wallet stays open.
        if (error instanceof VaultError && error.code === 'DUPLICATE_NAME') throw new RuntimeError('A wallet with this name already exists.', 'DUPLICATE_NAME');
        this.fatalStorage(); throw error;
      } finally { data?.keysData.fill(0); data?.cacheData.fill(0); }
      return {};
    }
    if (action === 'wallet.delete') {
      // request() already refuses delete during sync; relays hold this same queue. Kept explicit.
      requireCondition(!this.syncing && !this.relaying, 'Wait for synchronization or the active payment to finish before deleting this wallet.', 'SYNC_BUSY');
      requireCondition(!await this.options.getPendingTransfer(), 'Resolve the pending transfer before deleting this wallet.', 'PENDING_TRANSFER');
      await this.verifyPassword(p.password, 'Enter your wallet password to delete this wallet.');
      const session = this.session!;
      // Destroy the worker WITHOUT saving (its keys and unsaved cache die with it), then delete the record.
      this.client?.dispose(); this.client = undefined; this.initializing = undefined;
      try { await deleteVault(session); }
      finally { this.forgetWallet(); this.syncError = undefined; this.releaseWalletLock(); }
      return {};
    }
    if (action === 'wallet.rescan') {
      requireCondition(this.nodeId, 'Choose a public node in Settings first.', 'NO_NODE');
      requireCondition(!await this.options.getPendingTransfer(), 'Resolve the pending transfer before rescanning this wallet.', 'PENDING_TRANSFER');
      await this.call('extRescanCheck'); // PENDING_OUTGOING: a rescan would drop unconfirmed payments; local query
      // Reviews end here, even if the height check fails: configuring the node below discards worker drafts.
      await this.call('extInvalidateDrafts'); this.drafts.clear();
      const from = (p.restoreHeight as number | undefined) ?? this.restoreHeight;
      const tip = await this.networkOperation(async () => {
        await this.call('extConfigureNode', this.nodeArgs(this.nodeId!));
        try { return await this.call<number>('getDaemonHeight'); }
        catch (error) {
          if ((error as { code?: unknown }).code !== 'WASM_ERROR') throw error; // Never mask a dead engine.
          throw new RuntimeError('The node did not report its current height. No rescan was started.', 'NODE_UNREACHABLE');
        }
      });
      requireCondition(Number.isSafeInteger(tip) && from <= tip, `Restore height ${from} is above the node's current height ${tip}. Choose a lower height.`, 'RESTORE_HEIGHT_TOO_HIGH');
      return this.startSync({ from, tip });
    }
    if (action === 'address.integrated') {
      // Local only: no node, network permission or saved state change.
      const paymentId = p.paymentId === undefined ? null : (p.paymentId as string).toLowerCase();
      const result = await this.call<IntegratedAddress>('extIntegrated', [paymentId]);
      return { integratedAddress: result.integratedAddress, paymentId: result.paymentId } satisfies IntegratedAddress;
    }
    if (action === 'wallet.refresh') return this.startSync();
    if (action === 'wallet.save') { await this.persist(); return {}; }
    if (action === 'wallet.export') {
      await this.persist();
      return { filename: `${this.meta!.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}.monero-vault.json`, content: await exportVault(this.meta!.id) };
    }
    if (action === 'wallet.password') {
      this.freshSeed = null;
      const oldSession = this.session!;
      // Treat even an uncertain native change/export failure as fatal: otherwise a
      // later save could put new-password native keys under the old AES password.
      // Only a WRONG current password (checked first, nothing changed) keeps the wallet open.
      let data: VaultData | undefined;
      try {
        await this.verifyPassword(p.oldPassword, 'Enter your current wallet password.');
        await this.call('changePassword', [p.oldPassword, p.newPassword]);
        data = await this.data();
        const changed = await changeVaultPassword(oldSession, p.newPassword, data);
        this.meta = changed.meta; this.session = changed.session;
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'WRONG_PASSWORD') this.fatalStorage();
        throw error;
      } finally { data?.keysData.fill(0); data?.cacheData.fill(0); }
      return {};
    }
    if (action === 'node.custom.add') {
      // Adding never contacts the node; node.check / node.select do, after explicit consent.
      await this.saveCustomNodes(appendCustomNode(this.customNodes(), p.name, p.url, this.meta!.network));
      return this.nodes();
    }
    if (action === 'node.custom.remove') {
      const custom = this.customNodes();
      requireCondition(custom.some(node => node.id === p.nodeId), 'This custom node no longer exists. Refresh the node list.', 'INVALID_NODE');
      if (this.nodeId === p.nodeId) {
        // Network stays disabled until another node is explicitly selected.
        this.nodeId = null; this.appliedAt = null; this.synced = false; this.lastSyncAt = 0; this.drafts.clear();
        await this.call('extInvalidateDrafts');
      }
      await this.saveCustomNodes(custom.filter(node => node.id !== p.nodeId));
      return this.nodes();
    }
    if (action === 'node.select') {
      const custom = this.customNodes(); const node = getNode(p.nodeId, custom);
      requireCondition(node.network === this.meta!.network, 'The node must match this wallet network.', 'NODE_NETWORK_MISMATCH');
      const check = await checkNode(node.id, custom);
      requireCondition(check.reachable, node.kind === 'custom' && check.error ? `${check.error} No node was applied.` : 'The node check failed. No node was applied.', 'NODE_UNREACHABLE');
      requireCondition(check.network === this.meta!.network, 'The node reported a different or unknown network.', 'NODE_NETWORK_MISMATCH');
      const previous = this.nodeId;
      this.nodeId = node.id; this.appliedAt = null; this.synced = false; this.lastSyncAt = 0; this.drafts.clear();
      try { await this.networkOperation(() => this.call('extConfigureNode', this.nodeArgs(node.id))); this.appliedAt = Date.now(); await this.persist(); }
      catch (error) { this.nodeId = previous; this.appliedAt = null; this.fatalStorage(); throw error; }
      return { ...this.nodes(), check };
    }
    if (action === 'account.create') {
      const result = await this.call<{ index: number; primaryAddress: string }>('createAccount', [p.label]);
      await this.persist(); this.snapshots.clear(); return { index: result.index, address: result.primaryAddress };
    }
    if (action === 'address.create') {
      const result = await this.call<{ index: number; address: string }>('createSubaddress', [p.accountIndex, p.label]);
      await this.persist(); this.snapshots.clear(); return { index: result.index, address: result.address };
    }
    if (action === 'account.label' || action === 'account.rename') { await this.mutate(() => this.call('extAddressLabel', [p.accountIndex, 0, p.label])); return {}; }
    if (action === 'address.label') { await this.mutate(() => this.call('extAddressLabel', [p.accountIndex, p.addressIndex, p.label])); return {}; }
    if (action === 'contact.add') {
      await this.validateAddress(p.address);
      const result = await this.mutate(() => this.call<{ index: number }>('extContactAdd', [p.address, p.description]));
      return { index: result.index };
    }
    if (action === 'contact.edit') {
      await this.validateAddress(p.address);
      const result = await this.mutate(() => this.call<{ index: number }>('extContactEdit', [p.index, p.expectedAddress, p.address, p.description]));
      return { index: result.index };
    }
    if (action === 'contact.delete') { await this.mutate(() => this.call('extContactDelete', [p.index, p.expectedAddress])); return {}; }
    // Local-only cryptography: no node, network permission or saved state change.
    if (action === 'message.sign') {
      const result = await this.call<{ signature: string; address: string }>('extSign', [p.message, p.accountIndex, p.addressIndex, p.mode]);
      return { signature: result.signature, address: result.address };
    }
    if (action === 'message.verify') {
      await this.validateAddress(p.address);
      const result = await this.call<MessageVerification>('extVerify', [p.message, p.address, p.signature]);
      const good = result?.good === true;
      return { good, old: good && result.old === true,
        signatureType: good && (result.signatureType === 'spend' || result.signatureType === 'view') ? result.signatureType : null,
        version: good && Number.isSafeInteger(result.version) ? result.version : null } satisfies MessageVerification;
    }
    if (action === 'tx.key') { const result = await this.call<{ key: string }>('extTxKey', [p.txid]); return { key: result.key }; }
    if (action === 'tx.note') { await this.call('setTxNotes', [[p.txid], [p.note]]); await this.persist(); this.snapshots.clear(); return {}; }
    if (action === 'tx.cancel') { this.drafts.delete(p.draftId); await this.call('extCancel', [p.draftId]); return {}; }
    if (action === 'tx.prepare') {
      requireCondition(!await this.options.getPendingTransfer(), 'Resolve the previous transfer outcome before preparing another.', 'PENDING_TRANSFER');
      requireCondition(this.status().synced, 'Synchronize the wallet now before preparing a transfer.', 'NOT_SYNCED');
      const amount = toAtomic(p.amount);
      requireCondition(amount > 0n, 'The transfer amount must be positive.');
      await this.validateAddress(p.address);
      const draft = await this.networkOperation(() => this.call<Draft>('extPrepare', [{ ...p, amount: amount.toString() }], 300_000));
      await this.persist(); this.drafts.set(draft.draftId, draft); return draft;
    }
    if (action === 'tx.confirm') {
      const draft = this.drafts.get(p.draftId); this.drafts.delete(p.draftId);
      this.relaying = true;
      try {
        requireCondition(draft && draft.expiresAt > Date.now(), 'The transaction review expired or was already consumed.', 'DRAFT_NOT_FOUND');
        // Per-wallet payment confirmation: verified BEFORE the recovery marker or any relay. The draft stays consumed.
        if (p.password || this.settings().confirmWithPassword)
          await this.verifyPassword(p.password, 'Enter your wallet password to confirm this payment. Nothing was sent; review the payment again.',
            'Incorrect password. Nothing was sent; review the payment again.');
        requireCondition(this.status().synced, 'Synchronize again before confirming this transfer.', 'NOT_SYNCED');
        const pending = await this.options.getPendingTransfer();
        requireCondition(!pending || pending.txHash === draft.txHash, 'A different transfer outcome is unresolved.', 'PENDING_TRANSFER');
        await this.options.setPendingTransfer({ txHash: draft.txHash, createdAt: Date.now() });
        this.drafts.clear();
        const result = await this.networkOperation(() => this.call<{ txHash: string }>('extConfirm', [p.draftId], 120_000));
        await this.persist();
        const marker = await this.options.getPendingTransfer();
        requireCondition(marker?.txHash === draft.txHash, 'The recovery record changed. Verify transaction history before sending again.', 'STALE_TRANSFER_MARKER');
        await this.options.setPendingTransfer(null);
        this.synced = false; this.snapshots.clear();
        return result;
      } finally {
        this.relaying = false;
        if (this.client) await this.call('extCancel', [p.draftId]).catch(() => undefined);
      }
    }
    throw new RuntimeError('Unsupported wallet operation.', 'INVALID_ACTION');
  }
  dispose() {
    this.disposed = true; this.client?.dispose(); this.client = undefined; this.forgetWallet();
    this.releaseWalletLock();
  }
}
