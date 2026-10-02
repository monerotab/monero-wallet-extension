import { useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowRight, History as HistoryIcon, Search } from 'lucide-react';
import { csvCell, downloadText, formatXmr } from '../lib/money';
import { isIncoming, isPending } from '../lib/format';
import type { Transaction } from '../lib/types';
import { useWallet } from '../components/WalletContext';
import { Amount, EmptyState, ErrorBox, TransactionRows } from '../components/ui';

type Filter = 'all' | 'in' | 'out' | 'pending';
const FILTERS: [Filter, string][] = [['all', 'All transactions'], ['in', 'Received'], ['out', 'Sent'], ['pending', 'Pending']];
/** Unconfirmed first, then newest block, then newest timestamp. */
function byRecency(a: Transaction, b: Transaction) {
  const pendingA = isPending(a) ? 1 : 0; const pendingB = isPending(b) ? 1 : 0;
  return pendingB - pendingA || (b.height || Infinity) - (a.height || Infinity) || b.timestamp - a.timestamp;
}

export default function History({ selectTransaction, setup }: { selectTransaction: (tx: Transaction) => void; setup: () => void }) {
  const { snapshot, status, ready, notify } = useWallet();
  const [filter, setFilter] = useState<Filter>('all'); const [search, setSearch] = useState(''); const [limit, setLimit] = useState(25);
  const transactions = useMemo(() => {
    const query = search.trim().toLowerCase();
    const contacts = new Map((snapshot?.contacts ?? []).map(contact => [contact.address, contact.description.toLowerCase()]));
    return (snapshot?.transactions || []).filter(tx => {
      const kindMatches = filter === 'all' || (filter === 'in' && isIncoming(tx)) || (filter === 'out' && !isIncoming(tx)) || (filter === 'pending' && (isPending(tx) || tx.confirmations < 10) && tx.type !== 'failed');
      if (!kindMatches) return false;
      if (!query) return true;
      const addresses = [tx.address, ...tx.destinations.map(item => item.address)];
      return `${tx.txid} ${tx.note} ${addresses.join(' ')} ${addresses.map(item => contacts.get(item) ?? '').join(' ')} ${formatXmr(tx.amount, 0)}`.toLowerCase().includes(query);
    }).sort(byRecency);
  }, [snapshot, filter, search]);
  const totals = useMemo(() => transactions.reduce((sum, tx) => {
    if (tx.type === 'failed') return sum;
    if (isIncoming(tx)) sum.in += BigInt(tx.amount); else { sum.out += BigInt(tx.amount); sum.fees += BigInt(tx.fee); }
    return sum;
  }, { in: 0n, out: 0n, fees: 0n }), [transactions]);
  function exportCsv() {
    const rows = [['Date', 'Type', 'Transaction ID', 'Amount (XMR)', 'Fee (XMR)', 'Confirmations', 'Block height', 'Destination', 'Note'],
      ...transactions.map(tx => [tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : '', tx.type, tx.txid, formatXmr(tx.amount, 0).replaceAll(',', ''),
        isIncoming(tx) ? '' : formatXmr(tx.fee, 0).replaceAll(',', ''), tx.confirmations, tx.height || '', tx.destinations.map(item => item.address).join(' ') || tx.address, tx.note])];
    downloadText(rows.map(row => row.map(csvCell).join(',')).join('\r\n'), 'monero-transactions.csv', 'text/csv;charset=utf-8');
    notify('Exported transaction history. Keep this file private.');
  }
  return <div className="page-content">
    <div className="page-heading"><h1>Transaction history</h1><button className="button secondary small" disabled={!transactions.length} onClick={exportCsv}><ArrowDownToLine size={15} />Export CSV</button></div>
    {status?.walletOpen && status.synced !== true && <div className="inline-info history-sync-note"><HistoryIcon size={18} /><span>{status.syncing ? 'Synchronization is in progress. This history includes only transactions already scanned.' : 'History reflects your last saved scan. Start Sync to discover new transactions and verify payment outcomes.'}</span></div>}
    {snapshot?.historyNotice && !snapshot.historyError && <p className="history-notice">{snapshot.historyNotice}</p>}
    <section className="card history-card">
      <div className="history-toolbar">
        <div className="segmented-control" role="group" aria-label="Filter transactions">{FILTERS.map(([key, label]) => <button className={filter === key ? 'active' : ''} aria-pressed={filter === key} key={key} onClick={() => { setFilter(key); setLimit(25); }}>{label}</button>)}</div>
        <div className="search-field"><Search size={16} /><input aria-label="Search transactions" value={search} onChange={e => { setSearch(e.target.value); setLimit(25); }} placeholder="Search by ID, address, contact, note or amount" /></div>
      </div>
      {transactions.length > 0 && <div className="history-summary">
        <span>In <Amount value={totals.in.toString()} className="green-text" /></span>
        <span>Out <Amount value={totals.out.toString()} /></span>
        <span>Fees <Amount value={totals.fees.toString()} /></span>
      </div>}
      {snapshot?.historyError ? <div className="history-error"><ErrorBox>{snapshot.historyError}</ErrorBox></div>
        : transactions.length ? <TransactionRows transactions={transactions.slice(0, limit)} onSelect={selectTransaction} />
        : <EmptyState icon={<HistoryIcon size={26} />} title={search || filter !== 'all' ? 'No matching transactions' : 'Nothing to see. Yet.'} description={search || filter !== 'all' ? 'Try a different filter, address, transaction ID, or note.' : ready ? 'Your transactions will appear here after synchronization finds them.' : 'Unlock your wallet to see its transactions.'} action={ready ? undefined : <button className="button primary" onClick={setup}>Open wallet<ArrowRight size={16} /></button>} />}
      <div className="table-footer">
        <span>{transactions.length ? `Showing ${Math.min(limit, transactions.length)} of ${transactions.length}` : snapshot?.historyError ? 'History unavailable' : 'No transactions'}{filter !== 'all' && ' · Filtered'}</span>
        {limit < transactions.length && <button className="text-button" onClick={() => setLimit(n => n + 25)}>Load more<ArrowRight size={14} /></button>}
        <span>Stored in your wallet. Not on our servers.</span>
      </div>
    </section>
  </div>;
}
