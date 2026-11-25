import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
      "bunfig.toml",
    ].map((p) => copyFile(join(packageRoot, p), join(dir, p))),
  );
  // Files ported by hand from upstream are inputs that the generator never writes.
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
  "generated checks are read-only, detect drift, and regenerate only owned files",
  slow,
  async () => {
    const { dir, run, success } = await generatorCopy();
    await success();
    await success("--check");
    const old = join(dir, "src/skills/bro/SKILL.md");
    const original = await readFile(old, "utf8");
    const input = join(dir, "scripts/catalog-source.json");
    const source = shaped<{ skills: Record<string, string> }>(
      JSON.parse(await readFile(input, "utf8")),
    );
    source.skills["bro"] = "Changed source instructions.";
    await writeFile(input, JSON.stringify(source));
    assert.notEqual((await run("--check")).status, 0);
    assert.equal(await readFile(old, "utf8"), original);
    await success();
    assert.match(await readFile(old, "utf8"), /Changed source instructions/);

    const mapFile = join(dir, "src/reference/source-map.json");
    const map = shaped<{ nodes: { id: string; label: string }[] }>(
      JSON.parse(await readFile(mapFile, "utf8")),
    );
    const bro = map.nodes.find((n) => n.id === "bro");
    assert(bro);
    bro.label = "/renamed-bro";
    await writeFile(mapFile, JSON.stringify(map));
    const manual = join(dir, "src/skills/hand-authored/SKILL.md");
    await mkdir(dirname(manual));
    await writeFile(manual, "Keep my skill.\n");
    const check = await run("--check");
    assert.notEqual(check.status, 0);
    assert.match(check.stdout + check.stderr, /src\/skills\/bro\/SKILL\.md/);
    assert.match(check.stdout + check.stderr, /src\/skills\/renamed-bro\/SKILL\.md/);
    const renamed = join(dir, "src/skills/renamed-bro/SKILL.md");
    await assert.rejects(() => readFile(renamed), { code: "ENOENT" });
    await success();
    await success("--check");
    await assert.rejects(() => readFile(old), { code: "ENOENT" });
    assert.match(await readFile(renamed, "utf8"), /Changed source instructions/);
    assert.equal(await readFile(manual, "utf8"), "Keep my skill.\n");
  },
);
