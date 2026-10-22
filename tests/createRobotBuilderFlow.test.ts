import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dir, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Create bot strategy flow', () => {
  test('the directory create action opens the validated visual strategy builder', () => {
    const view = read('src/components/views/TradingRobotsView.tsx');
    expect(view).toContain("import { StrategyBuilder, StrategySummary } from '../strategy/StrategyBuilder'");
    expect(view).toContain('createOpen&&<StrategyBuilder');
    expect(view).toContain('onCreated={s=>{setCreateOpen(false);open(s)}}');
  });

  test('the modal supports editing history and keeps internal ids out of user copy', () => {
    const builder = read('src/components/strategy/StrategyBuilder.tsx');
    expect(builder).toContain('aria-label="Undo last change"');
    expect(builder).toContain('aria-label="Redo last change"');
    expect(builder).toContain('Ctrl+Z');
    expect(builder).not.toContain('Internal reference {indicator.id}');
    expect(builder).toContain('validateStrategyDefinition(definition)');
  });
});
