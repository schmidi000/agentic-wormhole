import { EventEmitter } from "node:events";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { ManagedServiceSnapshot, ProcessLogEntry, ServiceConfig, ServiceName, ServiceStatus } from "./types.js";
import { clampBuffer, id } from "./utils.js";

const FORCE_KILL_AFTER_MS = 6_000;

interface ServiceEvents {
  log: (entry: ProcessLogEntry) => void;
  status: (snapshot: ManagedServiceSnapshot) => void;
}

export class ManagedService extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private status: ServiceStatus = "stopped";
  private startedAt: number | null = null;
  private lastExitCode: number | null = null;

  constructor(
    private readonly name: ServiceName,
    private readonly config: ServiceConfig,
    private readonly configBaseDir: string
  ) {
    super();
  }

  on<E extends keyof ServiceEvents>(event: E, listener: ServiceEvents[E]): this {
    return super.on(event, listener);
  }

  emit<E extends keyof ServiceEvents>(event: E, ...args: Parameters<ServiceEvents[E]>): boolean {
    return super.emit(event, ...(args as any[]));
  }

  snapshot(): ManagedServiceSnapshot {
    return {
      name: this.name,
      status: this.status,
      pid: this.process?.pid ?? null,
      startedAt: this.startedAt,
      lastExitCode: this.lastExitCode,
      command: this.config.startCommand,
      cwd: this.resolveCwd(),
      previewUrl: this.config.previewUrl
    };
  }

  isRunning(): boolean {
    return this.status === "running" || this.status === "starting";
  }

  async start(): Promise<void> {
    if (this.isRunning()) {
      this.writeSystemLog("already running");
      return;
    }

    const command = this.config.startCommand;
    if (!command) {
      this.writeSystemLog("startCommand is not configured");
      return;
    }

    const cwd = this.resolveCwd();
    this.status = "starting";
    this.publishStatus();
    this.writeSystemLog(`starting: ${command}`);

    this.process = spawn(command, {
      cwd,
      env: process.env,
      shell: true,
      stdio: "pipe",
      detached: process.platform !== "win32"
    });

    this.startedAt = Date.now();
    this.status = "running";
    this.publishStatus();

    this.process.stdout.on("data", (chunk: Buffer) => {
      this.writeLog("stdout", chunk.toString("utf8"));
    });

    this.process.stderr.on("data", (chunk: Buffer) => {
      this.writeLog("stderr", chunk.toString("utf8"));
    });

    this.process.on("error", (err) => {
      this.status = "error";
      this.publishStatus();
      this.writeSystemLog(`process error: ${err.message}`);
    });

    this.process.on("close", (code) => {
      this.lastExitCode = code;
      this.status = "stopped";
      this.process = null;
      this.publishStatus();
      this.writeSystemLog(`exited with code ${code ?? "null"}`);
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      this.writeSystemLog("already stopped");
      return;
    }

    this.status = "stopping";
    this.publishStatus();

    const processRef = this.process;
    const pid = processRef.pid;
    if (pid === undefined) {
      this.writeSystemLog("stopping process with unknown PID");
      processRef.kill("SIGTERM");

      let forceKillTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        waitForClose(processRef),
        new Promise<void>((resolve) => {
          forceKillTimer = setTimeout(() => {
            if (this.process === processRef) {
              processRef.kill("SIGKILL");
            }
            resolve();
          }, FORCE_KILL_AFTER_MS);
        })
      ]);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      return;
    }

    this.writeSystemLog(`stopping PID ${pid}`);

    await terminateProcessTree(pid, "SIGTERM");

    let forceKillTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      waitForClose(processRef),
      new Promise<void>((resolve) => {
        forceKillTimer = setTimeout(async () => {
          if (this.process && this.process.pid === pid) {
            this.writeSystemLog(`force-killing PID ${pid}`);
            await terminateProcessTree(pid, "SIGKILL");
          }
          resolve();
        }, FORCE_KILL_AFTER_MS);
      })
    ]);
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }

    if (this.process) {
      await waitForClose(this.process);
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async clean(): Promise<void> {
    const command = this.config.cleanCommand;
    if (!command) {
      this.writeSystemLog("cleanCommand is not configured");
      return;
    }

    const cwd = this.resolveCwd();
    this.writeSystemLog(`cleaning: ${command}`);

    await new Promise<void>((resolve) => {
      const cleanProc = spawn(command, {
        cwd,
        env: process.env,
        shell: true,
        stdio: "pipe"
      });

      cleanProc.stdout.on("data", (chunk: Buffer) => {
        this.writeLog("stdout", chunk.toString("utf8"));
      });

      cleanProc.stderr.on("data", (chunk: Buffer) => {
        this.writeLog("stderr", chunk.toString("utf8"));
      });

      cleanProc.on("close", (code) => {
        this.writeSystemLog(`clean exited with code ${code ?? "null"}`);
        resolve();
      });

      cleanProc.on("error", (error) => {
        this.writeSystemLog(`clean error: ${error.message}`);
        resolve();
      });
    });
  }

  private resolveCwd(): string {
    const cwd = this.config.cwd;
    if (!cwd) {
      return this.configBaseDir;
    }

    return path.isAbsolute(cwd) ? cwd : path.resolve(this.configBaseDir, cwd);
  }

  private publishStatus(): void {
    this.emit("status", this.snapshot());
  }

  private writeSystemLog(message: string): void {
    this.writeLog("system", message);
  }

  private writeLog(stream: ProcessLogEntry["stream"], message: string): void {
    const lines = message
      .replace(/\r/g, "")
      .split("\n")
      .filter((line) => line.trim().length > 0);

    for (const line of lines) {
      const entry: ProcessLogEntry = {
        id: id("log"),
        service: this.name,
        stream,
        message: line,
        timestamp: Date.now()
      };
      this.emit("log", entry);
    }
  }
}

function waitForClose(processRef: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise<void>((resolve) => {
    if (processRef.exitCode !== null || processRef.signalCode !== null) {
      resolve();
      return;
    }
    processRef.once("close", () => resolve());
  });
}

async function terminateProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    await new Promise<void>((resolve) => {
      execFile("taskkill", args, () => resolve());
    });
    return;
  }

  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fallback to single-process kill when process groups are unavailable.
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Ignore already-exited processes.
  }
}

export class ServiceController extends EventEmitter {
  private readonly services: Record<ServiceName, ManagedService>;
  private logs: ProcessLogEntry[] = [];

  constructor(frontend: ServiceConfig, backend: ServiceConfig, configBaseDir: string) {
    super();
    this.services = {
      frontend: new ManagedService("frontend", frontend, configBaseDir),
      backend: new ManagedService("backend", backend, configBaseDir)
    };

    for (const service of Object.values(this.services)) {
      service.on("log", (entry) => {
        this.logs = clampBuffer([...this.logs, entry], 2_500);
        this.emit("log", entry);
      });
      service.on("status", (snapshot) => {
        this.emit("status", snapshot);
      });
    }
  }

  snapshots(): ManagedServiceSnapshot[] {
    return Object.values(this.services).map((service) => service.snapshot());
  }

  getLogs(): ProcessLogEntry[] {
    return this.logs;
  }

  async execute(serviceName: ServiceName, action: "start" | "stop" | "restart" | "clean"): Promise<void> {
    const service = this.services[serviceName];

    switch (action) {
      case "start":
        await service.start();
        break;
      case "stop":
        await service.stop();
        break;
      case "restart":
        await service.restart();
        break;
      case "clean":
        await service.clean();
        break;
      default:
        break;
    }
  }
}
