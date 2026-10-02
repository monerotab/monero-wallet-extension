import { LOST_MESSAGE, MAX_PENDING_REQUESTS, TransportError, plain, validRequest, validResultIdentity, walletChanged, type RuntimePort } from './transport.ts';
import { PortWire } from './transport-wire.ts';

interface Pending { action: string; expectedVaultId?: string | null; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
/** One UI document owns one port. A lost request is rejected, never replayed. */
export class WalletPortClient {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readyTimer: ReturnType<typeof setTimeout>;
  private isReady = false;
  private closed = false;
  private serial = 0;
  private pending = new Map<number, Pending>();
  private wire: PortWire;
  constructor(port: RuntimePort, onClose: () => void = () => {}) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.readyTimer = setTimeout(() => this.close(), 10_000);
    this.wire = new PortWire(port, value => this.receive(value), () => {
      if (this.closed) return;
      this.closed = true; clearTimeout(this.readyTimer);
      const error = new TransportError(LOST_MESSAGE);
      this.rejectReady(error);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear(); onClose();
    });
  }
  private receive(value: unknown) {
    if (!plain(value)) { this.close(); return; }
    if (value.kind === 'ready' && !this.isReady) {
      this.isReady = true; clearTimeout(this.readyTimer); this.resolveReady(); return;
    }
    if (value.kind !== 'response' || !Number.isSafeInteger(value.id)) { this.close(); return; }
    const pending = this.pending.get(value.id as number);
    if (!pending) return; // Late/disconnected results are never retained, especially seeds.
    this.pending.delete(value.id as number); clearTimeout(pending.timer);
    if (value.ok === true) {
      if (validResultIdentity(pending.action, pending.expectedVaultId, value.vaultId)) pending.resolve(value.result);
      else pending.reject(walletChanged());
    }
    else if (value.ok === false && plain(value.error) && typeof value.error.message === 'string')
      pending.reject(new TransportError(value.error.message, typeof value.error.code === 'string' ? value.error.code : 'WALLET_ERROR'));
    else { pending.reject(new TransportError(LOST_MESSAGE)); this.close(); }
  }
  async request<T>(action: string, params: Record<string, unknown> = {}, expectedVaultId?: string | null): Promise<T> {
    await this.ready;
    if (this.closed) throw new TransportError(LOST_MESSAGE);
    if (this.pending.size >= MAX_PENDING_REQUESTS) throw new TransportError('Too many wallet requests are pending.', 'QUEUE_FULL');
    const id = this.serial + 1;
    const message = { kind: 'request' as const, id, action, params, ...(expectedVaultId !== undefined ? { expectedVaultId } : {}) };
    if (!validRequest(message)) throw new TransportError('Wallet request parameters are invalid.', 'INVALID_PARAMS');
    this.serial = id;
    return new Promise<T>((resolve, reject) => {
      // Expiry drops the connection, not the wallet operation. The user must verify
      // an unknown result. Even a timeout never resubmits signing or relay.
      const timer = setTimeout(() => this.close(), 15 * 60_000);
      this.pending.set(id, { action, expectedVaultId, resolve: resolve as (value: unknown) => void, reject, timer });
      void this.wire.send(message).catch(error => {
        const pending = this.pending.get(id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error); }
      });
    });
  }
  activity() { if (this.isReady && !this.closed) void this.wire.send({ kind: 'activity' }).catch(() => undefined); }
  close() { this.wire.close(); }
}
