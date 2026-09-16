/**
 * Differential harness boundary.
 *
 * Resolves the pinned upstream tree, builds the isolation PATH, and runs child
 * processes. No case knowledge lives here: this is the seam between the suite and
 * the host. Set PORT_UPSTREAM_DIR to resolve upstream from a clone other than the
 * cached `.port-upstream/cursor-plugins-<sha7>`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/repo-root.mjs";

export const ROOT = repoRoot(import.meta.url);
export const SCRIPTS_REL = "skills/poteto-mode/scripts";
const UPSTREAM_JSON = join(ROOT, "port", "upstream.json");

export const GIT_ISOLATION = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

export function writeLine(text) {
  process.stdout.write(`${text}\n`);
}

export function upstreamMeta() {
  return JSON.parse(readFileSync(UPSTREAM_JSON, "utf8"));
}

function upstreamRootDir(meta) {
  if (process.env.PORT_UPSTREAM_DIR !== undefined) return process.env.PORT_UPSTREAM_DIR;
  return join(ROOT, ".port-upstream", `cursor-plugins-${meta.commit.slice(0, 7)}`);
}

function gitHead(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function resolveUpstream(meta) {
  const dir = upstreamRootDir(meta);
  const nested = join(dir, meta.subdir);
  const root = existsSync(nested) ? nested : existsSync(join(dir, SCRIPTS_REL)) ? dir : null;
  if (root === null) return { ok: false, path: nested };
  return gitHead(dir) === meta.commit ? { ok: true, root, commit: meta.commit } : { ok: false, path: root };
}

export function runChild(argv, options) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    rc: result.status ?? (result.error === undefined ? -1 : 127),
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function toolDir(name) {
  const parts = (process.env.PATH ?? "").split(":");
  return parts.find((dir) => dir !== "" && existsSync(join(dir, name))) ?? "/usr/bin";
}

// /bin and /usr/bin stay ahead of the user PATH so the BSD userland the
// worktree-audit script is written against wins over any GNU shim.
export function systemPath() {
  return ["/bin", "/usr/bin", toolDir("rg"), toolDir("jq"), toolDir("bun")]
    .filter((dir, index, all) => all.indexOf(dir) === index)
    .join(":");
}

export function childEnv(ctx, binDir, extra) {
  const path = binDir === undefined || binDir === null ? ctx.pathBase : `${binDir}:${ctx.pathBase}`;
  return {
    PATH: path,
    HOME: ctx.cliHome,
    TMPDIR: ctx.tmp,
    LC_ALL: "C",
    LANG: "C",
    NO_COLOR: "1",
    ...GIT_ISOLATION,
    ...(extra ?? {}),
  };
}

export function gitEnv(ctx) {
  return {
    ...childEnv(ctx, null),
    GIT_AUTHOR_NAME: "differential",
    GIT_AUTHOR_EMAIL: "differential@example.test",
    GIT_COMMITTER_NAME: "differential",
    GIT_COMMITTER_EMAIL: "differential@example.test",
    GIT_AUTHOR_DATE: ctx.commitDate,
    GIT_COMMITTER_DATE: ctx.commitDate,
  };
}

export function gitRun(cwd, args, env) {
  const result = runChild(["git", ...args], { cwd, env });
  if (result.rc !== 0) throw new Error(`git ${args.join(" ")} exited ${result.rc}: ${result.stderr.trim()}`);
  return result.stdout;
}

export function writeExecutable(path, text) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

/**
 * Discriminated probe. `skipped` covers the states the harness is allowed to
 * stand down on (missing pin, missing runtime); `environment` means the suite may
 * build a scratch context. A malformed port/upstream.json is left to throw.
 */
export function probeEnvironment() {
  const resolution = resolveUpstream(upstreamMeta());
  if (!resolution.ok) return { status: "skipped", reason: `upstream tree unavailable at ${resolution.path}` };
  const pathBase = systemPath();
  const bun = runChild(["bun", "--version"], { cwd: ROOT, env: { PATH: pathBase, LC_ALL: "C", ...GIT_ISOLATION } });
  if (bun.rc !== 0) return { status: "skipped", reason: "bun unavailable" };
  return { status: "environment", resolution, pathBase };
}
