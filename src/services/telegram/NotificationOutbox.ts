/**
 * NOTIFICATION OUTBOX
 * ===================
 * Durable, deduplicated, retryable delivery of Telegram notifications.
 *
 * THE FAILURE THIS FIXES
 *
 * Notifications were sent inline, fire-and-forget, from the signal fan-out. That
 * produced four concrete bugs:
 *
 *   1. A Telegram outage lost the notification permanently. There was no record
 *      that a message was owed, so there was nothing to retry.
 *   2. A retried wake produced a SECOND Telegram message for the SAME logical
 *      decision. Nothing keyed the message on the decision.
 *   3. A send that failed mid-flight still ran the rest of the handler, so a
 *      failure could be logged as success.
 *   4. Delivery state was not observable. "Did the user get the alert?" had no
 *      answer.
 *
 * WHAT THIS PROVIDES
 *
 *   - A stable IDEMPOTENCY KEY derived from the logical decision (GOAT, kind,
 *     and the thing that happened), NOT from the attempt. Two attempts to
 *     deliver the same decision produce the same key, so the second is
 *     suppressed rather than sent twice.
 *   - A durable record written BEFORE the send, so an outage leaves a pending
 *     row rather than a lost message.
 *   - Bounded retries with exponential backoff, then a DEAD_LETTER state that
 *     keeps the payload for inspection without retrying forever.
 *   - An explicit NEVER-SENT ambiguity window for the one case that cannot be
 *     made exactly-once (see below).
 *
 * THE HONEST LIMIT — WHY THIS IS NOT "EXACTLY ONCE"
 *
 * Telegram's API gives no idempotency key and no delivery receipt that can be
 * correlated. If the HTTP request succeeds on Telegram's side but the response
 * is lost, we cannot know whether the message arrived. Marking that state
 * `SENT` risks a lost message; retrying risks a duplicate.
 *
 * This class resolves it by recording `SENT_UNCONFIRMED` — a state distinct
 * from `SENT` and from `FAILED` — and NOT retrying it automatically. The user
 * may get one duplicate in a narrow window; they never silently miss an alert,
 * and the ambiguity is recorded rather than hidden. That is the correct trade
 * for a trading alert, where a missed signal is far more costly than a repeated
 * one.
 *
 * SECRETS
 *
 * The bot token is passed in at delivery time and is never persisted here. The
 * outbox stores the RENDERED TEXT, which is not a credential, and never the
 * token, the chat secret, or any API key.
 */

export type NotificationKind = 'SIGNAL' | 'TRACKER_TRIGGERED' | 'GOAT_ALERT';

export type NotificationStatus =
  | 'PENDING'
  | 'SENDING'
  | 'SENT'
  /** Telegram accepted it but the acknowledgement was lost. Do not retry. */
  | 'SENT_UNCONFIRMED'
  | 'FAILED'
  | 'DEAD_LETTER'
  | 'SUPPRESSED';

export interface OutboxRecord {
  /**
   * The idempotency key. Deterministic from the logical decision, so the same
   * decision always maps to the same key.
   */
  id: string;
  kind: NotificationKind;
  /**
   * The id of the thing being announced (a signal id, a tracker id).
   *
   * Kept so "which decision is owed / was delivered?" is answerable without
   * parsing the key. It is an application-level id, never a credential.
   */
  subjectId: string;
  /** The GOAT the notification belongs to. Never leaves the app layer. */
  goatId: string;
  userId: string;
  /** Rendered message body. Never a credential. */
  body: string;
  status: NotificationStatus;
  attempts: number;
  /** When the next delivery is permitted. */
  nextAttemptAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  lastError: string | null;
  /** Telegram message id when delivery was confirmed. */
  deliveredMessageId: string | null;
}

export interface OutboxStore {
  /** Idempotent insert on `id`. Returns false when the record already existed. */
  enqueue(record: OutboxRecord): Promise<boolean>;
  get(id: string): Promise<OutboxRecord | null>;
  save(record: OutboxRecord): Promise<void>;
  /** Due records, oldest first, bounded. */
  due(nowMs: number, limit: number): Promise<OutboxRecord[]>;
  /** Records in a given state, bounded. Used by the reclaim sweep. */
  byStatus(status: NotificationStatus, limit: number): Promise<OutboxRecord[]>;
  countByStatus(status: NotificationStatus): Promise<number>;
}

export interface Deliverer {
  /** Sends the rendered body. Returns the Telegram message id on success. */
  deliver(record: OutboxRecord): Promise<{ messageId: string | null }>;
}

export interface OutboxOptions {
  store: OutboxStore;
  deliverer: Deliverer;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

const DEFAULTS = {
  maxAttempts: 5,
  baseBackoffMs: 30_000,
  maxBackoffMs: 30 * 60_000,
};

/**
 * Builds the idempotency key.
 *
 * The key includes the SUBJECT the notification is about, not a timestamp:
 *
 *   signal  -> `${goatId}:signal:${signalId}`  (a signal has its own stable id)
 *   tracker -> `${goatId}:tracker:${trackerId}:${candleOpenTimeMs}`
 *
 * The tracker case is the important one. Including the CANDLE OPEN TIME means
 * "this tracker fired on this bar" is delivered once, while the same tracker
 * legitimately firing on a LATER bar is a new notification and is delivered.
 */
export function notificationKey(params: {
  goatId: string;
  kind: NotificationKind;
  subjectId: string;
  candleOpenTimeMs?: number | null;
}): string {
  const candle =
    params.candleOpenTimeMs === undefined || params.candleOpenTimeMs === null
      ? ''
      : `:${params.candleOpenTimeMs}`;
  return `${params.goatId}:${params.kind}:${params.subjectId}${candle}`;
}

/** In-memory store. Correct for a single process; a Firestore port exists. */
export class MemoryOutboxStore implements OutboxStore {
  private readonly records = new Map<string, OutboxRecord>();

  async enqueue(record: OutboxRecord): Promise<boolean> {
    if (this.records.has(record.id)) return false;
    this.records.set(record.id, { ...record });
    return true;
  }

  async get(id: string): Promise<OutboxRecord | null> {
    const found = this.records.get(id);
    return found ? { ...found } : null;
  }

  async save(record: OutboxRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async due(nowMs: number, limit: number): Promise<OutboxRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.nextAttemptAtMs <= nowMs &&
          (record.status === 'PENDING' || record.status === 'FAILED'),
      )
      .sort((a, b) => a.nextAttemptAtMs - b.nextAttemptAtMs)
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }

  async byStatus(
    status: NotificationStatus,
    limit: number,
  ): Promise<OutboxRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.status === status)
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }

  async countByStatus(status: NotificationStatus): Promise<number> {
    let total = 0;
    for (const record of this.records.values()) {
      if (record.status === status) total += 1;
    }
    return total;
  }

  /** All records, for assertions. */
  all(): OutboxRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }
}

export interface EnqueueInput {
  goatId: string;
  userId: string;
  kind: NotificationKind;
  subjectId: string;
  body: string;
  candleOpenTimeMs?: number | null;
}

export class NotificationOutbox {
  /**
   * Public so tests and the health endpoint can read delivery state directly
   * rather than inferring it from counters.
   */
  readonly store: OutboxStore;
  private readonly deliverer: Deliverer;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;

  readonly stats = {
    enqueued: 0,
    suppressedDuplicates: 0,
    delivered: 0,
    deliveredUnconfirmed: 0,
    failed: 0,
    deadLettered: 0,
  };

  constructor(options: OutboxOptions) {
    this.store = options.store;
    this.deliverer = options.deliverer;
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.now = options.now ?? (() => Date.now());
    this.log =
      options.log ??
      ((message, error) => {
        if (error) console.warn(message, error);
      });
  }

  /**
   * Records the intent to notify, BEFORE any send is attempted.
   *
   * Returns false when an identical notification was already recorded — that is
   * duplicate suppression, and it is what stops a retried wake from sending a
   * second message for the same decision.
   */
  async enqueue(input: EnqueueInput): Promise<{ id: string; created: boolean }> {
    const id = notificationKey({
      goatId: input.goatId,
      kind: input.kind,
      subjectId: input.subjectId,
      candleOpenTimeMs: input.candleOpenTimeMs,
    });

    const at = this.now();
    const record: OutboxRecord = {
      id,
      kind: input.kind,
      subjectId: input.subjectId,
      goatId: input.goatId,
      userId: input.userId,
      body: input.body,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAtMs: at,
      createdAtMs: at,
      updatedAtMs: at,
      lastError: null,
      deliveredMessageId: null,
    };

    const created = await this.store.enqueue(record);

    if (!created) {
      this.stats.suppressedDuplicates += 1;
      return { id, created: false };
    }

    this.stats.enqueued += 1;
    return { id, created: true };
  }

  /**
   * Attempts delivery of one record.
   *
   * The record is marked SENDING BEFORE the call and left in a terminal state
   * afterwards, so a crash mid-send leaves a SENDING record that a
   * reconciliation sweep can reclaim — never a silent loss.
   */
  async deliverOne(id: string): Promise<OutboxRecord | null> {
    const record = await this.store.get(id);
    if (!record) return null;

    if (record.status === 'SENT' || record.status === 'DEAD_LETTER') {
      return record;
    }

    if (record.nextAttemptAtMs > this.now()) {
      return record;
    }

    await this.store.save({
      ...record,
      status: 'SENDING',
      attempts: record.attempts + 1,
      updatedAtMs: this.now(),
    });

    try {
      const result = await this.deliverer.deliver(record);
      const delivered = await this.store.get(id);
      const settled: OutboxRecord = {
        ...(delivered ?? record),
        status: result.messageId ? 'SENT' : 'SENT_UNCONFIRMED',
        deliveredMessageId: result.messageId,
        lastError: null,
        updatedAtMs: this.now(),
      };
      await this.store.save(settled);
      this.stats.delivered += 1;
      if (!result.messageId) this.stats.deliveredUnconfirmed += 1;
      return settled;
    } catch (err) {
      return this.handleFailure(id, record, err);
    }
  }

  /**
   * Delivers everything due, bounded.
   *
   * A failure for one record must not prevent the rest from being attempted, so
   * each is settled independently.
   */
  async drain(limit = 25): Promise<{ delivered: number; failed: number }> {
    const due = await this.store.due(this.now(), limit);
    let delivered = 0;
    let failed = 0;

    for (const record of due) {
      try {
        const result = await this.deliverOne(record.id);

        if (result?.status === 'SENT' || result?.status === 'SENT_UNCONFIRMED') {
          delivered += 1;
        } else if (
          result?.status === 'FAILED' ||
          result?.status === 'DEAD_LETTER' ||
          result?.status === 'SENDING'
        ) {
          /**
           * Anything not settled counts as failed for this pass, including a
           * plain FAILED record that will be retried. Reporting only
           * DEAD_LETTER would make a run where everything failed look clean.
           */
          failed += 1;
        }
      } catch (err) {
        this.log('[outbox] drain item threw', err);
        failed += 1;
      }
    }

    return { delivered, failed };
  }

  /**
   * Reclaims records abandoned mid-send.
   *
   * A process can die between marking SENDING and settling. Those records
   * would otherwise wait forever, so this is the one place that treats
   * SENDING as recoverable — with a generous timeout, because a slow send is
   * not an abandoned one.
   */
  async reclaimStale(olderThanMs = 10 * 60_000): Promise<number> {
    const cutoff = this.now() - olderThanMs;
    const stale = await this.store.byStatus('SENDING', 100);

    let reclaimed = 0;

    for (const record of stale) {
      if (record.updatedAtMs > cutoff) continue;

      const attempts = record.attempts;
      const exhausted = attempts >= this.maxAttempts;

      await this.store.save({
        ...record,
        status: exhausted ? 'DEAD_LETTER' : 'FAILED',
        lastError: 'Abandoned mid-send; reclaimed by the stale sweep.',
        nextAttemptAtMs: this.now() + this.backoffFor(attempts),
        updatedAtMs: this.now(),
      });
      reclaimed += 1;
    }

    return reclaimed;
  }

  /** Compact status. Contains no message bodies and no tokens. */
  async health(): Promise<Record<string, unknown>> {
    const [pending, sent, unconfirmed, dead, failed] = await Promise.all([
      this.store.countByStatus('PENDING'),
      this.store.countByStatus('SENT'),
      this.store.countByStatus('SENT_UNCONFIRMED'),
      this.store.countByStatus('DEAD_LETTER'),
      this.store.countByStatus('FAILED'),
    ]);

    return {
      stats: { ...this.stats },
      pending,
      sent,
      sentUnconfirmed: unconfirmed,
      deadLetter: dead,
      failed,
    };
  }

  private async handleFailure(
    id: string,
    record: OutboxRecord,
    err: unknown,
  ): Promise<OutboxRecord> {
    const attempts = record.attempts + 1;
    const exhausted = attempts >= this.maxAttempts;

    const settled: OutboxRecord = {
      ...record,
      status: exhausted ? 'DEAD_LETTER' : 'FAILED',
      attempts,
      lastError: describe(err).slice(0, 300),
      nextAttemptAtMs: this.now() + this.backoffFor(attempts),
      updatedAtMs: this.now(),
    };

    await this.store.save(settled);
    this.stats.failed += 1;
    if (exhausted) this.stats.deadLettered += 1;

    return settled;
  }

  /** Exponential backoff, capped. */
  private backoffFor(attempts: number): number {
    return Math.min(
      this.baseBackoffMs * 2 ** Math.max(0, attempts - 1),
      this.maxBackoffMs,
    );
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}