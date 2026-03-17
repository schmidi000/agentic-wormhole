import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { sanitizeTerminalOutput } from "./terminal-sanitize.js";
import type { BridgeMessage, BridgeSessionSnapshot } from "./types.js";
import { TerminalStreamProcessor } from "./terminal-stream.js";
import { clampBuffer, id } from "./utils.js";

interface BridgeSession {
  snapshot: BridgeSessionSnapshot;
  socket: WebSocket | null;
  lastAssistantMessageAt: number;
  processor: TerminalStreamProcessor;
  recentCanonicalLines: Array<{ key: string; at: number }>;
  recentUserInputs: Array<{ text: string; key: string; at: number }>;
  terminalReplay: string;
}

export class BridgeHub extends EventEmitter {
  private readonly sessions = new Map<string, BridgeSession>();

  snapshots(): BridgeSessionSnapshot[] {
    return [...this.sessions.values()].map((session) => session.snapshot);
  }

  terminalReplays(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [sessionId, session] of this.sessions.entries()) {
      out[sessionId] = session.terminalReplay;
    }
    return out;
  }

  attach(
    sessionId: string,
    socket: WebSocket,
    metadata: {
      tool: string;
      commandLine: string;
      cwd: string;
      pid: number;
      startedAt: number;
    }
  ): BridgeSessionSnapshot {
    const existing = this.sessions.get(sessionId);
    const baseMessages = existing?.snapshot.messages ?? [];

    const snapshot: BridgeSessionSnapshot = {
      sessionId,
      tool: metadata.tool,
      commandLine: metadata.commandLine,
      cwd: metadata.cwd,
      pid: metadata.pid,
      connected: true,
      startedAt: metadata.startedAt,
      updatedAt: Date.now(),
      exitCode: null,
      messages: baseMessages
    };

    const session: BridgeSession = {
      snapshot,
      socket,
      lastAssistantMessageAt: existing?.lastAssistantMessageAt ?? 0,
      processor: existing?.processor ?? new TerminalStreamProcessor(),
      recentCanonicalLines: existing?.recentCanonicalLines ?? [],
      recentUserInputs: existing?.recentUserInputs ?? [],
      terminalReplay: existing?.terminalReplay ?? ""
    };

    this.sessions.set(sessionId, session);
    this.emit("updated", snapshot);
    return snapshot;
  }

  detach(sessionId: string, exitCode: number | null = null): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const now = Date.now();
    const trailingLines = dropRecentlySeenLines(
      session,
      filterTerminalLines(session.snapshot.tool, session.processor.flush(now))
        .map((line) => stripUserEchoPrefix(session, line, now))
        .filter((line): line is string => Boolean(line && line.length > 0)),
      now
    );
    if (trailingLines.length > 0) {
      const cleanedChunk = trailingLines.join("\n");
      const messages = session.snapshot.messages;
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && now - session.lastAssistantMessageAt < 1_200) {
        last.content = appendChunk(last.content, cleanedChunk);
        last.timestamp = now;
      } else {
        this.pushMessage(session, {
          id: id("msg"),
          role: "assistant",
          content: cleanedChunk,
          timestamp: now
        });
      }
      session.lastAssistantMessageAt = now;
      session.snapshot.updatedAt = now;
    }

    session.socket = null;
    session.snapshot.connected = false;
    session.snapshot.exitCode = exitCode;
    session.snapshot.updatedAt = Date.now();

    this.emit("updated", session.snapshot);
  }

  removeDisconnectedOlderThan(ms: number): void {
    const threshold = Date.now() - ms;
    for (const [sessionId, session] of this.sessions.entries()) {
      if (!session.snapshot.connected && session.snapshot.updatedAt < threshold) {
        this.sessions.delete(sessionId);
        this.emit("removed", sessionId);
      }
    }
  }

  recordUserInput(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const cleaned = normalizeUserInputForMessage(text);
    if (!cleaned) {
      return;
    }

    rememberRecentUserInputs(session, cleaned, Date.now());

    this.pushMessage(session, {
      id: id("msg"),
      role: "user",
      content: cleaned,
      timestamp: Date.now()
    });
  }

  recordOutput(sessionId: string, chunk: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.terminalReplay = appendTerminalReplay(session.terminalReplay, chunk);

    const now = Date.now();
    const primaryLines = session.processor.ingest(chunk, now);
    const secondaryLines = extractSanitizedLines(session.snapshot.tool, chunk);
    const filteredLines = filterTerminalLines(session.snapshot.tool, dedupePreserveOrder([...primaryLines, ...secondaryLines]))
      .map((line) => stripUserEchoPrefix(session, line, now))
      .filter((line): line is string => Boolean(line && line.length > 0));
    const lines = dropRecentlySeenLines(session, filteredLines, now);
    if (lines.length === 0) {
      return;
    }

    const cleanedChunk = lines.join("\n");
    const messages = session.snapshot.messages;
    const last = messages[messages.length - 1];

    if (last && last.role === "assistant" && now - session.lastAssistantMessageAt < 1_200) {
      last.content = appendChunk(last.content, cleanedChunk);
      last.timestamp = now;
    } else {
      this.pushMessage(session, {
        id: id("msg"),
        role: "assistant",
        content: cleanedChunk,
        timestamp: now
      });
    }

    session.lastAssistantMessageAt = now;
    session.snapshot.updatedAt = now;
    this.emit("updated", session.snapshot);
  }

  sendInput(sessionId: string, text: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.socket || session.socket.readyState !== session.socket.OPEN) {
      return false;
    }

    session.socket.send(
      JSON.stringify({
        type: "bridge.input",
        text
      })
    );

    return true;
  }

  sendResize(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.socket || session.socket.readyState !== session.socket.OPEN) {
      return false;
    }

    session.socket.send(
      JSON.stringify({
        type: "bridge.resize",
        cols,
        rows
      })
    );

    return true;
  }

  getSession(sessionId: string): BridgeSessionSnapshot | undefined {
    return this.sessions.get(sessionId)?.snapshot;
  }

  private pushMessage(session: BridgeSession, message: BridgeMessage): void {
    session.snapshot.messages = clampBuffer([...session.snapshot.messages, message], 500);
    session.snapshot.updatedAt = Date.now();
    this.emit("updated", session.snapshot);
  }
}

function filterTerminalLines(tool: string, lines: string[]): string[] {
  const normalizedTool = tool.toLowerCase();
  const isCodex = normalizedTool.includes("codex");
  const isClaude = normalizedTool.includes("claude");

  const out: string[] = [];
  for (const rawLine of lines) {
    const normalized = rawLine.replace(/\s{2,}/g, " ").trim();
    if (!normalized) {
      continue;
    }

    if (isClaude) {
      if (isClaudeChromeLine(normalized)) {
        continue;
      }
      const cleaned = cleanClaudeLine(normalized);
      if (!cleaned || isClaudeFragmentLine(cleaned)) {
        continue;
      }
      out.push(cleaned);
      continue;
    }

    if (isCodex) {
      const expanded = expandCodexCompositeLine(cleanCodexLine(normalized));
      for (const candidate of expanded) {
        if (isCodexChromeLine(candidate) || isCodexFragmentLine(candidate)) {
          continue;
        }
        out.push(candidate);
      }
      continue;
    }

    out.push(normalized);
  }

  return out.filter((line) => line.length > 0);
}

function isCodexChromeLine(line: string): boolean {
  if (/^[›>]\s/.test(line) && !/^[›>]\s*\d+\./.test(line)) {
    return true;
  }
  if (/^Working(?:\s*\(|\.\.\.|$)/i.test(line)) {
    return true;
  }
  if (/^(?:[△⚠!]\s*)?Heads up, you have less than \d+% of your weekly limit left/i.test(line)) {
    return true;
  }
  if (/^(?:[△⚠!]\s*)?Under-development features enabled/i.test(line)) {
    return true;
  }
  if (/^Tip:\s*New /i.test(line)) {
    return true;
  }
  if (/^Use \/skills to list available skills$/i.test(line)) {
    return true;
  }
  if (/^gpt-[a-z0-9.-]+\s+(?:high|medium|low)\s*·/i.test(line)) {
    return true;
  }
  if (/esc\s*to\s*interrupt/i.test(line)) {
    return true;
  }
  if (/\/effort\b/i.test(line)) {
    return true;
  }
  if (/^\?\s+for shortcuts$/i.test(line)) {
    return true;
  }
  if (/@filename\b/i.test(line)) {
    return true;
  }
  return false;
}

function cleanCodexLine(line: string): string {
  return line
    .replace(/\besc to interrupt\)?/gi, " ")
    .replace(/\s*·\s*/g, " · ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanClaudeLine(line: string): string {
  return line
    .replace(/\s*·\s*/g, " · ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isClaudeChromeLine(line: string): boolean {
  if (/^Pasting text/i.test(line)) {
    return true;
  }
  if (/^[*+]\s*Enchanting/i.test(line)) {
    return true;
  }
  if (/^Enchanting/i.test(line)) {
    return true;
  }
  if (/^claude code v/i.test(line)) {
    return true;
  }
  if (/^sonnet\s/i.test(line)) {
    return true;
  }
  if (/^Heads up, you have less than \d+% of your weekly limit left/i.test(line)) {
    return true;
  }
  if (/^Under-development features enabled/i.test(line)) {
    return true;
  }
  if (/^Tip:\s*New /i.test(line)) {
    return true;
  }
  if (/^~?\/[^\s]+$/i.test(line)) {
    return true;
  }
  if (/^[›>]\s/.test(line)) {
    return true;
  }
  if (/esc\s*to\s*interrupt/i.test(line)) {
    return true;
  }
  if (/\/effort\b/i.test(line)) {
    return true;
  }
  if (/deliberating/i.test(line)) {
    return true;
  }
  if (/\(thinking\)|thinking\.\.\./i.test(line)) {
    return true;
  }
  return false;
}

function dropRecentlySeenLines(session: BridgeSession, lines: string[], now: number): string[] {
  const WINDOW_MS = 15_000;
  session.recentCanonicalLines = session.recentCanonicalLines.filter((entry) => now - entry.at <= WINDOW_MS);

  const out: string[] = [];
  for (const line of lines) {
    const key = canonicalizeForDedupe(line);
    if (!key) {
      continue;
    }

    const seen = session.recentCanonicalLines.some((entry) => entry.key === key);
    if (seen) {
      continue;
    }

    session.recentCanonicalLines.push({ key, at: now });
    out.push(line);
  }

  if (session.recentCanonicalLines.length > 240) {
    session.recentCanonicalLines = session.recentCanonicalLines.slice(session.recentCanonicalLines.length - 240);
  }

  return out;
}

function canonicalizeForDedupe(line: string): string {
  return line
    .toLowerCase()
    .replace(/\d+%/g, "")
    .replace(/gpt-[a-z0-9.-]+/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function dedupePreserveOrder(lines: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function extractSanitizedLines(tool: string, chunk: string): string[] {
  if (!chunk) {
    return [];
  }

  const normalizedTool = tool.toLowerCase();
  const isCodex = normalizedTool.includes("codex");
  const isClaude = normalizedTool.includes("claude");
  if (!isCodex && !isClaude) {
    return [];
  }

  const text = sanitizeTerminalOutput(chunk)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  if (isClaude) {
    const bulletLines = [...text.matchAll(/(?:^|\s)([•●]\s+[^\n\r]{4,260})/gm)]
      .map((match) => (match[1] ?? "").trim())
      .filter((line) => line.length > 0);

    return dedupePreserveOrder(bulletLines);
  }

  const inlineMenuLines = [...text.matchAll(/(?:^|\s)(\d+\.\s+[^\n\r]{4,240})/gm)]
    .map((match) => (match[1] ?? "").trim())
    .filter((line) => line.length > 0);

  const bulletLines = [...text.matchAll(/(?:^|\s)(•\s+[^\n\r]{4,260})/gm)]
    .map((match) => (match[1] ?? "").trim())
    .filter((line) => line.length > 0);

  const rateHeader = [...text.matchAll(/Approaching rate limits(?:\s+Switch to [^\n\r?]+\?)?/gi)]
    .map((match) => (match[0] ?? "").trim())
    .filter((line) => line.length > 0);

  const confirmLines = [...text.matchAll(/Press enter to confirm or esc to go back/gi)]
    .map((match) => (match[0] ?? "").trim())
    .filter((line) => line.length > 0);

  return dedupePreserveOrder([...bulletLines, ...rateHeader, ...inlineMenuLines, ...confirmLines]);
}

function isClaudeFragmentLine(line: string): boolean {
  if (line.length <= 1) {
    return true;
  }
  if (/^[+*]?[a-z]{1,2}$/i.test(line)) {
    return true;
  }
  if (/^[+*][a-z]{1,6}$/i.test(line)) {
    return true;
  }
  if (/^[a-z]{1,2}\.?$/i.test(line) && !/^(hi|ok|no|yo)\.?$/i.test(line)) {
    return true;
  }
  if (/^[^a-z0-9]{1,3}$/i.test(line)) {
    return true;
  }
  return false;
}

function isCodexFragmentLine(line: string): boolean {
  if (/^\d+$/.test(line)) {
    return true;
  }
  if (/^\.*[Ww](?:o|or|ork|orki|orkin|orking)?$/.test(line)) {
    return true;
  }
  if (/^[a-z]{1,2}$/i.test(line) && !/^(ok|hi|no)$/i.test(line)) {
    return true;
  }
  if (/^[+*]\w{1,6}$/i.test(line)) {
    return true;
  }
  if (/^[^a-z0-9]{1,3}$/i.test(line)) {
    return true;
  }
  return false;
}

function expandCodexCompositeLine(line: string): string[] {
  const normalized = line.trim();
  if (!normalized) {
    return [];
  }

  const out: string[] = [];
  if (/Approaching rate limits/i.test(normalized) && /\b1\.\s+/.test(normalized)) {
    const pressMatch = normalized.match(/Press enter to confirm or esc to go back/i);
    const withoutPress = pressMatch
      ? normalized.slice(0, normalized.toLowerCase().indexOf(pressMatch[0].toLowerCase())).trim()
      : normalized;
    const splitAtFirstOption = withoutPress.split(/\s(?=1\.\s+)/);
    const prefix = splitAtFirstOption[0]?.trim();
    const optionBlob = splitAtFirstOption.slice(1).join(" ").trim();

    if (prefix) {
      out.push(prefix);
    }

    if (optionBlob) {
      const options = [...optionBlob.matchAll(/(\d+\.\s+.*?)(?=\s+\d+\.\s+|$)/g)]
        .map((match) => (match[1] ?? "").trim())
        .filter((part) => part.length > 0);
      out.push(...options);
    }

    if (pressMatch) {
      out.push(pressMatch[0]);
    }

    return out.length > 0 ? dedupePreserveOrder(out) : [normalized];
  }

  return [normalized];
}

function normalizeUserInputForMessage(text: string): string {
  // Ignore control-only key actions (Esc/arrows/Ctrl+key) in chat transcript.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u001B]/.test(text)) {
    return "";
  }

  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function rememberRecentUserInputs(session: BridgeSession, content: string, now: number): void {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    const key = canonicalizeUserEcho(line);
    if (!key) {
      continue;
    }

    session.recentUserInputs.push({
      text: line,
      key,
      at: now
    });
  }

  if (session.recentUserInputs.length > 80) {
    session.recentUserInputs = session.recentUserInputs.slice(session.recentUserInputs.length - 80);
  }
}

function stripUserEchoPrefix(session: BridgeSession, line: string, now: number): string {
  const WINDOW_MS = 120_000;
  session.recentUserInputs = session.recentUserInputs.filter((entry) => now - entry.at <= WINDOW_MS);

  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }

  const canonicalLine = canonicalizeUserEcho(trimmed);
  if (!canonicalLine) {
    return "";
  }

  const candidates = [...session.recentUserInputs].sort((a, b) => b.text.length - a.text.length);
  for (const candidate of candidates) {
    if (canonicalLine === candidate.key) {
      return "";
    }

    const stripped = stripPrefixMatch(trimmed, candidate.text);
    if (stripped === null) {
      continue;
    }

    const canonicalStripped = canonicalizeUserEcho(stripped);
    if (!canonicalStripped || canonicalStripped === candidate.key) {
      return "";
    }

    return stripped;
  }

  return trimmed;
}

function stripPrefixMatch(source: string, prefix: string): string | null {
  const normalizedPrefix = prefix.trim();
  if (!normalizedPrefix) {
    return null;
  }

  if (!source.toLowerCase().startsWith(normalizedPrefix.toLowerCase())) {
    return null;
  }

  const boundary = source.charAt(normalizedPrefix.length);
  if (boundary && /[a-z0-9_]/i.test(boundary)) {
    return null;
  }

  return source
    .slice(normalizedPrefix.length)
    .replace(/^[\s:;,.!?-]+/g, "")
    .trim();
}

function canonicalizeUserEcho(line: string): string {
  return line
    .toLowerCase()
    .replace(/^[›>]\s*/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function appendChunk(existing: string, incoming: string): string {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }
  if (existing.endsWith("\n")) {
    return `${existing}${incoming}`;
  }
  return `${existing}\n${incoming}`;
}

function appendTerminalReplay(existing: string, incoming: string): string {
  if (!incoming) {
    return existing;
  }

  const next = `${existing}${incoming}`;
  const MAX_CHARS = 600_000;
  if (next.length <= MAX_CHARS) {
    return next;
  }

  return next.slice(next.length - MAX_CHARS);
}
