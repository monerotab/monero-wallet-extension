import { CONTROL_CHANNEL, TransportError, plain } from './transport.ts';
/** Short privileged operations only. Wallet requests must use the direct UI port. */
export async function runtimeControl<T>(action: string, extra: Record<string, unknown> = {}): Promise<T> {
  let response: unknown;
  try { response = await chrome.runtime.sendMessage({ channel: CONTROL_CHANNEL, action, ...extra }); }
  catch { throw new TransportError('The extension coordinator is unavailable. Nothing was automatically retried. Reopen the wallet and verify pending transfers.', 'COORDINATOR_UNAVAILABLE'); }
  if (!plain(response)) throw new TransportError('The extension coordinator did not confirm this operation. Nothing was retried.', 'COORDINATOR_UNAVAILABLE');
  if (response.ok === true) return response.result as T;
  if (plain(response.error) && typeof response.error.message === 'string')
    throw new TransportError(response.error.message, typeof response.error.code === 'string' ? response.error.code : 'COORDINATOR_ERROR');
  throw new TransportError('The extension coordinator refused this operation.', 'COORDINATOR_ERROR');
}
