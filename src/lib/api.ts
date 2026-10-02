import type { WalletService } from '../runtime/service';
import { PORT_NAME, validMarker, type PendingTransfer } from '../runtime/transport.ts';
import { WalletPortClient } from '../runtime/transport-client.ts';
import { runtimeControl } from '../runtime/transport-control.ts';
import { WalletIdentityGate } from '../runtime/transport-identity.ts';
export type { PendingTransfer } from '../runtime/transport.ts';
export const inExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
export class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) { super(message); this.name = 'ApiError'; this.code = code; }
}
let service: WalletService | undefined;
let localGate: WalletIdentityGate | undefined;
let localStarting: Promise<WalletService> | undefined;
let client: WalletPortClient | undefined;
let connecting: Promise<WalletPortClient> | undefined;
let hidden = false;
async function localRuntime() {
  if (service) return service;
  if (!localStarting) localStarting = import('../runtime/service').then(({ WalletService }) => {
    if (hidden) throw new ApiError('The wallet page was closed.', 'ENGINE_CLOSED');
    service = new WalletService({ getPendingTransfer, setPendingTransfer }); localGate = new WalletIdentityGate(service); return service;
  }).finally(() => { localStarting = undefined; });
  return localStarting;
}
async function extensionRuntime(): Promise<WalletPortClient> {
  if (hidden) throw new ApiError('The wallet view was closed.', 'TRANSPORT_LOST');
  if (client) return client;
  if (!connecting) connecting = (async () => {
    await runtimeControl('ensureOffscreen');
    if (hidden) throw new ApiError('The wallet view was closed.', 'TRANSPORT_LOST');
    const next = new WalletPortClient(chrome.runtime.connect({ name: PORT_NAME }), () => { if (client === next) client = undefined; });
    client = next;
    await next.ready;
    return next;
  })().finally(() => { connecting = undefined; });
  return connecting;
}
function mapped(error: unknown): ApiError {
  if (error instanceof Error) return new ApiError(error.message, 'code' in error && typeof error.code === 'string' ? error.code : undefined);
  return new ApiError('The wallet operation could not be completed. No operation was automatically retried.');
}
/** Extension: direct UI↔offscreen port. Browser preview: original local service.
 * No request, especially signing/relay, is automatically resent after disconnect. */
export async function api<T>(action: string, params: Record<string, unknown> = {}, expectedVaultId?: string | null): Promise<T> {
  try {
    if (inExtension) return await (await extensionRuntime()).request<T>(action, params, expectedVaultId);
    await localRuntime();
    return await localGate!.request(action, params, expectedVaultId) as T;
  } catch (error) { throw mapped(error); }
}
export async function getPendingTransfer(): Promise<PendingTransfer | null> {
  try {
    return validMarker(inExtension ? await runtimeControl('marker.read') : JSON.parse(localStorage.getItem('monero-unresolved-transfer-v2') ?? 'null'));
  } catch { throw new ApiError('Transfer recovery storage is unavailable or damaged. Sending remains disabled until the previous outcome is verified.', 'PENDING_STORAGE_ERROR'); }
}
async function setPendingTransfer(value: PendingTransfer | null): Promise<void> {
  const marker = validMarker(value);
  // Used only by standalone browser preview. Extension writes originate exclusively
  // from WalletService in offscreen and are authenticated by the background.
  if (inExtension) throw new ApiError('Only the wallet runtime may update transfer recovery storage.', 'INVALID_CONTEXT');
  if (marker) localStorage.setItem('monero-unresolved-transfer-v2', JSON.stringify(marker));
  else localStorage.removeItem('monero-unresolved-transfer-v2');
}
export async function openOnboarding(mode?: string): Promise<void> {
  if (mode !== undefined && !['create', 'restore', 'import'].includes(mode)) throw new ApiError('Choose create, restore or import.', 'INVALID_PARAMS');
  try {
    if (inExtension) await runtimeControl('openOnboarding', mode ? { mode } : {});
    else location.assign(`onboarding.html${mode ? `?mode=${mode}` : ''}`);
  } catch (error) { throw mapped(error); }
}
/** Optional full-size view. The extension action itself still opens the popup. */
export async function openWalletWindow(): Promise<void> {
  try {
    if (inExtension) await runtimeControl('openWalletWindow');
    else location.assign('index.html');
  } catch (error) { throw mapped(error); }
}
// Only actual trusted, visible UI input extends the offscreen session. Status and
// snapshot polling, rendering, visibility timers and programmatic events do not.
let lastActivity = 0;
export function notifyWalletActivity(): void {
  if (!inExtension || document.visibilityState !== 'visible' || Date.now() - lastActivity < 10_000) return;
  lastActivity = Date.now(); client?.activity();
}
for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
  document.addEventListener(type, event => { if (event.isTrusted) notifyWalletActivity(); }, { capture: true, passive: true });
}
window.addEventListener('pagehide', () => {
  hidden = true; client?.close(); client = undefined;
  // Closing the popup does NOT dispose the offscreen service, sync or relay.
  service?.dispose(); service = undefined; localGate = undefined;
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
