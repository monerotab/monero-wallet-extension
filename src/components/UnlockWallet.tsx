import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, ExternalLink, FolderOpen, KeyRound, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, openOnboarding } from '../lib/api';
import type { VaultMeta } from '../lib/types';
import { useWallet } from './WalletContext';
import { ErrorBox, Logo, Spinner } from './ui';

export default function UnlockWallet() {
  const wallet = useWallet();
  const [wallets, setWallets] = useState<VaultMeta[]>([]); const [vaultId, setVaultId] = useState('');
  const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [caps, setCaps] = useState(false);
  useEffect(() => {
    let active = true;
    void api<{ wallets: VaultMeta[] }>('wallet.list').then(result => {
      if (active) { const last = localStorage.getItem('monero-gui-last-wallet'); setWallets(result.wallets); setVaultId(result.wallets.find(item => item.id === last)?.id || result.wallets[0]?.id || ''); }
    }).catch(e => { if (active) setError((e as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !vaultId) return;
    setBusy(true); setError('');
    try { await api('wallet.open', { vaultId, password }, null); setPassword(''); localStorage.setItem('monero-gui-last-wallet', vaultId); await wallet.refresh(); }
    catch (e) { setError((e as Error).message); setPassword(''); }
    finally { setBusy(false); }
  }
  async function start(mode: 'create' | 'restore' | 'import') {
    try { await openOnboarding(mode); } catch (e) { setError((e as Error).message); }
  }
  return <div className="unlock-view">
    <div className="unlock-brand"><Logo /><span>MONERO</span></div>
    <h1>{wallets.length ? 'Open your wallet' : 'Welcome to Monero'}</h1>
    <p className="muted">{wallets.length ? 'Enter your password to unlock this wallet.' : 'Your wallet. Your keys. Your privacy.'}</p>
    {error && <ErrorBox>{error}</ErrorBox>}
    {loading ? <div className="engine-loading"><Spinner />Loading encrypted wallets…</div> : wallets.length ? <form className="form-stack unlock-form" onSubmit={submit}>
      <label>Wallet<select value={vaultId} onChange={e => { setVaultId(e.target.value); setPassword(''); }} disabled={busy}>{wallets.map(item => <option key={item.id} value={item.id}>{item.name} · {item.network}</option>)}</select></label>
      <label>Password<input type="password" name="password" autoComplete="current-password" maxLength={256} required value={password} onChange={e => setPassword(e.target.value)} onKeyUp={e => setCaps(e.getModifierState('CapsLock'))} onBlur={() => setCaps(false)} disabled={busy} placeholder="Wallet password" autoFocus />{caps && <small className="caps-warning" role="status">Caps Lock is on</small>}</label>
      <button className="button primary" disabled={busy || !password || !vaultId}>{busy ? <Spinner /> : <KeyRound size={16} />}Unlock wallet<ArrowRight size={16} /></button>
      <p className="form-footnote">The wallet stays unlocked while you use the extension. Five minutes of inactivity locks it automatically after active operations finish.</p>
    </form> : <div className="first-wallet"><button className="button primary" onClick={() => void start('create')}><Plus size={17} />Create a new wallet<ExternalLink size={14} /></button><p className="form-footnote">Setup opens in a separate page so you can safely back up your recovery phrase.</p></div>}
    <div className="unlock-alternatives">{wallets.length > 0 && <button onClick={() => void start('create')}><Plus size={15} />Create new wallet</button>}<button onClick={() => void start('restore')}><RefreshCw size={15} />Restore from recovery phrase</button><button onClick={() => void start('import')}><FolderOpen size={15} />Import encrypted wallet</button></div>
    <div className="unlock-security"><ShieldCheck size={15} /><span>Keys are encrypted on this device. No local server needed.</span></div>
  </div>;
}
