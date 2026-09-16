import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_TRUSTED_BIN_DIRS,
  INTERPRETER_COMMANDS,
  resolveTrustedCommand,
} from "../../../extensions/lib/exec-allowlist.ts";

const COMPANION_ALLOWLIST = [...DEFAULT_ALLOWED_COMMANDS, ...INTERPRETER_COMMANDS];

function withTempBinDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pstack-trust-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withPath<T>(path: string, run: () => T): T {
  const previous = process.env.PATH;
  process.env.PATH = path;
  try {
    return run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "PATH");
    else process.env.PATH = previous;
  }
}

function writeExecutable(path: string, body = "#!/bin/sh\necho stub\n"): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

test("a bare name whose first PATH match is outside the trusted directories is refused", () => {
  withTempBinDir((dir) => {
    writeExecutable(join(dir, "git"));
    withPath(dir, () => {
      const result = resolveTrustedCommand("git");
      assert.equal(result.ok, false);
      assert.match(
        result.ok === false ? result.reason : "",
        /resolves to '.*git', outside a trusted binary directory/,
      );
    });
  });
});

test("a bare name whose first PATH match is a trusted directory is passed through unchanged", () => {
  withTempBinDir((dir) => {
    writeExecutable(join(dir, "git"));
    withPath(dir, () => {
      const result = resolveTrustedCommand("git", { trustedDirs: [dir] });
      assert.equal(result.ok, true);
      assert.equal(result.ok === true ? result.command : "", "git");
      assert.equal(result.ok === true ? result.realPath : "", realpathSync(join(dir, "git")));
    });
  });
});

test("the operator can extend the trusted directories for a toolchain install", () => {
  withTempBinDir((dir) => {
    writeExecutable(join(dir, "npm"));
    withPath(dir, () => {
      assert.equal(resolveTrustedCommand("npm").ok, false, "the extra directory is not trusted yet");
      const extended = [...DEFAULT_TRUSTED_BIN_DIRS, dir];
      assert.equal(resolveTrustedCommand("npm", { trustedDirs: extended }).ok, true);
    });
  });
});

test("PATH resolution trusts the located directory, not the symlink target", () => {
  withTempBinDir((dir) => {
    const outside = join(dir, "outside");
    writeExecutable(outside, "#!/bin/sh\necho outside\n");
    symlinkSync(outside, join(dir, "git"));
    withPath(dir, () => {
      const result = resolveTrustedCommand("git", { trustedDirs: [dir] });
      assert.equal(result.ok, true, "exec runs the entry it finds, so the entry's directory is the trust boundary");
    });
  });
});

test("a bare name nothing on PATH matches is passed through to report ENOENT", () => {
  const result = resolveTrustedCommand("git", { pathEnv: "/nonexistent-pstack-bin" });
  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.command : "", "git");
});

test("an absolute path outside the trusted directories is refused even when it exists", () => {
  withTempBinDir((dir) => {
    const evil = join(dir, "git");
    writeExecutable(evil);
    const result = resolveTrustedCommand(evil);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /not in a trusted binary directory/);
  });
});

test("an interpreter is refused without the opt-in and located unchecked with it", () => {
  withTempBinDir((dir) => {
    writeExecutable(join(dir, "node"));
    withPath(dir, () => {
      const refused = resolveTrustedCommand("node", { commandAllowlist: COMPANION_ALLOWLIST });
      assert.equal(refused.ok, false);
      assert.match(refused.ok === false ? refused.reason : "", /requires an explicit allowInterpreters opt-in/);
      const opted = resolveTrustedCommand("node", {
        commandAllowlist: COMPANION_ALLOWLIST,
        allowInterpreters: true,
      });
      assert.equal(opted.ok, true, "the opt-in is a grant of arbitrary execution, so the location adds nothing");
      assert.equal(opted.ok === true ? opted.command : "", "node");
    });
  });
});

test("a name outside the allowlist is refused before any path is inspected", () => {
  withTempBinDir((dir) => {
    writeExecutable(join(dir, "rm"));
    withPath(dir, () => {
      const result = resolveTrustedCommand("rm", { trustedDirs: [dir] });
      assert.equal(result.ok, false);
      assert.match(result.ok === false ? result.reason : "", /not in control_cli allowlist/);
    });
  });
});
