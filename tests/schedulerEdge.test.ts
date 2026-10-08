import { describe, test, expect } from 'bun:test';
import {
  msUntilNextScheduledTime,
  normaliseSchedule,
  describeSchedule,
} from '../src/services/durable-object/GoatDurableObject';
import {
  normaliseTrackingTimeframe,
  pollIntervalForTimeframe,
  candleCountForTimeframe,
  TRACKING_TIMEFRAMES,
} from '../src/services/market-data/trackingTimeframes';

describe('schedule edge cases', () => {
  test('invalid times are dropped, never crash the scheduler', () => {
    expect(normaliseSchedule({ mode: 'TIMES', times: ['99:99', 'nope', '', '08:30'] }).times).toEqual(['08:30']);
  });

  test('TIMES with no valid entries degrades to MANUAL (never a hot loop)', () => {
    expect(normaliseSchedule({ mode: 'TIMES', times: ['bad'] }).mode).toBe('MANUAL');
  });

  test('a sub-minimum interval is floored', () => {
    expect(normaliseSchedule({ mode: 'INTERVAL', intervalMinutes: 1 }).intervalMinutes).toBe(5);
  });

  test('garbage schedule input does not produce NaN delays', () => {
    const s = normaliseSchedule({ mode: 'INTERVAL', intervalMinutes: -50 } as never);
    expect(Number.isFinite(s.intervalMinutes)).toBe(true);
    expect(s.intervalMinutes).toBe(60);
  });

  test('missing schedule defaults to hourly', () => {
    expect(normaliseSchedule(undefined)).toEqual({ mode: 'INTERVAL', intervalMinutes: 60 });
  });

  test('describeSchedule never leaks an object', () => {
    for (const mode of ['MANUAL', 'TRACKERS', 'INTERVAL', 'TIMES'] as const) {
      expect(typeof describeSchedule({ mode, intervalMinutes: 5 } as never)).toBe('string');
    }
  });
});

describe('next scheduled time', () => {
  const at = (iso: string) => new Date(iso).getTime();

  test('picks the next occurrence today', () => {
    const now = at('2026-10-08T08:00:00Z');
    const delta = msUntilNextScheduledTime(['09:00', '14:00'], now);
    expect(delta).toBe(60 * 60_000);
  });

  test('wraps to tomorrow when every time has passed', () => {
    const now = at('2026-10-08T23:00:00Z');
    const delta = msUntilNextScheduledTime(['08:30'], now);
    // Next occurrence is tomorrow 08:30.
    expect(delta).toBeGreaterThan(9 * 60 * 60_000);
    expect(delta).toBeLessThan(11 * 60 * 60_000);
  });

  test('an empty or invalid list falls back to the tick interval', () => {
    expect(msUntilNextScheduledTime([], Date.now())).toBe(30_000);
    expect(msUntilNextScheduledTime(['bad'], Date.now())).toBe(30_000);
  });

  test('a time in the past is never returned as due', () => {
    const now = at('2026-10-08T14:00:30Z');
    const delta = msUntilNextScheduledTime(['14:00'], now);
    expect(delta).toBeGreaterThan(0);
  });

  test('midnight boundary does not produce a zero or negative delay', () => {
    const now = at('2026-10-08T23:59:59Z');
    const delta = msUntilNextScheduledTime(['00:00'], now);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(24 * 60 * 60_000);
  });
});

describe('tracking timeframes', () => {
  test('an unknown timeframe degrades to the default rather than throwing', () => {
    expect(normaliseTrackingTimeframe('nonsense')).toBe('15m');
    expect(normaliseTrackingTimeframe(undefined)).toBe('15m');
    expect(normaliseTrackingTimeframe(42)).toBe('15m');
  });

  test('exactly the five offered cadences are accepted', () => {
    expect([...TRACKING_TIMEFRAMES]).toEqual(['1m', '5m', '15m', '1h', '4h']);
    for (const tf of TRACKING_TIMEFRAMES) {
      expect(normaliseTrackingTimeframe(tf)).toBe(tf);
    }
  });

  test('poll cadence scales with the bar and stays within bounds', () => {
    // Faster bars poll more often than slower bars.
    expect(pollIntervalForTimeframe('1m')).toBeLessThan(pollIntervalForTimeframe('4h'));
    for (const tf of TRACKING_TIMEFRAMES) {
      const ms = pollIntervalForTimeframe(tf);
      expect(ms).toBeGreaterThanOrEqual(5_000);
      expect(ms).toBeLessThanOrEqual(60_000);
    }
  });

  test('candle window covers enough bars for the indicator set', () => {
    for (const tf of TRACKING_TIMEFRAMES) {
      // EMA(50) needs 50 bars minimum.
      expect(candleCountForTimeframe(tf)).toBeGreaterThanOrEqual(50);
    }
  });
});
