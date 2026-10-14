import './src/server/env';

import { createApp } from './src/server/app';
import { appPersistence, marketStateStore } from './src/server/apiRouter';
import { goatRuntimeRegistry } from './src/services/goat-runtime/GoatRuntimeRegistry';
import { hyperliquidProvider } from './src/services/market-data/hyperliquid/HyperliquidMarketDataProvider';

/**
 * Private Cloud Run dispatcher service.
 *
 * It deliberately does not call restoreRuntimes() or seedDefaultSkills() on
 * startup. Each cron request loads due GOATs from Firestore and creates only
 * the runtime actors needed for that batch. The Firestore scheduler, not a
 * process-local timer or registry, owns all due times.
 *
 * Cloud Run IAM must restrict this service to the Cloud Scheduler service
 * account. The application also checks CRON_SECRET on /api/internal/cron.
 */
const port = Number(process.env.PORT) || 8080;
const app = createApp({ serveStatic: false });

const server = app.listen(port, '0.0.0.0', () => {
  console.log('[scheduler] SIRGOAT Cloud Run dispatcher ready.');
  console.log(`[scheduler] Persistence mode: ${appPersistence.mode}`);
  if (appPersistence.mode !== 'firestore') {
    console.error('[scheduler] Firestore persistence is not active; cron requests will fail closed.');
  }
});

function shutdown(signal: string) {
  console.log(`[scheduler] ${signal} received — stopping runtime resources.`);
  for (const goat of goatRuntimeRegistry.getAll()) goat.destroy();
  hyperliquidProvider.stopTicks();
  marketStateStore.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
