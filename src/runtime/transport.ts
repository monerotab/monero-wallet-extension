/** Private extension-only protocol. Never expose this channel to web/content scripts. */
export const PORT_NAME = 'monero-wallet-ui-v2.1';
export const CONTROL_CHANNEL = 'monero-wallet-control-v2.1';
export const SESSION_IDLE_MS = 5 * 60_000;
/** Per-wallet auto-lock choices (minutes). The idle limit never exceeds one hour. */
export const AUTO_LOCK_CHOICES = [1, 5, 15, 30, 60] as const;
export const MAX_SESSION_IDLE_MS = 60 * 60_000;
/** The open wallet's encrypted auto-lock setting; anything unexpected falls back to the five-minute default. */
export function sessionIdleMs(status: unknown): number {
  const minutes = plain(status) ? status.autoLockMinutes : undefined;
  return typeof minutes === 'number' && (AUTO_LOCK_CHOICES as readonly number[]).includes(minutes)
    ? Math.min(minutes * 60_000, MAX_SESSION_IDLE_MS) : SESSION_IDLE_MS;
}
export const MAX_PENDING_REQUESTS = 16;
export const MAX_HOST_REQUESTS = 32;
export const MAX_CLIENTS = 8;
export const MAX_BACKUP_CHARS = 180_000_000;
export const MAX_MESSAGE_CHARS = 1024 * 1024;
export const BACKUP_CHUNK_CHARS = 512 * 1024;
export const ACTIONS = new Set(['status', 'snapshot', 'wallet.list', 'wallet.create', 'wallet.restore', 'wallet.open',
  'wallet.close', 'wallet.save', 'wallet.refresh', 'wallet.seed', 'wallet.password', 'wallet.export', 'wallet.import',
  'node.list', 'node.check', 'node.select', 'node.custom.add', 'node.custom.remove', 'account.create', 'account.label', 'account.rename', 'address.create', 'address.label',
  'contact.add', 'contact.edit', 'contact.delete', 'message.sign', 'message.verify',
  'wallet.rename', 'wallet.settings', 'wallet.keys', 'wallet.delete', 'wallet.rescan', 'address.integrated',
  'tx.note', 'tx.key', 'tx.prepare', 'tx.confirm', 'tx.cancel', 'tx.resolve']);
// Every action outside NEUTRAL_ACTIONS is bound to the verified vault identity. None of
// the address-book, label, signing, tx-key, rename, settings, keys, delete, rescan or
// integrated-address actions is neutral, open, poll or read-only.
/** Actions whose successful result leaves NO wallet open (result identity null). */
export const CLOSE_ACTIONS = new Set(['wallet.close', 'wallet.delete']);
export const READ_ACTIONS = new Set(['status', 'snapshot', 'wallet.list', 'node.list']);
export const OPEN_ACTIONS = new Set(['wallet.create', 'wallet.restore', 'wallet.open']);
export const NEUTRAL_ACTIONS = new Set(['status', 'wallet.list', 'wallet.import', 'node.list', 'node.check', 'tx.resolve']);
export const POLL_ACTIONS = new Set(['status', 'wallet.list', 'node.list']);
export const WALLET_CHANGED_MESSAGE = 'The active wallet changed or this view has no verified wallet identity. Refresh and review the selected wallet before continuing. Nothing was retried.';
export function walletChanged(): TransportError { return new TransportError(WALLET_CHANGED_MESSAGE, 'WALLET_CHANGED'); }
export function validVaultId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);
}
export function validResultIdentity(action: string, expectedVaultId: string | null | undefined, actualVaultId: unknown): boolean {
  if (NEUTRAL_ACTIONS.has(action)) return true;
  if (OPEN_ACTIONS.has(action)) return expectedVaultId === null && validVaultId(actualVaultId);
  return validVaultId(expectedVaultId) && actualVaultId === (CLOSE_ACTIONS.has(action) ? null : expectedVaultId);
}
export interface PendingTransfer { txHash: string; createdAt: number }
export type RuntimePort = Pick<chrome.runtime.Port, 'name' | 'sender' | 'onMessage' | 'onDisconnect' | 'postMessage' | 'disconnect'>;
export interface WalletRuntime { request(action: string, params?: Record<string, unknown>): Promise<unknown> }
export class TransportError extends Error {
  code: string;
  constructor(message: string, code = 'TRANSPORT_LOST') { super(message); this.name = 'TransportError'; this.code = code; }
}
export const LOST_MESSAGE = 'The wallet connection closed. An operation may have completed; nothing was retried. Reopen the wallet and verify pending transfers before sending again.';
export function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function validMarker(value: unknown): PendingTransfer | null {
  if (value === null || value === undefined) return null;
  if (!plain(value) || Object.keys(value).length !== 2 || typeof value.txHash !== 'string' || !/^[a-f\d]{64}$/i.test(value.txHash) ||
    typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0)
    throw new TransportError('Transfer recovery storage is unavailable or damaged. Sending remains disabled until the previous outcome is verified.', 'PENDING_STORAGE_ERROR');
  return { txHash: value.txHash, createdAt: value.createdAt };
}
/** Compare a complete extension URL, not a prefix (and never trust sender.id alone). */
export function trustedSender(sender: chrome.runtime.MessageSender | undefined, extensionId: string, page: 'ui' | 'offscreen'): boolean {
  if (!sender || sender.id !== extensionId || !sender.url || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
  if (sender.documentLifecycle && sender.documentLifecycle !== 'active') return false;
  try {
    const url = new URL(sender.url);
    if (url.protocol !== 'chrome-extension:' || url.hostname !== extensionId || url.port || url.username || url.password || url.hash) return false;
    if (sender.origin && sender.origin !== `chrome-extension://${extensionId}`) return false;
    if (page === 'offscreen') return url.pathname === '/offscreen.html' && !url.search && !sender.tab;
    if (url.pathname === '/index.html') return !url.search || url.search === '?popup=1';
    if (url.pathname !== '/onboarding.html') return false;
    return !url.search || ['?mode=create', '?mode=restore', '?mode=import'].includes(url.search);
  } catch { return false; }
}
export function errorRecord(error: unknown): { message: string; code?: string } {
  // Service errors are intentionally sanitized at the engine/vault boundary. Never stringify parameters.
  if (error instanceof Error) return { message: error.message.slice(0, 1000),
    ...('code' in error && typeof error.code === 'string' ? { code: error.code.slice(0, 64) } : {}) };
  return { message: 'The wallet operation could not be completed. Nothing was automatically retried.' };
}
export function validRequest(value: unknown): value is { kind: 'request'; id: number; action: string; params: Record<string, unknown>; expectedVaultId?: string | null } {
  if (!plain(value) || value.kind !== 'request' || Object.keys(value).length !== (Object.hasOwn(value, 'expectedVaultId') ? 5 : 4) ||
    !Number.isSafeInteger(value.id) || (value.id as number) <= 0 || typeof value.action !== 'string' || !ACTIONS.has(value.action) || !plain(value.params) ||
    (Object.hasOwn(value, 'expectedVaultId') && value.expectedVaultId !== null && !validVaultId(value.expectedVaultId))) return false;
  // Flat API params only; WalletService applies the authoritative per-action schema.
  return Object.keys(value.params).length <= 12 && Object.entries(value.params).every(([key, val]) =>
    key.length <= 64 && (typeof val === 'boolean' || (typeof val === 'number' && Number.isFinite(val)) ||
    (typeof val === 'string' && val.length <= (value.action === 'wallet.import' && key === 'content' ? MAX_BACKUP_CHARS : 4096))));
}
