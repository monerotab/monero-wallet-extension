import { MAX_HOST_REQUESTS, NEUTRAL_ACTIONS, OPEN_ACTIONS, POLL_ACTIONS, TransportError, plain, validResultIdentity,
  validVaultId, walletChanged, type WalletRuntime } from './transport.ts';

/** Shared offscreen views must bind each operation to the wallet the USER saw.
 * This is an outer identity critical section, not a replacement for any of the
 * service's native/vault/Web-Lock/relay guards. Status polling is never binding. */
export class WalletIdentityGate {
  private readonly service: WalletRuntime;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  constructor(service: WalletRuntime) { this.service = service; }
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.queued >= MAX_HOST_REQUESTS) return Promise.reject(new TransportError('Too many wallet operations are pending.', 'QUEUE_FULL'));
    const enqueuedAt = Date.now(); this.queued++;
    const task = this.tail.then(async () => {
      if (Date.now() - enqueuedAt >= 30_000) throw new TransportError('The wallet request waited too long and was not started.', 'QUEUE_TIMEOUT');
      return operation();
    });
    this.tail = task.catch(() => undefined).finally(() => { this.queued--; });
    return task;
  }
  private async identity(): Promise<string | null> {
    const status = await this.service.request('status');
    if (!plain(status) || typeof status.walletOpen !== 'boolean') throw walletChanged();
    if (!status.walletOpen) return null;
    if (!validVaultId(status.vaultId)) throw walletChanged();
    return status.vaultId;
  }
  async request(action: string, params: Record<string, unknown> = {}, expectedVaultId?: string | null,
    resultReady?: (result: unknown, vaultId: string | null | undefined) => Promise<void>, beforeStart?: () => void): Promise<unknown> {
    const execute = async () => {
      const scoped = !NEUTRAL_ACTIONS.has(action);
      if (scoped) {
        const expectedValid = OPEN_ACTIONS.has(action) ? expectedVaultId === null : validVaultId(expectedVaultId);
        if (!expectedValid || await this.identity() !== expectedVaultId) throw walletChanged();
      }
      beforeStart?.();
      const result = await this.service.request(action, params);
      let vaultId: string | null | undefined;
      if (scoped) {
        vaultId = await this.identity();
        // Worker/storage failures can clear a session while an async operation is
        // settling. Never deliver a seed, draft, export or end result for another
        // identity, even if a service failure bypassed its normal return path.
        if (!validResultIdentity(action, expectedVaultId, vaultId) ||
          (action === 'wallet.open' && typeof params.vaultId === 'string' && vaultId !== params.vaultId)) throw walletChanged();
      }
      await resultReady?.(result, vaultId);
      return result;
    };
    // Read-only polls stay responsive during a queued/long native operation and
    // cannot change wallet identity. Every lifecycle/mutation and idle close uses
    // the same queue, with the identity checked at DEQUEUE, never just arrival.
    // tx.resolve MUST reach the service immediately: its arrival-time relaying
    // guard rejects a clear submitted during broadcast. Queuing it here could
    // defer it until an uncertain relay finishes and erase the recovery marker.
    return POLL_ACTIONS.has(action) || action === 'tx.resolve' ? execute() : this.exclusive(execute);
  }
}
