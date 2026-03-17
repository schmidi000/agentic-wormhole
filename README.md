# AgenticWormhole 🌀

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Contributions Welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg?style=flat)](CONTRIBUTING.md)

Whether you call yourself a vibecoder or an agentic engineer, you know the problem: you have to step away from your machine, but your AI coding companion is still there waiting. If you've ever thought, *"How cool would it be if I could code from my phone?"* — this project is for you.

AgenticWormhole provides a seamless web interface that lets you communicate with your AI models, manage your local applications, and preview your work from anywhere.

AgenticWormhole is a local-first control plane for coding agents and full-stack apps.

## 🚀 Features

- **Multi-Model Support:** Talk to Codex, Claude, and other leading models.
- **Remote Execution:** Start and stop your local applications via the web interface.
- **Live Logging:** Stream and read your application's log output in real-time.
- **Interactive Web Preview:** Web builders can click through and test previews of their web apps directly inside AgenticWormhole.

The agent process stays in a real local terminal PTY, so terminal-specific behavior (title updates, ANSI UI, MCP-aware behavior) continues to work.

## Status
Current version: `0.1.0` (MVP).

## Architecture
- `server/`: Node.js + TypeScript runtime
  - PTY bridge (`node-pty`) for Codex/Claude
  - WebSocket hub for UI and bridge clients
  - managed service runner for frontend/backend commands
- `web/`: React + Vite smartphone-first UI
- Root workspace: npm workspaces

## Quick Start
1. Install dependencies:
```bash
npm install
```

2. Copy and edit config:
```bash
cp AGENTIC_WORMHOLE_CONFIG.example.json AGENTIC_WORMHOLE_CONFIG.json
```

3. Set a strong `security.accessToken` in `AGENTIC_WORMHOLE_CONFIG.json`.

4. Build:
```bash
npm run build
```

5. Install CLI once:

Install from npm (recommended):
```bash
npm install -g agentic-wormhole
```
The npm package contains both the server CLI and the web UI assets.

Install from local source (for contributors):
```bash
npm link --workspace server
```

6. In your target project directory (the one containing `AGENTIC_WORMHOLE_CONFIG.json`), start server:
```bash
agentic-wormhole serve
```

7. Open from your phone:
- `http://<your-lan-ip>:8787`
- enter your token

8. In another terminal (same target project), start Codex bridged:
```bash
agentic-wormhole
```
Equivalent explicit forms:
```bash
agentic-wormhole codex
agentic-wormhole claude
```

## Optional Terminal Hooks (Advanced)
If you still want native `codex` / `claude` commands auto-bridged, hooks are available:

```bash
eval "$(node server/dist/cli.js hooks bash)"
```

Bypass hook for one command:

```bash
AGENTIC_WORMHOLE_BYPASS=1 codex
```

## Service Control
Configure these in `AGENTIC_WORMHOLE_CONFIG.json`:
- `frontend.startCommand`
- `frontend.cleanCommand`
- `backend.startCommand`
- `backend.cleanCommand`

Then use the mobile UI `Services` tab for:
- `Start`
- `Stop`
- `Restart`
- `Clean`

## Frontend Preview
Set `frontend.previewUrl`, for example:
- Vite: `http://127.0.0.1:5173`
- Next.js: `http://127.0.0.1:3000`

For phone accessibility, run your frontend dev server with host binding (example Vite):
```bash
npm run dev -- --host 0.0.0.0 --port 5173
```

## Example Configs

### Node frontend + Node backend
```json
{
  "frontend": {
    "cwd": "../my-app/frontend",
    "startCommand": "npm run dev -- --host 0.0.0.0 --port 5173",
    "cleanCommand": "npm ci",
    "previewUrl": "http://127.0.0.1:5173"
  },
  "backend": {
    "cwd": "../my-app/backend",
    "startCommand": "npm run dev",
    "cleanCommand": "npm ci"
  },
  "security": {
    "listenHost": "0.0.0.0",
    "listenPort": 8787,
    "accessToken": "replace-with-strong-token"
  }
}
```

### React frontend + Spring backend
```json
{
  "frontend": {
    "cwd": "../fullstack/ui",
    "startCommand": "npm run dev -- --host 0.0.0.0 --port 5173",
    "cleanCommand": "npm ci",
    "previewUrl": "http://127.0.0.1:5173"
  },
  "backend": {
    "cwd": "../fullstack/api",
    "startCommand": "./gradlew bootRun",
    "cleanCommand": "./gradlew clean build"
  },
  "security": {
    "listenHost": "0.0.0.0",
    "listenPort": 8787,
    "accessToken": "replace-with-strong-token"
  }
}
```

## CLI
```bash
agentic-wormhole serve [--config <path>] [--host <host>] [--port <port>] [--dev]
agentic-wormhole start [--config <path>] [--host <host>] [--port <port>] [--dev]
agentic-wormhole
agentic-wormhole codex [args...]
agentic-wormhole claude [args...]
agentic-wormhole run [--session <id>] [--token <token>] [--url <ws-url>] [--config <path>] -- <tool> [args...]
agentic-wormhole bridge [--session <id>] [--token <token>] [--url <ws-url>] -- <tool> [args...]
agentic-wormhole hooks [bash|zsh]
```

## Development
```bash
npm run dev
```
- Web UI: `http://localhost:5178`
- Server: `http://localhost:8787`

## Automated npm Releases
This repo is configured to auto-release the CLI package from `server/` to npm on every push to `main` via GitHub Actions + semantic-release.

Release workflow:
- file: `.github/workflows/release.yml`
- trigger: push to `main`
- steps: `npm ci` -> `typecheck` -> `build` -> `semantic-release`

Release config:
- file: `.releaserc.cjs`
- publishes package: `agentic-wormhole`
- updates `CHANGELOG.md`
- creates GitHub Release

Commit convention for version bumps:
- `feat:` -> minor
- `fix:` / `perf:` -> patch
- `feat!:` or `BREAKING CHANGE:` -> major

Dry-run locally:
```bash
npm run release:dry
```

## Supported Platforms
- Linux
- macOS
- Windows (PowerShell/cmd shells supported by Node runtime and `node-pty`)

## Security Notes
- Always change `accessToken` from default.
- Avoid exposing this service beyond trusted LAN/VPN.
- Treat bridged sessions as highly privileged local shell access.

## Troubleshooting
- If the terminal in the Web UI is black, switch tabs (for example `Services`, `Logs`, or `Preview`) and then return to `Chat`.

## License
MIT

Inspired by [VibeTunnel](https://vibetunnel.sh/)
