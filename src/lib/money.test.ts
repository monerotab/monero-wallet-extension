import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, formatXmr, paymentUri, shortAddress, toAtomic } from './money.ts';

describe('exact XMR values', () => {
  it('converts all 12 decimal places without floating point', () => {
    assert.equal(toAtomic('0.000000000001'), 1n);
    assert.equal(toAtomic('9007.199254740993'), 9007199254740993n);
    assert.equal(toAtomic('18446744.073709551615'), 18446744073709551615n);
  });
  it('formats exact large and tiny values', () => {
    assert.equal(formatXmr('9007199254740993'), '9,007.199254740993');
    assert.equal(formatXmr('1'), '0.000000000001');
    assert.equal(formatXmr('0'), '0.0000');
    assert.equal(formatXmr(undefined), '—');
  });
  for (const amount of ['1e4', '1.0000000000001', '-1', '1,2', ' 1', '.1', '01', '18446744.073709551616', 'Infinity', 'NaN']) {
    it(`rejects invalid amount ${amount}`, () => assert.throws(() => toAtomic(amount)));
  }
});
describe('payment requests and exports', () => {
  it('encodes payment descriptions, only when an address exists', () => {
    assert.equal(paymentUri('44address', '1.25', 'Coffee & cake'), 'monero:44address?tx_amount=1.25&tx_description=Coffee%20%26%20cake');
    assert.equal(paymentUri('44address', '', ''), 'monero:44address');
    assert.equal(paymentUri('44address', '', 'a+b', 'Bob & Co'), 'monero:44address?recipient_name=Bob%20%26%20Co&tx_description=a%2Bb');
    assert.equal(paymentUri('', '1', ''), '');
    assert.throws(() => paymentUri('44address', '0', ''));
  });
  it('prevents spreadsheet formula injection', () => {
    assert.equal(csvCell('=WEBSERVICE("x")'), '"\'=WEBSERVICE(""x"")"');
    assert.equal(csvCell('hello, world'), '"hello, world"');
    assert.equal(csvCell('-123'), '"\'-123"');
  });
  it('shortens addresses only for non-confirmation summaries', () => assert.equal(shortAddress('12345678901234567890', 4), '1234…7890'));
});
