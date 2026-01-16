import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * Build an absolute API URL from a base and a path.
 * Ensures we don't accidentally create double slashes.
 */
function buildUrl(base, path) {
  const b = (base || "").replace(/\/+$/, "");
  const p = (path || "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

/**
 * Attempt to resolve the backend base URL from environment variables.
 * We do not hardcode any URLs here.
 */
function getApiBaseUrl() {
  const base =
    process.env.REACT_APP_API_BASE ||
    process.env.REACT_APP_BACKEND_URL ||
    "";
  return base.replace(/\/+$/, "");
}

/**
 * Safely parse JSON response; if body isn't JSON (or empty), return null.
 */
async function safeJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Create a simple, stable-ish client-side id for messages.
 */
function createId(prefix = "msg") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * Format timestamp for display.
 */
function formatTime(isoOrMs) {
  try {
    const d =
      typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/**
 * Given an arbitrary backend payload, try to extract a human-readable text.
 * This keeps the UI resilient while backend endpoints evolve.
 */
function extractBotText(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.reply === "string") return payload.reply;
  if (typeof payload.text === "string") return payload.text;

  // Common shapes: { data: { ... } } or { choices: [{ message: { content } }] }
  if (payload.data) return extractBotText(payload.data);
  if (Array.isArray(payload.choices) && payload.choices[0]) {
    const c0 = payload.choices[0];
    if (c0.message && typeof c0.message.content === "string") return c0.message.content;
    if (typeof c0.text === "string") return c0.text;
  }

  return "";
}

/**
 * Try multiple likely endpoints; backend currently only exposes `/` health,
 * but upcoming steps will add chat endpoints. This keeps UI working now and
 * automatically starts using new endpoints when they appear.
 */
async function postChatMessage({ apiBaseUrl, text, signal }) {
  const candidates = [
    // Most common patterns for chat apps
    { method: "POST", path: "/chat", body: { message: text } },
    { method: "POST", path: "/chat", body: { text } },
    { method: "POST", path: "/chat/message", body: { message: text } },
    { method: "POST", path: "/chat/messages", body: { message: text } },
    { method: "POST", path: "/message", body: { message: text } },
    { method: "POST", path: "/messages", body: { message: text } },
    { method: "POST", path: "/api/chat", body: { message: text } },
    { method: "POST", path: "/api/messages", body: { message: text } },
    { method: "POST", path: "/v1/chat", body: { message: text } },
  ];

  let lastErr = null;

  for (const c of candidates) {
    const url = buildUrl(apiBaseUrl, c.path);
    try {
      const res = await fetch(url, {
        method: c.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(c.body),
        signal,
      });

      if (!res.ok) {
        // Try next candidate unless it's clearly a non-endpoint error
        lastErr = new Error(`HTTP ${res.status} at ${c.path}`);
        continue;
      }

      const payload = await safeJson(res);
      return { ok: true, payload, usedPath: c.path };
    } catch (e) {
      lastErr = e;
      // network error or abort: break if abort, else keep trying
      if (e?.name === "AbortError") throw e;
    }
  }

  return { ok: false, error: lastErr || new Error("No chat endpoint available") };
}

/**
 * Try to fetch history from common endpoints. If unavailable, just return [].
 */
async function fetchChatHistory({ apiBaseUrl, signal }) {
  const candidates = [
    "/chat/history",
    "/chat/messages",
    "/messages",
    "/api/chat/history",
    "/api/messages",
  ];

  for (const path of candidates) {
    const url = buildUrl(apiBaseUrl, path);
    try {
      const res = await fetch(url, { method: "GET", signal });
      if (!res.ok) continue;
      const payload = await safeJson(res);

      // Expect either {messages: []} or [].
      const msgs = Array.isArray(payload) ? payload : payload?.messages;
      if (Array.isArray(msgs)) return msgs;
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      // ignore and try next
    }
  }
  return [];
}

// PUBLIC_INTERFACE
function App() {
  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [errorBanner, setErrorBanner] = useState("");

  const [messages, setMessages] = useState(() => {
    const now = Date.now();
    return [
      {
        id: createId("bot"),
        role: "bot",
        text:
          "Hi! I’m your assistant. Type a message below. " +
          (apiBaseUrl
            ? "I’ll try to reach the backend as endpoints become available."
            : "Set REACT_APP_API_BASE or REACT_APP_BACKEND_URL to connect to the backend."),
        ts: now,
      },
    ];
  });

  const listRef = useRef(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Fetch chat history (best-effort)
  useEffect(() => {
    if (!apiBaseUrl) return;

    const controller = new AbortController();
    setIsLoadingHistory(true);
    setErrorBanner("");

    fetchChatHistory({ apiBaseUrl, signal: controller.signal })
      .then((history) => {
        if (!history || history.length === 0) return;

        // Normalize history items into our UI shape.
        const normalized = history
          .map((m) => {
            const role =
              m.role ||
              m.sender ||
              (m.is_bot ? "bot" : m.is_user ? "user" : undefined) ||
              "bot";
            const text = m.text || m.message || m.content || "";
            const ts = m.ts || m.timestamp || m.created_at || Date.now();
            return {
              id: m.id || createId(role),
              role: role === "assistant" ? "bot" : role,
              text,
              ts,
            };
          })
          .filter((m) => typeof m.text === "string" && m.text.trim().length > 0);

        if (normalized.length > 0) {
          setMessages((prev) => {
            // Keep the initial greeting, but append history after it
            return [prev[0], ...normalized];
          });
        }
      })
      .catch((e) => {
        if (e?.name === "AbortError") return;
        // history is optional; keep silent
      })
      .finally(() => setIsLoadingHistory(false));

    return () => controller.abort();
  }, [apiBaseUrl]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isSending) return;

    setInput("");
    setErrorBanner("");

    const userMsg = { id: createId("user"), role: "user", text, ts: Date.now() };
    const pendingBotId = createId("bot_pending");
    const pendingMsg = {
      id: pendingBotId,
      role: "bot",
      text: "Thinking…",
      ts: Date.now(),
      pending: true,
    };

    setMessages((prev) => [...prev, userMsg, pendingMsg]);

    if (!apiBaseUrl) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === pendingBotId
            ? {
                ...m,
                pending: false,
                text:
                  "Backend not configured. Please set REACT_APP_API_BASE or REACT_APP_BACKEND_URL.",
              }
            : m
        )
      );
      return;
    }

    const controller = new AbortController();
    setIsSending(true);

    try {
      const result = await postChatMessage({
        apiBaseUrl,
        text,
        signal: controller.signal,
      });

      if (!result.ok) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingBotId
              ? {
                  ...m,
                  pending: false,
                  text:
                    "I couldn't reach a chat endpoint yet. " +
                    "The backend currently may only expose a health check.",
                }
              : m
          )
        );
        setErrorBanner(
          `Chat endpoint unavailable. Ensure backend is running and REACT_APP_API_BASE/REACT_APP_BACKEND_URL is correct.`
        );
        return;
      }

      const botText = extractBotText(result.payload) || "OK";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === pendingBotId
            ? { ...m, pending: false, text: botText, ts: Date.now() }
            : m
        )
      );
    } catch (e) {
      if (e?.name !== "AbortError") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingBotId
              ? {
                  ...m,
                  pending: false,
                  text:
                    "Network error while contacting the backend. " +
                    "Please try again.",
                }
              : m
          )
        );
        setErrorBanner("Network error while sending message.");
      }
    } finally {
      setIsSending(false);
    }
  }

  function onComposerKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="ChatApp">
      <div className="ChatShell">
        <header className="ChatHeader">
          <div className="ChatHeader-left">
            <div className="ChatHeader-logo" aria-hidden="true">
              <span className="ChatHeader-logoInner">K</span>
            </div>
            <div className="ChatHeader-titleWrap">
              <div className="ChatHeader-title">Chatbot</div>
              <div className="ChatHeader-subtitle">
                {apiBaseUrl ? (
                  <>
                    Connected base: <span className="mono">{apiBaseUrl}</span>
                  </>
                ) : (
                  "Not connected — set REACT_APP_API_BASE or REACT_APP_BACKEND_URL"
                )}
              </div>
            </div>
          </div>

          <div className="ChatHeader-right">
            {isLoadingHistory ? (
              <span className="Pill Pill-secondary">Loading…</span>
            ) : (
              <span className="Pill Pill-success">Ready</span>
            )}
          </div>
        </header>

        {errorBanner ? (
          <div className="ChatBanner" role="status" aria-live="polite">
            {errorBanner}
          </div>
        ) : null}

        <main className="ChatBody" aria-label="Chat messages">
          <div className="ChatMessageList" ref={listRef}>
            {messages.map((m) => (
              <div
                key={m.id}
                className={[
                  "ChatMessageRow",
                  m.role === "user" ? "is-user" : "is-bot",
                ].join(" ")}
              >
                {m.role === "bot" ? (
                  <div className="Avatar Avatar-bot" aria-hidden="true">
                    B
                  </div>
                ) : null}

                <div className="ChatBubbleWrap">
                  <div
                    className={[
                      "ChatBubble",
                      m.role === "user" ? "ChatBubble-user" : "ChatBubble-bot",
                      m.pending ? "is-pending" : "",
                    ].join(" ")}
                  >
                    <div className="ChatBubble-text">{m.text}</div>
                    <div className="ChatBubble-meta">
                      <span className="ChatBubble-time">{formatTime(m.ts)}</span>
                      {m.pending ? <span className="ChatBubble-dot">•</span> : null}
                      {m.pending ? (
                        <span className="ChatBubble-status">sending</span>
                      ) : null}
                    </div>
                  </div>
                </div>

                {m.role === "user" ? (
                  <div className="Avatar Avatar-user" aria-hidden="true">
                    U
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="ChatComposerSpacer" aria-hidden="true" />
        </main>

        <footer className="ChatComposer" aria-label="Message composer">
          <div className="ChatComposer-inner">
            <textarea
              className="ChatInput"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="Write a message…"
              rows={1}
              disabled={isSending}
              aria-label="Message input"
            />
            <button
              className="ChatSendButton"
              onClick={handleSend}
              disabled={isSending || input.trim().length === 0}
              aria-label="Send message"
              type="button"
            >
              {isSending ? "Sending…" : "Send"}
            </button>
          </div>
          <div className="ChatComposer-hint">
            Press <span className="kbd">Enter</span> to send,{" "}
            <span className="kbd">Shift</span>+<span className="kbd">Enter</span>{" "}
            for a new line.
          </div>
        </footer>
      </div>
    </div>
  );
}

export default App;
