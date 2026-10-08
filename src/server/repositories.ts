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
import { SignalGoat, TradingSkill, TradeSignal, MarketThesis, WakeEvent, UserProfile } from '../types';
import { getFirebaseAdmin } from './firebaseAdmin';
import type { Firestore } from 'firebase-admin/firestore';

/* ------------------------------------------------------------------ */
/* Interfaces                                                          */
/* ------------------------------------------------------------------ */

export interface GoatRepository {
  listByUser(userId: string): Promise<SignalGoat[]>;
  listAll(): Promise<SignalGoat[]>;
  get(goatId: string): Promise<SignalGoat | null>;
  getForUser(goatId: string, userId: string): Promise<SignalGoat | null>;
  save(goat: SignalGoat): Promise<void>;
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

export interface KeyStore {
  getOpenRouterKey(userId: string): Promise<string | undefined>;
  setOpenRouterKey(userId: string, key: string | undefined): Promise<void>;
  getTelegramToken(userId: string): Promise<string | undefined>;
  setTelegramToken(userId: string, token: string | undefined): Promise<void>;
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
  goats = new MemoryGoatRepository();
  skills = new MemorySkillRepository();
  signals = new MemorySignalRepository();
  theses = new MemoryThesisRepository();
  wakeEvents = new MemoryWakeEventRepository();
  profiles = new MemoryProfileRepository();
  keys = new MemoryKeyStore();
}

class MemoryGoatRepository implements GoatRepository {
  private store = new Map<string, SignalGoat>();
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
  async save(goat: SignalGoat) {
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

class MemoryKeyStore implements KeyStore {
  private openRouter = new Map<string, string>();
  private telegram = new Map<string, string>();
  async getOpenRouterKey(userId: string) {
    return this.openRouter.get(userId);
  }
  async setOpenRouterKey(userId: string, key: string | undefined) {
    if (key) this.openRouter.set(userId, key);
    else this.openRouter.delete(userId);
  }
  async getTelegramToken(userId: string) {
    return this.telegram.get(userId);
  }
  async setTelegramToken(userId: string, token: string | undefined) {
    if (token) this.telegram.set(userId, token);
    else this.telegram.delete(userId);
  }
}

/* ------------------------------------------------------------------ */
/* File-backed implementation (self-hosted default; survives restarts) */
/* ------------------------------------------------------------------ */

interface FileDbShape {
  goats: Record<string, SignalGoat>;
  skills: Record<string, TradingSkill>;
  signals: Record<string, TradeSignal[]>;
  theses: Record<string, MarketThesis[]>;
  wakeEvents: Record<string, WakeEvent[]>;
  profiles: Record<string, UserProfile>;
  keys: { openRouter: Record<string, string>; telegram: Record<string, string> };
}

function emptyDb(): FileDbShape {
  return { goats: {}, skills: {}, signals: {}, theses: {}, wakeEvents: {}, profiles: {}, keys: { openRouter: {}, telegram: {} } };
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
  async save(goat: SignalGoat) {
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

class FileKeyStore implements KeyStore {
  constructor(private parent: FilePersistence) {}
  async getOpenRouterKey(userId: string) {
    return this.parent.data.keys.openRouter[userId];
  }
  async setOpenRouterKey(userId: string, key: string | undefined) {
    if (key) this.parent.data.keys.openRouter[userId] = key;
    else delete this.parent.data.keys.openRouter[userId];
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

  constructor(private db: Firestore) {
    this.goats = new FirestoreGoatRepository(db);
    this.skills = new FirestoreSkillRepository(db);
    this.signals = new FirestoreSignalRepository(db);
    this.theses = new FirestoreThesisRepository(db);
    this.wakeEvents = new FirestoreWakeEventRepository(db);
    this.profiles = new FirestoreProfileRepository(db);
    this.keys = new FirestoreKeyStore(db);
  }
}

const GOATS = 'goats';
const SKILLS = 'skills';
const SIGNALS = 'signals';
const THESES = 'theses';
const WAKE_EVENTS = 'wakeEvents';
const PROFILES = 'users';
const KEYS = 'integrationKeys';

class FirestoreGoatRepository implements GoatRepository {
  constructor(private db: Firestore) {}
  private col() {
    return this.db.collection(GOATS);
  }
  async listByUser(userId: string) {
    const snap = await this.col().where('userId', '==', userId).get();
    return snap.docs.map((d) => d.data() as SignalGoat);
  }
  async listAll() {
    const snap = await this.col().get();
    return snap.docs.map((d) => d.data() as SignalGoat);
  }
  async get(goatId: string) {
    const doc = await this.col().doc(goatId).get();
    return doc.exists ? (doc.data() as SignalGoat) : null;
  }
  async getForUser(goatId: string, userId: string) {
    const goat = await this.get(goatId);
    return goat && goat.userId === userId ? goat : null;
  }
  async save(goat: SignalGoat) {
    await this.col().doc(goat.id).set({ ...goat });
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
    await this.col().doc(skill.id).set({ ...skill });
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
    await this.db.collection(SIGNALS).doc(signal.id).set({ ...signal });
  }
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
    await this.db.collection(THESES).doc(thesis.id).set({ ...thesis });
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
    await this.db.collection(WAKE_EVENTS).doc(event.id).set({ ...event });
  }
}

class FirestoreProfileRepository implements UserProfileRepository {
  constructor(private db: Firestore) {}
  async get(userId: string) {
    const doc = await this.db.collection(PROFILES).doc(userId).get();
    return doc.exists ? (doc.data() as UserProfile) : null;
  }
  async save(profile: UserProfile) {
    await this.db.collection(PROFILES).doc(profile.id).set({ ...profile });
  }
  async findByTelegramChatId(chatId: string) {
    const snap = await this.db.collection(PROFILES).where('telegramChatId', '==', chatId).limit(1).get();
    return snap.empty ? null : (snap.docs[0].data() as UserProfile);
  }
}

class FirestoreKeyStore implements KeyStore {
  constructor(private db: Firestore) {}
  private doc(userId: string) {
    return this.db.collection(KEYS).doc(userId);
  }
  async getOpenRouterKey(userId: string) {
    const doc = await this.doc(userId).get();
    if (!doc.exists) return undefined;
    const value = doc.data()?.openRouterKey;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  async setOpenRouterKey(userId: string, key: string | undefined) {
    await this.doc(userId).set({ openRouterKey: key ?? null }, { merge: true });
  }
  async getTelegramToken(userId: string) {
    const doc = await this.doc(userId).get();
    if (!doc.exists) return undefined;
    const value = doc.data()?.telegramToken;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  async setTelegramToken(userId: string, token: string | undefined) {
    await this.doc(userId).set({ telegramToken: token ?? null }, { merge: true });
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

export function createPersistence(dataDir?: string): PersistenceLayer {
  const db = getFirestoreDb();
  if (db) {
    return new FirestorePersistence(db);
  }
  try {
    return new FilePersistence(dataDir);
  } catch (err) {
    console.warn('[persistence] File persistence unavailable; using in-memory only.', err);
    return new InMemoryPersistence();
  }
}
