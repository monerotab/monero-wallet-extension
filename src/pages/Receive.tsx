import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Download, Hash, Pencil, Plus, QrCode, Search, Sparkles } from 'lucide-react';
import { downloadText, paymentUri, shortAddress } from '../lib/money';
import { useWallet } from '../components/WalletContext';
import { AddressBlock, Amount, CopyButton, EmptyState, ErrorBox, Modal, Spinner } from '../components/ui';
import type { Address, IntegratedAddress } from '../lib/types';

const labelFor = (index: number, label: string) => label || (index === 0 ? 'Primary address' : `Subaddress ${index}`);

export default function Receive({ setup }: { setup: () => void }) {
  const { snapshot, status, ready, accountIndex, refresh, notify, request: api } = useWallet();
  const canEdit = ready && !status?.syncing;
  const [addressIndex, setAddressIndex] = useState(0); const [amount, setAmount] = useState(''); const [description, setDescription] = useState('');
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'rename'; address: Address } | { mode: 'integrated' } | null>(null);
  const [integrated, setIntegrated] = useState<IntegratedAddress | null>(null); const [paymentId, setPaymentId] = useState('');
  const [label, setLabel] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [search, setSearch] = useState('');
  const qr = useRef<HTMLDivElement>(null);
  useEffect(() => { setAddressIndex(0); setAmount(''); setDescription(''); setSearch(''); }, [accountIndex, status?.vaultId]);
  const addresses = snapshot?.addresses ?? [];
  const selected = addresses.find(item => item.index === addressIndex) || addresses[0];
  const address = selected?.address || snapshot?.address || '';
  const unused = addresses.find(item => item.index > 0 && !item.used);
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? addresses.filter(item => `${item.index} ${labelFor(item.index, item.label)} ${item.address}`.toLowerCase().includes(query)) : addresses;
  }, [addresses, search]);
  let uri = ''; let uriError = '';
  try { uri = paymentUri(address, amount, description); } catch (e) { uriError = (e as Error).message; }
  function openDialog(next: typeof dialog) { setError(''); setLabel(next?.mode === 'rename' ? next.address.label : ''); setIntegrated(null); setPaymentId(''); setDialog(next); }
  async function quickCreate() {
    if (busy || !canEdit) return;
    setBusy(true);
    try { const result = await api<{ index: number }>('address.create', { accountIndex, label: '' }); await refresh(); setAddressIndex(result.index); notify(`Subaddress #${result.index} created and selected`); }
    catch (e) { notify((e as Error).message, 'error'); } finally { setBusy(false); }
  }
  async function makeIntegrated() {
    if (busy) return;
    if (paymentId && !/^[0-9a-fA-F]{16}$/.test(paymentId)) { setError('A payment ID has exactly 16 hexadecimal characters (0-9, a-f).'); return; }
    setBusy(true); setError('');
    try { setIntegrated(await api<IntegratedAddress>('address.integrated', paymentId ? { paymentId: paymentId.toLowerCase() } : {})); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function submit() {
    if (busy || !canEdit || !dialog || dialog.mode === 'integrated') return;
    setBusy(true); setError('');
    try {
      if (dialog.mode === 'create') {
        const result = await api<{ index: number }>('address.create', { accountIndex, label: label.trim() });
        await refresh(); setAddressIndex(result.index); notify('New subaddress created');
      } else {
        await api('address.label', { accountIndex, addressIndex: dialog.address.index, label: label.trim() });
        await refresh(); notify('Address label saved');
      }
      setDialog(null); setLabel('');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="page-content">
    <div className="page-heading"><h1>Receive</h1><span className="subtle-tag">{snapshot?.network.toUpperCase()} · XMR</span></div>
    {ready && address ? <>
      <div className="section-title">
        <h2>Addresses</h2>
        <span className="section-actions">
          {unused && selected?.index !== unused.index && <button className="text-button" onClick={() => setAddressIndex(unused.index)} title="Use an address that has not received funds yet"><Sparkles size={14} />Use unused</button>}
          <span className="subtle-tag">Account #{accountIndex} · {addresses.length}</span>
        </span>
      </div>
      {addresses.length > 6 && <div className="search-field compact"><Search size={15} /><input aria-label="Search addresses" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by label, number or address" /></div>}
      <div className="address-table-wrapper">
        <table className="address-table" aria-label="Receiving addresses"><tbody>{visible.map(item => <tr key={item.index} className={selected?.index === item.index ? 'selected' : ''}>
          <td><button className="address-choice" aria-pressed={selected?.index === item.index} onClick={() => setAddressIndex(item.index)}><span className="address-number">#{item.index}</span>{labelFor(item.index, item.label)}</button></td>
          <td className="address-state">{item.used ? <Amount value={item.balance} /> : <span className="fresh-tag">Unused</span>}</td>
          <td><code>{shortAddress(item.address, 6)}</code></td>
          <td className="row-tools">
            {item.index > 0 && <button className="icon-button" aria-label={`Rename ${labelFor(item.index, item.label)}`} title="Edit label" disabled={!canEdit} onClick={() => openDialog({ mode: 'rename', address: item })}><Pencil size={14} /></button>}
            <CopyButton text={item.address} label={`Copy ${labelFor(item.index, item.label)}`} small />
          </td>
        </tr>)}</tbody></table>
        {!visible.length && <p className="table-empty">No address matches “{search}”.</p>}
      </div>
      <div className="address-toolbar">
        <button className="text-button" disabled={!canEdit} onClick={() => openDialog({ mode: 'create' })}><Plus size={17} />Create new address</button>
        <button className="text-button subtle" disabled={!canEdit || busy} onClick={() => void quickCreate()} title="Create an unlabeled subaddress in one click"><Sparkles size={14} />Quick new address</button>
        <button className="text-button subtle" disabled={!canEdit} onClick={() => openDialog({ mode: 'integrated' })}><Hash size={14} />Integrated address</button>
      </div>
      <div className="receive-qr-area">
        <div>
          <div ref={qr} className="real-qr">{uri ? <QRCodeSVG value={uri} size={176} level="M" marginSize={2} title="Monero payment request" /> : <div className="invalid-qr"><QrCode /><p>Correct the amount<br />to generate a QR code.</p></div>}</div>
          <p className="qr-caption">{labelFor(selected?.index ?? 0, selected?.label || '')}</p>
          <div className="qr-actions"><button className="button primary small" disabled={!uri} onClick={() => { const svg = qr.current?.querySelector('svg'); if (svg) downloadText(new XMLSerializer().serializeToString(svg), 'monero-payment-request.svg', 'image/svg+xml'); }}><Download size={14} />Save QR</button></div>
        </div>
        <div className="receive-payment">
          <label>Amount (optional)<div className="input-with-unit"><input aria-label="Requested amount" inputMode="decimal" maxLength={32} value={amount} onChange={e => setAmount(e.target.value.replace(',', '.').trim())} placeholder="Any amount" /><span>XMR</span></div></label>
          <label>Description (optional)<input value={description} onChange={e => setDescription(e.target.value)} placeholder="Payment description" maxLength={128} /></label>
          <label>Receiving address<div className="address-display"><AddressBlock address={address} /></div></label>
          {selected?.used && <p className="reuse-hint"><Sparkles size={13} />This address has received funds before. A fresh subaddress keeps payments unlinkable.</p>}
          <div className="receive-copy"><CopyButton text={address} /><CopyButton text={uri} label="Copy payment link" /></div>
        </div>
      </div>
      {uriError && <ErrorBox>{uriError}</ErrorBox>}
      <p className="receive-note">Back up your recovery phrase before receiving funds. Use a fresh subaddress for each payer. A QR code is not proof of payment — sync and check Transactions to verify receipt.</p>
    </> : <EmptyState icon={<QrCode size={34} />} title="Wallet address unavailable" description="Unlock your wallet to display its receiving addresses." action={<button className="button primary" onClick={setup}>Open wallet</button>} />}
    <AnimatePresence>{dialog?.mode === 'integrated' && <Modal title="Integrated address" onClose={() => setDialog(null)} busy={busy}>
      <div className="form-stack">
        <p className="muted">An integrated address combines your primary address with a payment ID, so an exchange or merchant can tell your payments apart. For personal use, a fresh subaddress is more private.</p>
        {error && <ErrorBox>{error}</ErrorBox>}
        {integrated ? <>
          <div className="field"><span className="field-label">Integrated address<CopyButton text={integrated.integratedAddress} small label="Copy integrated address" /></span><AddressBlock address={integrated.integratedAddress} /></div>
          <div className="field"><span className="field-label">Payment ID<CopyButton text={integrated.paymentId} small label="Copy payment ID" /></span><code className="address-plain">{integrated.paymentId}</code></div>
          <div className="button-row"><button className="button secondary" onClick={() => { setIntegrated(null); setPaymentId(''); }}>Generate another</button><button className="button primary" onClick={() => setDialog(null)}><Check size={16} />Done</button></div>
        </> : <form className="form-stack" onSubmit={event => { event.preventDefault(); void makeIntegrated(); }}>
          <label>Payment ID (optional)<input value={paymentId} onChange={e => setPaymentId(e.target.value.trim().slice(0, 16))} placeholder="Leave empty for a random ID" spellCheck={false} maxLength={16} /></label>
          <button className="button primary" disabled={busy || !canEdit}>{busy ? <Spinner /> : <Hash size={15} />}Generate</button>
        </form>}
      </div>
    </Modal>}{dialog && dialog.mode !== 'integrated' && <Modal title={dialog.mode === 'create' ? 'Create a subaddress' : 'Edit address label'} onClose={() => setDialog(null)} busy={busy}>
      <form className="form-stack" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <p className="muted">{dialog.mode === 'create' ? 'This address belongs to the selected account. Its label is only visible in your encrypted wallet.' : `Subaddress #${dialog.address.index}. Labels are private and stored only in your encrypted wallet.`}</p>
        {error && <ErrorBox>{error}</ErrorBox>}
        <label>Address label{dialog.mode === 'create' ? ' (optional)' : ''}<input aria-label="Address label" maxLength={64} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Invoice payment" /></label>
        <button className="button primary" disabled={busy || !canEdit}>{busy ? <Spinner /> : dialog.mode === 'create' ? <Plus size={17} /> : <Check size={17} />}{dialog.mode === 'create' ? 'Create subaddress' : 'Save label'}</button>
      </form>
    </Modal>}</AnimatePresence>
  </div>;
}
