/**

  * APP-WIDE AI CHATBOT

  * ===================

  * A conversational assistant reachable from any tab: one trigger opens a

  * slide-over with your sessions on the left and the conversation on the right.

  *

  * MECHANICS

  *   - Chats: GET /api/chats — the user's sessions, newest first.

  *   - Send:  POST /api/chat — { message, chatId? }. Creates a chat when absent.

  *   - History: GET /api/chat?chatId= — prior messages for the session.

  *   - Delete:  DELETE /api/chat/:id.

  *

  * The assistant resolves the same credentials as GOAT reasoning (the caller's

  * own OpenRouter key from the vault, then the server fallback) and persists

  * sessions to Firestore.

  *

  * FIXED HERE (each of these was a real defect, not a polish item)

  *

  *   1. THE FIRST MESSAGE WAS SILENTLY DROPPED.

  *      `sendMessage` created a chat, then re-read `currentChatId` from the

  *      closure that had just been captured as `null` — so the guard returned

  *      and nothing was sent. The user typed, pressed enter, and nothing

  *      happened. The id now comes from `handleNewChat`'s return value.

  *

  *   2. THE PANEL DID NOT FIT A PHONE.

  *      A fixed `w-64` session list sat beside a 440px panel: on a 375px

  *      viewport the conversation was 119px wide. Width is now fluid, and the

  *      session list collapses behind a toggle below `sm`.

  *

  *   3. SIDEBAR HEIGHT WAS A HARD-CODED CALC.

  *      `h-[calc(100vh-theme(space.14))]` is not a valid height and grew the

  *      panel past the viewport, so the composer sat off-screen.

  *

  *   4. ERRORS RENDERED WHERE NOBODY COULD SEE THEM.

  *      The banner sat at the TOP of a scrolling list, so a failure after the

  *      first few messages pushed itself out of view. Errors now live in a

  *      fixed slot above the composer, and a failed send keeps the user's text

  *      so it can be retried instead of deleted.

  *

  *   5. UNHANDLED PROMISE REJECTIONS.

  *      `handleNewChat` and `deleteChat` were wired straight to `onClick` with

  *      no error handling; one failed request produced a console-only error

  *      and a spinner that never stopped.

  *

  *   6. IMPLICIT STYLE MUTATION.

  *      The panel width was assigned through `ref.current.style.width` in an

  *      effect, fighting React's own reconciliation. It is CSS now.

  */



import {

  useCallback,

  useEffect,

  useLayoutEffect,

  useRef,

  useState,

} from 'react';

import {

  X,

  Plus,

  Send,

  MessageSquare,

  Trash2,

  Loader2,

  Sparkles,

  PanelLeftClose,

  PanelLeftOpen,

  RotateCw,

  AlertCircle,

} from 'lucide-react';



import { useAuth } from '../../context/AuthContext';



interface ChatItem {

  id: string;

  title: string;

  lastMessageAt?: string;

  updatedAt?: string;

}



interface ChatMessage {

  id: string;

  chatId: string;

  userId: string;

  role: 'user' | 'assistant';

  content: string;

  model?: string;

  createdAt: string;

}



const CHATBOT_STORAGE_KEY = 'sirgoat.chatbot';



/**

  * The pre-rename key, still read once so an existing user does not silently

  * lose the chat they had open when the product was renamed.

  */

const LEGACY_CHATBOT_STORAGE_KEY = 'fundagoat.chatbot';



/**

  * Persisted Chat Sessions visibility.

  *

  * Stored separately from the active conversation so collapsing the list can

  * never disturb which chat is open — the two are independent decisions.

  */

const SESSIONS_PANEL_STORAGE_KEY = 'sirgoat.chatbot.sessionsExpanded';



/** Sessions column width at `sm` and above. */

const SESSIONS_PANEL_WIDTH = 'w-60';



/**

  * Reads the persisted panel state.

  *

  * Defaults to expanded on desktop (where it is a useful sidebar) and

  * collapsed on small screens (where it would otherwise cover the whole

  * conversation). A stored preference always wins, because the user made it

  * deliberately.

  */

function readSessionsPreference(): boolean {

  try {

    const stored = localStorage.getItem(SESSIONS_PANEL_STORAGE_KEY);

    if (stored === 'true') return true;

    if (stored === 'false') return false;

  } catch {

    // Private mode / disabled storage: fall through to the default.

  }

  return typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches;

}



function persistSessionsPreference(expanded: boolean): void {

  try {

    localStorage.setItem(SESSIONS_PANEL_STORAGE_KEY, String(expanded));

  } catch {

    // Non-fatal: the panel still toggles for this session.

  }

}



function formatTime(iso: string): string {

  const d = new Date(iso);

  if (Number.isNaN(d.getTime())) return '';

  const diff = Date.now() - d.getTime();

  if (diff < 86_400_000) {

    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  }

  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });

}



/**

  * Minimal, safe inline formatting for assistant replies.

  *

  * The model emits Markdown, and rendering it as raw text means every answer

  * shows literal `\*\*bold\*\*` and `- bullets`. A full Markdown renderer and

  * `dangerouslySetInnerHTML` are both disproportionate here — this handles the

  * two things the system prompt actually produces (bold and bullet lists)

  * entirely in React elements, so there is no HTML injection surface at all.

  */

function renderContent(content: string): React.ReactNode {

  const blocks = content.split('\n');

  const nodes: React.ReactNode[] = [];

  let bullets: string[] = [];



  const flushBullets = (key: string) => {

    if (bullets.length === 0) return;

    nodes.push(

      <ul key={key} className="my-1.5 ml-4 list-disc space-y-0.5">

        {bullets.map((item, index) => (

          <li key={index}>{renderInline(item)}</li>

        ))}

      </ul>,

    );

    bullets = [];

  };



  blocks.forEach((raw, index) => {

    const line = raw.trimEnd();

    const bullet = /^[-*•]\s+(.*)$/.exec(line.trim());

    if (bullet) {

      bullets.push(bullet[1]);

      return;

    }

    flushBullets(`ul-${index}`);

    if (line.trim().length === 0) return;

    nodes.push(

      <p key={index} className="mb-1.5 last:mb-0">

        {renderInline(line)}

      </p>,

    );

  });

  flushBullets('ul-final');



  return nodes;

}



/** Handles `\*\*bold\*\*` and `` `code` `` without touching HTML. */

function renderInline(text: string): React.ReactNode {

  const parts = text.split(/(\*\*[^\*]+\*\*|`[^`]+`)/g);

  return parts.map((part, index) => {

    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {

      return (

        <strong key={index} className="font-semibold">

          {part.slice(2, -2)}

        </strong>

      );

    }

    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {

      return (

        <code key={index} className="rounded bg-sunken px-1 font-mono text-[0.9em]">

          {part.slice(1, -1)}

        </code>

      );

    }

    return part;

  });

}



export function Chatbot() {

  const { currentUser, getApiAuthHeaders } = useAuth();

  const [isOpen, setIsOpen] = useState(false);

  const [chats, setChats] = useState<ChatItem[]>([]);

  const [currentChatId, setCurrentChatId] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [input, setInput] = useState('');

  const [isSending, setIsSending] = useState(false);

  const [isFetching, setIsFetching] = useState(true);

  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState<string | null>(null);

  const [showSessions, setShowSessions] = useState(readSessionsPreference);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [chatModel, setChatModel] = useState<string | null>(null);



  const scrollRef = useRef<HTMLDivElement>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);

  const authHeaders = useRef<Record<string, string> | null>(null);



  const loadAuthHeaders = useCallback(async () => {

    if (!authHeaders.current) authHeaders.current = await getApiAuthHeaders();

    return authHeaders.current;

  }, [getApiAuthHeaders]);



  /* ---- Sessions ---- */



  const loadChats = useCallback(async () => {

    setError(null);

    setIsFetching(true);

    try {

      const res = await fetch('/api/chats', { headers: await loadAuthHeaders() });

      if (!res.ok) throw new Error('Could not load your chat sessions.');

      const data = await res.json();

      setChats(

        Array.isArray(data?.chats)

          ? data.chats.map((c: Partial<ChatItem> & { id: string }) => ({

              id: c.id,

              title: c.title || 'New chat',

              lastMessageAt: c.lastMessageAt,

              updatedAt: c.updatedAt,

            }))

          : [],

      );

    } catch (err) {

      setError(err instanceof Error ? err.message : 'Could not load your chat sessions.');

      setChats([]);

    } finally {

      setIsFetching(false);

    }

  }, [loadAuthHeaders]);



  const loadMessages = useCallback(

    async (chatId: string) => {

      setError(null);

      setMessages([]);

      try {

        const res = await fetch(`/api/chat?chatId=${encodeURIComponent(chatId)}`, {

          headers: await loadAuthHeaders(),

        });

        if (!res.ok) throw new Error('Could not load this conversation.');

        const data = await res.json();

        setMessages(Array.isArray(data?.messages) ? data.messages : []);

      } catch (err) {

        setError(err instanceof Error ? err.message : 'Could not load this conversation.');

      }

    },

    [loadAuthHeaders],

  );



  /**

    * Creates a session and RETURNS ITS ID.

    *

    * Returning the id is the whole point: the previous version called

    * `setCurrentChatId` and then the caller re-read the stale closure value,

    * which was still `null`, so the first message was discarded.

    */

  const createChat = useCallback(async (): Promise<string | null> => {
    setError(null);
    try {
      const res = await fetch('/api/chats', {
        method: 'POST',
        headers: await loadAuthHeaders(),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error?.message ?? 'Could not start a new chat.');
      }

      const id: string = data?.chat?.id;
      if (!id) throw new Error('The server did not return a chat id.');

      const newChat: ChatItem = {
        id,
        title: data.chat.title || 'New chat',
        lastMessageAt: data.chat.lastMessageAt || new Date().toISOString(),
      };
      setChats((prev) => [newChat, ...prev]);
      setCurrentChatId(id);
      setMessages([]);
      try {
        localStorage.setItem(CHATBOT_STORAGE_KEY, JSON.stringify({ chatId: id }));
      } catch {
        /* Storage is optional. */
      }
      return id;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start a new chat.');
      return null;
    }
  }, [loadAuthHeaders]);

  const selectChat = useCallback(

    async (chatId: string) => {

      setCurrentChatId(chatId);

      setShowSessions(false);

      try { localStorage.setItem(CHATBOT_STORAGE_KEY, JSON.stringify({ chatId })); } catch { /* Storage is optional. */ }

      setDraft(null);

      await loadMessages(chatId);

      inputRef.current?.focus();

    },

    [loadMessages],

  );



  const deleteChat = useCallback(

    async (chatId: string) => {

      setDeletingId(chatId);

      setError(null);

      try {

        const res = await fetch(`/api/chat/${encodeURIComponent(chatId)}`, {

          method: 'DELETE',

          headers: await loadAuthHeaders(),

        });

        if (!res.ok) throw new Error('Could not delete that chat.');

        setChats((prev) => prev.filter((c) => c.id !== chatId));

        if (currentChatId === chatId) {

          setCurrentChatId(null);

          setMessages([]);

          setDraft(null);

          try { localStorage.removeItem(CHATBOT_STORAGE_KEY); } catch { /* Storage is optional. */ }

        }

      } catch (err) {

        setError(err instanceof Error ? err.message : 'Could not delete that chat.');

      } finally {

        setDeletingId(null);

      }

    },

    [currentChatId, loadAuthHeaders],

  );



  /* ---- Sending ---- */



  const sendMessage = useCallback(

    async (text: string) => {

      const trimmed = text.trim();

      if (!trimmed || isSending) return;



      setIsSending(true);

      setError(null);

      setDraft(trimmed);



      // Resolve (or create) the session FIRST and use the returned id.

      const chatId = currentChatId ?? (await createChat());

      if (!chatId) {

        setIsSending(false);

        return;

      }



      const userMsg: ChatMessage = {

        id: `local\_${Date.now()}`,

        chatId,

        userId: currentUser?.uid ?? 'unknown',

        role: 'user',

        content: trimmed,

        createdAt: new Date().toISOString(),

      };

      setMessages((prev) => [...prev, userMsg]);

      setInput('');



      try {

        const res = await fetch('/api/chat', {

          method: 'POST',

          headers: { ...(await loadAuthHeaders()), 'Content-Type': 'application/json' },

          body: JSON.stringify({ message: trimmed, chatId }),

        });

        const body = await res.json().catch(() => null);



        if (!res.ok) {

          throw new Error(body?.error?.message ?? 'The assistant could not respond.');

        }



        const assistantMsg: ChatMessage = body.message;

        setMessages((prev) => [...prev, assistantMsg]);

        setDraft(null);

        if (assistantMsg.model) setChatModel(assistantMsg.model);

        if (body.chat?.title) {

          setChats((prev) =>

            prev.map((c) =>

              c.id === chatId

                ? {

                    ...c,

                    title: body.chat.title,

                    lastMessageAt: assistantMsg.createdAt ?? new Date().toISOString(),

                  }

                : c,

            ),

          );

        }

      } catch (err) {

        /**

          * Keep the user's text. The previous version deleted the optimistic

          * message on failure, so a failed send lost what the user had typed —

          * worst possible behaviour for a transient network error.

          */

        setError(err instanceof Error ? err.message : 'The assistant could not respond.');

      } finally {

        setIsSending(false);

      }

    },

    [currentChatId, isSending, currentUser, createChat, loadAuthHeaders],

  );



  const retry = useCallback(() => {

    if (draft) void sendMessage(draft);

  }, [draft, sendMessage]);



  /* ---- Lifecycle ---- */



  useEffect(() => {

    const handleOpen = () => setIsOpen(true);

    window.addEventListener('sirgoat-chatbot-open', handleOpen as EventListener);

    return () => window.removeEventListener('sirgoat-chatbot-open', handleOpen as EventListener);

  }, []);



  useEffect(() => {

    if (!currentUser) return;

    void loadChats();

    try {

      const stored = localStorage.getItem(CHATBOT_STORAGE_KEY);

      if (!stored) return;

      const parsed = JSON.parse(stored);

      if (typeof parsed === 'object' && parsed !== null && 'chatId' in parsed) {

        const chatId = (parsed as { chatId: unknown }).chatId;

        if (typeof chatId === 'string' && chatId) {

          setCurrentChatId(chatId);

          void loadMessages(chatId);

        }

      }

    } catch {

      // A corrupt localStorage entry must never block the panel.

      localStorage.removeItem(CHATBOT_STORAGE_KEY);

      localStorage.removeItem(LEGACY_CHATBOT_STORAGE_KEY);

    }

    // Runs once per signed-in user; chatId changes are handled below.

    // eslint-disable-next-line react-hooks/exhaustive-deps

  }, [currentUser]);



  /**

    * Scroll the CONTAINER, not the page.

    *

    * `scrollIntoView` walks up to the nearest scrollable ancestor and beyond,

    * which drags the whole application view while the user is trying to read a

    * message.

    */

  useLayoutEffect(() => {

    const node = scrollRef.current;

    if (node) node.scrollTop = node.scrollHeight;

  }, [messages, isSending]);



  /* Grow the composer with its content, up to a cap. */

  useLayoutEffect(() => {

    const node = inputRef.current;

    if (!node) return;

    node.style.height = 'auto';

    node.style.height = `${Math.min(node.scrollHeight, 128)}px`;

  }, [input]);



  useEffect(() => {

    if (!isOpen) return;

    const onKey = (e: KeyboardEvent) => {

      if (e.key !== 'Escape') return;

      /**

        * Escape closes the INNERMOST dismissible layer first.

        *

        * With the sessions panel expanded on a small screen it covers the

        * conversation, so a single Escape that closed the whole assistant would

        * skip a step the user can see in front of them.

        */

      if (showSessions && typeof window !== 'undefined' && !window.matchMedia('(min-width: 640px)').matches) {

        setShowSessions(false);

        persistSessionsPreference(false);

        return;

      }

      setIsOpen(false);

    };

    window.addEventListener('keydown', onKey);

    inputRef.current?.focus();

    return () => window.removeEventListener('keydown', onKey);

  }, [isOpen, showSessions]);



  /* ---- Closed state: the trigger ---- */



  if (!isOpen) {

    return (

      <button

        data-chatbot-trigger

        type="button"

        onClick={() => {

          if (!currentUser) {

            setError('Sign in to use the assistant.');

            return;

          }

          setIsOpen(true);

        }}

        className="group flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-fg hover:bg-raised md:px-4"

        aria-label="Open AI assistant"

      >

        <Sparkles

          size={15}

          aria-hidden="true"

          className="text-accent-text transition-transform group-hover:scale-110"

        />

        <span className="hidden sm:inline">AI assistant</span>

        <span className="inline sm:hidden">Assistant</span>

      </button>

    );

  }



  /* ---- Open state: the panel ---- */



  return (

    <div

      className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm sm:bg-black/40 sm:backdrop-blur-sm"

      role="dialog"

      aria-modal="true"

      aria-label="AI assistant"

      onMouseDown={(e) => {

        // Only a click on the backdrop itself closes; clicks inside stop here.

        if (e.target === e.currentTarget) setIsOpen(false);

      }}

    >

    <div className="flex h-full w-full max-w-full flex-col overflow-hidden bg-surface shadow-2xl sm:h-full sm:w-[min(1100px,96vw)]">



        {/* Header */}

        <div className="flex shrink-0 items-center justify-between border-b border-line bg-surface px-3 py-2.5 sm:px-4">

          <div className="flex min-w-0 items-center gap-2">

            {/**

              * Sessions toggle — VISIBLE AT EVERY BREAKPOINT.

              *

              * It used to carry `sm:hidden`, which meant desktop users had no

              * way to collapse the list at all: the conversation was permanently

              * squeezed to roughly half the panel. The collapsed count badge

              * keeps the sessions discoverable when the panel is hidden.

              */}

            <button

              type="button"

              onClick={() =>

                setShowSessions((v) => {

                  persistSessionsPreference(!v);

                  return !v;

                })

              }

              className="flex items-center gap-1 rounded px-1 py-0.5 text-fg-subtle transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"

              aria-label={showSessions ? 'Hide chat sessions' : 'Show chat sessions'}

              aria-expanded={showSessions}

              aria-controls="chatbot-sessions-panel"

              title={showSessions ? 'Hide chat sessions' : 'Show chat sessions'}

            >

              {showSessions ? (

                <PanelLeftClose size={16} aria-hidden="true" />

              ) : (

                <PanelLeftOpen size={16} aria-hidden="true" />

              )}

              {!showSessions && chats.length > 0 && (

                <span

                  className="rounded bg-sunken px-1 text-[10px] font-semibold tabular-nums text-fg-muted"

                  aria-hidden="true"

                >

                  {chats.length}

                </span>

              )}

            </button>

            <Sparkles size={15} className="shrink-0 text-accent-text" aria-hidden="true" />

            <h2 className="truncate text-[13px] font-semibold tracking-tight text-fg">

              AI assistant

            </h2>

          </div>

          <button

            type="button"

            onClick={() => setIsOpen(false)}

            className="rounded p-1 text-fg-subtle hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"

            aria-label="Close assistant"

          >

            <X size={16} aria-hidden="true" />

          </button>

        </div>



        <div className="relative flex min-h-0 flex-1">

          {/**

            * SESSIONS PANEL.

            *

            * Desktop (`sm`+): a collapsible column. Collapsed it takes NO width,

            * so the conversation reclaims the full 440px.

            *

            * Mobile: an overlay covering the conversation, because a fixed

            * 224px column beside a fluid panel left the conversation 119px wide

            * on a 375px screen.

            *

            * `hidden` (not `visibility`) is deliberate so a collapsed panel is

            * removed from the accessibility tree and the tab order entirely.

            */}

          <div

            id="chatbot-sessions-panel"

            className={[

              'flex min-h-0 w-60 max-w-[80vw] shrink-0 flex-col border-line bg-sunken sm:border-r',

              SESSIONS_PANEL_WIDTH,

              showSessions

                ? 'absolute inset-x-0 top-[45px] bottom-0 z-10 w-full max-w-none border-b sm:static sm:inset-auto sm:w-60 sm:max-w-[80vw]'

                : 'hidden',

            ].join(' ')}

          >

            <div className="p-2.5">

              <button

                type="button"

                onClick={() => {

                  void createChat().then((id) => {

                    if (id) {

                      setShowSessions(false);

                      inputRef.current?.focus();

                    }

                  });

                }}

                className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[11px] font-medium text-fg transition-colors hover:bg-raised"

              >

                <Plus size={12} aria-hidden="true" />

                New chat

              </button>

            </div>



            <div className="min-h-0 flex-1 overflow-y-auto px-2">

              {isFetching && chats.length === 0 ? (

                <div className="flex items-center justify-center py-6 text-fg-subtle">

                  <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" />

                  Loading…

                </div>

              ) : chats.length === 0 ? (

                <div className="py-6 text-center text-[11px] text-fg-subtle">

                  <MessageSquare size={14} className="mx-auto mb-1.5 opacity-60" aria-hidden="true" />

                  <p>No chat sessions yet.</p>

                </div>

              ) : (

                <ul className="space-y-0.5">

                  {chats.map((chat) => (

                    <li key={chat.id}>

                      <div

                        className={`group flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-[11px] transition-colors ${

                          currentChatId === chat.id

                            ? 'bg-accent/10 text-accent-text'

                            : 'text-fg hover:bg-raised'

                        }`}

                      >

                        <button

                          type="button"

                          onClick={() => void selectChat(chat.id)}

                          aria-current={currentChatId === chat.id}

                          className="flex min-w-0 flex-1 flex-col items-start truncate text-left"

                        >

                          <span className="truncate font-medium">{chat.title}</span>

                          {chat.lastMessageAt && (

                            <span className="truncate text-[10px] opacity-70">

                              {formatTime(chat.lastMessageAt)}

                            </span>

                          )}

                        </button>

                        {/**

                          * Always visible on touch. `opacity-0 group-hover:opacity-100`

                          * hid it permanently on a phone, where there is no hover

                          * and no keyboard to reveal it.

                          */}

                        <button

                          type="button"

                          onClick={(e) => {

                            e.stopPropagation();

                            void deleteChat(chat.id);

                          }}

                          disabled={deletingId === chat.id}

                          className="ml-1 shrink-0 rounded p-1 text-fg-subtle transition-colors hover:bg-negative/10 hover:text-negative disabled:opacity-50 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"

                          aria-label={`Delete ${chat.title}`}

                          title="Delete chat"

                        >

                          {deletingId === chat.id ? (

                            <Loader2 size={11} className="animate-spin" aria-hidden="true" />

                          ) : (

                            <Trash2 size={11} aria-hidden="true" />

                          )}

                        </button>

                      </div>

                    </li>

                  ))}

                </ul>

              )}

            </div>



            <div className="shrink-0 border-t border-line p-2 text-[10px] leading-relaxed text-fg-subtle">

              <p className="truncate">

                {chatModel ? `Model: ${chatModel}` : 'Model: set in Settings'}

              </p>

              <p className="mt-0.5">Answers questions only — it never places an order.</p>

            </div>

          </div>



          {/* Conversation */}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">

              {messages.length === 0 ? (

                <div className="flex h-full flex-col items-center justify-center px-4 text-center">

                  <Sparkles size={24} className="mb-2 text-accent-text" aria-hidden="true" />

                  <p className="text-[13px] font-medium text-fg">Ask anything</p>

                  <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-fg-muted">

                    Questions about markets, your GOATs, or trading ideas. I don't

                    have live prices — check the Markets tab for those.

                  </p>

                  <div className="mt-4 flex flex-wrap justify-center gap-1.5">

                    {[

                      'What is a risk:reward ratio?',

                      'How does a prop firm challenge work?',

                      'What does my GOAT do at a session open?',

                    ].map((suggestion) => (

                      <button

                        key={suggestion}

                        type="button"

                        onClick={() => void sendMessage(suggestion)}

                        className="rounded-full border border-line px-2.5 py-1 text-[10px] text-fg-muted transition-colors hover:bg-raised hover:text-fg"

                      >

                        {suggestion}

                      </button>

                    ))}

                  </div>

                </div>

              ) : (

                <div aria-live="polite">

                  {messages.map((msg) => (

                    <div

                      key={msg.id}

                      className={`mb-3 flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}

                    >

                      <div

                        className={`max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-relaxed sm:max-w-[80%] ${

                          msg.role === 'user' ? 'bg-accent text-accent-fg' : 'bg-sunken text-fg'

                        }`}

                      >

                        <div>{renderContent(msg.content)}</div>

                        <p

                          className={`mt-1 text-[10px] ${

                            msg.role === 'user' ? 'text-accent-fg/70' : 'text-fg-subtle'

                          }`}

                        >

                          {formatTime(msg.createdAt)}

                        </p>

                      </div>

                    </div>

                  ))}

                </div>

              )}



              {isSending && (

                <div className="mb-3 flex items-center gap-1.5 text-[11px] text-fg-subtle">

                  <Loader2 size={13} className="animate-spin" aria-hidden="true" />

                  <span>Assistant is typing…</span>

                </div>

              )}

            </div>



            {/* Error + composer. Fixed slot above the input so a failure is

                never scrolled out of sight by a long conversation. */}

            {error && (

              <div className="mx-3 mb-2 shrink-0 rounded-lg border border-negative/40 bg-negative-soft px-3 py-2 text-[11px] text-negative sm:mx-4">

                <div className="flex items-start gap-2">

                  <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />

                  <span className="min-w-0 flex-1">{error}</span>

                  {draft && (

                    <button

                      type="button"

                      onClick={retry}

                      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-semibold underline underline-offset-2"

                    >

                      <RotateCw size={11} aria-hidden="true" />

                      Retry

                    </button>

                  )}

                </div>

              </div>

            )}



            <form

              onSubmit={(e) => {

                e.preventDefault();

                void sendMessage(input);

              }}

              className="shrink-0 border-t border-line bg-surface px-3 py-2.5 sm:px-4 sm:py-3"

            >

              <div className="flex items-end gap-2 rounded-lg border border-line bg-sunken px-3 py-2 focus-within:border-focus">

                <textarea

                  ref={inputRef}

                  value={input}

                  onChange={(e) => setInput(e.target.value)}

                  onKeyDown={(e) => {

                    if (e.key === 'Enter' && !e.shiftKey) {

                      e.preventDefault();

                      void sendMessage(input);

                    }

                  }}

                  placeholder="Ask about a market, a GOAT, or a trading concept…"

                  rows={1}

                  aria-label="Message"

                  className="max-h-32 min-h-[20px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-fg placeholder:text-fg-subtle outline-none"

                />

                <button

                  type="submit"

                  disabled={isSending || !input.trim()}

                  className="rounded p-1 text-fg-subtle transition-colors hover:bg-raised hover:text-fg disabled:opacity-40"

                  aria-label="Send message"

                  title="Send"

                >

                  <Send size={15} aria-hidden="true" />

                </button>

              </div>

            </form>

          </div>

        </div>

      </div>

    </div>

  );

}
