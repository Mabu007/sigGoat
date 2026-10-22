import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

/**
 * THE ROBOT MARKETPLACE INTERFACE
 * ================================
 *
 * Structural assertions over the source, in the same spirit as
 * `tests/ui.test.ts`: there is no DOM test environment in this repository,
 * and adding one to assert class names would change the dependency surface
 * for very little coverage.
 *
 * What is pinned here is the set of things a redesign would silently break:
 * the hero card coming back, a control that stops working, a layout that
 * overflows a 320 pixel phone, the cover art turning back into a gradient,
 * and the strategy engine losing an indicator.
 */

const ROOT = path.join(import.meta.dir, '..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const VIEW = 'src/components/views/TradingRobotsView.tsx';
const CARD = 'src/components/strategy/RobotCard.tsx';
const SHEET = 'src/components/strategy/RobotSheet.tsx';
const BROKER = 'src/components/strategy/BrokerConnections.tsx';
const ARTWORK = 'src/components/strategy/DefaultRobotCover.tsx';
const PICKER = 'src/components/RoomCoverPicker.tsx';
const BUILDER = 'src/components/strategy/StrategyBuilder.tsx';

/* ------------------------------------------------------------------ */
/* The hero card                                                       */
/* ------------------------------------------------------------------ */

describe('the directory header', () => {
  test('the marketplace introduction card is gone', () => {
    const source = read(VIEW);
    expect(source).not.toContain('Create a strategy. Backtest it. Deploy your robot.');
    expect(source).not.toContain('Rule-based robots run in paper mode in this browser today');
    expect(source).not.toContain('Robot Marketplace');
  });

  test('the directory is one bot feed with no category filters', () => {
    const source = read(VIEW);
    expect(source).toContain('Explore trading bots');
    expect(source).toContain('Create bot');
    expect(source).not.toContain('Public Robots');
    expect(source).not.toContain('My Robots');
    expect(source).toContain('<RobotCard');
  });
});

describe('the professional robot studio', () => {
  test('strategy context is defined with conditions and market binding happens at deployment', () => {
    const source = read(BUILDER);
    expect(source).toContain('Signal context');
    expect(source).toContain('Condition timeframe');
    expect(source).toContain('Position intent');
    expect(source).toContain('Deployment profile');
    expect(source).toContain('Deployment instrument');
    expect(source).toContain('Validate & deploy robot');
  });
});

/* ------------------------------------------------------------------ */
/* The card                                                            */
/* ------------------------------------------------------------------ */

describe('the robot card', () => {
  test('it has a YouTube-style widescreen cover with rounded corners', () => {
    const source = read(CARD);
    expect(source).toContain('aspect-video');
    expect(source).toContain('rounded-2xl');
    expect(source).toContain('overflow-hidden');
  });

  test('it uses an uploaded image when there is one, and drawn artwork when there is not', () => {
    const source = read(CARD);
    expect(source).toContain('<img');
    expect(source).toContain('loading="lazy"');
    expect(source).toContain('decoding="async"');
    expect(source).toContain('object-cover');
    expect(source).toContain('DefaultRobotCover');
    // A broken image falls back to the artwork rather than an empty frame.
    expect(source).toContain('onError');
  });

  test('the title and description stay readable over the cover', () => {
    const source = read(CARD);
    expect(source).toContain('bg-gradient-to-t');
    expect(source).toContain('robot.name');
    expect(source).toContain('robot.description');
  });

  test('the thumbnail opens the robot workspace', () => {
    const source = read(CARD);
    expect(source).toContain('onClick={onOpen}');
    expect(source).toContain('aria-label={`Open ${robot.name}`}');
  });

  test('the workspace has PAIRS, TRADE and BACKTEST controls', () => {
    const source = read(VIEW);
    expect(source).toContain('Choose an asset');
    expect(source).toContain("<span>PAIRS</span>");
    expect(source).toContain("<span>BACKTEST</span>");
    expect(source).toContain("running?'STOP':'TRADE'");
  });
});

/* ------------------------------------------------------------------ */
/* The default artwork                                                 */
/* ------------------------------------------------------------------ */

describe('the default cover artwork', () => {
  test('it is drawn, not a gradient', () => {
    const source = read(ARTWORK);
    expect(source).toContain('<svg');
    expect(source).toContain('viewBox="0 0 400 500"');
    expect(source).toContain('<path');
    expect(source).toContain('<circle');
    // It is a portrait that matches the card.
    expect(source).toContain('preserveAspectRatio="xMidYMid slice"');
  });

  test('two robots never get the same artwork', () => {
    const source = read(ARTWORK);
    expect(source).toContain('seedFrom');
    expect(source).toContain('PALETTES');
  });
});

/* ------------------------------------------------------------------ */
/* The sheet                                                           */
/* ------------------------------------------------------------------ */

describe('the robot sheet', () => {
  test('it answers the three questions the controls ask', () => {
    const source = read(SHEET);
    expect(source).toContain('function PairsView');
    expect(source).toContain('function TradeView');
    expect(source).toContain('function InfoView');
  });

  test('the instruments and the timeframe are real data, not placeholders', () => {
    const source = read(SHEET);
    expect(source).toContain('definition.market.instrument');
    expect(source).toContain('definition.market.timeframe');
  });

  test('historical, paper and live performance are separated', () => {
    const source = read(SHEET);
    expect(source).toContain('Historical backtest');
    expect(source).toContain('Paper trading');
    expect(source).toContain('Live trading');
    expect(source).toContain('Not available in this build');
  });

  test('it is a bottom sheet on a phone and a dialog on a larger screen', () => {
    const source = read(SHEET);
    expect(source).toContain('items-end');
    expect(source).toContain('sm:items-center');
    expect(source).toContain('rounded-t-2xl');
    expect(source).toContain('sm:rounded-2xl');
  });

  test('it closes on Escape', () => {
    const source = read(SHEET);
    expect(source).toContain("event.key === 'Escape'");
  });
});

/* ------------------------------------------------------------------ */
/* The broker connections                                              */
/* ------------------------------------------------------------------ */

describe('the broker connections', () => {
  test('the paper boundary is the first thing it says', () => {
    const source = read(BROKER);
    const boundary = source.indexOf('execution.message');
    const accounts = source.indexOf('state.cTrader.accounts');
    expect(boundary).toBeGreaterThan(-1);
    expect(boundary).toBeLessThan(accounts);
  });

  test('it uses cTrader OAuth and a separate PropDAO key for each robot', () => {
    const source = read(BROKER);
    expect(source).toContain("'/api/ctrader/connect'");
    expect(source).toContain('/broker/propdao-key');
    expect(source).toContain('apiKey: key');
  });

  test('the key is never read back and is cleared once it is saved', () => {
    const source = read(BROKER);
    expect(source).toContain("setPropDaoKey('')");
    expect(source).toContain("type=\"password\"");
  });

  test('the binding is made through the robot endpoint, not the local state', () => {
    const source = read(BROKER);
    expect(source).toContain('/broker');
    expect(source).toContain("bind('ctrader'");
    expect(source).toContain("bind('propdao'");
  });
});

/* ------------------------------------------------------------------ */
/* Mobile                                                              */
/* ------------------------------------------------------------------ */

describe('the mobile layout', () => {
  test('the directory is one column on a phone and a grid above it', () => {
    const source = read(VIEW);
    expect(source).toContain('grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3');
  });

  test('nothing in the card or the sheet sets a fixed width that could overflow', () => {
    for (const file of [CARD, SHEET, BROKER]) {
      const source = read(file);
      // A fixed pixel width on a container is what produces a horizontal
      // scrollbar on a 320 pixel phone.
      expect(source, `${file} sets a fixed width`).not.toMatch(/w-\[\d{3,}px\]/);
      expect(source, `${file} sets a fixed min width`).not.toMatch(/min-w-\[\d{3,}px\]/);
    }
  });

  test('the only fixed width in the workspace is a table inside its own scroll box', () => {
    const source = read(VIEW);
    // The trade table is wider than a phone, so it scrolls INSIDE the panel
    // rather than pushing the page sideways.
    expect(source).toContain('min-w-[420px]');
    expect(source).toContain('max-h-80 overflow-auto');
  });

  test('the workspace becomes a persistent app navigation on a phone', () => {
    const view = read(VIEW);
    const styles = read('src/components/views/robot-workspace.css');
    expect(view).toContain('robot-mobile-nav');
    expect(styles).toContain('position:fixed');
    expect(styles).toContain('grid-template-columns:repeat(4,1fr)');
  });

  test('the backtest table scrolls inside its own box', () => {
    const source = read(VIEW);
    expect(source).toContain('max-h-80 overflow-auto');
    expect(source).toContain('min-w-[420px]');
  });

  test('a robot cover lives in the key namespace the deployed Worker accepts', () => {
    const signer = read('src/server/media/mediaSigner.ts');
    // The realtime Worker is deployed by hand, so a new prefix would mean
    // the upload fails in production until somebody redeploys it. A robot
    // cover therefore lives in the folder the Worker already accepts.
    expect(signer).toContain('input.purpose === "avatar" ? "avatars" : "covers"');
    expect(signer).not.toContain('"robots"');
  });

  test('the cover preview uses the real portrait ratio', () => {
    const source = read(PICKER);
    expect(source).toContain("aspect === 'portrait'");
    expect(source).toContain('aspect-[4/5]');
  });

  test('the workspace panels stack on a phone', () => {
    const styles = read('src/components/views/robot-workspace.css');
    expect(styles).toContain('.robot-panels{grid-template-columns:1fr}');
    expect(styles).toContain('.robot-modal-bg{align-items:flex-end');
  });
});

/* ------------------------------------------------------------------ */
/* The strategy engine is preserved                                    */
/* ------------------------------------------------------------------ */

describe('the strategy engine is preserved', () => {
  test('all 53 indicators are still in the catalog', () => {
    const source = read('src/services/strategy/indicators/catalog.ts');
    const keys = source.match(/^\s+key: '[A-Z0-9]+',$/gm)?.length ?? 0;
    expect(keys).toBe(53);
  });

  test('the builder still has the indicator picker, the condition editor and the price-action fields', () => {
    const builder = read(BUILDER);
    expect(builder).toContain('IndicatorPicker');
    expect(builder).toContain('ConditionEditor');
    const editor = read('src/components/strategy/ConditionEditor.tsx');
    expect(editor).toContain('PriceActionFields');
  });

  test('the schema is still version 2 with its migration', () => {
    const source = read('src/services/strategy/schema.ts');
    expect(source).toContain('STRATEGY_SCHEMA_VERSION = 3');
    expect(source).toContain('migrateStrategyDefinition');
  });
});
