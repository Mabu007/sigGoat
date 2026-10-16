/**
 * Durable competition ledger for comparing existing GOATs and GOAT teams.
 *
 * Competition outcomes are append-only records. The evaluator is deliberately
 * separate from participant runtime context: rankings are never injected into
 * GOAT prompts, team assessments, or execution decisions.
 */
import fs from "node:fs";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import { getFirebaseAdmin } from "./firebaseAdmin";

export type CompetitionStatus = "DRAFT" | "RUNNING" | "COMPLETED" | "CANCELLED";
export type CompetitionEnvironment = "PAPER" | "LIVE";
export type CompetitionParticipantKind = "GOAT" | "TEAM";
export type CompetitionOutcomeResult = "WIN" | "LOSS" | "FLAT";

export interface CompetitionParticipant {
  id: string;
  kind: CompetitionParticipantKind;
  label: string;
}

export interface CompetitionScoringPolicy {
  version: number;
  returnWeight: number;
  drawdownPenaltyWeight: number;
  winRateWeight: number;
  riskPenaltyWeight: number;
  createdAt: string;
}

export interface CompetitionOutcome {
  id: string;
  participantId: string;
  sourceRecordId: string;
  environment: CompetitionEnvironment;
  recordedAt: string;
  netPnl: number;
  equityAfter: number;
  riskAmount: number;
  result: CompetitionOutcomeResult;
}

export interface GoatCompetition {
  id: string;
  ownerUserId: string;
  name: string;
  description?: string;
  status: CompetitionStatus;
  environment: CompetitionEnvironment;
  startingEquity: number;
  participants: CompetitionParticipant[];
  policies: CompetitionScoringPolicy[];
  activePolicyVersion: number;
  outcomes: CompetitionOutcome[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

interface CompetitionDb { competitions: Record<string, GoatCompetition> }
const emptyDb = (): CompetitionDb => ({ competitions: {} });
const safeId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 240);

export interface CompetitionStanding {
  participantId: string;
  participantKind: CompetitionParticipantKind;
  participantLabel: string;
  outcomeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  returnPct: number;
  maxDrawdownPct: number;
  maxRiskPct: number;
  score: number;
  rank: number;
}

export function evaluateCompetition(competition: GoatCompetition): CompetitionStanding[] {
  const policy = competition.policies.find(p => p.version === competition.activePolicyVersion);
  if (!policy) throw new Error("COMPETITION_POLICY_MISSING");
  const standings = competition.participants.map(participant => {
    const outcomes = competition.outcomes
      .filter(outcome => outcome.participantId === participant.id && outcome.environment === competition.environment)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
    let equity = competition.startingEquity;
    let peak = equity;
    let maxDrawdownPct = 0;
    let wins = 0;
    let losses = 0;
    let netPnl = 0;
    let maxRiskPct = 0;
    for (const outcome of outcomes) {
      netPnl += outcome.netPnl;
      equity = outcome.equityAfter;
      peak = Math.max(peak, equity);
      if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
      if (outcome.result === "WIN") wins += 1;
      if (outcome.result === "LOSS") losses += 1;
      if (competition.startingEquity > 0) maxRiskPct = Math.max(maxRiskPct, (outcome.riskAmount / competition.startingEquity) * 100);
    }
    const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0;
    const returnPct = competition.startingEquity > 0 ? (netPnl / competition.startingEquity) * 100 : 0;
    const score =
      returnPct * policy.returnWeight -
      maxDrawdownPct * policy.drawdownPenaltyWeight +
      winRate * policy.winRateWeight -
      maxRiskPct * policy.riskPenaltyWeight;
    return {
      participantId: participant.id,
      participantKind: participant.kind,
      participantLabel: participant.label,
      outcomeCount: outcomes.length,
      wins,
      losses,
      winRate,
      netPnl,
      returnPct,
      maxDrawdownPct,
      maxRiskPct,
      score,
      rank: 0,
    };
  });
  standings.sort((a, b) => b.score - a.score || b.returnPct - a.returnPct || a.participantId.localeCompare(b.participantId));
  return standings.map((standing, index) => ({ ...standing, rank: index + 1 }));
}

export class GoatCompetitionStore {
  private readonly firestore?: Firestore;
  private readonly filePath: string;
  private db: CompetitionDb = emptyDb();

  constructor(options: { firestore?: Firestore; filePath?: string } = {}) {
    this.firestore = options.firestore;
    this.filePath = options.filePath || path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "goat-competitions.json");
    if (!this.firestore) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      try {
        if (fs.existsSync(this.filePath)) this.db = { ...emptyDb(), ...(JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<CompetitionDb>) };
      } catch (error) {
        throw new Error("GOAT_COMPETITION_STORE_UNREADABLE: saved competitions could not be loaded.", { cause: error });
      }
    }
  }

  private collection() { return this.firestore!.collection("goatCompetitions"); }
  private persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = this.filePath + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.db), "utf8");
    fs.renameSync(temp, this.filePath);
  }

  async create(competition: GoatCompetition): Promise<GoatCompetition> {
    const id = safeId(competition.id);
    const record = { ...competition, id };
    if (this.firestore) {
      const ref = this.collection().doc(id);
      await this.firestore.runTransaction(async tx => {
        const existing = await tx.get(ref);
        if (existing.exists) throw new Error("COMPETITION_ALREADY_EXISTS");
        tx.create(ref, record);
      });
      return record;
    }
    if (this.db.competitions[id]) throw new Error("COMPETITION_ALREADY_EXISTS");
    this.db.competitions[id] = record;
    this.persist();
    return record;
  }

  async getForUser(id: string, userId: string): Promise<GoatCompetition | null> {
    const key = safeId(id);
    if (this.firestore) {
      const snapshot = await this.collection().doc(key).get();
      if (!snapshot.exists) return null;
      const record = snapshot.data() as GoatCompetition;
      return record.ownerUserId === userId ? record : null;
    }
    const record = this.db.competitions[key];
    return record?.ownerUserId === userId ? record : null;
  }

  async listForUser(userId: string): Promise<GoatCompetition[]> {
    if (this.firestore) {
      const snapshot = await this.collection().where("ownerUserId", "==", userId).get();
      return snapshot.docs.map(doc => doc.data() as GoatCompetition).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return Object.values(this.db.competitions).filter(record => record.ownerUserId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async save(competition: GoatCompetition): Promise<GoatCompetition> {
    const id = safeId(competition.id);
    const record = { ...competition, id };
    if (this.firestore) await this.collection().doc(id).set(record);
    else { this.db.competitions[id] = record; this.persist(); }
    return record;
  }

  async appendOutcome(id: string, userId: string, outcome: CompetitionOutcome): Promise<GoatCompetition | null> {
    const key = safeId(id);
    if (this.firestore) {
      const ref = this.collection().doc(key);
      return this.firestore.runTransaction(async tx => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) return null;
        const current = snapshot.data() as GoatCompetition;
        if (current.ownerUserId !== userId) return null;
        if (current.status !== "RUNNING") throw new Error("COMPETITION_NOT_RUNNING");
        if (!current.participants.some(p => p.id === outcome.participantId)) throw new Error("COMPETITION_PARTICIPANT_NOT_FOUND");
        if (outcome.environment !== current.environment) throw new Error("COMPETITION_ENVIRONMENT_MISMATCH");
        if (current.outcomes.some(item => item.sourceRecordId === outcome.sourceRecordId)) throw new Error("COMPETITION_OUTCOME_ALREADY_RECORDED");
        const updated = { ...current, outcomes: [...current.outcomes, outcome], updatedAt: new Date().toISOString() };
        tx.set(ref, updated);
        return updated;
      });
    }
    const current = this.db.competitions[key];
    if (!current || current.ownerUserId !== userId) return null;
    if (current.status !== "RUNNING") throw new Error("COMPETITION_NOT_RUNNING");
    if (!current.participants.some(p => p.id === outcome.participantId)) throw new Error("COMPETITION_PARTICIPANT_NOT_FOUND");
    if (outcome.environment !== current.environment) throw new Error("COMPETITION_ENVIRONMENT_MISMATCH");
    if (current.outcomes.some(item => item.sourceRecordId === outcome.sourceRecordId)) throw new Error("COMPETITION_OUTCOME_ALREADY_RECORDED");
    const updated = { ...current, outcomes: [...current.outcomes, outcome], updatedAt: new Date().toISOString() };
    this.db.competitions[key] = updated;
    this.persist();
    return updated;
  }
}

export function createGoatCompetitionStore(): GoatCompetitionStore {
  return new GoatCompetitionStore({ firestore: getFirebaseAdmin()?.firestore });
}
