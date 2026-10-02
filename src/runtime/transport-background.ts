import { CONTROL_CHANNEL, plain, trustedSender, validMarker, errorRecord, TransportError } from './transport.ts';

/** Privileged coordinator only. No WalletService, passwords, seeds, signing or relay. */
let creating: Promise<void> | undefined;
let opening: Promise<unknown> = Promise.resolve();
let markerTail: Promise<unknown> = Promise.resolve();
function markerError() {
  return new TransportError('Transfer recovery storage is unavailable or damaged. Sending remains disabled until the previous outcome is verified.', 'PENDING_STORAGE_ERROR');
}
async function identifyOffscreen(sender: chrome.runtime.MessageSender) {
  const url = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  const matching = contexts.filter(context => context.documentUrl === url && context.contextType === chrome.runtime.ContextType.OFFSCREEN_DOCUMENT);
  const documentId = matching.length === 1 ? matching[0].documentId : undefined;
  if (typeof documentId !== 'string' || !documentId || (sender.documentId !== undefined && sender.documentId !== documentId)) throw markerError();
  return documentId;
}
async function requireCurrentOffscreen(sender: chrome.runtime.MessageSender, documentId: unknown) {
  // Offscreen sendMessage currently omits the native documentId in Chromium. Its
  // bootstrap captures the browser-issued ID once and carries that fixed actor
  // identity. Require the native ID to agree whenever Chrome does supply it.
  if (typeof documentId !== 'string' || !documentId || documentId.length > 128 ||
    (sender.documentId !== undefined && sender.documentId !== documentId)) throw markerError();
  const url = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  if (!contexts.some(context => context.documentId === documentId && context.documentUrl === url &&
    context.contextType === chrome.runtime.ContextType.OFFSCREEN_DOCUMENT)) throw markerError();
}
function markerOperation(action: string, value: unknown, sender: chrome.runtime.MessageSender, offscreen: boolean, documentId: unknown) {
  // Include READS: a replacement offscreen must not observe/persist a new outcome
  // ahead of an older accepted clear whose asynchronous storage call is unsettled.
  const task = markerTail.then(async () => {
    try {
      if (offscreen) await requireCurrentOffscreen(sender, documentId); // Dequeue-time ownership.
      if (action === 'marker.read') return validMarker((await chrome.storage.local.get('unresolvedTransfer')).unresolvedTransfer);
      const marker = validMarker(value);
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      // The old offscreen may have died during setAccessLevel. URL equality alone
      // does not distinguish it from its replacement; documentId does.
      await requireCurrentOffscreen(sender, documentId);
      if (marker) await chrome.storage.local.set({ unresolvedTransfer: marker });
      else await chrome.storage.local.remove('unresolvedTransfer');
      return null;
    } catch { throw markerError(); }
  });
  // Retain the fence until the actual Chrome storage promise settles. No timeout,
  // retry, or navigation path can release/reorder this ownership boundary.
  markerTail = task.catch(() => undefined);
  return task;
}
async function ensureOffscreen() {
  if (creating) return creating;
  creating = (async () => {
    const url = chrome.runtime.getURL('offscreen.html');
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
    if (!contexts.length) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Own the local Monero WebAssembly worker so popup closure cannot interrupt an explicit wallet operation; idle sessions auto-lock.' });
  })().finally(() => { creating = undefined; });
  return creating;
}
async function openPage(page: 'onboarding' | 'wallet', mode?: string) {
  const path = page === 'wallet' ? 'index.html' : `onboarding.html${mode ? `?mode=${mode}` : ''}`;
  const url = chrome.runtime.getURL(path);
  // URLs only, no UI secrets. A suspended/restarted SW can rediscover existing tabs.
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(tab => tab.url === url && typeof tab.id === 'number');
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true }); return;
  }
  await chrome.tabs.create({ url });
}
let controls = 0;
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!plain(message) || message.channel !== CONTROL_CHANNEL || typeof message.action !== 'string') return false;
  const ui = trustedSender(sender, chrome.runtime.id, 'ui');
  const offscreen = trustedSender(sender, chrome.runtime.id, 'offscreen');
  if (!ui && !offscreen) return false;
  const action = message.action;
  if ((!ui && !['marker.read', 'marker.write', 'offscreen.identify'].includes(action)) ||
    (['marker.write', 'offscreen.identify'].includes(action) && !offscreen) ||
    !['ensureOffscreen', 'openOnboarding', 'openWalletWindow', 'marker.read', 'marker.write', 'offscreen.identify'].includes(action)) return false;
  const expected = action === 'marker.write' ? ['channel', 'action', 'value', 'documentId'] :
    action === 'marker.read' && offscreen ? ['channel', 'action', 'documentId'] :
    action === 'openOnboarding' && Object.hasOwn(message, 'mode') ? ['channel', 'action', 'mode'] : ['channel', 'action'];
  if (Object.keys(message).length !== expected.length || expected.some(key => !Object.hasOwn(message, key))) return false;
  if (action === 'openOnboarding' && message.mode !== undefined && !['create', 'restore', 'import'].includes(message.mode as string)) return false;
  if (controls >= 32) { respond({ ok: false, error: { message: 'Too many wallet coordinator requests.', code: 'QUEUE_FULL' } }); return false; }
  controls++;
  void (async () => {
    if (action === 'ensureOffscreen') { await ensureOffscreen(); return null; }
    if (action === 'offscreen.identify') return identifyOffscreen(sender);
    if (action === 'openOnboarding' || action === 'openWalletWindow') {
      const task = opening.catch(() => undefined).then(() => openPage(action === 'openOnboarding' ? 'onboarding' : 'wallet', message.mode as string | undefined));
      opening = task; await task; return null;
    }
    return markerOperation(action, message.value, sender, offscreen, message.documentId);
  })().then(result => respond({ ok: true, result }), error => respond({ ok: false, error: errorRecord(error) })).finally(() => { controls--; });
  return true;
});
chrome.runtime.onInstalled.addListener(() => { void chrome.storage.session.remove('bridgeToken').catch(() => undefined); });
// Intentionally no onConnect listener: runtime.connect is received by the offscreen
// page directly. A service-worker restart must not detach the wallet's UI ports.
