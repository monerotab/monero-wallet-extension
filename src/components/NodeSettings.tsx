import { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { Check, ExternalLink, Globe2, LockKeyhole, Plus, Radio, RefreshCw, Server, ShieldAlert, Trash2, TriangleAlert } from 'lucide-react';
import { clearPendingNode, ensureNodePermission, normalizeNodeUrl, readPendingNode, savePendingNode } from '../lib/node-permissions';
import presets from '../../shared/nodes.json';
import type { Network, NodeApplied, NodeCheck, NodePreset, NodeSelection } from '../lib/types';
import { useWallet } from './WalletContext';
import { ErrorBox, Modal, Spinner } from './ui';

const bundledNodes = (presets as NodePreset[]).filter(node => node.kind === 'public');
const visibleNodes = (nodes: NodePreset[]) => nodes.filter(node => node.kind === 'public' || node.kind === 'custom');
export default function NodeSettings() {
  const wallet = useWallet();
  const api = wallet.request;
  const walletNetwork = wallet.status?.walletOpen ? wallet.status.network : 'unknown';
  const [network, setNetwork] = useState<Exclude<Network, 'unknown'>>('mainnet');
  const [selection, setSelection] = useState<NodeSelection>({ nodes: bundledNodes, selectedNodeId: null, appliedAt: null });
  const [checks, setChecks] = useState<Record<string, NodeCheck>>({});
  const [privacy, setPrivacy] = useState(false);
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<NodePreset | null>(null);
  const [adding, setAdding] = useState(false); const [customName, setCustomName] = useState(''); const [customUrl, setCustomUrl] = useState(''); const [customError, setCustomError] = useState('');
  const [removing, setRemoving] = useState<NodePreset | null>(null); const [resumed, setResumed] = useState(false);
  useEffect(() => {
    let active = true;
    void readPendingNode(wallet.status?.walletOpen ? wallet.status.vaultId : undefined).then(pending => {
      if (!active || !pending) return;
      setAdding(true); setCustomName(pending.name); setCustomUrl(pending.url); setResumed(true);
    });
    return () => { active = false; };
  }, [wallet.status?.vaultId, wallet.status?.walletOpen]);
  const mounted = useRef(true); const operation = useRef(false); const listVersion = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; listVersion.current++; }; }, []);
  useEffect(() => { if (walletNetwork !== 'unknown') setNetwork(walletNetwork); setConfirm(null); }, [walletNetwork]);
  useEffect(() => { setPrivacy(false); setConfirm(null); }, [wallet.status?.vaultId]);

  async function reloadSelection() {
    const request = ++listVersion.current;
    try {
      const result = await api<NodeSelection>('node.list');
      if (mounted.current && request === listVersion.current) setSelection({ ...result, nodes: visibleNodes(result.nodes) });
    } catch (e) { if (mounted.current && request === listVersion.current) setError((e as Error).message); }
  }
  useEffect(() => {
    if (!wallet.connected) { listVersion.current++; setSelection({ nodes: bundledNodes, selectedNodeId: null, appliedAt: null }); return; }
    void reloadSelection(); // Reads local configuration only; never probes a node.
  }, [wallet.connected, wallet.status?.walletOpen, wallet.status?.vaultId, wallet.status?.nodeId]);

  async function checkNode(node: NodePreset) {
    if (operation.current || !privacy) return;
    operation.current = true; setBusy(`check:${node.id}`); setError('');
    try {
      if (node.kind === 'custom') await ensureNodePermission(node.url);
      const result = await api<NodeCheck>('node.check', { nodeId: node.id, acknowledgePrivacy: true });
      if (mounted.current) setChecks(previous => ({ ...previous, [node.id]: result }));
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { operation.current = false; if (mounted.current) setBusy(''); }
  }
  async function applyNode() {
    if (!confirm || operation.current || !privacy) return;
    const node = confirm;
    operation.current = true; listVersion.current++; setBusy(`select:${node.id}`); setError('');
    try {
      if (node.kind === 'custom') await ensureNodePermission(node.url);
      const result = await api<NodeApplied>('node.select', { nodeId: node.id, acknowledgePrivacy: true });
      if (mounted.current) {
        setSelection({ ...result, nodes: visibleNodes(result.nodes) });
        setChecks(previous => ({ ...previous, [node.id]: result.check })); setConfirm(null);
        wallet.notify(`Node saved: ${node.name}. Start Sync when you are ready.`);
      }
      await wallet.refresh();
    } catch (e) {
      if (mounted.current) { setError((e as Error).message); setConfirm(null); }
      await reloadSelection();
    } finally { operation.current = false; if (mounted.current) setBusy(''); }
  }
  async function addCustom() {
    if (operation.current) return;
    const normalized = normalizeNodeUrl(customUrl);
    if (!normalized.ok) { setCustomError(normalized.message); return; }
    if (!customName.trim()) { setCustomError('Give the node a name, e.g. “Home node”.'); return; }
    operation.current = true; setBusy('add'); setCustomError('');
    if (wallet.status?.vaultId) savePendingNode({ vaultId: wallet.status.vaultId, name: customName.trim(), url: normalized.url });
    try {
      // Ask Chrome for this exact origin while we still have the click gesture.
      await ensureNodePermission(normalized.url);
      const result = await api<NodeSelection>('node.custom.add', { name: customName.trim(), url: normalized.url });
      clearPendingNode();
      if (mounted.current) { setSelection({ ...result, nodes: visibleNodes(result.nodes) }); setAdding(false); setResumed(false); setCustomName(''); setCustomUrl(''); }
      wallet.notify('Custom node added. Check it, then choose Use node.');
    } catch (e) { if (mounted.current) setCustomError((e as Error).message); }
    finally { operation.current = false; if (mounted.current) setBusy(''); }
  }
  async function removeCustom(node: NodePreset) {
    if (operation.current) return;
    operation.current = true; setBusy(`remove:${node.id}`); setError('');
    try {
      const result = await api<NodeSelection>('node.custom.remove', { nodeId: node.id });
      // Revoke the optional host access too, unless another saved node uses the same host.
      if (typeof chrome !== 'undefined' && chrome.permissions && !result.nodes.some(other => other.kind === 'custom' && new URL(other.url).hostname === new URL(node.url).hostname))
        void chrome.permissions.remove({ origins: [`${node.url}/*`] }).catch(() => undefined);
      if (mounted.current) { setSelection({ ...result, nodes: visibleNodes(result.nodes) }); setRemoving(null); }
      await wallet.refresh(); wallet.notify(result.selectedNodeId ? 'Custom node removed' : 'Custom node removed. Choose a node before you sync again.', result.selectedNodeId ? 'success' : 'info');
    } catch (e) { if (mounted.current) { setError((e as Error).message); setRemoving(null); } }
    finally { operation.current = false; if (mounted.current) setBusy(''); }
  }
  const preview = customUrl ? normalizeNodeUrl(customUrl) : null;
  const selected = selection.nodes.find(node => node.id === selection.selectedNodeId);
  const canSelect = wallet.connected && !!wallet.status?.walletOpen && walletNetwork !== 'unknown' && !wallet.status.syncing;
  return <section className="card node-settings" id="network-nodes">
    <div className="section-title"><h2><Globe2 size={18} />Monero network nodes</h2><span className="subtle-tag">UNTRUSTED BY DESIGN</span></div>
    <p className="muted">Connect to a remote node to scan the blockchain. Your keys stay in this extension.</p>
    <div className="node-active-summary"><Radio size={18} /><div><strong>{selected ? `Saved node: ${selected.name}` : 'No saved node selected'}</strong><p>{selected ? `${selected.url} · ${selected.network}` : 'Select an endpoint below.'}</p><small>Saved encrypted. Only an explicit check or Sync contacts the node; selection is not proof of connectivity.</small></div></div>
    <div className="node-network-row"><label htmlFor="node-network">Browse network</label><select id="node-network" value={network} disabled={!!busy} onChange={e => setNetwork(e.target.value as Exclude<Network, 'unknown'>)}><option value="mainnet">Mainnet · real XMR</option><option value="stagenet">Stagenet · test funds</option><option value="testnet">Testnet · test funds</option></select><span className="muted">{walletNetwork === 'unknown' ? 'No wallet network selected' : `Open wallet: ${walletNetwork}`}</span></div>
    <div className="warning-box node-privacy"><ShieldAlert size={20} /><div><strong>Public nodes are a privacy trade-off.</strong><p>Operators can see your IP and request timing. HTTP traffic is unencrypted. Your private keys and recovery phrase never leave the extension.</p><label className="checkbox-label"><input type="checkbox" checked={privacy} disabled={!!busy} onChange={e => setPrivacy(e.target.checked)} /><span>I understand the privacy trade-off and allow explicit node checks and selection.</span></label></div></div>
    {error && <ErrorBox>{error}</ErrorBox>}
    {!wallet.connected && <div className="inline-info">The built-in wallet engine is starting. Node actions will become available when it is ready.</div>}
    {wallet.status?.syncing && <div className="inline-info"><Spinner /><span>Synchronization is in progress. Wait for it to finish before changing the saved node.</span></div>}
    <div className="node-grid">{selection.nodes.filter(node => node.network === network).map(node => {
      const check = checks[node.id]; const active = selected?.id === node.id;
      const compatible = walletNetwork === node.network;
      return <article className={`node-card ${active ? 'node-selected' : ''}`} key={node.id} data-node-id={node.id}>
        <div className="node-card-heading"><div className="node-provider-icon">{node.kind === 'custom' ? <Server size={20} /> : <Globe2 size={20} />}</div><div><h3>{node.name}</h3><span className="node-kind">{node.kind === 'custom' ? 'Your node' : 'Public node'} · {node.network}</span></div>{active && <span className="node-selected-tag"><Check size={12} />Saved</span>}</div>
        <p className="node-url mono">{node.url}</p><div className="node-transport"><LockKeyhole size={13} />{node.url.startsWith('https:') ? 'HTTPS · verified TLS required' : 'HTTP · unencrypted transport'}</div>
        <div className={`node-check-result ${check?.reachable ? 'node-reachable' : ''}`} aria-live="polite">
          {!check ? <span>Not checked · no background requests</span> : check.reachable ? <><strong>Reachable · {check.latencyMs === null ? 'latency unknown' : `${check.latencyMs} ms`}</strong><span>Height {check.height === null ? 'unknown' : check.height.toLocaleString()} · {check.network}</span><span>{check.synchronized === true ? 'Node synchronized' : check.synchronized === false ? 'Node is synchronizing' : 'Node sync status unavailable'}</span><small>Checked {new Date(check.checkedAt).toLocaleTimeString()}</small></> : <><strong>Check unsuccessful</strong><span>{check.error || 'This node could not be reached.'}</span></>}
        </div>
        <div className="node-card-actions"><button className="button secondary small" disabled={!wallet.connected || !privacy || !!busy} onClick={() => void checkNode(node)}>{busy === `check:${node.id}` ? <Spinner /> : <RefreshCw size={14} />}Check node</button><button className="button primary small" disabled={!canSelect || !compatible || !privacy || !!busy} onClick={() => setConfirm(node)}>{busy === `select:${node.id}` ? <Spinner /> : <Check size={14} />}{active ? 'Apply again' : 'Use node'}</button></div>
        {!compatible && <p className="node-compatibility">{walletNetwork === 'unknown' ? 'Unlock a wallet to select a node.' : `This preset is for ${node.network}; your wallet uses ${walletNetwork}.`}</p>}
        {node.kind === 'custom' ? <button className="text-button node-remove" disabled={!!busy || !!wallet.status?.syncing} onClick={() => setRemoving(node)}><Trash2 size={12} />Remove</button>
          : <a className="node-source" href={node.source} target="_blank" rel="noreferrer">Preset source<ExternalLink size={12} /></a>}
        {node.url.startsWith('http:') && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(node.url) && <p className="node-http-warning"><TriangleAlert size={12} />Unencrypted: your provider can see that you use Monero and which transactions you broadcast (not your balance or addresses).</p>}
      </article>;
    })}</div>
    {walletNetwork !== 'unknown' && network === walletNetwork && (adding ? <form className="custom-node-form" onSubmit={event => { event.preventDefault(); void addCustom(); }}>
      <h3><Server size={15} />Add your own node</h3>
      {resumed && <div className="inline-info"><Check size={15} /><span>Your unfinished node was restored. Click Add node to finish; Chrome will not ask again if you already allowed access.</span></div>}
      <p className="muted">Use your own <code>monerod</code> for the best privacy, e.g. <code>http://127.0.0.1:{walletNetwork === 'mainnet' ? 18081 : walletNetwork === 'stagenet' ? 38081 : 28081}</code> for a node on this computer. It must run on {walletNetwork}.</p>
      {customError && <ErrorBox>{customError}</ErrorBox>}
      <div className="two-columns">
        <label>Node name<input value={customName} onChange={e => setCustomName(e.target.value)} maxLength={40} placeholder="Home node" /></label>
        <label>Node address<input value={customUrl} onChange={e => { setCustomUrl(e.target.value.trim()); setCustomError(''); }} maxLength={200} spellCheck={false} placeholder="http://192.168.1.10:18089" /></label>
      </div>
      <div className={`field-help ${preview && !preview.ok ? 'error' : ''}`}>{preview ? preview.ok ? `Will connect to ${preview.url}` : preview.message : 'http:// or https://, host and optional port. No login or path.'}</div>
      <p className="form-footnote">Chrome will ask you to allow access to this address. Remote nodes must allow browser requests: start monerod with <code>--rpc-bind-ip</code>, <code>--confirm-external-bind</code> and preferably <code>--restricted-rpc</code>. Credentials are not supported.</p>
      <div className="button-row"><button type="button" className="button secondary small" onClick={() => { setAdding(false); setResumed(false); setCustomError(''); clearPendingNode(); }} disabled={busy === 'add'}>Cancel</button><button className="button primary small" disabled={!!busy || !customUrl || !customName.trim() || (preview !== null && !preview.ok)}>{busy === 'add' ? <Spinner /> : <Plus size={14} />}Add node</button></div>
    </form> : <button className="button secondary add-node-button" disabled={!!busy || !wallet.status?.walletOpen} onClick={() => { setAdding(true); setCustomError(''); }}><Plus size={15} />Add your own node</button>)}
    <p className="form-footnote">No automatic fallback, background health checks, or automatic synchronization on unlock. Node operators may be unavailable or provide inaccurate data. Check the network and sync before sending.</p>
    <AnimatePresence>{removing && <Modal key="remove-node" title="Remove this node?" onClose={() => setRemoving(null)} busy={!!busy}>
      <div className="form-stack"><p className="muted">{removing.name} · <span className="mono">{removing.url}</span>{selection.selectedNodeId === removing.id ? '. It is your selected node: choose another node before you sync again.' : '.'}</p>
        <div className="button-row"><button className="button secondary" onClick={() => setRemoving(null)} disabled={!!busy}>Cancel</button><button className="button danger" disabled={!!busy} onClick={() => void removeCustom(removing)}>{busy ? <Spinner /> : <Trash2 size={15} />}Remove node</button></div></div>
    </Modal>}{confirm && <Modal title="Use this Monero node?" eyebrow="EXPLICIT NETWORK PERMISSION" onClose={() => setConfirm(null)} busy={!!busy}>
      <div className="form-stack"><dl className="detail-list"><div><dt>Endpoint</dt><dd className="mono">{confirm.url}</dd></div><div><dt>Network</dt><dd className="capitalize">{confirm.network}</dd></div><div><dt>Trust mode</dt><dd>Untrusted</dd></div></dl>
        <div className="warning-box"><ShieldAlert size={19} /><span>This check contacts the operator and reveals your IP. The chosen node is saved in your encrypted wallet. Switching invalidates prepared transaction drafts; it does not send a payment or automatically start synchronization.</span></div>
        <div className="button-row"><button className="button secondary" disabled={!!busy} onClick={() => setConfirm(null)}>Cancel</button><button className="button primary" disabled={!!busy || !privacy || !canSelect} onClick={() => void applyNode()}>{busy ? <Spinner /> : <Check size={16} />}Check & save node</button></div>
      </div>
    </Modal>}</AnimatePresence>
  </section>;
}
