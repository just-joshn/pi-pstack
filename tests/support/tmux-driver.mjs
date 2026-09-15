import { execFileSync } from "node:child_process";

export function tmuxAvailable() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function spawnTmuxSession(name, cwd, env, argv) {
  const envArgs = Object.entries(env).flatMap(([key, value]) => [`${key}=${value}`]);
  execFileSync(
    "tmux",
    ["new-session", "-d", "-s", name, "-x", "120", "-y", "40", "-c", cwd, "env", ...envArgs, ...argv],
    { stdio: "ignore" },
  );
}

function capturePane(name) {
  return execFileSync("tmux", ["capture-pane", "-t", name, "-p", "-S", "-200"], {
    encoding: "utf8",
  });
}

function createWaitFor(name) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  return async (regex, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      last = capturePane(name);
      if (regex.test(last)) return last;
      await sleep(100);
    }
    throw new Error(`Timeout waiting for ${regex} in tmux session ${name}. Last capture:\n${last}`);
  };
}

function createFixture(name) {
  const waitFor = createWaitFor(name);
  return {
    name,
    send: (keys) => execFileSync("tmux", ["send-keys", "-t", name, keys], { stdio: "ignore" }),
    sendLiteral: (text) => execFileSync("tmux", ["send-keys", "-t", name, "-l", text], { stdio: "ignore" }),
    capture: () => capturePane(name),
    waitFor,
    waitForText: (needle, timeoutMs = 10000) =>
      waitFor(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), timeoutMs),
    kill: () => killSession(name),
  };
}

function killSession(name) {
  try {
    execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
  } catch {}
}

export async function withTmux(fn, options = {}) {
  const { cwd = process.cwd(), env = {}, argv = ["pi", "-a", "--no-session"] } = options;
  const name = `pstack-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fixture = createFixture(name);

  spawnTmuxSession(name, cwd, env, argv);
  try {
    return await fn(fixture);
  } finally {
    fixture.kill();
  }
}
