import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";

import { catalog, root, slashSkills } from "../lib/catalog.ts";
import { errorMessage, isRecord } from "../lib/validation.ts";

type Rpc = Record<string, unknown>;

const cwd = await mkdtemp(join(tmpdir(), "pstack-smoke-"));
const child = spawn(
  process.env["PSTACK_PI_BIN"] ?? "pi",
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
    join(root, "src/index.ts"),
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
child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
const responses = new Map<string, (response: Rpc) => void>();
const notices: string[] = [];
createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  const item = record(line);
  if (item?.["type"] === "response" && typeof item["id"] === "string")
    responses.get(item["id"])?.(item);
  if (
    item?.["type"] === "extension_ui_request" &&
    item["method"] === "notify" &&
    typeof item["message"] === "string"
  )
    notices.push(item["message"]);
});
const exited = new Promise<string>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve(String(code ?? signal)));
});
const failed = exited.then((status) => {
  throw Error(`Pi exited (${status}) before smoke completed: ${stderr}`);
});

function record(json: string): Rpc | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
function list(data: unknown, key: string): Rpc[] {
  const items = isRecord(data) ? data[key] : undefined;
  assert(Array.isArray(items), `Pi returned no ${key}`);
  return items.filter(isRecord);
}
async function rpc(id: string, type: string, fields: Rpc = {}) {
  let timer: NodeJS.Timeout | undefined;
  try {
    const request = new Promise<Rpc>((resolve) => {
      responses.set(id, resolve);
      child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(`RPC timeout: ${type}\n${stderr}`)), 20000);
    });
    const response = await Promise.race([request, failed, timeout]);
    assert(response["success"], JSON.stringify(response));
    return response["data"];
  } finally {
    clearTimeout(timer);
    responses.delete(id);
  }
}
child.stdin.on("error", () => {});
try {
  const commands = list(await rpc("1", "get_commands"), "commands");
  const found = new Set(commands.map((command) => command["name"]));
  for (const node of slashSkills) assert(found.has(node.label.slice(1)), node.id);
  for (const path of Object.values(catalog.paths).filter((p) => p.endsWith("SKILL.md")))
    assert(found.has(`skill:${path.split("/")[1]}`), path);
  await rpc("2", "prompt", { message: "/poteto-mode on" });
  const entries = list(await rpc("3", "get_entries"), "entries");
  assert(
    entries.some(
      (entry) =>
        entry["type"] === "custom" &&
        entry["customType"] === "pstack-state" &&
        isRecord(entry["data"]) &&
        entry["data"]["mode"] === true,
    ),
  );
  await rpc("4", "prompt", { message: "/poteto-mode off" });
  await rpc("5", "prompt", { message: "/setup-pstack show" });
  const shown = record(notices.at(-1) ?? "{}");
  assert(
    Array.isArray(shown?.["available"]) && shown["available"].includes("smoke/model"),
    notices.at(-1),
  );
  process.stdout.write(
    "Real Pi RPC discovery, mode-state and extension-provider smoke passed (no model calls).\n",
  );
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  const exit = exited.catch(() => {});
  await Promise.race([exit, wait(1000, undefined, { ref: false })]);
  if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exit;
  await rm(cwd, { recursive: true, force: true });
}
