#!/usr/bin/env node
import process from "node:process";
import { startServer } from "./app.js";
import { runBridge } from "./bridge-client.js";

interface ParsedFlags {
  [key: string]: string | boolean | undefined;
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (!command) {
    await runToolShortcut("codex", rest, undefined);
    return;
  }

  switch (command) {
    case "serve": {
      const parsed = parseFlags(rest);
      await startServer({
        configPath: asString(parsed.config),
        dev: Boolean(parsed.dev),
        hostOverride: asString(parsed.host),
        portOverride: asNumber(parsed.port)
      });
      return;
    }
    case "start": {
      const parsed = parseFlags(rest);
      await startServer({
        configPath: asString(parsed.config),
        dev: Boolean(parsed.dev),
        hostOverride: asString(parsed.host),
        portOverride: asNumber(parsed.port)
      });
      return;
    }
    case "codex": {
      await runToolShortcut("codex", rest, "codex");
      return;
    }
    case "claude": {
      await runToolShortcut("claude", rest, "claude");
      return;
    }
    case "run": {
      const dividerIndex = rest.indexOf("--");
      const flagPart = dividerIndex >= 0 ? rest.slice(0, dividerIndex) : [];
      const cmdPart = dividerIndex >= 0 ? rest.slice(dividerIndex + 1) : rest;
      if (cmdPart.length === 0) {
        process.stderr.write("Usage: agentic-wormhole run [flags] -- <tool> [args...]\n");
        process.exit(1);
      }

      const parsed = parseFlags(flagPart);
      const [toolCmd, ...toolArgs] = cmdPart;
      await runBridge({
        sessionId: asString(parsed.session) ?? toolCmd,
        tool: asString(parsed.tool) ?? toolCmd,
        command: toolCmd,
        args: toolArgs,
        token: asString(parsed.token),
        wsBaseUrl: asString(parsed.url),
        configPath: asString(parsed.config)
      });
      return;
    }
    case "bridge": {
      const dividerIndex = rest.indexOf("--");
      const flagPart = dividerIndex >= 0 ? rest.slice(0, dividerIndex) : rest;
      const cmdPart = dividerIndex >= 0 ? rest.slice(dividerIndex + 1) : [];
      const parsed = parseFlags(flagPart);
      const [toolCmd = "codex", ...toolArgs] = cmdPart;

      await runBridge({
        sessionId: asString(parsed.session) ?? toolCmd,
        tool: asString(parsed.tool) ?? toolCmd,
        command: toolCmd,
        args: toolArgs,
        token: asString(parsed.token),
        wsBaseUrl: asString(parsed.url),
        configPath: asString(parsed.config)
      });
      return;
    }
    case "hooks": {
      const shell = rest[0] ?? "bash";
      process.stdout.write(buildShellHooks(shell));
      return;
    }
    case "--help":
    case "-h":
    case "help": {
      printUsage();
      return;
    }
    default: {
      if (command.startsWith("-")) {
        printUsage();
        process.exit(1);
      }

      await runToolShortcut(command, rest, command);
      return;
    }
  }
}

function parseFlags(argv: string[]): ParsedFlags {
  const out: ParsedFlags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) {
      continue;
    }

    const key = current.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }

    out[key] = next;
    i += 1;
  }

  return out;
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function printUsage(): void {
  process.stdout.write(`AgenticWormhole\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  agentic-wormhole serve [--config <path>] [--host <host>] [--port <port>] [--dev]\n`);
  process.stdout.write(`  agentic-wormhole start [--config <path>] [--host <host>] [--port <port>] [--dev]\n`);
  process.stdout.write(`  agentic-wormhole                # shortcut for: agentic-wormhole codex\n`);
  process.stdout.write(`  agentic-wormhole codex [args...] \n`);
  process.stdout.write(`  agentic-wormhole claude [args...] \n`);
  process.stdout.write(`  agentic-wormhole run [--session <id>] [--token <token>] [--url <ws-url>] [--config <path>] -- <tool> [args...]\n`);
  process.stdout.write(`  agentic-wormhole bridge [--session <id>] [--token <token>] [--url <ws-url>] -- <tool> [args...]\n`);
  process.stdout.write(`  agentic-wormhole hooks [bash|zsh]\n\n`);
}

function buildShellHooks(shell: string): string {
  if (shell !== "bash" && shell !== "zsh") {
    return `# Unsupported shell '${shell}'. Use bash or zsh.\n`;
  }

  const runner = cliInvocation();

  return `# AgenticWormhole hooks\n# Add to your ~/.${shell}rc:\n# eval "$(${runner} hooks ${shell})"\n\n` +
    `codex() {\n` +
    `  if [ -n "${"$"}AGENTIC_WORMHOLE_BYPASS" ]; then\n` +
    `    command codex "${"$"}@"\n` +
    `    return\n` +
    `  fi\n` +
    `  ${runner} codex "${"$"}@"\n` +
    `}\n\n` +
    `claude() {\n` +
    `  if [ -n "${"$"}AGENTIC_WORMHOLE_BYPASS" ]; then\n` +
    `    command claude "${"$"}@"\n` +
    `    return\n` +
    `  fi\n` +
    `  ${runner} claude "${"$"}@"\n` +
    `}\n`;
}

function cliInvocation(): string {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return "agentic-wormhole";
  }

  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function runToolShortcut(
  tool: string,
  argv: string[],
  defaultSessionId: string | undefined
): Promise<void> {
  const dividerIndex = argv.indexOf("--");
  if (dividerIndex === -1) {
    await runBridge({
      sessionId: defaultSessionId ?? tool,
      tool,
      command: tool,
      args: argv
    });
    return;
  }

  const flagPart = argv.slice(0, dividerIndex);
  const toolArgs = argv.slice(dividerIndex + 1);
  const parsed = parseFlags(flagPart);
  await runBridge({
    sessionId: asString(parsed.session) ?? defaultSessionId ?? tool,
    tool: asString(parsed.tool) ?? tool,
    command: tool,
    args: toolArgs,
    token: asString(parsed.token),
    wsBaseUrl: asString(parsed.url),
    configPath: asString(parsed.config)
  });
}

main().catch((error) => {
  process.stderr.write(`[AgenticWormhole] ${String(error)}\n`);
  process.exit(1);
});
