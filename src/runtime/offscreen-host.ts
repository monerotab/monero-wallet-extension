import { CLOSE_ACTIONS, MAX_CLIENTS, MAX_HOST_REQUESTS, MAX_PENDING_REQUESTS, OPEN_ACTIONS, PORT_NAME, READ_ACTIONS, SESSION_IDLE_MS,
  TransportError, errorRecord, plain, sessionIdleMs, trustedSender, validRequest, walletChanged, type RuntimePort, type WalletRuntime } from './transport.ts';
import { PortWire } from './transport-wire.ts';
import { WalletIdentityGate } from './transport-identity.ts';

interface Client {
  wire: PortWire; connected: boolean; pending: number; received: Set<number>; contiguousId: number; drafts: Map<string, string>;
}
/** Owns transport lifetime only. WalletService retains all native/vault/relay guards. */
export class OffscreenWalletHost {
  private readonly service: WalletRuntime;
  private readonly gate: WalletIdentityGate;
  private readonly extensionId: string;
  private readonly now: () => number;
  private clients = new Set<Client>();
  private operations = 0;
  private lastActivity: number;
  private expired = false;
  private checkingIdle = false;
  private closing = false;
  private walletMayBeOpen = false;
  /** The open wallet's encrypted auto-lock setting (default five minutes, never above one hour). */
  private idleMs = SESSION_IDLE_MS;
  constructor(service: WalletRuntime, extensionId: string, now = Date.now) {
    this.service = service; this.gate = new WalletIdentityGate(service);
    this.extensionId = extensionId; this.now = now; this.lastActivity = now();
  }
  accept(port: RuntimePort): boolean {
    if (port.name !== PORT_NAME || !trustedSender(port.sender, this.extensionId, 'ui') || this.clients.size >= MAX_CLIENTS) {
      try { port.disconnect(); } catch { /* Invalid or already closed. */ } return false;
    }
    const client: Client = { wire: undefined!, connected: true, pending: 0, received: new Set(), contiguousId: 0, drafts: new Map() };
    client.wire = new PortWire(port, value => this.receive(client, value), () => this.detach(client));
    this.clients.add(client); this.activity();
    void client.wire.send({ kind: 'ready' }).catch(() => client.wire.close());
    return true;
  }
  private activity() {
    this.latchExpiry();
    if (!this.expired && !this.closing) this.lastActivity = this.now();
  }
  private latchExpiry() {
    if (this.walletMayBeOpen && this.now() - this.lastActivity >= this.idleMs) this.expired = true;
  }
  /** Status results are the only source of the idle limit; polls never count as activity. */
  private observe(status: unknown) {
    if (!plain(status) || typeof status.walletOpen !== 'boolean') return;
    this.walletMayBeOpen = status.walletOpen;
    this.idleMs = status.walletOpen ? sessionIdleMs(status) : SESSION_IDLE_MS;
  }
  private assertActive(action: string) {
    this.latchExpiry();
    if ((this.closing && !READ_ACTIONS.has(action)) || (this.expired && !READ_ACTIONS.has(action) && action !== 'wallet.close')) {
      const minutes = Math.round(this.idleMs / 60_000);
      throw new TransportError(`The session expired after ${minutes === 1 ? 'one minute' : `${minutes} minutes`} without interaction. Synchronization or an active operation must finish before automatic locking. Unlock again once locked.`, 'SESSION_EXPIRED');
    }
  }
  private detach(client: Client) {
    if (!client.connected) return;
    client.connected = false; this.clients.delete(client);
    // Submitted confirmations are removed before entering the queue. Only abandoned
    // unconfirmed reviews are cancelled, with their original wallet identity.
    for (const [draftId, vaultId] of client.drafts) this.cancelDraft(draftId, vaultId);
    client.drafts.clear();
    void this.checkIdle();
  }
  private cancelDraft(draftId: string, vaultId: string) {
    this.operations++;
    void this.gate.request('tx.cancel', { draftId }, vaultId).catch(() => undefined).finally(() => {
      this.operations--; void this.checkIdle();
    });
  }
  private async reply(client: Client, id: number, result: unknown, error?: unknown, vaultId?: string | null) {
    if (!client.connected) return; // Do not retain seed/export responses for absent clients.
    await client.wire.send(error === undefined ? { kind: 'response', id, ok: true, result, ...(vaultId !== undefined ? { vaultId } : {}) } :
      { kind: 'response', id, ok: false, error: errorRecord(error) }).catch(() => client.wire.close());
  }
  private receive(client: Client, value: unknown) {
    if (!client.connected) return;
    if (plain(value) && value.kind === 'activity' && Object.keys(value).length === 1) { this.activity(); void this.checkIdle(); return; }
    if (!validRequest(value)) { client.wire.close(); return; }
    const { id, action, params, expectedVaultId } = value;
    // A sliding contiguous watermark rejects even completed request IDs without
    // retaining an unbounded replay cache. Large-backup chunks may reorder arrival.
    if (id <= client.contiguousId || client.received.has(id) || id > client.contiguousId + 4096) { client.wire.close(); return; }
    client.received.add(id);
    while (client.received.delete(client.contiguousId + 1)) client.contiguousId++;
    if (client.pending >= MAX_PENDING_REQUESTS || this.operations >= MAX_HOST_REQUESTS) {
      void this.reply(client, id, undefined, new TransportError('Too many wallet operations are pending.', 'QUEUE_FULL')); return;
    }
    try { this.assertActive(action); }
    catch (error) { void this.reply(client, id, undefined, error); void this.checkIdle(); return; }
    if (action === 'tx.prepare' && client.drafts.size >= 8) {
      void this.reply(client, id, undefined, new TransportError('Cancel an existing transaction review before preparing another.', 'QUEUE_FULL')); return;
    }
    if (action === 'tx.confirm' || action === 'tx.cancel') {
      const owner = typeof params.draftId === 'string' ? client.drafts.get(params.draftId) : undefined;
      if (!owner) {
        void this.reply(client, id, undefined, new TransportError('This transaction review is not owned by this wallet view. Prepare a new review; an unknown payment was not retried.', 'DRAFT_NOT_FOUND')); return;
      }
      if (owner !== expectedVaultId) { void this.reply(client, id, undefined, walletChanged()); return; }
      client.drafts.delete(params.draftId as string);
    }
    client.pending++; this.operations++;
    // Identity checks, action, result identity check, and response handoff share one
    // outer critical section. Another UI cannot replace A with B between them.
    void this.gate.request(action, params, expectedVaultId, async (result, vaultId) => {
      if (OPEN_ACTIONS.has(action)) {
        this.walletMayBeOpen = true;
        // Apply the unlocked wallet's own auto-lock setting before any later idle check.
        this.observe(await this.service.request('status').catch(() => undefined));
      }
      if (['wallet.refresh', 'wallet.rescan', 'node.select'].includes(action)) for (const view of this.clients) view.drafts.clear();
      if (action === 'status') this.observe(result);
      if (action === 'wallet.settings' && plain(result)) this.idleMs = sessionIdleMs(result);
      if (CLOSE_ACTIONS.has(action)) {
        this.walletMayBeOpen = false; this.expired = false; this.idleMs = SESSION_IDLE_MS;
        for (const view of this.clients) view.drafts.clear();
      }
      if (action === 'tx.prepare' && plain(result) && typeof result.draftId === 'string' && typeof vaultId === 'string') {
        if (!client.connected) this.cancelDraft(result.draftId, vaultId);
        else client.drafts.set(result.draftId, vaultId);
      }
      await this.reply(client, id, result, undefined, vaultId);
    }, () => {
      this.assertActive(action); // Recheck inactivity after any queue wait, too.
      if (OPEN_ACTIONS.has(action)) this.walletMayBeOpen = true;
    }).catch(error => this.reply(client, id, undefined, error)).finally(() => {
      client.pending--; this.operations--; void this.checkIdle();
    });
  }
  /** Called every 15s and when requests settle. Never dispose a relaying worker. */
  async checkIdle(): Promise<void> {
    this.latchExpiry();
    if (!this.expired || this.operations || this.checkingIdle || this.closing) return;
    this.checkingIdle = true;
    try {
      await this.gate.exclusive(async () => {
        const status = await this.service.request('status');
        if (!plain(status)) return;
        if (!status.walletOpen) { this.walletMayBeOpen = false; this.expired = false; this.idleMs = SESSION_IDLE_MS; return; }
        // Explicit sync may finish with no UI. Wait for its durable checkpoint;
        // explicit user Lock can still cancel via the normal identity-guarded call.
        if (status.syncing || this.operations) return;
        this.closing = true;
        await this.service.request('wallet.close');
        this.walletMayBeOpen = false; this.expired = false; this.idleMs = SESSION_IDLE_MS;
        for (const client of this.clients) client.drafts.clear();
      });
    } catch {
      // Service storage/native failures already fail closed. Retry only the safe
      // idle/close check, never the user's operation, unlock, prepare or broadcast.
    } finally { this.closing = false; this.checkingIdle = false; }
  }
}
