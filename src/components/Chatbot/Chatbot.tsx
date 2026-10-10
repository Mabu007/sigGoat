/**
 * APP-WIDE AI CHATBOT
 * ===================
 * A conversational assistant reachable from any tab. One floating button opens
 * a slide-over panel with your chat sessions on the left and the conversation
 * on the right.
 *
 * MECHANICS
 *   - Chats: GET /api/chats — a user's sessions, newest first.
 *   - Send:  POST /api/chat — { message, chatId? }. Creates a chat when absent.
 *   - History: GET /api/chat?chatId= — returns prior messages for the session.
 *   - Delete:  DELETE /api/chat/:id.
 *
 * The assistant uses the same credentials as GOAT reasoning (per-user OpenRouter
 * key from the vault, then the server-wide fallback), always the configured
 * model `apodex/apodex-1.1-mini:free`, and persists sessions to Firestore.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useLayoutEffect,
} from 'react';
import {
  X,
  Plus,
  Send,
  MessageSquare,
  Trash2,
  Loader2,
  Sparkles,
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

interface ChatHistory {
  chat: { id: string; title: string };
  messages: ChatMessage[];
}

const PANEL_WIDTH_PX = 440;

const CHATBOT_STORAGE_KEY = 'fundagoat.chatbot';

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 86400000) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const isMounted = useRef(false);

  const authHeaders = useRef<Record<string, string> | null>(null);
  const loadAuthHeaders = useCallback(async () => {
    if (!authHeaders.current) {
      authHeaders.current = await getApiAuthHeaders();
    }
    return authHeaders.current;
  }, [getApiAuthHeaders]);

  /* ---- Initial load: open on first visit if user already logged in ---- */
  useEffect(() => {
    isMounted.current = true;
    const handleOpen = () => setIsOpen(true);
    window.addEventListener('fundagoat-chatbot-open', handleOpen as EventListener);
    if (currentUser) {
      try {
        const stored = localStorage.getItem(CHATBOT_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (typeof parsed === 'object' && parsed !== null && 'chatId' in parsed) {
            setCurrentChatId(parsed.chatId);
            void loadChats();
          }
        }
      } catch {
        // ignore
      }
    }
    return () => {
      isMounted.current = false;
      window.removeEventListener('fundagoat-chatbot-open', handleOpen as EventListener);
    };
  }, [currentUser]);

  const loadChats = useCallback(async () => {
    setError(null);
    setIsFetching(true);
    try {
      const headers = await loadAuthHeaders();
      const res = await fetch('/api/chats', { headers });
      if (!res.ok) throw new Error('Could not load chat sessions.');
      const data = await res.json();
      setChats(
        Array.isArray(data?.chats)
          ? data.chats.map((c: any) => ({
              id: c.id,
              title: c.title,
              lastMessageAt: c.lastMessageAt,
              updatedAt: c.updatedAt,
            }))
          : [],
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not load chat sessions.',
      );
      setChats([]);
    } finally {
      setIsFetching(false);
    }
  }, [loadAuthHeaders]);

  const loadMessages = useCallback(
    async (chatId: string) => {
      if (!currentChatId) return;
      setError(null);
      try {
        const headers = await loadAuthHeaders();
        const res = await fetch(`/api/chat?chatId=${encodeURIComponent(chatId)}`, {
          headers,
        });
        if (!res.ok) throw new Error('Could not load chat messages.');
        const data = (await res.json()) as ChatHistory;
        setMessages(data.messages ?? []);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Could not load chat messages.',
        );
        setMessages([]);
      }
    },
    [currentChatId, loadAuthHeaders],
  );

  const handleNewChat = useCallback(async () => {
    setError(null);
    const headers = await loadAuthHeaders();
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    if (!res.ok) throw new Error('Could not create a new chat.');
    const data = await res.json();
    const newChat: ChatItem = {
      id: data.chat.id,
      title: data.chat.title || 'New chat',
      lastMessageAt: new Date().toISOString(),
    };
    setChats((prev) => [newChat, ...prev]);
    setCurrentChatId(newChat.id);
    setMessages([]);
    localStorage.setItem(
      CHATBOT_STORAGE_KEY,
      JSON.stringify({ chatId: newChat.id }),
    );
    setInput('');
  }, [loadAuthHeaders]);

  const selectChat = useCallback(
    async (chatId: string) => {
      setCurrentChatId(chatId);
      localStorage.setItem(
        CHATBOT_STORAGE_KEY,
        JSON.stringify({ chatId }),
      );
      await loadMessages(chatId);
      inputRef.current?.focus();
    },
    [loadMessages],
  );

  const deleteChat = useCallback(
    async (chatId: string) => {
      const headers = await loadAuthHeaders();
      const res = await fetch(`/api/chat/${encodeURIComponent(chatId)}`, {
        method: 'DELETE',
        headers,
      });
      if (!res.ok) throw new Error('Could not delete the chat.');
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (currentChatId === chatId) {
        setCurrentChatId(null);
        setMessages([]);
      }
    },
    [currentChatId, loadAuthHeaders],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isSending) return;
      if (!currentChatId) {
        await handleNewChat();
        if (!currentChatId) return;
      }
      setIsSending(true);
      setError(null);

      const userMsg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        chatId: currentChatId,
        userId: currentUser?.uid ?? 'unknown',
        role: 'user',
        content: trimmed,
        createdAt: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setInput('');

      try {
        const headers = await loadAuthHeaders();
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: trimmed, chatId: currentChatId }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            body?.error?.message ?? 'The assistant could not respond.',
          );
        }
        const data = await res.json();
        const assistantMsg: ChatMessage = {
          ...data.message,
          createdAt: data.message.createdAt,
        };
        setMessages((prev) => [...prev, assistantMsg]);
        setChats((prev) =>
          prev.map((c) =>
            c.id === currentChatId
              ? { ...c, title: data.chat.title, lastMessageAt: assistantMsg.createdAt }
              : c,
          ),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The assistant could not respond.');
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
      } finally {
        setIsSending(false);
      }
    },
    [currentChatId, isSending, currentUser, handleNewChat, loadAuthHeaders],
  );

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      sendMessage(input);
    },
    [input, sendMessage],
  );

  /* ---- Auto-scroll to bottom of messages ---- */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* ---- Panel width + focus management ---- */
  useEffect(() => {
    if (!panelRef.current) return;
    panelRef.current.style.width = `${PANEL_WIDTH_PX}px`;
    const handleResize = () => {
      if (panelRef.current && window.innerWidth < PANEL_WIDTH_PX) {
        panelRef.current.style.width = `${window.innerWidth}px`;
      } else {
        panelRef.current.style.width = `${PANEL_WIDTH_PX}px`;
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, [isOpen]);

  /* ---- Escape to close ---- */
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen]);

  /* ---- Overlay click closes panel ---- */
  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (!panelRef.current || !isOpen) return;
      const target = e.target as HTMLElement;
      const button = target.closest('[data-chatbot-trigger]');
      if (!button) {
        setIsOpen(false);
      }
    },
    [isOpen],
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      inputRef.current?.focus();
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, handleClickOutside]);

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
        className="group relative flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-fg hover:bg-raised md:px-4"
        aria-label="Open AI assistant"
      >
        <Sparkles
          size={15}
          aria-hidden="true"
          className="text-accent-text transition-transform group-hover:scale-110"
        />
        <span className="hidden sm:inline">AI assistant</span>
        <span className="inline-block sm:hidden">Assistant</span>
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-label="AI assistant"
    >
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => setIsOpen(false)}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className="relative flex h-screen flex-col overflow-hidden bg-surface shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line bg-surface px-4 py-2">
          <div className="flex items-center gap-2">
            <Sparkles size={15} className="text-accent-text" aria-hidden="true" />
            <h2 className="text-[13px] font-semibold tracking-tight text-fg">
              AI assistant
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="rounded p-1 text-fg-subtle hover:bg-raised hover:text-fg"
            aria-label="Close assistant"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {/* Sidebar: chat list */}
        <div className="flex h-[calc(100vh-theme(space.14))] w-64 flex-col border-r border-line bg-sunken">
          <div className="p-3">
            <button
              type="button"
              onClick={handleNewChat}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[11px] font-medium text-fg transition-colors hover:bg-raised"
            >
              <Plus size={12} aria-hidden="true" />
              New chat
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-2">
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
                      className={`group flex items-center justify-between rounded-md px-2 py-1.5 text-[11px] transition-colors ${
                        currentChatId === chat.id
                          ? 'bg-accent/10 text-accent-text'
                          : 'text-fg hover:bg-raised'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => selectChat(chat.id)}
                        className="flex flex-1 flex-col items-start truncate text-left"
                      >
                        <span className="truncate font-medium">{chat.title}</span>
                        {chat.lastMessageAt && (
                          <span className="truncate text-[10px] opacity-70">
                            {formatTime(chat.lastMessageAt)}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteChat(chat.id);
                        }}
                        className={`ml-1.5 rounded p-0.5 opacity-0 transition-opacity hover:bg-negative/10 hover:text-negative group-hover:opacity-100 ${
                          currentChatId === chat.id ? 'text-negative' : 'text-fg-subtle'
                        }`}
                        aria-label={`Delete ${chat.title}`}
                        title="Delete chat"
                      >
                        <Trash2 size={11} aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-line p-2 text-[10px] text-fg-subtle">
            <p>Model: apodex/apodex-1.1-mini:free</p>
            <p className="mt-0.5">
              Analysis only — never places an order.
            </p>
          </div>
        </div>

        {/* Conversation */}
        <div
          ref={scrollRef}
          className="flex flex-1 flex-col bg-surface"
        >
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {error && (
              <div className="mb-3 rounded-lg border border-negative/40 bg-negative-soft px-3 py-2 text-[11px] text-negative">
                {error}
              </div>
            )}

            {messages.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <Sparkles size={24} className="mb-2 text-accent-text" aria-hidden="true" />
                <p className="text-[13px] font-medium text-fg">Ask anything</p>
                <p className="max-w-xs text-[11px] text-fg-muted">
                  Questions about markets, your GOATs, or trading ideas. I don&apos;t
                  have live prices — check the Markets tab for that.
                </p>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`mb-3 flex ${
                  msg.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-[13px] leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-accent text-accent-fg'
                      : 'bg-sunken text-fg'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                  <p
                    className={`mt-1 text-[10px] ${
                      msg.role === 'user'
                        ? 'text-accent-fg/70'
                        : 'text-fg-subtle'
                    }`}
                  >
                    {formatTime(msg.createdAt)}
                  </p>
                </div>
              </div>
            ))}

            {isSending && (
              <div className="mb-3 flex items-center gap-1.5 text-[11px] text-fg-subtle">
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                <span>Assistant is typing</span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <form
            onSubmit={handleSubmit}
            className="border-t border-line bg-surface px-4 py-3"
          >
            <div className="flex items-end gap-2 rounded-lg border border-line bg-sunken px-3 py-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                placeholder="Ask about a market, a GOAT, or a trading concept…"
                rows={1}
                className="max-h-32 min-h-[20px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-fg placeholder:text-fg-subtle outline-none"
                disabled={isSending}
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
  );
}
