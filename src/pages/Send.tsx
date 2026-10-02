import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence } from 'motion/react';
import { AlertTriangle, ArrowRight, BookUser, Check, CircleCheck, ClipboardPaste, Clock3, LockKeyhole, RefreshCw, ShieldCheck, UserPlus, X } from 'lucide-react';
import { formatXmr, toAtomic, toDecimal } from '../lib/money';
import { checkAddress, describeAddress, parsePaymentUri } from '../lib/address';
import { countdown } from '../lib/format';
import type { Draft } from '../lib/types';
import { useWallet } from '../components/WalletContext';
import { AddressBlock, Amount, CopyButton, ErrorBox, Modal, Spinner, contactName } from '../components/ui';
import { PasswordField } from '../components/SensitiveDialogs';

export interface SendPrefill { address: string; amount?: string; description?: string; key?: number }
const PRIORITIES = [
  { value: 0, label: 'Automatic', hint: 'Recommended. Uses Low unless the network is busy.' },
  { value: 1, label: 'Low', hint: 'Cheapest. May wait longer when blocks are full.' },
  { value: 2, label: 'Normal', hint: 'About 5× the low fee.' },
  { value: 3, label: 'Fast', hint: 'About 25× the low fee.' },
  { value: 4, label: 'Fastest', hint: 'About 1000× the low fee. For urgent payments only.' },
];

export default function Send({ setup, settings, prefill, contacts }: { setup: () => void; settings: () => void; prefill: SendPrefill | null; contacts: () => void }) {
  const { ready, status, snapshot, accountIndex, refresh, sync, pendingTransfer, notify, request: api } = useWallet();
  const [address, setAddress] = useState(''); const [amount, setAmount] = useState(''); const [priority, setPriority] = useState(0);
  const [sendAll, setSendAll] = useState(false); const [description, setDescription] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmed, setConfirmed] = useState(false); const [sent, setSent] = useState<{ txHash: string; address: string; amount: string } | null>(null);
  const [now, setNow] = useState(Date.now()); const [picker, setPicker] = useState(false); const [saveContact, setSaveContact] = useState(false);
  const [password, setPassword] = useState(''); const needsPassword = !!status?.confirmWithPassword;
  const freshSync = status?.lastSyncAt === undefined || now - status.lastSyncAt <= 120_000;
  const canSend = ready && status?.synced === true && !status.syncing && freshSync;
  const lock = useRef(false); const draftRef = useRef<Draft | null>(null); draftRef.current = draft;
  const network = snapshot?.network !== 'unknown' ? snapshot?.network : undefined;
  const addressInfo = useMemo(() => describeAddress(address, network), [address, network]);
  const known = contactName(snapshot?.contacts, address.trim());
  const unlocked = BigInt(snapshot?.unlockedBalance ?? '0');
  let atomic: bigint | null = null; let amountError = '';
  if (sendAll) atomic = unlocked;
  else if (amount) { try { atomic = toAtomic(amount); if (atomic <= 0n) amountError = 'Enter an amount greater than zero.'; else if (atomic > unlocked) amountError = 'This is more than your unlocked balance.'; else if (atomic === unlocked) amountError = 'Leave room for the network fee, or use Max to send your whole balance.'; } catch (e) { amountError = (e as Error).message; } }
  const addressValid = checkAddress(address).valid && addressInfo.tone === 'valid';
  const formReady = canSend && addressValid && atomic !== null && atomic > 0n && !amountError && !pendingTransfer;

  // Countdown ticks every second only while a review is open; otherwise a slower tick keeps sync freshness current.
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), draft ? 1000 : 10_000); return () => clearInterval(timer); }, [draft]);
  useEffect(() => { setAddress(''); setAmount(''); setSendAll(false); setDescription(''); }, [status?.vaultId]);
  useEffect(() => () => { if (draftRef.current) void api('tx.cancel', { draftId: draftRef.current.draftId }).catch(() => {}); }, []);
  useEffect(() => {
    const previous = draftRef.current;
    setDraft(null); setConfirmed(false); setSent(null); setSendAll(false);
    if (previous) void api('tx.cancel', { draftId: previous.draftId }).catch(() => {});
  }, [accountIndex, status?.vaultId, status?.nodeId]);
  useEffect(() => {
    if (!prefill) return;
    setAddress(prefill.address); setAmount(prefill.amount ?? ''); setDescription(prefill.description ?? ''); setSendAll(false); setSent(null); setError('');
  }, [prefill?.key]);
  // Never expire a review underneath an in-flight confirmation: its outcome must not be reported as "nothing sent".
  useEffect(() => { if (draft && now >= draft.expiresAt && !lock.current) void cancel(true); }, [now, draft]);

  function applyAddressInput(value: string) {
    const uri = parsePaymentUri(value);
    if (uri && 'error' in uri) { setAddress(value.trim()); setError(uri.error); return; }
    if (uri) {
      setAddress(uri.address); setError('');
      if (uri.amount) { setAmount(uri.amount); setSendAll(false); }
      if (uri.description || uri.recipientName) setDescription([uri.recipientName, uri.description].filter(Boolean).join(' · '));
      notify('Payment request filled in. Check every field before sending.', 'info');
      return;
    }
    setAddress(value.replace(/\s+/g, ''));
  }
  async function paste() {
    try { applyAddressInput(await navigator.clipboard.readText()); }
    catch { notify('Clipboard unavailable. Paste with Ctrl+V instead.', 'error'); }
  }
  async function prepare(e: FormEvent) {
    e.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError(''); setSent(null);
    try {
      if (!ready) throw new Error('Unlock a wallet before sending Monero.');
      if (!canSend) throw new Error('Complete a fresh wallet synchronization before preparing a transaction.');
      if (pendingTransfer) throw new Error('Resolve the previous transfer outcome before preparing another payment.');
      if (!addressValid) throw new Error(addressInfo.message || 'Enter a valid Monero address.');
      if (amountError || atomic === null || atomic <= 0n) throw new Error(amountError || 'Enter an amount.');
      const requested = sendAll ? toDecimal(unlocked) : amount;
      const prepared = await api<Draft>('tx.prepare', { accountIndex, address: address.trim(), amount: requested, priority, ...(sendAll ? { subtractFee: true } : {}) });
      setConfirmed(false); setSaveContact(false); setDraft(prepared);
    } catch (e) { setError((e as Error).message); } finally { lock.current = false; setBusy(false); }
  }
  async function send() {
    if (!draft || !confirmed || lock.current || pendingTransfer || !canSend || now >= draft.expiresAt || (needsPassword && !password)) return;
    lock.current = true; setBusy(true); setError('');
    const current = draft;
    try {
      // The service persists the recovery marker before relay and clears it only after durable success.
      const secret = password; setPassword('');
      const result = await api<{ txHash: string }>('tx.confirm', needsPassword ? { draftId: current.draftId, password: secret } : { draftId: current.draftId });
      setSent({ txHash: result.txHash, address: current.address, amount: current.amount });
      if (description.trim()) await api('tx.note', { txid: result.txHash, note: description.trim().slice(0, 2000) }).catch(() => {});
      if (saveContact && !contactName(snapshot?.contacts, current.address)) await api('contact.add', { address: current.address, description: description.trim().slice(0, 200) || 'Recipient' }).catch(() => {});
      setAddress(''); setAmount(''); setSendAll(false); setDescription(''); await refresh();
    } catch (e) {
      const code = (e as Error & { code?: string }).code;
      // Password gate failures are checked before anything is relayed: the form stays filled for a new review.
      if (code === 'WRONG_PASSWORD' || code === 'PASSWORD_REQUIRED') setError((e as Error).message);
      else setError(`${(e as Error).message} The transaction was not retried. Check your transaction history before preparing another payment.`);
    } finally { setDraft(null); setConfirmed(false); setPassword(''); lock.current = false; setBusy(false); }
  }
  async function cancel(expired = false) {
    if (lock.current || (busy && !expired)) return;
    const id = draft?.draftId; setDraft(null); setConfirmed(false); setPassword('');
    if (expired) setError('The review expired after 5 minutes. Nothing was sent; review the payment again.');
    if (id) await api('tx.cancel', { draftId: id }).catch(() => {});
  }
  const remaining = draft ? draft.expiresAt - now : 0;
  const selectedPriority = PRIORITIES.find(item => item.value === priority)!;
  return <div className="page-content">
    <div className="page-heading"><h1>Send</h1><span className="subtle-tag">{snapshot?.network.toUpperCase()} · XMR</span></div>
    {!status?.walletOpen && <div className="connection-notice"><LockKeyhole size={18} /><span>Unlock your encrypted wallet to send XMR.</span><button className="text-button" onClick={setup}>Open wallet<ArrowRight size={16} /></button></div>}
    {status?.walletOpen && !canSend && <div className="connection-notice">
      <RefreshCw size={18} className={status.syncing ? 'spin' : ''} />
      <span>{status.syncing ? 'Synchronization is in progress. Sending is disabled until it finishes.' : status.nodeId ? 'Complete a fresh sync before sending. Balances from an older scan are not enough to prepare a payment.' : 'Choose a public node in Settings, then synchronize before sending.'}</span>
      {status.nodeId ? <button className="text-button" disabled={status.syncing || busy || !!draft} onClick={async () => { setBusy(true); setError(''); try { await sync(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>Sync wallet<RefreshCw size={15} /></button>
        : <button className="text-button" onClick={settings}>Choose a node<ArrowRight size={15} /></button>}
    </div>}
    {status?.syncError && <ErrorBox>{status.syncError}</ErrorBox>}
    {sent && <div className="success-box sent-box">
      <CircleCheck size={23} />
      <div><strong>{formatXmr(sent.amount)} XMR sent to {contactName(snapshot?.contacts, sent.address) || 'the recipient'}</strong><p className="mono break-all">{sent.txHash}</p><small>Submitted to the network. Confirmation takes about 2 minutes per block; funds are final after 10 confirmations.</small></div>
      <CopyButton text={sent.txHash} small label="Copy transaction ID" />
      <button className="icon-button" aria-label="Dismiss" onClick={() => setSent(null)}><X size={15} /></button>
    </div>}
    <form className="form-stack send-form" onSubmit={prepare} noValidate>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="field">
        <div className="field-label"><label htmlFor="send-address">Recipient</label>
          <span className="field-tools">
            <button type="button" className="text-button" onClick={() => void paste()} disabled={busy}><ClipboardPaste size={13} />Paste</button>
            <button type="button" className="text-button" onClick={() => setPicker(true)} disabled={busy}><BookUser size={13} />Address book</button>
          </span>
        </div>
        <textarea id="send-address" className={`address-input ${addressInfo.tone}`} rows={2} aria-label="Recipient address" aria-invalid={addressInfo.tone === 'error'} aria-describedby="send-address-help"
          value={address} onChange={e => applyAddressInput(e.target.value)} placeholder="Monero address or monero: payment link" spellCheck={false} autoComplete="off" maxLength={4096} disabled={busy} />
        <div id="send-address-help" className={`field-help ${addressInfo.tone}`} aria-live="polite">{known && addressInfo.tone === 'valid' ? <><Check size={12} />{known} · {addressInfo.message}</> : addressInfo.tone === 'valid' ? <><Check size={12} />{addressInfo.message}</> : addressInfo.message}</div>
      </div>
      <div className="field">
        <div className="field-label"><label htmlFor="send-amount">Amount</label><span className="field-hint">Available: <Amount value={snapshot?.unlockedBalance} decimals={12} /></span></div>
        <div className={`input-with-unit amount-input ${amountError ? 'error' : ''}`}>
          <input id="send-amount" aria-label="Amount" inputMode="decimal" maxLength={32} value={sendAll ? `${toDecimal(unlocked)}` : amount} readOnly={sendAll} aria-invalid={!!amountError}
            onChange={e => { setAmount(e.target.value.replace(',', '.').trim()); setSendAll(false); }} placeholder="0.00" disabled={busy} />
          <button type="button" className={`max-button ${sendAll ? 'active' : ''}`} aria-pressed={sendAll} disabled={busy || unlocked === 0n} onClick={() => setSendAll(value => !value)}>{sendAll ? 'All' : 'Max'}</button>
          <span>XMR</span>
        </div>
        <div className={`field-help ${amountError ? 'error' : ''}`}>{amountError || (sendAll ? 'Sends your whole unlocked balance. The network fee is deducted from this amount.' : 'The exact fee is calculated when you review the payment.')}</div>
      </div>
      <div className="field">
        <label htmlFor="send-note">Private note (optional)</label>
        <input id="send-note" value={description} onChange={e => setDescription(e.target.value)} maxLength={200} placeholder="Saved only in this wallet, e.g. Rent for May" disabled={busy} />
      </div>
      <div className="field">
        <span className="field-label" id="priority-label">Fee priority</span>
        <div className="priority-options" role="radiogroup" aria-labelledby="priority-label">{PRIORITIES.map(item => <button type="button" role="radio" aria-checked={priority === item.value} key={item.value} className={priority === item.value ? 'active' : ''} onClick={() => setPriority(item.value)} disabled={busy}>{item.label}</button>)}</div>
        <div className="field-help">{selectedPriority.hint}</div>
      </div>
      <div className="send-actions">
        <button className="button primary" disabled={!formReady || busy}>{busy ? <Spinner /> : <ArrowRight size={17} />}Review transaction</button>
        <small>Nothing is sent until you check the full address, amount and fee.</small>
      </div>
    </form>
    <div className="send-guidance">
      <div><ShieldCheck /><span>Transactions are signed locally. Closing a review does not send a payment.</span></div>
      <div><Clock3 /><span>Already-confirmed payments continue if the popup closes. Never retry an uncertain transfer without checking its transaction ID.</span></div>
    </div>
    <AnimatePresence>
      {picker && <Modal key="picker" title="Choose a recipient" onClose={() => setPicker(false)}>
        {snapshot?.contacts.length ? <div className="contact-picker">{snapshot.contacts.map(contact => {
          const check = checkAddress(contact.address); const mismatch = check.valid && network && check.network !== network;
          return <button key={contact.index} disabled={!!mismatch} onClick={() => { setAddress(contact.address); setError(''); setPicker(false); }}>
            <span className="contact-avatar" aria-hidden="true">{(contact.description || '?').slice(0, 1).toUpperCase()}</span>
            <span><strong>{contact.description || 'Unnamed contact'}</strong><code>{contact.address.slice(0, 12)}…{contact.address.slice(-8)}</code>{mismatch && <small>Different network</small>}</span>
          </button>;
        })}</div> : <div className="form-stack"><p className="muted">Your address book is empty. Save people you pay often; entries are stored only in your encrypted wallet.</p><button className="button secondary" onClick={() => { setPicker(false); contacts(); }}><UserPlus size={15} />Open address book</button></div>}
      </Modal>}
      {draft && <Modal key="review" title="Review your transaction" eyebrow="ONE LAST LOOK" onClose={() => void cancel()} busy={busy}>
        {!canSend && <ErrorBox>Wallet synchronization is not current. Cancel this draft, sync, and prepare a new transaction. Nothing will be sent from this review.</ErrorBox>}
        <div className="form-stack">
          <div className="review-amount"><span>{draft.subtractFee ? 'Recipient receives' : 'You send'}</span><div className="detail-amount">{formatXmr(draft.amount)} <span>XMR</span></div></div>
          <div className="field"><span className="field-label">To {contactName(snapshot?.contacts, draft.address) ? <strong className="review-contact">{contactName(snapshot?.contacts, draft.address)}</strong> : 'address'}<CopyButton text={draft.address} small /></span><AddressBlock address={draft.address} /></div>
          <dl className="detail-list">
            <div><dt>Network</dt><dd className="capitalize">{snapshot?.network || 'Unknown'}</dd></div>
            <div><dt>Network fee{draft.subtractFee ? ' (deducted)' : ''}</dt><dd>{formatXmr(draft.fee)} XMR</dd></div>
            <div className="total-line"><dt>Total leaving your wallet</dt><dd>{formatXmr((BigInt(draft.amount) + BigInt(draft.fee)).toString())} XMR</dd></div>
            <div><dt>Review expires in</dt><dd className={remaining < 60_000 ? 'warning-text' : ''}>{countdown(remaining)}</dd></div>
          </dl>
          <details className="review-details"><summary>Transaction ID</summary><div className="copy-field"><code>{draft.txHash}</code><CopyButton text={draft.txHash} label="Copy prepared transaction ID" small /></div></details>
          <div className="warning-box"><AlertTriangle size={19} /><span>Payments are irreversible. Compare the entire address, not just the first or last characters.</span></div>
          {!contactName(snapshot?.contacts, draft.address) && <label className="checkbox-label"><input type="checkbox" checked={saveContact} onChange={e => setSaveContact(e.target.checked)} disabled={busy} /><span>Save this recipient to my address book</span></label>}
          <label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={busy} /><span>I have checked the address and amount.</span></label>
          {needsPassword && <PasswordField value={password} onChange={setPassword} label="Wallet password to confirm" disabled={busy} />}
          <div className="button-row"><button className="button secondary" onClick={() => void cancel()} disabled={busy}>Cancel</button><button className="button primary" disabled={!confirmed || busy || now >= draft.expiresAt || !canSend || !!pendingTransfer || (needsPassword && !password)} onClick={() => void send()}>{busy ? <Spinner /> : <Check size={17} />}Confirm & send</button></div>
        </div>
      </Modal>}
    </AnimatePresence>
  </div>;
}
