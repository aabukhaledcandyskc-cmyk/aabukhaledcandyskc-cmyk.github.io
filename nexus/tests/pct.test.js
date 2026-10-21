import test from 'node:test';
import assert from 'node:assert/strict';
import { pctStatus, normalizeThresholds, fmtPct, barWidth, overflows, DEFAULT_THRESHOLDS } from '../src/pct.js';

test('status: zero of a real base is bad, no base is none', () => {
  assert.equal(pctStatus(0, true), 'bad');
  assert.equal(pctStatus(0, false), 'none');
  assert.equal(pctStatus(null, true), 'none');
  assert.equal(pctStatus(NaN, true), 'none');
  assert.equal(pctStatus(undefined), 'none');
});
test('status boundaries use the thresholds (lower bound inclusive)', () => {
  assert.equal(pctStatus(49.99), 'bad');
  assert.equal(pctStatus(50), 'warn');
  assert.equal(pctStatus(79.99), 'warn');
  assert.equal(pctStatus(80), 'good');
  assert.equal(pctStatus(135), 'good');
  assert.equal(pctStatus(70, true, { warn: 60, good: 90 }), 'warn');
  assert.equal(pctStatus(59, true, { warn: 60, good: 90 }), 'bad');
});
test('threshold input is validated', () => {
  assert.deepEqual(normalizeThresholds(40, 75), { warn: 40, good: 75 });
  assert.deepEqual(normalizeThresholds('60', '95'), { warn: 60, good: 95 });
  for (const bad of [[80, 50], [50, 50], [-1, 80], ['x', 80], [50, 500], [null, null]]) assert.deepEqual(normalizeThresholds(...bad), DEFAULT_THRESHOLDS, JSON.stringify(bad));
});
test('formatting and bar geometry', () => {
  assert.equal(fmtPct(63), '63%');
  assert.equal(fmtPct(39.94), '39.9%');
  assert.equal(fmtPct(100), '100%');
  assert.equal(fmtPct(0), '0%');
  assert.equal(barWidth(135), 100); assert.equal(barWidth(-4), 0); assert.equal(barWidth(63), 63);
  assert.equal(overflows(100), false); assert.equal(overflows(100.04), false); assert.equal(overflows(112), true);
});
