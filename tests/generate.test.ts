import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { onTestFinished, test } from "vitest";

import { shaped, spawned } from "./support.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

async function generatorCopy() {
  const dir = await mkdtemp(join(tmpdir(), "catalog-generate-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await Promise.all(
    ["scripts", "src/lib", "src/reference"].map((p) => mkdir(join(dir, p), { recursive: true })),
  );
  await Promise.all(
    [
      "scripts/generate.py",
      "scripts/catalog-source.json",
      "src/reference/source-map.json",
      "src/lib/catalog-data.json",
      "src/reference/parity.json",
      "src/reference/PARITY.md",
      "bunfig.toml",
    ].map((p) => copyFile(join(packageRoot, p), join(dir, p))),
  );
  await cp(join(packageRoot, "src/skills"), join(dir, "src/skills"), { recursive: true });
  const run = (...args: string[]) =>
    spawned("python3", ["scripts/generate.py", ...args], { cwd: dir });
  const success = async (...args: string[]) => {
    const r = await run(...args);
    assert.equal(r.status, 0, r.stderr + r.stdout);
  };
  return { dir, run, success };
}

// The test runs the generator several times, so the default 5 seconds is too short on a slow machine.
const slow = { timeout: 30_000 };

test(
  "generated checks are read-only, detect drift, and never write the ported files",
  slow,
  async () => {
    const { dir, run, success } = await generatorCopy();
    await success("--check");
    const catalogFile = join(dir, "src/lib/catalog-data.json");
    const catalog = async () =>
      shaped<{ steps: Record<string, string[]>; implementations: Record<string, string[]> }>(
        JSON.parse(await readFile(catalogFile, "utf8")),
      );
    const original = await readFile(catalogFile, "utf8");

    const input = join(dir, "scripts/catalog-source.json");
    const source = shaped<{ implementations: Record<string, string[]> }>(
      JSON.parse(await readFile(input, "utf8")),
    );
    source.implementations["kit-ci-watcher"] = ["extension", "agents/ci-watcher.md (changed)"];
    await writeFile(input, JSON.stringify(source));
    assert.notEqual((await run("--check")).status, 0);
    assert.equal(await readFile(catalogFile, "utf8"), original);
    await success();
    assert.deepEqual((await catalog()).implementations["kit-ci-watcher"], [
      "extension",
      "agents/ci-watcher.md (changed)",
    ]);

    const playbook = join(dir, "src/skills/poteto-mode/playbooks/investigation.md");
    const text = await readFile(playbook, "utf8");
    await writeFile(
      playbook,
      text.replace("1. Trace the code", "1. **Read the code first.** Trace the code"),
    );
    const check = await run("--check");
    assert.notEqual(check.status, 0);
    assert.match(check.stdout + check.stderr, /src\/lib\/catalog-data\.json/);
    await success();
    assert.equal((await catalog()).steps["investigation"]?.[0], "Read the code first.");
    assert.match(await readFile(playbook, "utf8"), /Read the code first/);
  },
);
