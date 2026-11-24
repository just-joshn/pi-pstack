import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { catalog, slashSkills } from "../lib/catalog.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const cwd = await mkdtemp(join(tmpdir(), "pstack-smoke-"));
const child = spawn(
  process.env.PSTACK_PI_BIN ?? "pi",
  [
    "--mode",
    "rpc",
    "--offline",
    "--no-session",
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-mcp",
    "-e",
    join(root, "extensions/index.ts"),
    "--skill",
    join(root, "skills"),
  ],
  {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(cwd, "agent") },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
let stderr = "",
  buffer = "";
child.stderr.setEncoding("utf8").on("data", (s) => (stderr += s));
const responses = new Map();
child.stdout.setEncoding("utf8").on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item.type === "response" && responses.has(item.id)) {
      responses.get(item.id)(item);
      responses.delete(item.id);
    }
  }
});
const exited = once(child, "exit");
exited.catch(() => {});
const failed = new Promise((_, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) =>
    reject(Error(`Pi exited (${code ?? signal}) before smoke completed: ${stderr}`)),
  );
});
failed.catch(() => {});
/** @param {string} id @param {string} type @param {Record<string, unknown>} fields */
async function rpc(id, type, fields = {}) {
  let timer;
  try {
    const request = new Promise((resolve) => {
      responses.set(id, resolve);
      child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    });
    const response = await Promise.race([
      request,
      failed,
      new Promise(
        (_, reject) =>
          (timer = setTimeout(() => reject(Error(`RPC timeout: ${type}\n${stderr}`)), 20000)),
      ),
    ]);
    assert(response.success, JSON.stringify(response));
    return response.data;
  } finally {
    clearTimeout(timer);
    responses.delete(id);
  }
}
child.stdin.on("error", () => {});
try {
  const data = await rpc("1", "get_commands");
  const found = new Set(data.commands.map((/** @type {{ name: string }} */ c) => c.name));
  for (const node of slashSkills) assert(found.has(node.label.slice(1)), node.id);
  for (const path of Object.values(catalog.paths).filter((p) => p.endsWith("SKILL.md")))
    assert(found.has(`skill:${path.split("/")[1]}`), path);
  await rpc("2", "prompt", { message: "/poteto-mode on" });
  const entries = await rpc("3", "get_entries");
  assert(
    entries.entries.some(
      (/** @type {{ type: string, customType?: string, data?: { mode?: boolean } }} */ e) =>
        e.type === "custom" && e.customType === "pstack-state" && e.data?.mode === true,
    ),
  );
  await rpc("4", "prompt", { message: "/poteto-mode off" });
  console.log("Real Pi RPC discovery and mode-state smoke passed (no model calls).");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  const exit = exited.catch(() => {});
  await Promise.race([exit, wait(1000, undefined, { ref: false })]);
  if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exit;
  await rm(cwd, { recursive: true, force: true });
}
