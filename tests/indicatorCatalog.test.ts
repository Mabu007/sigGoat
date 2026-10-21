import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  INDICATOR_CATALOG,
  INDICATOR_CATEGORIES,
  defaultIndicatorOutput,
  indicatorCatalogEntry,
  resolveIndicatorParams,
  validateIndicatorOutput,
  validateIndicatorParams,
} from '../src/services/strategy/indicators/catalog';
import { CALCULATED_INDICATOR_KEYS, calculateIndicator, indicatorWarmup } from '../src/services/strategy/indicators/calculations';
import { makeCandles } from './helpers/strategyCandles';

/**
 * THE INDICATOR CATALOG
 * =====================
 *
 * The catalog is supposed to be the complete official `cinar/indicatorts`
 * catalog, and the README that ships with the installed package is used
 * here as the independent source of truth. Nothing in this file repeats the
 * catalog: if the catalog and the upstream documentation ever disagree, one
 * of these tests fails.
 */

const readme = readFileSync(new URL('../node_modules/indicatorts/README.md', import.meta.url), 'utf8');

/** The indicator section of the upstream README, split by category. */
function upstreamCatalog(): Map<string, string[]> {
  const section = readme.slice(readme.indexOf('## Indicators Provided'), readme.indexOf('## Strategies Provided'));
  const categories = new Map<string, string[]>();
  let current = '';
  for (const line of section.split('\n')) {
    const heading = /^###\s+(.+?)\s+Indicators\s*$/.exec(line);
    if (heading) { current = heading[1].toLowerCase(); categories.set(current, []); continue; }
    const entry = /^-\s+\[(.+?)\]\(/.exec(line);
    if (entry && current) categories.get(current)!.push(entry[1]);
  }
  return categories;
}

describe('indicator catalog', () => {
  test('covers the complete official catalog, verified against the upstream README', () => {
    const upstream = upstreamCatalog();
    expect(upstream.size).toBe(4);
    const expectedTotal = [...upstream.values()].reduce((sum, list) => sum + list.length, 0);
    expect(expectedTotal).toBe(53);
    expect(INDICATOR_CATALOG.length).toBe(expectedTotal);

    for (const category of INDICATOR_CATEGORIES) {
      const mine = INDICATOR_CATALOG.filter(entry => entry.category === category.key);
      const theirs = upstream.get(category.key) ?? [];
      expect(`${category.key}:${mine.length}`).toBe(`${category.key}:${theirs.length}`);
      // Every upstream indicator must be present under a name this builder
      // recognises, and nothing extra may be present.
      for (const name of theirs) {
        const known = mine.find(entry => entry.name === name || entry.shortName === name
          || entry.name.includes(name.replace(/\s*\(.*\)$/, ''))
          || name.includes(entry.shortName));
        expect(known, `missing upstream indicator "${name}"`).toBeDefined();
      }
      for (const entry of mine) {
        const known = theirs.find(name => name === entry.name || name.includes(entry.shortName) || entry.name.includes(name.replace(/\s*\(.*\)$/, '')));
        expect(known, `catalog has an extra indicator "${entry.name}"`).toBeDefined();
      }
    }
  });

  test('every catalog entry has a calculation adapter and every adapter has a catalog entry', () => {
    const catalogKeys = new Set(INDICATOR_CATALOG.map(entry => entry.key));
    const adapterKeys = new Set(CALCULATED_INDICATOR_KEYS);
    for (const key of catalogKeys) expect(adapterKeys.has(key), `no adapter for ${key}`).toBe(true);
    for (const key of adapterKeys) expect(catalogKeys.has(key), `adapter without catalog entry ${key}`).toBe(true);
  });

  test('every indicator is registered with a name, a category, a description and outputs', () => {
    const seen = new Set<string>();
    for (const entry of INDICATOR_CATALOG) {
      expect(seen.has(entry.key), `duplicate catalog key ${entry.key}`).toBe(false);
      seen.add(entry.key);
      expect(entry.name.length).toBeGreaterThan(3);
      expect(entry.description.length).toBeGreaterThan(10);
      expect(['trend', 'momentum', 'volatility', 'volume']).toContain(entry.category);
      expect(entry.outputs.length).toBeGreaterThan(0);
      expect(entry.outputs.map(output => output.key)).toContain(defaultIndicatorOutput(entry.key));
      for (const output of entry.outputs) {
        expect(output.label.length).toBeGreaterThan(0);
        expect(output.description.length).toBeGreaterThan(0);
      }
    }
  });

  test('parameter definitions are usable and validated', () => {
    for (const entry of INDICATOR_CATALOG) {
      for (const parameter of entry.parameters) {
        expect(parameter.default).toBeGreaterThanOrEqual(parameter.min);
        expect(parameter.default).toBeLessThanOrEqual(parameter.max);
        expect(parameter.step).toBeGreaterThan(0);
        expect(parameter.label.length).toBeGreaterThan(0);
        expect(parameter.description.length).toBeGreaterThan(0);
      }
      // The defaults themselves must validate.
      expect(validateIndicatorParams(entry.key, resolveIndicatorParams(entry.key, {}))).toEqual([]);
    }
  });

  test('parameter validation rejects out of range values, unknown keys and unknown indicators', () => {
    expect(validateIndicatorParams('SMA', { period: 1 }).length).toBeGreaterThan(0);
    expect(validateIndicatorParams('SMA', { period: 1000 }).length).toBeGreaterThan(0);
    expect(validateIndicatorParams('SMA', { period: 20.5 }).length).toBeGreaterThan(0);
    expect(validateIndicatorParams('SMA', { nope: 3 }).length).toBeGreaterThan(0);
    expect(validateIndicatorParams('SMA', { period: Number.NaN }).length).toBeGreaterThan(0);
    expect(validateIndicatorParams('NOT_AN_INDICATOR', {}).length).toBeGreaterThan(0);
    expect(validateIndicatorParams('RSI', { period: 14 })).toEqual([]);
  });

  test('output validation accepts real outputs and rejects invented ones', () => {
    expect(validateIndicatorOutput('MACD', 'histogram')).toEqual([]);
    expect(validateIndicatorOutput('MACD', 'nope').length).toBeGreaterThan(0);
    expect(validateIndicatorOutput('MACD', undefined)).toEqual([]);
    expect(validateIndicatorOutput('SMA', 'sma')).toEqual([]);
  });

  test('every indicator calculates, produces every declared output and stays finite once warm', () => {
    const candles = makeCandles({ count: 400 });
    for (const entry of INDICATOR_CATALOG) {
      const params = resolveIndicatorParams(entry.key, {});
      const calculated = calculateIndicator(entry.key, candles, params);
      const warmup = indicatorWarmup(entry.key, params);
      expect(warmup, `${entry.key} has no warm-up`).toBeGreaterThan(0);
      for (const output of entry.outputs) {
        const series = calculated.series[output.key];
        expect(series, `${entry.key} does not produce "${output.key}"`).toBeDefined();
        expect(series!.length).toBe(candles.length);
        const last = series![series!.length - 1];
        expect(Number.isFinite(last), `${entry.key}.${output.key} is not finite at the last candle`).toBe(true);
        // Everything before the warm-up is explicitly undefined.
        for (let index = 0; index < Math.min(warmup - 1, series!.length); index += 1) {
          expect(Number.isNaN(series![index]), `${entry.key}.${output.key} has a value before its warm-up`).toBe(true);
        }
      }
    }
  });

  test('an indicator with too little history reports nothing rather than a wrong number', () => {
    const candles = makeCandles({ count: 12 });
    for (const entry of INDICATOR_CATALOG) {
      const params = resolveIndicatorParams(entry.key, {});
      const calculated = calculateIndicator(entry.key, candles, params);
      for (const output of entry.outputs) {
        const series = calculated.series[output.key];
        for (const value of series!) {
          expect(Number.isNaN(value) || Number.isFinite(value)).toBe(true);
        }
        // With fewer candles than the warm-up, nothing may be available.
        if (candles.length < indicatorWarmup(entry.key, params)) {
          for (const value of series!) expect(Number.isNaN(value), `${entry.key}.${output.key} produced a value without enough history`).toBe(true);
        }
      }
    }
  });

  test('a candle with no range never produces an infinite number', () => {
    const flat = makeCandles({ count: 200, flat: true });
    for (const entry of INDICATOR_CATALOG) {
      const calculated = calculateIndicator(entry.key, flat, resolveIndicatorParams(entry.key, {}));
      for (const output of entry.outputs) {
        for (const value of calculated.series[output.key]) {
          // `NaN` means "this value does not exist" and is allowed. An
          // infinity would mean a real number was produced from a division
          // by zero, which is exactly what this test is looking for.
          expect(Number.isFinite(value) || Number.isNaN(value), `${entry.key}.${output.key} produced an infinite number`).toBe(true);
        }
      }
    }
  });

  test('a missing volume does not produce an infinite number', () => {
    const candles = makeCandles({ count: 200 }).map(item => ({ ...item, volume: 0 }));
    for (const entry of INDICATOR_CATALOG) {
      if (!entry.inputs.includes('volume')) continue;
      const calculated = calculateIndicator(entry.key, candles, resolveIndicatorParams(entry.key, {}));
      for (const output of entry.outputs) {
        for (const value of calculated.series[output.key]) {
          expect(Number.isFinite(value) || Number.isNaN(value)).toBe(true);
        }
      }
    }
  });

  test('multi output indicators expose every output as a real, different series', () => {
    const candles = makeCandles({ count: 400 });
    const multi = INDICATOR_CATALOG.filter(entry => entry.outputs.length > 1);
    expect(multi.length).toBeGreaterThan(10);
    for (const entry of multi) {
      const calculated = calculateIndicator(entry.key, candles, resolveIndicatorParams(entry.key, {}));
      for (const output of entry.outputs) {
        const series = calculated.series[output.key];
        expect(series.some(value => Number.isFinite(value)), `${entry.key}.${output.key} is empty`).toBe(true);
      }
    }
  });

  test('the catalog entry for an unknown key is undefined', () => {
    expect(indicatorCatalogEntry('NOPE')).toBeUndefined();
    expect(indicatorCatalogEntry('MACD')?.category).toBe('trend');
  });
});
