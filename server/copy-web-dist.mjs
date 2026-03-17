import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const serverDir = path.dirname(currentFile);
const repoRoot = path.resolve(serverDir, "..");
const sourceDir = path.resolve(repoRoot, "web", "dist");
const targetDir = path.resolve(serverDir, "dist", "web");

await ensureDirExists(sourceDir);
await fs.rm(targetDir, { recursive: true, force: true });
await fs.mkdir(path.dirname(targetDir), { recursive: true });
await fs.cp(sourceDir, targetDir, { recursive: true });

console.log(`[build] copied web assets: ${sourceDir} -> ${targetDir}`);

async function ensureDirExists(dir) {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${dir}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`web UI build output not found at ${dir}. Run "npm --workspace web run build" first. (${message})`);
  }
}
