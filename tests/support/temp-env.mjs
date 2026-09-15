import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempRoot(prefix = "pstack-test-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const cwd = join(root, "cwd");
  const sessions = join(root, "sessions");

  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });

  function env(extra = {}) {
    return {
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PATH: process.env.PATH,
      ...extra,
    };
  }

  function cleanup() {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }

  return { root, home, agentDir, cwd, sessions, env, cleanup };
}
