/**
 * UI-side helpers for user-added Monero nodes. The runtime validates URLs again
 * and enforces the exact-origin allowlist; this module only gives instant
 * feedback and asks Chrome for access to that single origin.
 */
export type NormalizedNode = { ok: true; url: string } | { ok: false; message: string };

export function normalizeNodeUrl(input: string): NormalizedNode {
  const text = input.trim();
  if (!text) return { ok: false, message: 'Enter the node address.' };
  if (text.length > 200) return { ok: false, message: 'The node address is too long.' };
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { return { ok: false, message: 'This is not a valid address. Example: http://192.168.1.10:18089' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, message: 'Only http:// and https:// nodes are supported.' };
  if (url.username || url.password) return { ok: false, message: 'Login credentials are not supported. Use a node without RPC login.' };
  if (url.search || url.hash || (url.pathname && url.pathname !== '/')) return { ok: false, message: 'Enter only the host and port, without a path, query or #fragment.' };
  if (!url.hostname) return { ok: false, message: 'Enter a host name or IP address.' };
  return { ok: true, url: url.origin };
}

/**
 * Must be called at the start of a click handler: Chrome requires a user gesture.
 * Resolves immediately without a prompt when the origin is already allowed.
 * The pattern includes the port, so access is granted to exactly this node.
 */
export async function ensureNodePermission(origin: string): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.permissions) return; // development preview
  const origins = [`${new URL(origin).origin}/*`];
  let granted = false;
  // request() must be the first await so it keeps the click's user gesture;
  // Chrome answers immediately, without a prompt, when access already exists.
  try { granted = await chrome.permissions.request({ origins }); }
  catch { granted = await chrome.permissions.contains({ origins }).catch(() => false); }
  if (!granted) throw new Error('The wallet cannot reach this node without access. Allow it when Chrome asks; nothing was contacted.');
}

/**
 * Chrome's permission prompt can close the popup before the request resolves.
 * The unfinished form is kept in memory-only session storage (never on disk)
 * so reopening the popup can finish adding the node.
 */
interface PendingNode { vaultId: string; name: string; url: string }
const PENDING_KEY = 'pendingCustomNode';
const sessionArea = () => typeof chrome !== 'undefined' ? chrome.storage?.session : undefined;
export function savePendingNode(value: PendingNode): void { void sessionArea()?.set({ [PENDING_KEY]: value }).catch(() => undefined); }
export function clearPendingNode(): void { void sessionArea()?.remove(PENDING_KEY).catch(() => undefined); }
export async function readPendingNode(vaultId?: string): Promise<{ name: string; url: string } | null> {
  const area = sessionArea(); if (!area || !vaultId) return null;
  try {
    const value = (await area.get(PENDING_KEY))[PENDING_KEY] as Partial<PendingNode> | undefined;
    if (!value || value.vaultId !== vaultId || typeof value.name !== 'string' || typeof value.url !== 'string') return null;
    const normalized = normalizeNodeUrl(value.url);
    return normalized.ok ? { name: value.name.slice(0, 40), url: normalized.url } : null;
  } catch { return null; }
}
