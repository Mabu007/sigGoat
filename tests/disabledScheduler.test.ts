import { describe, expect, test } from 'bun:test';
import { DisabledScheduler } from '../src/server/scheduler/DisabledScheduler';

describe('DisabledScheduler', () => {
  test('does not pretend to persist schedules', async () => {
    const scheduler = new DisabledScheduler('Firebase Admin unavailable');
    await expect(scheduler.sync({
      goatId: 'g1',
      nextWakeAt: new Date().toISOString(),
      nextTrackerCheckAt: null,
      timeframe: '15m',
      generationId: 'g1-v1',
    })).rejects.toThrow('Firebase Admin unavailable');
    expect(scheduler.health().kind).toBe('disabled');
    expect(scheduler.health().lastError).toBe('Firebase Admin unavailable');
  });

  test('never accepts a wake without durable scheduling', () => {
    const scheduler = new DisabledScheduler('Firebase Admin unavailable');
    expect(scheduler.decide('g1', {
      goatId: 'g1',
      eventId: 'g1:event1',
      generationId: 'g1-v1',
      reason: 'test',
      firedAt: Date.now(),
    })).toEqual({ allowed: false, reason: 'Firebase Admin unavailable' });
  });
});
