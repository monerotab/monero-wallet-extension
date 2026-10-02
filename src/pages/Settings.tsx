import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, Download, Eye, KeyRound, LockKeyhole, Pencil, RefreshCw, RotateCcw, Save, ShieldCheck, Trash2 } from 'lucide-react';
import type { AutoLockMinutes, WalletKeys, WalletSettings } from '../lib/types';
import { inExtension } from '../lib/api';
import { downloadText } from '../lib/money';
import { restoreHeightFromDate, localDateString, networkStartDate } from '../lib/restore-height';
import { useWallet } from '../components/WalletContext';
import { CopyButton, ErrorBox, Modal, Spinner } from '../components/ui';
import { ConfirmDialog, PasswordField } from '../components/SensitiveDialogs';
import NodeSettings from '../components/NodeSettings';
import MessageTools from '../components/MessageTools';
import { APP_VERSION } from '../lib/version';
import { nodeLabel } from '../lib/node-names';
import { useTheme } from '../lib/theme';
import { readPendingNode } from '../lib/node-permissions';

type Tab = 'wallet' | 'node' | 'tools' | 'info';
type Dialog = 'close' | 'password' | 'rename' | 'keys' | 'rescan' | 'delete' | 'gate-off' | null;
const tabs: { id: Tab; label: string }[] = [{ id: 'wallet', label: 'Wallet' }, { id: 'node', label: 'Node' }, { id: 'info', label: 'Info' }, { id: 'tools', label: 'Tools' }];
const LOCK_OPTIONS: AutoLockMinutes[] = [1, 5, 15, 30, 60];

function strength(password: string): { score: 0 | 1 | 2 | 3; label: string } {
  let score = 0;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password) || password.trim().split(/\s+/).length >= 4) score++;
  const clamped = Math.min(3, score) as 0 | 1 | 2 | 3;
  return { score: clamped, label: ['Weak', 'Fair', 'Good', 'Strong'][clamped] };
}

export default function Settings({ backup }: { setup: () => void; backup: () => void }) {
  const wallet = useWallet(); const reduced = useReducedMotion(); const [theme, setTheme] = useTheme();
  const api = wallet.request; const status = wallet.status;
  const [tab, setTab] = useState<Tab>(status?.nodeId ? 'wallet' : 'node');
  const [error, setError] = useState(''); const [busy, setBusy] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [oldPassword, setOldPassword] = useState(''); const [newPassword, setNewPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState(''); const [keys, setKeys] = useState<WalletKeys | null>(null);
  const [rescanMode, setRescanMode] = useState<'height' | 'date'>('height'); const [rescanHeight, setRescanHeight] = useState(''); const [rescanDate, setRescanDate] = useState('');
  const [deleteName, setDeleteName] = useState('');
  // Reopen on the Node tab when Chrome's permission prompt closed the popup mid-way.
  useEffect(() => { void readPendingNode(status?.walletOpen ? status.vaultId : undefined).then(pending => { if (pending) setTab('node'); }); }, []);
  const open = wallet.connected && !!status?.walletOpen;
  const canWrite = open && !status?.syncing && !busy;
  const network = status?.network && status.network !== 'unknown' ? status.network : 'mainnet';
  async function run(key: string, action: () => Promise<void>) {
    setBusy(key); setError('');
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  const save = () => run('save', async () => { await api('wallet.save'); await wallet.refresh(); wallet.notify('Encrypted wallet saved'); });
  const sync = () => run('sync', async () => { await wallet.sync(); wallet.notify('Synchronization started. You may close the popup.'); });
  const exportWallet = () => run('export', async () => { const result = await api<{ filename: string; content: string }>('wallet.export'); downloadText(result.content, result.filename, 'application/json'); wallet.notify('Encrypted backup downloaded. Keep its password safe.'); });
  const updateSettings = (patch: Partial<WalletSettings>) => run('settings', async () => { await api<WalletSettings>('wallet.settings', patch); await wallet.refresh(); wallet.notify('Setting saved'); });
  function closeDialog() { setOldPassword(''); setNewPassword(''); setConfirmPassword(''); setKeys(null); setDeleteName(''); setError(''); setDialog(null); }
  function openDialog(next: Dialog) {
    setError(''); setOldPassword(''); setKeys(null);
    if (next === 'rename') setName(wallet.walletName);
    if (next === 'rescan') { setRescanMode('height'); setRescanHeight(String(status?.restoreHeight ?? 0)); setRescanDate(''); }
    setDialog(next);
  }
  const rescanTarget = rescanMode === 'height' ? (/^\d{1,9}$/.test(rescanHeight) ? { ok: true as const, height: Number(rescanHeight) } : { ok: false as const, message: 'Enter a block height (digits only).' })
    : rescanDate ? restoreHeightFromDate(rescanDate, network) : { ok: false as const, message: 'Choose a date.' };
  const syncStatus = status?.syncing ? (status.rescanning ? 'Rescanning' : 'Synchronizing') : status?.synced === true ? 'Synchronized' : open ? 'Sync required' : 'Locked';
  const passwordStrength = strength(newPassword);
  return <div className="page-content">
    <div className="page-heading"><h1>Settings</h1><span className="subtle-tag">VERSION {APP_VERSION}</span></div>
    <div className="settings-tabs" role="tablist" aria-label="Settings sections">{tabs.map((item, index) => <button key={item.id} id={`settings-tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`settings-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)} onKeyDown={event => { let next = index; if (event.key === 'ArrowRight') next = (index + 1) % tabs.length; else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = tabs.length - 1; else return; event.preventDefault(); setTab(tabs[next].id); document.getElementById(`settings-tab-${tabs[next].id}`)?.focus(); }}>{item.label}</button>)}</div>
    {error && !dialog && <ErrorBox>{error}</ErrorBox>}
    <AnimatePresence mode="wait" initial={false}><motion.div key={tab} role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} initial={{ opacity: 0, y: reduced ? 0 : 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.14 }}>
      {tab === 'node' && <NodeSettings />}
      {tab === 'tools' && <MessageTools />}
      {tab === 'wallet' && <>
        <section className="settings-card">
          <div className="section-title"><h2>Wallet security</h2><span className="subtle-tag">{wallet.walletName}</span></div>
          <div className="setting-row"><div><strong>Wallet name</strong><p>{wallet.walletName} · shown when you unlock.</p></div><button className="button secondary small" disabled={!canWrite} onClick={() => openDialog('rename')}><Pencil size={13} />Rename wallet</button></div>
          <div className="setting-row"><div><strong>Recovery phrase</strong><p>Your 25-word offline backup. Requires your password.</p></div><button className="button secondary small" disabled={!canWrite} onClick={backup}><KeyRound size={14} />Show seed</button></div>
          <div className="setting-row"><div><strong>Wallet password</strong><p>Encrypts the wallet stored on this device.</p></div><button className="button secondary small" disabled={!canWrite} onClick={() => openDialog('password')}>Change password</button></div>
          <div className="setting-row"><div><strong>Confirm payments with password</strong><p>Ask for your password before every payment is broadcast.</p></div><button className={`toggle ${status?.confirmWithPassword ? 'on' : ''}`} role="switch" aria-checked={!!status?.confirmWithPassword} aria-label="Confirm payments with password" disabled={!canWrite} onClick={() => status?.confirmWithPassword ? openDialog('gate-off') : void updateSettings({ confirmWithPassword: true })}><span /></button></div>
          <div className="setting-row"><div><strong>Automatic lock</strong><p>After this long without interaction; active work finishes first.</p></div>
            <select className="compact-select" aria-label="Automatic lock" value={status?.autoLockMinutes ?? 5} disabled={!canWrite} onChange={e => void updateSettings({ autoLockMinutes: Number(e.target.value) as AutoLockMinutes })}>{LOCK_OPTIONS.map(value => <option key={value} value={value}>{value === 60 ? '1 hour' : `${value} minute${value === 1 ? '' : 's'}`}</option>)}</select></div>
          <div className="setting-row"><div><strong>Hide balances</strong><p>Mask amounts throughout the wallet.</p></div><button className={`toggle ${wallet.hidden ? 'on' : ''}`} role="switch" aria-checked={wallet.hidden} aria-label="Hide balances" onClick={() => wallet.setHidden(!wallet.hidden)}><span /></button></div>
          <div className="setting-row"><div><strong>Light theme</strong><p>Easier to read in bright rooms. Saved on this device.</p></div><button className={`toggle ${theme === 'light' ? 'on' : ''}`} role="switch" aria-checked={theme === 'light'} aria-label="Light theme" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}><span /></button></div>
        </section>
        <section className="settings-card">
          <div className="section-title"><h2>Wallet backup</h2></div>
          <p className="muted">Keep an encrypted export and an offline recovery phrase. There is no password reset service.</p>
          <div className="backup-actions">
            <button className="button secondary" disabled={!canWrite} onClick={() => void save()}>{busy === 'save' ? <Spinner /> : <Save size={15} />}Save wallet</button>
            <button className="button secondary" disabled={!canWrite} onClick={() => void exportWallet()}>{busy === 'export' ? <Spinner /> : <Download size={15} />}Export encrypted backup</button>
            <button className="button secondary" disabled={!open || !!busy} onClick={() => setDialog('close')}><LockKeyhole size={15} />Lock wallet</button>
          </div>
          <p className="form-footnote">Removing this extension or clearing its browser data can erase saved wallets. Exports require the password they were created with.</p>
        </section>
        <section className="settings-card">
          <div className="section-title"><h2>Advanced</h2></div>
          <div className="setting-row"><div><strong>View-only keys</strong><p>Primary address and view key, e.g. for a watch-only wallet or an auditor.</p></div><button className="button secondary small" disabled={!canWrite} onClick={() => openDialog('keys')}><Eye size={13} />Show keys</button></div>
          <div className="setting-row"><div><strong>Rescan blockchain</strong><p>Scan again from block {(status?.restoreHeight ?? 0).toLocaleString()} if a payment is missing or the restore height was wrong.</p></div><button className="button secondary small" disabled={!canWrite || !status?.nodeId} title={status?.nodeId ? undefined : 'Choose a node first'} onClick={() => openDialog('rescan')}><RotateCcw size={13} />Rescan</button></div>
          <div className="setting-row danger-row"><div><strong>Delete wallet from this browser</strong><p>Removes the encrypted wallet. Only your recovery phrase or a backup can restore it.</p></div><button className="button danger small" disabled={!canWrite} onClick={() => openDialog('delete')}><Trash2 size={13} />Delete wallet</button></div>
        </section>
      </>}
      {tab === 'info' && <section className="settings-card">
        <div className="section-title"><h2>Wallet information</h2><span className={`status-label ${wallet.connected ? 'green-text' : ''}`}><span className="status-dot" />{wallet.connected ? 'Engine ready' : 'Starting'}</span></div>
        <dl className="detail-list">
          <div><dt>Wallet name</dt><dd>{wallet.walletName}</dd></div>
          <div><dt>Network</dt><dd className="capitalize">{status?.network}</dd></div>
          <div><dt>Wallet height</dt><dd>{status?.height.toLocaleString()}</dd></div>
          <div><dt>Restore height</dt><dd>{status?.restoreHeight?.toLocaleString() ?? '—'}</dd></div>
          <div><dt>Synchronization</dt><dd>{syncStatus}</dd></div>
          <div><dt>Selected node</dt><dd>{status?.nodeId ? status.nodeName || nodeLabel(status.nodeId) : 'Not selected'}</dd></div>
          {status?.nodeUrl && <div><dt>Node address</dt><dd className="mono">{status.nodeUrl}</dd></div>}
          <div><dt>Last successful sync</dt><dd>{status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : 'Not yet synchronized'}</dd></div>
          <div><dt>Engine</dt><dd>Monero · WebAssembly</dd></div>
          <div><dt>Interface</dt><dd>{inExtension ? 'Chrome extension · popup' : 'Development preview'}</dd></div>
        </dl>
        {status?.syncError && <ErrorBox>{status.syncError}</ErrorBox>}
        <div className="backup-actions"><button className="button primary" disabled={!open || !status?.nodeId || status.syncing || !!busy} onClick={() => void sync()}>{status?.syncing || busy === 'sync' ? <Spinner /> : <RefreshCw size={15} />}Sync wallet</button></div>
        <div className="inline-info"><ShieldCheck size={17} /><span>Opening a wallet stays offline. Synchronization starts only when you request it and can download substantial data. The engine stays inside Chrome when you close the popup; restarting Chrome locks it.</span></div>
        <p className="form-footnote">Independent project. Not an official Monero release or an independently audited wallet.</p>
      </section>}
    </motion.div></AnimatePresence>
    <AnimatePresence>
      {dialog === 'close' && <ConfirmDialog key="lock" title="Lock this wallet?" message="Save the encrypted wallet and remove unlocked keys from memory. Synchronization will stop and save its progress. Your password will be required to open the wallet again." confirmLabel="Save & lock" onClose={() => setDialog(null)} onConfirm={async () => { await wallet.close(); wallet.notify('Wallet locked'); }} />}
      {dialog === 'gate-off' && <Modal key="gate-off" title="Turn off password confirmation?" onClose={closeDialog} busy={!!busy}>
        <form className="form-stack" onSubmit={event => { event.preventDefault(); void run('gate-off', async () => { await api<WalletSettings>('wallet.settings', { confirmWithPassword: false, password: oldPassword }); setOldPassword(''); await wallet.refresh(); closeDialog(); wallet.notify('Payments no longer ask for your password'); }); }}>
          <p className="muted">Anyone with access to this unlocked wallet could then send payments without knowing your password.</p>
          {error && <ErrorBox>{error}</ErrorBox>}
          <PasswordField value={oldPassword} onChange={setOldPassword} />
          <div className="button-row"><button type="button" className="button secondary" onClick={closeDialog} disabled={!!busy}>Keep it on</button><button className="button primary" disabled={!oldPassword || !!busy}>{busy ? <Spinner /> : <Check size={16} />}Turn off</button></div>
        </form>
      </Modal>}
      {dialog === 'rename' && <Modal key="rename" title="Rename wallet" onClose={closeDialog} busy={!!busy}>
        <form className="form-stack" onSubmit={event => { event.preventDefault(); const value = name.trim(); if (!value || /[\\/\x00-\x1f\x7f]/.test(value)) { setError('Use 1–64 characters, without slashes or control characters.'); return; } void run('rename', async () => { await api('wallet.rename', { name: value }); await wallet.refresh(); closeDialog(); wallet.notify('Wallet renamed'); }); }}>
          {error && <ErrorBox>{error}</ErrorBox>}
          <label>Wallet name<input value={name} onChange={e => setName(e.target.value)} maxLength={64} required /></label>
          <p className="form-footnote">Only changes the name shown in this browser. Addresses, keys and backups are unaffected.</p>
          <button className="button primary" disabled={!!busy || !name.trim()}>{busy ? <Spinner /> : <Check size={16} />}Save name</button>
        </form>
      </Modal>}
      {dialog === 'password' && <Modal key="password" title="Change wallet password" onClose={closeDialog} busy={!!busy}>
        <form className="form-stack" onSubmit={event => {
          event.preventDefault(); setError('');
          if (!canWrite) { setError('Wait for synchronization to finish before changing the password.'); return; }
          if (newPassword !== confirmPassword) { setError('The new passwords do not match.'); return; }
          if (newPassword.trim().length < 8) { setError('Use at least 8 non-padding characters.'); return; }
          if (newPassword === oldPassword) { setError('Choose a password different from the current one.'); return; }
          void run('password', async () => { try { await api('wallet.password', { oldPassword, newPassword }); closeDialog(); wallet.notify('Password changed. Export a fresh encrypted backup.'); } catch (e) { await wallet.refresh(); throw e; } });
        }}>
          {error && <ErrorBox>{error}</ErrorBox>}
          <label>Current password<input type="password" required maxLength={256} autoComplete="current-password" value={oldPassword} onChange={e => setOldPassword(e.target.value)} /></label>
          <label>New password<input type="password" minLength={8} maxLength={256} required autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} /></label>
          {newPassword && <div className={`strength-meter s${passwordStrength.score}`} aria-live="polite"><span><i /><i /><i /><i /></span>{passwordStrength.label}</div>}
          <label>Confirm new password<input type="password" minLength={8} maxLength={256} required autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} aria-invalid={!!confirmPassword && confirmPassword !== newPassword} /></label>
          <p className="form-footnote">Old exported backups keep their old password. Your recovery phrase does not change.</p>
          <button className="button primary" disabled={!canWrite}>{busy ? <Spinner /> : <Check size={16} />}Change password</button>
        </form>
      </Modal>}
      {dialog === 'keys' && <Modal key="keys" title="View-only keys" eyebrow="SHARE WITH CARE" onClose={closeDialog} busy={!!busy}>
        {keys ? <div className="form-stack">
          <div className="warning-box"><ShieldCheck size={18} /><span>The private view key reveals every incoming payment and your balance history. It cannot spend funds. The spend key is never shown.</span></div>
          {([['Primary address', keys.primaryAddress], ['Private view key', keys.privateViewKey], ['Public view key', keys.publicViewKey], ['Public spend key', keys.publicSpendKey]] as const).map(([label, value]) => <div className="field" key={label}><span className="field-label">{label}<CopyButton text={value} small label={`Copy ${label.toLowerCase()}`} /></span><code className="address-plain">{value}</code></div>)}
          <button className="button primary" onClick={closeDialog}><Check size={16} />Done</button>
        </div> : <form className="form-stack" onSubmit={event => { event.preventDefault(); void run('keys', async () => { const result = await api<WalletKeys>('wallet.keys', { password: oldPassword }); setOldPassword(''); setKeys(result); }); }}>
          {error && <ErrorBox>{error}</ErrorBox>}
          <PasswordField value={oldPassword} onChange={setOldPassword} />
          <button className="button primary" disabled={!oldPassword || !!busy}>{busy ? <Spinner /> : <Eye size={15} />}Show keys</button>
        </form>}
      </Modal>}
      {dialog === 'rescan' && <Modal key="rescan" title="Rescan the blockchain" onClose={closeDialog} busy={!!busy}>
        <form className="form-stack" onSubmit={event => { event.preventDefault(); if (!rescanTarget.ok) { setError(rescanTarget.message); return; } const height = rescanTarget.height; void run('rescan', async () => { await api('wallet.rescan', { restoreHeight: height }); closeDialog(); await wallet.refresh(); wallet.notify(`Rescan started from block ${height.toLocaleString()}. You may close the popup.`); }); }}>
          {error && <ErrorBox>{error}</ErrorBox>}
          <p className="muted">Downloads and scans blocks again through {status?.nodeName || nodeLabel(status?.nodeId)}. This can take a long time; a lower height takes longer.</p>
          <p className="form-footnote">Amounts, fees, notes, labels and contacts are kept. Recipient addresses of earlier outgoing payments are not stored on the blockchain and will no longer be shown.</p>
          <div className="segmented-control" role="group" aria-label="Rescan from">{(['height', 'date'] as const).map(mode => <button type="button" key={mode} className={rescanMode === mode ? 'active' : ''} aria-pressed={rescanMode === mode} onClick={() => setRescanMode(mode)}>{mode === 'height' ? 'Block height' : 'Date'}</button>)}</div>
          {rescanMode === 'height' ? <label>Start at block height<input inputMode="numeric" value={rescanHeight} onChange={e => setRescanHeight(e.target.value.replace(/\D/g, '').slice(0, 9))} /></label>
            : <label>Wallet creation date<input type="date" min={networkStartDate(network)} max={localDateString()} value={rescanDate} onChange={e => setRescanDate(e.target.value)} /></label>}
          <div className={`field-help ${rescanTarget.ok ? '' : 'error'}`}>{rescanTarget.ok ? `Scanning starts at block ${rescanTarget.height.toLocaleString()}.` : rescanMode === 'date' && !rescanDate ? '' : rescanTarget.message}</div>
          <button className="button primary" disabled={!rescanTarget.ok || !!busy}>{busy ? <Spinner /> : <RotateCcw size={15} />}Start rescan</button>
        </form>
      </Modal>}
      {dialog === 'delete' && <Modal key="delete" title="Delete this wallet?" eyebrow="PERMANENT" onClose={closeDialog} busy={!!busy}>
        <form className="form-stack" onSubmit={event => { event.preventDefault(); void run('delete', async () => { await api('wallet.delete', { password: oldPassword }); setOldPassword(''); setDialog(null); localStorage.removeItem('monero-gui-last-wallet'); await wallet.refresh(); wallet.notify('Wallet deleted from this browser'); }); }}>
          <div className="error-box"><Trash2 size={18} /><span>“{wallet.walletName}” will be erased from this browser. Without your 25-word recovery phrase or an encrypted backup, the funds in it are lost forever.</span></div>
          {error && <ErrorBox>{error}</ErrorBox>}
          <label>Type the wallet name to confirm<input value={deleteName} onChange={e => setDeleteName(e.target.value)} placeholder={wallet.walletName} autoComplete="off" /></label>
          <PasswordField value={oldPassword} onChange={setOldPassword} />
          <div className="button-row"><button type="button" className="button secondary" onClick={closeDialog} disabled={!!busy}>Cancel</button><button className="button danger" disabled={deleteName !== wallet.walletName || !oldPassword || !!busy}>{busy ? <Spinner /> : <Trash2 size={15} />}Delete wallet</button></div>
        </form>
      </Modal>}
    </AnimatePresence>
  </div>;
}
