import { describe, test, expect } from 'bun:test';
import { parseTelegramCommand } from '../src/services/telegram/TelegramCommands';

/**
 * Natural-language intents: "every 5 minutes", "stop", "analyse gold".
 *
 * Intent-first parsing turns free-text intent into typed commands BEFORE any
 * AI call, so the user can control the GOAT (cadence / pause / one-off
 * analysis) with ordinary sentences instead of remembering slash commands.
 */
describe('parseTelegramCommand (natural-language intents)', () => {
  test('parses "every N minutes" into a schedule intent', () => {
    expect(parseTelegramCommand('every 5 minutes')).toEqual({
      kind: 'intent',
      intent: { kind: 'schedule', minutes: 5 },
    });
    expect(parseTelegramCommand('every 5')).toEqual({
      kind: 'intent',
      intent: { kind: 'schedule', minutes: 5 },
    });
    expect(parseTelegramCommand('every 10m')).toEqual({
      kind: 'intent',
      intent: { kind: 'schedule', minutes: 10 },
    });
    expect(parseTelegramCommand('every 60 mins')).toEqual({
      kind: 'intent',
      intent: { kind: 'schedule', minutes: 60 },
    });
    // Floor at 5 minutes, per the contract.
    expect(parseTelegramCommand('every 2 minutes')).toEqual({
      kind: 'intent',
      intent: { kind: 'schedule', minutes: 5 },
    });
  });

  test('parses hourly / daily / weekly cadences', () => {
    expect(parseTelegramCommand('every hour')).toEqual({
      kind: 'intent',
      intent: { kind: 'schedule', minutes: 60 },
    });
    expect(parseTelegramCommand('every 2 hours')).toEqual({
      kind: 'intent',
      intent: { kind: 'schedule', minutes: 120 },
    });
    expect(parseTelegramCommand('every day')).toEqual({
      kind: 'intent',
      intent: { kind: 'schedule', minutes: 60 * 24 },
    });
    expect(parseTelegramCommand('every week')).toEqual({
      kind: 'intent',
      intent: { kind: 'schedule', minutes: 60 * 24 * 7 },
    });
  });

  test('parses analysis requests with and without a market', () => {
    expect(parseTelegramCommand('analyse gold')).toEqual({
      kind: 'intent',
      intent: { kind: 'analyse', market: 'gold' },
    });
    expect(parseTelegramCommand('analyse gold now')).toEqual({
      kind: 'intent',
      intent: { kind: 'analyse', market: 'gold' },
    });
    expect(parseTelegramCommand('analyze XLM:USD')).toEqual({
      kind: 'intent',
      intent: { kind: 'analyse', market: 'xlm:usd' },
    });
    // No market -> full GOAT re-evaluation on the default market.
    expect(parseTelegramCommand('analyse')).toEqual({
      kind: 'intent',
      intent: { kind: 'analyse' },
    });
    expect(parseTelegramCommand('analyze')).toEqual({
      kind: 'intent',
      intent: { kind: 'analyse' },
    });
  });

  test('parses stop / cancel', () => {
    expect(parseTelegramCommand('stop')).toEqual({
      kind: 'intent',
      intent: { kind: 'stop' },
    });
    expect(parseTelegramCommand('stop it')).toEqual({
      kind: 'intent',
      intent: { kind: 'stop' },
    });
    expect(parseTelegramCommand('cancel')).toEqual({
      kind: 'intent',
      intent: { kind: 'stop' },
    });
  });

  test('prioritises intents over chat, even for ambiguous phrases', () => {
    // "stop" would otherwise be a conversational question; intents own it.
    expect(parseTelegramCommand('stop now')).toEqual({
      kind: 'intent',
      intent: { kind: 'stop' },
    });
    // "what is gold" is not an intent (not analysing, not scheduling, not stopping)
    // -> conversational, routed to the AI gateway.
    expect(parseTelegramCommand('what is gold right now?')).toEqual({
      kind: 'chat',
      text: 'what is gold right now?',
    });
  });

  test('/schedule and /stop commands also resolve to the same intents', () => {
    expect(parseTelegramCommand('/schedule every 15 minutes')).toEqual({
      kind: 'intent',
      intent: { kind: 'schedule', minutes: 15 },
    });
    expect(parseTelegramCommand('/schedule daily')).toEqual({
      kind: 'intent',
      intent: { kind: 'schedule', minutes: 60 * 24 },
    });
    expect(parseTelegramCommand('/schedule hourly')).toEqual({
      kind: 'intent',
      intent: { kind: 'schedule', minutes: 60 },
    });
    expect(parseTelegramCommand('/schedule invalid')).toEqual({
      kind: 'unknown',
      command: '/schedule',
    });
    expect(parseTelegramCommand('/stop')).toEqual({
      kind: 'intent',
      intent: { kind: 'stop' },
    });
  });

  test('market lookup is case-insensitive and tolerant of slashes', () => {
    expect(parseTelegramCommand('analyse EUR/USD')).toEqual({
      kind: 'intent',
      intent: { kind: 'analyse', market: 'eur/usd' },
    });
  });

  test('a plain question stays conversational (costs an AI call) and never an intent', () => {
    expect(parseTelegramCommand('how is btc?')).toEqual({
      kind: 'chat',
      text: 'how is btc?',
    });
    expect(parseTelegramCommand('what is my bias on gold?')).toEqual({
      kind: 'chat',
      text: 'what is my bias on gold?',
    });
  });
});
