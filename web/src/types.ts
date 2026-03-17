export type Role = "user" | "assistant" | "system";
export type ServiceName = "frontend" | "backend";

export interface BridgeMessage {
  id: string;
  role: Role;
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

export interface ManagedServiceSnapshot {
  name: ServiceName;
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  pid: number | null;
  startedAt: number | null;
  lastExitCode: number | null;
  command?: string;
  cwd?: string;
  previewUrl?: string;
}

export interface ProcessLogEntry {
  id: string;
  service: ServiceName;
  stream: "stdout" | "stderr" | "system";
  message: string;
  timestamp: number;
}

export type ServerMessage =
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
