import { RuntimeError, requireCondition } from './errors.ts';
import type { SyncProgress } from '../lib/types';

// Address book, labels, signatures and tx keys go only through validating ext* hooks.
const METHODS = new Set(['extInit', 'extNetwork', 'extAbortNetwork', 'extInvalidateDrafts', 'extConfigureNode', 'extSnapshot', 'extPrepare', 'extCancel', 'extConfirm',
  'extAddressLabel', 'extContactAdd', 'extContactEdit', 'extContactDelete', 'extSign', 'extVerify', 'extTxKey',
  // Wallet keys never include the private spend key; rescans and integrated addresses are validated in the hooks.
  'extKeys', 'extIntegrated', 'extRescanCheck', 'extRescan',
  'createWalletFull', 'openWalletData', 'getData', 'getSeed', 'getAddress', 'getRestoreHeight', 'getHeight', 'getNetworkType', 'getBalance', 'getUnlockedBalance',
  'getAccounts', 'createAccount', 'createSubaddress', 'getDaemonHeight', 'isDaemonSynced', 'isSynced', 'isDaemonTrusted',
  'setTxNotes', 'changePassword', 'addListener', 'sync', 'close', 'moneroUtilsValidateAddress']);
const SAFE_ERRORS: Record<string, string> = {
  NO_WALLET: 'Unlock a wallet first.', NOT_SYNCED: 'Synchronize your wallet before sending.', UNSAFE_NODE: 'The engine refused an unsafe node connection.',
  INVALID_NODE: 'The selected node is not allowed.', NETWORK_DISABLED: 'Select a public node and explicitly synchronize first.',
  NODE_TIMEOUT: 'The node request timed out. No operation was retried.', NODE_UNREACHABLE: 'The node is unreachable. No operation was retried.',
  NODE_HTTP_ERROR: 'The node refused the request. No operation was retried.', NODE_RESPONSE_TOO_LARGE: 'The node response exceeded the safety limit.',
  INSUFFICIENT_FUNDS: 'Insufficient unlocked funds for the amount and fee.', INVALID_ACCOUNT: 'The selected account does not exist.',
  INVALID_DRAFT: 'The engine did not return the exact requested signed transaction.', TOO_MANY_DRAFTS: 'Cancel previous transaction reviews before preparing more.',
  DRAFT_NOT_FOUND: 'The transaction review expired, was cancelled or already consumed. Never blindly retry an unknown payment.',
  STALE_DRAFT: 'Wallet state changed. Synchronize and prepare a new review.',
  RELAY_UNCERTAIN: 'Broadcast outcome is unknown. Check the saved transaction ID before sending again. Nothing was retried.',
  AMOUNT_TOO_SMALL: 'The amount is too small to cover the network fee.',
  TX_TOO_LARGE: 'This payment needs too many inputs for one transaction. Send a smaller amount, or several payments.',
  NOT_ENOUGH_OUTPUTS: 'The network does not have enough outputs for a private ring signature. No transaction was created.',
  INVALID_SUBADDRESS: 'This address does not exist in the selected account.',
  STALE_CONTACT: 'The address book changed. Review it and try again.',
  DUPLICATE_CONTACT: 'This address is already in your address book.',
  CONTACTS_FULL: 'The address book is full (500 entries). Delete an entry first.',
  CONTACT_UPDATE_FAILED: 'The address book could not be updated safely. The wallet was locked without saving that change; unlock it again.',
  TX_KEY_UNAVAILABLE: 'This wallet has no key for this transaction. Keys exist only for payments sent from this wallet.',
  PENDING_OUTGOING: 'Wait until your pending payments are confirmed before rescanning.',
  NODE_NOT_SYNCED: 'The node is still synchronizing. Rescan after it has caught up.',
};
interface Pending { id: string; resolve(value: unknown): void; reject(error: unknown): void; timer?: ReturnType<typeof setTimeout> }

/** Small static protocol client; no main-thread SDK, eval, function serialization or remote code. */
export class EngineClient {
  private worker: Worker;
  private pending = new Map<string, Pending>();
  private disposed = false;
  onProgress?: (id: string, progress: SyncProgress) => void;
  onFatal?: () => void;
  constructor(url = new URL('monero.worker.js', document.baseURI)) {
    this.worker = new Worker(url, { name: 'monero-wallet-engine' });
    this.worker.onmessage = event => {
      const data = event.data;
      if (!Array.isArray(data) || typeof data[0] !== 'string' || typeof data[1] !== 'string') return;
      const [id, callback, payload] = data;
      if (callback === 'onSyncProgress_extension') {
        const [height, startHeight, endHeight, percentDone] = data.slice(2);
        if ([height, startHeight, endHeight].every(value => Number.isSafeInteger(value) && value >= 0) && Number.isFinite(percentDone) && percentDone >= 0 && percentDone <= 1) {
          this.onProgress?.(id, { height, startHeight, endHeight, percentDone, message: 'Scanning blocks in your browser' });
        }
        return;
      }
      const entry = this.pending.get(callback);
      if (!entry || entry.id !== id) return;
      this.pending.delete(callback); clearTimeout(entry.timer);
      if (payload?.error) {
        const code = typeof payload.error.code === 'string' && Object.hasOwn(SAFE_ERRORS, payload.error.code) ? payload.error.code : 'WASM_ERROR';
        entry.reject(new RuntimeError(SAFE_ERRORS[code] ?? 'The Monero engine rejected this operation. Check the password, recovery phrase, node availability and wallet state.', code));
      } else entry.resolve(payload?.result);
    };
    this.worker.onerror = event => { event.preventDefault(); this.fail('The browser wallet engine stopped. Unlock your saved wallet again; verify any pending transaction before retrying.'); };
    this.worker.onmessageerror = () => this.fail('The browser could not read a wallet engine response. Unlock again and check pending transfers.');
  }
  call<T = unknown>(id: string, method: string, args: unknown[] = [], timeoutMs = 120_000): Promise<T> {
    requireCondition(!this.disposed, 'The wallet engine is locked or closed.', 'ENGINE_CLOSED');
    requireCondition(METHODS.has(method), 'This wallet operation is not allowed.', 'INVALID_ACTION');
    requireCondition(this.pending.size < 64, 'Too many queued wallet requests.', 'QUEUE_FULL');
    const callback = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => this.fail('The wallet engine timed out. No operation was retried; check any pending transfer before sending again.'), timeoutMs) : undefined;
      this.pending.set(callback, { id, resolve: resolve as (value: unknown) => void, reject, timer });
      try { this.worker.postMessage([id, method, callback, ...args]); }
      catch { this.fail('The browser could not send a request to the wallet engine.'); }
    });
  }
  private fail(message: string) { if (this.disposed) return; this.dispose(new RuntimeError(message, 'ENGINE_FAILED')); this.onFatal?.(); }
  dispose(error: Error = new RuntimeError('The wallet was locked or the tab was closed.', 'ENGINE_CLOSED')) {
    if (this.disposed) return;
    this.disposed = true; this.worker.terminate();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.onProgress = undefined;
  }
}
