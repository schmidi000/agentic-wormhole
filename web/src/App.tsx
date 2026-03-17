import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";
import type {
  BridgeSessionSnapshot,
  ManagedServiceSnapshot,
  ProcessLogEntry,
  ServerMessage,
  ServiceName
} from "./types";

type Tab = "chat" | "services" | "logs" | "preview";

const TOKEN_KEY = "agentic-wormhole-token";

export function App() {
  const queryToken = new URLSearchParams(window.location.search).get("token") ?? "";
  const [token, setToken] = useState(() => window.localStorage.getItem(TOKEN_KEY) ?? queryToken);
  const [tokenDraft, setTokenDraft] = useState(token);

  const [bridges, setBridges] = useState<Record<string, BridgeSessionSnapshot>>({});
  const [services, setServices] = useState<Record<ServiceName, ManagedServiceSnapshot>>({
    frontend: {
      name: "frontend",
      status: "stopped",
      pid: null,
      startedAt: null,
      lastExitCode: null
    },
    backend: {
      name: "backend",
      status: "stopped",
      pid: null,
      startedAt: null,
      lastExitCode: null
    }
  });
  const [logs, setLogs] = useState<ProcessLogEntry[]>([]);
  const [terminalReplayBySession, setTerminalReplayBySession] = useState<Record<string, string>>({});

  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [menuOpen, setMenuOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [socketError, setSocketError] = useState("");
  const [logFilter, setLogFilter] = useState<"all" | ServiceName>("all");

  const wsRef = useRef<WebSocket | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeRenderedSessionRef = useRef<string>("");
  const renderedLengthRef = useRef<Record<string, number>>({});
  const activeSessionIdRef = useRef<string>("");

  const orderedSessions = useMemo(
    () => Object.values(bridges).sort((a, b) => b.updatedAt - a.updatedAt),
    [bridges]
  );

  const activeSession = selectedSessionId ? bridges[selectedSessionId] : orderedSessions[0];
  const activeSessionId = activeSession?.sessionId ?? "";
  const activeTerminalReplay = activeSessionId ? terminalReplayBySession[activeSessionId] ?? "" : "";

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const sendSessionInput = (sessionId: string, text: string) => {
    wsRef.current?.send(
      JSON.stringify({
        type: "bridge.input",
        sessionId,
        text
      })
    );
  };

  const sendSessionResize = (sessionId: string, cols: number, rows: number) => {
    wsRef.current?.send(
      JSON.stringify({
        type: "bridge.resize",
        sessionId,
        cols,
        rows
      })
    );
  };

  useEffect(() => {
    if (activeTab !== "chat") {
      if (terminalRef.current) {
        terminalRef.current.dispose();
        terminalRef.current = null;
      }
      fitAddonRef.current = null;
      activeRenderedSessionRef.current = "";
      renderedLengthRef.current = {};
      return;
    }

    const host = terminalHostRef.current;
    if (!host) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: 8_000,
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 13,
      lineHeight: 1.3,
      theme: {
        background: "#0f1220",
        foreground: "#e9edf5"
      }
    });

    terminal.open(host);
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    const fitAndSync = () => {
      try {
        fitAddon.fit();
      } catch {
        // Ignore fit errors during rapid remount/teardown on mobile.
      }

      const sessionId = activeSessionIdRef.current;
      if (!sessionId) {
        return;
      }
      sendSessionResize(sessionId, terminal.cols, terminal.rows);
    };

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) {
        return;
      }
      sendSessionResize(sessionId, cols, rows);
    });

    const onWindowResize = () => fitAndSync();
    window.addEventListener("resize", onWindowResize);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => fitAndSync());
      resizeObserver.observe(host);
    }

    terminal.onData((data) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) {
        return;
      }

      sendSessionInput(sessionId, data);
    });

    requestAnimationFrame(() => {
      fitAndSync();
      terminal.focus();
    });

    terminalRef.current = terminal;
    activeRenderedSessionRef.current = "";
    renderedLengthRef.current = {};

    return () => {
      resizeDisposable.dispose();
      window.removeEventListener("resize", onWindowResize);
      resizeObserver?.disconnect();
      terminal.dispose();
      if (terminalRef.current === terminal) {
        terminalRef.current = null;
      }
      if (fitAddonRef.current === fitAddon) {
        fitAddonRef.current = null;
      }
      activeRenderedSessionRef.current = "";
      renderedLengthRef.current = {};
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "chat") {
      return;
    }

    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) {
      return;
    }

    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        // Ignore fit errors during fast tab/session switches.
      }

      if (activeSessionId) {
        sendSessionResize(activeSessionId, terminal.cols, terminal.rows);
      }
    });
  }, [activeTab, activeSessionId]);

  useEffect(() => {
    if (activeTab !== "chat") {
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    if (!activeSessionId) {
      terminal.reset();
      activeRenderedSessionRef.current = "";
      return;
    }

    if (activeRenderedSessionRef.current !== activeSessionId) {
      terminal.reset();
      terminal.write(activeTerminalReplay);
      activeRenderedSessionRef.current = activeSessionId;
      renderedLengthRef.current[activeSessionId] = activeTerminalReplay.length;
      return;
    }

    const renderedLength = renderedLengthRef.current[activeSessionId] ?? 0;
    if (activeTerminalReplay.length < renderedLength) {
      terminal.reset();
      terminal.write(activeTerminalReplay);
      renderedLengthRef.current[activeSessionId] = activeTerminalReplay.length;
      return;
    }

    const delta = activeTerminalReplay.slice(renderedLength);
    if (delta.length > 0) {
      terminal.write(delta);
      renderedLengthRef.current[activeSessionId] = activeTerminalReplay.length;
    }
  }, [activeSessionId, activeTerminalReplay, activeTab]);

  useEffect(() => {
    if (!token) {
      return;
    }

    let alive = true;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/ws/ui?token=${encodeURIComponent(token)}`;

    const connect = () => {
      const socket = new WebSocket(url);
      wsRef.current = socket;

      socket.onopen = () => {
        if (!alive) {
          return;
        }
        setConnected(true);
        setSocketError("");
      };

      socket.onmessage = (event) => {
        if (!alive) {
          return;
        }

        const parsed = parseMessage(event.data);
        if (!parsed) {
          return;
        }

        if (parsed.type === "snapshot") {
          const nextBridges: Record<string, BridgeSessionSnapshot> = {};
          for (const bridge of parsed.bridges) {
            nextBridges[bridge.sessionId] = bridge;
          }

          const nextServices: Record<ServiceName, ManagedServiceSnapshot> = {
            frontend: services.frontend,
            backend: services.backend
          };

          for (const service of parsed.services) {
            nextServices[service.name] = service;
          }

          setBridges(nextBridges);
          setServices(nextServices);
          setLogs(parsed.logs);
          setTerminalReplayBySession(parsed.terminalReplayBySession ?? {});

          if (!selectedSessionId && parsed.bridges.length > 0) {
            setSelectedSessionId(parsed.bridges[0].sessionId);
          }
          return;
        }

        if (parsed.type === "bridge.updated") {
          setBridges((prev) => ({ ...prev, [parsed.session.sessionId]: parsed.session }));
          if (!selectedSessionId) {
            setSelectedSessionId(parsed.session.sessionId);
          }
          return;
        }

        if (parsed.type === "bridge.removed") {
          setBridges((prev) => {
            const next = { ...prev };
            delete next[parsed.sessionId];
            return next;
          });
          setTerminalReplayBySession((prev) => {
            const next = { ...prev };
            delete next[parsed.sessionId];
            return next;
          });
          return;
        }

        if (parsed.type === "bridge.raw") {
          setTerminalReplayBySession((prev) => {
            const existing = prev[parsed.sessionId] ?? "";
            const combined = `${existing}${parsed.chunk}`;
            const MAX_CHARS = 600_000;
            const trimmed =
              combined.length > MAX_CHARS ? combined.slice(combined.length - MAX_CHARS) : combined;
            return { ...prev, [parsed.sessionId]: trimmed };
          });
          return;
        }

        if (parsed.type === "log") {
          setLogs((prev) => {
            const next = [...prev, parsed.entry];
            return next.length > 3000 ? next.slice(next.length - 3000) : next;
          });
          return;
        }

        if (parsed.type === "service.updated") {
          setServices((prev) => ({ ...prev, [parsed.service.name]: parsed.service }));
          return;
        }

        if (parsed.type === "error") {
          setSocketError(parsed.message);
        }
      };

      socket.onclose = () => {
        if (!alive) {
          return;
        }
        setConnected(false);
        setTimeout(connect, 1_500);
      };

      socket.onerror = () => {
        setSocketError("WebSocket error");
      };
    };

    connect();

    return () => {
      alive = false;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [token]);

  const onSaveToken = (event: FormEvent) => {
    event.preventDefault();
    const normalized = tokenDraft.trim();
    window.localStorage.setItem(TOKEN_KEY, normalized);
    setToken(normalized);
  };

  const sendPrompt = (event: FormEvent) => {
    event.preventDefault();
    if (!activeSession || !prompt.trim()) {
      return;
    }

    const commandText = prompt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/g, "");
    if (!commandText) {
      return;
    }

    sendSessionInput(activeSession.sessionId, `${commandText}\n`);
    setPrompt("");
  };

  const sendKeyAction = (text: string) => {
    if (!activeSession || !connected) {
      return;
    }

    sendSessionInput(activeSession.sessionId, text);
  };

  const focusTerminal = () => {
    terminalRef.current?.focus();
  };

  const switchTab = (nextTab: Tab) => {
    setActiveTab(nextTab);
    setMenuOpen(false);
  };

  const runServiceAction = (service: ServiceName, action: "start" | "stop" | "restart" | "clean") => {
    wsRef.current?.send(
      JSON.stringify({
        type: "service.command",
        service,
        action
      })
    );
  };

  const filteredLogs = logs.filter((entry) => (logFilter === "all" ? true : entry.service === logFilter));
  const frontendPreviewSrc = resolveFrontendPreviewUrl(services.frontend.previewUrl, token);

  if (!token) {
    return (
      <main className="app-shell auth-shell">
        <section className="panel auth-panel">
          <h1>AgenticWormhole</h1>
          <p>Enter your access token from `AGENTIC_WORMHOLE_CONFIG.json`.</p>
          <form onSubmit={onSaveToken}>
            <input
              type="password"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              placeholder="access token"
              autoFocus
            />
            <button type="submit">Connect</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>AgenticWormhole</h1>
          <p className={connected ? "ok" : "bad"}>{connected ? "connected" : "disconnected"}</p>
        </div>
        <div className="topbar-right">
          <div className="session-picker">
            <label htmlFor="sessionSelect">Session</label>
            <select
              id="sessionSelect"
              value={activeSession?.sessionId ?? ""}
              onChange={(event) => setSelectedSessionId(event.target.value)}
            >
              {orderedSessions.length === 0 ? <option value="">No bridge session</option> : null}
              {orderedSessions.map((session) => (
                <option key={session.sessionId} value={session.sessionId}>
                  {session.tool} - {session.sessionId} {session.connected ? "(live)" : "(offline)"}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="mobileMenu"
            onClick={() => setMenuOpen((prev) => !prev)}
          >
            ☰ Menu
          </button>
        </div>
      </header>

      <nav className="tab-row desktop-tabs">
        <button className={activeTab === "chat" ? "active" : ""} onClick={() => switchTab("chat")}>Chat</button>
        <button className={activeTab === "services" ? "active" : ""} onClick={() => switchTab("services")}>Services</button>
        <button className={activeTab === "logs" ? "active" : ""} onClick={() => switchTab("logs")}>Logs</button>
        <button className={activeTab === "preview" ? "active" : ""} onClick={() => switchTab("preview")}>Preview</button>
      </nav>
      <nav id="mobileMenu" className={`mobile-menu ${menuOpen ? "open" : ""}`}>
        <button className={activeTab === "chat" ? "active" : ""} onClick={() => switchTab("chat")}>Chat</button>
        <button className={activeTab === "services" ? "active" : ""} onClick={() => switchTab("services")}>Services</button>
        <button className={activeTab === "logs" ? "active" : ""} onClick={() => switchTab("logs")}>Logs</button>
        <button className={activeTab === "preview" ? "active" : ""} onClick={() => switchTab("preview")}>Preview</button>
      </nav>

      {socketError ? <p className="error-banner">{socketError}</p> : null}

      <section className="panel main-panel">
        {activeTab === "chat" && (
          <>
            <div className="terminal-view">
              <div ref={terminalHostRef} className="terminal-host" />
              {!activeSession ? (
                <div className="empty-state terminal-empty">
                  Start `codex` or `claude` from a bridged shell to see terminal output here.
                </div>
              ) : null}
            </div>
            <form className="composer" onSubmit={sendPrompt}>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Prompt active session"
                rows={3}
              />
              <button type="submit" disabled={!activeSession || !connected}>
                Send
              </button>
            </form>
            <div className="keypad">
              <button type="button" disabled={!activeSession || !connected} onClick={focusTerminal}>
                Open Keyboard
              </button>
              <button type="button" disabled={!activeSession || !connected} onClick={() => sendKeyAction("\n")}>
                Enter
              </button>
              <button type="button" disabled={!activeSession || !connected} onClick={() => sendKeyAction("\u001B")}>
                Esc
              </button>
              <button type="button" disabled={!activeSession || !connected} onClick={() => sendKeyAction("\u001B[A")}>
                Up
              </button>
              <button type="button" disabled={!activeSession || !connected} onClick={() => sendKeyAction("\u001B[B")}>
                Down
              </button>
              <button type="button" disabled={!activeSession || !connected} onClick={() => sendKeyAction("\t")}>
                Tab
              </button>
              <button type="button" disabled={!activeSession || !connected} onClick={() => sendKeyAction("\u0003")}>
                Ctrl+C
              </button>
              <button type="button" disabled={!activeSession || !connected} onClick={() => sendKeyAction("\u0004")}>
                Ctrl+D
              </button>
              <button type="button" disabled={!activeSession || !connected} onClick={() => sendKeyAction("1\n")}>
                1+Enter
              </button>
              <button type="button" disabled={!activeSession || !connected} onClick={() => sendKeyAction("2\n")}>
                2+Enter
              </button>
              <button type="button" disabled={!activeSession || !connected} onClick={() => sendKeyAction("3\n")}>
                3+Enter
              </button>
            </div>
          </>
        )}

        {activeTab === "services" && (
          <div className="service-grid">
            {(["frontend", "backend"] as const).map((serviceName) => {
              const service = services[serviceName];
              return (
                <article key={serviceName} className="service-card">
                  <h2>{serviceName}</h2>
                  <p className={`status ${service.status}`}>{service.status}</p>
                  <p>PID: {service.pid ?? "-"}</p>
                  <p className="mono">{service.command ?? "No startCommand configured"}</p>
                  <div className="button-row">
                    <button onClick={() => runServiceAction(serviceName, "start")}>Start</button>
                    <button onClick={() => runServiceAction(serviceName, "stop")}>Stop</button>
                    <button onClick={() => runServiceAction(serviceName, "restart")}>Restart</button>
                    <button onClick={() => runServiceAction(serviceName, "clean")}>Clean</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {activeTab === "logs" && (
          <>
            <div className="log-toolbar">
              <button className={logFilter === "all" ? "active" : ""} onClick={() => setLogFilter("all")}>All</button>
              <button className={logFilter === "frontend" ? "active" : ""} onClick={() => setLogFilter("frontend")}>Frontend</button>
              <button className={logFilter === "backend" ? "active" : ""} onClick={() => setLogFilter("backend")}>Backend</button>
            </div>
            <div className="log-list">
              {filteredLogs.map((entry) => (
                <p key={entry.id} className={`log-line ${entry.stream}`}>
                  <span className="stamp">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                  <span className="tag">[{entry.service}:{entry.stream}]</span>
                  <span>{entry.message}</span>
                </p>
              ))}
            </div>
          </>
        )}

        {activeTab === "preview" && (
          <div className="preview-wrap">
            <iframe
              title="Frontend Preview"
              src={frontendPreviewSrc}
              sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin"
            />
          </div>
        )}
      </section>
    </main>
  );
}

function parseMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "string") {
    return null;
  }

  try {
    return JSON.parse(raw) as ServerMessage;
  } catch {
    return null;
  }
}

function resolveFrontendPreviewUrl(previewUrl: string | undefined, token: string): string {
  if (!previewUrl) {
    return `/preview/frontend?token=${encodeURIComponent(token)}`;
  }

  try {
    const parsed = new URL(previewUrl);
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      parsed.hostname = window.location.hostname;
    }
    return parsed.toString();
  } catch {
    return `/preview/frontend?token=${encodeURIComponent(token)}`;
  }
}
