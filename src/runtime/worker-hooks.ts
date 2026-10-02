import type MoneroWalletFull from 'monero-ts/dist/src/main/ts/wallet/MoneroWalletFull';
import type MoneroTxWallet from 'monero-ts/dist/src/main/ts/wallet/model/MoneroTxWallet';
import type { Snapshot, Transaction, Draft, Contact, MessageVerification } from '../lib/types';
import { boundedFetch, resolveNodeTarget, engineRequestUrl } from './nodes';
import { requireCondition, RuntimeError } from './errors';

// Appended to the pinned, locally bundled monero-ts worker. No runtime code generation.
interface VendorWorker {
  WORKER_OBJECTS: Record<string, MoneroWalletFull>;
  HttpClient: { request: (request: NetworkRequest) => Promise<unknown> };
  LibraryUtils: { loadWasmModule(): Promise<unknown>; setLogLevel(level: number): Promise<void> };
  [key: string]: unknown;
}
interface NetworkRequest { uri: string; method?: string; body?: string | Uint8Array | object; username?: string; password?: string; proxyUri?: string; headers?: object; rejectUnauthorized?: boolean }
interface PrepareParams { accountIndex: number; address: string; amount: string; priority: number; subtractFee?: boolean }
const vendor = globalThis as unknown as VendorWorker;
const MAX_CONTACTS = 500;
let permittedNode: string | null = null;
let networkAbort = new AbortController();
let generation = 0;
type HeldDraft = Draft & { metadata: string; generation: number; walletId: string; primary: string; accountIndex: number; height: number };
const drafts = new Map<string, HeldDraft>();
const wallet = (id: string): MoneroWalletFull => {
  const value = vendor.WORKER_OBJECTS?.[id];
  requireCondition(value, 'Unlock a wallet first.', 'NO_WALLET');
  return value;
};
const amountString = (amount: bigint | undefined) => (amount ?? 0n).toString();
const clearDrafts = () => { generation++; drafts.clear(); };

// The worker cannot read the encrypted vault. The service passes a custom node's origin
// together with its id; resolveNodeTarget re-validates it and it becomes the ONLY admitted custom origin.
let permittedCustom: string | null = null;
vendor.HttpClient.request = async request => {
  requireCondition(permittedNode, 'Network access is disabled until you explicitly choose a node and synchronize.', 'NETWORK_DISABLED');
  const target = engineRequestUrl(request.uri);
  const allowed = new URL(resolveNodeTarget(permittedNode, permittedCustom).url).origin;
  requireCondition(target.origin === allowed && !target.search && !target.hash,
    'The wallet attempted to contact a different node.', 'INVALID_NODE');
  requireCondition(!request.username && !request.password && !request.proxyUri && !request.headers && request.rejectUnauthorized !== false,
    'Daemon credentials and insecure TLS overrides are not allowed.', 'INVALID_NODE');
  requireCondition(['GET', 'POST'].includes(request.method ?? 'GET'), 'Unsupported daemon request.', 'NODE_PROTOCOL');
  const binary = request.body instanceof Uint8Array;
  let body: string | Uint8Array | undefined;
  if (binary || typeof request.body === 'string') body = request.body as string | Uint8Array;
  else if (request.body !== undefined) body = JSON.stringify(request.body);
  const { response, bytes } = await boundedFetch(target, { method: request.method ?? 'GET', body: body as BodyInit | undefined,
    signal: networkAbort.signal, headers: body === undefined ? undefined : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } },
  undefined, undefined, permittedCustom ? [allowed] : []);
  return { statusCode: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers),
    body: binary ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
};

vendor.extInit = async () => {
  requireCondition(typeof globalThis.crypto?.getRandomValues === 'function' && typeof globalThis.crypto?.randomUUID === 'function', 'A secure browser random source is required.', 'UNSUPPORTED_BROWSER');
  await vendor.LibraryUtils.loadWasmModule();
  await vendor.LibraryUtils.setLogLevel(0);
  return { version: 'monero-ts 0.11.15 · WebAssembly' };
};
vendor.extNetwork = async (_id: string, nodeId: string | null, customUrl?: string | null) => {
  const target = nodeId === null ? null : resolveNodeTarget(nodeId, customUrl);
  networkAbort.abort(); networkAbort = new AbortController();
  permittedNode = nodeId; permittedCustom = target?.custom ? target.url : null;
};
vendor.extAbortNetwork = async () => { networkAbort.abort(); permittedNode = null; permittedCustom = null; };
vendor.extInvalidateDrafts = async () => { clearDrafts(); };
vendor.extConfigureNode = async (id: string, nodeId: string, customUrl?: string | null) => {
  clearDrafts();
  const node = resolveNodeTarget(nodeId, customUrl);
  // Explicit untrusted mode: wallet2 would otherwise auto-trust local addresses like 127.0.0.1.
  await wallet(id).setDaemonConnection({ uri: node.url, rejectUnauthorized: true }, false);
  requireCondition(await wallet(id).isDaemonTrusted() === false, 'The engine did not apply untrusted node mode.', 'UNSAFE_NODE');
};

// Never-mined rows (pending, pool and failed; height 0) first, then newest block, then
// newest timestamp; txid keeps the order total and stable between polls.
const unconfirmed = (tx: Transaction) => tx.type === 'pending' || tx.type === 'pool' || tx.type === 'failed';
const byRecency = (a: Transaction, b: Transaction) => Number(unconfirmed(b)) - Number(unconfirmed(a)) || b.height - a.height ||
  b.timestamp - a.timestamp || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0);
const contactsOf = async (current: MoneroWalletFull): Promise<Contact[]> => (await current.getAddressBookEntries()).map(entry =>
  ({ index: Number(entry.getIndex()), address: entry.getAddress() ?? '', description: entry.getDescription() ?? '' }));

vendor.extSnapshot = async (id: string, accountIndex: number): Promise<Snapshot> => {
  const current = wallet(id);
  const accounts = await current.getAccounts(false);
  requireCondition(accounts.some(account => account.getIndex() === accountIndex), 'This account does not exist.', 'INVALID_ACCOUNT');
  // wallet2 stores account labels on primary subaddress zero; some SDK account
  // responses omit the root label. Read that native label rather than losing it.
  const accountRows = [];
  for (const account of accounts) {
    const primary = (await current.getSubaddresses(account.getIndex(), [0]))[0];
    accountRows.push({ index: account.getIndex(), label: account.getLabel() || primary?.getLabel() || '', balance: amountString(account.getBalance()),
      unlockedBalance: amountString(account.getUnlockedBalance()), baseAddress: account.getPrimaryAddress() });
  }
  const addresses = await current.getSubaddresses(accountIndex);
  const balance = await current.getBalance(accountIndex);
  const unlocked = await current.getUnlockedBalance(accountIndex);
  const height = await current.getHeight();
  let transactions: Transaction[] = [];
  let historyError: string | undefined;
  try {
    // An unrestricted getTxs() refreshes the incoming mempool over daemon RPC,
    // even when the caller only wants cached history. These two native queries
    // are local: confirmed transactions plus every cached outgoing transfer,
    // including pending/failed payments. Incoming pool-only payments are omitted.
    const confirmed = await current.getTxs({ includeOutputs: false, isConfirmed: true });
    // SDK runtime documents/normalizes the isOutgoing JSON alias, but its
    // Partial<MoneroTransferQuery> declaration omits that accepted input property.
    const outgoingTransfers = await current.getTransfers({ isOutgoing: true } as Parameters<typeof current.getTransfers>[0]);
    const txByHash = new Map(confirmed.map(tx => [tx.getHash(), tx]));
    for (const transfer of outgoingTransfers) {
      const tx = transfer.getTx();
      // Keep the complete confirmed object, including other-account incoming
      // context for self-transfers, rather than replacing it with a partial view.
      if (!txByHash.has(tx.getHash())) txByHash.set(tx.getHash(), tx);
    }
    transactions = [...txByHash.values()].flatMap(tx => {
      const outgoing = tx.getOutgoingTransfer();
      const isOutgoing = outgoing?.getAccountIndex() === accountIndex;
      const incoming = (tx.getIncomingTransfers() ?? []).filter(transfer => transfer.getAccountIndex() === accountIndex);
      if (!isOutgoing && !incoming.length) return [];
      const amount = isOutgoing ? outgoing.getAmount() : incoming.reduce((sum, transfer) => sum + transfer.getAmount(), 0n);
      const type: Transaction['type'] = tx.getIsFailed() ? 'failed' : isOutgoing ? tx.getIsConfirmed() ? 'out' : 'pending' : tx.getIsConfirmed() ? 'in' : 'pool';
      // Outgoing: subaddresses that funded the payment. Incoming: subaddresses that received it.
      const indices = isOutgoing ? outgoing.getSubaddressIndices() ?? [] : incoming.map(transfer => transfer.getSubaddressIndex());
      return [{ txid: tx.getHash(), type, amount: amountString(amount), fee: amountString(tx.getFee()),
        timestamp: tx.getBlock()?.getTimestamp() ?? tx.getReceivedTimestamp() ?? tx.getLastRelayedTimestamp() ?? 0,
        height: tx.getHeight() ?? 0, confirmations: tx.getNumConfirmations() ?? 0,
        address: isOutgoing ? outgoing.getDestinations()?.[0]?.getAddress() ?? '' : incoming[0]?.getAddress() ?? '', note: tx.getNote() ?? '',
        subaddressIndices: [...new Set(indices)].filter(index => Number.isSafeInteger(index) && index >= 0).sort((a, b) => a - b),
        // wallet2 knows destinations only for payments this wallet created (not for restored history).
        destinations: isOutgoing ? (outgoing.getDestinations() ?? []).map(destination =>
          ({ address: destination.getAddress() ?? '', amount: amountString(destination.getAmount()) })) : [],
        locked: tx.getIsLocked() === true }];
    }).sort(byRecency);
  } catch { historyError = 'Local transaction history could not be read. This is not an empty-history guarantee.'; }
  return { balance: amountString(balance), unlockedBalance: amountString(unlocked), height,
    synced: await current.isSynced(), network: (['mainnet', 'testnet', 'stagenet'] as const)[Number(await current.getNetworkType())],
    blocksToUnlock: Math.max(0, ...addresses.map(address => address.getNumBlocksToUnlock() ?? 0)),
    address: await current.getAddress(accountIndex, 0),
    accounts: accountRows,
    addresses: addresses.map(address => ({ index: address.getIndex(), address: address.getAddress(), label: address.getLabel() ?? '',
      used: address.getIsUsed() === true, balance: amountString(address.getBalance()), unlockedBalance: amountString(address.getUnlockedBalance()),
      numUnspentOutputs: address.getNumUnspentOutputs() ?? 0 })),
    contacts: await contactsOf(current),
    transactions, historyNotice: 'Incoming payments appear after their first mined block. Pending outgoing payments are read from the local cache. Sync to update.',
    ...(historyError ? { historyError } : {}) };
};

/** Existence checks run before any native mutation or signature (wallet2 derives keys for any index). */
async function requireSubaddress(current: MoneroWalletFull, accountIndex: number, addressIndex: number) {
  const accounts = await current.getAccounts(false);
  requireCondition(accounts.some(account => account.getIndex() === accountIndex), 'This account does not exist.', 'INVALID_ACCOUNT');
  const addresses = await current.getSubaddresses(accountIndex);
  requireCondition(addresses.some(address => address.getIndex() === addressIndex), 'This address does not exist in the selected account.', 'INVALID_SUBADDRESS');
}
vendor.extAddressLabel = async (id: string, accountIndex: number, addressIndex: number, label: string) => {
  const current = wallet(id);
  await requireSubaddress(current, accountIndex, addressIndex);
  await current.setSubaddressLabel(accountIndex, addressIndex, label);
  return {};
};

// Address book. Rows are addressed by index, so every change names the address the
// caller saw at that index. Addresses were validated for this network by the service
// (no OpenAlias/DNS lookups). Each native change is read back before it can be saved.
function requireContact(rows: Contact[], index: number, expectedAddress: string): Contact {
  const row = rows.find(candidate => candidate.index === index);
  if (!row || row.address !== expectedAddress) throw new RuntimeError('The address book changed. Review it and try again.', 'STALE_CONTACT');
  return row;
}
const requireUnique = (rows: Contact[], address: string, except?: number) => requireCondition(
  !rows.some(row => row.index !== except && row.address === address), 'This address is already in your address book.', 'DUPLICATE_CONTACT');
const requireSaved = (rows: Contact[], index: number, address: string, description: string) => requireCondition(
  rows.some(row => row.index === index && row.address === address && row.description === description),
  'The address book could not be updated safely.', 'CONTACT_UPDATE_FAILED');
async function appendContact(current: MoneroWalletFull, address: string, description: string) {
  const index = Number(await current.addAddressBookEntry(address, description));
  requireSaved(await contactsOf(current), index, address, description);
  return { index };
}
vendor.extContactAdd = async (id: string, address: string, description: string) => {
  const current = wallet(id);
  const rows = await contactsOf(current);
  requireCondition(rows.length < MAX_CONTACTS, 'The address book is full.', 'CONTACTS_FULL');
  requireUnique(rows, address);
  return appendContact(current, address, description);
};
vendor.extContactEdit = async (id: string, index: number, expectedAddress: string, address: string, description: string) => {
  const current = wallet(id);
  const rows = await contactsOf(current);
  const row = requireContact(rows, index, expectedAddress);
  if (address !== row.address) requireUnique(rows, address, index); // Tolerate imported duplicates.
  const integrated = (value: string) => value.length === 106;
  if (integrated(row.address) !== integrated(address)) {
    // monero-cpp's in-place edit keeps the previous row's payment-ID flag, so switching
    // between integrated and standard addresses would keep or drop a payment ID.
    // Append the replacement first (a failure can never lose the row), then remove
    // the old row: the edited contact moves to the end of the address book.
    const { index: added } = await appendContact(current, address, description);
    await current.deleteAddressBookEntry(index);
    const after = await contactsOf(current);
    requireCondition(after.length === rows.length, 'The address book could not be updated safely.', 'CONTACT_UPDATE_FAILED');
    requireSaved(after, added - 1, address, description);
    return { index: added - 1 };
  }
  await current.editAddressBookEntry(index, true, address, true, description);
  requireSaved(await contactsOf(current), index, address, description);
  return { index };
};
vendor.extContactDelete = async (id: string, index: number, expectedAddress: string) => {
  const current = wallet(id);
  const rows = await contactsOf(current);
  requireContact(rows, index, expectedAddress);
  await current.deleteAddressBookEntry(index);
  requireCondition((await contactsOf(current)).length === rows.length - 1, 'The address book could not be updated safely.', 'CONTACT_UPDATE_FAILED');
  return {};
};

// Local message signatures (wallet2 "SigV2"): no network access and no wallet mutation.
vendor.extSign = async (id: string, message: string, accountIndex: number, addressIndex: number, mode: 'spend' | 'view') => {
  const current = wallet(id);
  requireCondition(mode === 'spend' || mode === 'view', 'Choose the spend or view key.', 'INVALID_PARAMS');
  await requireSubaddress(current, accountIndex, addressIndex);
  const type = (mode === 'view' ? 1 : 0) as Parameters<MoneroWalletFull['signMessage']>[1];
  const signature = await current.signMessage(message, type, accountIndex, addressIndex);
  requireCondition(typeof signature === 'string' && /^SigV\d+[1-9A-HJ-NP-Za-km-z]+$/.test(signature), 'The engine returned an invalid signature.', 'WASM_ERROR');
  return { signature, address: await current.getAddress(accountIndex, addressIndex) };
};
vendor.extVerify = async (id: string, message: string, address: string, signature: string): Promise<MessageVerification> => {
  // monero-ts reports malformed signatures as not good instead of throwing.
  const result = await wallet(id).verifyMessage(message, address, signature);
  const good = result.getIsGood() === true;
  const type = Number(result.getSignatureType());
  const version = Number(result.getVersion());
  return { good, old: good && result.getIsOld() === true, signatureType: !good ? null : type === 0 ? 'spend' : type === 1 ? 'view' : null,
    version: good && Number.isSafeInteger(version) ? version : null };
};
/** Transaction keys exist only for payments this wallet created and relayed (wallet2 m_tx_keys); no daemon access. */
vendor.extTxKey = async (id: string, txHash: string) => {
  const current = wallet(id);
  requireCondition(/^[a-f\d]{64}$/i.test(txHash), 'Enter a 64-character transaction ID.', 'INVALID_PARAMS');
  let key: unknown;
  try { key = await current.getTxKey(txHash); } catch { key = undefined; }
  requireCondition(typeof key === 'string' && /^(?:[a-f\d]{64})+$/i.test(key), 'This wallet has no key for this transaction.', 'TX_KEY_UNAVAILABLE');
  return { key: key.toLowerCase() };
};

/** Public keys plus the private VIEW key (for view-only wallets). The private spend key never leaves the worker. */
vendor.extKeys = async (id: string): Promise<{ primaryAddress: string; publicViewKey: string; privateViewKey: string; publicSpendKey: string }> => {
  const current = wallet(id);
  const keys = { primaryAddress: await current.getPrimaryAddress(), publicViewKey: await current.getPublicViewKey(),
    privateViewKey: await current.getPrivateViewKey(), publicSpendKey: await current.getPublicSpendKey() };
  requireCondition(/^[1-9A-HJ-NP-Za-km-z]{95}$/.test(keys.primaryAddress) &&
    [keys.publicViewKey, keys.privateViewKey, keys.publicSpendKey].every(key => typeof key === 'string' && /^[a-f\d]{64}$/i.test(key)),
  'The engine returned invalid wallet keys.', 'WASM_ERROR');
  return { primaryAddress: keys.primaryAddress, publicViewKey: keys.publicViewKey.toLowerCase(),
    privateViewKey: keys.privateViewKey.toLowerCase(), publicSpendKey: keys.publicSpendKey.toLowerCase() };
};
/** 8 random bytes from the browser CSPRNG; never the all-zero ID (wallet2's dummy "no payment ID"). */
function randomPaymentId(): string {
  for (;;) {
    const hex = [...crypto.getRandomValues(new Uint8Array(8))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (!/^0{16}$/.test(hex)) return hex;
  }
}
/** Integrated address of the wallet's PRIMARY address. Local only; read back and decoded before use. */
vendor.extIntegrated = async (id: string, paymentId: string | null) => {
  const current = wallet(id);
  requireCondition(paymentId === null || (/^[a-f\d]{16}$/.test(paymentId) && !/^0{16}$/.test(paymentId)),
    'A payment ID is 16 hexadecimal characters and not all zeros.', 'INVALID_PARAMS');
  const pid = paymentId ?? randomPaymentId();
  const primary = await current.getPrimaryAddress();
  const integrated = (await current.getIntegratedAddress(primary, pid)).getIntegratedAddress();
  const decoded = await current.decodeIntegratedAddress(integrated);
  requireCondition(/^[1-9A-HJ-NP-Za-km-z]{106}$/.test(integrated) && decoded.getStandardAddress() === primary &&
    decoded.getPaymentId()?.toLowerCase() === pid, 'The engine returned an invalid integrated address.', 'WASM_ERROR');
  return { integratedAddress: integrated, paymentId: pid };
};

/** Unconfirmed outgoing payments (and their recipients) exist only in this cache; a rescan would drop them. Local query. */
async function requireNoPendingOutgoing(current: MoneroWalletFull) {
  const outgoing = await current.getTransfers({ isOutgoing: true } as Parameters<typeof current.getTransfers>[0]);
  requireCondition(!outgoing.some(transfer => transfer.getTx().getIsConfirmed() !== true && transfer.getTx().getIsFailed() !== true),
    'Wait until your pending payments are confirmed before rescanning.', 'PENDING_OUTGOING');
}
vendor.extRescanCheck = async (id: string) => { await requireNoPendingOutgoing(wallet(id)); return {}; };
/**
 * Rescan from `restoreHeight`, only inside the caller's network gate. monero-cpp rescan_blockchain runs
 * wallet2's SOFT clear (keys, subaddresses, labels, address book, notes and sent-transaction keys are
 * kept; scanned outputs are rebuilt from the chain, the recipients recorded for past payments are
 * lost) and wallet2's own full refresh; blocks below the restore height are fetched as hashes only.
 */
vendor.extRescan = async (id: string, restoreHeight: number, tipHint: number) => {
  const current = wallet(id);
  requireCondition([restoreHeight, tipHint].every(value => Number.isSafeInteger(value) && value >= 0), 'The restore height is invalid.', 'INVALID_PARAMS');
  requireCondition(permittedNode, 'Network access is disabled until you explicitly choose a node and synchronize.', 'NETWORK_DISABLED');
  await requireNoPendingOutgoing(current);
  // monero-cpp silently skips a requested rescan while the daemon is behind: refuse instead.
  requireCondition(await current.isDaemonSynced(), 'The node is still synchronizing. Rescan after it has caught up.', 'NODE_NOT_SYNCED');
  clearDrafts();
  await current.setRestoreHeight(restoreHeight);
  rescanWatch = { walletId: id, from: restoreHeight, end: Math.max(tipHint, restoreHeight) };
  try { await current.rescanBlockchain(); }
  finally { rescanWatch = null; }
  return { restoreHeight: await current.getRestoreHeight() };
};
// wallet2 refreshes inside rescan_blockchain BEFORE monero-cpp starts its sync bookkeeping, so the
// native listener drops those block events. Observe the heights each daemon block/hash response
// states instead (epee binary: <len>"start_height"<type 5 = uint64><8 bytes LE>).
// Display only: the guarded request, its response and its errors pass through unchanged.
let rescanWatch: { walletId: string; from: number; end: number } | null = null;
const START_HEIGHT = new TextEncoder().encode('\u000cstart_height\u0005');
const CURRENT_HEIGHT = new TextEncoder().encode('\u000ecurrent_height\u0005');
function binaryHeight(bytes: Uint8Array, key: Uint8Array): number | null {
  for (let at = bytes.indexOf(key[0]); at >= 0 && at + key.length + 8 <= bytes.length; at = bytes.indexOf(key[0], at + 1)) {
    if (!key.every((byte, offset) => bytes[at + offset] === byte)) continue;
    const value = new DataView(bytes.buffer, bytes.byteOffset + at + key.length, 8).getBigUint64(0, true);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  return null;
}
const guardedRequest = vendor.HttpClient.request;
vendor.HttpClient.request = async request => {
  const response = await guardedRequest(request);
  const watch = rescanWatch;
  try {
    const body = (response as { body?: unknown } | null)?.body;
    if (watch && body instanceof Uint8Array && /\/get(?:blocks|hashes)\.bin$/.test(engineRequestUrl(request.uri).pathname)) {
      const start = binaryHeight(body, START_HEIGHT), tip = binaryHeight(body, CURRENT_HEIGHT);
      if (start !== null) {
        watch.end = Math.max(watch.end, tip ?? 0);
        const height = Math.min(Math.max(start, watch.from), watch.end);
        const percentDone = watch.end > watch.from ? (height - watch.from) / (watch.end - watch.from) : 1;
        (globalThis as unknown as { postMessage(message: unknown): void })
          .postMessage([watch.walletId, 'onSyncProgress_extension', height, watch.from, watch.end, percentDone, 'Rescanning']);
      }
    }
  } catch { /* Progress is cosmetic and never affects the request. */ }
  return response;
};

/** Map wallet2 transfer failures (plain native messages) to readable, allowlisted codes. */
function transferError(error: unknown, subtractFee: boolean): unknown {
  if (typeof (error as { code?: unknown } | null)?.code === 'string') return error;
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  if (/destination amount is zero/i.test(message) || (subtractFee && /tx not possible/i.test(message)))
    return new RuntimeError('The amount is too small to cover the network fee.', 'AMOUNT_TOO_SMALL');
  if (/not enough (unlocked )?money|tx not possible/i.test(message)) return new RuntimeError('Insufficient unlocked funds for the amount and fee.', 'INSUFFICIENT_FUNDS');
  if (/too (large|big)|cannot be split/i.test(message)) return new RuntimeError('This payment needs too many inputs for one transaction.', 'TX_TOO_LARGE');
  if (/not enough outputs/i.test(message)) return new RuntimeError('Not enough outputs exist for a private ring.', 'NOT_ENOUGH_OUTPUTS');
  return error;
}

vendor.extPrepare = async (id: string, params: PrepareParams): Promise<Draft> => {
  const current = wallet(id);
  for (const [key, draft] of drafts) if (draft.expiresAt <= Date.now()) drafts.delete(key);
  requireCondition(drafts.size < 16, 'Cancel previous transaction reviews before preparing more.', 'TOO_MANY_DRAFTS');
  requireCondition(await current.isSynced(), 'Synchronize the wallet before preparing a transfer.', 'NOT_SYNCED');
  requireCondition(await current.isDaemonTrusted() === false, 'Only an untrusted daemon connection is allowed.', 'UNSAFE_NODE');
  requireCondition((await current.getAccounts(false)).some(account => account.getIndex() === params.accountIndex), 'This account does not exist.', 'INVALID_ACCOUNT');
  const subtractFee = params.subtractFee === true;
  const requested = BigInt(params.amount);
  requireCondition(requested > 0n && requested <= await current.getUnlockedBalance(params.accountIndex), 'Insufficient unlocked funds.', 'INSUFFICIENT_FUNDS');
  let tx: MoneroTxWallet;
  try {
    // Exactly one transaction. With subtractFeeFrom (wallet2 "subtractfeefrom") the
    // recipient receives the requested amount minus the fee; it is never split.
    tx = await current.createTx({ accountIndex: params.accountIndex, address: params.address, amount: requested,
      priority: params.priority, relay: false, canSplit: false, ...(subtractFee ? { subtractFeeFrom: [0] } : {}) });
  } catch (error) { throw transferError(error, subtractFee); }
  const txSet = tx.getTxSet();
  const destinations = tx.getOutgoingTransfer()?.getDestinations();
  const fee = tx.getFee();
  const received = destinations?.length === 1 ? destinations[0].getAmount() : undefined;
  // The total debit is always the reviewed recipient amount plus fee: exactly the request
  // when the fee is subtracted, otherwise the recipient receives exactly the request.
  requireCondition(!txSet?.getUnsignedTxHex() && !txSet?.getMultisigTxHex() && !tx.getIsRelayed() &&
    tx.getMetadata() && /^[a-f\d]{64}$/i.test(tx.getHash()) && destinations?.length === 1 && destinations[0].getAddress() === params.address &&
    typeof received === 'bigint' && typeof fee === 'bigint' && fee >= 0n && received > 0n &&
    (subtractFee ? received + fee === requested : received === requested),
    'The engine did not return the exact requested signed transaction.', 'INVALID_DRAFT');
  requireCondition(received + fee <= await current.getUnlockedBalance(params.accountIndex), 'Insufficient unlocked funds for amount plus fee.', 'INSUFFICIENT_FUNDS');
  const summary: Draft = { draftId: crypto.randomUUID(), amount: received.toString(), fee: fee.toString(), address: params.address,
    txHash: tx.getHash(), expiresAt: Date.now() + 300_000, ...(subtractFee ? { subtractFee: true } : {}) };
  drafts.set(summary.draftId, { ...summary, metadata: tx.getMetadata(), generation, walletId: id,
    primary: await current.getPrimaryAddress(), accountIndex: params.accountIndex, height: await current.getHeight() });
  return summary;
};
vendor.extCancel = async (_id: string, draftId: string) => { drafts.delete(draftId); };
vendor.extConfirm = async (id: string, draftId: string): Promise<{ txHash: string }> => {
  const draft = drafts.get(draftId);
  drafts.delete(draftId); // A confirmation is always one-shot, including validation failures.
  requireCondition(draft && draft.walletId === id && draft.generation === generation && draft.expiresAt > Date.now(),
    'The transaction review expired, changed, or was already used. Never retry an unknown broadcast.', 'DRAFT_NOT_FOUND');
  const current = wallet(id);
  requireCondition(await current.getPrimaryAddress() === draft.primary && await current.isSynced() &&
    await current.isDaemonTrusted() === false && await current.getHeight() >= draft.height,
    'Wallet state changed. Synchronize and prepare again.', 'STALE_DRAFT');
  requireCondition(await current.getUnlockedBalance(draft.accountIndex) >= BigInt(draft.amount) + BigInt(draft.fee),
    'Unlocked balance changed.', 'INSUFFICIENT_FUNDS');
  requireCondition(draft.expiresAt > Date.now(), 'The transaction review expired.', 'DRAFT_NOT_FOUND');
  clearDrafts();
  try {
    const hash = await current.relayTx(draft.metadata);
    if (hash !== draft.txHash) throw new Error('Hash mismatch');
    return { txHash: hash };
  } catch {
    throw new RuntimeError('Broadcast outcome is unknown. Check the saved transaction ID before sending again. Nothing was retried.', 'RELAY_UNCERTAIN');
  }
};
