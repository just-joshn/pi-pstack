/**
 * SEC-06..SEC-10: tool-surface containment. control_ui scheme/host filtering,
 * control_cli path handling, decision-log symlink escape, spawn cwd containment.
 */
import { readFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  fail,
  hostFor,
  importExtension,
  okResponse,
  pass,
  repoPath,
  verdict,
  withStubbedFetch,
  withTempDir,
} from "./harness.mjs";

const NON_HTTP_URLS = Object.freeze([
  "file:///etc/passwd",
  "gopher://127.0.0.1/",
  "ftp://127.0.0.1/secrets",
]);

const PRIVATE_URLS = Object.freeze([
  "http://169.254.169.254/latest/meta-data/",
  "http://127.0.0.1:1/",
  "http://10.0.0.1/",
  "http://192.168.1.1/",
  "http://[::1]/",
  "http://metadata.google.internal/",
]);

const SPAWN_SOURCES = Object.freeze([
  "extensions/subagents/index.ts",
  "extensions/subagents/child-runner.ts",
  "extensions/agents/task.ts",
]);

const DOC_SOURCES = Object.freeze(["README.md", "AGENTS.md", "PARITY.md", "docs/HOSTED.md"]);

const CONTAINMENT_HINT = /(?:workspace|repo|project)[A-Za-z]*\s*(?:root|boundary)|cwdAllowlist|PSTACK_ALLOWED_CWD|containment/i;

async function companionTool(name) {
  const module = await importExtension("extensions/companions/index.ts");
  const host = hostFor(module.registerCompanions);
  const tool = host.tools.get(name);
  if (!tool) throw new Error(`${name} is not registered by registerCompanions`);
  return { tool, ctx: host.ctx() };
}

/** A URL is refused only when the tool rejects it and never reaches fetch. */
async function probeRefusals(urls) {
  const { tool, ctx } = await companionTool("pstack_control_ui");
  return await withStubbedFetch(
    () => okResponse("stubbed body; no real request left this process"),
    async (calls) => {
      const outcomes = await Promise.all(
        urls.map(async (url) => {
          try {
            await tool.execute("audit", { url }, undefined, undefined, ctx);
            return { url, threw: false };
          } catch {
            return { url, threw: true };
          }
        }),
      );
      const attempted = new Set(calls().map((call) => call.url));
      return outcomes.map((outcome) => ({
        ...outcome,
        refused: outcome.threw && !attempted.has(outcome.url),
      }));
    },
  );
}

function refusalVerdict(results, label) {
  const leaks = results.filter((result) => !result.refused);
  return verdict(
    leaks.length === 0,
    `all ${results.length} ${label} refused before any request`,
    `${leaks.length}/${results.length} ${label} reach fetch unfiltered: ${leaks.map((l) => l.url).join(", ")}`,
  );
}

async function secNonHttpScheme() {
  return refusalVerdict(await probeRefusals(NON_HTTP_URLS), "non-http URLs");
}

async function secPrivateHosts() {
  return refusalVerdict(await probeRefusals(PRIVATE_URLS), "private/link-local URLs");
}

async function secControlCliPath() {
  const { tool, ctx } = await companionTool("pstack_control_cli");
  try {
    await tool.execute("audit", { argv: ["/tmp/evil/git", "--version"] }, undefined, undefined, ctx);
    return fail("argv0 '/tmp/evil/git' passed the allowlist: the check is basename-only");
  } catch (err) {
    return pass(`argv0 '/tmp/evil/git' refused (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function attemptSymlinkWrite(dir) {
  const module = await importExtension("extensions/decision-log/index.ts");
  const outside = join(dir, "outside");
  const piDir = join(dir, ".pi");
  mkdirSync(outside, { recursive: true });
  mkdirSync(piDir, { recursive: true });
  symlinkSync(outside, join(piDir, "esc"), "dir");
  const host = hostFor(module.registerDecisionLog, dir);
  const tool = host.tools.get("pstack_decision_log");
  if (!tool) throw new Error("pstack_decision_log is not registered");
  try {
    await tool.execute(
      "audit",
      { path: ".pi/esc/x.tsv", phase: "audit", decision: "escape", why: "symlink" },
      undefined,
      undefined,
      host.ctx(),
    );
    return { refused: false, escaped: existsSync(join(outside, "x.tsv")) };
  } catch (err) {
    return { refused: true, message: err instanceof Error ? err.message : String(err) };
  }
}

async function secDecisionLogSymlink() {
  return await withTempDir("declog", async (dir) => {
    const result = await attemptSymlinkWrite(dir);
    if (result.refused) return pass(`symlinked .pi/esc refused: ${result.message}`);
    return fail(
      `write through symlinked .pi/esc succeeded; file landed outside .pi: ${result.escaped}. The allowlist resolves lexically, not through realpath`,
    );
  });
}

function sourceHasContainment() {
  return SPAWN_SOURCES.filter((relative) => {
    const source = readFileSync(repoPath(relative), "utf8");
    return CONTAINMENT_HINT.test(source);
  });
}

function docsDescribeAllowlist() {
  return DOC_SOURCES.filter((relative) => {
    const path = repoPath(relative);
    if (!existsSync(path)) return false;
    const text = readFileSync(path, "utf8");
    return /cwd/i.test(text) && CONTAINMENT_HINT.test(text);
  });
}

async function secSpawnCwdContainment() {
  const module = await importExtension("extensions/subagents/index.ts");
  const host = hostFor(module.registerSpawn);
  const registered = host.tools.has("pstack_spawn");
  const enforced = sourceHasContainment();
  const documented = docsDescribeAllowlist();
  const asserted =
    "asserted one of: (a) the spawn path contains a cwd containment check against a workspace root, or (b) README/AGENTS/PARITY/docs document an explicit cwd allowlist mechanism";
  if (!registered) return fail(`pstack_spawn is not registered; ${asserted}`);
  if (enforced.length > 0) return pass(`cwd containment enforced in ${enforced.join(", ")}. ${asserted}`);
  if (documented.length > 0) {
    return pass(`no code containment, but an explicit cwd allowlist is documented in ${documented.join(", ")}. ${asserted}`);
  }
  return fail(
    `pstack_spawn accepts any cwd (params.cwd is passed through unvalidated in ${SPAWN_SOURCES.join(", ")}) and no allowlist mechanism is documented in ${DOC_SOURCES.join(", ")}. ${asserted}`,
  );
}

export const SEC_TOOL_PREDICATES = Object.freeze([
  {
    id: "SEC-06",
    description: "pstack_control_ui refuses file/gopher/ftp URLs without issuing a request",
    run: secNonHttpScheme,
  },
  {
    id: "SEC-07",
    description: "pstack_control_ui refuses private, loopback, and link-local hosts by default",
    run: secPrivateHosts,
  },
  {
    id: "SEC-08",
    description: "pstack_control_cli allowlist is not basename-only (/tmp/evil/git is refused)",
    run: secControlCliPath,
  },
  {
    id: "SEC-09",
    description: "pstack_decision_log allowlist resolves symlinks before writing",
    run: secDecisionLogSymlink,
  },
  {
    id: "SEC-10",
    description: "pstack_spawn contains cwd to the workspace or documents an explicit allowlist",
    run: secSpawnCwdContainment,
  },
]);
