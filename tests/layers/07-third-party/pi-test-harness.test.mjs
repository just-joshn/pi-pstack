import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI_VERSION = "0.85.1";
const HARNESS_SPEC = "@marcfargas/pi-test-harness@0.6.1";
const OPT_IN_ENV = "PSTACK_VERIFY_PI_TEST_HARNESS";

function run(argv, cwd, timeout) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", timeout });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    status: result.status,
    error: result.error,
    output: result.error ? `${output}\n${result.error.message}` : output,
  };
}

function performHarnessCheck() {
  const dir = mkdtempSync(join(tmpdir(), "pstack-pi-test-harness-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "pstack-pi-test-harness-check", private: true, type: "module" }, null, 2),
    );

    const installPi = run(
      [
        "bun",
        "add",
        `@earendil-works/pi-coding-agent@${PI_VERSION}`,
        `@earendil-works/pi-ai@${PI_VERSION}`,
        `@earendil-works/pi-agent-core@${PI_VERSION}`,
      ],
      dir,
      300000,
    );
    expect(installPi.status, `bun add of pinned pi packages failed:\n${installPi.output}`).toBe(0);

    const installHarness = run(["bun", "add", "-d", HARNESS_SPEC], dir, 300000);
    expect(installHarness.status, `bun add -d ${HARNESS_SPEC} failed:\n${installHarness.output}`).toBe(0);

    const imported = run(
      [process.execPath, "--input-type=module", "-e", "await import('@marcfargas/pi-test-harness')"],
      dir,
      120000,
    );

    if (imported.status === 0) {
      expect.fail(`${HARNESS_SPEC} now imports cleanly against pi ${PI_VERSION}. The layer 7 verdict is stale: ` +
          "re-check the runtime rename surface and update tests/layers/07-third-party/README.md.");
    }

    expect(imported.output, `expected the recorded getModel import break, got:\n${imported.output}`).toMatch(/getModel/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("pi-test-harness 0.6.1 compatibility gate against pi 0.85.1", (t) => {
  if (process.env[OPT_IN_ENV] !== "1") {
    t.skip(
      `recorded verdict 2026-09-15: ${HARNESS_SPEC} does not import against pi ${PI_VERSION} ` +
        `("SyntaxError: The requested module '@earendil-works/pi-ai' does not provide an export named 'getModel'"). ` +
        `Set ${OPT_IN_ENV}=1 to run the live install check (network).`,
    );
    return;
  }

  performHarnessCheck();
});
