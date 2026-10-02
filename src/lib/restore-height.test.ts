import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { approximateHeight, localDateString, networkStartDate, restoreHeightFromDate, RESTORE_HEIGHT_MAX, type RestoreDateResult } from './restore-height.ts';

type GuiNetwork = 'Mainnet' | 'Testnet' | 'Stagenet';
/** Direct port of monero-gui js/Wizard.js getApproximateBlockchainHeight(). */
function guiReference(date: string, nettype: GuiNetwork): number {
  const moneroBirthTime = nettype === 'Mainnet' ? 1397818193 : nettype === 'Testnet' ? 1410295020 : 1518932025;
  const secondsPerBlockV1 = 60;
  const forkTime = nettype === 'Mainnet' ? 1458748658 : nettype === 'Testnet' ? 1448285909 : 1520937818;
  const forkBlock = nettype === 'Mainnet' ? 1009827 : nettype === 'Testnet' ? 624634 : 32000;
  const secondsPerBlockV2 = 120;
  const requestedTime = Math.floor(new Date(date).getTime() / 1000);
  let approxBlockchainHeight: number;
  let secondsPerBlock: number;
  if (requestedTime < moneroBirthTime) return 0;
  if (requestedTime > moneroBirthTime && requestedTime < forkTime) {
    approxBlockchainHeight = Math.floor((requestedTime - moneroBirthTime) / secondsPerBlockV1);
    secondsPerBlock = secondsPerBlockV1;
  } else {
    approxBlockchainHeight = Math.floor(forkBlock + (requestedTime - forkTime) / secondsPerBlockV2);
    secondsPerBlock = secondsPerBlockV2;
  }
  if (nettype === 'Testnet' || nettype === 'Stagenet') {
    const approximateTestnetRolledBackBlocks = nettype === 'Testnet' ? 342100 : 60000;
    if (approxBlockchainHeight > approximateTestnetRolledBackBlocks) approxBlockchainHeight -= approximateTestnetRolledBackBlocks;
  }
  const blocksPerMonth = 60 * 60 * 24 * 30 / secondsPerBlock;
  return approxBlockchainHeight - blocksPerMonth > 0 ? approxBlockchainHeight - blocksPerMonth : 0;
}

const networks = [['mainnet', 'Mainnet'], ['testnet', 'Testnet'], ['stagenet', 'Stagenet']] as const;
const utcSeconds = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
const reason = (result: RestoreDateResult) => result.ok ? 'ok' : result.reason;

describe('restore height from a date (Monero GUI estimator)', () => {
  it('reproduces known reference values before and after the v2 fork', () => {
    assert.equal(approximateHeight(utcSeconds('2024-01-01'), 'mainnet'), 3_032_548);
    assert.equal(approximateHeight(utcSeconds('2024-01-01'), 'testnet'), 2_392_444);
    assert.equal(approximateHeight(utcSeconds('2024-01-01'), 'stagenet'), 1_476_478);
    // 60-second v1 blocks use a 43,200-block one-month margin.
    assert.equal(approximateHeight(utcSeconds('2015-01-01'), 'mainnet'), 327_670);
  });

  it('matches the Monero GUI implementation on every tenth day since each launch', () => {
    for (const [network, nettype] of networks) {
      const first = Date.parse(`${networkStartDate(network)}T00:00:00Z`) + 86_400_000;
      let compared = 0;
      for (let time = first; time < Date.UTC(2031, 0, 1); time += 10 * 86_400_000) {
        const date = new Date(time).toISOString().slice(0, 10);
        const result = restoreHeightFromDate(date, network, '2031-01-01');
        assert.equal(result.ok && result.height, guiReference(date, nettype), `${network} ${date}`);
        compared++;
      }
      assert.ok(compared > 400, `${network}: ${compared} dates compared`);
    }
  });

  it('knows each network launch date and returns height 0 on it', () => {
    assert.equal(networkStartDate('mainnet'), '2014-04-18');
    assert.equal(networkStartDate('testnet'), '2014-09-09');
    assert.equal(networkStartDate('stagenet'), '2018-02-18');
    for (const [network] of networks) {
      const launch = restoreHeightFromDate(networkStartDate(network), network, '2030-01-01');
      assert.equal(launch.ok && launch.height, 0);
      assert.equal(approximateHeight(0, network), 0);
      assert.equal(approximateHeight(Number.NaN, network), 0);
    }
  });

  it('accepts today but rejects future dates', () => {
    const today = restoreHeightFromDate('2024-01-01', 'mainnet', '2024-01-01');
    assert.equal(today.ok && today.height, 3_032_548);
    assert.equal(reason(restoreHeightFromDate('2024-01-02', 'mainnet', '2024-01-01')), 'future');
  });

  it('rejects dates before the network launched with a clear message', () => {
    const early = restoreHeightFromDate('2014-04-17', 'mainnet', '2024-01-01');
    assert.equal(reason(early), 'before-start');
    assert.match(early.ok ? '' : early.message, /Mainnet launched on 2014-04-18/);
    assert.equal(reason(restoreHeightFromDate('2018-02-17', 'stagenet', '2024-01-01')), 'before-start');
    assert.equal(reason(restoreHeightFromDate('2014-09-08', 'testnet', '2024-01-01')), 'before-start');
  });

  it('rejects malformed and impossible dates', () => {
    for (const value of ['', '2024-1-1', '2024-02-30', '2023-13-01', '2023-00-10', '0099-01-01', 'yesterday', '2024-01-01T00:00']) {
      assert.equal(reason(restoreHeightFromDate(value, 'mainnet', '2024-06-01')), 'invalid', value);
    }
    assert.equal(reason(restoreHeightFromDate('2024-02-29', 'mainnet', '2024-06-01')), 'ok');
  });

  it('stays an integer inside the wallet schema bounds', () => {
    const far = restoreHeightFromDate('2999-12-31', 'mainnet', '2999-12-31');
    assert.ok(far.ok && Number.isSafeInteger(far.height) && far.height > 0 && far.height <= RESTORE_HEIGHT_MAX);
  });

  it('formats the local calendar date like a date input', () => {
    assert.equal(localDateString(new Date(2024, 0, 5, 23, 59)), '2024-01-05');
    assert.equal(localDateString(new Date(2024, 11, 31, 0, 1)), '2024-12-31');
  });
});
