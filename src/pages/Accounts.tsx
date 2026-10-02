import { useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { ArrowDownLeft, ArrowRight, Check, Layers3, Pencil, Plus } from 'lucide-react';
import type { Page } from '../lib/types';
import { shortAddress } from '../lib/money';
import { useWallet } from '../components/WalletContext';
import { Amount, CopyButton, EmptyState, ErrorBox, Modal, Spinner } from '../components/ui';

const accountName = (index: number, label: string) => label || (index === 0 ? 'Primary account' : `Account ${index}`);

export default function Accounts({ setup, navigate }: { setup: () => void; navigate?: (page: Page) => void }) {
  const { snapshot, status, ready, accountIndex, setAccountIndex, refresh, notify, request: api } = useWallet();
  const total = snapshot?.accounts.reduce((sum, item) => sum + BigInt(item.balance), 0n) ?? 0n;
  const canEdit = ready && !status?.syncing;
  const [editing, setEditing] = useState<number | 'new' | null>(null); const [label, setLabel] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit() {
    if (editing === null || busy) return;
    setBusy(true); setError('');
    try {
      if (editing === 'new') {
        const result = await api<{ index: number }>('account.create', { label: label.trim() });
        await refresh(); setEditing(null); notify(`Account #${result.index} created`);
      } else {
        await api('account.rename', { accountIndex: editing, label: label.trim() });
        await refresh(); setEditing(null); notify('Account renamed');
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="page-content">
    <div className="page-heading">
      <div><h1>Your accounts</h1><p className="page-subtitle">{snapshot?.accounts.length ? <>{snapshot.accounts.length} account{snapshot.accounts.length === 1 ? '' : 's'} · total <Amount value={total.toString()} /></> : 'Separate your funds. Keep one recovery phrase.'}</p></div>
      <button className="button primary" disabled={!canEdit} onClick={() => { setEditing('new'); setLabel(''); setError(''); }}><Plus size={17} />Create account</button>
    </div>
    {status?.syncing && <div className="inline-info"><Spinner /><span>Account changes are paused while the wallet synchronizes.</span></div>}
    {!snapshot?.accounts.length ? <section className="card"><EmptyState icon={<Layers3 size={28} />} title="One wallet. Room for more." description="Create separate accounts for savings, everyday spending, or anything else. Start by opening your wallet." action={<button className="button primary" onClick={setup}>Open wallet<ArrowRight size={16} /></button>} /></section>
      : <div className="accounts-grid">{snapshot.accounts.map(account => {
        const selected = accountIndex === account.index;
        const name = accountName(account.index, account.label);
        return <section className={`card account-card ${selected ? 'selected' : ''}`} key={account.index}>
          <div className="section-title">
            <span className="subtle-tag">ACCOUNT #{account.index}</span>
            {selected && <span className="current-tag"><Check size={11} />Current</span>}
            <button className="icon-button" title="Rename account" aria-label={`Rename ${account.label || 'account'}`} disabled={!canEdit} onClick={() => { setEditing(account.index); setLabel(account.label); setError(''); }}><Pencil size={15} /></button>
          </div>
          <h2>{name}</h2>
          <div className="account-balance"><Amount value={account.balance} /></div>
          <div className="muted account-available"><Amount value={account.unlockedBalance} /> available</div>
          <div className="account-address"><code>{shortAddress(account.baseAddress, 10)}</code><CopyButton text={account.baseAddress} small label={`Copy address of ${name}`} /></div>
          <div className="account-actions">
            <button className={`button ${selected ? 'selected-button' : 'secondary'}`} disabled={!canEdit || selected} onClick={() => { setAccountIndex(account.index); notify(`Switched to ${name}`); }}>{selected ? <><Check size={16} />Selected account</> : <>Use this account<ArrowRight size={16} /></>}</button>
            {navigate && <button className="text-button" disabled={!canEdit} onClick={() => { if (!selected) setAccountIndex(account.index); navigate('receive'); }}><ArrowDownLeft size={14} />Addresses</button>}
          </div>
        </section>;
      })}</div>}
    <div className="inline-info account-info"><Layers3 size={20} /><span>Each account has its own balance and subaddresses, all backed up by the same recovery phrase. Labels are stored only in your encrypted wallet. Accounts cannot be deleted — that is a Monero wallet rule, not a limitation of this app.</span></div>
    <AnimatePresence>{editing !== null && <Modal title={editing === 'new' ? 'Create an account' : 'Rename account'} onClose={() => setEditing(null)} busy={busy}>
      <form className="form-stack" onSubmit={e => { e.preventDefault(); void submit(); }}>
        {error && <ErrorBox>{error}</ErrorBox>}
        <label>Account name<input value={label} onChange={e => setLabel(e.target.value)} maxLength={64} required={editing === 'new'} placeholder="e.g. Savings" /></label>
        <p className="form-footnote">{editing === 'new' ? 'The new account gets its own primary address and balance. It is backed up by your existing recovery phrase.' : 'This label is stored in your encrypted wallet and is visible only to you.'}</p>
        <button className="button primary" disabled={busy || !canEdit}>{busy ? <Spinner /> : <Check size={16} />}{editing === 'new' ? 'Create account' : 'Save changes'}</button>
      </form>
    </Modal>}</AnimatePresence>
  </div>;
}
