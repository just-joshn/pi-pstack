import { test } from "node:test";
import assert from "node:assert/strict";
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
    assert.equal(result.signal, null, `process killed by ${result.signal}`);
    assert.equal(result.status, 0, `exit ${result.status}; stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /Failed to load extension/);
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
    assert.equal(result.signal, null, `process killed by ${result.signal}`);
    assert.equal(result.status, 1, `exit ${result.status}; stderr: ${result.stderr}`);
    assert.match(result.stderr, /Failed to load extension/);
    assert.match(result.stderr, /BROKEN_EXTENSION/);
  } finally {
    tmp.cleanup();
  }
});
