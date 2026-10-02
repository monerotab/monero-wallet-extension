import { MoneroBrowserWallet } from './adapter.js';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const started = performance.now();
let stage = 'starting worker';
let engine;
let heartbeat = 0;
const heartbeatTimer = setInterval(() => heartbeat++, 10);
const progress = [];
const step = name => {
  stage = name;
  progress.push(name);
  document.querySelector('#status').textContent = progress.join('\n');
};
window.proofResult = { status: 'running' };
(async () => {
  const password = crypto.randomUUID() + crypto.randomUUID();
  engine = new MoneroBrowserWallet();
  step('createWalletFull');
  await engine.createWalletFull({ password, networkType: 2, language: 'English' });
  const initialHeights = { restoreHeight: await engine.call('getRestoreHeight'), walletHeight: await engine.call('getHeight') };
  step('getPrimaryAddress');
  const address = await engine.getPrimaryAddress();
  check(typeof address === 'string' && address.length === 95, 'Not a full real Monero address');
  step('getSeed');
  let seed = await engine.getSeed();
  check(seed.split(' ').length === 25, 'Not a 25-word Monero seed');
  step('getBalance');
  check(await engine.getBalance() === '0', 'Disposable wallet unexpectedly funded');
  step('createAccount');
  const account = await engine.createAccount('Offline proof account');
  check(account.index === 1, 'Account index incorrect');
  step('createSubaddress');
  const subaddress = await engine.createSubaddress(0, 'Offline proof subaddress');
  check(subaddress.index === 1 && subaddress.address.length === 95 && subaddress.address !== address, 'Subaddress derivation failed');
  step('exportWalletData');
  let data = await engine.exportWalletData();
  check(data.keysData.byteLength > 100 && data.cacheData.byteLength > 100, 'Encrypted Monero wallet export missing');
  const exportedBytes = { keys: data.keysData.byteLength, cache: data.cacheData.byteLength };
  step('close and terminate original worker');
  await engine.close();
  engine.terminate();
  engine = new MoneroBrowserWallet();
  step('reject wrong password in new worker');
  let rejected = false;
  try { await engine.openWallet({ password: 'incorrect-test-password', networkType: 2, ...data }); } catch { rejected = true; }
  check(rejected, 'Wrong wallet password unexpectedly accepted');
  step('openWallet from exported data in new worker');
  await engine.openWallet({ password, networkType: 2, ...data });
  check(await engine.getPrimaryAddress() === address, 'Reopened primary address mismatch');
  check(await engine.getSeed() === seed, 'Reopened seed mismatch');
  check(await engine.getBalance() === '0', 'Reopened balance mismatch');
  const accounts = await engine.getAccounts();
  const subaddresses = await engine.getSubaddresses(0);
  check(accounts.length === 2 && subaddresses.length === 2 && subaddresses[1].address === subaddress.address, 'Wallet cache did not preserve accounts/subaddresses');
  step('restore wallet from seed in third worker');
  await engine.close();
  engine.terminate();
  engine = new MoneroBrowserWallet();
  await engine.createWalletFull({ password, networkType: 2, seed, restoreHeight: 0 });
  check(await engine.getPrimaryAddress() === address, 'Restored primary address mismatch');
  check(await engine.getSeed() === seed, 'Restored seed mismatch');
  check(await engine.getBalance() === '0', 'Restored balance mismatch');
  const restoredHeights = { restoreHeight: await engine.call('getRestoreHeight'), walletHeight: await engine.call('getHeight') };
  seed = '';
  data.keysData.fill(0);
  data.cacheData.fill(0);
  data = undefined;
  await engine.close();
  engine.terminate();
  step('PASS');
  clearInterval(heartbeatTimer);
  window.proofResult = {
    status: 'passed', steps: progress, durationMs: Math.round(performance.now() - started),
    extensionOrigin: location.origin, crossOriginIsolated, sharedArrayBufferAvailable: typeof SharedArrayBuffer !== 'undefined',
    heartbeat, exportedBytes, initialHeights, restoredHeights, seedWords: 25, addressLength: 95,
    balances: 'zero, real WASM', workersUsed: 3, keysOrSeedLogged: false,
  };
  document.querySelector('#status').textContent = JSON.stringify(window.proofResult, null, 2);
})().catch(error => {
  clearInterval(heartbeatTimer);
  engine?.terminate();
  // Never serialize seed/password/wallet bytes. Only library error class and stage are persisted.
  const cspError = /Content Security Policy|unsafe-eval|EvalError|Refused to evaluate/.test(error.message);
  window.proofResult = { status: 'failed', stage, errorName: error.name, cspError, detail: cspError ? 'Dynamic JavaScript blocked by MV3 CSP' : 'See debugger without logging wallet secrets', steps: progress };
  document.querySelector('#status').textContent = JSON.stringify(window.proofResult, null, 2);
});
