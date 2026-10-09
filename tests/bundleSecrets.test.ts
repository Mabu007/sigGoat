import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * CLIENT BUNDLE LEAK REGRESSION
 * ===============================
 * Guards the credential leak that shipped to production.
 *
 * WHAT HAPPENED
 *
 * `vite.config.ts` had `envPrefix: ['VITE_', 'FIREBASE_']`. `envPrefix` is a
 * PREFIX match, so `FIREBASE_` also exposed `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64`
 * — the admin service account, including its PRIVATE KEY — into the public
 * client bundle. Vercel makes Secrets available to the build step, so the key
 * was inlined and served to every visitor.
 *
 * WHY A PLAINTEXT GREP WAS NOT ENOUGH
 *
 * The key ships BASE64-ENCODED. Grepping the bundle for `BEGIN PRIVATE KEY` or
 * `iam.gserviceaccount.com` finds nothing, because neither string appears in
 * plaintext. The earlier check reported "not present" and was wrong.
 *
 * These tests therefore base64-DECODE every candidate blob before asserting,
 * which is the only way to detect this class of leak.
 */

const ROOT = path.resolve(import.meta.dir, '..');
const OUT_DIR = path.join(os.tmpdir(), 'signalgoat-leak-probe');

/** A structurally valid fake service account, base64-encoded like the real one. */
const FAKE_SERVICE_ACCOUNT = Buffer.from(
  JSON.stringify({
    type: 'service_account',
    project_id: 'leak-probe',
    private_key: '-----BEGIN PRIVATE KEY-----\nLEAKPROBECANARY\n-----END PRIVATE KEY-----\n',
    client_email: 'probe@leak-probe.iam.gserviceaccount.com',
  }),
).toString('base64');

const PROBE_VALUES = {
  FIREBASE_apiKey: 'AIzaSyLEAKPROBEKEY',
  FIREBASE_authDomain: 'leak-probe.firebaseapp.com',
  FIREBASE_projectId: 'leak-probe',
  FIREBASE_storageBucket: 'leak-probe.appspot.com',
  FIREBASE_messagingSenderId: '1234567890',
  FIREBASE_appId: '1:1234567890:web:leakprobe',
  FIREBASE_measurementId: 'G-LEAKPROBE',
};

/** Runs a real `vite build` with the full simulated Vercel environment. */
function buildBundle(): string {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });

  const result = spawnSync(
    'npx',
    ['vite', 'build', '--outDir', OUT_DIR, '--emptyOutDir'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...PROBE_VALUES,
        // The two secrets that must never reach the browser.
        FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: FAKE_SERVICE_ACCOUNT,
        FIREBASE_SERVICE_ACCOUNT_JSON: FAKE_SERVICE_ACCOUNT,
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(`vite build failed: ${result.stderr ?? result.stdout}`);
  }

  const assets = path.join(OUT_DIR, 'assets');
  const js = fs.readdirSync(assets).filter((f) => f.endsWith('.js'));
  if (js.length === 0) throw new Error('no JS bundle produced');

  return js.map((f) => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n');
}

/** Base64-DECODES every blob in the bundle and searches the decoded text. */
function searchBundleDecodingBase64(bundle: string, needles: string[]): string[] {
  const found: string[] = [];

  for (const match of bundle.matchAll(/[A-Za-z0-9+/]{60,}={0,2}/g)) {
    const candidate = match[0];
    let decoded: string;
    try {
      decoded = Buffer.from(
        candidate + '='.repeat((4 - (candidate.length % 4)) % 4),
        'base64',
      ).toString('utf8');
    } catch {
      continue;
    }
    for (const needle of needles) {
      if (decoded.includes(needle)) found.push(`${needle} (base64)`);
    }
  }

  return found;
}

describe('client bundle does not leak server credentials', () => {
  const bundle = buildBundle();

  test('the private key is absent in plaintext', () => {
    expect(bundle).not.toContain('BEGIN PRIVATE KEY');
    expect(bundle).not.toContain('LEAKPROBECANARY');
    expect(bundle).not.toContain('iam.gserviceaccount.com');
  });

  /**
   * The check that would have caught the real incident. A plaintext grep
   * passes on a base64-encoded secret, so decoding is mandatory.
   */
  test('the private key is absent after base64-decoding every blob', () => {
    const leaks = searchBundleDecodingBase64(bundle, [
      'BEGIN PRIVATE KEY',
      'LEAKPROBECANARY',
      'service_account',
      'iam.gserviceaccount.com',
    ]);

    expect(leaks).toEqual([]);
  });

  test('the raw base64 secret itself is absent too', () => {
    expect(bundle).not.toContain(FAKE_SERVICE_ACCOUNT);
  });

  test('every public Firebase value IS present, so the fix did not just disable config', () => {
    for (const value of Object.values(PROBE_VALUES)) {
      expect(bundle).toContain(value);
    }
  });
});

describe('vite client env configuration', () => {
  test('envPrefix exposes VITE_ only, never FIREBASE_', async () => {
    const source = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');

    // The allow-list mapping must name exactly the seven public values.
    for (const name of Object.keys(PROBE_VALUES)) {
      expect(source).toContain(name);
    }

    /**
     * Match the ACTUAL config line, not the prose that documents why it is
     * narrow — comments and JSDoc legitimately mention `envPrefix: ['FIREBASE_']`
     * as the mistake being avoided, and matching those produced a false failure.
     */
    expect(source).not.toMatch(/^\s*envPrefix:\s*\[[^\]]*FIREBASE_/m);
    expect(source).toMatch(/^\s*envPrefix:\s*'VITE_',/m);
  });

  test('the client env type declares no FIREBASE_* variable', () => {
    const types = fs.readFileSync(path.join(ROOT, 'src/vite-env.d.ts'), 'utf8');
    const declarations = types
      .split('\n')
      .filter((line) => line.includes('readonly'))
      .map((line) => line.trim());

    expect(declarations.length).toBeGreaterThan(0);
    for (const line of declarations) {
      expect(line).not.toMatch(/readonly\s+FIREBASE_/);
      expect(line).not.toMatch(/SERVICE_ACCOUNT/);
    }
  });
});