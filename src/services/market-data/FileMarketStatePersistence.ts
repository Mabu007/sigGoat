/**
 * FILE-BACKED MARKET STATE PERSISTENCE
 * ====================================
 * Implements MarketStatePersistence on the local filesystem.
 *
 * This is the current backing store. On Cloudflare Durable Objects the same
 * interface is satisfied by `state.storage`; on S3-compatible storage by a
 * single-object PUT. Nothing above MarketStateStore changes, because no
 * consumer knows where a snapshot lives.
 *
 * Why persist market state at all?
 *
 * A restart currently leaves every chart empty until the first successful
 * fetch, and a cold start with N GOATs issues N simultaneous requests. A
 * restored snapshot lets the UI render immediately and is refreshed on the
 * next read (it is always restored marked expired).
 */

import fs from 'fs';
import path from 'path';
import type {
  MarketStatePersistence,
  MarketStateSnapshot,
} from './MarketStateStore';

export class FileMarketStatePersistence implements MarketStatePersistence {
  private readonly dir: string;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private dirty = false;

  constructor(dir?: string) {
    this.dir =
      dir ??
      path.join(
        process.env.DATA_DIR || path.join(process.cwd(), 'data'),
        'market-state',
      );
  }

  private fileFor(key: string): string {
    const safe = key.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  async load(key: string): Promise<MarketStateSnapshot | null> {
    try {
      const file = this.fileFor(key);
      if (!fs.existsSync(file)) return null;

      const parsed = JSON.parse(
        fs.readFileSync(file, 'utf8'),
      ) as MarketStateSnapshot;

      /**
       * A corrupt or truncated file must never take the process down. Treat it
       * as a cache miss and refetch.
       */
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !Array.isArray(parsed.candles)
      ) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Write-behind and serialised: snapshots arrive every few seconds and a
   * synchronous write per arrival would block the event loop for no benefit.
   */
  save(
    key: string,
    snapshot: MarketStateSnapshot,
  ): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(() => this.writeNow(key, snapshot))
      .catch(() => {
        /* A failed cache write must never propagate. */
      });

    this.dirty = true;
    return this.writeQueue as Promise<void>;
  }

  private async writeNow(
    key: string,
    snapshot: MarketStateSnapshot,
  ): Promise<void> {
    try {
      fs.mkdirSync(this.dir, { recursive: true });

      const file = this.fileFor(key);
      const tmp = `${file}.tmp`;

      // Atomic: a crash mid-write cannot leave a half-parsed snapshot.
      fs.writeFileSync(
        tmp,
        JSON.stringify(snapshot),
        'utf8',
      );
      fs.renameSync(tmp, file);
    } catch {
      /* best effort */
    }
  }

  hasPendingWrites(): boolean {
    return this.dirty;
  }
}
