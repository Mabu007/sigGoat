/**
 * Durable GOAT workflow ledger.
 *
 * The ledger stores orchestration metadata and activity records only. It never
 * stores prompts, market snapshots, provider credentials, or model payloads.
 * Firestore transactions make run creation, stage transitions, and execution
 * claims safe across concurrent serverless instances. The file backend is for
 * local/self-hosted development.
 */
import fs from "node:fs";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import { getFirebaseAdmin } from "./firebaseAdmin";

export type GoatWorkflowStatus =
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "COMPLETED"
  | "FAILED";

export type GoatWorkflowDecision = "ACCEPTED" | "REJECTED";
export type GoatExecutionStatus = "CLAIMED" | "SUBMITTED" | "FAILED";

export interface GoatWorkflowRun {
  id: string;
  goatId: string;
  userId: string;
  eventId: string;
  generationId: string;
  market: string;
  triggerType: string;
  stage: string;
  status: GoatWorkflowStatus;
  signalId?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface GoatWorkflowActivity {
  id: string;
  workflowId: string;
  goatId: string;
  userId: string;
  type: "WORKFLOW_STARTED" | "STAGE_COMPLETED" | "APPROVAL_REQUIRED" | "APPROVED" | "REJECTED" | "WORKFLOW_COMPLETED" | "WORKFLOW_FAILED" | "EXECUTION_CLAIMED" | "EXECUTION_SUBMITTED" | "EXECUTION_FAILED";
  stage: string;
  at: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface GoatExecutionIntent {
  id: string;
  signalId: string;
  goatId: string;
  userId: string;
  provider: string;
  /** Stable hash of the confirmed order shape; reused IDs cannot mutate an intent. */
  fingerprint?: string;
  status: GoatExecutionStatus;
  createdAt: string;
  updatedAt: string;
  orderId?: string;
  message?: string;
}

interface WorkflowDb {
  runs: Record<string, GoatWorkflowRun>;
  activities: Record<string, GoatWorkflowActivity>;
  executions: Record<string, GoatExecutionIntent>;
}

function emptyDb(): WorkflowDb {
  return { runs: {}, activities: {}, executions: {} };
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 240);
}

function isTerminal(status: GoatWorkflowStatus): boolean {
  return status === "APPROVED" || status === "REJECTED" || status === "COMPLETED" || status === "FAILED";
}

export class GoatWorkflowStore {
  private readonly firestore?: Firestore;
  private readonly filePath: string;
  private db: WorkflowDb = emptyDb();
  private readonly now: () => string;

  constructor(options: { firestore?: Firestore; filePath?: string; now?: () => string } = {}) {
    this.firestore = options.firestore;
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
    this.filePath = options.filePath || path.join(dataDir, "goat-workflows.json");
    this.now = options.now || (() => new Date().toISOString());

    if (!this.firestore) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      try {
        if (fs.existsSync(this.filePath)) {
          const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<WorkflowDb>;
          this.db = { ...emptyDb(), ...parsed };
        }
      } catch (error) {
        throw new Error("GOAT_WORKFLOW_STORE_UNREADABLE: durable workflow state could not be loaded.", { cause: error });
      }
    }
  }

  private runsCollection() { return this.firestore!.collection("goatWorkflowRuns"); }
  private activitiesCollection() { return this.firestore!.collection("goatWorkflowActivities"); }
  private executionsCollection() { return this.firestore!.collection("goatExecutionIntents"); }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const temp = this.filePath + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.db), "utf8");
    fs.renameSync(temp, this.filePath);
  }

  private activity(
    run: GoatWorkflowRun,
    type: GoatWorkflowActivity["type"],
    stage: string,
    details?: GoatWorkflowActivity["details"],
  ): GoatWorkflowActivity {
    return {
      id: safeId(`${run.id}:${stage}:${type}`),
      workflowId: run.id,
      goatId: run.goatId,
      userId: run.userId,
      type,
      stage,
      at: this.now(),
      ...(details ? { details } : {}),
    };
  }

  async createRun(run: GoatWorkflowRun): Promise<boolean> {
    const id = safeId(run.id);
    const record = { ...run, id };
    const activity = this.activity(record, "WORKFLOW_STARTED", record.stage);
    if (this.firestore) {
      const runRef = this.runsCollection().doc(id);
      const activityRef = this.activitiesCollection().doc(activity.id);
      return this.firestore.runTransaction(async (tx) => {
        const existing = await tx.get(runRef);
        if (existing.exists) return false;
        tx.create(runRef, record);
        tx.create(activityRef, activity);
        return true;
      });
    }
    if (this.db.runs[id]) return false;
    this.db.runs[id] = record;
    this.db.activities[activity.id] = activity;
    this.persist();
    return true;
  }

  async getRun(id: string): Promise<GoatWorkflowRun | null> {
    const key = safeId(id);
    if (this.firestore) {
      const snapshot = await this.runsCollection().doc(key).get();
      return snapshot.exists ? snapshot.data() as GoatWorkflowRun : null;
    }
    return this.db.runs[key] ?? null;
  }

  /**
   * Advances a run and writes its activity in one Firestore transaction.
   * Terminal states cannot be reopened by a late retry.
   */
  async advanceRun(
    id: string,
    stage: string,
    status?: GoatWorkflowStatus,
    details?: GoatWorkflowActivity["details"],
    signalId?: string,
    errorCode?: string,
  ): Promise<GoatWorkflowRun | null> {
    const key = safeId(id);
    if (this.firestore) {
      const ref = this.runsCollection().doc(key);
      return this.firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) return null;
        const current = snapshot.data() as GoatWorkflowRun;
        if (isTerminal(current.status)) return current;
        const nextStatus = status ?? current.status;
        const now = this.now();
        const updated: GoatWorkflowRun = {
          ...current,
          stage,
          status: nextStatus,
          updatedAt: now,
          ...(signalId ? { signalId } : {}),
          ...(errorCode ? { errorCode } : {}),
          ...(isTerminal(nextStatus) ? { completedAt: now } : {}),
        };
        const type: GoatWorkflowActivity["type"] =
          nextStatus === "WAITING_APPROVAL" ? "APPROVAL_REQUIRED"
            : nextStatus === "APPROVED" ? "APPROVED"
              : nextStatus === "REJECTED" ? "REJECTED"
                : nextStatus === "FAILED" ? "WORKFLOW_FAILED"
                  : nextStatus === "COMPLETED" ? "WORKFLOW_COMPLETED"
                    : "STAGE_COMPLETED";
        const activity = this.activity(updated, type, stage, details);
        const activityRef = this.activitiesCollection().doc(activity.id);
        const priorActivity = await tx.get(activityRef);
        tx.set(ref, updated);
        if (!priorActivity.exists) tx.create(activityRef, activity);
        return updated;
      });
    }
    const current = this.db.runs[key];
    if (!current || isTerminal(current.status)) return current ?? null;
    const nextStatus = status ?? current.status;
    const now = this.now();
    const updated: GoatWorkflowRun = {
      ...current, stage, status: nextStatus, updatedAt: now,
      ...(signalId ? { signalId } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(isTerminal(nextStatus) ? { completedAt: now } : {}),
    };
    const type: GoatWorkflowActivity["type"] =
      nextStatus === "WAITING_APPROVAL" ? "APPROVAL_REQUIRED"
        : nextStatus === "APPROVED" ? "APPROVED"
          : nextStatus === "REJECTED" ? "REJECTED"
            : nextStatus === "FAILED" ? "WORKFLOW_FAILED"
              : nextStatus === "COMPLETED" ? "WORKFLOW_COMPLETED"
                : "STAGE_COMPLETED";
    const activity = this.activity(updated, type, stage, details);
    this.db.runs[key] = updated;
    this.db.activities[activity.id] ??= activity;
    this.persist();
    return updated;
  }

  async resolveApproval(
    signalId: string,
    userId: string,
    goatId: string,
    decision: GoatWorkflowDecision,
  ): Promise<GoatWorkflowRun | null> {
    if (this.firestore) {
      const snapshot = await this.runsCollection().where("signalId", "==", signalId).limit(1).get();
      if (snapshot.empty) return null;
      const ref = snapshot.docs[0].ref;
      return this.firestore.runTransaction(async (tx) => {
        const currentSnapshot = await tx.get(ref);
        if (!currentSnapshot.exists) return null;
        const current = currentSnapshot.data() as GoatWorkflowRun;
        if (current.userId !== userId || current.goatId !== goatId) return null;
        if (current.status === (decision === "ACCEPTED" ? "APPROVED" : "REJECTED")) return current;
        if (current.status !== "WAITING_APPROVAL") return null;
        const status = decision === "ACCEPTED" ? "APPROVED" : "REJECTED";
        const updated: GoatWorkflowRun = { ...current, status, stage: "approval_resolved", updatedAt: this.now(), completedAt: this.now() };
        const activity = this.activity(updated, decision === "ACCEPTED" ? "APPROVED" : "REJECTED", updated.stage, { decision });
        const activityRef = this.activitiesCollection().doc(activity.id);
        const existingActivity = await tx.get(activityRef);
        tx.set(ref, updated);
        if (!existingActivity.exists) tx.create(activityRef, activity);
        return updated;
      });
    }
    const current = Object.values(this.db.runs).find((run) => run.signalId === signalId);
    if (!current || current.userId !== userId || current.goatId !== goatId) return null;
    const desired = decision === "ACCEPTED" ? "APPROVED" : "REJECTED";
    if (current.status === desired) return current;
    if (current.status !== "WAITING_APPROVAL") return null;
    const updated = { ...current, status: desired, stage: "approval_resolved", updatedAt: this.now(), completedAt: this.now() };
    const activity = this.activity(updated, desired, updated.stage, { decision });
    this.db.runs[current.id] = updated;
    this.db.activities[activity.id] ??= activity;
    this.persist();
    return updated;
  }

  /**
   * Claim an execution intent BEFORE contacting a venue. A claim is permanent:
   * an uncertain timeout is never blindly retried as a second order.
   */
  async claimExecution(intent: Omit<GoatExecutionIntent, "status" | "createdAt" | "updatedAt">): Promise<{ claimed: boolean; conflict: boolean; intent: GoatExecutionIntent }> {
    const id = safeId(intent.id);
    const now = this.now();
    const record: GoatExecutionIntent = { ...intent, id, status: "CLAIMED", createdAt: now, updatedAt: now };
    const activity: GoatWorkflowActivity = {
      id: safeId(`execution_${id}_claimed`), workflowId: `execution:${id}`,
      goatId: intent.goatId, userId: intent.userId, type: "EXECUTION_CLAIMED",
      stage: "execution_claimed", at: now,
      details: { provider: intent.provider, signalId: intent.signalId },
    };
    if (this.firestore) {
      const ref = this.executionsCollection().doc(id);
      const activityRef = this.activitiesCollection().doc(activity.id);
      return this.firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (snapshot.exists) {
          const existing = snapshot.data() as GoatExecutionIntent;
          return { claimed: false, conflict: Boolean(existing.fingerprint && record.fingerprint && existing.fingerprint !== record.fingerprint), intent: existing };
        }
        tx.create(ref, record);
        tx.create(activityRef, activity);
        return { claimed: true, conflict: false, intent: record };
      });
    }
    const existing = this.db.executions[id];
    if (existing) return { claimed: false, conflict: Boolean(existing.fingerprint && record.fingerprint && existing.fingerprint !== record.fingerprint), intent: existing };
    this.db.executions[id] = record;
    this.db.activities[activity.id] = activity;
    this.persist();
    return { claimed: true, conflict: false, intent: record };
  }

  async finishExecution(
    id: string,
    status: Exclude<GoatExecutionStatus, "CLAIMED">,
    result: { orderId?: string; message?: string } = {},
  ): Promise<GoatExecutionIntent | null> {
    const key = safeId(id);
    if (this.firestore) {
      const ref = this.executionsCollection().doc(key);
      return this.firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) return null;
        const current = snapshot.data() as GoatExecutionIntent;
        if (current.status !== "CLAIMED") return current;
        const updated = { ...current, ...result, status, updatedAt: this.now() };
        const activity: GoatWorkflowActivity = {
          id: safeId(`execution_${key}_${status.toLowerCase()}`), workflowId: `execution:${key}`,
          goatId: current.goatId, userId: current.userId,
          type: status === "SUBMITTED" ? "EXECUTION_SUBMITTED" : "EXECUTION_FAILED",
          stage: status === "SUBMITTED" ? "execution_submitted" : "execution_failed",
          at: updated.updatedAt,
          details: { provider: current.provider, signalId: current.signalId, ...(result.orderId ? { orderId: result.orderId } : {}) },
        };
        const activityRef = this.activitiesCollection().doc(activity.id);
        const existingActivity = await tx.get(activityRef);
        tx.set(ref, updated);
        if (!existingActivity.exists) tx.create(activityRef, activity);
        return updated;
      });
    }
    const current = this.db.executions[key];
    if (!current) return null;
    if (current.status !== "CLAIMED") return current;
    const updated = { ...current, ...result, status, updatedAt: this.now() };
    const activity: GoatWorkflowActivity = {
      id: safeId(`execution_${key}_${status.toLowerCase()}`), workflowId: `execution:${key}`,
      goatId: current.goatId, userId: current.userId,
      type: status === "SUBMITTED" ? "EXECUTION_SUBMITTED" : "EXECUTION_FAILED",
      stage: status === "SUBMITTED" ? "execution_submitted" : "execution_failed",
      at: updated.updatedAt,
      details: { provider: current.provider, signalId: current.signalId, ...(result.orderId ? { orderId: result.orderId } : {}) },
    };
    this.db.executions[key] = updated;
    this.db.activities[activity.id] ??= activity;
    this.persist();
    return updated;
  }

  async listActivities(goatId: string, limit = 100): Promise<GoatWorkflowActivity[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    if (this.firestore) {
      const snapshot = await this.activitiesCollection().where("goatId", "==", goatId).get();
      return snapshot.docs.map((doc) => doc.data() as GoatWorkflowActivity)
        .sort((a, b) => b.at.localeCompare(a.at)).slice(0, safeLimit);
    }
    return Object.values(this.db.activities).filter((item) => item.goatId === goatId)
      .sort((a, b) => b.at.localeCompare(a.at)).slice(0, safeLimit);
  }
}

/** Uses the same Firebase Admin configuration as the rest of server persistence. */
export function createGoatWorkflowStore(): GoatWorkflowStore {
  const admin = getFirebaseAdmin();
  return new GoatWorkflowStore({ firestore: admin?.firestore });
}
