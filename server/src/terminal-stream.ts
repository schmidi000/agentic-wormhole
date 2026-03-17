type ParserMode = "text" | "esc" | "csi" | "osc" | "oscEsc" | "dcs" | "dcsEsc";

export class TerminalStreamProcessor {
  private mode: ParserMode = "text";
  private line = "";
  private cursor = 0;
  private csiBuffer = "";
  private lastEmittedLine = "";
  private lastEmittedAt = 0;

  ingest(chunk: string, now: number): string[] {
    const emitted: string[] = [];

    for (const ch of chunk) {
      if (this.mode !== "text") {
        this.consumeEscape(ch);
        continue;
      }

      if (ch === "\u001B" || ch === "\u241B") {
        this.mode = "esc";
        continue;
      }

      if (ch === "\r") {
        this.cursor = 0;
        continue;
      }

      if (ch === "\n") {
        this.emitCurrentLine(now, emitted);
        continue;
      }

      if (ch === "\b" || ch === "\u007F") {
        this.backspace();
        continue;
      }

      if (!isPrintable(ch) && ch !== "\t") {
        continue;
      }

      this.overwrite(ch);
    }

    return emitted;
  }

  flush(now: number): string[] {
    const emitted: string[] = [];
    this.emitCurrentLine(now, emitted);
    return emitted;
  }

  private consumeEscape(ch: string): void {
    switch (this.mode) {
      case "esc":
        if (ch === "[") {
          this.csiBuffer = "";
          this.mode = "csi";
          return;
        }
        if (ch === "]") {
          this.mode = "osc";
          return;
        }
        if (ch === "P" || ch === "X" || ch === "^" || ch === "_") {
          this.mode = "dcs";
          return;
        }
        this.mode = "text";
        return;
      case "csi":
        if (isCsiFinalByte(ch)) {
          this.applyCsi(ch, this.csiBuffer);
          this.csiBuffer = "";
          this.mode = "text";
          return;
        }
        this.csiBuffer += ch;
        return;
      case "osc":
        if (ch === "\u0007") {
          this.mode = "text";
          return;
        }
        if (ch === "\u001B" || ch === "\u241B") {
          this.mode = "oscEsc";
        }
        return;
      case "oscEsc":
        this.mode = ch === "\\" ? "text" : "osc";
        return;
      case "dcs":
        if (ch === "\u001B" || ch === "\u241B") {
          this.mode = "dcsEsc";
        }
        return;
      case "dcsEsc":
        this.mode = ch === "\\" ? "text" : "dcs";
        return;
      case "text":
      default:
        return;
    }
  }

  private overwrite(ch: string): void {
    if (this.cursor >= this.line.length) {
      this.line += ch;
      this.cursor = this.line.length;
      return;
    }

    const start = this.line.slice(0, this.cursor);
    const end = this.line.slice(this.cursor + 1);
    this.line = `${start}${ch}${end}`;
    this.cursor += 1;
  }

  private applyCsi(finalByte: string, rawParams: string): void {
    const params = parseCsiParams(rawParams);
    const first = params[0] ?? 0;

    switch (finalByte) {
      case "D": {
        const amount = first === 0 ? 1 : first;
        this.cursor = Math.max(0, this.cursor - amount);
        return;
      }
      case "C": {
        const amount = first === 0 ? 1 : first;
        this.cursor = Math.min(this.line.length, this.cursor + amount);
        return;
      }
      case "G": {
        const column = first <= 0 ? 1 : first;
        this.cursor = Math.min(this.line.length, column - 1);
        return;
      }
      case "K": {
        const mode = first;
        if (mode === 0) {
          this.line = this.line.slice(0, this.cursor);
          return;
        }
        if (mode === 1) {
          this.line = this.line.slice(this.cursor);
          this.cursor = 0;
          return;
        }
        if (mode === 2) {
          this.line = "";
          this.cursor = 0;
        }
        return;
      }
      case "P": {
        const amount = first === 0 ? 1 : first;
        this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + amount);
        return;
      }
      default:
        return;
    }
  }

  private backspace(): void {
    if (this.cursor <= 0) {
      return;
    }

    const deleteIndex = this.cursor - 1;
    this.line = this.line.slice(0, deleteIndex) + this.line.slice(deleteIndex + 1);
    this.cursor = deleteIndex;
  }

  private emitCurrentLine(now: number, emitted: string[]): void {
    const normalized = this.line.replace(/\s+$/g, "");
    this.line = "";
    this.cursor = 0;

    if (!normalized) {
      return;
    }

    if (normalized === this.lastEmittedLine && now - this.lastEmittedAt < 900) {
      return;
    }

    this.lastEmittedLine = normalized;
    this.lastEmittedAt = now;
    emitted.push(normalized);
  }
}

function isPrintable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f && code <= 0x10ffff;
}

function isCsiFinalByte(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function parseCsiParams(raw: string): number[] {
  const cleaned = raw.replace(/[?<>=!]/g, "");
  if (!cleaned) {
    return [];
  }

  return cleaned
    .split(";")
    .map((part) => {
      const parsed = Number(part);
      return Number.isFinite(parsed) ? parsed : 0;
    });
}
