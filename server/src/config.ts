import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "./types.js";

const serviceSchema = z.object({
  cwd: z.string().optional(),
  startCommand: z.string().optional(),
  cleanCommand: z.string().optional(),
  previewUrl: z.string().url().optional()
});

const configSchema = z.object({
  frontend: serviceSchema.default({}),
  backend: serviceSchema.default({}),
  security: z
    .object({
      listenHost: z.string().default("0.0.0.0"),
      listenPort: z.number().int().positive().default(8787),
      accessToken: z.string().min(1).default("change-me-now")
    })
    .default({
      listenHost: "0.0.0.0",
      listenPort: 8787,
      accessToken: "change-me-now"
    })
});

const defaults: AppConfig = {
  frontend: {},
  backend: {},
  security: {
    listenHost: "0.0.0.0",
    listenPort: 8787,
    accessToken: "change-me-now"
  }
};

export interface LoadedConfig {
  path: string;
  baseDir: string;
  config: AppConfig;
}

export function loadConfig(inputPath?: string): LoadedConfig {
  const resolvedPath = path.resolve(process.cwd(), inputPath ?? "AGENTIC_WORMHOLE_CONFIG.json");
  if (!existsSync(resolvedPath)) {
    return {
      path: resolvedPath,
      baseDir: path.dirname(resolvedPath),
      config: defaults
    };
  }

  const raw = readFileSync(resolvedPath, "utf8");
  const parsedJson = JSON.parse(raw) as unknown;
  const parsed = configSchema.parse(parsedJson);

  return {
    path: resolvedPath,
    baseDir: path.dirname(resolvedPath),
    config: {
      frontend: parsed.frontend,
      backend: parsed.backend,
      security: parsed.security
    }
  };
}

export function resolveConfigPath(baseDir: string, maybePath?: string): string | undefined {
  if (!maybePath) {
    return undefined;
  }

  if (path.isAbsolute(maybePath)) {
    return maybePath;
  }

  return path.resolve(baseDir, maybePath);
}
