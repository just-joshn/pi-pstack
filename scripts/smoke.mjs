import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";

import { catalog, root, slashSkills } from "../lib/catalog.ts";
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
    "-e",
    join(root, "scripts/smoke-provider.ts"),
    "--skill",
    join(root, "skills"),
  ],
  {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(cwd, "agent") },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
let stderr = "";
child.stderr.setEncoding("utf8").on("data", (s) => (stderr += s));
const responses = new Map();
/** @type {string[]} */
const notices = [];
createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  let item;
  try {
    item = JSON.parse(line);
  } catch {
    return;
  }
  if (item.type === "response") responses.get(item.id)?.(item);
  if (item.type === "extension_ui_request" && item.method === "notify") notices.push(item.message);
});
const exited = once(child, "exit");
const failed = exited.then(([code, signal]) => {
  throw Error(`Pi exited (${code ?? signal}) before smoke completed: ${stderr}`);
});
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
  await rpc("5", "prompt", { message: "/setup-pstack show" });
  assert(JSON.parse(notices.at(-1) ?? "{}").available?.includes("smoke/model"), notices.at(-1));
  console.log(
    "Real Pi RPC discovery, mode-state and extension-provider smoke passed (no model calls).",
  );
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
