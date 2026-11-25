import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, onTestFinished, test } from "vitest";

import { root } from "../lib/catalog.ts";
import { shaped, spawned } from "./support.ts";

// The test runs the generator several times, so the default 5 seconds is too short on a slow machine.
describe("generator", { timeout: 30_000 }, () => {
  test("generated checks are read-only, detect drift, and regenerate only owned files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-generate-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    await Promise.all(["scripts", "lib", "reference"].map((p) => mkdir(join(dir, p))));
    await Promise.all(
      [
        "scripts/generate.py",
        "scripts/catalog-source.json",
        "reference/source-map.json",
        "bunfig.toml",
      ].map((p) => copyFile(join(root, p), join(dir, p))),
    );
    const run = (...args: string[]) =>
      spawned("python3", ["scripts/generate.py", ...args], { cwd: dir });
    const success = async (...args: string[]) => {
      const r = await run(...args);
      assert.equal(r.status, 0, r.stderr + r.stdout);
    };
    await success();
    await success("--check");
    const old = join(dir, "skills/bro/SKILL.md");
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

    const mapFile = join(dir, "reference/source-map.json");
    const map = shaped<{ nodes: { id: string; label: string }[] }>(
      JSON.parse(await readFile(mapFile, "utf8")),
    );
    const bro = map.nodes.find((n) => n.id === "bro");
    assert(bro);
    bro.label = "/renamed-bro";
    await writeFile(mapFile, JSON.stringify(map));
    const manual = join(dir, "skills/hand-authored/SKILL.md");
    await mkdir(dirname(manual));
    await writeFile(manual, "Keep my skill.\n");
    const check = await run("--check");
    assert.notEqual(check.status, 0);
    assert.match(check.stdout + check.stderr, /skills\/bro\/SKILL\.md/);
    assert.match(check.stdout + check.stderr, /skills\/renamed-bro\/SKILL\.md/);
    const renamed = join(dir, "skills/renamed-bro/SKILL.md");
    await assert.rejects(() => readFile(renamed), { code: "ENOENT" });
    await success();
    await success("--check");
    await assert.rejects(() => readFile(old), { code: "ENOENT" });
    assert.match(await readFile(renamed, "utf8"), /Changed source instructions/);
    assert.equal(await readFile(manual, "utf8"), "Keep my skill.\n");
  });
});
