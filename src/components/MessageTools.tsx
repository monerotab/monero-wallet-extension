import { useState } from 'react';
import { BadgeCheck, CircleX, FileSignature, ShieldCheck } from 'lucide-react';
import type { MessageVerification } from '../lib/types';
import { describeAddress } from '../lib/address';
import { useWallet } from './WalletContext';
import { CopyButton, ErrorBox, Spinner } from './ui';

/** Local-only message signing/verification (wallet2 sign/verify). No network access. */
export default function MessageTools() {
  const { snapshot, status, accountIndex, request: api } = useWallet();
  const canUse = !!status?.walletOpen && !status.syncing;
  const network = snapshot?.network !== 'unknown' ? snapshot?.network : undefined;
  const [message, setMessage] = useState(''); const [addressIndex, setAddressIndex] = useState(0); const [mode, setMode] = useState<'spend' | 'view'>('spend');
  const [signature, setSignature] = useState<{ signature: string; address: string } | null>(null);
  const [verifyMessage, setVerifyMessage] = useState(''); const [verifyAddress, setVerifyAddress] = useState(''); const [verifySignature, setVerifySignature] = useState('');
  const [result, setResult] = useState<MessageVerification | null>(null);
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const addressInfo = describeAddress(verifyAddress, network);
  async function sign() {
    setBusy('sign'); setError(''); setSignature(null);
    try { setSignature(await api<{ signature: string; address: string }>('message.sign', { message, accountIndex, addressIndex, mode })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  async function verify() {
    setBusy('verify'); setError(''); setResult(null);
    try { setResult(await api<MessageVerification>('message.verify', { message: verifyMessage, address: verifyAddress.trim(), signature: verifySignature.trim() })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  return <>
    {error && <ErrorBox>{error}</ErrorBox>}
    <section className="settings-card tool-card">
      <div className="section-title"><h2><FileSignature size={16} />Sign a message</h2><span className="subtle-tag">OFFLINE</span></div>
      <p className="muted">Prove that you control an address without sending funds. The signature is created locally.</p>
      <form className="form-stack" onSubmit={event => { event.preventDefault(); void sign(); }}>
        <div className="field"><label htmlFor="sign-message">Message to sign</label><textarea id="sign-message" rows={3} maxLength={4000} value={message} onChange={e => { setMessage(e.target.value); setSignature(null); }} placeholder="Text to sign" /></div>
        <div className="two-columns">
          <label>Signing address<select value={addressIndex} onChange={e => { setAddressIndex(Number(e.target.value)); setSignature(null); }}>{snapshot?.addresses.map(item => <option key={item.index} value={item.index}>#{item.index} · {item.label || (item.index === 0 ? 'Primary address' : `Subaddress ${item.index}`)}</option>)}</select></label>
          <label>Key<select value={mode} onChange={e => { setMode(e.target.value as 'spend' | 'view'); setSignature(null); }}><option value="spend">Spend key (proves ownership)</option><option value="view">View key</option></select></label>
        </div>
        <button className="button primary" disabled={!canUse || !message || !!busy}>{busy === 'sign' ? <Spinner /> : <FileSignature size={15} />}Sign message</button>
        {signature && <div className="result-box"><span>Signature for {signature.address.slice(0, 8)}…{signature.address.slice(-6)}</span><div className="copy-field"><code>{signature.signature}</code><CopyButton text={signature.signature} label="Copy signature" small /></div></div>}
      </form>
    </section>
    <section className="settings-card tool-card">
      <div className="section-title"><h2><ShieldCheck size={16} />Verify a signature</h2><span className="subtle-tag">OFFLINE</span></div>
      <form className="form-stack" onSubmit={event => { event.preventDefault(); void verify(); }}>
        <div className="field"><label htmlFor="verify-message">Signed message</label><textarea id="verify-message" rows={3} maxLength={4000} value={verifyMessage} onChange={e => { setVerifyMessage(e.target.value); setResult(null); }} placeholder="Exact signed text" /></div>
        <div className="field"><label htmlFor="verify-address">Address</label><input id="verify-address" value={verifyAddress} onChange={e => { setVerifyAddress(e.target.value.replace(/\s+/g, '')); setResult(null); }} spellCheck={false} maxLength={106} placeholder="Signer's Monero address" /><div className={`field-help ${addressInfo.tone}`}>{addressInfo.message}</div></div>
        <label>Signature<input value={verifySignature} onChange={e => { setVerifySignature(e.target.value); setResult(null); }} spellCheck={false} maxLength={500} placeholder="SigV2…" /></label>
        <button className="button secondary" disabled={!canUse || !verifyAddress || !verifySignature || addressInfo.tone === 'error' || !!busy}>{busy === 'verify' ? <Spinner /> : <BadgeCheck size={15} />}Verify signature</button>
        {result && <div className={`verify-result ${result.good ? 'good' : 'bad'}`} role="status">{result.good ? <BadgeCheck size={18} /> : <CircleX size={18} />}<span>{result.good ? `Valid signature made with the ${result.signatureType ?? ''} key${result.old ? ' (legacy format)' : ''}.` : 'This signature does not match the message and address.'}</span></div>}
      </form>
    </section>
  </>;
}
