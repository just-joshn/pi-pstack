import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { makeTempRoot } from "../../support/temp-env.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const EXTENSION_PATH = join(REPO_ROOT, "extensions", "index.ts");

function spawnPi(extensionPath, tmp) {
  return spawnSync("pi", ["--no-extensions", "-e", extensionPath], {
    cwd: tmp.cwd,
    env: tmp.env(),
    input: "",
    encoding: "utf8",
    timeout: 60000,
    killSignal: "SIGKILL",
  });
}

test("extension loads with no error on closed stdin", () => {
  const tmp = makeTempRoot();
  try {
    const result = spawnPi(EXTENSION_PATH, tmp);
    expect(result.signal, `process killed by ${result.signal}`).toBe(null);
    expect(result.status, `exit ${result.status}; stderr: ${result.stderr}`).toBe(0);
    expect(result.stderr).not.toMatch(/Failed to load extension/);
  } finally {
    tmp.cleanup();
  }
});

test("broken extension fails the same probe", () => {
  const tmp = makeTempRoot();
  try {
    const brokenPath = join(tmp.cwd, "broken-ext.mjs");
    writeFileSync(
      brokenPath,
      'export default function () { throw new Error("BROKEN_EXTENSION") }\n',
      "utf8",
    );

    const result = spawnPi(brokenPath, tmp);
    expect(result.signal, `process killed by ${result.signal}`).toBe(null);
    expect(result.status, `exit ${result.status}; stderr: ${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(/Failed to load extension/);
    expect(result.stderr).toMatch(/BROKEN_EXTENSION/);
  } finally {
    tmp.cleanup();
  }
});
