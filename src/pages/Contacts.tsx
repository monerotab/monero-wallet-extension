import { useMemo, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { ArrowUpRight, BookUser, Check, Pencil, Search, Trash2, UserPlus } from 'lucide-react';
import type { Contact } from '../lib/types';
import { checkAddress, describeAddress, parsePaymentUri } from '../lib/address';
import { useWallet } from '../components/WalletContext';
import { AddressBlock, CopyButton, EmptyState, ErrorBox, Modal, Spinner } from '../components/ui';
import { ConfirmDialog } from '../components/SensitiveDialogs';
import type { SendPrefill } from './Send';

type Editing = { mode: 'new' } | { mode: 'edit'; contact: Contact };

export default function Contacts({ sendTo }: { sendTo: (value: SendPrefill) => void }) {
  const { snapshot, status, ready, refresh, notify, request: api } = useWallet();
  const canEdit = ready && !status?.syncing;
  const [search, setSearch] = useState(''); const [editing, setEditing] = useState<Editing | null>(null); const [removing, setRemoving] = useState<Contact | null>(null);
  const [name, setName] = useState(''); const [address, setAddress] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const network = snapshot?.network !== 'unknown' ? snapshot?.network : undefined;
  const contacts = useMemo(() => [...(snapshot?.contacts ?? [])].sort((a, b) => (a.description || '~').localeCompare(b.description || '~')), [snapshot?.contacts]);
  const visible = contacts.filter(contact => `${contact.description} ${contact.address}`.toLowerCase().includes(search.trim().toLowerCase()));
  const info = describeAddress(address, network);
  function open(next: Editing) {
    setError(''); setEditing(next);
    setName(next.mode === 'edit' ? next.contact.description : ''); setAddress(next.mode === 'edit' ? next.contact.address : '');
  }
  function addressInput(value: string) {
    const uri = parsePaymentUri(value);
    if (uri && !('error' in uri)) { setAddress(uri.address); if (!name && uri.recipientName) setName(uri.recipientName); return; }
    setAddress(value.replace(/\s+/g, ''));
  }
  async function save() {
    if (!editing || busy || !canEdit) return;
    const trimmed = address.trim();
    if (!checkAddress(trimmed).valid || info.tone !== 'valid') { setError(info.message || 'Enter a valid Monero address.'); return; }
    const duplicate = contacts.find(contact => contact.address === trimmed && (editing.mode === 'new' || contact.index !== editing.contact.index));
    if (duplicate) { setError(`This address is already saved as “${duplicate.description || 'Unnamed contact'}”.`); return; }
    setBusy(true); setError('');
    try {
      if (editing.mode === 'new') await api('contact.add', { address: trimmed, description: name.trim() });
      else await api('contact.edit', { index: editing.contact.index, expectedAddress: editing.contact.address, address: trimmed, description: name.trim() });
      await refresh(); setEditing(null); notify(editing.mode === 'new' ? 'Contact saved' : 'Contact updated');
    } catch (e) { setError((e as Error).message); await refresh().catch(() => {}); } finally { setBusy(false); }
  }
  return <div className="page-content">
    <div className="page-heading"><h1>Address book</h1><button className="button primary small" disabled={!canEdit} onClick={() => open({ mode: 'new' })}><UserPlus size={15} />Add contact</button></div>
    {contacts.length > 0 && <div className="search-field compact"><Search size={15} /><input aria-label="Search contacts" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or address" /></div>}
    {!contacts.length ? <EmptyState icon={<BookUser size={24} />} title="No contacts yet" description="Save addresses you pay often so you never have to paste them again. Contacts are stored only in your encrypted wallet." action={<button className="button secondary small" disabled={!canEdit} onClick={() => open({ mode: 'new' })}><UserPlus size={14} />Add your first contact</button>} />
      : <div className="contact-list">{visible.map(contact => {
        const check = checkAddress(contact.address); const mismatch = check.valid && network && check.network !== network;
        return <article className="contact-row" key={`${contact.index}-${contact.address}`}>
          <span className="contact-avatar" aria-hidden="true">{(contact.description || '?').slice(0, 1).toUpperCase()}</span>
          <div className="contact-main"><strong>{contact.description || 'Unnamed contact'}</strong><code title={contact.address}>{contact.address.slice(0, 14)}…{contact.address.slice(-10)}</code>{mismatch && <small className="warning-text">Saved for {check.network}; this wallet uses {network}.</small>}</div>
          <div className="row-tools">
            <button className="button secondary small" disabled={!!mismatch} onClick={() => sendTo({ address: contact.address })}><ArrowUpRight size={14} />Send</button>
            <CopyButton text={contact.address} label={`Copy address of ${contact.description || 'contact'}`} small />
            <button className="icon-button" aria-label={`Edit ${contact.description || 'contact'}`} disabled={!canEdit} onClick={() => open({ mode: 'edit', contact })}><Pencil size={14} /></button>
            <button className="icon-button danger" aria-label={`Delete ${contact.description || 'contact'}`} disabled={!canEdit} onClick={() => setRemoving(contact)}><Trash2 size={14} /></button>
          </div>
        </article>;
      })}{!visible.length && <p className="table-empty">No contact matches “{search}”.</p>}</div>}
    <p className="form-footnote contacts-footnote">Contacts are private: they are saved inside your encrypted wallet and included in encrypted backups, never uploaded.</p>
    <AnimatePresence>
      {editing && <Modal key="edit" title={editing.mode === 'new' ? 'Add contact' : 'Edit contact'} onClose={() => setEditing(null)} busy={busy}>
        <form className="form-stack" onSubmit={event => { event.preventDefault(); void save(); }}>
          {error && <ErrorBox>{error}</ErrorBox>}
          <label>Name<input value={name} onChange={e => setName(e.target.value)} maxLength={100} placeholder="e.g. Alice" /></label>
          <div className="field">
            <label htmlFor="contact-address">Monero address</label>
            <textarea id="contact-address" className={`address-input ${info.tone}`} rows={3} value={address} onChange={e => addressInput(e.target.value)} spellCheck={false} autoComplete="off" maxLength={4096} placeholder="Paste an address or monero: link" />
            <div className={`field-help ${info.tone}`} aria-live="polite">{info.tone === 'valid' && <Check size={12} />}{info.message}</div>
          </div>
          <div className="button-row"><button type="button" className="button secondary" onClick={() => setEditing(null)} disabled={busy}>Cancel</button><button className="button primary" disabled={busy || !canEdit || info.tone !== 'valid'}>{busy ? <Spinner /> : <Check size={16} />}{editing.mode === 'new' ? 'Save contact' : 'Save changes'}</button></div>
        </form>
      </Modal>}
      {removing && <ConfirmDialog key="remove" title="Delete this contact?" message={`“${removing.description || 'Unnamed contact'}” will be removed from your encrypted address book. Past transactions are not affected.`} confirmLabel="Delete contact"
        onClose={() => setRemoving(null)} onConfirm={async () => { try { await api('contact.delete', { index: removing.index, expectedAddress: removing.address }); } finally { await refresh().catch(() => {}); } notify('Contact deleted'); }}>
        <AddressBlock address={removing.address} />
      </ConfirmDialog>}
    </AnimatePresence>
  </div>;
}
