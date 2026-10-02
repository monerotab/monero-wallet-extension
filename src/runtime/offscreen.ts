import { WalletService } from './service.ts';
import { OffscreenWalletHost } from './offscreen-host.ts';
import { runtimeControl } from './transport-control.ts';
import { TransportError, validMarker, type PendingTransfer } from './transport.ts';

// Offscreen documents have chrome.runtime ONLY. Marker storage is mediated by
// the strictly authenticated background coordinator; encrypted vaults use IDB.
// A newly created/restarted document always starts locked. No stored password,
// auto-unlock, timer sync, implicit relay, or request replay exists here.
// Chromium omits sender.documentId on offscreen messages and does not expose the
// getContexts introspection API here. Capture OUR browser-issued identity once
// through a short authenticated SW lookup. A reply to a dead document is dropped;
// a live document never refreshes/adopts a replacement identity in a callback.
const documentIdentity = runtimeControl<unknown>('offscreen.identify').then(value =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null).catch(() => null);
async function actor() {
  const documentId = await documentIdentity;
  if (!documentId) throw new TransportError('The wallet runtime document identity is unavailable. Sending remains disabled.', 'PENDING_STORAGE_ERROR');
  return { documentId };
}
const service = new WalletService({
  getPendingTransfer: async () => validMarker(await runtimeControl<PendingTransfer | null>('marker.read', await actor())),
  setPendingTransfer: async value => { await runtimeControl('marker.write', { value: validMarker(value), ...await actor() }); },
});
const host = new OffscreenWalletHost(service, chrome.runtime.id);
chrome.runtime.onConnect.addListener(port => { host.accept(port); });
const timer = setInterval(() => { void host.checkIdle(); }, 15_000);
// This fires for actual offscreen teardown, never for a popup closing or SW idle.
window.addEventListener('pagehide', () => { clearInterval(timer); service.dispose(); }, { once: true });
