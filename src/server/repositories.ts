/**
 * PERSISTENCE LAYER
 * ==================
 * Repository interfaces + three implementations selected by environment:
 *
 *   - Firestore repositories (firebase-admin) when FIREBASE_SERVICE_ACCOUNT_JSON
 *     or GOOGLE_APPLICATION_CREDENTIALS is configured — production.
 *   - File-backed JSON repositories at DATA_DIR (default ./data) otherwise —
 *     self-hosted/local; survives restarts without external services.
 *   - In-memory repositories for tests.
 *
 * Business logic depends only on the interfaces. Ownership (userId) is part
 * of every stored document and every query — the server enforces ownership
 * itself and never relies on Firestore security rules (admin SDK bypasses
 * them).
 */

import fs from 'fs';
import path from 'path';
import { FundGoat, TradingSkill, TradeSignal, MarketThesis, WakeEvent, UserProfile, Chat, ChatMessage } from '../types';
import type { DailyMarketRecap } from '../services/daily-rolling/DailyMarketRecap';
import { getFirebaseAdmin, getFirebaseAdminFailureReason } from './firebaseAdmin';
import { isProductionRuntime } from './auth';
import type { Firestore } from 'firebase-admin/firestore';

/* ------------------------------------------------------------------ */
/* Interfaces                                                          */
/* ------------------------------------------------------------------ */

export interface GoatRepository {
  listByUser(userId: string): Promise<FundGoat[]>;
  listAll(): Promise<FundGoat[]>;
  get(goatId: string): Promise<FundGoat | null>;
  getForUser(goatId: string, userId: string): Promise<FundGoat | null>;
  save(goat: FundGoat): Promise<void>;
  delete(goatId: string): Promise<void>;
}

export interface SkillRepository {
  listByUser(userId: string): Promise<TradingSkill[]>;
  get(skillId: string): Promise<TradingSkill | null>;
  save(skill: TradingSkill): Promise<void>;
  delete(skillId: string): Promise<void>;
}

export interface SignalRepository {
  listByGoat(goatId: string, limit?: number): Promise<TradeSignal[]>;
  save(signal: TradeSignal): Promise<void>;
  /**
   * Replaces an EXISTING signal in place (same id), e.g. when a user records
   * an accept/reject decision. Returns false when the id does not exist —
   * decision persistence must fail loudly rather than silently append a
   * duplicate record.
   */
  update(signal: TradeSignal): Promise<boolean>;
}

export interface ThesisRepository {
  listByGoat(goatId: string, limit?: number): Promise<MarketThesis[]>;
  save(thesis: MarketThesis): Promise<void>;
}

export interface WakeEventRepository {
  listByGoat(goatId: string, limit?: number): Promise<WakeEvent[]>;
  save(event: WakeEvent): Promise<void>;
}

export interface UserProfileRepository {
  get(userId: string): Promise<UserProfile | null>;
  save(profile: UserProfile): Promise<void>;
  findByTelegramChatId(chatId: string): Promise<UserProfile | null>;
}

/**
 * Persisted daily market recaps.
 *
 * Keyed by "<MARKET>:<YYYY-MM-DD>" which is also the rollover idempotency
 * key, so `save` overwrites the same day rather than appending a duplicate.
 */
export interface MarketRecapRepository {
  /** Most recent recaps for a market, newest first. */
  listByMarket(market: string, limit?: number): Promise<DailyMarketRecap[]>;
  getById(id: string): Promise<DailyMarketRecap | null>;
  /** Idempotent: the id embeds the trading date. */
  save(recap: DailyMarketRecap): Promise<void>;
}

export interface KeyStore {
  getOpenRouterKey(userId: string): Promise<string | undefined>;
  setOpenRouterKey(userId: string, key: string | undefined): Promise<void>;
  getTelegramToken(userId: string): Promise<string | undefined>;
  setTelegramToken(userId: string, token: string | undefined): Promise<void>;

  /**
   * The user's Groq key, for the fallback/testing provider.
   *
   * Stored per user exactly like the OpenRouter key, so a user who pays for
   * Groq keeps their own credential and one user's key never serves another
   * user. Optional on the interface so an older repository implementation
   * still satisfies it.
   */
  getGroqKey?(userId: string): Promise<string | undefined>;
  setGroqKey?(userId: string, key: string | undefined): Promise<void>;

  /**
   * Which provider this user selected.
   *
   * Persisted rather than inferred so the choice survives a cold start and
   * cannot be swapped by a request field.
   */
  getProvider?(userId: string): Promise<'openrouter' | 'groq' | undefined>;
  setProvider?(userId: string, provider: 'openrouter' | 'groq'): Promise<void>;

  /**
   * The user's Telegram bot identity, recorded once `getMe` has verified it.
   *
   * Only ever the bot's public identity (id, username). The token itself lives
   * in `getTelegramToken` and is never written here.
   */
  getTelegramBot?(userId: string): Promise<TelegramBotRecord | undefined>;
  setTelegramBot?(userId: string, bot: TelegramBotRecord | undefined): Promise<void>;
}

export interface TelegramBotRecord {
  /** Telegram's numeric bot id, from getMe. */
  id: number;
  username: string;
  /** When this record was last verified against getMe. */
  verifiedAt: string;
  /** The webhook URL Telegram currently has registered, if known. */
  webhookUrl?: string;
}

/**
 * At-rest storage for encrypted credentials.
 *
 * SEPARATE FROM `KeyStore` ON PURPOSE. `KeyStore` predates the vault and is
 * still read by the reasoning gateway and the Telegram connect flow, which
 * accept a value that may or may not be encrypted. `CredentialRecordStore`
 * has no `get`-that-returns-a-plaintext shape at all — it deals only in
 * envelopes — so it cannot be used as an accidental plaintext channel.
 */
export interface CredentialRecordRepository {
  saveEncrypted(userId: string, provider: string, envelope: string, updatedAt: string): Promise<void>;
  readEncrypted(userId: string, provider: string): Promise<{ envelope: string; updatedAt: string } | null>;
  delete(userId: string, provider: string): Promise<void>;
  listEncrypted(userId: string): Promise<Array<{ provider: string; envelope: string; updatedAt: string }>>;
}

export interface ChatRepository {
  listByUser(userId: string): Promise<Chat[]>;
  get(chatId: string): Promise<Chat | null>;
  getForUser(chatId: string, userId: string): Promise<Chat | null>;
  create(chat: Chat): Promise<Chat>;
  update(chatId: string, updates: Partial<Chat>): Promise<void>;
  delete(chatId: string): Promise<void>;
}

export interface MessageRepository {
  listByChat(chatId: string, limit?: number): Promise<ChatMessage[]>;
  create(chatId: string, message: ChatMessage): Promise<ChatMessage>;
  deleteByChat(chatId: string): Promise<void>;
  delete(messageId: string): Promise<void>;
}

export interface PersistenceLayer {
  mode: 'firestore' | 'file' | 'memory';
  goats: GoatRepository;
  skills: SkillRepository;
  signals: SignalRepository;
  theses: ThesisRepository;
  wakeEvents: WakeEventRepository;
  profiles: UserProfileRepository;
  keys: KeyStore;
  recaps: MarketRecapRepository;
  /** AES-256-GCM envelopes. Never plaintext. */
  credentials: CredentialRecordRepository;
  chats: ChatRepository;
  messages: MessageRepository;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

export class NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/* ------------------------------------------------------------------ */
/* In-memory implementation (tests / fallback cache)                   */
/* ------------------------------------------------------------------ */

export class InMemoryPersistence implements PersistenceLayer {
  mode: 'memory' = 'memory';
  recaps = new MemoryMarketRecapRepository();
  goats = new MemoryGoatRepository();
  skills = new MemorySkillRepository();
  signals = new MemorySignalRepository();
  theses = new MemoryThesisRepository();
  wakeEvents = new MemoryWakeEventRepository();
  profiles = new MemoryProfileRepository();
  keys = new MemoryKeyStore();
  credentials = new MemoryCredentialRecordRepository();
  chats = new MemoryChatRepository();
  messages = new MemoryMessageRepository();
}

class MemoryGoatRepository implements GoatRepository {
  private store = new Map<string, FundGoat>();
  async listByUser(userId: string) {
    return [...this.store.values()].filter((g) => g.userId === userId);
  }
  async listAll() {
    return [...this.store.values()];
  }
  async get(goatId: string) {
    return this.store.get(goatId) ?? null;
  }
  async getForUser(goatId: string, userId: string) {
    const goat = this.store.get(goatId);
    return goat && goat.userId === userId ? goat : null;
  }
  async save(goat: FundGoat) {
    this.store.set(goat.id, { ...goat });
  }
  async delete(goatId: string) {
    this.store.delete(goatId);
  }
}

class MemorySkillRepository implements SkillRepository {
  private store = new Map<string, TradingSkill>();
  async listByUser(userId: string) {
    return [...this.store.values()].filter((s) => s.userId === userId || s.isDefault);
  }
  async get(skillId: string) {
    return this.store.get(skillId) ?? null;
  }
  async save(skill: TradingSkill) {
    this.store.set(skill.id, { ...skill });
  }
  async delete(skillId: string) {
    this.store.delete(skillId);
  }
}

class MemorySignalRepository implements SignalRepository {
  private store = new Map<string, TradeSignal[]>();
  async listByGoat(goatId: string, limit = 50) {
    return (this.store.get(goatId) ?? []).slice(0, limit);
  }
  async save(signal: TradeSignal) {
    const list = this.store.get(signal.goatId) ?? [];
    list.unshift(signal);
    this.store.set(signal.goatId, list.slice(0, 500));
  }
  async update(signal: TradeSignal) {
    const list = this.store.get(signal.goatId) ?? [];
    const index = list.findIndex((s) => s.id === signal.id);
    if (index < 0) return false;
    list[index] = signal;
    return true;
  }
}

class MemoryThesisRepository implements ThesisRepository {
  private store = new Map<string, MarketThesis[]>();
  async listByGoat(goatId: string, limit = 50) {
    return (this.store.get(goatId) ?? []).slice(0, limit);
  }
  async save(thesis: MarketThesis) {
    const list = this.store.get(thesis.goatId) ?? [];
    list.unshift(thesis);
    this.store.set(thesis.goatId, list.slice(0, 200));
  }
}

class MemoryWakeEventRepository implements WakeEventRepository {
  private store = new Map<string, WakeEvent[]>();
  async listByGoat(goatId: string, limit = 50) {
    return (this.store.get(goatId) ?? []).slice(0, limit);
  }
  async save(event: WakeEvent) {
    const list = this.store.get(event.goatId) ?? [];
    list.unshift(event);
    this.store.set(event.goatId, list.slice(0, 500));
  }
}

class MemoryProfileRepository implements UserProfileRepository {
  private store = new Map<string, UserProfile>();
  async get(userId: string) {
    return this.store.get(userId) ?? null;
  }
  async save(profile: UserProfile) {
    this.store.set(profile.id, { ...profile });
  }
  async findByTelegramChatId(chatId: string) {
    return [...this.store.values()].find((p) => p.telegramChatId === chatId) ?? null;
  }
}

class MemoryMarketRecapRepository implements MarketRecapRepository {
  private store = new Map<string, DailyMarketRecap>();
  async listByMarket(market: string, limit = 30) {
    return [...this.store.values()]
      .filter((r) => r.market === market)
      .sort((a, b) => b.tradingDate.localeCompare(a.tradingDate))
      .slice(0, limit);
  }
  async getById(id: string) {
    return this.store.get(id) ?? null;
  }
  async save(recap: DailyMarketRecap) {
    this.store.set(recap.id, { ...recap });
  }
}

class MemoryKeyStore implements KeyStore {
  private openRouter = new Map<string, string>();
  private groq = new Map<string, string>();
  private telegram = new Map<string, string>();
  private providers = new Map<string, 'openrouter' | 'groq'>();
  private bots = new Map<string, TelegramBotRecord>();

  async getOpenRouterKey(userId: string) {
    return this.openRouter.get(userId);
  }
  async setOpenRouterKey(userId: string, key: string | undefined) {
    if (key) this.openRouter.set(userId, key);
    else this.openRouter.delete(userId);
  }
  async getGroqKey(userId: string) {
    return this.groq.get(userId);
  }
  async setGroqKey(userId: string, key: string | undefined) {
    if (key) this.groq.set(userId, key);
    else this.groq.delete(userId);
  }
  async getTelegramToken(userId: string) {
    return this.telegram.get(userId);
  }
  async setTelegramToken(userId: string, token: string | undefined) {
    if (token) this.telegram.set(userId, token);
    else this.telegram.delete(userId);
  }
  async getProvider(userId: string) {
    return this.providers.get(userId);
  }
  async setProvider(userId: string, provider: 'openrouter' | 'groq') {
    this.providers.set(userId, provider);
  }
  async getTelegramBot(userId: string) {
    return this.bots.get(userId);
  }
  async setTelegramBot(userId: string, bot: TelegramBotRecord | undefined) {
    if (bot) this.bots.set(userId, bot);
    else this.bots.delete(userId);
  }
}

class MemoryCredentialRecordRepository implements CredentialRecordRepository {
  private records = new Map<string, Map<string, { envelope: string; updatedAt: string }>>();

  private bucket(userId: string) {
    let entry = this.records.get(userId);
    if (!entry) {
      entry = new Map();
      this.records.set(userId, entry);
    }
    return entry;
  }

  async saveEncrypted(userId: string, provider: string, envelope: string, updatedAt: string) {
    this.bucket(userId).set(provider, { envelope, updatedAt });
  }
  async readEncrypted(userId: string, provider: string) {
    return this.records.get(userId)?.get(provider) ?? null;
  }
  async delete(userId: string, provider: string) {
    this.records.get(userId)?.delete(provider);
  }
  async listEncrypted(userId: string) {
    const entry = this.records.get(userId);
    if (!entry) return [];
    return [...entry.entries()].map(([provider, value]) => ({ provider, ...value }));
  }
  /** Test helper: asserts the stored value is an envelope, not plaintext. */
  rawEnvelopes(userId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [provider, value] of this.records.get(userId)?.entries() ?? []) {
      out[provider] = value.envelope;
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* File-backed implementation (self-hosted default; survives restarts) */
/* ------------------------------------------------------------------ */

interface FileDbShape {
  goats: Record<string, FundGoat>;
  skills: Record<string, TradingSkill>;
  signals: Record<string, TradeSignal[]>;
  theses: Record<string, MarketThesis[]>;
  wakeEvents: Record<string, WakeEvent[]>;
  profiles: Record<string, UserProfile>;
  keys: {
    openRouter: Record<string, string>;
    groq: Record<string, string>;
    telegram: Record<string, string>;
    providers: Record<string, 'openrouter' | 'groq'>;
    bots: Record<string, TelegramBotRecord>;
  };
  recaps: Record<string, DailyMarketRecap>;
  credentials: Record<string, Record<string, { envelope: string; updatedAt: string }>>;
  chats: Record<string, Chat>;
  messages: Record<string, Record<string, ChatMessage>>;
}

function emptyDb(): FileDbShape {
  return {
    goats: {},
    skills: {},
    signals: {},
    theses: {},
    wakeEvents: {},
    profiles: {},
    keys: { openRouter: {}, groq: {}, telegram: {}, providers: {}, bots: {} },
    recaps: {},
    credentials: {},
    chats: {},
    messages: {},
  };
}

class MemoryChatRepository implements ChatRepository {
  private store = new Map<string, Chat>();
  async listByUser(userId: string) {
    return [...this.store.values()].filter((c) => c.userId === userId);
  }
  async get(chatId: string) {
    return this.store.get(chatId) ?? null;
  }
  async getForUser(chatId: string, userId: string) {
    const chat = this.store.get(chatId);
    return chat && chat.userId === userId ? chat : null;
  }
  async create(chat: Chat) {
    this.store.set(chat.id, chat);
    return chat;
  }
  async update(chatId: string, updates: Partial<Chat>) {
    const chat = this.store.get(chatId);
    if (!chat) throw new NotFoundError();
    Object.assign(chat, updates);
  }
  async delete(chatId: string) {
    this.store.delete(chatId);
  }
}

class MemoryMessageRepository implements MessageRepository {
  private store = new Map<string, ChatMessage>();
  async listByChat(chatId: string, limit = 50) {
    const msgs = [...this.store.values()].filter((m) => m.chatId === chatId).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    return msgs.slice(-limit);
  }
  async create(chatId: string, message: ChatMessage) {
    this.store.set(message.id, message);
    return message;
  }
  async deleteByChat(chatId: string) {
    for (const msg of this.store.values()) {
      if (msg.chatId === chatId) this.store.delete(msg.id);
    }
  }
  async delete(messageId: string) {
    this.store.delete(messageId);
  }
}

export class FilePersistence implements PersistenceLayer {
  mode: 'file' = 'file';
  goats: FileGoatRepository;
  skills: FileSkillRepository;
  signals: FileSignalRepository;
  theses: FileThesisRepository;
  wakeEvents: FileWakeEventRepository;
  profiles: FileProfileRepository;
  keys: FileKeyStore;
  recaps: FileMarketRecapRepository;
  credentials: FileCredentialRecordRepository;
  chats: FileChatRepository;
  messages: FileMessageRepository;

  private db: FileDbShape = emptyDb();
  private filePath: string;

  constructor(dataDir?: string) {
    const dir = dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'signalgoat-state.json');
    this.load();

    this.goats = new FileGoatRepository(this);
    this.skills = new FileSkillRepository(this);
    this.signals = new FileSignalRepository(this);
    this.theses = new FileThesisRepository(this);
    this.wakeEvents = new FileWakeEventRepository(this);
    this.profiles = new FileProfileRepository(this);
    this.keys = new FileKeyStore(this);
    this.recaps = new FileMarketRecapRepository(this);
    this.credentials = new FileCredentialRecordRepository(this);
    this.chats = new FileChatRepository(this);
    this.messages = new FileMessageRepository(this);
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.db = { ...emptyDb(), ...parsed };
      }
    } catch (err) {
      console.error('[persistence] Failed to load state file; starting empty.', err);
      this.db = emptyDb();
    }
  }

  /** Synchronous small writes are fine at MVP scale; atomic via temp file + rename. */
  persist(): void {
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[persistence] Failed to persist state file.', err);
    }
  }

  get data(): FileDbShape {
    return this.db;
  }
}

class FileGoatRepository implements GoatRepository {
  constructor(private parent: FilePersistence) {}
  async listByUser(userId: string) {
    return Object.values(this.parent.data.goats).filter((g) => g.userId === userId);
  }
  async listAll() {
    return Object.values(this.parent.data.goats);
  }
  async get(goatId: string) {
    return this.parent.data.goats[goatId] ?? null;
  }
  async getForUser(goatId: string, userId: string) {
    const goat = this.parent.data.goats[goatId];
    return goat && goat.userId === userId ? goat : null;
  }
  async save(goat: FundGoat) {
    this.parent.data.goats[goat.id] = goat;
    this.parent.persist();
  }
  async delete(goatId: string) {
    delete this.parent.data.goats[goatId];
    this.parent.persist();
  }
}

class FileSkillRepository implements SkillRepository {
  constructor(private parent: FilePersistence) {}
  async listByUser(userId: string) {
    return Object.values(this.parent.data.skills).filter((s) => s.userId === userId || s.isDefault);
  }
  async get(skillId: string) {
    return this.parent.data.skills[skillId] ?? null;
  }
  async save(skill: TradingSkill) {
    this.parent.data.skills[skill.id] = skill;
    this.parent.persist();
  }
  async delete(skillId: string) {
    delete this.parent.data.skills[skillId];
    this.parent.persist();
  }
}

class FileSignalRepository implements SignalRepository {
  constructor(private parent: FilePersistence) {}
  async listByGoat(goatId: string, limit = 50) {
    return (this.parent.data.signals[goatId] ?? []).slice(0, limit);
  }
  async save(signal: TradeSignal) {
    const list = this.parent.data.signals[signal.goatId] ?? [];
    list.unshift(signal);
    this.parent.data.signals[signal.goatId] = list.slice(0, 500);
    this.parent.persist();
  }
  async update(signal: TradeSignal) {
    const list = this.parent.data.signals[signal.goatId] ?? [];
    const index = list.findIndex((s) => s.id === signal.id);
    if (index < 0) return false;
    list[index] = signal;
    this.parent.persist();
    return true;
  }
}

class FileThesisRepository implements ThesisRepository {
  constructor(private parent: FilePersistence) {}
  async listByGoat(goatId: string, limit = 50) {
    return (this.parent.data.theses[goatId] ?? []).slice(0, limit);
  }
  async save(thesis: MarketThesis) {
    const list = this.parent.data.theses[thesis.goatId] ?? [];
    list.unshift(thesis);
    this.parent.data.theses[thesis.goatId] = list.slice(0, 200);
    this.parent.persist();
  }
}

class FileWakeEventRepository implements WakeEventRepository {
  constructor(private parent: FilePersistence) {}
  async listByGoat(goatId: string, limit = 50) {
    return (this.parent.data.wakeEvents[goatId] ?? []).slice(0, limit);
  }
  async save(event: WakeEvent) {
    const list = this.parent.data.wakeEvents[event.goatId] ?? [];
    list.unshift(event);
    this.parent.data.wakeEvents[event.goatId] = list.slice(0, 500);
    this.parent.persist();
  }
}

class FileProfileRepository implements UserProfileRepository {
  constructor(private parent: FilePersistence) {}
  async get(userId: string) {
    return this.parent.data.profiles[userId] ?? null;
  }
  async save(profile: UserProfile) {
    this.parent.data.profiles[profile.id] = profile;
    this.parent.persist();
  }
  async findByTelegramChatId(chatId: string) {
    return Object.values(this.parent.data.profiles).find((p) => p.telegramChatId === chatId) ?? null;
  }
}

class FileMarketRecapRepository implements MarketRecapRepository {
  constructor(private parent: FilePersistence) {}
  async listByMarket(market: string, limit = 30) {
    return Object.values(this.parent.data.recaps ?? {})
      .filter((r) => r.market === market)
      .sort((a, b) => b.tradingDate.localeCompare(a.tradingDate))
      .slice(0, limit);
  }
  async getById(id: string) {
    return this.parent.data.recaps[id] ?? null;
  }
  async save(recap: DailyMarketRecap) {
    this.parent.data.recaps[recap.id] = recap;
    this.parent.persist();
  }
}

class FileKeyStore implements KeyStore {
  constructor(private parent: FilePersistence) {}

  /**
   * Sub-records are read through a defaulting helper.
   *
   * A state file written before Groq existed has no `groq`, `providers` or
   * `bots` key. Reading `undefined[key]` would throw on every boot, so an
   * absent sub-record behaves as an empty one.
   */
  private section<K extends keyof FileDbShape['keys']>(
    name: K,
  ): FileDbShape['keys'][K] {
    const keys = this.parent.data.keys as Record<string, unknown>;
    if (!keys[name] || typeof keys[name] !== 'object') {
      keys[name] = {} as FileDbShape['keys'][K];
    }
    return keys[name] as FileDbShape['keys'][K];
  }

  async getOpenRouterKey(userId: string) {
    return this.parent.data.keys.openRouter[userId];
  }
  async setOpenRouterKey(userId: string, key: string | undefined) {
    if (key) this.parent.data.keys.openRouter[userId] = key;
    else delete this.parent.data.keys.openRouter[userId];
    this.parent.persist();
  }
  async getGroqKey(userId: string) {
    return this.section('groq')[userId];
  }
  async setGroqKey(userId: string, key: string | undefined) {
    if (key) this.section('groq')[userId] = key;
    else delete this.section('groq')[userId];
    this.parent.persist();
  }
  async getTelegramToken(userId: string) {
    return this.parent.data.keys.telegram[userId];
  }
  async setTelegramToken(userId: string, token: string | undefined) {
    if (token) this.parent.data.keys.telegram[userId] = token;
    else delete this.parent.data.keys.telegram[userId];
    this.parent.persist();
  }
  async getProvider(userId: string) {
    return this.section('providers')[userId];
  }
  async setProvider(userId: string, provider: 'openrouter' | 'groq') {
    this.section('providers')[userId] = provider;
    this.parent.persist();
  }
  async getTelegramBot(userId: string) {
    return this.section('bots')[userId];
  }
  async setTelegramBot(userId: string, bot: TelegramBotRecord | undefined) {
    if (bot) this.section('bots')[userId] = bot;
    else delete this.section('bots')[userId];
    this.parent.persist();
  }
}

/**
 * Encrypted credential envelopes, one map per user.
 *
 * The file on disk therefore contains `v1.<keyId>.<nonce>.<ct>.<tag>` and
 * nothing else — a state file copied off the host yields ciphertext, not keys.
 */
class FileCredentialRecordRepository implements CredentialRecordRepository {
  constructor(private parent: FilePersistence) {}

  private section(): Record<string, Record<string, { envelope: string; updatedAt: string }>> {
    const db = this.parent.data as unknown as {
      credentials?: Record<string, Record<string, { envelope: string; updatedAt: string }>>;
    };
    if (!db.credentials || typeof db.credentials !== 'object') db.credentials = {};
    return db.credentials;
  }

  private bucket(userId: string) {
    const all = this.section();
    if (!all[userId] || typeof all[userId] !== 'object') all[userId] = {};
    return all[userId];
  }

  async saveEncrypted(userId: string, provider: string, envelope: string, updatedAt: string) {
    this.bucket(userId)[provider] = { envelope, updatedAt };
    this.parent.persist();
  }

  async readEncrypted(userId: string, provider: string) {
    return this.section()[userId]?.[provider] ?? null;
  }

  async delete(userId: string, provider: string) {
    const entry = this.section()[userId];
    if (!entry) return;
    delete entry[provider];
    if (Object.keys(entry).length === 0) delete this.section()[userId];
    this.parent.persist();
  }

  async listEncrypted(userId: string) {
    const entry = this.section()[userId] ?? {};
    return Object.entries(entry).map(([provider, value]) => ({ provider, ...value }));
  }
}

class FileChatRepository implements ChatRepository {
  constructor(private parent: FilePersistence) {}

  private collection(): Record<string, Chat> {
    const db = this.parent.data as unknown as { chats?: Record<string, Chat> };
    if (!db.chats || typeof db.chats !== 'object') db.chats = {};
    return db.chats;
  }

  async listByUser(userId: string) {
    return Object.values(this.collection()).filter((c) => c.userId === userId);
  }
  async get(chatId: string) {
    return this.collection()[chatId] ?? null;
  }
  async getForUser(chatId: string, userId: string) {
    const chat = this.collection()[chatId];
    return chat && chat.userId === userId ? chat : null;
  }
  async create(chat: Chat) {
    this.collection()[chat.id] = chat;
    this.parent.persist();
    return chat;
  }
  async update(chatId: string, updates: Partial<Chat>) {
    const chat = this.collection()[chatId];
    if (!chat) throw new NotFoundError();
    Object.assign(chat, updates);
    this.parent.persist();
  }
  async delete(chatId: string) {
    delete this.collection()[chatId];
    this.parent.persist();
  }
}

class FileMessageRepository implements MessageRepository {
  constructor(private parent: FilePersistence) {}

  private collection(chatId: string): Record<string, ChatMessage> {
    const db = this.parent.data as unknown as { messages?: Record<string, Record<string, ChatMessage>> };
    if (!db.messages || typeof db.messages !== 'object') db.messages = {};
    if (!db.messages[chatId] || typeof db.messages[chatId] !== 'object') db.messages[chatId] = {};
    return db.messages[chatId];
  }

  async listByChat(chatId: string, limit = 50) {
    const msgs = Object.values(this.collection(chatId)).slice();
    return msgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-limit);
  }
  async create(chatId: string, message: ChatMessage) {
    this.collection(chatId)[message.id] = message;
    this.parent.persist();
    return message;
  }
  async deleteByChat(chatId: string) {
    const db = this.parent.data as unknown as { messages?: Record<string, Record<string, ChatMessage>> };
    delete db.messages?.[chatId];
    this.parent.persist();
  }
  async delete(messageId: string) {
    const collection = this.collection(messageId);
    delete collection[messageId];
    this.parent.persist();
  }
}

/* ------------------------------------------------------------------ */
/* Firestore implementation (production)                               */
/* ------------------------------------------------------------------ */

export class FirestorePersistence implements PersistenceLayer {
  mode: 'firestore' = 'firestore';
  goats: FirestoreGoatRepository;
  skills: FirestoreSkillRepository;
  signals: FirestoreSignalRepository;
  theses: FirestoreThesisRepository;
  wakeEvents: FirestoreWakeEventRepository;
  profiles: FirestoreProfileRepository;
  keys: FirestoreKeyStore;
  recaps: FirestoreMarketRecapRepository;
  credentials: FirestoreCredentialRecordRepository;
  chats: FirestoreChatRepository;
  messages: FirestoreMessageRepository;

  constructor(private db: Firestore) {
    this.goats = new FirestoreGoatRepository(db);
    this.skills = new FirestoreSkillRepository(db);
    this.signals = new FirestoreSignalRepository(db);
    this.theses = new FirestoreThesisRepository(db);
    this.wakeEvents = new FirestoreWakeEventRepository(db);
    this.profiles = new FirestoreProfileRepository(db);
    this.keys = new FirestoreKeyStore(db);
    this.recaps = new FirestoreMarketRecapRepository(db);
    this.credentials = new FirestoreCredentialRecordRepository(db);
    this.chats = new FirestoreChatRepository(db);
    this.messages = new FirestoreMessageRepository(db);
  }
}

const GOATS = 'goats';
const SKILLS = 'skills';
const SIGNALS = 'signals';
const THESES = 'theses';
const WAKE_EVENTS = 'wakeEvents';
const PROFILES = 'users';
const KEYS = 'integrationKeys';
const CREDENTIALS = 'credentials';
const CHATS = 'chats';
const MESSAGES = 'messages';

class FirestoreGoatRepository implements GoatRepository {
  constructor(private db: Firestore) {}
  private col() {
    return this.db.collection(GOATS);
  }
  async listByUser(userId: string) {
    const snap = await this.col().where('userId', '==', userId).get();
    return snap.docs.map((d) => d.data() as FundGoat);
  }
  async listAll() {
    const snap = await this.col().get();
    return snap.docs.map((d) => d.data() as FundGoat);
  }
  async get(goatId: string) {
    const doc = await this.col().doc(goatId).get();
    return doc.exists ? (doc.data() as FundGoat) : null;
  }
  async getForUser(goatId: string, userId: string) {
    const goat = await this.get(goatId);
    return goat && goat.userId === userId ? goat : null;
  }
  async save(goat: FundGoat) {
    await this.col().doc(goat.id).set(firestoreSafe({ ...goat }));
  }
  async delete(goatId: string) {
    await this.col().doc(goatId).delete();
  }
}

class FirestoreSkillRepository implements SkillRepository {
  constructor(private db: Firestore) {}
  private col() {
    return this.db.collection(SKILLS);
  }
  async listByUser(userId: string) {
    const snap = await this.col().where('userId', '==', userId).get();
    return snap.docs.map((d) => d.data() as TradingSkill);
  }
  async get(skillId: string) {
    const doc = await this.col().doc(skillId).get();
    return doc.exists ? (doc.data() as TradingSkill) : null;
  }
  async save(skill: TradingSkill) {
    await this.col().doc(skill.id).set(firestoreSafe({ ...skill }));
  }
  async delete(skillId: string) {
    await this.col().doc(skillId).delete();
  }
}

class FirestoreSignalRepository implements SignalRepository {
  constructor(private db: Firestore) {}
  async listByGoat(goatId: string, limit = 50) {
    const snap = await this.db
      .collection(SIGNALS)
      .where('goatId', '==', goatId)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((d) => d.data() as TradeSignal);
  }
  async save(signal: TradeSignal) {
    await this.db.collection(SIGNALS).doc(signal.id).set(firestoreSafe({ ...signal }));
  }
  async update(signal: TradeSignal) {
    const ref = this.db.collection(SIGNALS).doc(signal.id);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.set(firestoreSafe({ ...signal }));
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Firestore value sanitising                                           */
/* ------------------------------------------------------------------ */

/**
 * Deep-copies a value, dropping `undefined` and rejecting non-Firestore types.
 *
 * WHY THIS EXISTS
 *
 *   Firestore has no `undefined`. Passing it — even nested, even inside an
 *   array — fails the WHOLE write with "Value for argument data is not a
 *   valid Firestore document". Nothing is saved; the error surfaces only as a
 *   `persistenceErrors` string on the wake event.
 *
 *   The application's own optional fields produce it routinely: a tracker for
 *   an indicator with no extra parameters serialises `indicatorParams:
 *   undefined`, and a signal with no `decisionNote` yet does the same. In
 *   development the file-backed repository stores the object as-is and is
 *   perfectly happy, so this ONLY reproduces on Firestore — meaning it
 *   appears for the first time in production, on exactly the records that
 *   matter most: the theses and proposals a GOAT just reasoned about.
 *
 *   Observed in production on 2026-10-12: `trackers.0.indicatorParams`.
 *
 * WHY NOT `ignoreUndefinedProperties`
 *
 *   That setting silently discards the field everywhere, which is the same
 *   outcome but spread across every call site and invisible in review.
 *   Sanitising once, at the boundary, keeps the type system honest — the
 *   domain types still say `indicatorParams?: …` — and makes the rule
 *   auditable in one place.
 *
 * Rules:
 *   - `undefined` is DROPPED (the field simply does not exist);
 *   - `null` is KEPT (Firestore stores it, and it is a meaningful value);
 *   - arrays are mapped element-wise, so a hole never becomes `null`;
 *   - `Date` is kept as-is, which Firestore understands natively;
 *   - anything else that is not a plain object or a primitive is stringified
 *     rather than throwing, so one odd field cannot fail a whole document.
 */
export function firestoreSafe<T>(value: T): T {
  const seen = new WeakSet<object>();

  const walk = (input: unknown): unknown => {
    if (input === null) return null;
    if (input === undefined) return undefined;

    const type = typeof input;
    if (type === 'string' || type === 'boolean') return input;
    if (type === 'number') {
      // Firestore rejects NaN and Infinity outright.
      return Number.isFinite(input as number) ? input : null;
    }
    if (type === 'bigint') return String(input);
    if (type === 'function' || type === 'symbol') return undefined;

    if (input instanceof Date) return input;
    if (Array.isArray(input)) {
      return input.map((item) => {
        const walked = walk(item);
        return walked === undefined ? null : walked;
      });
    }

    if (type === 'object') {
      const object = input as object;
      // Cycle guard: a self-referential document would otherwise hang the write.
      if (seen.has(object)) return null;
      seen.add(object);

      if (typeof (object as { toJSON?: () => unknown }).toJSON === 'function') {
        return walk((object as { toJSON: () => unknown }).toJSON());
      }

      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(object)) {
        const walked = walk(item);
        if (walked !== undefined) out[key] = walked;
      }
      return out;
    }

    return undefined;
  };

  return walk(value) as T;
}

class FirestoreThesisRepository implements ThesisRepository {
  constructor(private db: Firestore) {}
  async listByGoat(goatId: string, limit = 50) {
    const snap = await this.db
      .collection(THESES)
      .where('goatId', '==', goatId)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((d) => d.data() as MarketThesis);
  }
  async save(thesis: MarketThesis) {
    await this.db.collection(THESES).doc(thesis.id).set(firestoreSafe({ ...thesis }));
  }
}

class FirestoreWakeEventRepository implements WakeEventRepository {
  constructor(private db: Firestore) {}
  async listByGoat(goatId: string, limit = 50) {
    const snap = await this.db
      .collection(WAKE_EVENTS)
      .where('goatId', '==', goatId)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((d) => d.data() as WakeEvent);
  }
  async save(event: WakeEvent) {
    await this.db.collection(WAKE_EVENTS).doc(event.id).set(firestoreSafe({ ...event }));
  }
}

class FirestoreProfileRepository implements UserProfileRepository {
  constructor(private db: Firestore) {}
  async get(userId: string) {
    const doc = await this.db.collection(PROFILES).doc(userId).get();
    return doc.exists ? (doc.data() as UserProfile) : null;
  }
  async save(profile: UserProfile) {
    await this.db.collection(PROFILES).doc(profile.id).set(firestoreSafe({ ...profile }));
  }
  async findByTelegramChatId(chatId: string) {
    const snap = await this.db.collection(PROFILES).where('telegramChatId', '==', chatId).limit(1).get();
    return snap.empty ? null : (snap.docs[0].data() as UserProfile);
  }
}

const RECAPS = 'dailyMarketRecaps';

class FirestoreMarketRecapRepository implements MarketRecapRepository {
  constructor(private db: Firestore) {}
  async listByMarket(market: string, limit = 30) {
    const snap = await this.db
      .collection(RECAPS)
      .where('market', '==', market)
      .orderBy('tradingDate', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((d) => d.data() as DailyMarketRecap);
  }
  async getById(id: string) {
    const doc = await this.db.collection(RECAPS).doc(id).get();
    return doc.exists ? (doc.data() as DailyMarketRecap) : null;
  }
  async save(recap: DailyMarketRecap) {
    // doc().set() is an upsert, and the id embeds the trading date, which is
    // what makes the daily rollup idempotent.
    await this.db.collection(RECAPS).doc(recap.id).set(firestoreSafe({ ...recap }));
  }
}

class FirestoreKeyStore implements KeyStore {
  constructor(private db: Firestore) {}
  private doc(userId: string) {
    return this.db.collection(KEYS).doc(userId);
  }

  /**
   * Reads one credential field.
   *
   * Field-by-field rather than document-wide so adding a credential type never
   * requires a migration, and a partial document still resolves cleanly.
   */
  private async readString(
    userId: string,
    field: string,
  ): Promise<string | undefined> {
    const doc = await this.doc(userId).get();
    if (!doc.exists) return undefined;
    const value = doc.data()?.[field];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private async write(
    userId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    // `merge: true` throws on an explicit `undefined` too, so a caller clearing
    // a credential by setting it to undefined would fail the whole write.
    await this.doc(userId).set(firestoreSafe(fields), { merge: true });
  }

  async getOpenRouterKey(userId: string) {
    return this.readString(userId, 'openRouterKey');
  }
  async setOpenRouterKey(userId: string, key: string | undefined) {
    await this.write(userId, { openRouterKey: key ?? null });
  }
  async getGroqKey(userId: string) {
    return this.readString(userId, 'groqKey');
  }
  async setGroqKey(userId: string, key: string | undefined) {
    await this.write(userId, { groqKey: key ?? null });
  }
  async getTelegramToken(userId: string) {
    return this.readString(userId, 'telegramToken');
  }
  async setTelegramToken(userId: string, token: string | undefined) {
    await this.write(userId, { telegramToken: token ?? null });
  }
  async getProvider(userId: string) {
    const doc = await this.doc(userId).get();
    if (!doc.exists) return undefined;
    const value = doc.data()?.provider;
    return value === 'groq' || value === 'openrouter' ? value : undefined;
  }
  async setProvider(userId: string, provider: 'openrouter' | 'groq') {
    await this.write(userId, { provider });
  }
  async getTelegramBot(userId: string) {
    const doc = await this.doc(userId).get();
    if (!doc.exists) return undefined;
    const value = doc.data()?.telegramBot;
    if (!value || typeof value !== 'object') return undefined;
    const bot = value as Partial<TelegramBotRecord>;
    if (typeof bot.id !== 'number' || typeof bot.username !== 'string') {
      return undefined;
    }
    return {
      id: bot.id,
      username: bot.username,
      verifiedAt: typeof bot.verifiedAt === 'string' ? bot.verifiedAt : '',
      ...(typeof bot.webhookUrl === 'string' ? { webhookUrl: bot.webhookUrl } : {}),
    };
  }
  async setTelegramBot(userId: string, bot: TelegramBotRecord | undefined) {
    await this.write(userId, { telegramBot: bot ?? null });
  }
}

/**
 * Encrypted credential envelopes, one document per (user, provider).
 *
 * DOCUMENT-LEVEL, NOT FIELD-LEVEL. `integrationKeys/{uid}` co-located every
 * secret on the user document, which meant a single `get()` on the profile
 * returned every key that user had — and Firestore security rules operate at
 * document granularity, so there was no way to write a rule that permitted the
 * profile read while denying the credentials. `credentials/{uid}_{provider}`
 * makes each secret independently addressable and independently rule-able.
 */
class FirestoreCredentialRecordRepository implements CredentialRecordRepository {
  constructor(private db: Firestore) {}

  private doc(userId: string, provider: string) {
    return this.db.collection(CREDENTIALS).doc(`${userId}_${provider}`);
  }

  async saveEncrypted(userId: string, provider: string, envelope: string, updatedAt: string) {
    await this.doc(userId, provider).set({ userId, provider, envelope, updatedAt });
  }

  async readEncrypted(userId: string, provider: string) {
    const snap = await this.doc(userId, provider).get();
    if (!snap.exists) return null;
    const data = snap.data() ?? {};
    const envelope = data.envelope;
    const updatedAt = data.updatedAt;
    if (typeof envelope !== 'string' || envelope.length === 0) return null;
    return {
      envelope,
      updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
    };
  }

  async delete(userId: string, provider: string) {
    await this.doc(userId, provider).delete();
  }

  async listEncrypted(userId: string) {
    // Scoped by the `userId` field rather than `docId.startsWith` so this uses
    // the collection index instead of a full scan.
    const snap = await this.db
      .collection(CREDENTIALS)
      .where('userId', '==', userId)
      .get();
    const out: Array<{ provider: string; envelope: string; updatedAt: string }> = [];
    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      if (typeof data?.provider !== 'string' || typeof data?.envelope !== 'string') continue;
      out.push({
        provider: data.provider,
        envelope: data.envelope,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
      });
    }
    return out;
  }
}

class FirestoreChatRepository implements ChatRepository {
  constructor(private db: Firestore) {}

  private col() {
    return this.db.collection(CHATS);
  }
  async listByUser(userId: string) {
    // Avoid requiring a composite Firestore index just to load a user's chats.
    // Query by owner, then sort the small per-user result set in application code.
    const snap = await this.col().where('userId', '==', userId).get();
    return snap.docs
      .map((d) => d.data() as Chat)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }
  async get(chatId: string) {
    const doc = await this.col().doc(chatId).get();
    return doc.exists ? (doc.data() as Chat) : null;
  }
  async getForUser(chatId: string, userId: string) {
    const chat = await this.get(chatId);
    return chat && chat.userId === userId ? chat : null;
  }
  async create(chat: Chat) {
    await this.col().doc(chat.id).set(firestoreSafe(chat));
    return chat;
  }
  async update(chatId: string, updates: Partial<Chat>) {
    await this.col().doc(chatId).update(firestoreSafe(updates));
  }
  async delete(chatId: string) {
    await this.col().doc(chatId).delete();
  }
}

class FirestoreMessageRepository implements MessageRepository {
  constructor(private db: Firestore) {}

  async listByChat(chatId: string, limit = 50) {
    const snap = await this.db
      .collection(CHATS)
      .doc(chatId)
      .collection(MESSAGES)
      .orderBy('createdAt', 'asc')
      .limit(limit)
      .get();
    return snap.docs.map((d) => d.data() as ChatMessage);
  }
  async create(chatId: string, message: ChatMessage) {
    await this.db.collection(CHATS).doc(chatId).collection(MESSAGES).doc(message.id).set(firestoreSafe(message));
    return message;
  }
  async deleteByChat(chatId: string) {
    const snapshot = await this.db.collection(CHATS).doc(chatId).collection(MESSAGES).get();
    const batch = this.db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
  async delete(messageId: string) {
    // Message id is not globally unique across chats; search the user's chats.
    // In practice the caller deletes whole chats, so a full scan is the safe
    // and cheap option at this scale.
    const snapshot = await this.db.collection(CHATS).get();
    const batch = this.db.batch();
    for (const chatDoc of snapshot.docs) {
      const msgSnap = await chatDoc.ref.collection(MESSAGES).where('id', '==', messageId).get();
      msgSnap.docs.forEach((doc) => batch.delete(doc.ref));
    }
    await batch.commit();
  }
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

let firestoreDb: Firestore | null | undefined;

function getFirestoreDb(): Firestore | null {
  if (firestoreDb !== undefined) return firestoreDb;

  try {
    // firebase-admin is server-only: no client bundle path imports this module.
    const admin = getFirebaseAdmin();
    if (!admin) {
      firestoreDb = null;
      return null;
    }

    firestoreDb = admin.firestore;
    console.log('[persistence] Using Firestore persistence.');
  } catch (err) {
    console.warn('[persistence] Firestore unavailable, falling back to file persistence.', err);
    firestoreDb = null;
  }

  return firestoreDb;
}

/**
 * True when this process must not fall back to weaker storage.
 *
 * On Vercel a file-backed store is written to an ephemeral scratch directory
 * that is discarded on the next cold start, so every user's GOATs, skills and
 * signals would silently vanish between invocations — and an in-memory store
 * loses them the moment the instance is reclaimed.
 */
function mustNotDegrade(): boolean {
  return isProductionRuntime();
}

export function createPersistence(dataDir?: string): PersistenceLayer {
  const db = getFirestoreDb();
  if (db) {
    return new FirestorePersistence(db);
  }

  /**
   * FAIL CLOSED IN PRODUCTION.
   *
   * The previous chain was Firestore -> file -> memory, unconditionally. In
   * production that meant a missing or invalid service account produced a server
   * that appeared healthy, reported `persistenceMode: 'memory'`, accepted
   * writes and then lost all of them. A user would create a GOAT, see it
   * succeed, and find it gone.
   *
   * Production now refuses to degrade: the API layer reports the real cause and
   * protected routes are unreachable, which is a loud, correct failure instead
   * of a quiet data loss.
   */
  if (mustNotDegrade()) {
    throw new Error(
      'Firestore is unavailable and this is a production runtime, so ' +
        'persistence cannot degrade to file or in-memory storage. ' +
        (getFirebaseAdminFailureReason() ??
          'Firebase Admin credentials are missing or could not be loaded.'),
    );
  }

  try {
    return new FilePersistence(dataDir);
  } catch (err) {
    console.warn('[persistence] File persistence unavailable; using in-memory only.', err);
    return new InMemoryPersistence();
  }
}
