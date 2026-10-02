/**
 * Offline Monero address inspection: Monero base58 + Keccak-256 checksum + network prefix.
 * Pure and synchronous, used for instant form feedback only. The WebAssembly engine
 * remains the authority: it validates every address again before signing or saving.
 */
import type { WalletNetwork } from './types';

export type AddressKind = 'standard' | 'subaddress' | 'integrated';
export type AddressCheck =
  | { valid: true; network: WalletNetwork; kind: AddressKind }
  | { valid: false; reason: 'empty' | 'length' | 'characters' | 'checksum' | 'prefix' };

/** Base58 characters of a standard (95) or integrated (106) address. Never an OpenAlias/URL. */
export const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{95}(?:[1-9A-HJ-NP-Za-km-z]{11})?$/;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];
const MASK = (1n << 64n) - 1n;
// cryptonote_config.h: standard, integrated and subaddress prefixes per network.
const PREFIXES: Record<number, { network: WalletNetwork; kind: AddressKind }> = {
  18: { network: 'mainnet', kind: 'standard' }, 19: { network: 'mainnet', kind: 'integrated' }, 42: { network: 'mainnet', kind: 'subaddress' },
  53: { network: 'testnet', kind: 'standard' }, 54: { network: 'testnet', kind: 'integrated' }, 63: { network: 'testnet', kind: 'subaddress' },
  24: { network: 'stagenet', kind: 'standard' }, 25: { network: 'stagenet', kind: 'integrated' }, 36: { network: 'stagenet', kind: 'subaddress' },
};

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rotation offsets indexed by x + 5y.
const ROTATIONS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotate = (value: bigint, bits: number) => bits === 0 ? value : ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & MASK;

function permute(state: bigint[]) {
  const c = new Array<bigint>(5); const b = new Array<bigint>(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotate(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) state[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(state[x + 5 * y], ROTATIONS[x + 5 * y]);
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) state[x + y] = b[x + y] ^ ((~b[(x + 1) % 5 + y] & MASK) & b[(x + 2) % 5 + y]);
    state[0] ^= ROUND_CONSTANTS[round];
  }
}

/** Original Keccak-256 (0x01 padding), as used by Monero's cn_fast_hash — not SHA3-256. */
export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136;
  const padded = new Uint8Array(Math.floor(data.length / rate) * rate + rate);
  padded.set(data); padded[data.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane++) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte--) value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte]);
      state[lane] ^= value;
    }
    permute(state);
  }
  const output = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let value = state[lane];
    for (let byte = 0; byte < 8; byte++) { output[lane * 8 + byte] = Number(value & 0xffn); value >>= 8n; }
  }
  return output;
}

function decodeBlock(block: string, size: number): Uint8Array | null {
  let value = 0n;
  for (const character of block) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  if (value > MASK || (size < 8 && value >= 1n << BigInt(8 * size))) return null;
  const bytes = new Uint8Array(size);
  for (let index = size - 1; index >= 0; index--) { bytes[index] = Number(value & 0xffn); value >>= 8n; }
  return bytes;
}

/** Monero's block-wise base58 (8-byte blocks ↔ 11 characters), not Bitcoin base58. */
export function base58Decode(text: string): Uint8Array | null {
  const full = Math.floor(text.length / 11); const remainder = text.length % 11;
  const remainderBytes = ENCODED_BLOCK_SIZES.indexOf(remainder);
  if (remainderBytes < 0) return null;
  const bytes = new Uint8Array(full * 8 + remainderBytes);
  for (let block = 0; block < full; block++) {
    const decoded = decodeBlock(text.slice(block * 11, block * 11 + 11), 8);
    if (!decoded) return null;
    bytes.set(decoded, block * 8);
  }
  if (remainder) {
    const decoded = decodeBlock(text.slice(full * 11), remainderBytes);
    if (!decoded) return null;
    bytes.set(decoded, full * 8);
  }
  return bytes;
}

export function checkAddress(input: string): AddressCheck {
  const address = input.trim();
  if (!address) return { valid: false, reason: 'empty' };
  if (/[^1-9A-HJ-NP-Za-km-z]/.test(address)) return { valid: false, reason: 'characters' };
  if (!ADDRESS_PATTERN.test(address)) return { valid: false, reason: 'length' };
  const bytes = base58Decode(address);
  if (!bytes || bytes.length < 5) return { valid: false, reason: 'checksum' };
  const hash = keccak256(bytes.subarray(0, bytes.length - 4));
  if (!hash.subarray(0, 4).every((value, index) => value === bytes[bytes.length - 4 + index])) return { valid: false, reason: 'checksum' };
  const info = bytes[0] < 0x80 ? PREFIXES[bytes[0]] : undefined;
  if (!info || bytes.length !== (info.kind === 'integrated' ? 77 : 69)) return { valid: false, reason: 'prefix' };
  return { valid: true, network: info.network, kind: info.kind };
}

export const NETWORK_LABELS: Record<WalletNetwork, string> = { mainnet: 'Mainnet', stagenet: 'Stagenet', testnet: 'Testnet' };
export const KIND_LABELS: Record<AddressKind, string> = { standard: 'standard address', subaddress: 'subaddress', integrated: 'integrated address' };

/** Human feedback for a form. `network` is the open wallet's network. */
export function describeAddress(input: string, network?: WalletNetwork): { tone: 'neutral' | 'valid' | 'error'; message: string } {
  const result = checkAddress(input);
  if (result.valid) {
    const label = `${NETWORK_LABELS[result.network]} ${KIND_LABELS[result.kind]}`;
    if (network && result.network !== network) return { tone: 'error', message: `This is a ${label}. Your wallet uses ${NETWORK_LABELS[network]}.` };
    return { tone: 'valid', message: `Valid ${label}` };
  }
  if (result.reason === 'empty') return { tone: 'neutral', message: '' };
  if (result.reason === 'characters') return { tone: 'error', message: 'Addresses contain only base58 characters (no 0, O, I or l, spaces or punctuation).' };
  if (result.reason === 'length') {
    const length = input.trim().length;
    return { tone: length < 95 ? 'neutral' : 'error', message: length < 95 ? `${length} of 95 characters` : 'A Monero address has 95 characters (106 for integrated addresses).' };
  }
  if (result.reason === 'checksum') return { tone: 'error', message: 'Checksum mismatch. A character is wrong or missing — copy the address again.' };
  return { tone: 'error', message: 'This is not a Monero address.' };
}

export interface PaymentRequest { address: string; amount?: string; description?: string; recipientName?: string }

function decodeComponent(value: string): string {
  // wallet2 percent-encodes; many other encoders also use '+' for spaces.
  try { return decodeURIComponent(value.replace(/\+/g, '%20')); } catch { return value; }
}

/** Parse a `monero:` payment URI. Returns null for text that is not a URI at all. */
export function parsePaymentUri(input: string): PaymentRequest | { error: string } | null {
  const text = input.trim();
  if (!/^monero:/i.test(text)) return null;
  if (text.length > 4096) return { error: 'This payment link is too long.' };
  const body = text.slice(7).replace(/^\/\//, '');
  const [address, query = ''] = body.split('?', 2);
  if (!ADDRESS_PATTERN.test(address)) return { error: 'The payment link does not contain a valid Monero address.' };
  const request: PaymentRequest = { address };
  for (const part of query.split('&')) {
    if (!part) continue;
    const separator = part.indexOf('=');
    const key = separator < 0 ? part : part.slice(0, separator);
    const value = decodeComponent(separator < 0 ? '' : part.slice(separator + 1)).slice(0, 1000);
    if (key === 'tx_amount') {
      if (!/^(0|[1-9]\d{0,19})(\.\d{1,12})?$/.test(value)) return { error: 'The payment link contains an invalid amount.' };
      request.amount = value;
    } else if (key === 'tx_description') request.description = value;
    else if (key === 'recipient_name') request.recipientName = value;
    else if (key === 'tx_payment_id') return { error: 'Payment links with separate payment IDs are not supported. Ask for an integrated address instead.' };
  }
  return request;
}
