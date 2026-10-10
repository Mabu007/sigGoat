import './src/server/env';

import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { createApp } from './src/server/app';
import { createViteGuard } from './src/server/devViteGuard';
import { appPersistence, restoreRuntimes, seedDefaultSkills } from './src/server/apiRouter';
import { durableObjectRegistry } from './src/services/durable-object/DurableObjectRegistry';
import { hyperliquidProvider } from './src/services/market-data/hyperliquid/HyperliquidMarketDataProvider';
import { marketStateStore } from './src/server/apiRouter';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function logStartup(mode: string): void {
  console.log('');
  console.log('  FundAGoat starting up');
  console.log(`  Persistence mode: ${appPersistence.mode}`);
  console.log(`  Auth mode: see GET /api/settings/status`);
  console.log(`  Market data: PAPER (deterministic simulated feed — not live prices)`);
  console.log('');
}

async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    // Dev only: let Vite serve the SPA with HMR.
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });

    const app = createApp({ serveStatic: false });

    /**
     * VITE MIDDLEWARE IS MOUNTED BEHIND A GUARD, NOT DIRECTLY.
     *
     * See `src/server/devViteGuard.ts` for the full rationale: Vite must
     * never see an `/api` request, or its CORS middleware can write headers
     * onto a response the API already committed (ERR_HTTP_HEADERS_SENT).
     * The guard is extracted so the invariant is regression-tested.
     */
    app.use(
      createViteGuard(
        vite.middlewares as unknown as Parameters<typeof createViteGuard>[0],
      ),
    );

    await listen(app, PORT);
    return;
  }

  // Production: serve the built client from dist/ (see src/server/app.ts).
  await listen(createApp({ serveStatic: true }), PORT);
}

async function listen(app: ReturnType<typeof createApp>, port: number) {
  const server = app.listen(port, '0.0.0.0', async () => {
    logStartup(appPersistence.mode);

    // Restart recovery + default skill library — best-effort, non-blocking boot.
    await seedDefaultSkills();
    await restoreRuntimes();
    console.log(`  Server ready on port ${port}`);
    console.log('');
  });

  const shutdown = (signal: string) => {
    console.log(`\n[server] ${signal} received — shutting down…`);
    // Stop every GOAT actor timer/subscription first.
    for (const goat of durableObjectRegistry.getAll()) {
      goat.destroy();
    }
    // Stop every market-data polling loop (provider + shared state store).
    hyperliquidProvider.stopTicks();
    marketStateStore.stop();
    server.close(() => {
      console.log('[server] HTTP server closed.');
      process.exit(0);
    });
    // Hard exit fallback in case close hangs.
    setTimeout(() => process.exit(0), 5_000).unref?.();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('Failed to start FundAGoat server:', err);
  process.exit(1);
});
