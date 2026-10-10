/**
 * GOAT RUNTIME REGISTRY
 * ======================
 * Keeps exactly one GoatDurableObject instance per GOAT id in this process.
 * Destroying an instance (delete/stop) fully removes its timers and
 * subscriptions — no orphaned runtime jobs.
 */

import { GoatDurableObject, GoatDurableObjectOptions } from './GoatDurableObject';
import { FundGoat, TradingSkill, TradeSignal } from '../../types';
import type { TrackerEvaluationReport } from '../tracker-sdk/TrackerEvaluator';

class DurableObjectRegistry {
  private instances: Map<string, GoatDurableObject> = new Map();

  private signalCallbacks: Set<(goat: FundGoat, signal: TradeSignal) => void> = new Set();

  private trackerCallbacks: Set<
    (goat: FundGoat, report: TrackerEvaluationReport) => void
  > = new Set();

  get(goatId: string): GoatDurableObject | undefined {
    return this.instances.get(goatId);
  }

  getOrCreate(
    goat: FundGoat,
    skills: TradingSkill[],
    options: GoatDurableObjectOptions,
  ): GoatDurableObject {
    let instance = this.instances.get(goat.id);

    if (!instance) {
      instance = new GoatDurableObject(goat, skills, {
        ...options,
        onSignal: (signalGoat, signal) => this.notifySignal(signalGoat, signal),
        onTrackerTriggered: (trackerGoat, report) =>
          this.notifyTrackerTriggered(trackerGoat, report),
      });
      this.instances.set(goat.id, instance);
    } else {
      instance.updateConfig(goat, skills);
    }

    return instance;
  }

  getAll(): GoatDurableObject[] {
    return Array.from(this.instances.values());
  }

  /** Destroy and remove a GOAT runtime: timers, subscriptions, callbacks. */
  remove(goatId: string): void {
    const instance = this.instances.get(goatId);
    if (!instance) return;
    instance.destroy();
    this.instances.delete(goatId);
  }

  onGlobalSignal(callback: (goat: FundGoat, signal: TradeSignal) => void): () => void {
    this.signalCallbacks.add(callback);
    return () => {
      this.signalCallbacks.delete(callback);
    };
  }

  /** Fired when a deterministic tracker condition is satisfied. */
  onTrackerTriggered(
    callback: (goat: FundGoat, report: TrackerEvaluationReport) => void,
  ): () => void {
    this.trackerCallbacks.add(callback);
    return () => {
      this.trackerCallbacks.delete(callback);
    };
  }

  private notifySignal(goat: FundGoat, signal: TradeSignal): void {
    this.signalCallbacks.forEach((callback) => {
      try {
        callback(goat, signal);
      } catch (error) {
        console.error('Global signal callback error', error);
      }
    });
  }

  private notifyTrackerTriggered(
    goat: FundGoat,
    report: TrackerEvaluationReport,
  ): void {
    this.trackerCallbacks.forEach((callback) => {
      try {
        callback(goat, report);
      } catch (error) {
        console.error('Global tracker callback error', error);
      }
    });
  }
}

export const durableObjectRegistry = new DurableObjectRegistry();
