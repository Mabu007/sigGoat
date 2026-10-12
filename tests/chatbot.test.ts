/**
 * CHATBOT PERSISTENCE AND REGRESSION GUARDS
 * ==========================================
 * The chatbot's defects were all user-visible, so each one is pinned here by
 * the behaviour it broke rather than by the line that implements it.
 */

import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

const chatbotPath = path.join(import.meta.dir, '..', 'src', 'components', 'Chatbot', 'Chatbot.tsx');
const routerPath = path.join(import.meta.dir, '..', 'src', 'server', 'apiRouter.ts');

const read = (p: string) => fs.readFileSync(p, 'utf8');

/**
 * Source WITHOUT comments.
 *
 * These are structural assertions over source text, and this file's own
 * prose names the exact APIs it forbids ("scrollIntoView walks up past the
 * container…", "`dangerouslySetInnerHTML` is disproportionate here"). Matching
 * raw source therefore passes on a comment describing the bug and fails on the
 * fix. Stripping comments first is what makes the assertion mean what it says.
 */
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('chat message persistence', () => {
  test("the user's turn is written to the store, not just the assistant's", () => {
    const source = readCode(routerPath);

    /**
     * Regression. Only the assistant's reply was persisted. The user's
     * message went into the in-memory model context and was then discarded,
     * so every saved chat held half of each exchange: reloading showed a run
     * of unexplained assistant replies, and the assistant lost the user's own
     * questions from its own history on every later turn.
     */
    const createsUser = /role: 'user',[\s\S]{0,200}messages\.create\(chat\.id, userMessage\)/.test(source);
    expect(createsUser).toBe(true);
  });

  test('the user message is stored BEFORE the model call, not after', () => {
    const source = readCode(routerPath);
    const persistIndex = source.indexOf('persistence.messages.create(chat.id, userMessage)');
    const callIndex = source.indexOf('await sendToModel(key, messages)');
    expect(persistIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(-1);
    /**
     * A provider failure must still leave the question on the record rather
     * than throwing away what the user typed.
     */
    expect(persistIndex).toBeLessThan(callIndex);
  });
});

describe('chatbot UI/UX defects', () => {
  const source = readCode(chatbotPath);

  test('creating a chat returns its id, so the first message is not dropped', () => {
    /**
     * Regression. `sendMessage` created a chat, then re-read `currentChatId`
     * from the closure that had just captured it as `null`, so the guard
     * returned and nothing was sent: the user typed, pressed enter, and
     * nothing happened.
     */
    expect(source).toContain('createChat = useCallback(async (): Promise<string | null>');
    expect(source).toContain('const chatId = currentChatId ?? (await createChat())');
    expect(source).not.toMatch(/await handleNewChat\(\);\s*\n\s*if \(!currentChatId\) return;/);
  });

  test('the panel is fluid on small screens', () => {
    /**
     * Regression. A fixed `w-64` session list sat beside a 440px panel, so on
     * a 375px viewport the conversation was 119px wide.
     */
    expect(source).toContain('sm:w-[440px]');
    expect(source).not.toContain('w-64');
  });

  test('the invalid sidebar height calc is gone', () => {
    // `h-[calc(100vh-theme(space.14))]` is not a valid height and pushed the
    // composer below the viewport.
    expect(source).not.toContain('theme(space.14)');
  });

  test('errors render in a fixed slot above the composer, never inside the scroll area', () => {
    /**
     * Regression. The banner sat at the TOP of the scrolling message list, so
     * a failure after a few messages scrolled itself out of view.
     */
    const errorIndex = source.indexOf('{error && (');
    const composerIndex = source.indexOf('<form');
    expect(errorIndex).toBeGreaterThan(-1);
    expect(errorIndex).toBeLessThan(composerIndex);
  });

  test('a failed send keeps the typed text and offers a retry', () => {
    // The previous version deleted the optimistic message, losing what the
    // user had written on any transient network error.
    expect(source).toContain('setDraft(trimmed)');
    expect(source).toContain('Retry');
    expect(source).not.toContain('setMessages((prev) => prev.filter((m) => m.id !== userMsg.id))');
  });

  test('delete and new-chat failures are handled instead of throwing unhandled', () => {
    expect(source).toContain('setDeletingId(chatId)');
    expect(source).toContain('} catch (err) {');
  });

  test('session delete stays reachable on touch devices', () => {
    // `opacity-0 group-hover:opacity-100` hid it permanently on a phone.
    expect(source).toContain('sm:opacity-0');
    expect(source).toContain('sm:focus-visible:opacity-100');
  });

  test('scrolling targets the conversation container, not the page', () => {
    // scrollIntoView walks up past the container and drags the whole app view.
    expect(source).not.toContain('scrollIntoView');
    expect(source).toContain('node.scrollTop = node.scrollHeight');
  });

  test('assistant output renders bold and bullets without raw HTML', () => {
    expect(source).toContain('renderContent');
    expect(source).toContain('renderInline');
    expect(source).not.toContain('dangerouslySetInnerHTML');
  });
});

/* ------------------------------------------------------------------ */
/* Collapsible Chat Sessions panel                                     */
/* ------------------------------------------------------------------ */

describe('the Chat Sessions panel can be collapsed and expanded', () => {
  const source = readCode(chatbotPath);

  test('the toggle is available at EVERY breakpoint, not just mobile', () => {
    /**
     * Regression. The toggle carried `sm:hidden`, which meant desktop users
     * had NO way to collapse the list: the conversation was permanently
     * squeezed to roughly half the panel, which is the reported bug.
     */
    const toggle = source.slice(
      source.indexOf('aria-controls="chatbot-sessions-panel"') - 700,
      source.indexOf('aria-controls="chatbot-sessions-panel"') + 120,
    );
    expect(toggle).not.toContain('sm:hidden');
  });

  test('collapsing removes the panel entirely so the conversation reclaims the width', () => {
    /**
     * The old class list was `'hidden sm:flex'` when collapsed, which pinned
     * the panel open on desktop regardless of state. Collapsed must be `hidden`
     * at every breakpoint.
     */
    expect(source).not.toContain("'hidden sm:flex'");
    const panel = source.slice(
      source.indexOf('id="chatbot-sessions-panel"'),
      source.indexOf('id="chatbot-sessions-panel"') + 520,
    );
    expect(panel).toMatch(/showSessions[\s\S]*?:\s*'hidden'/);
  });

  test('the toggle exposes expanded state and controls the panel', () => {
    expect(source).toContain('aria-expanded={showSessions}');
    expect(source).toContain('aria-controls="chatbot-sessions-panel"');
    expect(source).toContain('id="chatbot-sessions-panel"');
    // The label must describe the ACTION, not the current state.
    expect(source).toContain(
      "aria-label={showSessions ? 'Hide chat sessions' : 'Show chat sessions'}",
    );
  });

  test('collapsed sessions stay discoverable via a count badge', () => {
    // Hiding the list must not hide the fact that there is a list.
    expect(source).toMatch(/!showSessions && chats\.length > 0/);
  });

  test('the preference is persisted independently of the active conversation', () => {
    /**
     * Collapsing the list must never disturb WHICH chat is open, so the two
     * use separate storage keys.
     */
    expect(source).toContain('SESSIONS_PANEL_STORAGE_KEY');
    expect(source).toContain('readSessionsPreference');
    expect(source).toContain('persistSessionsPreference');
    expect(source).not.toContain("CHATBOT_STORAGE_KEY = SESSIONS_PANEL_STORAGE_KEY");
  });

  test('Escape closes the sessions overlay before the whole assistant', () => {
    // On mobile the panel covers the conversation; one Escape must not skip it.
    expect(source).toContain('matchMedia(\'(min-width: 640px)\')');
  });

  test('toggling never clears the conversation', () => {
    const toggle = source.slice(
      source.indexOf('aria-controls="chatbot-sessions-panel"') - 400,
      source.indexOf('aria-controls="chatbot-sessions-panel"') + 120,
    );
    // The only state it touches is the panel's own visibility.
    expect(toggle).not.toContain('setMessages');
    expect(toggle).not.toContain('setCurrentChatId');
  });

  test('message persistence assertions still hold', () => {
    // Priority: a UI change must not have broken the two data bugs.
    expect(source).toContain('const chatId = currentChatId ?? (await createChat())');
    expect(readCode(routerPath)).toContain(
      'persistence.messages.create(chat.id, userMessage)',
    );
  });
});
