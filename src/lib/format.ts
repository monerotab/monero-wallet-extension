import type { Transaction } from './types';

/** Monero targets one block every two minutes. Estimates only. */
export function blocksToDuration(blocks: number): string {
  const minutes = Math.max(2, Math.round(blocks * 2));
  if (minutes < 60) return `~${minutes} min`;
  const hours = minutes / 60;
  return `~${hours < 10 ? hours.toFixed(1).replace(/\.0$/, '') : Math.round(hours)} h`;
}
export function relativeTime(timestampMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestampMs) / 1000));
  if (seconds < 15) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(timestampMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
export function dayLabel(seconds: number, now = new Date()): string {
  if (!seconds) return 'Pending';
  const date = new Date(seconds * 1000);
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
export function timeLabel(seconds: number): string {
  return seconds ? new Date(seconds * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
}
export const isIncoming = (tx: Transaction) => tx.type === 'in' || tx.type === 'pool';
export const isPending = (tx: Transaction) => tx.type === 'pending' || tx.type === 'pool';
export type Tone = 'ok' | 'pending' | 'locked' | 'failed';
/** Monero outputs unlock after 10 confirmations. */
export function txStatus(tx: Transaction): { label: string; tone: Tone } {
  if (tx.type === 'failed') return { label: 'Failed', tone: 'failed' };
  if (isPending(tx)) return { label: 'Pending', tone: 'pending' };
  if (tx.confirmations < 10) return { label: `${tx.locked ? 'Locked · ' : ''}${tx.confirmations}/10`, tone: 'locked' };
  return { label: 'Confirmed', tone: 'ok' };
}
