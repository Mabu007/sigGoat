/**
 * UI: THEME, NAVIGATION AND BRAND
 *
 * These are static assertions over the source rather than rendered-DOM tests.
 * The properties being pinned are the ones a refactor would silently break:
 * a hard-coded colour that no longer themes, a navigation entry that
 * disappears, or the product name reappearing in user-visible copy.
 *
 * Deliberately NOT testing React rendering: there is no DOM test environment
 * configured in this repository, and adding one to assert class names would
 * change the project's dependency surface for very little additional
 * coverage — the behaviours that matter (theme persistence, no flash) are
 * verified structurally below.
 */

import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(import.meta.dir, '..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/**
 * Locates the dark PALETTE block.
 *
 * `:root[data-theme='dark']` also appears earlier in the file for
 * `color-scheme`, so the selector alone is not a usable slice boundary — the
 * comment on the next line is what distinguishes the palette.
 */
const DARK_PALETTE_START = ":root[data-theme='dark'] {\n    /* Surfaces step DOWN";

const VIEW_FILES = fs
  .readdirSync(path.join(ROOT, 'src/components/views'))
  .map((file) => path.join('src/components/views', file))
  .concat(['src/components/Header.tsx', 'src/components/Navigation.tsx', 'src/components/AuthGate.tsx']);

/* ------------------------------------------------------------------ */
/* Brand                                                               */
/* ------------------------------------------------------------------ */

describe('product identity', () => {
  test('the document title and metadata are FundAGoat', () => {
    const html = read('index.html');
    expect(html).toContain('<title>FundAGoat');
    expect(html).not.toContain('SignalGOAT');
  });

  test('no source file renders the retired product name', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const relative = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(relative);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          // This file necessarily contains the string it searches for.
          if (relative.endsWith('ui.test.ts')) continue;
          if (/\bSignalGOAT\b/.test(read(relative))) offenders.push(relative);
        }
      }
    };
    walk('src');
    walk('tests');
    expect(offenders).toEqual([]);
  });

  test('the wordmark renders FundAGoat', () => {
    const navigation = read('src/components/Navigation.tsx');
    expect(navigation).toContain('Fund');
    expect(navigation).toContain('AGoat');
  });

  test('Telegram copy uses the new name', () => {
    const telegram = read('src/services/telegram/TelegramService.ts');
    expect(telegram).toContain('FundAGoat');
    expect(telegram).not.toContain('SignalGOAT');
  });
});

/* ------------------------------------------------------------------ */
/* Theme system                                                        */
/* ------------------------------------------------------------------ */

describe('theme system', () => {
  test('BOTH themes define every token the components consume', () => {
    const css = read('src/index.css');

    // Every token referenced by a Tailwind class must be defined in BOTH the
    // light `:root` block and the dark `:root[data-theme='dark']` block.
    // A token defined in only one is a hard-coded colour waiting to happen.
    const tokens = [
      'canvas', 'surface', 'raised', 'sunken',
      'line', 'line-strong',
      'fg', 'fg-muted', 'fg-subtle', 'fg-inverse',
      'accent', 'accent-hover', 'accent-soft', 'accent-fg', 'accent-text',
      'positive', 'positive-soft',
      'negative', 'negative-soft',
      'warning', 'warning-soft',
      'info', 'info-soft',
      'focus',
    ];

    // `:root[data-theme='dark']` also appears in the earlier color-scheme
    // block, so the palette is located by its first token, not the selector.
    const lightBlock = css.slice(css.indexOf('@theme {'), css.indexOf(DARK_PALETTE_START));
    const darkBlock = css.slice(
      css.indexOf(DARK_PALETTE_START),
      css.indexOf('/* Accent used for TEXT'),
    );

    for (const token of tokens) {
      // accent-text lives in its own per-theme block by design.
      if (token === 'accent-text') continue;
      expect(lightBlock).toContain(`--color-${token}:`);
      expect(darkBlock).toContain(`--color-${token}:`);
    }
    expect(css).toContain('--color-accent-text: #92400e;');
    expect(css).toContain('--color-accent-text: #fbbf24;');
  });

  test('the two themes are designed, not inverted', () => {
    const css = read('src/index.css');
    const darkBlock = css.slice(
      css.indexOf(DARK_PALETTE_START),
      css.indexOf('/* Accent used for TEXT'),
    );

    // A dark theme that is a copy of the light one with the hues rotated would
    // still satisfy "both tokens exist". These assert the dark palette is
    // genuinely different: darker surfaces, lighter foregrounds.
    expect(darkBlock).toContain('--color-canvas: #0a0c11;');
    expect(darkBlock).toContain('--color-fg: #eef1f6;');

    const lightBlock = css.slice(css.indexOf('@theme {'), css.indexOf(DARK_PALETTE_START));
    expect(lightBlock).toContain('--color-canvas: #f7f8fa;');
    expect(lightBlock).toContain('--color-fg: #10131a;');
  });

  test('both themes declare color-scheme, so form controls match', () => {
    const css = read('src/index.css');
    expect(css).toContain(':root {\n    color-scheme: light;');
    expect(css).toContain("color-scheme: dark;");
  });

  test('the pre-paint script sets the theme before the bundle loads', () => {
    const html = read('index.html');

    // The script must appear in <head> and BEFORE the module script, or the
    // first paint uses the wrong theme.
    const scriptIndex = html.indexOf("localStorage.getItem('fundagoat.theme')");
    const moduleIndex = html.indexOf('type="module"');

    expect(scriptIndex).toBeGreaterThan(-1);
    expect(moduleIndex).toBeGreaterThan(-1);
    expect(scriptIndex).toBeLessThan(moduleIndex);
    // And inside <head>, not deferred to the body.
    expect(scriptIndex).toBeLessThan(html.indexOf('</head>'));
  });

  test('the document declares a default theme on <html>', () => {
    expect(read('index.html')).toContain('data-theme="light"');
  });

  test('the pre-paint script handles unavailable storage', () => {
    const script = read('index.html').slice(
      read('index.html').indexOf("localStorage.getItem('fundagoat.theme')"),
    );
    // Private browsing throws on localStorage access; an uncaught throw here
    // would abort the rest of the inline script.
    expect(script.slice(0, 400)).toContain('catch');
  });

  test('the theme provider is mounted ABOVE auth and data providers', () => {
    const app = read('src/App.tsx');
    const themeIndex = app.indexOf('<ThemeProvider>');
    const authIndex = app.indexOf('<AuthProvider>');
    expect(themeIndex).toBeGreaterThan(-1);
    expect(themeIndex).toBeLessThan(authIndex);
  });

  test('the provider reads the applied theme rather than deciding on render', () => {
    const context = read('src/context/ThemeContext.tsx');
    // Reading documentElement is what avoids a first-render correction.
    expect(context).toContain("document.documentElement.getAttribute('data-theme')");
  });

  test('useTheme throws outside a provider rather than defaulting', () => {
    const context = read('src/context/ThemeContext.tsx');
    expect(context).toContain('must be used inside a <ThemeProvider>');
  });

  test('a theme toggle exists in the header', () => {
    const header = read('src/components/Header.tsx');
    expect(header).toContain('ThemeToggle');
    const toggle = read('src/components/ThemeToggle.tsx');
    // The label names the ACTION, not the current state.
    expect(toggle).toContain("'Switch to light theme'");
    expect(toggle).toContain("'Switch to dark theme'");
    expect(toggle).toContain('aria-pressed');
  });
});

/* ------------------------------------------------------------------ */
/* Token discipline                                                    */
/* ------------------------------------------------------------------ */

describe('theme correctness (compiled output)', () => {
  /**
   * THE REGRESSION THIS CATCHES
   *
   * The stylesheet used `@theme inline`, which makes Tailwind inline the
   * LITERAL value into each utility:
   *
   *     .bg-surface { background-color: #fff }
   *
   * The CSS variables were still emitted, and `data-theme="dark"` still
   * activated the dark block — but no utility referenced them, so the toggle
   * changed almost nothing on screen. Only elements using a raw
   * `var(--color-*)` responded.
   *
   * Asserting on the COMPILED bundle is the only place this is observable:
   * the source reads correctly either way.
   */
  const builtCss = (() => {
    const dir = path.join(ROOT, 'dist/assets');
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
    if (files.length === 0) return null;
    const newest = files
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0].f;
    return fs.readFileSync(path.join(dir, newest), 'utf8');
  })();

  test.skipIf(builtCss === null)('theme utilities reference CSS variables, not baked hex', () => {
    const css = builtCss!;
    // Every semantic utility must compile to a var() reference.
    for (const utility of ['bg-surface', 'bg-canvas', 'text-fg', 'text-fg-muted', 'border-line']) {
      const match = new RegExp(`\\.${utility}\\{([^}]*)\\}`).exec(css);
      if (!match) continue; // utility unused in this build
      expect(match[1]).toContain('var(--color-');
    }
  });

  test.skipIf(builtCss === null)('no utility bakes a literal colour', () => {
    const css = builtCss!;
    // `.bg-surface{background-color:#fff}` is the exact failure mode.
    const baked = /\.bg-surface\{[^}]*#[0-9a-f]{3,8}/i.exec(css);
    expect(baked).toBeNull();
  });

  test.skipIf(builtCss === null)('the dark theme overrides every light value', () => {
    const css = builtCss!;
    const darkBlock = css.slice(css.indexOf("data-theme=dark]"));
    for (const token of ['canvas', 'surface', 'fg', 'line', 'positive', 'negative', 'accent']) {
      expect(darkBlock).toContain(`--color-${token}:`);
    }
  });

  test.skipIf(builtCss === null)('dark theme has sufficient contrast on key surfaces', () => {
    const css = builtCss!;
    const dark = css.slice(css.indexOf('data-theme=dark]'));
    const read = (name: string) => {
      const m = new RegExp(`--color-${name}` + String.raw`:\s*#([0-9a-fA-F]{6})`).exec(dark);
      return m ? m[1] : null;
    };
    const luminance = (hex: string) => {
      const ch = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    const canvas = read('canvas');
    const fg = read('fg');
    const muted = read('fg-muted');
    expect(canvas && fg).not.toBeNull();

    // Body text on the page background must clear WCAG AA (4.5:1).
    expect(ratio(fg!, canvas!)).toBeGreaterThanOrEqual(4.5);
    // Secondary text clears the AA large-text threshold (3:1).
    expect(ratio(muted!, canvas!)).toBeGreaterThanOrEqual(3);
  });

  test.skipIf(builtCss === null)('light theme has sufficient contrast on key surfaces', () => {
    const css = builtCss!;
    const darkStart = css.indexOf("data-theme=dark]");
    const light = css.slice(0, darkStart);
    expect(darkStart).toBeGreaterThan(0);
    const read = (name: string) => {
      const m = new RegExp(`--color-${name}` + String.raw`:\s*#([0-9a-fA-F]{6})`).exec(light);
      return m ? m[1] : null;
    };
    const luminance = (hex: string) => {
      const ch = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    const canvas = read('canvas');
    const fg = read('fg');
    expect(canvas && fg).not.toBeNull();
    expect(ratio(fg!, canvas!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('design tokens', () => {
  test('no component hard-codes a near-black or hex surface colour', () => {
    // The previous build used ~50 arbitrary hex values that no `dark:`
    // variant could flip. Any reappearance is a hard regression.
    const hexPattern = /#(?:0[0-9a-f]|1[0-9a-f]|2[0-9a-f])[0-9a-f]{4}\b/i;
    const offenders: string[] = [];

    for (const file of VIEW_FILES) {
      const contents = read(file);
      contents.split('\n').forEach((line, index) => {
        // Comments explaining the migration may mention the old values.
        const code = line.replace(/\/\/.*$/, '').replace(/\*.*$/, '');
        if (hexPattern.test(code)) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('no component uses a raw slate/amber/emerald/rose palette class', () => {
    // The semantic tokens replace them. A leftover means an unthemed surface.
    const offenders: string[] = [];
    for (const file of VIEW_FILES) {
      const contents = read(file);
      if (/(?:bg|text|border|from|to|ring)-(?:slate|amber|emerald|rose|sky)-\d{2,3}/.test(contents)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the chart reads its colours from the CSS tokens', () => {
    const chart = read('src/components/TradingViewLightweightChart.tsx');
    // A canvas cannot inherit CSS, so it must read the tokens explicitly.
    expect(chart).toContain('getComputedStyle(document.documentElement)');
    expect(chart).toContain('useTheme');
    expect(chart).not.toContain("color: '#090c12'");
  });

  test('scrollbars are themed', () => {
    const css = read('src/index.css');
    expect(css).toContain('::-webkit-scrollbar-thumb');
    expect(css).toContain('var(--color-line-strong)');
  });

  test('focus is visible and theme-aware', () => {
    const css = read('src/index.css');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('var(--color-focus)');
  });

  test('reduced motion is respected', () => {
    const css = read('src/index.css');
    expect(css).toContain('prefers-reduced-motion');
  });
});

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

describe('navigation', () => {
  /**
   * The mandated product sections. `Overview` was removed deliberately — it
   * duplicated data the other tabs show and rendered little of its own — and
   * `overview` now redirects to Markets at the router level.
   */
  test('offers the product sections, and no Overview tab', () => {
    const navigation = read('src/components/Navigation.tsx');
    for (const label of ['Markets', 'Goats', 'Proposals', 'Backtest', 'Settings']) {
      expect(navigation).toContain(`'${label}'`);
    }
    expect(navigation).not.toContain("'Overview'");
  });

  test('marks the active item for assistive technology', () => {
    const navigation = read('src/components/Navigation.tsx');
    // Colour alone is not an accessible active indicator.
    expect(navigation).toContain("aria-current={active ? 'page' : undefined}");
    expect(navigation).toContain('aria-label="Main"');
  });

  test('the mobile bar clears the device safe area', () => {
    const navigation = read('src/components/Navigation.tsx');
    expect(navigation).toContain('safe-area-inset-bottom');
  });

  test('the mobile bar fits five destinations', () => {
    const navigation = read('src/components/Navigation.tsx');
    expect(navigation).toContain('grid-cols-5');
  });

  test('every destination is routed in App', () => {
    const app = read('src/App.tsx');
    for (const tab of ['markets', 'goats', 'proposals', 'backtest', 'settings']) {
      expect(app).toContain(`activeTab === '${tab}'`);
    }
    // The removed tab must not still be rendered.
    expect(app).not.toContain("activeTab === 'overview'");
  });

  test('a stale #overview hash redirects to Markets instead of a blank page', () => {
    const app = read('src/App.tsx');
    expect(app).toContain("raw === 'overview'");
  });

  test('the tab is deep-linkable through the URL hash', () => {
    const app = read('src/App.tsx');
    expect(app).toContain("window.location.hash");
    expect(app).toContain('hashchange');
  });
});

/* ------------------------------------------------------------------ */
/* Market truthfulness                                                 */
/* ------------------------------------------------------------------ */

describe('markets screen truthfulness', () => {
  test('does not offer categories the provider does not populate', () => {
    const quotes = read('src/components/views/QuotesView.tsx');
    // Category buttons are rendered from what discovery returned.
    expect(quotes).toContain('availableCategories');
    expect(quotes).toContain('present.has');
  });

  test('search reaches beyond the default tracked universe', () => {
    const quotes = read('src/components/views/QuotesView.tsx');
    expect(quotes).toContain('/api/markets/search');
  });

  test('renders an explicit "not available" instead of a zero', () => {
    const quotes = read('src/components/views/QuotesView.tsx');
    // Hyperliquid publishes no 24h high/low; the cell must say so.
    expect(quotes).toContain('Hyperliquid publishes no 24h high/low endpoint');
    expect(quotes).toContain('No 24h reference price');
  });

  test('the Overview screen is gone, and its route redirects rather than rendering empty', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/components/views/OverviewView.tsx'))).toBeFalse();
    const app = read('src/App.tsx');
    expect(app).not.toContain('OverviewView');
  });
});