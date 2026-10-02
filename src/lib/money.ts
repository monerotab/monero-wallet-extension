const ATOMIC = 1_000_000_000_000n;

export function toAtomic(value: string): bigint {
  if (value.length > 32 || !/^(0|[1-9]\d*)(\.\d{1,12})?$/.test(value)) throw new Error('Enter an XMR amount with up to 12 decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * ATOMIC + BigInt(fraction.padEnd(12, '0'));
  if (result > 18_446_744_073_709_551_615n) throw new Error('Amount exceeds the supported range.');
  return result;
}
export function formatXmr(value: string | undefined, minimumDecimals = 4): string {
  if (value === undefined) return '—';
  const amount = BigInt(value);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  const decimals = (absolute % ATOMIC).toString().padStart(12, '0').replace(/0+$/, '').padEnd(minimumDecimals, '0');
  return `${sign}${(absolute / ATOMIC).toLocaleString('en-US')}${decimals ? `.${decimals}` : ''}`;
}
/** Plain decimal XMR (no grouping) that toAtomic() accepts again. */
export function toDecimal(value: string | bigint): string {
  const amount = BigInt(value);
  if (amount < 0n) throw new Error('Negative amounts are not supported.');
  const fraction = (amount % ATOMIC).toString().padStart(12, '0').replace(/0+$/, '');
  return `${amount / ATOMIC}${fraction ? `.${fraction}` : ''}`;
}
export function shortAddress(address: string, size = 10): string {
  return address.length > size * 2 + 3 ? `${address.slice(0, size)}…${address.slice(-size)}` : address;
}
/** wallet2-compatible payment URI. Text is percent-encoded: wallet2 does not decode '+' as a space. */
export function paymentUri(address: string, amount: string, description: string, recipientName = ''): string {
  if (!address) return '';
  const params: string[] = [];
  if (amount) { if (toAtomic(amount) <= 0n) throw new Error('Requested amount must be greater than zero.'); params.push(`tx_amount=${amount}`); }
  if (recipientName.trim()) params.push(`recipient_name=${encodeURIComponent(recipientName.trim())}`);
  if (description.trim()) params.push(`tx_description=${encodeURIComponent(description.trim())}`);
  return `monero:${address}${params.length ? `?${params.join('&')}` : ''}`;
}
export function downloadText(text: string, filename: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
