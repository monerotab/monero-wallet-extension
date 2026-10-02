import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const binary = process.env.MONEROD_BIN || '/tmp/monero-extension-engine-check/monero-x86_64-linux-gnu-v0.18.5.1/monerod';
const work = await mkdtemp(path.join(here, '.regtest-work-'));
const extension = path.join(here, 'dist-regtest');
const started = Date.now();
let stage = 'startup';
let daemon;
let context;
let daemonOutput = '';
let cleaned = false;
const report = { test: 'Private isolated regtest, zero public funds', status: 'running', stages: [], publicNetworkRequests: 0 };
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await context?.close().catch(() => {});
  if (daemon && daemon.exitCode === null) {
    const stopped = once(daemon, 'exit');
    daemon.kill('SIGTERM');
    const timer = setTimeout(() => daemon.kill('SIGKILL'), 5000);
    await stopped.catch(() => {});
    clearTimeout(timer);
  }
  await rm(work, { recursive: true, force: true });
}
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, async () => {
  report.status = 'aborted'; report.stage = stage;
  await cleanup(); report.cleanedUp = true;
  await writeFile(path.join(here,'regtest-results.json'), JSON.stringify(report,null,2));
  process.exit(130);
});
const totalDeadline = setTimeout(async () => { report.status = 'timeout'; report.stage = stage; await cleanup(); await writeFile(path.join(here,'regtest-results.json'), JSON.stringify(report,null,2)); process.exit(1); }, 240000);
const next = value => { stage = value; report.stages.push(value); console.log('REGTEST:', value); };
async function freePort() {
  const server = createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const port = server.address().port; await new Promise(resolve=>server.close(resolve)); return port;
}
try {
  const port = await freePort();
  const p2pPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  await writeFile(path.join(work,'empty.conf'), '');
  daemon = spawn(binary, ['--regtest','--fixed-difficulty','1','--offline','--no-zmq','--no-igd','--hide-my-port',
    '--disable-dns-checkpoints','--check-updates','disabled','--max-concurrency','2','--non-interactive',
    '--config-file',path.join(work,'empty.conf'),'--data-dir',path.join(work,'chain'),'--log-file',path.join(work,'daemon.log'),'--log-level','0',
    '--p2p-bind-ip','127.0.0.1','--p2p-bind-port',String(p2pPort),'--rpc-bind-ip','127.0.0.1','--rpc-bind-port',String(port),'--rpc-ssl','disabled'], {stdio:['ignore','pipe','pipe']});
  daemon.stdout.on('data',buffer=>{daemonOutput=(daemonOutput+buffer).slice(-12000);});
  daemon.stderr.on('data',buffer=>{daemonOutput=(daemonOutput+buffer).slice(-12000);});
  let daemonLaunchError;
  daemon.once('error', error => { daemonLaunchError = error; });
  const rpc = async (method,params={}) => {
    const isPath = method === 'get_transaction_pool';
    const response = await fetch(origin+(isPath ? '/get_transaction_pool' : '/json_rpc'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(isPath ? params : {jsonrpc:'2.0',id:'private-regtest',method,params}),signal:AbortSignal.timeout(60000)});
    const json = await response.json(); if(json.error) throw new Error(`${method}: ${json.error.message}`);
    const result = isPath ? json : json.result;
    if(result?.status && result.status !== 'OK') throw new Error(`${method}: daemon status ${result.status}`);
    return result;
  };
  let info;
  for(let attempt=0;attempt<120;attempt++) {
    if (daemonLaunchError) throw daemonLaunchError;
    if(daemon.exitCode!==null) throw new Error('Isolated monerod exited during startup: '+daemonOutput.slice(-500));
    try { info=await rpc('get_info'); break; } catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(info,'Regtest daemon never became ready');
  assert.equal(info.height,1,'Must start from a brand new private chain');
  assert.equal(info.nettype,'fakechain','Refuse to mine or transfer outside private regtest');
  assert.equal(info.offline,true,'Regtest daemon must not connect to peers');
  report.daemon = { version:info.version, nettype:info.nettype, initialHeight:info.height, offline:info.offline, difficulty:info.difficulty, host:'127.0.0.1' };
  next('private daemon ready');
  const vendor = await readFile(path.join(here,'dist/monero.worker.js'),'utf8');
  const shim = `
// TEST ONLY: permit solely this isolated fakechain daemon. Never ship in production.
self.regtestConfigure = async function () {
  self.regtestPaths = [];
  self.HttpClient.request = async function(options) {
    const url = new URL(options.uri);
    if (url.origin !== ${JSON.stringify(origin)}) throw new Error('External networking forbidden in regtest');
    if (options.username || options.password || options.proxyUri) throw new Error('Credentials forbidden in regtest');
    self.regtestPaths.push(url.pathname);
    const binary = options.body instanceof Uint8Array;
    const response = await fetch(url,{method:options.method||'POST',headers:{'content-type':binary?'application/octet-stream':'application/json'},body:options.body,
      credentials:'omit',redirect:'error',signal:AbortSignal.timeout(30000)});
    const body = binary ? new Uint8Array(await response.arrayBuffer()) : await response.text();
    return {statusCode:response.status,statusText:response.statusText,headers:Object.fromEntries(response.headers),body};
  };
};
self.regtestSummary = async function(){return {paths:[...new Set(self.regtestPaths)]};};
`;
  await mkdir(extension,{recursive:true});
  await writeFile(path.join(extension,'monero.worker.js'),vendor+shim);
  await copyFile(path.join(here,'adapter.js'),path.join(extension,'adapter.js'));
  await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'PRIVATE FAKECHAIN Monero WASM proof',version:'0.0.1',background:{service_worker:'background.js'},host_permissions:['http://127.0.0.1/*'],content_security_policy:{extension_pages:`script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; worker-src 'self'; connect-src ${origin};`}},null,2));
  await writeFile(path.join(extension,'background.js'),'chrome.runtime.onInstalled.addListener(()=>{});');
  await writeFile(path.join(extension,'index.html'),'<!doctype html><html><body>Isolated private regtest<script type="module" src="page.js"></script></body></html>');
  await writeFile(path.join(extension,'page.js'),"import {MoneroBrowserWallet} from './adapter.js'; window.sender=new MoneroBrowserWallet(); window.recipient=new MoneroBrowserWallet(); window.ready=true;");
  context = await chromium.launchPersistentContext(path.join(work,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-sandbox','--disable-background-networking']});
  await context.route(/^https?:\/\//,route=> {
    if(new URL(route.request().url()).origin!==origin) {report.publicNetworkRequests++; return route.abort();}
    return route.continue();
  });
  const service=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const page=await context.newPage();
  await page.goto(`chrome-extension://${new URL(service.url()).host}/index.html`);
  await page.waitForFunction(()=>window.ready);
  const addresses=await page.evaluate(async uri=> {
    const wallets=[window.sender,window.recipient]; const addresses=[];
    for(const wallet of wallets) {
      await wallet.call('regtestConfigure');
      await wallet.createWalletFull({networkType:0,regtest:true,password:crypto.randomUUID(),language:'English'});
      await wallet.call('setRestoreHeight',0);
      await wallet.call('setDaemonConnection',{uri,rejectUnauthorized:true},false);
      addresses.push(await wallet.getPrimaryAddress());
    }
    return addresses;
  },origin);
  assert.ok(addresses.every(address=>address.length===95));
  next('two real browser WASM regtest wallets created');
  const mined = await rpc('generateblocks',{wallet_address:addresses[0],amount_of_blocks:100});
  report.miningResponseFields=Object.keys(mined);
  report.minedBlocks=(await rpc('get_info')).height-1;
  assert.equal(report.minedBlocks,100,'generateblocks did not advance private chain by 100 blocks');
  next('100 private fakecoin blocks mined');
  report.sync = await page.evaluate(async()=> {
    await window.sender.call('sync',0,false);
    return {balance:await window.sender.getBalance(),unlockedBalance:await window.sender.call('getUnlockedBalance'),height:await window.sender.call('getHeight'),trusted:await window.sender.call('isDaemonTrusted')};
  });
  assert.ok(BigInt(report.sync.unlockedBalance)>1_000_000_000_000n,'Fakecoin mining reward did not unlock');
  assert.equal(report.sync.trusted,false);
  next('WASM synced actual binary blocks and recognized unlocked fakecoins');
  const beforePool=await rpc('get_transaction_pool');
  report.poolBefore=(beforePool.transactions||[]).length;
  report.prepared=await page.evaluate(async destination=> {
    const set=await window.sender.call('createTxs',{accountIndex:0,relay:false,canSplit:false,destinations:[{address:destination,amount:'1000000000000'}]});
    if(set.txs?.length!==1) throw new Error('Expected exactly one signed transaction');
    const tx=set.txs[0]; window.regtestTx=tx;
    return {hash:tx.hash,fee:String(tx.fee),relayed:tx.isRelayed,metadataPresent:typeof tx.metadata==='string'&&tx.metadata.length>0,fullHexPresent:typeof tx.fullHex==='string'&&tx.fullHex.length>0};
  },addresses[1]);
  assert.match(report.prepared.hash,/^[a-f0-9]{64}$/);
  assert.ok(BigInt(report.prepared.fee)>0n);
  assert.equal(report.prepared.metadataPresent,true);
  assert.equal(report.prepared.relayed,false);
  const afterPrepare=await rpc('get_transaction_pool');
  report.poolAfterPrepare=(afterPrepare.transactions||[]).length;
  assert.equal(report.poolAfterPrepare,report.poolBefore,'relay:false transaction was broadcast prematurely');
  next('genuine transaction signed with real fee and relay:false; pool unchanged');
  const hashes=await page.evaluate(()=>window.sender.call('relayTxs',[window.regtestTx.metadata]));
  assert.deepEqual(hashes,[report.prepared.hash]);
  report.relayedHash=hashes[0];
  const afterRelay=await rpc('get_transaction_pool');
  report.poolAfterRelay=(afterRelay.transactions||[]).length;
  assert.ok((afterRelay.transactions||[]).some(tx=>tx.id_hash===report.relayedHash),'Signed transaction not accepted by actual daemon');
  next('actual signed transaction accepted in private daemon mempool');
  await rpc('generateblocks',{wallet_address:addresses[0],amount_of_blocks:12});
  report.recipient = await page.evaluate(async()=> {
    await window.recipient.call('sync',0,false);
    const history=await window.recipient.call('getTxs',{txs:[{}]});
    const txs=history.blocks.flatMap(block=>block.txs||[]);
    const incoming=txs.find(tx=>tx.hash===window.regtestTx.hash);
    return {balance:await window.recipient.getBalance(),unlockedBalance:await window.recipient.call('getUnlockedBalance'),height:await window.recipient.call('getHeight'),confirmed:incoming?.isConfirmed,confirmations:incoming?.numConfirmations,hash:incoming?.hash};
  });
  assert.equal(report.recipient.balance,'1000000000000');
  assert.equal(report.recipient.unlockedBalance,'1000000000000');
  assert.equal(report.recipient.confirmed,true);
  assert.equal(report.recipient.hash,report.prepared.hash);
  assert.ok(report.recipient.confirmations>=10);
  next('recipient confirmed and unlocked exact 1 fake XMR');
  report.http=await page.evaluate(async()=>({sender:await window.sender.call('regtestSummary'),recipient:await window.recipient.call('regtestSummary')}));
  await page.evaluate(async()=> {for(const wallet of [window.sender,window.recipient]){await wallet.close();wallet.terminate();}delete window.regtestTx;});
  assert.equal(report.publicNetworkRequests,0);
  report.status='passed';
} catch(error) {
  report.status='failed'; report.stage=stage; report.error={name:error.name,message:error.message.slice(0,500)};
  console.error('REGTEST FAILED:',stage,error.name,error.message.slice(0,300));
  process.exitCode=1;
} finally {
  clearTimeout(totalDeadline);
  await cleanup();
  report.cleanedUp=true; report.durationMs=Date.now()-started;
  await writeFile(path.join(here,'regtest-results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
