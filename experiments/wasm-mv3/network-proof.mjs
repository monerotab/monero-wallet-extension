import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = await readFile(path.join(here, 'dist/monero.worker.js'), 'utf8');
const reports = [];
const endpoint = process.argv[2] || 'https://xmr-node.cakewallet.com:18081';
if (!['https://xmr-node.cakewallet.com:18081', 'http://nodes.hashvault.pro:18081'].includes(endpoint)) throw new Error('Proof endpoint is not allowlisted');
const reportFile = endpoint.startsWith('http:') ? 'network-results-hashvault.json' : 'network-results.json';
const extension = path.join(here, 'dist-network');
await mkdir(extension, { recursive: true });
const shim = `
// TEST ONLY: a fixed public read-only endpoint; no wallet addresses/keys ever sent.
const proofOrigin = ${JSON.stringify(endpoint)};
self.probeBrowserNetwork = async function () {
  const start = performance.now();
  try {
    const response = await fetch(proofOrigin + '/json_rpc', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({jsonrpc:'2.0',id:'mv3-proof',method:'get_info',params:{}}),
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    const body = await response.json();
    return {reachable: response.ok, network: body.result?.nettype, height: body.result?.height, status: response.status,
      accessControlAllowOrigin: response.headers.get('access-control-allow-origin'), responseType: response.type,
      durationMs: Math.round(performance.now()-start), workerOrigin: self.location.origin};
  } catch (error) { return {reachable:false,errorName:error.name,durationMs:Math.round(performance.now()-start)}; }
};
// TEST ONLY: bounded native fetch override matching the adapter parent is implementing.
self.enableProofFetch = async function () {
  self.proofHttpPaths = [];
  self.HttpClient.request = async function(options) {
    const url = new URL(options.uri);
    if (url.origin !== proofOrigin || !['/json_rpc','/get_height','/get_info','/get_version'].includes(url.pathname)) throw new Error('Non-proof HTTP endpoint refused');
    if (options.username || options.password || options.proxyUri) throw new Error('Credentials forbidden');
    self.proofHttpPaths.push(url.pathname);
    const response = await fetch(url, {method: options.method || 'POST', headers:{'content-type':'application/json'}, body:options.body,
      credentials:'omit',redirect:'error',signal:AbortSignal.timeout(8000)});
    return {statusCode:response.status,statusText:response.statusText,headers:Object.fromEntries(response.headers),body:await response.text()};
  };
};
self.proofNetworkSummary = async function () {return {paths:self.proofHttpPaths,workerOrigin:self.location.origin};};
`;
await writeFile(path.join(extension, 'monero.worker.js'), vendor + shim);
await copyFile(path.join(here, 'adapter.js'), path.join(extension, 'adapter.js'));
await writeFile(path.join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
await writeFile(path.join(extension, 'index.html'), '<!doctype html><html><body>Read-only public daemon proof<script type="module" src="network.js"></script></body></html>');
await writeFile(path.join(extension, 'network.js'), `import {MoneroBrowserWallet} from './adapter.js';\nwindow.engine = new MoneroBrowserWallet();\nwindow.ready = true;`);
for (const permission of [false, true]) {
  const manifest = {manifest_version:3,name:'Monero worker HTTPS proof',version:'0.0.1',background:{service_worker:'background.js'},
    content_security_policy:{extension_pages:"script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; worker-src 'self'; connect-src " + endpoint + ";"},
    ...(permission ? {host_permissions:[new URL(endpoint).protocol + '//' + new URL(endpoint).hostname + '/*']} : {})};
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest,null,2));
  const profile = await mkdtemp(path.join(here,'.network-profile-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-sandbox','--disable-background-networking']});
    const service = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(service.url()).host}/index.html`);
    await page.waitForFunction(()=>window.ready);
    const direct = await page.evaluate(()=>window.engine.call('probeBrowserNetwork'));
    const report = {hostPermission:permission,direct};
    if (permission && direct.reachable) {
      report.nativeWallet = await page.evaluate(async uri => {
        const engine = window.engine;
        await engine.call('enableProofFetch');
        await engine.createWalletFull({networkType:0,password:crypto.randomUUID(),language:'English'});
        await engine.call('setDaemonConnection',{uri,rejectUnauthorized:true},false);
        const trusted = await engine.call('isDaemonTrusted');
        const height = await engine.call('getDaemonHeight');
        const summary = await engine.call('proofNetworkSummary');
        const balance = await engine.getBalance();
        await engine.close();
        engine.terminate();
        return {height,trusted,balance,...summary};
      },endpoint);
      assert.equal(report.nativeWallet.trusted,false);
      assert.equal(report.nativeWallet.balance,'0');
      assert.ok(report.nativeWallet.height>0);
    }
    reports.push(report);
    console.log(JSON.stringify(report,null,2));
  } finally {
    await context?.close();
    await rm(profile,{recursive:true,force:true});
    await writeFile(path.join(here,reportFile),JSON.stringify(reports,null,2));
  }
}
