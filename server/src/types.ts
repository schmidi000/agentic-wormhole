export type ServiceName = "frontend" | "backend";

export type ServiceStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export interface ServiceConfig {
  cwd?: string;
  startCommand?: string;
  cleanCommand?: string;
  previewUrl?: string;
}

export interface SecurityConfig {
  listenHost: string;
  listenPort: number;
  accessToken: string;
}

export interface AppConfig {
  frontend: ServiceConfig;
  backend: ServiceConfig;
  security: SecurityConfig;
}

export interface ProcessLogEntry {
  id: string;
  service: ServiceName;
  stream: "stdout" | "stderr" | "system";
  message: string;
  timestamp: number;
}

export interface ManagedServiceSnapshot {
  name: ServiceName;
  status: ServiceStatus;
  pid: number | null;
  startedAt: number | null;
  lastExitCode: number | null;
  command?: string;
  cwd?: string;
  previewUrl?: string;
}

export interface BridgeMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

export interface BridgeSessionSnapshot {
  sessionId: string;
  tool: string;
  commandLine: string;
  cwd: string;
  pid: number | null;
  connected: boolean;
  startedAt: number;
  updatedAt: number;
  exitCode: number | null;
  messages: BridgeMessage[];
}

export type UiToServerMessage =
  | { type: "ping" }
  | { type: "bridge.input"; sessionId: string; text: string }
  | { type: "bridge.resize"; sessionId: string; cols: number; rows: number }
  | {
      type: "service.command";
      service: ServiceName;
      action: "start" | "stop" | "restart" | "clean";
    };

export type BridgeToServerMessage =
  | {
      type: "bridge.register";
      sessionId: string;
      tool: string;
      commandLine: string;
      cwd: string;
      pid: number;
      startedAt: number;
    }
  | { type: "bridge.output"; sessionId: string; chunk: string }
  | { type: "bridge.exit"; sessionId: string; exitCode: number | null }
  | { type: "bridge.heartbeat"; sessionId: string };

export type ServerToUiMessage =
  | {
      type: "snapshot";
      bridges: BridgeSessionSnapshot[];
      services: ManagedServiceSnapshot[];
      logs: ProcessLogEntry[];
      terminalReplayBySession: Record<string, string>;
    }
  | { type: "bridge.updated"; session: BridgeSessionSnapshot }
  | { type: "bridge.removed"; sessionId: string }
  | { type: "bridge.raw"; sessionId: string; chunk: string }
  | { type: "log"; entry: ProcessLogEntry }
  | { type: "service.updated"; service: ManagedServiceSnapshot }
  | { type: "error"; message: string }
  | { type: "pong" };

export type ServerToBridgeMessage =
  | { type: "bridge.input"; text: string }
  | { type: "bridge.resize"; cols: number; rows: number }
  | { type: "bridge.shutdown"; reason: string };
