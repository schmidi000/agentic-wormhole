import process from "node:process";
import WebSocket from "ws";
import pty from "node-pty";
import { loadConfig } from "./config.js";
import type { ServerToBridgeMessage } from "./types.js";

interface BridgeRunOptions {
  sessionId: string;
  tool: string;
  command: string;
  args: string[];
  token?: string;
  wsBaseUrl?: string;
  configPath?: string;
}

export async function runBridge(options: BridgeRunOptions): Promise<void> {
  const loaded = loadConfig(options.configPath);
  const token = options.token ?? loaded.config.security.accessToken;
  const wsUrl =
    options.wsBaseUrl ?? `ws://127.0.0.1:${loaded.config.security.listenPort}/ws/bridge?token=${encodeURIComponent(token)}`;

  const initialCols = Number(process.env.AGENTIC_WORMHOLE_PTY_COLS ?? "120") || 120;
  const initialRows = Number(process.env.AGENTIC_WORMHOLE_PTY_ROWS ?? "40") || 40;

  const ptyProcess = pty.spawn(options.command, options.args, {
    name: "xterm-256color",
    cols: clampInt(initialCols, 20, 400),
    rows: clampInt(initialRows, 8, 160),
    cwd: process.cwd(),
    env: process.env as Record<string, string>
  });

  const ws = new WebSocket(wsUrl);
  let wsReady = false;
  let kittyKeyboardProtocol = false;
  let bracketedPasteMode = false;
  const toolMode = detectToolMode(options.tool);
  const pendingOutput: string[] = [];

  const sendBridgeMessage = (data: unknown): void => {
    const payload = JSON.stringify(data);
    if (wsReady && ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  };

  const flushOutput = (): void => {
    if (!wsReady || ws.readyState !== ws.OPEN) {
      return;
    }

    while (pendingOutput.length > 0) {
      const chunk = pendingOutput.shift();
      if (!chunk) {
        continue;
      }
      sendBridgeMessage({
        type: "bridge.output",
        sessionId: options.sessionId,
        chunk
      });
    }
  };

  ptyProcess.onData((chunk) => {
    kittyKeyboardProtocol = updateKittyKeyboardProtocolMode(kittyKeyboardProtocol, chunk);
    bracketedPasteMode = updateBracketedPasteMode(bracketedPasteMode, chunk);
    process.stdout.write(chunk);
    pendingOutput.push(chunk);
    flushOutput();
  });

  const onStdin = (buffer: Buffer): void => {
    ptyProcess.write(buffer.toString("utf8"));
  };

  process.stdin.resume();
  process.stdin.on("data", onStdin);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  ws.on("open", () => {
    wsReady = true;
    sendBridgeMessage({
      type: "bridge.register",
      sessionId: options.sessionId,
      tool: options.tool,
      commandLine: [options.command, ...options.args].join(" "),
      cwd: process.cwd(),
      pid: ptyProcess.pid,
      startedAt: Date.now()
    });
    flushOutput();
  });

  ws.on("message", (raw) => {
    const parsed = parseJson<ServerToBridgeMessage>(raw.toString());
    if (!parsed) {
      return;
    }

    if (parsed.type === "bridge.input") {
      writeRemoteInput(ptyProcess, parsed.text, {
        kittyKeyboardProtocol,
        bracketedPasteMode,
        toolMode
      });
      return;
    }

    if (parsed.type === "bridge.resize") {
      try {
        ptyProcess.resize(clampInt(parsed.cols, 20, 400), clampInt(parsed.rows, 8, 160));
      } catch {
        // Ignore resize errors when PTY closes quickly.
      }
      return;
    }

    if (parsed.type === "bridge.shutdown") {
      ptyProcess.kill();
    }
  });

  ws.on("error", (error) => {
    process.stderr.write(`\n[AgenticWormhole] bridge websocket error: ${error.message}\n`);
  });

  ptyProcess.onExit(({ exitCode }) => {
    sendBridgeMessage({
      type: "bridge.exit",
      sessionId: options.sessionId,
      exitCode
    });

    if (ws.readyState === ws.OPEN) {
      ws.close();
    }

    teardown();
    process.exit(exitCode ?? 0);
  });

  process.on("SIGINT", () => {
    ptyProcess.kill();
  });

  process.on("SIGTERM", () => {
    ptyProcess.kill();
  });

  function teardown(): void {
    process.stdin.off("data", onStdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  }
}

interface InputModes {
  kittyKeyboardProtocol: boolean;
  bracketedPasteMode: boolean;
  toolMode: "codex" | "claude" | "generic";
}

function writeRemoteInput(ptyProcess: pty.IPty, input: string, modes: InputModes): void {
  if (containsRawControlInput(input)) {
    ptyProcess.write(input);
    return;
  }

  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let segment = "";
  const useBracketedPaste = modes.toolMode === "codex" && modes.bracketedPasteMode;

  const flushSegment = () => {
    if (!segment) {
      return;
    }
    if (useBracketedPaste) {
      writeBracketedPaste(ptyProcess, segment);
    } else {
      ptyProcess.write(segment);
    }
    segment = "";
  };

  for (const char of normalized) {
    if (char === "\n") {
      flushSegment();
      sendEnter(ptyProcess, modes.kittyKeyboardProtocol);
      continue;
    }
    segment += char;
  }

  flushSegment();
}

function sendEnter(ptyProcess: pty.IPty, kittyKeyboardProtocol: boolean): void {
  if (kittyKeyboardProtocol) {
    // Kitty keyboard protocol Enter key.
    ptyProcess.write("\u001B[13;1u");
    return;
  }
  ptyProcess.write("\r");
}

function writeBracketedPaste(ptyProcess: pty.IPty, text: string): void {
  ptyProcess.write(`\u001B[200~${text}\u001B[201~`);
}

function updateKittyKeyboardProtocolMode(previous: boolean, chunk: string): boolean {
  let mode = previous;

  // Enable progressive keyboard protocol levels: CSI > Ps u
  const enableMatches = chunk.matchAll(/\u001B\[\>(\d+)u/g);
  for (const match of enableMatches) {
    const level = Number(match[1] ?? "0");
    if (level > 0) {
      mode = true;
    }
  }

  // Disable kitty keyboard protocol: CSI < u
  if (chunk.includes("\u001B[<u")) {
    mode = false;
  }

  return mode;
}

function updateBracketedPasteMode(previous: boolean, chunk: string): boolean {
  let mode = previous;

  if (chunk.includes("\u001B[?2004h")) {
    mode = true;
  }
  if (chunk.includes("\u001B[?2004l")) {
    mode = false;
  }

  return mode;
}

function detectToolMode(tool: string): "codex" | "claude" | "generic" {
  const normalized = tool.toLowerCase();
  if (normalized.includes("codex")) {
    return "codex";
  }
  if (normalized.includes("claude")) {
    return "claude";
  }
  return "generic";
}

function containsRawControlInput(input: string): boolean {
  // Preserve low-level key chords (Esc/Ctrl combinations), but allow CR/LF/TAB
  // to flow through normal newline-aware handling.
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u001B]/.test(input);
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const normalized = Math.floor(value);
  return Math.max(min, Math.min(max, normalized));
}
