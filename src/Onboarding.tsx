import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { AlertCircle, ArrowLeft, ArrowRight, CalendarDays, Check, ChevronRight, Download, Eye, EyeOff, FileKey2, FolderOpen, Hash, KeyRound, LoaderCircle, LockKeyhole, Moon, Plus, ShieldCheck, Sun, Upload, Wallet, WifiOff } from 'lucide-react';
import { api, inExtension } from './lib/api';
import { localDateString, networkStartDate, restoreHeightFromDate } from './lib/restore-height';
import { useTheme } from './lib/theme';
import type { Status, VaultMeta, WalletNetwork } from './lib/types';
import { VAULT_MAX_BACKUP_CHARS } from './runtime/vault';

type Mode = 'create' | 'restore' | 'import';
type Step = 'choose' | 'details' | 'recovery' | 'backup' | 'verify' | 'ready';
type RestorePoint = 'height' | 'date';
const labels: Record<Step, string> = { choose: 'Wallet setup', details: 'Wallet details', recovery: 'Recovery phrase', backup: 'Encrypted backup', verify: 'Verify your phrase', ready: 'Ready to use' };
const modeLabels: Record<Mode, string> = { create: 'Create a new wallet', restore: 'Restore from recovery phrase', import: 'Import an encrypted wallet' };
const networkLabels: Record<WalletNetwork, string> = { mainnet: 'Mainnet', stagenet: 'Stagenet', testnet: 'Testnet' };
const emptyAnswers = (): string[] => ['', '', ''];

function stepHint(step: Step, mode: Mode): string {
  const hints: Record<Step, string> = {
    choose: 'Create, restore or import',
    details: mode === 'import' ? 'Backup file and password' : mode === 'restore' ? 'Phrase, restore point, password' : 'Name, network and password',
    recovery: 'Write down 25 words', backup: 'Optional encrypted file', verify: 'Check three words', ready: 'Continue in the popup',
  };
  return hints[step];
}

function readableError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === 'WALLET_IN_USE' || code === 'WALLET_ALREADY_OPEN') return 'A wallet is already active. Open the wallet popup to continue with it, or lock it in Settings before setting up another wallet. This page will not close or switch your wallet.';
  if (code === 'SYNC_BUSY') return 'The wallet is synchronizing. Wait for synchronization to finish before requesting a recovery phrase or backup.';
  return error instanceof Error ? error.message : 'The wallet operation could not be completed. Please try again.';
}

/** Coarse local feedback only; nothing is stored or sent anywhere. */
function passwordStrength(value: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (value.trim().length < 8) return { score: 0, label: 'Too short' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(value)).length;
  let score = value.length >= 16 ? 3 : value.length >= 12 ? 2 : 1;
  if (classes >= 3) score++;
  if (new Set(value).size < 5) score = 1;
  const clamped = Math.min(4, score) as 1 | 2 | 3 | 4;
  return { score: clamped, label: ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][clamped] };
}

function randomPositions(): number[] {
  const positions = new Set<number>();
  const value = new Uint32Array(1);
  // Rejection sampling: three different, uniformly chosen word positions.
  while (positions.size < 3) {
    crypto.getRandomValues(value);
    if (value[0] < Math.floor(0x100000000 / 25) * 25) positions.add(value[0] % 25);
  }
  return [...positions].sort((a, b) => a - b);
}

function BusyIcon() { return <LoaderCircle className="ob-spinner" size={17} aria-hidden="true" />; }

function Wizard() {
  const reduceMotion = useReducedMotion();
  const [theme, setTheme] = useTheme();
  // Popup links may select an action, never prefill wallet data or secrets.
  // Only one recognized query parameter is accepted; malformed links use the chooser.
  const [requestedMode] = useState<Mode | null>(() => {
    const params = [...new URLSearchParams(window.location.search).entries()];
    if (params.length !== 1 || params[0][0] !== 'mode') return null;
    const value = params[0][1];
    return value === 'create' || value === 'restore' || value === 'import' ? value : null;
  });
  const [mode, setMode] = useState<Mode>(requestedMode ?? 'create');
  const [step, setStep] = useState<Step>(requestedMode ? 'details' : 'choose');
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [secretBusy, setSecretBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [popupHelp, setPopupHelp] = useState('');
  const [filename, setFilename] = useState('');
  const [network, setNetwork] = useState<WalletNetwork>('mainnet');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [restoreSeed, setRestoreSeed] = useState('');
  const [restorePoint, setRestorePoint] = useState<RestorePoint>('height');
  const [restoreHeight, setRestoreHeight] = useState('0');
  const [restoreDate, setRestoreDate] = useState('');
  const [passwordAck, setPasswordAck] = useState(false);
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [imported, setImported] = useState<VaultMeta | null>(null);
  const [saved, setSaved] = useState(false);
  const [ownedWallet, setOwnedWallet] = useState<Status | null>(null);
  const [seed, setSeed] = useState('');
  const [privacyAck, setPrivacyAck] = useState(false);
  const [seedWritten, setSeedWritten] = useState(false);
  const [backupAck, setBackupAck] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [positions, setPositions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>(emptyAnswers);
  const mounted = useRef(true);
  const sensitiveGeneration = useRef(0);
  const operationBusy = useRef(false);
  const secretOperation = useRef(false);
  const ownedId = useRef('');
  const hasSensitiveInput = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorRef = useRef<HTMLDivElement>(null);
  const focusHeading = useRef(false);
  // Stable callback ref: runs only when a new step heading mounts (after the previous
  // step exits), moving keyboard and screen-reader focus to it unless an error needs it.
  const headingRef = useCallback((element: HTMLHeadingElement | null) => {
    if (!element || !focusHeading.current) return;
    focusHeading.current = false;
    if (!errorRef.current) element.focus({ preventScroll: true });
  }, []);
  const fileRef = useRef<HTMLInputElement>(null);
  const downloadUrls = useRef(new Set<string>());

  hasSensitiveInput.current = !!(password || confirmation || restoreSeed || seed || answers.some(Boolean) || privacyAck || secretBusy);

  const clearSecrets = useCallback((message = '') => {
    sensitiveGeneration.current++;
    setSeed(''); setPrivacyAck(false); setPassword(''); setConfirmation(''); setRestoreSeed(''); setAnswers(emptyAnswers());
    if (message && hasSensitiveInput.current) setNotice(message);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api<Status>('status');
      if (!mounted.current) return;
      setStatus(next);
      if (ownedId.current && (!next.walletOpen || next.vaultId !== ownedId.current)) {
        clearSecrets();
        setError('The active wallet has changed or been locked. Open your saved wallet in the popup. No recovery phrase will be displayed here for a different wallet.');
      }
    } catch (e) { if (mounted.current) { setStatus(null); setError(readableError(e)); } }
    finally { if (mounted.current) setChecking(false); }
  }, [clearSecrets]);

  useEffect(() => {
    mounted.current = true;
    void refreshStatus();
    const resetIdle = () => {
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => clearSecrets('Sensitive fields were cleared after 60 seconds of inactivity. Enter them again when you are ready.'), 60_000);
    };
    const visibility = () => {
      if (document.hidden) clearSecrets('Sensitive fields were cleared when you left this tab.');
      else { resetIdle(); if (!operationBusy.current) void refreshStatus(); }
    };
    const pagehide = () => clearSecrets();
    const focus = () => { if (!operationBusy.current && !document.hidden) void refreshStatus(); };
    const poll = setInterval(() => { if (!document.hidden && !operationBusy.current) void refreshStatus(); }, 5_000);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('pointerdown', resetIdle);
    document.addEventListener('pointermove', resetIdle, { passive: true });
    document.addEventListener('wheel', resetIdle, { passive: true });
    document.addEventListener('keydown', resetIdle);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('focus', focus);
    resetIdle();
    return () => {
      mounted.current = false; sensitiveGeneration.current++;
      clearTimeout(idleTimer.current); clearInterval(poll);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('pointerdown', resetIdle);
      document.removeEventListener('pointermove', resetIdle);
      document.removeEventListener('wheel', resetIdle);
      document.removeEventListener('keydown', resetIdle);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('focus', focus);
      downloadUrls.current.forEach(url => URL.revokeObjectURL(url));
      downloadUrls.current.clear();
    };
  }, [clearSecrets, refreshStatus]);

  useEffect(() => { if (error) errorRef.current?.focus({ preventScroll: true }); }, [error]);
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#ffffff' : '#232323');
  }, [theme]);
  useEffect(() => {
    if (!busy) return;
    const preventUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [busy]);

  const steps: Step[] = mode === 'create' ? ['choose', 'details', 'recovery', 'backup', 'verify', 'ready'] : ['choose', 'details', 'backup', 'ready'];
  const stepIndex = steps.indexOf(step);
  const anotherWallet = !!status?.walletOpen && (!ownedId.current || status.vaultId !== ownedId.current);
  const sessionMatches = !!ownedWallet?.vaultId && !!status?.walletOpen && ownedWallet.vaultId === status.vaultId;
  const unavailable = checking || !status?.engineReady || anotherWallet;
  const wordCount = restoreSeed.trim() ? restoreSeed.trim().split(/\s+/).length : 0;
  const strength = passwordStrength(password);
  const today = localDateString();
  const dateEstimate = restoreDate ? restoreHeightFromDate(restoreDate, network, today) : null;
  // Flag a mismatch as soon as the confirmation can no longer become the password.
  const passwordsDiffer = !!confirmation && confirmation !== password && (confirmation.length >= password.length || !password.startsWith(confirmation));

  function showStep(next: Step) { focusHeading.current = true; setStep(next); }

  function navigate(next: Step) {
    clearSecrets(); setError(''); setNotice(''); showStep(next);
  }

  function choose(next: Mode) {
    setMode(next); setImported(null); setBackupFile(null); setPasswordAck(false); setPopupHelp('');
    navigate('details');
  }

  async function openPopup() {
    clearSecrets();
    try {
      if (inExtension && typeof chrome.action?.openPopup === 'function') {
        await chrome.action.openPopup();
        if (mounted.current) setPopupHelp('The wallet opens from the Monero icon in your browser toolbar. You can close this setup tab after finishing your backup.');
        return;
      }
    } catch { /* Older Chromium and browsers without programmatic popup access use the toolbar. */ }
    if (mounted.current) setPopupHelp(inExtension
      ? 'Click the Extensions puzzle icon in your browser toolbar, pin Monero Wallet, then click the Monero icon to open your wallet. This browser does not allow this page to open the popup automatically.'
      : 'The wallet popup is available in the installed browser extension. In this web preview, the main wallet is at index.html; a preview tab does not share the extension session.');
  }

  async function requireNoWallet() {
    const next = await api<Status>('status');
    if (mounted.current) setStatus(next);
    if (next.walletOpen) throw new Error('A wallet is already unlocked. Continue in the popup, or lock it in Settings before setting up another. Your existing wallet has not been changed.');
  }

  async function requireOwnWallet(expectedVaultId: string) {
    const next = await api<Status>('status');
    if (mounted.current) setStatus(next);
    if (!expectedVaultId || expectedVaultId !== ownedId.current || !next.walletOpen || next.vaultId !== expectedVaultId) {
      clearSecrets();
      throw new Error('This wallet is no longer active. Unlock it in the popup and return here. Recovery phrases and backups are never taken from a different wallet.');
    }
    return next;
  }

  async function submitDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operationBusy.current || saved) return;
    setError(''); setNotice('');
    const name = filename.trim();
    if (mode !== 'import') {
      if (!name || name.length > 64 || /[\\/\x00-\x1f\x7f]/.test(name)) { setError('Use a wallet name of 1–64 characters, without slashes or control characters.'); return; }
      if (password.trim().length < 8 || password.length > 256) { setError('Use a password with at least 8 non-padding characters, up to 256 characters.'); return; }
      if (password !== confirmation) { setError('The passwords do not match.'); return; }
      if (!passwordAck) { setError('Confirm that you understand the password and backup requirements.'); return; }
    }
    const words = restoreSeed.trim().split(/\s+/);
    if (mode === 'restore' && words.length !== 25) { words.fill(''); setError('Enter all 25 words of your standard Monero recovery phrase, in order. Polyseed and seed offsets are not supported.'); return; }
    let height = 0;
    if (mode === 'restore' && restorePoint === 'date') {
      if (!restoreDate) { words.fill(''); setError('Choose the approximate date when this wallet was created, or enter a block height instead.'); return; }
      const estimate = restoreHeightFromDate(restoreDate, network, localDateString());
      if (!estimate.ok) { words.fill(''); setError(estimate.message); return; }
      height = estimate.height;
    } else if (mode === 'restore') {
      height = Number(restoreHeight);
      if (!/^\d+$/.test(restoreHeight) || !Number.isSafeInteger(height) || height < 0 || height > 999_999_999) { words.fill(''); setError('Enter a whole-number restore height from 0 to 999999999. Use 0 if unknown.'); return; }
    }
    if (mode === 'import' && (!password || (!backupFile && !imported))) { setError('Choose an encrypted backup and enter the password used to encrypt it.'); return; }
    operationBusy.current = true; setBusy(true);
    const generation = sensitiveGeneration.current;
    let didSave = false;
    let importMeta = imported;
    try {
      await requireNoWallet();
      if (!mounted.current || generation !== sensitiveGeneration.current || document.hidden) return;
      if (mode === 'import') {
        if (!importMeta) {
          if (!backupFile || backupFile.size > VAULT_MAX_BACKUP_CHARS) throw new Error('This encrypted backup exceeds the supported wallet-backup size limit.');
          const content = await backupFile.text();
          if (!mounted.current || generation !== sensitiveGeneration.current || document.hidden) return;
          if (content.length > VAULT_MAX_BACKUP_CHARS) throw new Error('This encrypted backup exceeds the supported wallet-backup size limit.');
          await requireNoWallet();
          if (!mounted.current || generation !== sensitiveGeneration.current || document.hidden) return;
          importMeta = await api<VaultMeta>('wallet.import', { content });
          if (mounted.current) { setImported(importMeta); setBackupFile(null); }
        }
        // Import saves encrypted data before unlock. Retain its id on a wrong-password error,
        // so retries open the imported vault instead of attempting a duplicate import.
        if (!mounted.current || generation !== sensitiveGeneration.current || document.hidden) return;
        await requireNoWallet();
        if (!mounted.current || generation !== sensitiveGeneration.current || document.hidden) return;
        await api('wallet.open', { vaultId: importMeta.id, password }, null);
      } else {
        await api(mode === 'create' ? 'wallet.create' : 'wallet.restore', mode === 'create'
          ? { filename: name, password, language: 'English', network }
          : { filename: name, password, seed: words.join(' '), restoreHeight: height, network }, null);
      }
      didSave = true;
      if (!mounted.current) return;
      clearSecrets(); setSaved(true); showStep(mode === 'create' ? 'recovery' : 'backup');
      const next = await api<Status>('status');
      if (!mounted.current) return;
      setStatus(next);
      const expectedName = mode === 'import' ? importMeta?.name : name;
      const expectedNetwork = mode === 'import' ? importMeta?.network : network;
      if (!next.walletOpen || !next.vaultId || next.walletName !== expectedName || next.network !== expectedNetwork || (importMeta && next.vaultId !== importMeta.id)) {
        throw new Error('Your wallet was saved, but the active session changed. Open the saved wallet in the popup to continue and back up its recovery phrase in Settings.');
      }
      ownedId.current = next.vaultId; setOwnedWallet(next);
    } catch (e) {
      if (mounted.current) setError(didSave ? `Your encrypted wallet was saved. ${readableError(e)} Do not create it again; continue from the wallet popup.` : readableError(e));
    } finally {
      words.fill(''); operationBusy.current = false;
      if (mounted.current) { setPassword(''); setConfirmation(''); setRestoreSeed(''); setBusy(false); }
    }
  }

  async function revealSeed() {
    if (secretOperation.current || !privacyAck || document.hidden) return;
    secretOperation.current = true; setSecretBusy(true); setError(''); setNotice('');
    const generation = ++sensitiveGeneration.current;
    const expectedVaultId = ownedWallet?.vaultId ?? '';
    let data: { seed: string } | undefined;
    try {
      await requireOwnWallet(expectedVaultId);
      if (!mounted.current || generation !== sensitiveGeneration.current || document.hidden) return;
      data = await api<{ seed: string }>('wallet.seed', {}, expectedVaultId);
      await requireOwnWallet(expectedVaultId);
      if (!mounted.current || generation !== sensitiveGeneration.current || document.hidden) return;
      if (data.seed.trim().split(/\s+/).length !== 25) throw new Error('The engine did not return a standard 25-word recovery phrase. Do not receive funds before making a valid backup.');
      setSeed(data.seed.trim());
    } catch (e) { if (mounted.current && !document.hidden) setError(readableError(e)); }
    finally { if (data) data.seed = ''; secretOperation.current = false; if (mounted.current) setSecretBusy(false); }
  }

  async function exportBackup() {
    if (operationBusy.current) return;
    operationBusy.current = true; setBusy(true); setError('');
    const expectedVaultId = ownedWallet?.vaultId ?? '';
    let data: { filename: string; content: string } | undefined;
    try {
      await requireOwnWallet(expectedVaultId);
      data = await api<{ filename: string; content: string }>('wallet.export', {}, expectedVaultId);
      await requireOwnWallet(expectedVaultId);
      if (!mounted.current || document.hidden) return;
      const url = URL.createObjectURL(new Blob([data.content], { type: 'application/json' }));
      downloadUrls.current.add(url);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = data.filename;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setDownloaded(true);
      setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.current.delete(url); }, 30_000);
    } catch (e) { if (mounted.current) setError(readableError(e)); }
    finally { if (data) data.content = ''; operationBusy.current = false; if (mounted.current) setBusy(false); }
  }

  async function verifyPhrase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (secretOperation.current || document.hidden || positions.length !== 3) return;
    secretOperation.current = true; setSecretBusy(true); setError(''); setNotice('');
    const generation = ++sensitiveGeneration.current;
    const expectedVaultId = ownedWallet?.vaultId ?? '';
    let data: { seed: string } | undefined;
    let words: string[] = [];
    try {
      await requireOwnWallet(expectedVaultId);
      if (!mounted.current || generation !== sensitiveGeneration.current || document.hidden) return;
      data = await api<{ seed: string }>('wallet.seed', {}, expectedVaultId);
      await requireOwnWallet(expectedVaultId);
      if (!mounted.current || generation !== sensitiveGeneration.current || document.hidden) return;
      words = data.seed.trim().split(/\s+/);
      if (words.length !== 25 || !positions.every((position, i) => answers[i].trim().toLowerCase() === words[position].toLowerCase())) {
        setAnswers(emptyAnswers());
        throw new Error('Those words do not match. Check the numbered words on your paper backup, or go back to view the recovery phrase again.');
      }
      navigate('ready');
    } catch (e) { if (mounted.current && !document.hidden) setError(readableError(e)); }
    finally { words.fill(''); if (data) data.seed = ''; secretOperation.current = false; if (mounted.current) setSecretBusy(false); }
  }

  const title = step === 'choose' ? 'Welcome to Monero' : step === 'details' ? modeLabels[mode] : step === 'recovery' ? 'Write down your recovery phrase' : step === 'backup' ? 'Save an encrypted backup' : step === 'verify' ? 'Check your recovery phrase' : 'Your wallet is ready';
  const description = step === 'choose' ? 'Create a wallet, restore a recovery phrase, or import an encrypted backup.'
    : step === 'details' ? (mode === 'import' ? 'Import a backup made by this extension. Your existing wallets will not be overwritten.' : mode === 'restore' ? 'Your wallet is restored on this device, without connecting to a remote node.' : 'Your wallet is created on this device, without connecting to a remote node.')
    : step === 'recovery' ? 'These 25 words are the backup of your wallet. Their order matters.'
    : step === 'backup' ? 'Keep a second copy of your encrypted wallet outside this browser.'
    : step === 'verify' ? 'Use your written backup to enter the three words below.'
    : 'Your encrypted wallet is saved on this device. Continue in the wallet popup.';

  return <div className="onboarding-root">
    <header className="ob-topbar">
      <a className="ob-brand" href="https://www.getmonero.org" target="_blank" rel="noreferrer" aria-label="Monero website"><img src="./monero.svg" alt="" /><span>MONERO<small>WALLET</small></span></a>
      <div className="ob-topbar-right">
        <button type="button" className="ob-icon-button" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button>
        <span className="ob-top-divider" aria-hidden="true" />
        <button type="button" className="ob-button ob-quiet" onClick={() => void openPopup()} disabled={busy}>Open wallet popup<ArrowRight size={15} /></button>
      </div>
    </header>
    <div className="ob-layout">
      <aside className="ob-sidebar" aria-label="Setup progress">
        <div className="ob-sidebar-heading">WALLET SETUP</div>
        <ol className="ob-steps">{steps.map((item, index) => <li key={item} className={`${index === stepIndex ? 'is-current' : ''} ${index < stepIndex ? 'is-complete' : ''}`} aria-current={index === stepIndex ? 'step' : undefined}>
          <span className="ob-step-marker" aria-hidden="true">{index < stepIndex ? <Check size={13} strokeWidth={3} /> : index + 1}</span>
          <span className="ob-step-text"><span className="ob-step-label">{labels[item]}</span><span className="ob-step-hint">{stepHint(item, mode)}</span></span>
          {index < stepIndex && <span className="ob-sr-only">(completed)</span>}
        </li>)}</ol>
        <div className="ob-sidebar-note"><WifiOff size={18} /><div><strong>Offline setup</strong><p>No node connection is made during setup. You choose when to synchronize.</p></div></div>
      </aside>
      <main className="ob-main" id="main-content">
        <div className="ob-breadcrumb" aria-label="Current step"><span>Wallet setup</span><ChevronRight size={13} /><span>{step === 'choose' ? 'Welcome' : labels[step]}</span><span className="ob-step-count">Step {stepIndex + 1} of {steps.length}</span></div>
        <div className="ob-progress" role="progressbar" aria-label="Setup progress" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={stepIndex + 1}><motion.span initial={false} animate={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }} transition={{ duration: reduceMotion ? 0 : 0.3, ease: 'easeOut' }} /></div>
        {popupHelp && <div className="ob-notice" role="status"><Wallet size={19} /><p>{popupHelp}</p><button className="ob-text-button" onClick={() => setPopupHelp('')}>Dismiss</button></div>}
        {error && <div className="ob-error" role="alert" tabIndex={-1} ref={errorRef}><AlertCircle size={20} /><div>{error}</div><button className="ob-text-button" disabled={busy} onClick={() => { setError(''); void refreshStatus(); }}>Recheck</button></div>}
        {notice && <div className="ob-notice" role="status"><EyeOff size={18} /><p>{notice}</p></div>}
        {anotherWallet && <section className="ob-existing" aria-label="Existing wallet is active"><LockKeyhole size={24} /><div><h2>A wallet is already open</h2><p>{status?.walletName || 'Your wallet'} is active. Continue in the popup, or lock it in Settings before setting up another wallet. This page will not switch wallets.</p><button className="ob-button" onClick={() => void openPopup()}>Continue in wallet popup<ArrowRight size={16} /></button></div></section>}
        <div className="ob-announcement" role="status" aria-live="polite">Step {stepIndex + 1}: {title}</div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.section className="ob-page" key={step} aria-labelledby="ob-page-title" initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0 } }} transition={{ duration: reduceMotion ? 0 : 0.2, ease: 'easeOut' }}>
            <div className="ob-page-heading"><h1 id="ob-page-title" ref={headingRef} tabIndex={-1}>{title}</h1><p>{description}</p></div>
            {step === 'choose' && <>
              {checking && <div className="ob-engine-status" role="status"><BusyIcon />Starting the local wallet engine…</div>}
              {!checking && !status?.engineReady && <div className="ob-engine-status"><AlertCircle size={18} />The wallet engine is not ready.<button className="ob-text-button" onClick={() => { setChecking(true); void refreshStatus(); }}>Retry</button></div>}
              <div className="ob-wallet-options">
                <button disabled={unavailable} onClick={() => choose('create')}><span className="ob-option-icon"><Plus size={24} strokeWidth={1.75} /></span><span><strong>Create a new wallet</strong><small>Choose this option if this is your first time using Monero.</small></span><ChevronRight size={20} /></button>
                <button disabled={unavailable} onClick={() => choose('restore')}><span className="ob-option-icon"><KeyRound size={23} strokeWidth={1.75} /></span><span><strong>Restore from recovery phrase</strong><small>Recover an existing wallet with its 25-word mnemonic seed.</small></span><ChevronRight size={20} /></button>
                <button disabled={unavailable} onClick={() => choose('import')}><span className="ob-option-icon"><FolderOpen size={23} strokeWidth={1.75} /></span><span><strong>Import an encrypted wallet</strong><small>Open a .monero-vault.json backup from this extension.</small></span><ChevronRight size={20} /></button>
              </div>
              <div className="ob-welcome-bottom"><p>Already have a wallet saved in this browser?</p><button className="ob-text-button" onClick={() => void openPopup()}>Unlock it in the wallet popup<ArrowRight size={15} /></button></div>
              <div className="ob-footnote"><ShieldCheck size={17} /><p>Keep an offline backup. Removing this extension or clearing browser data can erase your saved wallets.</p></div>
            </>}
            {step === 'details' && <form onSubmit={event => void submitDetails(event)} className="ob-form" noValidate={mode === 'restore' && restorePoint === 'date'}>
              <fieldset disabled={busy || anotherWallet}>
                {mode === 'import' ? <>
                  <label className="ob-field">Encrypted wallet backup<input ref={fileRef} type="file" accept=".json,application/json" onChange={event => { setBackupFile(event.target.files?.[0] || null); setImported(null); setError(''); event.target.value = ''; }} className="ob-hidden-file" aria-label="Choose encrypted wallet backup" tabIndex={-1} /></label>
                  <div className="ob-file-picker"><FileKey2 size={27} /><div><strong>{imported ? 'Backup imported · locked' : backupFile?.name || 'No backup file selected'}</strong><small>{imported ? 'Enter its password to finish opening it.' : 'Only encrypted JSON backups from this extension. Desktop .keys files are not supported.'}</small></div><button type="button" className="ob-button" onClick={() => fileRef.current?.click()}><Upload size={15} />Browse</button></div>
                  <label className="ob-field">Backup password<input aria-label="Backup password" name="backup-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={256} placeholder="Password used to encrypt this backup" /><small>The wallet name and network are read from the backup after it is unlocked.</small></label>
                </> : <>
                  <div className="ob-two-columns"><label className="ob-field">Wallet name<input name="wallet-name" value={filename} onChange={event => setFilename(event.target.value)} required maxLength={64} placeholder="My Monero wallet" autoComplete="off" spellCheck={false} /></label><label className="ob-field">Network<select aria-label="Network" value={network} onChange={event => setNetwork(event.target.value as WalletNetwork)}><option value="mainnet">Mainnet — real XMR</option><option value="stagenet">Stagenet — test funds</option><option value="testnet">Testnet — test funds</option></select></label></div>
                  {network !== 'mainnet' && <div className="ob-warning"><AlertCircle size={18} /><p>{networkLabels[network]} is for testing only. Coins on this network have no monetary value. The network cannot be changed later.</p></div>}
                  {mode === 'restore' && <>
                    <label className="ob-field">25-word recovery phrase<textarea aria-label="25-word recovery phrase" name="recovery-phrase" className="ob-sensitive" rows={3} value={restoreSeed} onChange={event => setRestoreSeed(event.target.value)} required maxLength={2000} autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} placeholder="Enter all 25 words in their original order" /><span className="ob-field-hint"><span>Standard Monero mnemonic only. No Polyseed or seed offsets.</span><span className={wordCount === 25 ? 'is-complete' : ''}>{wordCount} / 25 words</span></span></label>
                    <div className="ob-restore-point" role="group" aria-labelledby="ob-restore-title">
                      <div className="ob-restore-head">
                        <div><strong id="ob-restore-title">Restore point</strong><small>Scanning starts here. Earlier is safe but slower; too late can miss funds.</small></div>
                        <div className="ob-segmented" role="radiogroup" aria-label="Restore point type">
                          <label><input type="radio" name="restore-point" value="height" checked={restorePoint === 'height'} onChange={() => setRestorePoint('height')} /><Hash size={14} />Block height</label>
                          <label><input type="radio" name="restore-point" value="date" checked={restorePoint === 'date'} onChange={() => setRestorePoint('date')} /><CalendarDays size={14} />Approximate date</label>
                        </div>
                      </div>
                      {restorePoint === 'height'
                        ? <label className="ob-field ob-height-field">Restore height<input aria-label="Restore height" name="restore-height" inputMode="numeric" type="number" min={0} max={999_999_999} step={1} required value={restoreHeight} onChange={event => setRestoreHeight(event.target.value)} /><small>Use 0 if unknown to scan the whole chain, or choose Approximate date. A height before your first transaction is safe; a later height can miss funds.</small></label>
                        : <div className="ob-date-row">
                          <label className="ob-field ob-height-field">Wallet creation date<input aria-label="Wallet creation date" name="restore-date" type="date" min={networkStartDate(network)} max={today} value={restoreDate} aria-invalid={dateEstimate?.ok === false ? true : undefined} aria-describedby="ob-date-estimate" onChange={event => setRestoreDate(event.target.value)} /></label>
                          <p className={`ob-estimate ${dateEstimate?.ok === false ? 'is-error' : ''}`} id="ob-date-estimate" aria-live="polite">
                            {!dateEstimate ? <span>Pick the day you created the wallet, or any earlier day if you are unsure.</span>
                              : !dateEstimate.ok ? <span>{dateEstimate.message}</span>
                              : <><span>Scanning starts near block <strong>{dateEstimate.height.toLocaleString('en-US')}</strong>, about one month before this date for safety.</span><button type="button" className="ob-text-button" onClick={() => { setRestoreHeight(String(dateEstimate.height)); setRestorePoint('height'); }}>Edit as block height</button></>}
                          </p>
                        </div>}
                    </div>
                  </>}
                  <div className="ob-section-label"><LockKeyhole size={16} />Protect your wallet</div>
                  <div className="ob-two-columns">
                    <div className="ob-field-group">
                      <label className="ob-field">Wallet password<input name="new-password" type="password" autoComplete="new-password" required minLength={8} maxLength={256} value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 8 characters" aria-describedby={password ? 'ob-password-strength' : undefined} /></label>
                      {password && <div className="ob-strength" id="ob-password-strength" data-score={strength.score}><span className="ob-strength-bars" aria-hidden="true"><span /><span /><span /><span /></span><span>Strength: <strong>{strength.label}</strong></span></div>}
                    </div>
                    <div className="ob-field-group">
                      <label className="ob-field">Confirm password<input name="confirm-password" type="password" autoComplete="new-password" required minLength={8} maxLength={256} value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder="Enter the password again" aria-invalid={passwordsDiffer ? true : undefined} aria-describedby={confirmation ? 'ob-password-match' : undefined} /></label>
                      {confirmation && <div className={`ob-match ${confirmation === password ? 'is-ok' : ''}`} id="ob-password-match">{confirmation === password ? <><Check size={14} />Passwords match</> : passwordsDiffer ? 'Passwords do not match' : 'Keep typing to confirm'}</div>}
                    </div>
                  </div>
                  <p className="ob-help">This password encrypts your wallet on this device. It does not replace your recovery phrase, and there is no password reset.</p>
                  <label className="ob-checkbox"><input type="checkbox" checked={passwordAck} onChange={event => setPasswordAck(event.target.checked)} required /><span>I will keep my recovery phrase offline. I understand that clearing browser data can erase this wallet.</span></label>
                </>}
              </fieldset>
              <div className="ob-actions"><button type="button" className="ob-button" disabled={busy} onClick={() => { setImported(null); setBackupFile(null); navigate('choose'); }}><ArrowLeft size={16} />Back</button><button className="ob-button ob-primary" disabled={busy || unavailable}>{busy ? <BusyIcon /> : mode === 'import' ? <FolderOpen size={16} /> : <LockKeyhole size={16} />}{busy ? 'Saving encrypted wallet…' : mode === 'create' ? 'Create wallet offline' : mode === 'restore' ? 'Restore wallet offline' : imported ? 'Unlock imported wallet' : 'Import and open wallet'}</button></div>
              <div className="ob-footnote"><WifiOff size={16} /><p>{busy ? 'Keep this page open while the wallet is being saved. No funds are sent.' : 'No remote node is contacted. Network access begins only when you choose to synchronize.'}</p></div>
            </form>}
            {step === 'recovery' && <div className="ob-form">
              <div className="ob-warning"><KeyRound size={20} /><p><strong>Anyone with these words can spend your Monero.</strong> Write them on paper and keep them in a safe place. Do not take a screenshot, store them online, or share them.</p></div>
              {seed ? <>
                <ol className="ob-seed-grid ob-sensitive" aria-label="Recovery phrase">{seed.split(/\s+/).map((word, index) => <li key={index}><span>{String(index + 1).padStart(2, '0')}</span>{word}</li>)}</ol>
                <button className="ob-text-button" onClick={() => clearSecrets()}><EyeOff size={16} />Hide recovery phrase</button>
                <label className="ob-checkbox"><input type="checkbox" checked={seedWritten} onChange={event => setSeedWritten(event.target.checked)} /><span>I have written down all 25 words in order and stored them somewhere safe.</span></label>
              </> : <div className="ob-reveal-panel"><div className="ob-hidden-phrase" aria-hidden="true">{Array.from({ length: 25 }, (_, index) => <span key={index}>••••••</span>)}</div><div className="ob-reveal-content"><span className="ob-reveal-icon"><EyeOff size={22} /></span><strong>Your recovery phrase is hidden</strong><label className="ob-checkbox"><input type="checkbox" checked={privacyAck} onChange={event => setPrivacyAck(event.target.checked)} /><span>I am in a private place. I understand that these words give full access to my funds.</span></label><button className="ob-button ob-primary" disabled={!privacyAck || secretBusy || !sessionMatches} onClick={() => void revealSeed()}>{secretBusy ? <BusyIcon /> : <Eye size={16} />}Reveal recovery phrase</button></div></div>}
              <p className="ob-help">Hidden when you leave this tab or after 60 seconds without keyboard or pointer activity. The phrase is never written to browser storage by this screen.</p>
              <div className="ob-actions"><span className="ob-saved-label"><Check size={15} />Encrypted wallet saved</span><button className="ob-button ob-primary" disabled={!seedWritten || secretBusy || !sessionMatches} onClick={() => navigate('backup')}>Continue<ArrowRight size={16} /></button></div>
            </div>}
            {step === 'backup' && <div className="ob-form">
              <div className="ob-backup-summary"><FileKey2 size={36} strokeWidth={1.4} /><div><strong>{ownedWallet?.walletName || 'Your saved wallet'}</strong><span>Password-encrypted wallet backup · JSON</span></div><span className="ob-badge">ENCRYPTED</span></div>
              <p className="ob-body-copy">An encrypted backup lets you import your wallet into this extension again. You will need the wallet password to open it. Keep the file on a separate, trusted device.</p>
              <button className="ob-button ob-download" disabled={busy || !sessionMatches} onClick={() => void exportBackup()}>{busy ? <BusyIcon /> : <Download size={18} />}{busy ? 'Preparing encrypted backup…' : downloaded ? 'Download backup again' : 'Download encrypted backup'}</button>
              {downloaded && <div className="ob-success-note" role="status"><Check size={17} /><p>Download requested. Check your downloads and make sure the file is saved before continuing.</p></div>}
              <div className="ob-warning"><ShieldCheck size={20} /><p>An encrypted backup is optional and is not a substitute for your offline recovery phrase. The password cannot recover a wallet after all copies of its data are lost.</p></div>
              <label className="ob-checkbox"><input type="checkbox" checked={backupAck} onChange={event => setBackupAck(event.target.checked)} /><span>{mode === 'create' ? 'I understand how to keep my backups safe. I will keep my written recovery phrase even if I save an encrypted backup.' : 'I have an offline recovery phrase, or will back it up in the wallet Settings before receiving any funds.'}</span></label>
              <div className="ob-actions">{mode === 'create' ? <button className="ob-button" disabled={busy} onClick={() => navigate('recovery')}><ArrowLeft size={16} />Back</button> : <span className="ob-saved-label"><Check size={15} />Encrypted wallet saved</span>}<button className="ob-button ob-primary" disabled={!backupAck || busy || !sessionMatches} onClick={() => { if (mode === 'create') { setPositions(randomPositions()); navigate('verify'); } else navigate('ready'); }}>{mode === 'create' ? 'Verify recovery phrase' : 'Finish setup'}<ArrowRight size={16} /></button></div>
            </div>}
            {step === 'verify' && <form className="ob-form" onSubmit={event => void verifyPhrase(event)}>
              <div className="ob-verification-note"><KeyRound size={21} /><p>This quick check helps confirm that your recovery phrase was written down correctly. Your answers are only checked in memory and are not saved.</p></div>
              <fieldset className="ob-verify-fields" disabled={secretBusy || !sessionMatches}>{positions.map((position, index) => <label className="ob-field" key={position}>Word {position + 1}<input className="ob-sensitive" name={`backup-word-${position + 1}`} value={answers[index]} onChange={event => setAnswers(previous => previous.map((word, i) => i === index ? event.target.value : word))} required autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} maxLength={64} placeholder={`Word ${position + 1}`} /></label>)}</fieldset>
              <button type="button" className="ob-text-button" disabled={secretBusy} onClick={() => navigate('recovery')}><Eye size={16} />View recovery phrase again</button>
              <div className="ob-actions"><button type="button" className="ob-button" disabled={secretBusy} onClick={() => navigate('backup')}><ArrowLeft size={16} />Back</button><button className="ob-button ob-primary" disabled={secretBusy || !sessionMatches}>{secretBusy ? <BusyIcon /> : <Check size={16} />}{secretBusy ? 'Checking…' : 'Verify and finish'}</button></div>
            </form>}
            {step === 'ready' && <div className="ob-form">
              <div className="ob-ready-summary"><span className="ob-ready-check"><Check size={28} strokeWidth={2.5} /></span><div><strong>{ownedWallet?.walletName || 'Your wallet'}</strong><span>{networkLabels[(ownedWallet?.network || network) as WalletNetwork]} · Encrypted and saved</span></div></div>
              <dl className="ob-ready-details"><div><dt>Recovery phrase</dt><dd>{mode === 'create' ? <><Check size={15} />Verified</> : 'Back up in Settings before receiving funds'}</dd></div><div><dt>Network connection</dt><dd><WifiOff size={15} />Not started by setup</dd></div><div><dt>Next step</dt><dd>Choose a node in Settings, then start Sync</dd></div></dl>
              <div className="ob-notice"><ShieldCheck size={20} /><p>A remote node can see your IP address and the timing of your requests. Review the privacy notice in Settings before connecting. No node has been contacted during setup.</p></div>
              <div className="ob-actions"><span className="ob-saved-label"><Check size={15} />Setup complete</span><button className="ob-button ob-primary" onClick={() => void openPopup()}><Wallet size={17} />Open wallet popup<ArrowRight size={16} /></button></div>
              <p className="ob-help">{inExtension ? 'You can close this setup tab. The wallet session runs in the extension, not in this page. Use Settings → Lock wallet to lock it.' : 'In the installed extension, you can close this setup tab and continue in the popup. This development preview uses a tab-local wallet session.'}</p>
            </div>}
          </motion.section>
        </AnimatePresence>
        <footer className="ob-footer"><span>MONERO WALLET <span className="ob-footer-dot">·</span> Browser extension</span><span><LockKeyhole size={13} />Your keys stay on your device</span></footer>
      </main>
    </div>
  </div>;
}

export default function Onboarding() { return <MotionConfig reducedMotion="user"><Wizard /></MotionConfig>; }
