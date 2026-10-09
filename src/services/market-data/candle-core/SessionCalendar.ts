/**
 * INSTRUMENT SESSION CALENDAR
 * ===========================
 * Timezone-aware session boundaries, derived from IANA zone rules.
 *
 * WHY THIS REPLACES THE OLD HARDCODED TABLE
 *
 * `SessionSchedule` treated "London open" as 07:00 UTC and "New York open" as
 * 13:00 UTC, all year. Both are wrong for half the year:
 *
 *   - New York is UTC-5 in winter and UTC-4 in summer, so the NY open is
 *     14:00 UTC in winter and 13:00 UTC in summer.
 *   - London is UTC+0 in winter and UTC+1 in summer, so the London open is
 *     07:00 UTC in winter and 06:00 UTC in summer.
 *
 * A permanent UTC offset silently mislabels half of every year, which is a
 * correctness bug, not a cosmetic one: session finalization keys off these
 * boundaries, so pruning the wrong window destroys live data or retains it
 * forever.
 *
 * HOW DST IS HANDLED
 *
 * There is NO fixed offset anywhere in this file. Every conversion goes through
 * `Intl.DateTimeFormat` with an explicit `timeZone`, so the platform's IANA
 * database supplies the offset for the specific instant being converted. That
 * is the only correct way to do this in JavaScript, and it means DST
 * transitions and half-hour zones (Asia/Kolkata, Australia/Adelaide) come out
 * right without any per-zone tables.
 *
 * THE LOCAL-TIME -> UTC PROBLEM
 *
 * `Intl` formats, it does not parse. To turn "17:00 on 2026-03-08 in
 * America/New_York" into a UTC instant we:
 *   1. build the naive instant as if it were UTC,
 *   2. measure the zone's offset AT that instant,
 *   3. subtract, then re-measure and correct once more.
 *
 * The second pass matters: stepping across a DST boundary changes the offset,
 * so a single correction is not always right. Local times that do not exist
 * (the spring-forward gap) are reported as such rather than silently shifted —
 * inventing a timestamp there would be worse than reporting no session.
 */

import { MINUTE_MS } from './CandleRecord';

/** Day-of-week indices. 0 = Sunday, matching `Date.prototype.getUTCDay`. */
const SUNDAY = 0;
const MONDAY = 1;
const TUESDAY = 2;
const WEDNESDAY = 3;
const THURSDAY = 4;
const FRIDAY = 5;
const SATURDAY = 6;

const WEEKDAYS = [MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Broad instrument classes. Each carries its own session geometry. */
export type InstrumentClass = 'FX' | 'METALS' | 'ENERGY' | 'INDEX' | 'CRYPTO';

export interface SessionSpec {
  /** IANA zone name. The ONLY source of UTC offset truth. */
  timezone: string;
  /** Local minutes-from-midnight the session opens. */
  openMinute: number;
  /** Local minutes-from-midnight the session closes. */
  closeMinute: number;
  /**
   * Days the session OPENS, 0=Sun. A session may still run into the next day.
   *
   * FX/metals/energy open Sunday evening in America/New_York and therefore
   * run through Friday, so the open days are Sun-Thu.
   */
  tradingDays: number[];
  /**
   * When true the session is LABELLED by the local date of its close, which is
   * the FX convention: the Sunday-evening open belongs to Monday's session.
   */
  labelByClose: boolean;
  /**
   * Explicit closed local dates (YYYY-MM-DD), in the session's timezone.
   *
   * Deliberately EMPTY by default. Holidays are not uniform across markets and
   * a guessed holiday is a fabricated market closure, so an operator supplies
   * the real calendar for the exchange rather than the code assuming one.
   */
  closedDates?: string[];
}

export interface ResolvedSession {
  instrument: string;
  class: InstrumentClass;
  /** `${instrument}#${YYYY-MM-DD}` — the idempotent finalization key. */
  id: string;
  /** The local date used for labelling, in the session timezone. */
  sessionDate: string;
  opensAtMs: number;
  closesAtMs: number;
  timezone: string;
  state: 'PRE_OPEN' | 'OPEN' | 'CLOSED';
  /** True when `atMs` falls inside a configured closed date. */
  isHoliday: boolean;
  /** True when the gap to the next open exceeds the normal overnight gap. */
  spansWeekendGap: boolean;
}

/* ------------------------------------------------------------------ */
/* Timezone primitives (Intl-backed, offset-free)                      */
/* ------------------------------------------------------------------ */

export interface LocalParts {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday. */
  weekday: number;
}

const WEEKDAY_BY_SHORT: Record<string, number> = {
  Sun: SUNDAY,
  Mon: MONDAY,
  Tue: TUESDAY,
  Wed: WEDNESDAY,
  Thu: THURSDAY,
  Fri: FRIDAY,
  Sat: SATURDAY,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock breakdown of an instant in a given IANA zone. */
export function localPartsIn(timeZone: string, atMs: number): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(atMs));

  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let weekday = SUNDAY;

  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        // `hourCycle: h23` should never emit 24, but some ICU builds do at
        // midnight. Normalise so downstream arithmetic stays correct.
        hour = Number(part.value) % 24;
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      case 'weekday':
        weekday = WEEKDAY_BY_SHORT[part.value] ?? SUNDAY;
        break;
      default:
        break;
    }
  }

  return { year, month, day, hour, minute, second, weekday };
}

/**
 * The zone's UTC offset in ms AT a given instant.
 *
 * Format the instant in the zone, read the result back as though it were UTC,
 * and take the difference. Positive east of Greenwich.
 */
export function zoneOffsetMs(timeZone: string, atMs: number): number {
  const p = localPartsIn(timeZone, atMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Discard sub-second noise so the offset is a clean minute figure.
  return asUtc - Math.floor(atMs / 1000) * 1000;
}

export type LocalTimeResolution =
  | { exists: true; atMs: number }
  | { exists: false; reason: 'AMBIGUOUS' | 'NONEXISTENT' };

/**
 * Converts a LOCAL wall-clock time in a zone to a UTC instant.
 *
 * `NONEXISTENT` means the local time falls in a spring-forward gap — asking for
 * 02:30 on a US DST date. There is no correct instant, and inventing one is
 * how a session boundary ends up an hour wrong for a day a year.
 *
 * `AMBIGUOUS` means a fall-back overlap. The EARLIER (first) occurrence is
 * chosen, because a session that opens at the start of the repeated hour must
 * not skip the first pass of its own opening minute.
 */
export function localTimeToUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
): LocalTimeResolution {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;

  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // Two-pass offset correction; the second pass is what survives a transition.
  let candidate = naive - zoneOffsetMs(timeZone, naive);
  candidate = naive - zoneOffsetMs(timeZone, candidate);

  // Verify by reading back. A mismatch means the local time does not exist.
  const back = localPartsIn(timeZone, candidate);
  const matches =
    back.year === year &&
    back.month === month &&
    back.day === day &&
    back.hour === hour &&
    back.minute === minute;

  if (!matches) {
    return { exists: false, reason: 'NONEXISTENT' };
  }

  // Ambiguity: the offset one hour earlier differs AND the read-back matches
  // under both interpretations. Detect by checking the other candidate.
  const other = naive - zoneOffsetMs(timeZone, naive - 3_600_000);
  if (other !== candidate) {
    const otherBack = localPartsIn(timeZone, other);
    if (
      otherBack.year === year &&
      otherBack.month === month &&
      otherBack.day === day &&
      otherBack.hour === hour &&
      otherBack.minute === minute
    ) {
      return { exists: true, atMs: Math.min(candidate, other) };
    }
  }

  return { exists: true, atMs: candidate };
}

/** `YYYY-MM-DD` for a local date, without any timezone maths. */
function formatLocalDate(parts: Pick<LocalParts, 'year' | 'month' | 'day'>): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** UTC ms of local midnight on the given local date. */
function localMidnightMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
): number | null {
  const resolved = localTimeToUtcMs(timeZone, year, month, day, 0);
  return resolved.exists ? resolved.atMs : null;
}

/* ------------------------------------------------------------------ */
/* Instrument classification                                           */
/* ------------------------------------------------------------------ */

/**
 * Session geometry per class.
 *
 * These are the shapes, and they are deliberately few:
 *
 * - FX / METALS / ENERGY run Sunday evening to Friday evening in
 *   America/New_York and are labelled by their close date (the FX convention).
 * - INDEX sessions are plain intraday cash sessions in the exchange's own zone,
 *   labelled by their open date.
 * - CRYPTO trades continuously; one session per UTC day.
 *
 * Each spec's times are LOCAL wall-clock in its zone, so DST is applied by the
 * platform rather than baked in here.
 */
const SESSION_SPECS: Record<InstrumentClass, SessionSpec> = {
  FX: {
    timezone: 'America/New_York',
    // Opens at the previous session's close (17:00 ET) and closes at 17:00 ET.
    openMinute: 17 * 60,
    closeMinute: 17 * 60,
    tradingDays: [SUNDAY, MONDAY, TUESDAY, WEDNESDAY, THURSDAY],
    labelByClose: true,
  },
  METALS: {
    timezone: 'America/New_York',
    // Spot metals reopen 18:00 ET Sunday; futures-style commodities close 17:00.
    openMinute: 18 * 60,
    closeMinute: 17 * 60,
    tradingDays: [SUNDAY, MONDAY, TUESDAY, WEDNESDAY, THURSDAY],
    labelByClose: true,
  },
  ENERGY: {
    timezone: 'America/New_York',
    openMinute: 18 * 60,
    closeMinute: 17 * 60,
    tradingDays: [SUNDAY, MONDAY, TUESDAY, WEDNESDAY, THURSDAY],
    labelByClose: true,
  },
  INDEX: {
    timezone: 'America/New_York',
    // Regular cash session 09:30-16:00 ET.
    openMinute: 9 * 60 + 30,
    closeMinute: 16 * 60,
    tradingDays: WEEKDAYS,
    labelByClose: false,
  },
  CRYPTO: {
    timezone: 'UTC',
    openMinute: 0,
    closeMinute: 0,
    tradingDays: ALL_DAYS,
    labelByClose: false,
  },
};

/** Indexes whose cash session is not in America/New_York. */
const INDEX_ZONE_OVERRIDES: Record<string, { timezone: string; openMinute: number; closeMinute: number }> = {
  // Xetra: 09:00-17:30 Europe/Berlin.
  GER40: { timezone: 'Europe/Berlin', openMinute: 9 * 60, closeMinute: 17 * 60 + 30 },
};

const CRYPTO_INSTRUMENTS = new Set(['BTC/USD', 'ETH/USD']);

const INDEX_INSTRUMENTS = new Set(['US500', 'US100', 'SPX500', 'US30', 'GER40', 'NAS100', 'SPX']);

const METALS_INSTRUMENTS = new Set(['XAU/USD', 'XAG/USD', 'XPT/USD', 'XPD/USD']);

const ENERGY_INSTRUMENTS = new Set(['WTI', 'BRENT', 'XTIUSD', 'NG', 'HO']);

/**
 * Classifies an instrument by its canonical symbol.
 *
 * An unrecognised symbol defaults to FX, which is the conservative choice:
 * FX is the only class that labels by close date, and mis-classifying an index
 * as FX is caught immediately because its session would then span a weekend.
 */
export function classifyInstrument(instrument: string): InstrumentClass {
  const key = instrument.trim().toUpperCase();

  if (CRYPTO_INSTRUMENTS.has(key)) return 'CRYPTO';
  if (INDEX_INSTRUMENTS.has(key)) return 'INDEX';
  if (METALS_INSTRUMENTS.has(key)) return 'METALS';
  if (ENERGY_INSTRUMENTS.has(key)) return 'ENERGY';
  return 'FX';
}

/** The session spec for an instrument, honouring per-index zone overrides. */
export function sessionSpecFor(instrument: string): SessionSpec {
  const key = instrument.trim().toUpperCase();
  const cls = classifyInstrument(key);
  const base = SESSION_SPECS[cls];

  if (cls === 'INDEX') {
    const override = INDEX_ZONE_OVERRIDES[key];
    if (override) {
      return {
        ...base,
        timezone: override.timezone,
        openMinute: override.openMinute,
        closeMinute: override.closeMinute,
      };
    }
  }

  return base;
}

/**
 * How many local days either side the resolver scans when locating a session.
 *
 * Seven back covers the longest realistic closure — a Friday close to a
 * Monday open plus the label-by-close carry — and a few forward covers the
 * gap immediately after a close, where the most recent session has already
 * ended but is still the one whose candles are on disk.
 */
const LOOKBACK_DAYS = 9;
const LOOKFORWARD_DAYS = 3;

/**
 * Resolves the session that GOVERNS `atMs`.
 *
 * Candidates are built from every local date in a bounded window, then chosen
 * by this precedence:
 *
 *   1. the session that CONTAINS the instant  -> state OPEN
 *   2. the most recently CLOSED session      -> state CLOSED
 *   3. the earliest upcoming session          -> state PRE_OPEN
 *
 * Steps 2 and 3 are what make this usable for finalization and freshness
 * checks. A naive "does any session contain this instant" test returns null for
 * the whole weekend and for the instant a session closes, and null at exactly
 * the moment finalization needs an answer.
 *
 * Returning the previous session during a closure is deliberate, not a
 * convenience: those are the sessions whose candles are actually stored, so
 * they are the ones whose summaries must be produced.
 */
export function resolveSession(
  instrument: string,
  atMs: number,
): ResolvedSession | null {
  const key = instrument.trim().toUpperCase();
  const spec = sessionSpecFor(key);
  const cls = classifyInstrument(key);

  const local = localPartsIn(spec.timezone, atMs);

  const containing: ResolvedSession[] = [];
  const past: ResolvedSession[] = [];
  const future: ResolvedSession[] = [];

  for (let delta = -LOOKBACK_DAYS; delta <= LOOKFORWARD_DAYS; delta += 1) {
    const probe = new Date(Date.UTC(local.year, local.month - 1, local.day + delta));

    const candidate = buildSessionForDate(key, cls, spec, probe, atMs);
    if (!candidate) continue;

    if (candidate.opensAtMs <= atMs && atMs < candidate.closesAtMs) {
      containing.push(candidate);
    } else if (candidate.closesAtMs <= atMs) {
      past.push(candidate);
    } else {
      future.push(candidate);
    }
  }

  if (containing.length > 0) return containing[0];

  if (past.length > 0) {
    past.sort((a, b) => b.closesAtMs - a.closesAtMs);
    return { ...past[0], state: 'CLOSED' };
  }

  if (future.length > 0) {
    future.sort((a, b) => a.opensAtMs - b.opensAtMs);
    return { ...future[0], state: 'PRE_OPEN' };
  }

  return null;
}

function buildSessionForDate(
  instrument: string,
  cls: InstrumentClass,
  spec: SessionSpec,
  localDate: Date,
  atMs: number,
): ResolvedSession | null {
  const year = localDate.getUTCFullYear();
  const month = localDate.getUTCMonth() + 1;
  const day = localDate.getUTCDate();
  const weekday = localDate.getUTCDay();

  if (!spec.tradingDays.includes(weekday)) return null;

  const localDateStr = formatLocalDate({ year, month, day });

  const openResolved = localTimeToUtcMs(
    spec.timezone,
    year,
    month,
    day,
    spec.openMinute,
  );
  if (!openResolved.exists) return null;

  const opensAtMs = openResolved.atMs;

  // An overnight session (openMinute > closeMinute) closes on the next day.
  const overnight = spec.closeMinute <= spec.openMinute;
  const closeDate = overnight
    ? new Date(Date.UTC(year, month - 1, day + 1))
    : localDate;

  const closeResolved = localTimeToUtcMs(
    spec.timezone,
    closeDate.getUTCFullYear(),
    closeDate.getUTCMonth() + 1,
    closeDate.getUTCDate(),
    spec.closeMinute,
  );
  if (!closeResolved.exists) return null;

  const closesAtMs = closeResolved.atMs;

  if (closesAtMs <= opensAtMs) return null;

  const closeLocal = localPartsIn(spec.timezone, closesAtMs);
  const labelSource = spec.labelByClose
    ? { year: closeLocal.year, month: closeLocal.month, day: closeLocal.day }
    : { year, month, day };
  const sessionDate = formatLocalDate(labelSource);

  const isHoliday = Boolean(spec.closedDates?.includes(localDateStr));

  const spanMs = closesAtMs - opensAtMs;
  const expectedSpanMs = overnight ? 24 * 60 * MINUTE_MS : spanMs;

  return {
    instrument,
    class: cls,
    id: `${instrument}#${sessionDate}`,
    sessionDate,
    opensAtMs,
    closesAtMs,
    timezone: spec.timezone,
    state: sessionState(atMs, opensAtMs, closesAtMs),
    isHoliday,
    spansWeekendGap: spanMs > expectedSpanMs + 60 * MINUTE_MS,
  };
}

function sessionState(
  atMs: number,
  opensAtMs: number,
  closesAtMs: number,
): ResolvedSession['state'] {
  if (atMs >= opensAtMs && atMs < closesAtMs) return 'OPEN';
  return atMs < opensAtMs ? 'PRE_OPEN' : 'CLOSED';
}

/**
 * True when the market is inside its own session.
 *
 * Used by ingestion to label data freshness and by the tracker evaluator to
 * refuse a signal built on a price nobody was trading. A closed market is not
 * an error — it means "this bar is the last one", not "the feed is broken".
 */
export function isMarketOpen(instrument: string, atMs: number): boolean {
  const session = resolveSession(instrument, atMs);
  return session?.state === 'OPEN' && !session.isHoliday;
}

/**
 * The most recent session that has CLOSED at or before `atMs`.
 *
 * This is the finalization driver: the newest eligible session is always the
 * last CLOSED one, never the one currently forming. Finalizing a live session
 * would summarize a partial bar as if it were complete.
 */
export function lastClosedSession(
  instrument: string,
  atMs: number,
): ResolvedSession | null {
  let cursor = resolveSession(instrument, atMs);
  if (!cursor) return null;

  // At most a couple of steps: a closure can span more than one session only
  // across a long holiday, and the bound keeps this from ever spinning.
  for (let i = 0; i < 4 && cursor.closesAtMs > atMs; i += 1) {
    const previous = resolveSession(instrument, cursor.opensAtMs - 1);
    if (!previous || previous.id === cursor.id) break;
    cursor = previous;
  }

  return cursor.closesAtMs <= atMs ? cursor : null;
}

/**
 * Convenience used by observability: the session geometry without resolving a
 * specific instant. Lets the status endpoint report "EUR/USD runs 17:00-17:00
 * America/New_York" truthfully, including which offset applies right now.
 */
export function describeSessionSpec(instrument: string, atMs: number): Record<string, unknown> {
  const spec = sessionSpecFor(instrument);
  const offsetMinutes = zoneOffsetMs(spec.timezone, atMs) / MINUTE_MS;

  return {
    instrument: instrument.trim().toUpperCase(),
    class: classifyInstrument(instrument),
    timezone: spec.timezone,
    utcOffsetMinutes: offsetMinutes,
    openLocalMinuteOfDay: spec.openMinute,
    closeLocalMinuteOfDay: spec.closeMinute,
    labelByClose: spec.labelByClose,
    tradingDays: spec.tradingDays,
    overnight: spec.closeMinute <= spec.openMinute,
    closedDates: spec.closedDates ?? [],
  };
}