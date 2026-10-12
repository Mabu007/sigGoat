/**
 * FIRESTORE VALUE SANITISING
 * ==========================
 * Firestore has no `undefined`. Passing it — nested, or inside an array —
 * fails the ENTIRE document write, and only ever surfaces as a
 * `persistenceErrors` string on the wake event.
 *
 * The file-backed repository stores objects as-is and is perfectly happy, so
 * this reproduces ONLY on Firestore, i.e. only in production, and on exactly
 * the records that matter most: the thesis a GOAT just reasoned about.
 */

import { describe, test, expect } from 'bun:test';
import { firestoreSafe } from '../src/server/repositories';

/** Walks a value the way Firestore does, throwing on anything invalid. */
function assertFirestoreValid(value: unknown, path = 'doc'): void {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`${path}: Firestore rejects NaN/Infinity`);
    }
    return;
  }
  if (value instanceof Date) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertFirestoreValid(item, `${path}[${i}]`));
    return;
  }
  if (type === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        throw new Error(`${path}.${key}: "undefined" is not a valid Firestore value`);
      }
      assertFirestoreValid(item, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path}: unsupported Firestore type ${type}`);
}

describe('firestoreSafe', () => {
  test('the exact production failure: a tracker with no indicatorParams', () => {
    /**
     * Observed live on 2026-10-12:
     *   "Cannot use undefined as a Firestore value (found in field
     *    trackers.`0`.indicatorParams)"
     *
     * A tracker for an indicator that takes no extra parameters serialises
     * `indicatorParams: undefined` — so the thesis the model had just written
     * was silently discarded on every wake that produced one.
     */
    const thesis = {
      id: 'th_1',
      goatId: 'goat_1',
      market: 'xyz:GOLD',
      directionalBias: 'NEUTRAL',
      confidence: 45,
      summary: 'No confirmed breakout.',
      invalidation: 'A close above 4198.',
      observationPlan: 'Watch the range.',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      trackers: [
        {
          description: 'Price breaks above 4198.00',
          indicator: 'SWING_HIGH',
          period: 20,
          operator: 'GREATER_THAN',
          targetValue: 4198,
          indicatorParams: undefined,
        },
        {
          description: 'RSI crosses above 50',
          indicator: 'RSI',
          period: 14,
          operator: 'GREATER_THAN',
          targetValue: 50,
          indicatorParams: { length: 14 },
        },
      ],
    };

    expect(() => assertFirestoreValid(thesis)).toThrow();
    expect(() => assertFirestoreValid(firestoreSafe(thesis))).not.toThrow();
  });

  test('drops undefined but keeps null — they are different meanings', () => {
    const out = firestoreSafe({ a: undefined, b: null, c: 1 }) as Record<string, unknown>;
    expect('a' in out).toBe(false);
    // null is a real stored value, not an absent one.
    expect(out.b).toBeNull();
    expect(out.c).toBe(1);
  });

  test('an array hole becomes null rather than undefined', () => {
    const out = firestoreSafe({ xs: [1, undefined, 3] }) as { xs: unknown[] };
    expect(out.xs).toEqual([1, null, 3]);
    expect(() => assertFirestoreValid(out)).not.toThrow();
  });

  test('NaN and Infinity become null, which Firestore also rejects', () => {
    const out = firestoreSafe({ n: NaN, i: Infinity, f: 1.5 }) as Record<string, unknown>;
    expect(out.n).toBeNull();
    expect(out.i).toBeNull();
    expect(out.f).toBe(1.5);
    expect(() => assertFirestoreValid(out)).not.toThrow();
  });

  test('Date values survive, because Firestore stores them natively', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    const out = firestoreSafe({ createdAt: when }) as { createdAt: Date };
    expect(out.createdAt).toBeInstanceOf(Date);
    expect(out.createdAt.toISOString()).toBe(when.toISOString());
  });

  test('a self-referential document cannot hang the write', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    const out = firestoreSafe(cyclic) as Record<string, unknown>;
    expect(out.name).toBe('x');
    expect(out.self).toBeNull();
  });

  test('toJSON-bearing values are unwrapped, like the SDK does', () => {
    const out = firestoreSafe({
      d: new Date('2026-01-01T00:00:00.000Z'),
      nested: { when: new Date('2026-02-01T00:00:00.000Z') },
    });
    expect(() => assertFirestoreValid(out)).not.toThrow();
  });

  test('a realistic signal round-trips and stays writable', () => {
    const signal = {
      id: 'sig_1',
      userId: 'u1',
      goatId: 'goat_1',
      thesisId: 'th_1',
      market: 'xyz:GOLD',
      direction: 'LONG',
      orderType: 'LIMIT',
      entry: 4194,
      entryZone: { low: 4190, high: 4198 },
      stopLoss: 4150,
      takeProfit: 4300,
      confidence: 70,
      thesis: 't',
      rationale: 'r',
      confirmationRequired: 'c',
      invalidation: 'i',
      supportingEvidence: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      status: 'ACTIONABLE',
      // An undecided proposal has neither of these yet.
      decision: undefined,
      decidedAt: undefined,
      decisionNote: undefined,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const clean = firestoreSafe(signal);
    expect(() => assertFirestoreValid(clean)).not.toThrow();
    expect('decision' in clean).toBe(false);
    // Everything that WAS defined is untouched.
    expect(clean.market).toBe('xyz:GOLD');
    expect(clean.entryZone).toEqual({ low: 4190, high: 4198 });
  });
});