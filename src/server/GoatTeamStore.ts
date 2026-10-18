import fs from "node:fs";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import { getFirebaseAdmin } from "./firebaseAdmin";
import type { TradingProvider } from "../types";

export type GoatTeamCoordinationMode = "INDEPENDENT" | "CONSENSUS" | "LEAD_REVIEW";
export type GoatTeamStatus = "DRAFT" | "DEPLOYED" | "PAUSED" | "PARTIAL";
export type GoatTeamEnvironment = "DEMO" | "LIVE";
export type GoatTeamMarketDataProvider = "biquote" | "ctrader" | "hyperliquid";

/**
 * Risk limits chosen in the deployment step. These are a deployment-time
 * contract for the team, not per-member preferences: the whole team trades
 * one asset on one venue under one risk budget.
 */
export interface TeamRiskParameters {
  /** Percent of account equity risked on a single position. */
  maxPositionSizePercent?: number;
  /** Percent daily loss that halts the team for the session. */
  maxDailyLossPercent?: number;
  /** Cap on simultaneously open positions across the team. */
  maxOpenPositions?: number;
  /** Percent stop distance applied to every entry. */
  stopLossPercent?: number;
  /** Percent target distance applied to every entry. */
  takeProfitPercent?: number;
}

/** Everything the deployment modal collects before a team goes live. */
export interface TeamDeploymentSettings {
  provider: TradingProvider;
  asset: string;
  risk: TeamRiskParameters;
  /**
   * Whether the team may submit real orders.
   *
   * Off by default: deploying starts research against PAPER data and needs no
   * broker. This is the single switch that makes a venue credential necessary,
   * and the API refuses to deploy live without one.
   */
  liveTrading?: boolean;
  /**
   * The room's own account balance, in the deposit currency the venue reports.
   *
   * A demo team has no broker behind it, so this is the only balance it will
   * ever have — it is what the room header shows and what position sizing is
   * read against. A live team overrides it with the connected account's real
   * balance at read time; this value remains as the recorded baseline.
   */
  startingBalance?: number;
}

export interface GoatTeam {
  id: string;
  ownerUserId: string;
  name: string;
  /**
   * Member GOAT ids. A team of exactly one member is valid and is how a user
   * creates a single specialist: the team IS the creation unit.
   */
  memberGoatIds: string[];
  /**
   * Free-text operating instructions for the whole team. This is global state:
   * it is persisted with the team and injected into every member's reasoning
   * context, so members follow the team's playbook rather than only their own
   * job description.
   */
  instructions?: string;
  /** How members reconcile their views. Derived from instructions by default. */
  coordinationMode: GoatTeamCoordinationMode;
  /** Market-data environment only; it never grants or revokes order execution. */
  environment?: GoatTeamEnvironment;
  /** DEMO uses BiQuote reference prices; LIVE uses the selected venue feed. */
  marketDataProvider?: GoatTeamMarketDataProvider;
  /** Selected live market-data venue, not an execution permission. */
  liveTradingProvider?: "ctrader" | "hyperliquid";
  /** User-selected analysis cadences in minutes; defaults to one review every 15 minutes. */
  monitoringIntervals?: number[];
  leadGoatId?: string;
  /** Public teams appear in the discovery feed; private teams are owner-only. */
  visibility?: "PUBLIC" | "PRIVATE";
  /** Stable share slug for a public or unlisted private team link. */
  publicSlug?: string;
  status: GoatTeamStatus;
  /** Deployment settings captured by the deployment modal. */
  deployment?: TeamDeploymentSettings;
  createdAt: string;
  updatedAt: string;
  deployedAt?: string;
}

interface TeamDb { teams: Record<string, GoatTeam> }
const emptyDb = (): TeamDb => ({ teams: {} });
const safeId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 240);

export class GoatTeamStore {
  private readonly firestore?: Firestore;
  private readonly filePath: string;
  private db: TeamDb = emptyDb();

  constructor(options: { firestore?: Firestore; filePath?: string } = {}) {
    this.firestore = options.firestore;
    this.filePath = options.filePath || path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "goat-teams.json");
    if (!this.firestore) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      try {
        if (fs.existsSync(this.filePath)) this.db = { ...emptyDb(), ...(JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<TeamDb>) };
      } catch (error) {
        throw new Error("GOAT_TEAM_STORE_UNREADABLE: saved GOAT teams could not be loaded.", { cause: error });
      }
    }
  }

  private collection() { return this.firestore!.collection("goatTeams"); }
  private persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = this.filePath + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.db), "utf8");
    fs.renameSync(temp, this.filePath);
  }

  async create(team: GoatTeam): Promise<GoatTeam> {
    const id = safeId(team.id);
    const record = { ...team, id };
    if (this.firestore) {
      const ref = this.collection().doc(id);
      await this.firestore.runTransaction(async tx => {
        const existing = await tx.get(ref);
        if (existing.exists) throw new Error("GOAT_TEAM_ALREADY_EXISTS");
        tx.create(ref, record);
      });
      return record;
    }
    if (this.db.teams[id]) throw new Error("GOAT_TEAM_ALREADY_EXISTS");
    this.db.teams[id] = record;
    this.persist();
    return record;
  }

  async getForUser(id: string, userId: string): Promise<GoatTeam | null> {
    const key = safeId(id);
    if (this.firestore) {
      const snapshot = await this.collection().doc(key).get();
      if (!snapshot.exists) return null;
      const team = snapshot.data() as GoatTeam;
      return team.ownerUserId === userId ? team : null;
    }
    const team = this.db.teams[key];
    return team?.ownerUserId === userId ? team : null;
  }

  async listForUser(userId: string): Promise<GoatTeam[]> {
    if (this.firestore) {
      const snapshot = await this.collection().where("ownerUserId", "==", userId).get();
      return snapshot.docs.map(doc => doc.data() as GoatTeam).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return Object.values(this.db.teams).filter(team => team.ownerUserId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listPublic(): Promise<GoatTeam[]> {
    const teams = this.firestore
      ? (await this.collection().where("visibility", "==", "PUBLIC").get()).docs.map(doc => doc.data() as GoatTeam)
      : Object.values(this.db.teams).filter(team => team.visibility === "PUBLIC");
    return teams.filter(team => Boolean(team.publicSlug)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getPublicBySlug(slug: string): Promise<GoatTeam | null> {
    // Slugs are unguessable share capabilities for PRIVATE teams and public
    // identifiers for PUBLIC teams. The caller must never enumerate private slugs.
    if (this.firestore) {
      const snapshot = await this.collection().where("publicSlug", "==", slug).limit(1).get();
      if (snapshot.empty) return null;
      return snapshot.docs[0].data() as GoatTeam;
    }
    return Object.values(this.db.teams).find(team => team.publicSlug === slug) ?? null;
  }

  async save(team: GoatTeam): Promise<GoatTeam> {
    const id = safeId(team.id);
    const record = { ...team, id };
    if (this.firestore) await this.collection().doc(id).set(record);
    else { this.db.teams[id] = record; this.persist(); }
    return record;
  }

  async deleteForUser(id: string, userId: string): Promise<boolean> {
    const team = await this.getForUser(id, userId);
    if (!team) return false;
    if (this.firestore) await this.collection().doc(safeId(id)).delete();
    else { delete this.db.teams[safeId(id)]; this.persist(); }
    return true;
  }
}

export function createGoatTeamStore(): GoatTeamStore {
  return new GoatTeamStore({ firestore: getFirebaseAdmin()?.firestore });
}
