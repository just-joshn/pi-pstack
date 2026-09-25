#!/usr/bin/env node
// Usage: inventory.mjs <out.json> [pi args...]. Starts pi in RPC mode, records commands, tools, and startup stderr.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const [out, ...piArgs] = process.argv.slice(2);
const toolsFile = `${out}.tools.tmp`;
const probe = path.join(path.dirname(new URL(import.meta.url).pathname), "inventory-probe.ts");
const child = spawn("pi", ["--mode", "rpc", "--no-session", "-e", probe, ...piArgs], {
  env: { ...process.env, PSTACK_INVENTORY_OUT: toolsFile },
  stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
child.stdout.on("data", (d) => {
  stdout += d;
  for (const line of stdout.split("\n")) {
    if (!line.includes('"command":"get_commands"')) continue;
    const data = JSON.parse(line).data;
    const commands = data.commands
      .map((c) => ({ name: c.name, source: c.source, origin: c.sourceInfo?.origin, file: c.sourceInfo?.path?.replace(c.sourceInfo?.baseDir ?? "\0", "<pkg>") }))
      .sort((a, b) => a.name.localeCompare(b.name));
    let tools = null;
    try { tools = JSON.parse(readFileSync(toolsFile, "utf8")); rmSync(toolsFile); } catch {}
    writeFileSync(out, JSON.stringify({ commands, tools, stderr: stderr.trim() }, null, 2));
    child.kill("SIGTERM");
    process.exit(0);
  }
});
setTimeout(() => child.stdin.write(JSON.stringify({ type: "get_commands" }) + "\n"), 4000);
setTimeout(() => { console.error("inventory timeout\n" + stderr); child.kill("SIGKILL"); process.exit(1); }, 60000);
