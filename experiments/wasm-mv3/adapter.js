/** Native dedicated-worker transport for the bundled monero-ts 0.11.15 worker.
 * No library import/polyfills on the main thread; keys live in the worker.
 * The owner must persist exported data before terminating this worker.
 */
export class MoneroBrowserWallet {
  constructor(workerUrl = new URL('./monero.worker.js', location.href)) {
    this.worker = new Worker(workerUrl, { name: 'monero-wallet-wasm' });
    this.walletId = crypto.randomUUID();
    this.pending = new Map();
    this.tail = Promise.resolve();
    this.dead = false;
    this.worker.onmessage = ({ data }) => {
      const [walletId, callId, response] = data;
      const request = this.pending.get(callId);
      if (!request || walletId !== this.walletId) return;
      this.pending.delete(callId);
      clearTimeout(request.timer);
      if (response?.error) {
        let details;
        try { details = typeof response.error === 'string' ? JSON.parse(response.error) : response.error; } catch { details = { message: 'Wallet worker rejected request' }; }
        const error = new Error(details.message);
        error.name = details.name || 'WalletError';
        error.code = details.code;
        request.reject(error);
      } else request.resolve(response?.result);
    };
    this.worker.onerror = event => {
      this.fail(new Error(event.message || 'Wallet worker failed'));
    };
  }
  fail(error) {
    this.dead = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.worker.terminate();
  }
  call(method, ...args) {
    const run = () => {
      if (this.dead) throw new Error('Wallet worker terminated');
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => this.fail(new Error('Wallet worker timed out; state must be recovered before retrying')), 60000);
        this.pending.set(id, { resolve, reject, timer });
        this.worker.postMessage([this.walletId, method, id, ...args]);
      });
    };
    const result = this.tail.then(run);
    this.tail = result.catch(() => {});
    return result;
  }
  createWalletFull(config) {
    return this.call('createWalletFull', { ...config, path: '', proxyToWorker: false, isTrustedDaemon: false });
  }
  getPrimaryAddress() { return this.call('getAddress', 0, 0); }
  getSeed() { return this.call('getSeed'); }
  getBalance() { return this.call('getBalance'); }
  createAccount(label) { return this.call('createAccount', label); }
  createSubaddress(accountIndex, label) { return this.call('createSubaddress', accountIndex, label); }
  getAccounts() { return this.call('getAccounts', true); }
  getSubaddresses(accountIndex) { return this.call('getSubaddresses', accountIndex); }
  async exportWalletData() {
    const [keysData, cacheData] = await this.call('getData');
    return { keysData: new Uint8Array(keysData), cacheData: new Uint8Array(cacheData) };
  }
  openWallet({ password, networkType, keysData, cacheData }) {
    return this.call('openWalletData', '', password, networkType, keysData, cacheData, undefined);
  }
  close() { return this.call('close', false); }
  terminate() { this.fail(new Error('Wallet explicitly locked')); }
}
