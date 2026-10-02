import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { createPortal } from 'react-dom';
import { AlertCircle, ArrowDownLeft, ArrowUpRight, Check, CircleX, Clock3, Copy, LoaderCircle, LockKeyhole, X } from 'lucide-react';
import { useWallet } from './WalletContext';
import type { Contact, Transaction } from '../lib/types';
import { formatXmr, shortAddress } from '../lib/money';
import { dayLabel, isIncoming, timeLabel, txStatus } from '../lib/format';

export function Logo({ className = '' }: { className?: string }) { return <img className={`monero-logo ${className}`} src="./monero.svg" alt="Monero" />; }
export function Spinner({ label = 'Loading' }: { label?: string }) { return <LoaderCircle size={16} className="spin" aria-label={label} />; }
export function ErrorBox({ children }: { children: ReactNode }) { return <div className="error-box" role="alert"><AlertCircle size={17} /><span>{children}</span></div>; }

/** Copies text and briefly shows a check mark. Never logs the copied value. */
export function CopyButton({ text, label = 'Copy address', small = false, children }: { text: string; label?: string; small?: boolean; children?: ReactNode }) {
  const { notify } = useWallet();
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1400); return () => clearTimeout(timer); }, [copied]);
  return <button type="button" className={small ? `icon-button copy-button ${copied ? 'copied' : ''}` : 'button secondary'} disabled={!text} title={label} aria-label={label} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); notify('Copied to clipboard'); } catch { notify('Clipboard unavailable. Select and copy the text manually.'); }
  }}>{copied ? <Check size={15} /> : <Copy size={15} />}{!small && (children ?? label)}</button>;
}

/** Amount with a dimmed tail so long 12-decimal balances stay readable. Honors "hide balances". */
export function Amount({ value, decimals = 4, sign = '', className = '', unit = true }: { value?: string; decimals?: number; sign?: string; className?: string; unit?: boolean }) {
  const { hidden } = useWallet();
  if (hidden) return <span className={`amount ${className}`}>••••••{unit && <small> XMR</small>}</span>;
  const text = formatXmr(value, decimals);
  const [whole, fraction] = text.split('.');
  const head = fraction ? fraction.slice(0, 4) : ''; const tail = fraction ? fraction.slice(4) : '';
  return <span className={`amount ${className}`}>{sign}{whole}{fraction !== undefined && <>.{head}{tail && <span className="amount-tail">{tail}</span>}</>}{unit && <small> XMR</small>}</span>;
}

/** Full address split in groups of 4 for character-by-character comparison. */
export function AddressBlock({ address, highlight = false }: { address: string; highlight?: boolean }) {
  const groups = address.match(/.{1,4}/g) ?? [];
  return <code className={`address-block ${highlight ? 'highlight' : ''}`}>{groups.map((group, index) => <span key={index} className={index < 2 || index >= groups.length - 2 ? 'edge' : ''}>{group}</span>)}</code>;
}

export function Modal({ title, eyebrow, children, onClose, wide = false, busy = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; wide?: boolean; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null); const titleId = useId(); const reduced = useReducedMotion();
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const busyRef = useRef(busy); busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const focusable = () => [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]') || [])];
    focusable()[0]?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) closeRef.current();
      if (event.key === 'Tab') {
        const items = focusable(); const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', listener);
    const oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const backgrounds = [...document.querySelectorAll<HTMLElement>('.gui-workspace,.gui-sidebar,.gui-titlebar,.skip-link')];
    const previousInert = backgrounds.map(element => element.inert);
    backgrounds.forEach(element => { element.inert = true; });
    return () => { document.removeEventListener('keydown', listener); document.body.style.overflow = oldOverflow; backgrounds.forEach((element, index) => { element.inert = previousInert[index]; }); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.15 }} onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <motion.div className={`modal ${wide ? 'modal-wide' : ''}`} initial={{ y: reduced ? 0 : 12, scale: reduced ? 1 : 0.985 }} animate={{ y: 0, scale: 1 }} exit={{ y: reduced ? 0 : 6, opacity: 0 }} transition={{ duration: reduced ? 0 : 0.18, ease: 'easeOut' }} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
      <div className="modal-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2 id={titleId}>{title}</h2></div><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={20} /></button></div>
      {children}
    </motion.div>
  </motion.div>, document.body);
}
export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon || <LockKeyhole size={22} />}</div><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function StatusPill({ tx }: { tx: Transaction }) {
  const status = txStatus(tx);
  return <span className={`status-pill ${status.tone}`}>{status.tone === 'failed' ? <CircleX size={11} /> : status.tone === 'ok' ? <Check size={11} /> : <Clock3 size={11} />}{status.label}</span>;
}
export function contactName(contacts: Contact[] | undefined, address: string): string | undefined {
  return address ? contacts?.find(contact => contact.address === address)?.description || undefined : undefined;
}
function txTitle(tx: Transaction, contacts: Contact[] | undefined, addressLabel: (index: number) => string | undefined): string {
  if (tx.note) return tx.note;
  if (isIncoming(tx)) {
    const label = tx.subaddressIndices.length === 1 ? addressLabel(tx.subaddressIndices[0]) : undefined;
    return label ? `Received · ${label}` : 'Received';
  }
  const destination = tx.destinations[0]?.address || tx.address;
  const name = contactName(contacts, destination);
  return name ? `Sent to ${name}` : destination ? `Sent to ${shortAddress(destination, 5)}` : 'Sent';
}
/** Transactions grouped by day. `grouped=false` renders a compact list (overview). */
export function TransactionRows({ transactions, onSelect, grouped = true }: { transactions: Transaction[]; onSelect: (tx: Transaction) => void; grouped?: boolean }) {
  const { snapshot } = useWallet();
  const label = (index: number) => { const found = snapshot?.addresses.find(item => item.index === index); return found?.label || (index === 0 ? undefined : `Subaddress #${index}`); };
  const rows: ReactNode[] = []; let day = '';
  for (const tx of transactions) {
    const nextDay = dayLabel(tx.timestamp);
    if (grouped && nextDay !== day) { day = nextDay; rows.push(<div className="tx-day" key={`day-${tx.txid}-${nextDay}`}>{nextDay}</div>); }
    const incoming = isIncoming(tx);
    rows.push(<button className="transaction-row" key={`${tx.txid}-${tx.type}`} onClick={() => onSelect(tx)}>
      <span className={`tx-icon ${incoming ? 'incoming' : 'outgoing'} ${tx.type === 'failed' ? 'failed' : ''}`}>{incoming ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}</span>
      <span className="tx-description"><strong>{txTitle(tx, snapshot?.contacts, label)}</strong><span>{tx.timestamp ? (grouped ? timeLabel(tx.timestamp) : new Date(tx.timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) : 'Awaiting confirmation'}<span className="tx-dot">·</span><span className="mono">{shortAddress(tx.txid, 6)}</span></span></span>
      <span className="tx-value"><Amount value={tx.amount} sign={incoming ? '+' : '−'} className={incoming ? 'green-text' : ''} /><StatusPill tx={tx} /></span>
    </button>);
  }
  return <div className="transaction-list">{rows}</div>;
}
