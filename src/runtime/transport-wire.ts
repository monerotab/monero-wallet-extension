import { BACKUP_CHUNK_CHARS, MAX_BACKUP_CHARS, MAX_MESSAGE_CHARS, MAX_PENDING_REQUESTS, LOST_MESSAGE,
  TransportError, plain, type RuntimePort } from './transport.ts';

const MAX_STREAM_CHARS = MAX_BACKUP_CHARS + 32_768;
const MAX_BUFFERED_CHARS = 2 * MAX_STREAM_CHARS;
let bufferedIncoming = 0;
let bufferedOutgoing = 0;

/** Chrome ports use JSON and cap individual messages. Stream large encrypted backups
 * in acknowledged bounded chunks; no persistence, replay, or request retry. */
export class PortWire {
  private closed = false;
  private serial = 0;
  private sends = 0;
  private tail: Promise<void> = Promise.resolve();
  private outgoing?: { id: number; part: number; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  private incoming?: { id: number; length: number; received: number; parts: string[]; timer: ReturnType<typeof setTimeout> };
  private lastIncoming = 0;
  private readonly port: RuntimePort;
  private readonly receiveData: (value: unknown) => void;
  private readonly closedCallback: () => void;
  constructor(port: RuntimePort, receiveData: (value: unknown) => void, closed: () => void) {
    this.port = port; this.receiveData = receiveData; this.closedCallback = closed;
    port.onMessage.addListener(this.onMessage); port.onDisconnect.addListener(this.onDisconnect);
  }
  private onDisconnect = () => { void globalThis.chrome?.runtime?.lastError; this.close(false); };
  private raw(value: unknown) { if (this.closed) throw new TransportError(LOST_MESSAGE); this.port.postMessage(value); }
  private onMessage = (value: unknown) => {
    try {
      if (!plain(value)) throw new Error();
      if (value.kind === 'wire-ack') {
        if (!this.outgoing || value.id !== this.outgoing.id || value.part !== this.outgoing.part) throw new Error();
        clearTimeout(this.outgoing.timer); const { resolve } = this.outgoing; this.outgoing = undefined; resolve(); return;
      }
      if (value.kind === 'wire-start') {
        if (this.incoming || !Number.isSafeInteger(value.id) || (value.id as number) <= this.lastIncoming ||
          !Number.isSafeInteger(value.length) || (value.length as number) <= MAX_MESSAGE_CHARS || (value.length as number) > MAX_STREAM_CHARS ||
          bufferedIncoming + (value.length as number) > MAX_BUFFERED_CHARS) throw new Error();
        bufferedIncoming += value.length as number;
        this.lastIncoming = value.id as number;
        this.incoming = { id: value.id as number, length: value.length as number, received: 0, parts: [], timer: setTimeout(() => this.close(), 30_000) };
        this.raw({ kind: 'wire-ack', id: value.id, part: -1 }); return;
      }
      if (value.kind === 'wire-chunk') {
        const incoming = this.incoming;
        if (!incoming || value.id !== incoming.id || value.part !== incoming.parts.length || typeof value.text !== 'string' ||
          !value.text.length || value.text.length > BACKUP_CHUNK_CHARS || incoming.received + value.text.length > incoming.length) throw new Error();
        incoming.parts.push(value.text); incoming.received += value.text.length;
        clearTimeout(incoming.timer); incoming.timer = setTimeout(() => this.close(), 30_000);
        this.raw({ kind: 'wire-ack', id: value.id, part: value.part });
        if (incoming.received === incoming.length) {
          clearTimeout(incoming.timer); this.incoming = undefined; bufferedIncoming -= incoming.length;
          const data: unknown = JSON.parse(incoming.parts.join('')); incoming.parts.length = 0;
          this.receiveData(data);
        }
        return;
      }
      // Ordinary packets have a much smaller cap than complete encrypted backups.
      if (JSON.stringify(value).length > MAX_MESSAGE_CHARS) throw new Error();
      this.receiveData(value);
    } catch { this.close(); }
  };
  private acknowledged(value: Record<string, unknown>, id: number, part: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.outgoing = { id, part, resolve, reject, timer: setTimeout(() => this.close(), 30_000) };
      try { this.raw(value); } catch { this.close(); }
    });
  }
  async send(value: unknown): Promise<void> {
    if (this.closed) throw new TransportError(LOST_MESSAGE);
    const serialized = JSON.stringify(value);
    if (serialized.length <= MAX_MESSAGE_CHARS) {
      try { this.raw(value); return; } catch { this.close(); throw new TransportError(LOST_MESSAGE); }
    }
    if (serialized.length > MAX_STREAM_CHARS || this.sends >= MAX_PENDING_REQUESTS || bufferedOutgoing + serialized.length > MAX_BUFFERED_CHARS)
      throw new TransportError('Wallet backup exceeds the transport safety limit or another large backup is in progress.', 'LIMIT_EXCEEDED');
    this.sends++; bufferedOutgoing += serialized.length;
    const task = this.tail.then(async () => {
      if (this.closed) throw new TransportError(LOST_MESSAGE);
      const id = ++this.serial;
      await this.acknowledged({ kind: 'wire-start', id, length: serialized.length }, id, -1);
      for (let start = 0, part = 0; start < serialized.length; start += BACKUP_CHUNK_CHARS, part++) {
        await this.acknowledged({ kind: 'wire-chunk', id, part, text: serialized.slice(start, start + BACKUP_CHUNK_CHARS) }, id, part);
      }
    });
    this.tail = task.catch(() => undefined);
    try { await task; } finally { this.sends--; bufferedOutgoing -= serialized.length; }
  }
  close(disconnect = true) {
    if (this.closed) return;
    this.closed = true;
    this.port.onMessage.removeListener(this.onMessage); this.port.onDisconnect.removeListener(this.onDisconnect);
    if (this.outgoing) { clearTimeout(this.outgoing.timer); this.outgoing.reject(new TransportError(LOST_MESSAGE)); this.outgoing = undefined; }
    if (this.incoming) { clearTimeout(this.incoming.timer); bufferedIncoming -= this.incoming.length; this.incoming.parts.length = 0; this.incoming = undefined; }
    if (disconnect) { try { this.port.disconnect(); } catch { /* Already detached. */ } }
    this.closedCallback();
  }
}
