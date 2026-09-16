/**
 * Programmable forge stubs for the acceptance run and the user-journey suite.
 *
 * `installFakeGh(root, fixtures)` puts an executable `gh` on PATH. With no fixtures it exits 1
 * with empty stdout (the acceptance behavior). With fixtures it matches the longest fixture key
 * that is a prefix of the joined argv, so `pr view 42` serves `pr view 42 --json ...` calls when
 * the key was registered that way.
 *
 * `installFakeGit(root, mode)` puts an executable `git` on PATH. The default fake only creates
 * the target directory for `worktree add` (the acceptance behavior). Mode `"real"` (also
 * `"passthrough"` / `"pass-through"`) writes a shim that execs the real git instead.
 *
 * Both installers prepend a bin directory to PATH and return a restore function.
 */
import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FAKE_GIT_SCRIPT = '#!/bin/sh\nif [ "$1" = "worktree" ] && [ "$2" = "add" ]; then mkdir -p "$5"; fi\nexit 0\n';
const FAKE_GH_SCRIPT = "#!/bin/sh\nexit 1\n";
const GH_RUNNER_SOURCE = `import { readFileSync } from "node:fs";
const fixtures = JSON.parse(readFileSync(process.env.PSTACK_FAKE_GH_FIXTURES, "utf8"));
const key = process.argv.slice(2).join(" ");
const matches = Object.keys(fixtures).filter((candidate) => key === candidate || key.startsWith(candidate + " "));
const winner = matches.reduce(
  (best, candidate) => (best === undefined || candidate.length > best.length ? candidate : best),
  undefined,
);
const fixture = winner === undefined ? undefined : fixtures[winner];
const result = fixture ?? { code: 1, stdout: "", stderr: "no gh fixture for " + key };
process.stdout.write(String(result.stdout ?? ""));
process.stderr.write(String(result.stderr ?? ""));
process.exitCode = Number.isInteger(result.code) ? result.code : 1;
`;

export function prependPath(dir) {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved ?? ""}`;
  return () => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "PATH");
    else process.env.PATH = saved;
  };
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function isRealGitMode(mode) {
  return mode === "real" || mode === "passthrough" || mode === "pass-through";
}

function resolveRealGit() {
  const entries = (process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry.length > 0 && !entry.includes("fake-git-bin") && !entry.includes("real-git-bin"));
  const found = entries.map((dir) => join(dir, "git")).find((candidate) => isExecutable(candidate));
  if (found === undefined) throw new Error("installFakeGit(real): no real git found on PATH");
  return found;
}

function writeGitShim(root, realGit) {
  const binDir = join(root, realGit === undefined ? "fake-git-bin" : "real-git-bin");
  mkdirSync(binDir, { recursive: true });
  const script = realGit === undefined ? FAKE_GIT_SCRIPT : `#!/bin/sh\nexec "${realGit}" "$@"\n`;
  writeFileSync(join(binDir, "git"), script, { mode: 0o755 });
  return prependPath(binDir);
}

export function installFakeGit(root, mode = "fake") {
  return isRealGitMode(mode) ? writeGitShim(root, resolveRealGit()) : writeGitShim(root, undefined);
}

export function installFakeGh(root, fixtures) {
  const binDir = join(root, "fake-gh-bin");
  mkdirSync(binDir, { recursive: true });
  if (fixtures === undefined || Object.keys(fixtures).length === 0) {
    writeFileSync(join(binDir, "gh"), FAKE_GH_SCRIPT, { mode: 0o755 });
    return prependPath(binDir);
  }

  const fixturesPath = join(binDir, "gh-fixtures.json");
  const runnerPath = join(binDir, "gh-runner.mjs");
  writeFileSync(fixturesPath, `${JSON.stringify(fixtures, null, 2)}\n`, "utf8");
  writeFileSync(runnerPath, GH_RUNNER_SOURCE, "utf8");
  const script = `#!/bin/sh\nPSTACK_FAKE_GH_FIXTURES="${fixturesPath}" exec node "${runnerPath}" "$@"\n`;
  writeFileSync(join(binDir, "gh"), script, { mode: 0o755 });
  return prependPath(binDir);
}
