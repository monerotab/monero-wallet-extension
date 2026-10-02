import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boundedFetch, checkNode } from './nodes.ts';

const TARGET = new URL('https://xmr-node.cakewallet.com:18081/json_rpc');
const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = async () => { throw new Error('External requests are forbidden in network unit tests'); }; });
afterEach(() => { globalThis.fetch = originalFetch; });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test('network boundary rejects unlisted hosts, ports, URL credentials and fragments before fetching', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Should not fetch'); };
  for (const url of ['http://127.0.0.1:18081/json_rpc', 'https://example.org/json_rpc',
    'https://xmr-node.cakewallet.com:18082/json_rpc', 'https://user:secret@xmr-node.cakewallet.com:18081/json_rpc',
    'https://xmr-node.cakewallet.com:18081/json_rpc#fragment', 'http://xmr-node.cakewallet.com:18081/json_rpc']) {
    await assert.rejects(boundedFetch(new URL(url)), { code: 'INVALID_NODE' });
  }
  assert.equal(calls, 0);
});

test('fetch forces cookie-free no-store no-referrer and redirect refusal despite init overrides', async () => {
  let seen: RequestInit | undefined;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), TARGET.href); seen = init;
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };
  const result = await boundedFetch(TARGET, { credentials: 'include', cache: 'force-cache', redirect: 'follow', referrerPolicy: 'unsafe-url' });
  assert.equal(seen!.credentials, 'omit'); assert.equal(seen!.cache, 'no-store');
  assert.equal(seen!.redirect, 'error'); assert.equal(seen!.referrerPolicy, 'no-referrer');
  assert.deepEqual([...result.bytes], [1, 2, 3]);
  assert.equal(seen!.signal!.aborted, true, 'Transport is always closed after the owned body is fully consumed');
});

test('non-success status aborts an unread response instead of clearing its timeout and leaking it', async () => {
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init!.signal!;
    return new Response(new ReadableStream<Uint8Array>(), { status: 503 });
  };
  await assert.rejects(boundedFetch(TARGET), { code: 'NODE_HTTP_ERROR' });
  assert.equal(signal!.aborted, true);
});

test('declared oversized body is rejected and aborted before any body read', async () => {
  let signal: AbortSignal | undefined; let reads = 0;
  globalThis.fetch = async (_url, init) => {
    signal = init!.signal!;
    const body = new ReadableStream<Uint8Array>({ pull() { reads++; } }, { highWaterMark: 0 });
    return new Response(body, { headers: { 'content-length': '999999999' } });
  };
  await assert.rejects(boundedFetch(TARGET, {}, 1024), { code: 'NODE_RESPONSE_TOO_LARGE' });
  assert.equal(reads, 0); assert.equal(signal!.aborted, true);
});

test('actual streamed byte limit cancels the reader and aborts even without content-length', async () => {
  let signal: AbortSignal | undefined; let cancelled = false;
  globalThis.fetch = async (_url, init) => {
    signal = init!.signal!;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(5)); },
      cancel() { cancelled = true; },
    }));
  };
  await assert.rejects(boundedFetch(TARGET, {}, 4), { code: 'NODE_RESPONSE_TOO_LARGE' });
  assert.equal(cancelled, true); assert.equal(signal!.aborted, true);
});

test('per-request timeout aborts once and never retries the request', async () => {
  let calls = 0; let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    calls++; signal = init!.signal!;
    return await new Promise<Response>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('Synthetic timeout with private upstream details')), { once: true });
    });
  };
  await assert.rejects(boundedFetch(TARGET, {}, 1024, 10), error => {
    assert.equal((error as { code: string }).code, 'NODE_TIMEOUT');
    assert.doesNotMatch((error as Error).message, /private upstream/); return true;
  });
  assert.equal(calls, 1); assert.equal(signal!.aborted, true);
});

test('wallet lock cancellation aborts an outstanding fetch without a retry', async () => {
  const started = deferred(); const controller = new AbortController(); let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('Synthetic cancellation')), { once: true });
      started.resolve();
    });
  };
  const rejected = assert.rejects(boundedFetch(TARGET, { signal: controller.signal }), { code: 'NODE_TIMEOUT' });
  await started.promise; controller.abort(); await rejected;
  assert.equal(calls, 1);
});

test('redirect or connection failure surfaces only a safe error and is never retried', async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => { calls++; assert.equal(init!.redirect, 'error'); throw new TypeError('secret upstream redirect target'); };
  await assert.rejects(boundedFetch(TARGET), error => {
    assert.equal((error as { code: string }).code, 'NODE_UNREACHABLE');
    assert.doesNotMatch((error as Error).message, /secret upstream/); return true;
  });
  assert.equal(calls, 1);
});

test('node checks send only public get_info data and never accept contradictory network claims as verified', async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(String(url), TARGET.href); assert.equal(init!.credentials, 'omit');
    assert.deepEqual(JSON.parse(init!.body as string), { jsonrpc: '2.0', id: 'extension-node-check', method: 'get_info', params: {} });
    assert.deepEqual(init!.headers, { 'Content-Type': 'application/json' });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'extension-node-check',
      result: { status: 'OK', nettype: 'mainnet', stagenet: true, height: 42, synchronized: true } }));
  };
  const result = await checkNode('cake-mainnet');
  assert.equal(result.reachable, true); assert.equal(result.network, 'unknown'); assert.equal(calls, 1);
});

test('invalid node response is reported as unreachable without reflecting response contents', async () => {
  globalThis.fetch = async () => new Response('private seed-like upstream message');
  const result = await checkNode('cake-mainnet');
  assert.equal(result.reachable, false); assert.equal(result.network, 'unknown');
  assert.doesNotMatch(result.error!, /private seed/);
});

test('custom node URLs accept only plain http(s) daemon roots and normalize them to the origin', async () => {
  const { customNodeOrigin } = await import('./nodes.ts');
  const good: [string, string][] = [
    ['http://127.0.0.1:18081', 'http://127.0.0.1:18081'], ['http://localhost:18081/', 'http://localhost:18081'],
    ['  HTTP://LocalHost:38081  ', 'http://localhost:38081'], ['https://node.example.org', 'https://node.example.org'],
    ['https://node.example.org:443/', 'https://node.example.org'], ['http://node.example.org:80', 'http://node.example.org'],
    ['http://[::1]:18081', 'http://[::1]:18081'], ['http://[0:0::1]:18081/', 'http://[::1]:18081'],
    ['https://[2001:db8::1]:18089', 'https://[2001:db8::1]:18089'], ['http://192.168.1.20:18089', 'http://192.168.1.20:18089'],
    ['http://my-node.lan:18081', 'http://my-node.lan:18081'], ['https://xmr.example.onion.example:18089', 'https://xmr.example.onion.example:18089'],
  ];
  for (const [input, origin] of good) assert.equal(customNodeOrigin(input), origin, input);
  const bad = ['', ' ', 'node.example.org:18081', '127.0.0.1:18081', 'ftp://node.example.org', 'ws://node.example.org:18081',
    'javascript:alert(1)', 'file:///etc/passwd', 'http://user:pass@node.example.org:18081', 'http://user@node.example.org',
    'http://node.example.org:18081/json_rpc', 'http://node.example.org/path/', 'http://node.example.org:18081/?a=1',
    'http://node.example.org:18081?', 'http://node.example.org#x', 'http://node.example.org:18081/#', 'http://node.example.org:0',
    'http://node .example.org', 'http://node.example.org\\x', 'http://exa_mple.org', 'http://-bad.example.org', 'http://a..b',
    'http://[fe80::1%25eth0]:18081', 'http://::1:18081', 'http://node.example.org:99999', `https://${'a'.repeat(200)}.org`,
    'http://*.example.org', 'http://node\u0000.example.org'];
  for (const input of bad) assert.throws(() => customNodeOrigin(input), { code: 'INVALID_NODE_URL' }, JSON.stringify(input));
});

test('custom nodes append without contacting the node; duplicates and the per-wallet cap are refused', async () => {
  const { appendCustomNode, MAX_CUSTOM_NODES, CUSTOM_NODE_ID } = await import('./nodes.ts');
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Adding must never contact the node'); };
  let list = appendCustomNode([], 'My node', 'http://127.0.0.1:18081/', 'stagenet');
  assert.equal(list.length, 1); assert.match(list[0].id, CUSTOM_NODE_ID);
  assert.deepEqual({ ...list[0], id: '' }, { id: '', name: 'My node', url: 'http://127.0.0.1:18081', network: 'stagenet', kind: 'custom', source: '' });
  // Same origin in another spelling, and bundled catalog origins, are duplicates.
  for (const url of ['http://127.0.0.1:18081', 'HTTP://127.0.0.1:18081/', 'https://xmr-node.cakewallet.com:18081', 'http://node.sethforprivacy.com:38089/'])
    assert.throws(() => appendCustomNode(list, 'Again', url, 'stagenet'), { code: url.includes('127.0.0.1') || !url.includes('xmr-node') && !url.includes('sethfor') ? 'DUPLICATE_NODE' : 'DUPLICATE_NODE' });
  // localhost is a different origin from 127.0.0.1 and may be added separately.
  list = appendCustomNode(list, 'Localhost', 'http://localhost:18081', 'stagenet');
  assert.equal(new Set(list.map(node => node.id)).size, 2);
  for (let port = 20000; list.length < MAX_CUSTOM_NODES; port++) list = appendCustomNode(list, `Node ${port}`, `http://10.0.0.1:${port}`, 'stagenet');
  assert.throws(() => appendCustomNode(list, 'One too many', 'http://10.0.0.2:18081', 'stagenet'), { code: 'CUSTOM_NODES_FULL' });
  assert.throws(() => appendCustomNode([], 'Bad', 'http://10.0.0.2:18081/json_rpc', 'stagenet'), { code: 'INVALID_NODE_URL' });
  assert.equal(calls, 0);
});

test('stored custom nodes are structurally re-validated; tampered or extra fields are ignored', async () => {
  const { validCustomNode } = await import('./nodes.ts');
  const node = { id: 'custom-0123456789abcdef', name: 'Home', url: 'http://127.0.0.1:18081', network: 'mainnet', kind: 'custom', source: '' };
  assert.equal(validCustomNode(node), true);
  for (const bad of [null, [], 'x', { ...node, id: 'cake-mainnet' }, { ...node, id: 'custom-XYZ' }, { ...node, kind: 'public' }, { ...node, source: 'x' },
    { ...node, name: '' }, { ...node, name: 'n'.repeat(41) }, { ...node, url: 'http://127.0.0.1:18081/' }, { ...node, url: 'http://u:p@127.0.0.1:18081' },
    { ...node, url: 'https://evil.example/json_rpc' }, { ...node, network: 'unknown' }, { ...node, extra: true }])
    assert.equal(validCustomNode(bad), false, JSON.stringify(bad));
});

test('allowlist admits exactly the chosen custom origin, never other ports, hosts, schemes or credentials', async () => {
  const { resolveNodeTarget } = await import('./nodes.ts');
  const seen: string[] = [];
  globalThis.fetch = async url => { seen.push(String(url)); return new Response(new Uint8Array([7]), { status: 200 }); };
  const allowed = ['http://127.0.0.1:18081'];
  assert.deepEqual([...(await boundedFetch(new URL('http://127.0.0.1:18081/get_blocks.bin'), {}, 1024, 1000, allowed)).bytes], [7]);
  for (const url of ['http://127.0.0.1:18082/json_rpc', 'https://127.0.0.1:18081/json_rpc', 'http://localhost:18081/json_rpc',
    'http://[::1]:18081/json_rpc', 'http://u:p@127.0.0.1:18081/json_rpc', 'http://127.0.0.1:18081/json_rpc#x', 'http://127.0.0.2:18081/json_rpc'])
    await assert.rejects(boundedFetch(new URL(url), {}, 1024, 1000, allowed), { code: 'INVALID_NODE' }, url);
  // Without the explicit allowance, the same custom origin is refused.
  await assert.rejects(boundedFetch(new URL('http://127.0.0.1:18081/json_rpc')), { code: 'INVALID_NODE' });
  assert.deepEqual(seen, ['http://127.0.0.1:18081/get_blocks.bin']);
  // Worker-side resolution re-validates the passed origin and never redirects a bundled id.
  assert.deepEqual(resolveNodeTarget('custom-0123456789abcdef', 'http://127.0.0.1:18081'), { url: 'http://127.0.0.1:18081', custom: true });
  assert.deepEqual(resolveNodeTarget('cake-mainnet'), { url: 'https://xmr-node.cakewallet.com:18081', custom: false });
  for (const [id, url] of [['custom-0123456789abcdef', undefined], ['custom-0123456789abcdef', 'http://127.0.0.1:18081/'],
    ['custom-0123456789abcdef', 'http://u:p@127.0.0.1:18081'], ['custom-0123456789abcdef', 'ftp://127.0.0.1'], ['cake-mainnet', 'http://127.0.0.1:18081'],
    ['custom-nothex', 'http://127.0.0.1:18081'], ['unknown-node', undefined]] as [string, string | undefined][])
    assert.throws(() => resolveNodeTarget(id, url), { code: 'INVALID_NODE' }, `${id} ${url}`);
});

test('custom node connection failures explain permission and monerod RPC flags without leaking details', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('Failed to fetch: secret CORS detail'); };
  await assert.rejects(boundedFetch(new URL('http://192.168.1.20:18089/json_rpc'), {}, 1024, 1000, ['http://192.168.1.20:18089']), error => {
    assert.equal((error as { code: string }).code, 'NODE_UNREACHABLE');
    assert.match((error as Error).message, /Allow access/); assert.match((error as Error).message, /--rpc-bind-ip/);
    assert.match((error as Error).message, /--confirm-external-bind/); assert.match((error as Error).message, /--restricted-rpc/);
    assert.doesNotMatch((error as Error).message, /secret CORS/); return true;
  });
  // Bundled nodes keep their original message.
  await assert.rejects(boundedFetch(TARGET), error => { assert.doesNotMatch((error as Error).message, /--rpc-bind-ip/); return true; });
  assert.equal(calls, 2);
});

test('custom node checks send only get_info to the exact saved origin and resolve only saved ids', async () => {
  const custom = [{ id: 'custom-0123456789abcdef', name: 'Home', url: 'http://[::1]:38081', network: 'stagenet' as const, kind: 'custom' as const, source: '' }];
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(String(url), 'http://[::1]:38081/json_rpc');
    assert.equal(JSON.parse(init!.body as string).method, 'get_info');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'extension-node-check', result: { status: 'OK', nettype: 'stagenet', height: 7, synchronized: true } }));
  };
  const result = await checkNode('custom-0123456789abcdef', custom);
  assert.equal(result.reachable, true); assert.equal(result.network, 'stagenet'); assert.equal(result.height, 7);
  await assert.rejects(checkNode('custom-0123456789abcdef'), { code: 'INVALID_NODE' });
  await assert.rejects(checkNode('custom-fedcba9876543210', custom), { code: 'INVALID_NODE' });
  assert.equal(calls, 1);
});

test('engine request URIs are parsed strictly; unbracketed IPv6 from the native client is re-bracketed', async () => {
  const { engineRequestUrl } = await import('./nodes.ts');
  assert.equal(engineRequestUrl('http://127.0.0.1:18081/json_rpc').href, 'http://127.0.0.1:18081/json_rpc');
  assert.equal(engineRequestUrl('https://xmr-node.cakewallet.com:18081/getblocks.bin').origin, 'https://xmr-node.cakewallet.com:18081');
  // wallet2 strips brackets from IPv6 hosts before monero-ts rebuilds "scheme://host:port/path".
  assert.equal(engineRequestUrl('http://::1:18081/json_rpc').href, 'http://[::1]:18081/json_rpc');
  assert.equal(engineRequestUrl('http://2001:db8::1:38081/get_info').origin, 'http://[2001:db8::1]:38081');
  for (const uri of ['not a url', 'http://::1/json_rpc', 'http://::1:18081/json_rpc?x=1', 'ftp://::1:21/x', 'http://zz::1:18081/'])
    assert.throws(() => engineRequestUrl(uri), { code: 'INVALID_NODE' }, uri);
});
