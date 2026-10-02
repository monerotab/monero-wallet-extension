import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { ArrowDownLeft, ArrowUpRight, BookUser, ChevronDown, ChevronRight, Eye, EyeOff, HelpCircle, History, LayoutDashboard, Layers3, LockKeyhole, Maximize2, Moon, RefreshCw, Settings as SettingsIcon, ShieldCheck, Sun } from 'lucide-react';
import type { Page, Transaction } from './lib/types';
import { openWalletWindow } from './lib/api';
import { useTheme } from './lib/theme';
import { nodeLabel } from './lib/node-names';
import { relativeTime } from './lib/format';
import { APP_VERSION } from './lib/version';
import { WalletProvider, useWallet } from './components/WalletContext';
import { Amount, CopyButton, ErrorBox, Logo, Modal, Spinner } from './components/ui';
import { formatXmr } from './lib/money';
import UnlockWallet from './components/UnlockWallet';
import { ConfirmDialog, SeedDialog, TransactionDialog } from './components/SensitiveDialogs';
import Overview from './pages/Overview';
import Send, { type SendPrefill } from './pages/Send';
import Receive from './pages/Receive';
import HistoryPage from './pages/History';
import Contacts from './pages/Contacts';
import Accounts from './pages/Accounts';
import Settings from './pages/Settings';

const navigation: { page: Page; label: string; icon: typeof LayoutDashboard; key: string }[] = [
  { page: 'overview', label: 'Overview', icon: LayoutDashboard, key: '1' },
  { page: 'send', label: 'Send', icon: ArrowUpRight, key: '2' },
  { page: 'receive', label: 'Receive', icon: ArrowDownLeft, key: '3' },
  { page: 'history', label: 'Transactions', icon: History, key: '4' },
  { page: 'contacts', label: 'Address book', icon: BookUser, key: '5' },
  { page: 'accounts', label: 'Account', icon: Layers3, key: '6' },
  { page: 'settings', label: 'Settings', icon: SettingsIcon, key: '7' },
];
function initialPage(): Page { const saved = localStorage.getItem('monero-gui-page'); return navigation.some(item => item.page === saved) ? saved as Page : 'overview'; }
function editable(target: EventTarget | null) { return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)); }

function WalletApp() {
  const wallet = useWallet(); const reduced = useReducedMotion();
  const [page, setPage] = useState<Page>(initialPage);
  const [theme, setTheme] = useTheme();
  const [backup, setBackup] = useState(false); const [help, setHelp] = useState(false); const [lock, setLock] = useState(false);
  const [resolvePending, setResolvePending] = useState<string | null>(null); const [tx, setTx] = useState<Transaction | null>(null);
  const [syncBusy, setSyncBusy] = useState(false); const [prefill, setPrefill] = useState<SendPrefill | null>(null);
  const [now, setNow] = useState(Date.now()); const [switcher, setSwitcher] = useState(false);
  const scroll = useRef<HTMLElement>(null);
  const status = wallet.status; const open = !!status?.walletOpen;
  const account = wallet.snapshot?.accounts.find(item => item.index === wallet.accountIndex);
  useEffect(() => { localStorage.setItem('monero-gui-page', page); scroll.current?.scrollTo({ top: 0 }); if (page !== 'send') setPrefill(null); }, [page]);
  useEffect(() => { setBackup(false); setTx(null); setLock(false); setPrefill(null); setSwitcher(false); }, [status?.vaultId, open]);
  useEffect(() => {
    if (!switcher) return;
    const close = (event: Event) => { if (!(event.target as HTMLElement).closest?.('.account-menu,.account-switcher')) setSwitcher(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSwitcher(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [switcher]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  const navigate = (next: Page) => setPage(next);
  const sendTo = (value: SendPrefill) => { setPrefill({ ...value, key: Date.now() }); setPage('send'); };
  // Alt+1…7 switches sections; never while typing, and never behind a dialog.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || editable(event.target) || document.querySelector('[role=dialog]')) return;
      const item = navigation.find(entry => entry.key === event.key);
      if (item && open) { event.preventDefault(); setPage(item.page); }
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [open]);
  const progress = status?.synced ? 1 : status?.syncing ? status.syncProgress?.percentDone ?? 0 : 0;
  const remaining = status?.syncing && status.syncProgress ? Math.max(0, status.syncProgress.endHeight - status.syncProgress.height) : 0;
  const syncLabel = !open ? 'Wallet is locked' : status?.syncing ? `${status.rescanning ? 'Rescanning' : 'Synchronizing'}${status.syncProgress ? ` · ${Math.floor(progress * 100)}%` : '…'}` : status?.synced ? 'Wallet is synchronized' : 'Wallet needs synchronization';
  const syncDetail = !open ? 'Unlock to synchronize' : status?.syncing ? remaining ? `${remaining.toLocaleString()} blocks remaining` : `Wallet height: ${status.height.toLocaleString()}`
    : status?.lastSyncAt ? `Last sync ${relativeTime(status.lastSyncAt, now)} · height ${status.height.toLocaleString()}` : `Wallet height: ${status?.height.toLocaleString()}`;
  const stateTone = !open ? 'off' : status?.syncing ? 'busy' : status?.synced ? 'ok' : status?.nodeId ? 'warn' : 'off';
  async function sync() {
    if (!status?.nodeId) { navigate('settings'); return; }
    setSyncBusy(true);
    try { await wallet.sync(); } catch (e) { wallet.notify((e as Error).message, 'error'); } finally { setSyncBusy(false); }
  }
  return <div className="gui-shell">
    <a className="skip-link" href="#wallet-main">Skip to content</a>
    <header className="gui-titlebar">
      <div className="titlebar-tools">
        <button className="icon-button" aria-label="Lock wallet" title="Lock wallet" disabled={!open} onClick={() => setLock(true)}><LockKeyhole size={16} /></button>
        <button className="icon-button" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title="Change theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
      </div>
      <div className="titlebar-brand"><Logo /><span>{open ? wallet.walletName : 'MONERO'}</span></div>
      <div className="titlebar-tools right">
        <span className={`title-network ${open && status?.network !== 'mainnet' ? 'test-network' : ''}`}>{open ? status?.network : 'Wallet'}</span>
        <button className="icon-button" aria-label="Open wallet in a window" title="Open a larger wallet window" onClick={() => void openWalletWindow().catch(e => wallet.notify((e as Error).message, 'error'))}><Maximize2 size={15} /></button>
      </div>
    </header>
    <aside className="gui-sidebar">
      <div className="gui-balance-card">
        <div className="balance-monogram" aria-hidden="true">M</div>
        <div className="account-card-top">
          <Logo />
          <button className="account-switcher" disabled={!open || !wallet.snapshot || !!status?.syncing} aria-expanded={switcher} aria-controls="account-menu" onClick={() => setSwitcher(value => !value)} title="Switch account"><small>Account #{wallet.accountIndex}<ChevronDown size={11} /></small><strong>{account?.label || 'Primary account'}</strong></button>
          <button className="icon-button" aria-label={wallet.hidden ? 'Show balance' : 'Hide balance'} disabled={!open} onClick={() => wallet.setHidden(!wallet.hidden)}>{wallet.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
        </div>
        <div className="sidebar-balance"><span>Balance (XMR)</span><strong className={!wallet.hidden && formatXmr(wallet.snapshot?.balance, 12).length > 18 ? 'long-balance' : ''}>{open && wallet.snapshot ? <Amount value={wallet.snapshot.balance} decimals={12} unit={false} /> : '—'}</strong></div>
        <div className="sidebar-unlocked"><span>Unlocked balance</span><strong>{open && wallet.snapshot ? <Amount value={wallet.snapshot.unlockedBalance} decimals={12} unit={false} /> : '—'}</strong></div>
      </div>
      {switcher && wallet.snapshot && <div className="account-menu" id="account-menu" role="group" aria-label="Switch account">
          {wallet.snapshot.accounts.map(item => <button aria-current={item.index === wallet.accountIndex ? 'true' : undefined} key={item.index} onClick={() => { setSwitcher(false); if (item.index !== wallet.accountIndex) wallet.setAccountIndex(item.index); }}>
            <span>{item.label || (item.index === 0 ? 'Primary account' : `Account ${item.index}`)}</span><Amount value={item.balance} unit={false} />
          </button>)}
          <button className="account-menu-manage" onClick={() => { setSwitcher(false); navigate('accounts'); }}><Layers3 size={13} />Manage accounts</button>
        </div>}
      <nav className="gui-nav" aria-label="Wallet navigation">{navigation.map(item => <button key={item.page} onClick={() => navigate(item.page)} className={page === item.page ? 'active' : ''} aria-current={page === item.page ? 'page' : undefined} title={`${item.label} (Alt+${item.key})`}>
        {page === item.page && <motion.span className="nav-active-indicator" layoutId="active-navigation" transition={{ duration: reduced ? 0 : 0.2, ease: 'easeOut' }} />}
        <item.icon size={15} className="nav-icon" aria-hidden="true" />
        <span>{item.label}</span>
        <ChevronRight size={15} strokeWidth={1.3} className="nav-chevron" aria-hidden="true" />
      </button>)}</nav>
      <div className="sidebar-bottom">
        <div className="sync-meter">
          <div><span className={`state-dot ${stateTone}`} aria-hidden="true" /><span>{syncLabel}</span>{status?.syncing && <Spinner label="Synchronizing" />}</div>
          <div className="sync-track" role="progressbar" aria-label="Wallet synchronization" aria-valuemin={0} aria-valuemax={100} aria-valuenow={status?.syncing && !status.syncProgress ? undefined : Math.round(progress * 100)}><motion.div animate={{ scaleX: progress }} initial={false} transition={{ duration: reduced ? 0 : 0.3 }} /></div>
          <small>{syncDetail}</small>
        </div>
        <div className="sidebar-actions">
          <button className="text-button" disabled={!open || !!status?.syncing || syncBusy} onClick={() => void sync()} title={status?.nodeId ? `Sync with ${status.nodeName || nodeLabel(status.nodeId)}` : 'Choose a node in Settings'}><RefreshCw size={13} className={status?.syncing || syncBusy ? 'spin' : ''} />{status?.nodeId ? 'Sync wallet' : 'Choose node'}</button>
          <button className="icon-button" aria-label="Help and security" title="Help and security" onClick={() => setHelp(true)}><HelpCircle size={16} /></button>
        </div>
        <button className="node-link" onClick={() => navigate('settings')} disabled={!open}><span>{open ? status?.nodeName || nodeLabel(status?.nodeId) : 'Disconnected'}</span><ChevronRight size={12} /></button>
      </div>
    </aside>
    <main ref={scroll} className="gui-workspace" id="wallet-main" tabIndex={-1}>
      {wallet.error && <div className="workspace-error"><ErrorBox><span>{wallet.error}</span><button className="text-button" onClick={() => wallet.setAccountIndex(0)}>Reload default account</button></ErrorBox></div>}
      {wallet.pendingTransfer && <div className="pending-warning" role="alert">
        <strong>Transfer outcome needs checking</strong>
        <p>Do not resend until you have checked this transaction.</p>
        <div className="copy-field"><code>{wallet.pendingTransfer.txHash}</code><CopyButton text={wallet.pendingTransfer.txHash} label="Copy pending transaction ID" small /></div>
        <button className="text-button" onClick={() => setResolvePending(wallet.pendingTransfer!.txHash)}>I have verified the outcome<ChevronRight size={14} /></button>
      </div>}
      <AnimatePresence key={wallet.status?.vaultId ?? 'locked'} mode="wait" initial={false}>
        <motion.div key={open ? page : 'locked'} className="page-transition" initial={{ opacity: 0, x: reduced ? 0 : 9 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: reduced ? 0 : -6 }} transition={{ duration: reduced ? 0 : 0.16, ease: 'easeOut' }}>
          {!open ? <UnlockWallet /> : <>
            {page === 'overview' && <Overview navigate={navigate} selectTransaction={setTx} sync={() => void sync()} syncBusy={syncBusy} />}
            {page === 'send' && <Send setup={() => navigate('accounts')} settings={() => navigate('settings')} prefill={prefill} contacts={() => navigate('contacts')} />}
            {page === 'receive' && <Receive setup={() => navigate('accounts')} />}
            {page === 'history' && <HistoryPage selectTransaction={setTx} setup={() => navigate('accounts')} />}
            {page === 'contacts' && <Contacts sendTo={sendTo} />}
            {page === 'accounts' && <Accounts setup={() => navigate('accounts')} navigate={navigate} />}
            {page === 'settings' && <Settings setup={() => setLock(true)} backup={() => setBackup(true)} />}
          </>}
        </motion.div>
      </AnimatePresence>
    </main>
    <AnimatePresence>
      {backup && <SeedDialog key="seed" onClose={() => setBackup(false)} />}
      {tx && <TransactionDialog key="transaction" transaction={tx} onClose={() => setTx(null)} sendAgain={value => { setTx(null); sendTo(value); }} />}
      {lock && <ConfirmDialog key="lock" title="Close this wallet?" message="Save the encrypted wallet and remove unlocked keys from memory. Active synchronization will stop and save its progress. A transaction already being broadcast cannot be cancelled." confirmLabel="Save & lock" onClose={() => setLock(false)} onConfirm={wallet.close} />}
      {resolvePending && <ConfirmDialog key="resolve" title="Verify this transaction first" message={`Confirm only after checking the outcome of transaction ${resolvePending}. If it is pending or sent, do not send it again. This does not cancel a transaction.`} confirmLabel="Verified · clear warning" onClose={() => setResolvePending(null)} onConfirm={() => wallet.resolveTransfer(resolvePending)} />}
      {help && <Modal key="help" title="About this wallet" onClose={() => setHelp(false)}><div className="form-stack">
        <div className="about-brand"><Logo /><h3>Monero Wallet</h3><span>{APP_VERSION}</span></div>
        <p>A standalone browser wallet with the familiar Monero GUI layout. This is an independent project, not an official Monero release.</p>
        <div className="inline-info"><ShieldCheck size={19} /><span>The real Monero engine runs locally in WebAssembly. Keys are encrypted in this browser. Public nodes never receive your recovery phrase.</span></div>
        <p>Closing this popup does not stop synchronization or an already-confirmed payment. The session locks after {status?.autoLockMinutes === 60 ? 'one hour' : `${status?.autoLockMinutes ?? 5} minute${status?.autoLockMinutes === 1 ? '' : 's'}`} without interaction (change it in Settings), once active work finishes. Use the lock button for immediate control.</p>
        <p>Creating, restoring and importing a wallet opens a separate setup page. Back up the recovery phrase before receiving funds. Removing this extension can erase saved wallets.</p>
        <dl className="shortcut-list"><div><dt>Alt + 1…7</dt><dd>Switch between wallet sections</dd></div><div><dt>Esc</dt><dd>Close a dialog</dd></div></dl>
        <p className="form-footnote">Not independently audited. Start on stagenet and test small amounts.</p>
        <a className="text-button" href="https://docs.getmonero.org/" target="_blank" rel="noreferrer">Monero documentation<ArrowUpRight size={15} /></a>
      </div></Modal>}
    </AnimatePresence>
  </div>;
}
export default function App() { return <MotionConfig reducedMotion="user"><WalletProvider><WalletApp /></WalletProvider></MotionConfig>; }
