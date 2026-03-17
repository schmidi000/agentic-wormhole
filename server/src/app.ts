import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { WebSocketServer, type WebSocket } from "ws";
import { BridgeHub } from "./bridge-hub.js";
import { loadConfig } from "./config.js";
import { ServiceController } from "./managed-service.js";
import type { BridgeToServerMessage, ServerToUiMessage, UiToServerMessage } from "./types.js";

const GARBAGE_COLLECTION_MS = 120_000;

export interface StartServerOptions {
  configPath?: string;
  dev?: boolean;
  hostOverride?: string;
  portOverride?: number;
}

export async function startServer(options: StartServerOptions): Promise<void> {
  const loaded = loadConfig(options.configPath);
  const config = loaded.config;

  if (options.hostOverride) {
    config.security.listenHost = options.hostOverride;
  }

  if (options.portOverride) {
    config.security.listenPort = options.portOverride;
  }

  const app = express();
  const server = http.createServer(app);

  const bridgeHub = new BridgeHub();
  const serviceController = new ServiceController(config.frontend, config.backend, loaded.baseDir);
  const uiSockets = new Set<WebSocket>();

  const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const token = readToken(req.headers["x-aw-token"], req.url);
    if (token !== config.security.accessToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };

  const broadcast = (message: ServerToUiMessage): void => {
    const payload = JSON.stringify(message);
    for (const socket of uiSockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  };

  const snapshot = (): ServerToUiMessage => ({
    type: "snapshot",
    bridges: bridgeHub.snapshots(),
    services: serviceController.snapshots(),
    logs: serviceController.getLogs(),
    terminalReplayBySession: bridgeHub.terminalReplays()
  });

  bridgeHub.on("updated", (session) => {
    broadcast({
      type: "bridge.updated",
      session
    });
  });

  bridgeHub.on("removed", (sessionId) => {
    broadcast({
      type: "bridge.removed",
      sessionId
    });
  });

  serviceController.on("log", (entry) => {
    broadcast({
      type: "log",
      entry
    });
  });

  serviceController.on("status", (service) => {
    broadcast({
      type: "service.updated",
      service
    });
  });

  app.get("/api/state", authMiddleware, (_req, res) => {
    res.json(snapshot());
  });

  if (config.frontend.previewUrl) {
    app.use(
      "/preview/frontend",
      authMiddleware,
      createProxyMiddleware({
        target: config.frontend.previewUrl,
        changeOrigin: true,
        ws: true,
        pathRewrite: (pathToRewrite) => pathToRewrite.replace(/^\/preview\/frontend/, "")
      })
    );
  } else {
    app.get("/preview/frontend", authMiddleware, (_req, res) => {
      res.status(404).send("frontend.previewUrl is not configured in AGENTIC_WORMHOLE_CONFIG.json");
    });
  }

  if (options.dev) {
    app.use(
      "/",
      createProxyMiddleware({
        target: "http://127.0.0.1:5178",
        changeOrigin: true,
        ws: true
      })
    );
  } else {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const bundledWebDist = path.resolve(currentDir, "web");
    const workspaceWebDist = path.resolve(currentDir, "../../web/dist");
    const webDist = fs.existsSync(bundledWebDist) ? bundledWebDist : workspaceWebDist;

    if (!fs.existsSync(webDist)) {
      throw new Error(`Web UI assets not found. Expected ${bundledWebDist} or ${workspaceWebDist}.`);
    }

    app.use(express.static(webDist));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  const uiWss = new WebSocketServer({ noServer: true });
  const bridgeWss = new WebSocketServer({ noServer: true });

  uiWss.on("connection", (socket) => {
    uiSockets.add(socket);
    socket.send(JSON.stringify(snapshot()));

    socket.on("close", () => {
      uiSockets.delete(socket);
    });

    socket.on("message", async (raw) => {
      const parsed = parseJson<UiToServerMessage>(raw.toString());
      if (!parsed) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      if (parsed.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (parsed.type === "bridge.input") {
        const ok = bridgeHub.sendInput(parsed.sessionId, parsed.text);
        if (!ok) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: `Bridge session ${parsed.sessionId} is not connected`
            })
          );
          return;
        }

        bridgeHub.recordUserInput(parsed.sessionId, parsed.text);
        return;
      }

      if (parsed.type === "bridge.resize") {
        const cols = Number.isFinite(parsed.cols) ? Math.max(20, Math.min(400, Math.floor(parsed.cols))) : 120;
        const rows = Number.isFinite(parsed.rows) ? Math.max(8, Math.min(160, Math.floor(parsed.rows))) : 40;
        bridgeHub.sendResize(parsed.sessionId, cols, rows);
        return;
      }

      if (parsed.type === "service.command") {
        await serviceController.execute(parsed.service, parsed.action);
      }
    });
  });

  bridgeWss.on("connection", (socket) => {
    let attachedSessionId: string | null = null;

    socket.on("close", () => {
      if (attachedSessionId) {
        bridgeHub.detach(attachedSessionId, null);
      }
    });

    socket.on("message", (raw) => {
      const parsed = parseJson<BridgeToServerMessage>(raw.toString());
      if (!parsed) {
        return;
      }

      if (parsed.type === "bridge.register") {
        attachedSessionId = parsed.sessionId;
        bridgeHub.attach(parsed.sessionId, socket, {
          tool: parsed.tool,
          commandLine: parsed.commandLine,
          cwd: parsed.cwd,
          pid: parsed.pid,
          startedAt: parsed.startedAt
        });
        return;
      }

      if (parsed.type === "bridge.output") {
        bridgeHub.recordOutput(parsed.sessionId, parsed.chunk);
        broadcast({
          type: "bridge.raw",
          sessionId: parsed.sessionId,
          chunk: parsed.chunk
        });
        return;
      }

      if (parsed.type === "bridge.exit") {
        bridgeHub.detach(parsed.sessionId, parsed.exitCode);
      }
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const pathname = request.url ? new URL(request.url, "http://localhost").pathname : "";

    const token = readToken(request.headers["x-aw-token"], request.url);
    if (token !== config.security.accessToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (pathname === "/ws/ui") {
      uiWss.handleUpgrade(request, socket, head, (ws) => {
        uiWss.emit("connection", ws, request);
      });
      return;
    }

    if (pathname === "/ws/bridge") {
      bridgeWss.handleUpgrade(request, socket, head, (ws) => {
        bridgeWss.emit("connection", ws, request);
      });
      return;
    }

    socket.destroy();
  });

  setInterval(() => {
    bridgeHub.removeDisconnectedOlderThan(2 * GARBAGE_COLLECTION_MS);
  }, GARBAGE_COLLECTION_MS).unref();

  await new Promise<void>((resolve) => {
    server.listen(config.security.listenPort, config.security.listenHost, () => {
      const host = config.security.listenHost;
      const port = config.security.listenPort;
      console.log(`[AgenticWormhole] server running on http://${host}:${port}`);
      console.log(`[AgenticWormhole] config: ${loaded.path}`);
      if (config.security.accessToken === "change-me-now") {
        console.log("[AgenticWormhole] warning: using default access token; change it before LAN exposure");
      }
      resolve();
    });
  });
}

function readToken(headerValue: string | string[] | undefined, requestUrl?: string): string | null {
  const tokenFromHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (tokenFromHeader && tokenFromHeader.trim().length > 0) {
    return tokenFromHeader.trim();
  }

  if (!requestUrl) {
    return null;
  }

  const tokenFromQuery = new URL(requestUrl, "http://localhost").searchParams.get("token");
  return tokenFromQuery;
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
