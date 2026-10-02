import { chromium } from '@playwright/test';
import { buildMonero } from '../../scripts/build-monero.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const binary = process.env.MONEROD_BIN || '/tmp/monero-extension-engine-check/monero-x86_64-linux-gnu-v0.18.5.1/monerod';
const work = await mkdtemp(path.join(here, '.production-regtest-work-'));
const extension = path.join(here, 'dist-production-regtest');
const reportPath = path.join(here, 'production-regtest-results.json');
const started = Date.now();
let stage = 'startup';
let daemon;
let context;
let daemonOutput = '';
let cleaned = false;
const report = { test: 'Production worker hooks on isolated private fakechain', status: 'running', stages: [], publicNetworkRequests: 0 };
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
  await writeFile(reportPath, JSON.stringify(report,null,2));
  process.exit(130);
});
const totalDeadline = setTimeout(async () => { report.status = 'timeout'; report.stage = stage; await cleanup(); report.cleanedUp = true; await writeFile(reportPath, JSON.stringify(report,null,2)); process.exit(1); }, 360000);
const next = value => { stage = value; report.stages.push(value); console.log('PRODUCTION REGTEST:', value); };
async function freePort() {
  const server = createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const port = server.address().port; await new Promise(resolve=>server.close(resolve)); return port;
}
try {
  await buildMonero(extension); // Own experiment directory only, never production dist/public.
  const productionWorker = await readFile(path.join(extension,'monero.worker.js'),'utf8');
  report.productionWorkerSha256 = createHash('sha256').update(productionWorker).digest('hex');
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
  report.daemon = {version:info.version,nettype:info.nettype,initialHeight:info.height,offline:info.offline,difficulty:info.difficulty};
  next('isolated fakechain ready; actual production worker built');
  const shim = `
// TEST ONLY. Production boundedFetch, network guards and all ext* methods remain
// authoritative. Wrap HttpClient only to count attempts, never to bypass a denial.
// Wallet regtest mode is a test fixture. The fakechain is reached as a CUSTOM NODE
// through the production allowlist (no origin rewriting, no bundled-node shim).
const originalCreateWallet = self.createWalletFull;
self.createWalletFull = (id, config) => originalCreateWallet(id, {...config, regtest:true});
const actualFetch = globalThis.fetch.bind(globalThis);
let proofLoseNextRelay = false;
const proofStats = {paths:[], httpClientRequests:0, relayRequests:0, lostRelayResponses:0};
const productionHttpRequest = self.HttpClient.request;
self.HttpClient.request = async function(request) { proofStats.httpClientRequests++; return productionHttpRequest(request); };
globalThis.fetch = async function(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  // The private fakechain is a real custom node: production code fetches its actual origin.
  if (url.origin !== ${JSON.stringify(origin)}) throw new Error('Test fixture refuses any origin except the private fakechain');
  proofStats.paths.push(url.pathname);
  const relay = url.pathname === '/sendrawtransaction' || url.pathname === '/send_raw_transaction';
  if (relay) proofStats.relayRequests++;
  const response = await actualFetch(input, init);
  if (relay && proofLoseNextRelay) {
    proofLoseNextRelay = false;
    const body = await response.text();
    if (!response.ok || JSON.parse(body).status !== 'OK') throw new Error('Lost-response fixture requires actual accepted relay');
    proofStats.lostRelayResponses++;
    throw new TypeError('Test-only accepted relay response loss');
  }
  return response;
};
self.proofArmLostRelay = async function(){proofLoseNextRelay=true;};
self.proofNetworkStats = async function(){return {...proofStats, requestCount:proofStats.paths.length, paths:[...new Set(proofStats.paths)]};};
`;
  await writeFile(path.join(extension,'monero.worker.js'),productionWorker+shim);
  await copyFile(path.join(here,'adapter.js'),path.join(extension,'adapter.js'));
  await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'PRODUCTION HOOKS private fakechain proof',version:'0.0.1',background:{service_worker:'background.js'},host_permissions:[`${origin}/*`],optional_host_permissions:['http://*/*','https://*/*'],content_security_policy:{extension_pages:`script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; worker-src 'self'; connect-src 'self' http: https:;`}},null,2));
  await writeFile(path.join(extension,'background.js'),'chrome.runtime.onInstalled.addListener(()=>{});');
  await writeFile(path.join(extension,'index.html'),'<!doctype html><html><body>Production hooks private regtest<script type="module" src="page.js"></script></body></html>');
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
  // The service would pass the id + origin of the wallet's saved custom node (vault settings).
  report.customNode={id:'custom-0123456789abcdef',url:origin};
  await page.evaluate(node=>{window.customNode=node;},report.customNode);
  const created=await page.evaluate(async()=> {
    const addresses=[], freshOffline=[];
    window.fixturePasswords=new Map(); // Test-only memory; never returned or logged.
    for(const wallet of [window.sender,window.recipient]) {
      await wallet.call('extInit');
      const password=crypto.randomUUID(); window.fixturePasswords.set(wallet,password);
      await wallet.createWalletFull({networkType:0,password,language:'English'});
      await wallet.call('setRestoreHeight',0);
      await wallet.call('extNetwork',window.customNode.id,window.customNode.url);
      await wallet.call('extConfigureNode',window.customNode.id,window.customNode.url);
      await wallet.call('extNetwork',null);
      const before=await wallet.call('proofNetworkStats');
      const snapshot=await wallet.call('extSnapshot',0);
      const after=await wallet.call('proofNetworkStats');
      freshOffline.push({balance:snapshot.balance,transactions:snapshot.transactions.length,contacts:snapshot.contacts.length,historyError:snapshot.historyError,historyNotice:snapshot.historyNotice,
        httpClientRequests:after.httpClientRequests-before.httpClientRequests,networkRequests:after.requestCount-before.requestCount});
      addresses.push(await wallet.getPrimaryAddress());
    }
    return {addresses,freshOffline};
  });
  const addresses=created.addresses; report.freshOffline=created.freshOffline;
  assert.ok(addresses.every(address=>address.length===95));
  for(const snapshot of report.freshOffline) {
    assert.equal(snapshot.balance,'0'); assert.equal(snapshot.transactions,0); assert.equal(snapshot.contacts,0); assert.equal(snapshot.historyError,undefined);
    assert.equal(snapshot.httpClientRequests,0); assert.equal(snapshot.networkRequests,0);
    assert.match(snapshot.historyNotice,/Pending outgoing payments are read from the local cache/);
  }
  next('fresh native wallets expose genuine empty history with network gate off and zero RPC attempts');
  await rpc('generateblocks',{wallet_address:addresses[0],amount_of_blocks:100});
  assert.equal((await rpc('get_info')).height,101);
  report.senderSnapshot=await page.evaluate(async()=> {
    await window.sender.call('extNetwork',window.customNode.id,window.customNode.url);
    await window.sender.call('sync',0,false);
    await window.sender.call('extNetwork',null);
    const before=await window.sender.call('proofNetworkStats');
    const snapshot=await window.sender.call('extSnapshot',0);
    const after=await window.sender.call('proofNetworkStats');
    return {balance:snapshot.balance,unlockedBalance:snapshot.unlockedBalance,height:snapshot.height,synced:snapshot.synced,network:snapshot.network,
      accounts:snapshot.accounts.length,addresses:snapshot.addresses.length,transactions:snapshot.transactions.length,historyError:snapshot.historyError,
      httpClientRequests:after.httpClientRequests-before.httpClientRequests,networkRequests:after.requestCount-before.requestCount,
      allHistoryAmountsAreAtomicStrings:snapshot.transactions.every(tx=>typeof tx.amount==='string'&&/^[0-9]+$/.test(tx.amount))};
  });
  assert.ok(BigInt(report.senderSnapshot.unlockedBalance)>1_000_000_000_000n);
  assert.equal(report.senderSnapshot.synced,true);
  assert.equal(report.senderSnapshot.network,'mainnet');
  assert.ok(report.senderSnapshot.transactions>=100);
  assert.equal(report.senderSnapshot.historyError,undefined);
  assert.equal(report.senderSnapshot.httpClientRequests,0); assert.equal(report.senderSnapshot.networkRequests,0);
  assert.equal(report.senderSnapshot.allHistoryAmountsAreAtomicStrings,true);
  next('production extSnapshot exposes actual balances and mined transaction history');
  report.customNodeBoundary=await page.evaluate(async()=> {
    const codeOf=async run=>{try{await run();return 'OK';}catch(error){return error.code||'NO_CODE';}};
    const s=window.sender,node=window.customNode,sameHostOtherPort=node.url.replace(/:(\d+)$/,(_m,port)=>':'+(Number(port)+1));
    const before=await s.call('proofNetworkStats');
    const codes={
      // A custom id must carry its exact validated origin; a bundled id can never be redirected.
      missingUrl:await codeOf(()=>s.call('extNetwork',node.id)),
      pathUrl:await codeOf(()=>s.call('extNetwork',node.id,node.url+'/json_rpc')),
      credentialUrl:await codeOf(()=>s.call('extNetwork',node.id,node.url.replace('http://','http://user:pw@'))),
      redirectedBundled:await codeOf(()=>s.call('extNetwork','hashvault-mainnet',node.url)),
      unknownId:await codeOf(()=>s.call('extConfigureNode','custom-ffffffffffffffff')),
    };
    // A permitted custom node admits exactly its own origin: another port on the same host is refused.
    await s.call('extNetwork',node.id,sameHostOtherPort);
    await s.call('extConfigureNode',node.id,node.url);
    codes.otherOrigin=await codeOf(()=>s.call('sync',0,false));
    await s.call('extNetwork',null);
    const trusted=await s.call('isDaemonTrusted');
    const after=await s.call('proofNetworkStats');
    // Recovery through the permitted custom node restores a fully synced wallet for the next stages.
    await s.call('extNetwork',node.id,node.url);
    await s.call('extConfigureNode',node.id,node.url);
    await s.call('sync',0,false);
    const resynced=await s.call('isSynced');
    await s.call('extNetwork',null);
    return {codes,trusted,requests:after.requestCount-before.requestCount,resynced};
  });
  for(const key of ['missingUrl','pathUrl','credentialUrl','redirectedBundled','unknownId']) assert.equal(report.customNodeBoundary.codes[key],'INVALID_NODE',key);
  assert.notEqual(report.customNodeBoundary.codes.otherOrigin,'OK','A different origin than the permitted custom node must never sync');
  assert.equal(report.customNodeBoundary.trusted,false,'A loopback custom node is still configured untrusted');
  assert.equal(report.customNodeBoundary.requests,0,'Refused origins never reached fetch');
  assert.equal(report.customNodeBoundary.resynced,true,'The permitted custom node syncs again after a refused origin');
  next('custom node allowlist: exact origin only, bundled ids never redirected, loopback node stays untrusted');
  const poolBefore=(await rpc('get_transaction_pool')).transactions||[];
  assert.equal(poolBefore.length,0);
  report.prepared=await page.evaluate(async address=> {
    await window.sender.call('extNetwork',window.customNode.id,window.customNode.url);
    const draft=await window.sender.call('extPrepare',{accountIndex:0,address,amount:'1000000000000',priority:0});
    await window.sender.call('extNetwork',null);
    window.firstDraft=draft;
    return {hash:draft.txHash,amount:draft.amount,fee:draft.fee,expiresInMs:draft.expiresAt-Date.now(),metadataExposed:'metadata'in draft||'fullHex'in draft};
  },addresses[1]);
  assert.equal(report.prepared.amount,'1000000000000');
  assert.ok(BigInt(report.prepared.fee)>0n);
  assert.equal(report.prepared.metadataExposed,false);
  assert.ok(report.prepared.expiresInMs>0&&report.prepared.expiresInMs<=300000);
  assert.equal(((await rpc('get_transaction_pool')).transactions||[]).length,0);
  next('production extPrepare signed exact amount and hid metadata without relay');
  report.confirm=await page.evaluate(async()=> {
    await window.sender.call('extNetwork',window.customNode.id,window.customNode.url);
    const result=await window.sender.call('extConfirm',window.firstDraft.draftId);
    await window.sender.call('extNetwork',null);
    let repeatedCode;
    try {await window.sender.call('extConfirm',window.firstDraft.draftId);} catch(error){repeatedCode=error.code;}
    return {...result,repeatedCode,network:await window.sender.call('proofNetworkStats')};
  });
  assert.equal(report.confirm.txHash,report.prepared.hash);
  assert.equal(report.confirm.repeatedCode,'DRAFT_NOT_FOUND');
  assert.equal(report.confirm.network.relayRequests,1);
  assert.ok(((await rpc('get_transaction_pool')).transactions||[]).some(tx=>tx.id_hash===report.prepared.hash));
  next('production extConfirm relayed once and duplicate confirmation was rejected');
  report.pendingOffline=await page.evaluate(async()=> {
    const before=await window.sender.call('proofNetworkStats');
    const snapshot=await window.sender.call('extSnapshot',0);
    const after=await window.sender.call('proofNetworkStats');
    const matching=snapshot.transactions.filter(tx=>tx.txid===window.firstDraft.txHash);
    const tx=matching[0];
    return {historyError:snapshot.historyError,matches:matching.length,first:snapshot.transactions[0]?.txid,
      transaction:tx?{txid:tx.txid,type:tx.type,amount:tx.amount,fee:tx.fee,confirmations:tx.confirmations,destinations:tx.destinations,subaddressIndices:tx.subaddressIndices,locked:tx.locked}:null,
      httpClientRequests:after.httpClientRequests-before.httpClientRequests,networkRequests:after.requestCount-before.requestCount};
  });
  assert.equal(report.pendingOffline.historyError,undefined); assert.equal(report.pendingOffline.matches,1);
  assert.equal(report.pendingOffline.transaction.type,'pending'); assert.equal(report.pendingOffline.transaction.amount,'1000000000000');
  assert.equal(report.pendingOffline.transaction.fee,report.prepared.fee); assert.equal(report.pendingOffline.transaction.confirmations,0);
  assert.equal(report.pendingOffline.first,report.prepared.hash,'Unconfirmed payments sort before mined history');
  assert.deepEqual(report.pendingOffline.transaction.destinations,[{address:addresses[1],amount:'1000000000000'}]);
  assert.deepEqual(report.pendingOffline.transaction.subaddressIndices,[0]);
  assert.equal(report.pendingOffline.httpClientRequests,0); assert.equal(report.pendingOffline.networkRequests,0);
  next('unmined outgoing 1 fake XMR remains visible offline with exact fee and zero RPC attempts');
  await rpc('generateblocks',{wallet_address:addresses[0],amount_of_blocks:12});
  report.recipientFirst=await page.evaluate(async()=> {
    await window.recipient.call('extNetwork',window.customNode.id,window.customNode.url);
    await window.recipient.call('sync',0,false);
    await window.recipient.call('extNetwork',null);
    const before=await window.recipient.call('proofNetworkStats');
    const snapshot=await window.recipient.call('extSnapshot',0);
    const after=await window.recipient.call('proofNetworkStats');
    const tx=snapshot.transactions.find(tx=>tx.txid===window.firstDraft.txHash);
    return {balance:snapshot.balance,unlockedBalance:snapshot.unlockedBalance,height:snapshot.height,synced:snapshot.synced,
      httpClientRequests:after.httpClientRequests-before.httpClientRequests,networkRequests:after.requestCount-before.requestCount,
      historyError:snapshot.historyError,transaction:tx?{txid:tx.txid,type:tx.type,amount:tx.amount,fee:tx.fee,confirmations:tx.confirmations}:null};
  });
  assert.equal(report.recipientFirst.balance,'1000000000000');
  assert.equal(report.recipientFirst.unlockedBalance,'1000000000000');
  assert.equal(report.recipientFirst.transaction.type,'in');
  assert.equal(report.recipientFirst.transaction.amount,'1000000000000');
  assert.ok(report.recipientFirst.transaction.confirmations>=10);
  assert.equal(report.recipientFirst.historyError,undefined);
  assert.equal(report.recipientFirst.httpClientRequests,0); assert.equal(report.recipientFirst.networkRequests,0);
  next('production recipient snapshot confirms exact amount and incoming history offline with zero RPC attempts');
  report.uncertain=await page.evaluate(async address=> {
    await window.sender.call('extNetwork',window.customNode.id,window.customNode.url);
    await window.sender.call('sync',0,false);
    const draft=await window.sender.call('extPrepare',{accountIndex:0,address,amount:'500000000000',priority:0});
    window.secondDraft=draft;
    const before=await window.sender.call('proofNetworkStats');
    await window.sender.call('proofArmLostRelay');
    let code,repeatedCode;
    try {await window.sender.call('extConfirm',draft.draftId);} catch(error){code=error.code;}
    await window.sender.call('extNetwork',null);
    try {await window.sender.call('extConfirm',draft.draftId);} catch(error){repeatedCode=error.code;}
    const after=await window.sender.call('proofNetworkStats');
    return {hash:draft.txHash,amount:draft.amount,fee:draft.fee,code,repeatedCode,relayAttempts:after.relayRequests-before.relayRequests,lostResponses:after.lostRelayResponses};
  },addresses[1]);
  assert.equal(report.uncertain.code,'RELAY_UNCERTAIN');
  assert.equal(report.uncertain.repeatedCode,'DRAFT_NOT_FOUND');
  assert.equal(report.uncertain.relayAttempts,1,'Native or wrapper relay was retried after acceptance');
  assert.equal(report.uncertain.lostResponses,1);
  assert.ok(((await rpc('get_transaction_pool')).transactions||[]).some(tx=>tx.id_hash===report.uncertain.hash));
  next('accepted relay response lost: RELAY_UNCERTAIN, one attempt, consumed draft');
  await rpc('generateblocks',{wallet_address:addresses[0],amount_of_blocks:12});
  report.recipientFinal=await page.evaluate(async()=> {
    await window.recipient.call('extNetwork',window.customNode.id,window.customNode.url);
    await window.recipient.call('sync',0,false);
    await window.recipient.call('extNetwork',null);
    const before=await window.recipient.call('proofNetworkStats');
    const snapshot=await window.recipient.call('extSnapshot',0);
    const after=await window.recipient.call('proofNetworkStats');
    return {balance:snapshot.balance,unlockedBalance:snapshot.unlockedBalance,height:snapshot.height,historyError:snapshot.historyError,
      httpClientRequests:after.httpClientRequests-before.httpClientRequests,networkRequests:after.requestCount-before.requestCount,
      transactions:snapshot.transactions.map(tx=>({txid:tx.txid,type:tx.type,amount:tx.amount,confirmations:tx.confirmations}))};
  });
  assert.equal(report.recipientFinal.balance,'1500000000000');
  assert.equal(report.recipientFinal.unlockedBalance,'1500000000000');
  const uncertainTx=report.recipientFinal.transactions.find(tx=>tx.txid===report.uncertain.hash);
  assert.equal(uncertainTx.amount,'500000000000');
  assert.equal(uncertainTx.type,'in');
  assert.ok(uncertainTx.confirmations>=10);
  assert.equal(report.recipientFinal.historyError,undefined);
  assert.equal(report.recipientFinal.httpClientRequests,0); assert.equal(report.recipientFinal.networkRequests,0);
  next('uncertain transaction really confirmed; recipient snapshot exact 1.5 fake XMR offline');
  report.tools=await page.evaluate(async({senderPrimary,recipientPrimary})=> {
    const codeOf=async run=>{try{await run();return 'OK';}catch(error){return error.code||'NO_CODE';}};
    const r=window.recipient,s=window.sender,message='Regtest message \u2713 exact bytes\n';
    const before=[await r.call('proofNetworkStats'),await s.call('proofNetworkStats')];
    const senderSub=await s.call('createSubaddress',0,'Max inbox');
    const recipientSub=await r.call('createSubaddress',0,'Signing address');
    const integrated=(await s.call('getIntegratedAddress','','0123456789abcdef')).integratedAddress;
    await r.call('extAddressLabel',0,0,'Recipient main');
    const labelErrors={missingAddress:await codeOf(()=>r.call('extAddressLabel',0,99,'x')),missingAccount:await codeOf(()=>r.call('extAddressLabel',7,0,'x'))};
    const book=[];
    book.push(await r.call('extContactAdd',senderPrimary,'Sender'));
    book.push(await r.call('extContactAdd',senderSub.address,'Sender inbox'));
    const duplicate=await codeOf(()=>r.call('extContactAdd',senderPrimary,'again'));
    book.push(await r.call('extContactEdit',0,senderPrimary,senderPrimary,'Sender renamed'));
    const stale=await codeOf(()=>r.call('extContactEdit',0,recipientPrimary,senderPrimary,'stale'));
    const duplicateEdit=await codeOf(()=>r.call('extContactEdit',1,senderSub.address,senderPrimary,'dup'));
    book.push(await r.call('extContactEdit',0,senderPrimary,integrated,'Sender integrated'));
    const afterIntegrated=(await r.call('extSnapshot',0)).contacts;
    book.push(await r.call('extContactEdit',1,integrated,senderPrimary,'Sender standard'));
    const afterStandard=(await r.call('extSnapshot',0)).contacts;
    book.push(await r.call('extContactAdd',recipientPrimary,'Delete me'));
    const staleDelete=await codeOf(()=>r.call('extContactDelete',2,senderPrimary));
    const missingDelete=await codeOf(()=>r.call('extContactDelete',9,senderPrimary));
    book.push(await r.call('extContactDelete',2,recipientPrimary));
    const snapshot=await r.call('extSnapshot',0);
    const spend=await r.call('extSign',message,0,0,'spend');
    const view=await r.call('extSign',message,0,recipientSub.index,'view');
    const verify={
      spend:await s.call('extVerify',message,recipientPrimary,spend.signature),
      view:await s.call('extVerify',message,recipientSub.address,view.signature),
      tampered:await s.call('extVerify',message.trim(),recipientPrimary,spend.signature),
      wrongAddress:await s.call('extVerify',message,senderPrimary,spend.signature),
      wrongSubaddress:await s.call('extVerify',message,recipientPrimary,view.signature),
      malformed:await s.call('extVerify',message,recipientPrimary,'SigV2'+'1'.repeat(10)),
    };
    const signMissing=await codeOf(()=>r.call('extSign',message,0,99,'spend'));
    const after=[await r.call('proofNetworkStats'),await s.call('proofNetworkStats')];
    return {senderSub:{index:senderSub.index,address:senderSub.address},recipientSub:{index:recipientSub.index,address:recipientSub.address},integrated,
      labelErrors,book,duplicate,stale,duplicateEdit,afterIntegrated,afterStandard,staleDelete,missingDelete,contacts:snapshot.contacts,addresses:snapshot.addresses,
      transactions:snapshot.transactions.map(tx=>({txid:tx.txid,type:tx.type,height:tx.height,subaddressIndices:tx.subaddressIndices,destinations:tx.destinations,locked:tx.locked})),
      signatures:{spendAddress:spend.address,viewAddress:view.address,spendPrefix:spend.signature.slice(0,5),viewPrefix:view.signature.slice(0,5)},verify,signMissing,
      networkRequests:after[0].requestCount-before[0].requestCount+after[1].requestCount-before[1].requestCount,
      httpClientRequests:after[0].httpClientRequests-before[0].httpClientRequests+after[1].httpClientRequests-before[1].httpClientRequests};
  },{senderPrimary:addresses[0],recipientPrimary:addresses[1]});
  const tools=report.tools;
  assert.equal(tools.networkRequests,0); assert.equal(tools.httpClientRequests,0);
  assert.deepEqual(tools.labelErrors,{missingAddress:'INVALID_SUBADDRESS',missingAccount:'INVALID_ACCOUNT'});
  assert.deepEqual(tools.book,[{index:0},{index:1},{index:0},{index:1},{index:1},{index:2},{}]);
  assert.equal(tools.duplicate,'DUPLICATE_CONTACT'); assert.equal(tools.stale,'STALE_CONTACT'); assert.equal(tools.duplicateEdit,'DUPLICATE_CONTACT');
  assert.equal(tools.integrated.length,106);
  assert.deepEqual(tools.afterIntegrated,[{index:0,address:tools.senderSub.address,description:'Sender inbox'},{index:1,address:tools.integrated,description:'Sender integrated'}]);
  assert.deepEqual(tools.afterStandard,[{index:0,address:tools.senderSub.address,description:'Sender inbox'},{index:1,address:addresses[0],description:'Sender standard'}],
    'Switching an integrated contact back to standard must drop its payment ID');
  assert.equal(tools.staleDelete,'STALE_CONTACT'); assert.equal(tools.missingDelete,'STALE_CONTACT');
  assert.deepEqual(tools.contacts,tools.afterStandard);
  assert.deepEqual(tools.addresses.find(address=>address.index===0),{index:0,address:addresses[1],label:'Recipient main',used:true,
    balance:'1500000000000',unlockedBalance:'1500000000000',numUnspentOutputs:2});
  assert.deepEqual(tools.addresses.find(address=>address.index===tools.recipientSub.index),{index:tools.recipientSub.index,address:tools.recipientSub.address,
    label:'Signing address',used:false,balance:'0',unlockedBalance:'0',numUnspentOutputs:0});
  assert.equal(tools.transactions.length,2);
  for(const tx of tools.transactions) {
    assert.equal(tx.type,'in'); assert.equal(tx.locked,false); assert.deepEqual(tx.destinations,[]); assert.deepEqual(tx.subaddressIndices,[0]);
  }
  assert.ok(tools.transactions[0].height>=tools.transactions[1].height,'Mined history is newest first');
  assert.equal(tools.signatures.spendAddress,addresses[1]); assert.equal(tools.signatures.viewAddress,tools.recipientSub.address);
  assert.equal(tools.signatures.spendPrefix,'SigV2'); assert.equal(tools.signatures.viewPrefix,'SigV2');
  assert.deepEqual(tools.verify.spend,{good:true,old:false,signatureType:'spend',version:2});
  assert.deepEqual(tools.verify.view,{good:true,old:false,signatureType:'view',version:2});
  for(const key of ['tampered','wrongAddress','wrongSubaddress','malformed']) assert.deepEqual(tools.verify[key],{good:false,old:false,signatureType:null,version:null},key);
  assert.equal(tools.signMissing,'INVALID_SUBADDRESS');
  next('offline labels, per-address balances, address book edit/replace/delete and spend/view message signatures with zero RPC attempts');
  report.sendMax=await page.evaluate(async({destination})=> {
    const codeOf=async run=>{try{await run();return 'OK';}catch(error){return error.code||'NO_CODE';}};
    const r=window.recipient;
    await r.call('extNetwork',window.customNode.id,window.customNode.url);
    await r.call('sync',0,false);
    const unlocked=await r.call('getUnlockedBalance',0);
    const request=amount=>({accountIndex:0,address:destination,amount,priority:0,subtractFee:true});
    const tooMuch=await codeOf(()=>r.call('extPrepare',request((BigInt(unlocked)+1n).toString())));
    const tooSmall=await codeOf(()=>r.call('extPrepare',request('1')));
    const noFeeRoom=await codeOf(()=>r.call('extPrepare',{accountIndex:0,address:destination,amount:unlocked,priority:0}));
    const draft=await r.call('extPrepare',request(unlocked));
    window.maxDraft=draft;
    const beforeRelay=await r.call('proofNetworkStats');
    const result=await r.call('extConfirm',draft.draftId);
    const afterRelay=await r.call('proofNetworkStats');
    await r.call('extNetwork',null);
    const repeatedCode=await codeOf(()=>r.call('extConfirm',draft.draftId));
    const offlineBefore=await r.call('proofNetworkStats');
    const snapshot=await r.call('extSnapshot',0);
    const offlineAfter=await r.call('proofNetworkStats');
    const pending=snapshot.transactions.find(tx=>tx.txid===draft.txHash);
    return {unlocked,tooMuch,tooSmall,noFeeRoom,repeatedCode,result,relayRequests:afterRelay.relayRequests-beforeRelay.relayRequests,
      draft:{amount:draft.amount,fee:draft.fee,subtractFee:draft.subtractFee,address:draft.address,txHash:draft.txHash,metadataExposed:'metadata'in draft||'fullHex'in draft},
      first:snapshot.transactions[0]?.txid,balance:snapshot.balance,unlockedBalance:snapshot.unlockedBalance,
      pending:pending?{type:pending.type,amount:pending.amount,fee:pending.fee,destinations:pending.destinations,subaddressIndices:pending.subaddressIndices}:null,
      offlineRequests:offlineAfter.requestCount-offlineBefore.requestCount,offlineHttpClientRequests:offlineAfter.httpClientRequests-offlineBefore.httpClientRequests};
  },{destination:tools.senderSub.address});
  const max=report.sendMax;
  assert.ok(BigInt(max.unlocked)>=1_500_000_000_000n);
  assert.equal(max.tooMuch,'INSUFFICIENT_FUNDS'); assert.equal(max.tooSmall,'AMOUNT_TOO_SMALL'); assert.equal(max.noFeeRoom,'INSUFFICIENT_FUNDS');
  assert.equal(max.draft.subtractFee,true); assert.equal(max.draft.metadataExposed,false); assert.equal(max.draft.address,tools.senderSub.address);
  assert.ok(BigInt(max.draft.fee)>0n);
  assert.equal(BigInt(max.draft.amount)+BigInt(max.draft.fee),BigInt(max.unlocked),'Send max: recipient amount plus fee is exactly the requested balance');
  assert.equal(max.result.txHash,max.draft.txHash); assert.equal(max.relayRequests,1); assert.equal(max.repeatedCode,'DRAFT_NOT_FOUND');
  assert.ok(((await rpc('get_transaction_pool')).transactions||[]).some(tx=>tx.id_hash===max.draft.txHash));
  assert.equal(max.first,max.draft.txHash);
  assert.deepEqual(max.pending,{type:'pending',amount:max.draft.amount,fee:max.draft.fee,destinations:[{address:tools.senderSub.address,amount:max.draft.amount}],subaddressIndices:[0]});
  assert.equal(max.balance,'0'); assert.equal(max.unlockedBalance,'0');
  assert.equal(max.offlineRequests,0); assert.equal(max.offlineHttpClientRequests,0);
  next('send max: fee subtracted from the single destination, amount+fee exactly the unlocked balance, relayed once');
  await rpc('generateblocks',{wallet_address:addresses[0],amount_of_blocks:12});
  report.sendMaxFinal=await page.evaluate(async({inboxIndex})=> {
    const codeOf=async run=>{try{await run();return 'OK';}catch(error){return error.code||'NO_CODE';}};
    const r=window.recipient,s=window.sender,draft=window.maxDraft;
    for(const wallet of [r,s]) { await wallet.call('extNetwork',window.customNode.id,window.customNode.url); await wallet.call('sync',0,false); }
    const key=await r.call('extTxKey',draft.txHash);
    const check=await s.call('checkTxKey',draft.txHash,key.key,draft.address);
    for(const wallet of [r,s]) await wallet.call('extNetwork',null);
    const before=[await r.call('proofNetworkStats'),await s.call('proofNetworkStats')];
    const recipientSnapshot=await r.call('extSnapshot',0);
    const senderSnapshot=await s.call('extSnapshot',0);
    const incomingKey=await codeOf(()=>s.call('extTxKey',draft.txHash));
    const unknownKey=await codeOf(()=>r.call('extTxKey','f'.repeat(64)));
    const after=[await r.call('proofNetworkStats'),await s.call('proofNetworkStats')];
    const out=recipientSnapshot.transactions.find(tx=>tx.txid===draft.txHash);
    const incoming=senderSnapshot.transactions.find(tx=>tx.txid===draft.txHash);
    return {balance:recipientSnapshot.balance,unlockedBalance:recipientSnapshot.unlockedBalance,keyShape:/^(?:[a-f0-9]{64})+$/.test(key.key),
      check:{isGood:check.isGood,inTxPool:check.inTxPool,receivedAmount:String(check.receivedAmount)},incomingKey,unknownKey,
      out:out?{type:out.type,amount:out.amount,fee:out.fee,destinations:out.destinations,subaddressIndices:out.subaddressIndices}:null,
      incoming:incoming?{type:incoming.type,amount:incoming.amount,locked:incoming.locked,destinations:incoming.destinations,subaddressIndices:incoming.subaddressIndices}:null,
      inbox:senderSnapshot.addresses.find(address=>address.index===inboxIndex),
      networkRequests:after[0].requestCount-before[0].requestCount+after[1].requestCount-before[1].requestCount,
      httpClientRequests:after[0].httpClientRequests-before[0].httpClientRequests+after[1].httpClientRequests-before[1].httpClientRequests};
  },{inboxIndex:tools.senderSub.index});
  const maxFinal=report.sendMaxFinal;
  assert.equal(maxFinal.balance,'0'); assert.equal(maxFinal.unlockedBalance,'0');
  assert.deepEqual(maxFinal.out,{type:'out',amount:max.draft.amount,fee:max.draft.fee,destinations:[{address:tools.senderSub.address,amount:max.draft.amount}],subaddressIndices:[0]});
  assert.deepEqual(maxFinal.incoming,{type:'in',amount:max.draft.amount,locked:false,destinations:[],subaddressIndices:[tools.senderSub.index]});
  assert.deepEqual(maxFinal.inbox,{index:tools.senderSub.index,address:tools.senderSub.address,label:'Max inbox',used:true,
    balance:max.draft.amount,unlockedBalance:max.draft.amount,numUnspentOutputs:1});
  assert.equal(maxFinal.keyShape,true); assert.equal(maxFinal.check.isGood,true); assert.equal(maxFinal.check.receivedAmount,max.draft.amount);
  assert.equal(maxFinal.incomingKey,'TX_KEY_UNAVAILABLE'); assert.equal(maxFinal.unknownKey,'TX_KEY_UNAVAILABLE');
  assert.equal(maxFinal.networkRequests,0); assert.equal(maxFinal.httpClientRequests,0);
  next('send max confirmed: sender balance zero, receiving subaddress credited, tx key proves the payment');
  report.reopenedOffline=await page.evaluate(async()=> {
    const wallet=window.recipient;
    await wallet.call('setSubaddressLabel',0,0,'Offline recipient label');
    await wallet.call('setTxNotes',[window.firstDraft.txHash],['Offline cached confirmation']);
    const before=await wallet.call('proofNetworkStats');
    const data=await wallet.exportWalletData();
    try {
      await wallet.close();
      await wallet.openWallet({password:window.fixturePasswords.get(wallet),networkType:0,...data});
    } finally { data.keysData.fill(0); data.cacheData.fill(0); }
    const snapshot=await wallet.call('extSnapshot',0);
    const after=await wallet.call('proofNetworkStats');
    const tx=snapshot.transactions.find(tx=>tx.txid===window.firstDraft.txHash);
    return {balance:snapshot.balance,unlockedBalance:snapshot.unlockedBalance,historyError:snapshot.historyError,contacts:snapshot.contacts,
      subaddressLabels:snapshot.addresses.map(address=>address.label),
      label:snapshot.accounts.find(account=>account.index===0)?.label,
      transaction:tx?{type:tx.type,amount:tx.amount,note:tx.note}:null,
      httpClientRequests:after.httpClientRequests-before.httpClientRequests,networkRequests:after.requestCount-before.requestCount};
  });
  // The recipient sent its whole balance in the send-max stage above.
  assert.equal(report.reopenedOffline.balance,'0'); assert.equal(report.reopenedOffline.unlockedBalance,'0');
  assert.deepEqual(report.reopenedOffline.contacts,tools.contacts,'Address book persists in the native wallet cache');
  assert.deepEqual(report.reopenedOffline.subaddressLabels,['Offline recipient label','Signing address']);
  assert.equal(report.reopenedOffline.historyError,undefined); assert.equal(report.reopenedOffline.label,'Offline recipient label');
  assert.deepEqual(report.reopenedOffline.transaction,{type:'in',amount:'1000000000000',note:'Offline cached confirmation'});
  assert.equal(report.reopenedOffline.httpClientRequests,0); assert.equal(report.reopenedOffline.networkRequests,0);
  next('native wallet cache reopens offline with exact balances, confirmed history, labels, address book and note; zero RPC attempts');
  report.walletKeys=await page.evaluate(async()=> {
    const codeOf=async run=>{try{await run();return 'OK';}catch(error){return error.code||'NO_CODE';}};
    const s=window.sender;
    const before=await s.call('proofNetworkStats');
    const keys=await s.call('extKeys');
    // Compared inside the page: no private key is ever copied into the report.
    const native={publicViewKey:await s.call('getPublicViewKey'),privateViewKey:await s.call('getPrivateViewKey'),publicSpendKey:await s.call('getPublicSpendKey')};
    const spendKey=(await s.call('getPrivateSpendKey')).toLowerCase();
    const given=await s.call('extIntegrated','abcdef0123456789');
    const random=[await s.call('extIntegrated',null),await s.call('extIntegrated',null)];
    const decoded=[];
    for(const item of [given,...random]) { const value=await s.call('decodeIntegratedAddress',item.integratedAddress); decoded.push({standardAddress:value.standardAddress,paymentId:value.paymentId}); }
    const nativeIntegrated=(await s.call('getIntegratedAddress',keys.primaryAddress,'abcdef0123456789')).integratedAddress;
    const bad={zero:await codeOf(()=>s.call('extIntegrated','0000000000000000')),upper:await codeOf(()=>s.call('extIntegrated','ABCDEF0123456789')),
      short:await codeOf(()=>s.call('extIntegrated','abc')),long:await codeOf(()=>s.call('extIntegrated','a'.repeat(64)))};
    const after=await s.call('proofNetworkStats');
    return {keyNames:Object.keys(keys).sort(),primaryAddress:keys.primaryAddress,
      formats:['publicViewKey','privateViewKey','publicSpendKey'].every(name=>/^[a-f0-9]{64}$/.test(keys[name])),
      matchesNative:['publicViewKey','privateViewKey','publicSpendKey'].every(name=>keys[name]===native[name].toLowerCase()),
      containsSpendKey:JSON.stringify(keys).toLowerCase().includes(spendKey),
      given,random,decoded,nativeIntegrated,bad,
      networkRequests:after.requestCount-before.requestCount,httpClientRequests:after.httpClientRequests-before.httpClientRequests};
  });
  const walletKeys=report.walletKeys;
  assert.deepEqual(walletKeys.keyNames,['primaryAddress','privateViewKey','publicSpendKey','publicViewKey']);
  assert.equal(walletKeys.primaryAddress,addresses[0]); assert.equal(walletKeys.formats,true); assert.equal(walletKeys.matchesNative,true);
  assert.equal(walletKeys.containsSpendKey,false,'The private spend key never leaves the worker');
  assert.equal(walletKeys.given.paymentId,'abcdef0123456789'); assert.equal(walletKeys.given.integratedAddress,walletKeys.nativeIntegrated);
  assert.equal(walletKeys.given.integratedAddress.length,106);
  for(const item of walletKeys.random) { assert.match(item.paymentId,/^[a-f0-9]{16}$/); assert.notEqual(item.paymentId,'0000000000000000'); assert.equal(item.integratedAddress.length,106); }
  assert.notEqual(walletKeys.random[0].paymentId,walletKeys.random[1].paymentId);
  assert.deepEqual(walletKeys.decoded,[walletKeys.given,...walletKeys.random].map(item=>({standardAddress:addresses[0],paymentId:item.paymentId})));
  assert.deepEqual(walletKeys.bad,{zero:'INVALID_PARAMS',upper:'INVALID_PARAMS',short:'INVALID_PARAMS',long:'INVALID_PARAMS'});
  assert.equal(walletKeys.networkRequests,0); assert.equal(walletKeys.httpClientRequests,0);
  next('wallet keys exclude the private spend key; integrated addresses decode to the primary address and payment ID; zero RPC attempts');
  report.rescanPending=await page.evaluate(async({recipientPrimary})=> {
    const codeOf=async run=>{try{await run();return 'OK';}catch(error){return error.code||'NO_CODE';}};
    const s=window.sender,node=window.customNode;
    await s.call('extNetwork',node.id,node.url);
    try {
      await s.call('extConfigureNode',node.id,node.url);
      await s.call('sync',0,false);
      const draft=await s.call('extPrepare',{accountIndex:0,address:recipientPrimary,amount:'100000000000',priority:0});
      const sent=await s.call('extConfirm',draft.draftId);
      return {txHash:sent.txHash,draftHash:draft.txHash,check:await codeOf(()=>s.call('extRescanCheck')),rescan:await codeOf(()=>s.call('extRescan',0,1))};
    } finally { await s.call('extNetwork',null); }
  },{recipientPrimary:addresses[1]});
  assert.equal(report.rescanPending.txHash,report.rescanPending.draftHash);
  assert.equal(report.rescanPending.check,'PENDING_OUTGOING'); assert.equal(report.rescanPending.rescan,'PENDING_OUTGOING');
  assert.ok(((await rpc('get_transaction_pool')).transactions||[]).some(tx=>tx.id_hash===report.rescanPending.txHash));
  next('rescan refused by the real engine while an own payment is unconfirmed (PENDING_OUTGOING)');
  await rpc('generateblocks',{wallet_address:addresses[0],amount_of_blocks:2});
  const rescanTip=(await rpc('get_info')).height, partialFrom=rescanTip-3;
  report.rescan=await page.evaluate(async({tip,partialFrom,firstHash})=> {
    const codeOf=async run=>{try{await run();return 'OK';}catch(error){return error.code||'NO_CODE';}};
    const s=window.sender,node=window.customNode;
    const view=snapshot=>({balance:snapshot.balance,unlockedBalance:snapshot.unlockedBalance,height:snapshot.height,historyError:snapshot.historyError,
      transactions:snapshot.transactions.map(tx=>`${tx.txid}:${tx.type}:${tx.amount}`).sort(),minHeight:Math.min(...snapshot.transactions.map(tx=>tx.height)),
      outgoingDestinations:snapshot.transactions.filter(tx=>tx.type==='out').map(tx=>tx.destinations.length)});
    const progressOf=list=>({count:list.length,starts:[...new Set(list.map(item=>item[1]))],ends:[...new Set(list.map(item=>item[2]))],
      valid:list.every(([height,start,end,percent,message])=>height>=start&&height<=end&&percent>=0&&percent<=1&&message==='Rescanning')});
    const noGate=await codeOf(()=>s.call('extRescan',0,tip));
    const keyBefore=(await s.call('extTxKey',firstHash)).key;
    const progress=[]; const original=s.worker.onmessage;
    s.worker.onmessage=event=>{ if(Array.isArray(event.data)&&event.data[1]==='onSyncProgress_extension') progress.push(event.data.slice(2)); return original(event); };
    let before,check,partial,partialView,partialProgress,full,fullProgress;
    await s.call('extNetwork',node.id,node.url);
    try {
      await s.call('extConfigureNode',node.id,node.url);
      await s.call('sync',0,false);
      before=view(await s.call('extSnapshot',0));
      check=await codeOf(()=>s.call('extRescanCheck'));
      progress.length=0;
      partial=await s.call('extRescan',partialFrom,tip);
      partialView=view(await s.call('extSnapshot',0)); partialProgress=progressOf(progress);
      progress.length=0;
      full=await s.call('extRescan',0,tip);
      fullProgress=progressOf(progress);
    } finally { s.worker.onmessage=original; await s.call('extNetwork',null); }
    const after=view(await s.call('extSnapshot',0));
    const keyAfter=(await s.call('extTxKey',firstHash)).key;
    return {noGate,check,before,partial,partialView,partialProgress,full,fullProgress,after,sameTxKey:keyBefore===keyAfter,restoreHeight:await s.call('getRestoreHeight')};
  },{tip:rescanTip,partialFrom,firstHash:report.prepared.hash});
  const rescan=report.rescan;
  assert.equal(rescan.noGate,'NETWORK_DISABLED'); assert.equal(rescan.check,'OK');
  assert.ok(BigInt(rescan.before.balance)>0n); assert.equal(rescan.before.height,rescanTip);
  assert.deepEqual(rescan.partial,{restoreHeight:partialFrom});
  assert.ok(rescan.partialView.minHeight>=partialFrom,'A rescan from a height ignores earlier blocks');
  assert.ok(BigInt(rescan.partialView.balance)<BigInt(rescan.before.balance));
  assert.deepEqual(rescan.full,{restoreHeight:0}); assert.equal(rescan.restoreHeight,0);
  assert.equal(rescan.after.balance,rescan.before.balance); assert.equal(rescan.after.unlockedBalance,rescan.before.unlockedBalance);
  assert.equal(rescan.after.height,rescan.before.height); assert.deepEqual(rescan.after.transactions,rescan.before.transactions);
  assert.equal(rescan.after.historyError,undefined);
  assert.equal(rescan.after.outgoingDestinations.length,rescan.before.outgoingDestinations.length);
  assert.ok(rescan.before.outgoingDestinations.filter(count=>count>0).length>=2);
  assert.ok(rescan.after.outgoingDestinations.every(count=>count===0),'A soft rescan drops the recorded recipients of past payments');
  assert.equal(rescan.sameTxKey,true,'Sent-transaction keys survive a rescan');
  for(const [progress,from] of [[rescan.partialProgress,partialFrom],[rescan.fullProgress,0]]) {
    assert.ok(progress.count>=1,'The rescan reports progress'); assert.equal(progress.valid,true);
    assert.deepEqual(progress.starts,[from]); assert.deepEqual(progress.ends,[rescanTip]);
  }
  next('rescan: from a height scans only later blocks; from 0 rebuilds the identical balance and history, keeps tx keys, drops past recipients; progress reported');
  report.network=await page.evaluate(async()=>({sender:await window.sender.call('proofNetworkStats'),recipient:await window.recipient.call('proofNetworkStats')}));
  await page.evaluate(async()=>{for(const wallet of [window.sender,window.recipient]){await wallet.call('extNetwork',null);await wallet.close();wallet.terminate();}delete window.firstDraft;delete window.secondDraft;delete window.maxDraft;window.fixturePasswords.clear();delete window.fixturePasswords;});
  assert.equal(report.publicNetworkRequests,0);
  report.status='passed';
} catch(error) {
  report.status='failed';report.stage=stage;report.error={name:error.name,message:error.message.slice(0,700)};
  console.error('PRODUCTION REGTEST FAILED:',stage,error.name,error.message.slice(0,300));
  process.exitCode=1;
} finally {
  clearTimeout(totalDeadline);
  await cleanup();
  report.cleanedUp=true;report.durationMs=Date.now()-started;
  await writeFile(reportPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
