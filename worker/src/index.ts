export interface Env {
  SIRGOAT_API_ORIGIN: string;
  CRON_SECRET: string;
  CRON_TIMEOUT_MS?: string;
  ROBOT_RUNNER: DurableObjectNamespace;
}

/** One alarm and one serial execution lane per robot. The API remains the
 * authority for ownership, strategy version, runtime status and candles. */
export class RobotRunner implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('x-worker-admin-secret') !== this.env.CRON_SECRET) return json({ error: 'Unauthorized' }, 401);
    const id = new URL(request.url).searchParams.get('id');
    if (!id || !/^robot_[a-f0-9]{24}$/.test(id)) return json({ error: 'Invalid robot id' }, 400);
    if (request.method === 'POST') {
      await this.state.storage.put('robotId', id);
      await this.state.storage.setAlarm(Date.now() + 1_000);
      return json({ ok: true });
    }
    if (request.method === 'DELETE') {
      await this.state.storage.deleteAlarm();
      await this.state.storage.delete('robotId');
      return json({ ok: true });
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  async alarm(): Promise<void> {
    const id = await this.state.storage.get<string>('robotId');
    if (!id) return;
    // Re-arm before the network call. A transient API outage cannot silently
    // strand a running robot; the next alarm retries the same completed candle.
    await this.state.storage.setAlarm(Date.now() + 60_000);
    const origin = this.env.SIRGOAT_API_ORIGIN?.trim().replace(/\/+$/, '');
    if (!origin || !this.env.CRON_SECRET) throw new Error('Robot worker is not configured.');
    const target = new URL(`/api/internal/robots/${encodeURIComponent(id)}/process`, origin);
    const response = await fetch(target, { method: 'POST', headers: { authorization: `Bearer ${this.env.CRON_SECRET}` }, signal: AbortSignal.timeout(25_000) });
    if (response.status === 409 || response.status === 404) {
      await this.state.storage.deleteAlarm();
      await this.state.storage.delete('robotId');
      return;
    }
    if (!response.ok) throw new Error(`Robot process failed: ${response.status} ${await response.text()}`);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function dispatch(env: Env, trigger: "scheduled" | "manual"): Promise<Response> {
  const origin = env.SIRGOAT_API_ORIGIN?.trim().replace(/\/+$/, "");
  const secret = env.CRON_SECRET?.trim();
  if (!origin || !secret) {
    console.error("[sirgoat-cron] Missing SIRGOAT_API_ORIGIN or CRON_SECRET binding.");
    return json({ ok: false, error: "Worker is not configured." }, 503);
  }

  let target: URL;
  try {
    target = new URL("/api/internal/cron", origin);
    if (target.protocol !== "https:" && target.hostname !== "localhost" && target.hostname !== "127.0.0.1") {
      return json({ ok: false, error: "SIRGOAT_API_ORIGIN must use HTTPS." }, 500);
    }
  } catch {
    return json({ ok: false, error: "SIRGOAT_API_ORIGIN must be a valid URL." }, 500);
  }

  const timeoutMs = Math.min(280_000, Math.max(5_000, Number(env.CRON_TIMEOUT_MS) || 250_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("cron dispatch timed out"), timeoutMs);

  try {
    const response = await fetch(target, {
      method: "GET",
      headers: {
        authorization: `Bearer ${secret}`,
        accept: "application/json",
        "user-agent": "SIRGOAT-Cloudflare-Scheduler/1.0",
      },
      signal: controller.signal,
      redirect: "error",
    });
    const body = await response.text();
    if (!response.ok) {
      console.error("[sirgoat-cron] API rejected scheduled dispatch.", {
        status: response.status,
        response: body.slice(0, 1200),
      });
      return json({
        ok: false,
        trigger,
        upstreamStatus: response.status,
        error: "SIRGOAT cron endpoint rejected the dispatch.",
        detail: body.slice(0, 1200),
      }, 502);
    }

    let result: unknown;
    try {
      result = JSON.parse(body);
    } catch {
      return json({ ok: false, trigger, error: "Cron endpoint returned invalid JSON." }, 502);
    }

    return json({ ok: true, trigger, dispatchedAt: new Date().toISOString(), result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[sirgoat-cron] Dispatch failed.", message);
    return json({ ok: false, trigger, error: message }, 502);
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const response = await dispatch(env, "scheduled");
      if (!response.ok) {
        const body = await response.text();
        console.error("[sirgoat-cron] Scheduled invocation failed.", response.status, body);
        throw new Error(`SIRGOAT scheduled dispatch failed: HTTP ${response.status}`);
      }
      console.log("[sirgoat-cron] Scheduled dispatch completed.", await response.text());
    })());
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "sirgoat-cloudflare-scheduler", now: new Date().toISOString() });
    }
    if (url.pathname.startsWith('/robots/')) {
      const id = decodeURIComponent(url.pathname.slice('/robots/'.length));
      if (!/^robot_[a-f0-9]{24}$/.test(id)) return json({ error: 'Invalid robot id' }, 400);
      if (request.method !== 'POST' && request.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405);
      if (request.headers.get('x-worker-admin-secret') !== env.CRON_SECRET) return json({ error: 'Unauthorized' }, 401);
      const stub = env.ROBOT_RUNNER.get(env.ROBOT_RUNNER.idFromName(id));
      return stub.fetch(new Request(`https://robot-runner.internal/?id=${encodeURIComponent(id)}`, { method: request.method, headers: { 'x-worker-admin-secret': env.CRON_SECRET } }));
    }
    if (request.method !== "POST" || url.pathname !== "/dispatch") {
      return json({ error: "Not found" }, 404);
    }
    const supplied = request.headers.get("x-worker-admin-secret") ?? "";
    if (!env.CRON_SECRET || supplied !== env.CRON_SECRET) {
      return json({ error: "Unauthorized" }, 401);
    }
    return dispatch(env, "manual");
  },
};
