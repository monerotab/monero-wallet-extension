import catalog from '../../shared/nodes.json' with { type: 'json' };
import type { NodePreset, NodeCheck, Network, WalletNetwork } from '../lib/types';
import { RuntimeError, requireCondition } from './errors.ts';

export const NODES: readonly Readonly<NodePreset>[] = Object.freeze(catalog.map(node => Object.freeze(node as NodePreset)));
/** Resolve a node id against the bundled catalog plus the open wallet's own custom nodes. */
export function getNode(id: string, custom: readonly Readonly<NodePreset>[] = []): Readonly<NodePreset> {
  const node = NODES.find(node => node.id === id) ?? custom.find(node => node.kind === 'custom' && node.id === id);
  if (!node) throw new RuntimeError('Choose one of the bundled public nodes or one of your saved custom nodes.', 'INVALID_NODE');
  return node;
}

export const MAX_CUSTOM_NODES = 16;
export const CUSTOM_NODE_ID = /^custom-[a-f\d]{16}$/;
const HOST_LABEL = /^(?!-)[a-z\d-]{1,63}(?<!-)$/;
/** Parse a user-supplied daemon URL and normalize it to its origin (scheme + host + port).
 * Only plain http(s) daemon roots: no credentials, path, query, fragment or wildcard hosts. */
export function customNodeOrigin(input: string): string {
  const invalid = (detail: string) => new RuntimeError(`Enter the node address as http(s)://host:port. ${detail}`, 'INVALID_NODE_URL');
  const text = input.trim();
  if (!text || text.length > 200 || /[\s\u0000-\u001f\u007f\\]/.test(text)) throw invalid('Spaces and control characters are not allowed.');
  if (!/^https?:\/\//i.test(text)) throw invalid('Only http:// and https:// are supported.');
  let url: URL;
  try { url = new URL(text); } catch { throw invalid('This is not a valid URL.'); }
  if (url.username || url.password || text.slice(text.indexOf('//') + 2).split(/[/?#]/)[0].includes('@')) throw invalid('Credentials are not supported; use a node without RPC login.');
  if (/[?#]/.test(text)) throw invalid('Remove the query string or fragment.');
  if (url.pathname !== '/') throw invalid('Remove the path; the wallet adds /json_rpc and other daemon paths itself.');
  if (url.port === '0') throw invalid('Port 0 is not valid.');
  const host = url.hostname;
  if (host.startsWith('[')) {
    // Zone identifiers are rejected by URL parsing; accept any other bracketed IPv6 literal.
    if (!/^\[[\da-f:.]+\]$/i.test(host)) throw invalid('This IPv6 address is not valid.');
  } else if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    // WHATWG normalization turns shorthand numeric hosts into dotted IPv4 above. Everything else must be a DNS name.
    const labels = host.split('.');
    if (host.length > 253 || !labels.every(label => HOST_LABEL.test(label))) throw invalid('Use a DNS name, an IPv4 address or a bracketed IPv6 address.');
  }
  return url.origin;
}
/** Append a validated custom node. Adding never contacts the node. */
export function appendCustomNode(existing: readonly Readonly<NodePreset>[], name: string, url: string, network: WalletNetwork): NodePreset[] {
  const origin = customNodeOrigin(url);
  requireCondition(existing.length < MAX_CUSTOM_NODES, `You can save up to ${MAX_CUSTOM_NODES} custom nodes. Remove one first.`, 'CUSTOM_NODES_FULL');
  requireCondition(![...NODES, ...existing].some(node => new URL(node.url).origin === origin), 'This node address is already in the node list.', 'DUPLICATE_NODE');
  return [...existing.map(node => ({ ...node })), { id: newCustomNodeId(), name, url: origin, network, kind: 'custom', source: '' }];
}
export function newCustomNodeId(): string {
  return `custom-${[...crypto.getRandomValues(new Uint8Array(8))].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
/** Structural check for custom nodes loaded from an encrypted vault; values were validated when saved. */
export function validCustomNode(value: unknown): value is NodePreset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  if (Object.keys(node).length !== 6 || typeof node.id !== 'string' || !CUSTOM_NODE_ID.test(node.id) || node.kind !== 'custom' || node.source !== '' ||
    typeof node.name !== 'string' || !node.name.trim() || node.name.length > 40 || typeof node.url !== 'string' ||
    !['mainnet', 'stagenet', 'testnet'].includes(node.network as string)) return false;
  try { return customNodeOrigin(node.url) === node.url; } catch { return false; }
}
/** Worker-side resolution. The worker cannot read the vault, so the service passes a custom
 * node's origin together with its id; it is re-validated here. A bundled id is never redirected. */
export function resolveNodeTarget(nodeId: string, customUrl?: string | null): { url: string; custom: boolean } {
  if (CUSTOM_NODE_ID.test(nodeId)) {
    let valid = false;
    try { valid = typeof customUrl === 'string' && customNodeOrigin(customUrl) === customUrl; } catch { valid = false; }
    requireCondition(valid, 'The custom node address is not allowed.', 'INVALID_NODE');
    return { url: customUrl as string, custom: true };
  }
  requireCondition(customUrl === undefined || customUrl === null, 'A bundled node cannot be redirected to another address.', 'INVALID_NODE');
  return { url: getNode(nodeId).url, custom: false };
}
/** Parse a daemon request URI built by the native engine. monero-ts builds
 * `scheme://host:port/path` and drops IPv6 brackets (`http://::1:18081/json_rpc`), so a
 * bare IPv6 host is re-bracketed. The caller still compares the resulting origin exactly. */
export function engineRequestUrl(uri: string): URL {
  try { return new URL(uri); } catch { /* possibly an unbracketed IPv6 literal */ }
  // Host needs at least two colons (IPv6), then the mandatory port the native client always adds.
  const match = /^(https?):\/\/([\da-f.]*:[\da-f.]*:[\da-f:.]*):(\d{1,5})(\/[^?#]*)?$/i.exec(uri);
  requireCondition(match, 'The wallet attempted to contact a different node.', 'INVALID_NODE');
  try { return new URL(`${match[1]}://[${match[2]}]:${match[3]}${match[4] ?? '/'}`); }
  catch { throw new RuntimeError('The wallet attempted to contact a different node.', 'INVALID_NODE'); }
}
/** Custom nodes must be reachable with an explicit, exact-origin browser permission. Chrome
 * reports CORS/permission/connection failures as an opaque TypeError: explain every cause. */
export const CUSTOM_NODE_UNREACHABLE = 'Cannot reach this node. Allow access when Chrome asks for permission, then check that the daemon is running and reachable. ' +
  'For your own monerod use --restricted-rpc; for access from another device also --rpc-bind-ip 0.0.0.0 --confirm-external-bind. No request was retried.';

// Chrome verifies TLS and resolves DNS. No proxy, cookies, credentials, or redirects.
// Browser code cannot pin DNS. The allowlist admits the bundled catalog plus only the
// exact origins the caller passes in (the checked/selected custom node), never a pattern.
export async function boundedFetch(url: URL, init: RequestInit = {}, maxBytes = 32 * 1024 * 1024, timeoutMs = 30_000,
  allowedOrigins: readonly string[] = []): Promise<{ response: Response; bytes: Uint8Array }> {
  const custom = allowedOrigins.includes(url.origin);
  requireCondition((custom || NODES.some(node => new URL(node.url).origin === url.origin)) && !url.username && !url.password && !url.hash,
    'This daemon address is not allowed.', 'INVALID_NODE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signals = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
  try {
    const response = await fetch(url.href, { ...init, signal: signals, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new RuntimeError('The node refused this request. No request was retried.', 'NODE_HTTP_ERROR');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) throw new RuntimeError('Node response is too large.', 'NODE_RESPONSE_TOO_LARGE');
    const chunks: Uint8Array[] = []; let total = 0;
    if (!response.body) throw new RuntimeError('The node returned an empty response.', 'NODE_PROTOCOL');
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new RuntimeError('Node response is too large.', 'NODE_RESPONSE_TOO_LARGE');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { response, bytes };
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if (controller.signal.aborted || init.signal?.aborted) throw new RuntimeError('The node request timed out or was cancelled. No request was retried.', 'NODE_TIMEOUT');
    throw new RuntimeError(custom ? CUSTOM_NODE_UNREACHABLE : 'Cannot reach the node. Check its availability, TLS certificate and extension permissions. No request was retried.', 'NODE_UNREACHABLE');
  } finally { clearTimeout(timer); controller.abort(); }
}

/** `custom` is the open wallet's saved custom nodes; only the checked node's exact origin is admitted. */
export async function checkNode(nodeId: string, custom: readonly Readonly<NodePreset>[] = []): Promise<NodeCheck> {
  const node = getNode(nodeId, custom); const start = performance.now();
  const base = (): NodeCheck => ({ nodeId, reachable: false, network: 'unknown', height: null, targetHeight: null, synchronized: null, latencyMs: null, checkedAt: Date.now() });
  try {
    const { bytes } = await boundedFetch(new URL('/json_rpc', node.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'extension-node-check', method: 'get_info', params: {} }),
    }, 256 * 1024, 8_000, node.kind === 'custom' ? [new URL(node.url).origin] : []);
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const info = payload?.result;
    requireCondition(payload?.id === 'extension-node-check' && payload.jsonrpc === '2.0' && !payload.error && info?.status === 'OK', 'Invalid node response.', 'NODE_PROTOCOL');
    const flags = (['mainnet', 'stagenet', 'testnet'] as const).filter(network => info[network] === true);
    const declared: Network = ['mainnet', 'stagenet', 'testnet'].includes(info.nettype) ? info.nettype : 'unknown';
    const network: Network = flags.length > 1 || (info.nettype !== undefined && declared === 'unknown') ||
      (declared !== 'unknown' && flags.length === 1 && declared !== flags[0]) ? 'unknown' : declared !== 'unknown' ? declared : flags[0] ?? 'unknown';
    requireCondition(Number.isSafeInteger(info.height) && info.height >= 0 &&
      (info.target_height === undefined || (Number.isSafeInteger(info.target_height) && info.target_height >= 0)), 'Invalid node height.', 'NODE_PROTOCOL');
    return { ...base(), reachable: true, network, height: info.height, targetHeight: info.target_height ?? null,
      synchronized: typeof info.synchronized === 'boolean' ? info.synchronized : null, latencyMs: Math.round(performance.now() - start) };
  } catch (error) {
    return { ...base(), error: error instanceof RuntimeError ? error.message : 'The node returned invalid data.' };
  }
}
