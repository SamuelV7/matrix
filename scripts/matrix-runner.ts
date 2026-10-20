#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This executable owns child-process startup before the application Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeReadline from "node:readline";
import * as NodeOS from "node:os";
import { loadRepoEnv } from "./lib/public-config.ts";
import { initializeMatrixFreeModels, resolveMatrixLaunchHome } from "./lib/matrix-free-models.ts";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "dev";
if (!["dev", "dev:server", "dev:desktop", "start"].includes(mode)) {
  throw new Error(`Unsupported Matrix launch mode: ${mode}`);
}
const env = loadRepoEnv();
if (
  !env.SEC_USER_AGENT ||
  !env.SEC_USER_AGENT.includes("@") ||
  env.SEC_USER_AGENT.trim().split(/\s+/).length < 2
) {
  throw new Error(
    "Set SEC_USER_AGENT in .env to Matrix followed by your real contact email. SEC requires an identifiable client; no anonymous fallback is used.",
  );
}
env.MATRIX_DATA_TOKEN = NodeCrypto.randomBytes(32).toString("hex");
env.MATRIX_DATA_PORT = "0";
env.MATRIX_DATA_CACHE_DIR ??= NodePath.resolve(root, ".matrix/sec-cache");
// Scratch research must live outside a Git checkout to avoid inheriting its checkpoints.
env.MATRIX_HOME ??= NodePath.join(
  NodeOS.homedir(),
  ".matrix",
  "dev",
  NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 12),
);
const launch = resolveMatrixLaunchHome(process.argv.slice(3), env.MATRIX_HOME);
env.MATRIX_HOME = launch.homeDir;
const children = new Set<NodeChildProcess.ChildProcess>();
let stopping = false;

function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  const deadline = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 5_000);
  deadline.unref();
}
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

function start(command: string, args: string[], piped = false) {
  const child = NodeChildProcess.spawn(command, args, {
    cwd: root,
    env,
    stdio: piped ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  children.add(child);
  child.on("close", () => children.delete(child));
  child.on("error", (error) => {
    console.error(`[matrix] Could not start ${command}: ${error.message}`);
    stop(1);
  });
  return child;
}

try {
  await initializeMatrixFreeModels(launch.homeDir);
  if (!env.MATRIX_DATA_BIN) {
    const build = start("cargo", [
      "build",
      "--locked",
      "--manifest-path",
      "native/matrix-data/Cargo.toml",
    ]);
    const code = await new Promise<number | null>((accept, reject) => {
      build.once("close", accept);
      build.once("error", reject);
    });
    if (code !== 0 || stopping) throw new Error("Matrix data service build did not complete.");
  }
  const daemon = start(
    env.MATRIX_DATA_BIN ?? NodePath.resolve(root, "native/matrix-data/target/debug/matrix-data"),
    [],
    true,
  );
  const lines = NodeReadline.createInterface({ input: daemon.stdout! });
  const url = await new Promise<string>((accept, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Matrix data service did not become ready.")),
      15_000,
    );
    timer.unref();
    daemon.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    daemon.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Matrix data service exited before startup."));
    });
    lines.once("line", (line) => {
      clearTimeout(timer);
      try {
        const ready: unknown = JSON.parse(line);
        if (
          !ready ||
          typeof ready !== "object" ||
          !("url" in ready) ||
          typeof ready.url !== "string"
        ) {
          throw new Error("Invalid data service ready frame.");
        }
        const parsed = new URL(ready.url);
        if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port) {
          throw new Error("Data service did not bind a private loopback address.");
        }
        accept(parsed.origin);
      } catch (error) {
        reject(error);
      }
    });
  });
  lines.close();
  if (stopping) throw new Error("Matrix startup interrupted.");
  env.MATRIX_DATA_URL = url;
  console.log(`[matrix] SEC data service ready at ${url}; cache ${env.MATRIX_DATA_CACHE_DIR}`);
  daemon.once("exit", (code) => {
    if (!stopping) {
      console.error("[matrix] Data service stopped.");
      stop(code || 1);
    }
  });
  const app =
    mode === "start"
      ? start("vp", [
          "run",
          "--filter",
          "t3",
          "start",
          "--home-dir",
          launch.homeDir,
          ...launch.args,
        ])
      : start(process.execPath, [
          "scripts/dev-runner.ts",
          mode,
          "--home-dir",
          launch.homeDir,
          ...launch.args,
        ]);
  app.once("exit", (code) => stop(code ?? 1));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Matrix startup failed.");
  stop(1);
}
