/**
 * TELEGRAM COMMAND PARSER
 * =======================
 * Parses one Telegram message into a typed command, or null.
 *
 * WHY A PARSER AND NOT `text.startsWith(...)` CHAINING
 *
 * The router previously compared raw strings in sequence. That is what made
 * `/processes` fall through to the conversational path and get an AI answer
 * instead of a list, and it made argument parsing impossible: there was no way
 * to take a `PROCESS_ID` for `/trigger`, `/pause` or `/resume`.
 *
 * Every command is matched on exact first token, so a command can never be
 * shadowed by a longer one. Unrecognised input is returned as
 * `kind: 'unknown'` rather than being guessed at, because the alternative is
 * silently running an AI call on what the user thought was a command.
 *
 * BOT COMMANDS ARE `@botname`-SUFFIXED IN GROUPS
 *
 * `/create@my_signalgoat_bot` is how Telegram delivers a command in a group
 * chat. The suffix is stripped, which is the difference between the command
 * working in a group and silently doing nothing.
 *
 * RATE LIMITING LIVES HERE
 *
 * Per-chat, per-command. A bot token is a credential, and an unauthenticated
 * caller who has learned a bot's webhook URL could otherwise spend a user's
 * credits by triggering evaluations in a loop. The limiter is per-process and
 * in-memory, which bounds one instance's exposure; it is a speed bump against
 * accidental and naive abuse, not a distributed quota.
 */

/** Intent recognition on free text: "every 5 minutes", "analyse gold", "stop". */
export type TelegramIntent =
  | { kind: "schedule"; minutes: number }
  | { kind: "analyse"; market?: string }
  | { kind: "stop" };

export type TelegramCommand =
  | { kind: "start" }
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "analyse"; market?: string }
  | { kind: "create"; args: string }
  | { kind: "intent"; intent: TelegramIntent }
  | { kind: "processes" }
  | { kind: "trigger"; processId: string }
  | { kind: "pause"; processId: string }
  | { kind: "resume"; processId: string }
  | { kind: "delete"; processId: string }
  | { kind: "connect"; args: string }
  | { kind: "unknown"; command: string }
  | { kind: "chat"; text: string };

/**
 * Longest accepted process id.
 *
 * Ids this system generates are `goat_<13 digits>_<4 chars>`, so this admits
 * them with room to spare while refusing an arbitrarily long string before it
 * reaches a database query.
 */
const MAX_PROCESS_ID_LENGTH = 64;

const PROCESS_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A process id, or null when the argument is not a usable one. */
export function normaliseProcessId(raw: string): string | null {
  const trimmed = raw.trim().replace(/^@/, "");
  if (!trimmed) return null;
  if (trimmed.length > MAX_PROCESS_ID_LENGTH) return null;
  return PROCESS_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Splits `/trigger abc123 extra tokens` into command + args.
 *
 * `split(/\s+/)` rather than a naive split on the first space, so a command
 * with extra whitespace or a trailing newline from Telegram behaves.
 */
function tokenize(text: string): { command: string; args: string } {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const raw = parts[0] ?? "";

  /**
   * Normalise to a bare command name.
   *
   * Two things are removed, in this order, and the order matters:
   *   1. the `@botname` suffix Telegram appends in group chats;
   *   2. the leading `/`.
   *
   * The suffix must be stripped before the slash is dropped, otherwise
   * `/processes@my_bot` becomes `processes@my_bot` and matches nothing — which
   * is exactly the "commands silently do nothing in a group" symptom.
   */
  const withoutBot =
    raw.indexOf("@") === -1 ? raw : raw.slice(0, raw.indexOf("@"));
  const command = withoutBot.replace(/^\//, "").toLowerCase();

  return { command, args: parts.slice(1).join(" ") };
}

/** `processes`, and the `list` alias people reach for first. */
const LIST_COMMANDS = new Set(["processes", "list", "ps"]);

/** `analyse` / `analyze`, both spellings people actually type. */
const ANALYSE_COMMANDS = new Set(["analyse", "analyze"]);

/**
 * Detect natural-language intents in free text (messages that are not Telegram
 * commands). The pattern is deliberately short and literal so it never guesses:
 *   - "every 5 minutes" / "every 10m" / "every hour" / "every day" /
 *     "every week" -> schedule the GOAT on that cadence (floored at 5 minutes)
 *   - "analyse gold" / "analyse xyz:GOLD now" / "analyse"
 *     -> run a fresh analysis, optionally on a specific market
 *   - "stop" / "cancel"
 *     -> pause the GOAT
 *
 * Returning null falls through to the normal command parser or the AI gateway.
 */
export function parseTelegramIntent(text: string): TelegramIntent | null {
  const t = text.trim().toLowerCase();

  /** Schedule cadence: "every 5 minutes", "every 10m", "every hour/day/week",
   * plus multipliers like "every 2 hours" or "every 3 days". Floors at 5
   * minutes per the cadence contract. */
  const n = t.match(
    /\bevery\s+(\d+)\s*(m|min|mins|minutes|hour|hours|day|days|week|weeks)?\b/,
  );
  if (n) {
    const num = Math.max(1, Math.round(Number(n[1])));
    const unit = (n[2] ?? "minute").toLowerCase();
    const factor = unit.startsWith("week")
      ? 60 * 24 * 7
      : unit.startsWith("day")
        ? 60 * 24
        : unit.startsWith("hour")
          ? 60
          : 1;
    return { kind: "schedule", minutes: Math.max(5, num * factor) };
  }
  /** Fallback for the singular "every hour/day/week" phrasing. */
  if (/\bevery\s+hour(s)?\b/.test(t)) return { kind: "schedule", minutes: 60 };
  if (/\bevery\s+day(s)?\b/.test(t))
    return { kind: "schedule", minutes: 60 * 24 };
  if (/\bevery\s+week\w*\b/.test(t))
    return { kind: "schedule", minutes: 60 * 24 * 7 };

  /** Analyse: "analyse gold", "analyse xyz:GOLD now". The token is captured
   * as-is and resolved against the venue's catalogue by the router, which is
   * what makes free-text mentions ("gold", "aapl", "xauusd") actually work. */
  const m = t.match(/\b(?:analyse|analyze)\s+(\S+)/);
  if (m) {
    return { kind: "analyse", market: m[1] };
  }
  if (/\b(?:analyse|analyze)\b/.test(t)) return { kind: "analyse" };

  /** Stop / cancel. */
  if (/\bstop\b/.test(t) || /\bcancel\b/.test(t)) {
    return { kind: "stop" };
  }

  return null;
}

/**
 * A plausible market symbol: uppercase/alphanumeric, optionally category-tagged
 * with a colon (e.g. "xyz:GOLD", "BTC/USD"). Rejects whitespace and clearly
 * natural words so "analyse now" stays a normal question.
 */
function looksLikeMarketSymbol(raw: string): boolean {
  const s = raw.trim();
  return (
    s.length >= 3 && !/\s/.test(s) && (s.includes(":") || /^[A-Z0-9]/.test(s))
  );
}

/**
 * Parse the argument of /schedule: "every 5 minutes", "every 2 hours",
 * "daily", "weekly", "hourly". Returns minutes, or null when the argument is
 * not usable. Shares its parsing with the natural-language intent so
 * "/schedule every 2 hours" and "every 2 hours" behave identically.
 */
function parseScheduleArgs(args: string): number | null {
  const t = args.trim();
  const m = t.match(
    /\bevery\s+(\d+)\s*(?:m|min|mins|minutes|hour|hours|day|days|week|weeks)?\b/i,
  );
  if (m) {
    const num = Math.max(1, Math.round(Number(m[1])));
    const unit = (m[2] ?? "minutes").toLowerCase();
    const factor = unit.startsWith("week")
      ? 60 * 24 * 7
      : unit.startsWith("day")
        ? 60 * 24
        : unit.startsWith("hour")
          ? 60
          : 1;
    return Math.max(5, num * factor);
  }
  const a = args.toLowerCase();
  if (a === "daily" || a === "every day") return 60 * 24;
  if (a === "weekly" || a === "every week") return 60 * 24 * 7;
  if (a === "hourly" || a === "every hour") return 60;
  return null;
}

/**
 * Parses a message body into a command.
 *
 * `text` is expected to be trimmed and non-empty; the caller decides what a
 * message with no text means (an empty body is not a command).
 */
export function parseTelegramCommand(text: string): TelegramCommand {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "chat", text: trimmed };

  // A command must be the FIRST token. Anything else is free text for the AI.
  if (!trimmed.startsWith("/")) {
    // Natural-language shortcuts that are not Telegram commands: "every 5 minutes",
    // "analyse gold", "stop". These are handled here so the user never pays an AI
    // call to say what they mean.
    const intent = parseTelegramIntent(trimmed);
    if (intent) {
      return { kind: "intent", intent };
    }
    return { kind: "chat", text: trimmed };
  }

  const { command, args } = tokenize(trimmed);

  // `command` is the bare name; the leading slash is stripped by `tokenize`.
  if (command === "start") return { kind: "start" };
  if (command === "help") return { kind: "help" };
  if (command === "status") return { kind: "status" };
  if (command === "connect") return { kind: "connect", args };
  if (command === "create") return { kind: "create", args };

  if (LIST_COMMANDS.has(command)) return { kind: "processes" };

  if (ANALYSE_COMMANDS.has(command)) {
    // An optional market; the runtime falls back to the GOAT's first market.
    const market = normaliseProcessId(args);
    return market ? { kind: "analyse", market } : { kind: "analyse" };
  }

  if (command === "schedule") {
    const minutes = parseScheduleArgs(args);
    if (minutes === null) {
      return { kind: "unknown", command: "/schedule" };
    }
    return { kind: "intent", intent: { kind: "schedule", minutes } };
  }

  if (command === "stop") {
    return { kind: "intent", intent: { kind: "stop" } };
  }

  /**
   * Commands that REQUIRE a process id.
   *
   * A missing or malformed id returns `unknown` rather than acting on nothing:
   * acting would either target an arbitrary process or silently no-op, and the
   * user would be told neither.
   */
  const PROCESS_COMMANDS = new Set(["trigger", "pause", "resume", "delete"]);

  if (PROCESS_COMMANDS.has(command)) {
    const processId = normaliseProcessId(args);
    if (!processId) {
      return { kind: "unknown", command: `/${command} ${args}`.trim() };
    }

    if (command === "trigger") return { kind: "trigger", processId };
    if (command === "pause") return { kind: "pause", processId };
    if (command === "resume") return { kind: "resume", processId };
    return { kind: "delete", processId };
  }

  return { kind: "unknown", command: trimmed.split(/\s+/)[0] };
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

/**
 * Per-chat sliding-window limiter.
 *
 * Bounded by an explicit cap rather than growing per chat id: an unbounded map
 * keyed on attacker-controlled input is a memory-exhaustion vector, and this
 * process handles a webhook that is public.
 */
export class TelegramRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxPerWindow: number;
  private readonly maxChats: number;

  constructor(
    options: {
      windowMs?: number;
      maxPerWindow?: number;
      maxChats?: number;
      now?: () => number;
    } = {},
  ) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxPerWindow = options.maxPerWindow ?? 10;
    this.maxChats = options.maxChats ?? 5_000;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Records an attempt and reports whether it is allowed.
   *
   * The window is pruned on read, so an idle chat costs nothing after its
   * entries age out.
   */
  allow(chatId: string, cost = 1): boolean {
    const now = this.now();
    const cutoff = now - this.windowMs;

    const recent = (this.hits.get(chatId) ?? []).filter((at) => at > cutoff);

    if (recent.length + cost > this.maxPerWindow) {
      this.hits.set(chatId, recent);
      return false;
    }

    for (let i = 0; i < cost; i += 1) recent.push(now);

    // Bound the map. The oldest chat is evicted first; a legitimate chat being
    // evicted only costs it its history, never correctness.
    if (this.hits.size >= this.maxChats && !this.hits.has(chatId)) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }

    this.hits.set(chatId, recent);
    return true;
  }

  /** Seconds until the chat may try again, for a useful error message. */
  retryAfterSeconds(chatId: string): number {
    const now = this.now();
    const recent = (this.hits.get(chatId) ?? []).filter(
      (at) => at > now - this.windowMs,
    );
    if (recent.length === 0) return 0;
    const oldest = Math.min(...recent);
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  /** For tests. */
  reset(): void {
    this.hits.clear();
  }
}
