import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const stateRoot = await mkdtemp(path.join(tmpdir(), "quantqueens-playwright-"));
const port = process.env.E2E_PORT ?? "3417";

const server = spawn(process.execPath, ["apps/server/dist/index.js"], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: port,
    LOG_LEVEL: "error",
    SEED_DEMO_DATA: "true",
    APP_DATA_DIR: path.join(stateRoot, "data"),
    AGENT_WORKSPACE_ROOT: path.join(stateRoot, "workspaces"),
    CODEX_HOME: path.join(stateRoot, "codex-home"),
    CODEX_BIN: "codex-not-used-by-playwright",
    APP_PRINCIPAL_ID: "human:alice",
    APP_PRINCIPAL_NAME: "Alice",
    APP_PRINCIPAL_ROLE: "admin",
  },
  stdio: "inherit",
});

let requestedSignal = false;
let finishing = false;

async function finish(exitCode) {
  if (finishing) return;
  finishing = true;
  await rm(stateRoot, { recursive: true, force: true });
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    requestedSignal = true;
    server.kill(signal);
    const forceTimer = setTimeout(() => server.kill("SIGKILL"), 5_000);
    forceTimer.unref();
  });
}

server.once("error", (error) => {
  console.error("Unable to start the Playwright application server:", error);
  void finish(1);
});

server.once("exit", (code) => {
  void finish(requestedSignal ? 0 : (code ?? 1));
});
