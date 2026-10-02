import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Check, Info, X } from 'lucide-react';
import { api, getPendingTransfer, inExtension, type PendingTransfer } from '../lib/api';
import { validMarker } from '../runtime/transport.ts';
import { ensureNodePermission } from '../lib/node-permissions';
import type { Snapshot, Status } from '../lib/types';

interface WalletState {
  status: Status | null; snapshot: Snapshot | null; connected: boolean; loading: boolean;
  error: string; accountIndex: number; hidden: boolean; walletName: string; ready: boolean;
  setAccountIndex: (index: number) => void; setHidden: (value: boolean) => void; setWalletName: (name: string) => void;
  refresh: (force?: boolean) => Promise<void>; sync: () => Promise<void>; close: () => Promise<void>;
  notify: (message: string, tone?: ToastTone) => void;
  pendingTransfer: PendingTransfer | null;
  resolveTransfer: (expectedHash: string) => Promise<void>;
  request: <T>(action: string, params?: Record<string, unknown>) => Promise<T>;
}
export type ToastTone = 'success' | 'info' | 'error';
const Context = createContext<WalletState | null>(null);
// Non-secret presentation preferences only; never persist addresses, balances or form contents.
function preferredAccount(vaultId?: string): number {
  try { const value = JSON.parse(localStorage.getItem('monero-gui-selected-account') || 'null'); return value?.vaultId === vaultId && Number.isSafeInteger(value.index) && value.index >= 0 && value.index < 1_000_000 ? value.index : 0; } catch { return 0; }
}
function readableError(error: unknown) {
  if ((error as { code?: string })?.code === 'WALLET_IN_USE') return 'Your wallet engine is active in another tab. Lock the wallet or close that tab, then retry here. Only one wallet tab can be active at a time.';
  if ((error as { code?: string })?.code === 'SYNC_BUSY') return 'Your wallet is synchronizing. Wait for it to finish before changing accounts; this account’s current balances are not yet available.';
  return error instanceof Error ? error.message : 'The wallet could not complete this operation.';
}
export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [accountIndex, setAccountIndexState] = useState(0);
  const [hidden, setHiddenState] = useState(() => localStorage.getItem('monero-gui-hide-balances') === 'true');
  const setHidden = (value: boolean) => { setHiddenState(value); localStorage.setItem('monero-gui-hide-balances', String(value)); };
  const [walletName, setWalletName] = useState('My Monero wallet');
  const statusRef = useRef<Status | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone; id: number } | null>(null);
  const notify = useCallback((message: string, tone: ToastTone = 'success') => setToast({ message, tone, id: Date.now() }), []);
  const [pendingTransfer, setPending] = useState<PendingTransfer | null>(null);
  const [pendingReady, setPendingReady] = useState(false);
  const [pendingError, setPendingError] = useState('');
  const accountRef = useRef(0);
  const vaultRef = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const sequence = useRef(0);
  // Snapshots are comparatively expensive (all accounts, addresses, history).
  // Poll cheap status; reload the snapshot only when wallet state changed.
  const snapshotKey = useRef(''); const snapshotAt = useRef(0); const hasSnapshot = useRef(false);
  const resolveTransfer = async (expectedHash: string) => {
    // Only the service may change the durable marker, under its wallet lock and hash guard.
    await api('tx.resolve', { txHash: expectedHash });
    setPending(await getPendingTransfer());
  };

  useEffect(() => {
    let active = true;
    void getPendingTransfer().then(value => { if (active) { setPending(value); setPendingReady(true); } })
      .catch(() => { if (active) setPendingError('The transfer safety record could not be read. Reload this tab before using your wallet.'); });
    if (!inExtension) return () => { active = false; };
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !('unresolvedTransfer' in changes)) return;
      // Validate like the initial read. A damaged record must keep sending disabled.
      try { setPending(validMarker(changes.unresolvedTransfer.newValue)); setPendingError(''); }
      catch { setPendingError('The transfer safety record could not be read. Reload this tab before using your wallet.'); }
    };
    chrome.storage.onChanged.addListener(changed);
    return () => { active = false; chrome.storage.onChanged.removeListener(changed); };
  }, []);

  const refresh = useCallback(async (force = true) => {
    const request = ++sequence.current;
    const epoch = generation.current;
    if (force) setLoading(true);
    let next: Status | undefined;
    try {
      next = await api<Status>('status');
      if (epoch !== generation.current || request !== sequence.current) return;
      const changedWallet = next.vaultId !== vaultRef.current;
      const index = !next.walletOpen ? 0 : changedWallet ? preferredAccount(next.vaultId) : accountRef.current;
      if (changedWallet || !next.walletOpen) {
        vaultRef.current = next.vaultId; accountRef.current = index; setAccountIndexState(index); setSnapshot(null); hasSnapshot.current = false;
      }
      setStatus(next); statusRef.current = next; setConnected(next.engineReady === true);
      if (next.walletName) setWalletName(next.walletName);
      const key = [next.vaultId, index, next.height, next.syncing, next.synced, next.lastSyncAt, next.nodeId].join('|');
      if (next.walletOpen && (force || !hasSnapshot.current || key !== snapshotKey.current || Date.now() - snapshotAt.current > 20_000)) {
        const data = await api<Snapshot>('snapshot', { accountIndex: index }, next.vaultId);
        if (epoch !== generation.current || request !== sequence.current) return;
        setSnapshot(data); hasSnapshot.current = true; snapshotKey.current = key; snapshotAt.current = Date.now();
      }
      setError('');
    } catch (e) {
      if (epoch !== generation.current || request !== sequence.current) return;
      if (!next) { setConnected(false); setStatus(null); setSnapshot(null); hasSnapshot.current = false; }
      setError(readableError(e));
    } finally { if (request === sequence.current) setLoading(false); }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    // Reading local engine state never starts a sync or contacts a public node.
    const poll = async () => {
      if (!document.hidden) await refresh(false);
      if (active) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    const visible = () => { if (!document.hidden) void refresh(false); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; sequence.current++; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), toast.tone === 'error' ? 6500 : 4200); return () => clearTimeout(timer); }, [toast]);

  const setAccountIndex = (index: number) => {
    generation.current++; accountRef.current = index; setAccountIndexState(index); setSnapshot(null); hasSnapshot.current = false;
    if (vaultRef.current) localStorage.setItem('monero-gui-selected-account', JSON.stringify({ vaultId: vaultRef.current, index }));
    void refresh();
  };
  const request = <T,>(action: string, params: Record<string, unknown> = {}) => api<T>(action, params, status?.vaultId ?? null);
  const sync = async () => {
    // Custom nodes need the host permission; request it first while the click gesture is active.
    const current = statusRef.current;
    if (current?.nodeId?.startsWith('custom-') && current.nodeUrl) await ensureNodePermission(current.nodeUrl);
    await request('wallet.refresh'); await refresh();
  };
  const close = async () => {
    await request('wallet.close');
    generation.current++; setSnapshot(null); hasSnapshot.current = false; setStatus(null); setError('');
    setAccountIndexState(0); accountRef.current = 0; vaultRef.current = undefined;
    await refresh();
  };
  return <Context.Provider value={{ status, snapshot, connected, loading, error: error || pendingError, accountIndex, hidden, walletName,
    ready: connected && !!status?.walletOpen && !!snapshot && pendingReady && !error,
    setAccountIndex, setHidden, setWalletName, refresh, sync, close, request, notify, pendingTransfer, resolveTransfer }}>
    {children}
    {toast && <div key={toast.id} className={`toast ${toast.tone}`} role="status"><span className="toast-icon">{toast.tone === 'error' ? <AlertCircle size={16} /> : toast.tone === 'info' ? <Info size={16} /> : <Check size={16} />}</span><span className="toast-message">{toast.message}</span><button onClick={() => setToast(null)} aria-label="Dismiss notification"><X size={15} /></button></div>}
  </Context.Provider>;
}
export function useWallet() { const value = useContext(Context); if (!value) throw new Error('Missing WalletProvider'); return value; }
