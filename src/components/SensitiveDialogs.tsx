import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, Check, KeyRound, Repeat, ShieldAlert } from 'lucide-react';
import type { Transaction } from '../lib/types';
import { formatXmr, toDecimal } from '../lib/money';
import { isIncoming, isPending, txStatus } from '../lib/format';
import type { SendPrefill } from '../pages/Send';
import { useWallet } from './WalletContext';
import { CopyButton, ErrorBox, Modal, Spinner, StatusPill, contactName } from './ui';

export function SeedDialog({ onClose }: { onClose: () => void }) {
  const wallet = useWallet();
  const api = wallet.request;
  const [seed, setSeed] = useState(''); const [ack, setAck] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [password, setPassword] = useState('');
  const revealGeneration = useRef(0);
  useEffect(() => { revealGeneration.current++; setSeed(''); setAck(false); setPassword(''); }, [wallet.status?.vaultId, wallet.status?.walletOpen]);
  useEffect(() => {
    const hide = () => { if (document.hidden) { revealGeneration.current++; setSeed(''); setAck(false); setPassword(''); } };
    document.addEventListener('visibilitychange', hide);
    return () => { revealGeneration.current++; document.removeEventListener('visibilitychange', hide); };
  }, []);
  useEffect(() => {
    if (!seed) return;
    const timer = setTimeout(() => { revealGeneration.current++; setSeed(''); setAck(false); }, 60_000);
    return () => clearTimeout(timer);
  }, [seed]);
  const dismiss = () => { revealGeneration.current++; setSeed(''); setAck(false); setPassword(''); onClose(); };
  return <Modal title="Your recovery phrase" eyebrow="KEEP IT OFFLINE. KEEP IT YOURS." onClose={dismiss} busy={busy}>
    <div className="form-stack"><div className="warning-box"><ShieldAlert size={22} /><span>Anyone with this phrase can spend your Monero. Write it on paper. Never share it, take a screenshot, or store it in the cloud.</span></div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {seed ? <><div className="seed-grid">{seed.split(/\s+/).map((word, i) => <div key={i}><small>{i + 1}</small>{word}</div>)}</div><p className="form-footnote">Hidden after 60 seconds or when you leave this tab. Wallet data is saved encrypted, never as a plaintext phrase by this screen. Keep a separate offline backup.</p><button className="button primary full" onClick={dismiss}><Check size={16} />I have written it down</button></> : <form className="form-stack" onSubmit={async event => { event.preventDefault(); if (document.hidden || !ack || !password) return; const request = ++revealGeneration.current; setBusy(true); setError(''); try { const data = await api<{ seed: string }>('wallet.seed', { password }); setPassword(''); if (request === revealGeneration.current && !document.hidden) setSeed(data.seed); } catch (e) { setPassword(''); if (request === revealGeneration.current) setError((e as Error).message); } finally { setBusy(false); } }}><label className="checkbox-label"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /><span>I am in a private place and understand that this phrase gives full access to my funds.</span></label><PasswordField value={password} onChange={setPassword} disabled={busy} /><button className="button primary full" disabled={!ack || !password || busy || !wallet.status?.walletOpen}>{busy ? <Spinner /> : <KeyRound size={17} />}Reveal recovery phrase</button></form>}
    </div>
  </Modal>;
}
export function TransactionDialog({ transaction: tx, onClose, sendAgain }: { transaction: Transaction; onClose: () => void; sendAgain?: (value: SendPrefill) => void }) {
  const { notify, refresh, snapshot, request: api } = useWallet();
  const [note, setNote] = useState(tx.note); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [txKey, setTxKey] = useState(''); const [keyBusy, setKeyBusy] = useState(false);
  const incoming = isIncoming(tx); const status = txStatus(tx);
  const destinations = tx.destinations.length ? tx.destinations : !incoming && tx.address ? [{ address: tx.address, amount: tx.amount }] : [];
  const receivedOn = incoming ? tx.subaddressIndices.map(index => { const item = snapshot?.addresses.find(value => value.index === index); return item?.label || (index === 0 ? 'Primary address' : `Subaddress #${index}`); }) : [];
  async function loadKey() {
    setKeyBusy(true); setError('');
    try { setTxKey((await api<{ key: string }>('tx.key', { txid: tx.txid })).key); }
    catch (e) { setError((e as Error).message); } finally { setKeyBusy(false); }
  }
  return <Modal title="Transaction details" eyebrow={incoming ? 'RECEIVED MONERO' : 'SENT MONERO'} onClose={onClose}>
    <div className="form-stack">
      <div className="tx-detail-head"><div className={`detail-amount ${incoming ? 'green-text' : ''}`}>{incoming ? '+' : '−'}{formatXmr(tx.amount)} <span>XMR</span></div><StatusPill tx={tx} /></div>
      <dl className="detail-list">
        <div><dt>Status</dt><dd>{status.tone === 'ok' ? `${tx.confirmations.toLocaleString()} confirmations` : tx.type === 'failed' ? 'Failed' : isPending(tx) ? 'Pending · not yet in a block' : `${tx.confirmations} of 10 confirmations${tx.locked ? ' · funds locked' : ''}`}</dd></div>
        {!incoming && <div><dt>Network fee</dt><dd>{formatXmr(tx.fee)} XMR</dd></div>}
        <div><dt>Date</dt><dd>{tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleString() : 'Not confirmed yet'}</dd></div>
        <div><dt>Block height</dt><dd>{tx.height ? tx.height.toLocaleString() : 'Pending'}</dd></div>
        {receivedOn.length > 0 && <div><dt>Received on</dt><dd>{receivedOn.join(', ')}</dd></div>}
      </dl>
      <label>Transaction ID<div className="copy-field"><code>{tx.txid}</code><CopyButton text={tx.txid} label="Copy transaction ID" small /></div></label>
      {destinations.map((destination, index) => <div className="field" key={`${destination.address}-${index}`}>
        <span className="field-label">{contactName(snapshot?.contacts, destination.address) ? <>To <strong>{contactName(snapshot?.contacts, destination.address)}</strong></> : destinations.length > 1 ? `Destination ${index + 1}` : 'Address'}{destinations.length > 1 && <small> · {formatXmr(destination.amount)} XMR</small>}<CopyButton text={destination.address} small /></span>
        <code className="address-plain">{destination.address}</code>
      </div>)}
      {incoming && tx.address && <label>Address<div className="copy-field"><code>{tx.address}</code><CopyButton text={tx.address} small /></div></label>}
      {!incoming && tx.type !== 'failed' && <details className="review-details" onToggle={event => { if ((event.target as HTMLDetailsElement).open && !txKey && !keyBusy) void loadKey(); }}>
        <summary>Proof of payment (transaction key)</summary>
        <p className="form-footnote">Share this key, the transaction ID and the recipient address only with someone who must verify this payment. It reveals this payment to them.</p>
        {keyBusy ? <Spinner /> : txKey ? <div className="copy-field"><code>{txKey}</code><CopyButton text={txKey} label="Copy transaction key" small /></div> : null}
      </details>}
      {error && <ErrorBox>{error}</ErrorBox>}
      <form className="form-stack" onSubmit={async (e: FormEvent) => { e.preventDefault(); setBusy(true); try { await api('tx.note', { txid: tx.txid, note }); await refresh(); notify('Transaction note saved'); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>
        <label>Private note<input maxLength={256} value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note for yourself" /><small>Stored in your local wallet, not on the blockchain.</small></label>
        <div className="button-row">{!incoming && sendAgain && destinations.length === 1 && <button type="button" className="button secondary" onClick={() => sendAgain({ address: destinations[0].address, amount: toDecimal(destinations[0].amount) })}><Repeat size={15} />Send again</button>}<button className="button primary" disabled={busy || note === tx.note}>{busy ? <Spinner /> : <Check size={17} />}Save note</button></div>
      </form>
    </div>
  </Modal>;
}
export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose, children }: { title: string; message: string; confirmLabel: string; onConfirm: () => Promise<void>; onClose: () => void; children?: ReactNode }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <Modal title={title} onClose={onClose} busy={busy}><div className="form-stack"><div className="warning-box"><AlertTriangle size={20} /><span>{message}</span></div>{children}{error && <ErrorBox>{error}</ErrorBox>}<div className="button-row"><button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{busy && <Spinner />}{confirmLabel}</button></div></div></Modal>;
}
/** Password input for sensitive actions. Never pre-filled, never persisted. */
export function PasswordField({ value, onChange, label = 'Wallet password', disabled = false }: { value: string; onChange: (value: string) => void; label?: string; disabled?: boolean }) {
  const [caps, setCaps] = useState(false);
  return <label>{label}<input type="password" name="confirm-password" autoComplete="current-password" maxLength={256} value={value} disabled={disabled}
    onChange={e => onChange(e.target.value)} onKeyUp={e => setCaps(e.getModifierState('CapsLock'))} onBlur={() => setCaps(false)} />{caps && <small className="caps-warning">Caps Lock is on</small>}</label>;
}
