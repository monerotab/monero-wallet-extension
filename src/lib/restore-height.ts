/**
 * Approximate wallet restore height from a calendar date.
 *
 * Port of Monero GUI `js/Wizard.js` getApproximateBlockchainHeight(): a linear
 * block-time model around the v2 fork (60 s blocks before it, 120 s after), a
 * testnet/stagenet rollback correction and a one-month safety margin. Scanning
 * from an earlier height is always safe; a later height can miss funds.
 */
import type { WalletNetwork } from './types';

/** Upper bound accepted by the wallet.restore schema. */
export const RESTORE_HEIGHT_MAX = 999_999_999;

interface Timeline { birthTime: number; forkTime: number; forkBlock: number; rolledBack: number }
const TIMELINES: Record<WalletNetwork, Timeline> = {
  mainnet: { birthTime: 1_397_818_193, forkTime: 1_458_748_658, forkBlock: 1_009_827, rolledBack: 0 },
  testnet: { birthTime: 1_410_295_020, forkTime: 1_448_285_909, forkBlock: 624_634, rolledBack: 342_100 },
  stagenet: { birthTime: 1_518_932_025, forkTime: 1_520_937_818, forkBlock: 32_000, rolledBack: 60_000 },
};
const LABELS: Record<WalletNetwork, string> = { mainnet: 'Mainnet', testnet: 'Testnet', stagenet: 'Stagenet' };

/** Estimated height for a UNIX time (seconds), already including the one-month margin. */
export function approximateHeight(unixSeconds: number, network: WalletNetwork): number {
  const timeline = TIMELINES[network];
  if (!Number.isFinite(unixSeconds) || unixSeconds < timeline.birthTime) return 0;
  const beforeFork = unixSeconds < timeline.forkTime;
  const secondsPerBlock = beforeFork ? 60 : 120;
  let height = beforeFork
    ? Math.floor((unixSeconds - timeline.birthTime) / 60)
    : Math.floor(timeline.forkBlock + (unixSeconds - timeline.forkTime) / 120);
  // Testnet and stagenet were rolled back, so the linear model overshoots them.
  if (timeline.rolledBack && height > timeline.rolledBack) height -= timeline.rolledBack;
  const blocksPerMonth = (60 * 60 * 24 * 30) / secondsPerBlock;
  return Math.min(RESTORE_HEIGHT_MAX, Math.max(0, height - blocksPerMonth));
}

/** First day of the network (UTC), as `YYYY-MM-DD`. */
export function networkStartDate(network: WalletNetwork): string {
  return new Date(TIMELINES[network].birthTime * 1000).toISOString().slice(0, 10);
}

/** The user's local calendar date, as `YYYY-MM-DD` (the format of `<input type="date">`). */
export function localDateString(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type RestoreDateResult =
  | { ok: true; height: number }
  | { ok: false; reason: 'invalid' | 'future' | 'before-start'; message: string };

/** Validate a `YYYY-MM-DD` wallet creation date and convert it to a restore height. */
export function restoreHeightFromDate(value: string, network: WalletNetwork, today = localDateString()): RestoreDateResult {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const time = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : Number.NaN;
  // Round-trip check rejects impossible days (2024-02-30) and two-digit-year remapping.
  if (!match || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    return { ok: false, reason: 'invalid', message: 'Enter a valid date.' };
  }
  if (value > today) {
    return { ok: false, reason: 'future', message: 'This date is in the future. Choose the day you created the wallet, or an earlier day.' };
  }
  const start = networkStartDate(network);
  if (value < start) {
    return { ok: false, reason: 'before-start', message: `${LABELS[network]} launched on ${start}. Choose that day or a later one.` };
  }
  return { ok: true, height: approximateHeight(time / 1000, network) };
}
