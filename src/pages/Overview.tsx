import { ArrowDownLeft, ArrowRight, ArrowUpRight, Clock3, History as HistoryIcon, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import type { Page, Transaction } from '../lib/types';
import { useWallet } from '../components/WalletContext';
import { Amount, EmptyState, ErrorBox, Spinner, TransactionRows } from '../components/ui';
import { blocksToDuration, relativeTime } from '../lib/format';
import { nodeLabel } from '../lib/node-names';

export default function Overview({ navigate, selectTransaction, sync, syncBusy }: { navigate: (page: Page) => void; selectTransaction: (tx: Transaction) => void; sync: () => void; syncBusy: boolean }) {
  const { snapshot, status, accountIndex } = useWallet();
  const account = snapshot?.accounts.find(item => item.index === accountIndex);
  const locked = snapshot ? BigInt(snapshot.balance) - BigInt(snapshot.unlockedBalance) : 0n;
  const total = snapshot?.accounts.reduce((sum, item) => sum + BigInt(item.balance), 0n) ?? 0n;
  const recent = snapshot?.transactions.slice(0, 5) ?? [];
  const progress = status?.syncProgress?.percentDone ?? 0;
  const remaining = status?.syncProgress ? Math.max(0, status.syncProgress.endHeight - status.syncProgress.height) : 0;
  return <div className="page-content overview">
    <div className="page-heading"><h1>Overview</h1><span className="subtle-tag">{snapshot?.network.toUpperCase()} · XMR</span></div>
    {status?.syncing ? <div className="sync-banner busy" aria-live="polite">
      <Spinner label="Synchronizing" />
      <div><strong>{status.rescanning ? 'Rescanning' : 'Synchronizing'}{status.syncProgress ? ` · ${Math.floor(progress * 100)}%` : '…'}</strong><span>{remaining ? `${remaining.toLocaleString()} blocks remaining. You can close the popup; progress is saved.` : 'Scanning the blockchain for your transactions.'}</span></div>
    </div> : !status?.nodeId ? <div className="sync-banner">
      <Server size={18} />
      <div><strong>Choose a node to get started</strong><span>Balances stay at zero until the wallet scans the blockchain through a node you choose.</span></div>
      <button className="button primary small" onClick={() => navigate('settings')}>Choose node<ArrowRight size={14} /></button>
    </div> : status.synced ? <div className="sync-banner ok">
      <ShieldCheck size={18} />
      <div><strong>Up to date</strong><span>Synchronized {status.lastSyncAt ? relativeTime(status.lastSyncAt) : ''} with {status.nodeName || nodeLabel(status.nodeId)}.</span></div>
    </div> : <div className="sync-banner warn">
      <RefreshCw size={18} />
      <div><strong>Balances may be out of date</strong><span>{status.lastSyncAt ? `Last synchronized ${relativeTime(status.lastSyncAt)}.` : 'This wallet has not been synchronized in this session.'} Sync before sending.</span></div>
      <button className="button primary small" disabled={syncBusy} onClick={sync}>{syncBusy ? <Spinner /> : <RefreshCw size={14} />}Sync now</button>
    </div>}
    <section className="hero-card" aria-label="Account balance">
      <div className="hero-top"><span>{account?.label || (accountIndex === 0 ? 'Primary account' : `Account ${accountIndex}`)}</span><span className="hero-index">Account #{accountIndex}</span></div>
      <div className="hero-amount"><Amount value={snapshot?.balance} decimals={4} /></div>
      <div className="hero-meta">
        <div><span>Unlocked</span><Amount value={snapshot?.unlockedBalance} /></div>
        {locked > 0n && <div><span><Clock3 size={12} />Locked</span><Amount value={locked.toString()} /><small>{snapshot?.blocksToUnlock ? `Unlocks in ${blocksToDuration(snapshot.blocksToUnlock)}` : 'Awaiting confirmations'}</small></div>}
        {(snapshot?.accounts.length ?? 0) > 1 && <div><span>All accounts</span><Amount value={total.toString()} /></div>}
      </div>
      <div className="hero-actions">
        <button className="button primary" onClick={() => navigate('send')}><ArrowUpRight size={16} />Send XMR</button>
        <button className="button secondary" onClick={() => navigate('receive')}><ArrowDownLeft size={16} />Receive XMR</button>
      </div>
    </section>
    <section className="overview-section">
      <div className="section-title"><h2>Recent activity</h2>{recent.length > 0 && <button className="text-button" onClick={() => navigate('history')}>View all<ArrowRight size={14} /></button>}</div>
      {snapshot?.historyError ? <ErrorBox>{snapshot.historyError}</ErrorBox> : recent.length ? <TransactionRows transactions={recent} onSelect={selectTransaction} grouped={false} />
        : <EmptyState icon={<HistoryIcon size={22} />} title="No transactions yet" description={status?.synced ? 'Share a receiving address to get your first payment. Incoming payments appear after their first mined block.' : 'Synchronize to discover payments to this account.'} action={<button className="button secondary small" onClick={() => navigate('receive')}><ArrowDownLeft size={14} />Show my address</button>} />}
    </section>
  </div>;
}
