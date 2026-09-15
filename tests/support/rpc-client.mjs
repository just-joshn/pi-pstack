import { spawn } from "node:child_process";
import { join } from "node:path";
import { makeTempRoot } from "./temp-env.mjs";

const DEFAULT_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnRpcProcess(extensionPath, extraArgs, tmp) {
  const args = [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "-e", extensionPath,
    "-nt",
    "-a",
    ...extraArgs,
  ];
  return spawn("pi", args, {
    cwd: tmp.cwd,
    env: tmp.env(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function createLineStream(onMessage) {
  const messages = [];
  const state = { cursor: 0, tail: "" };

  const feed = (chunk) => {
    state.tail += chunk.toString();
    let index;
    while ((index = state.tail.indexOf("\n")) !== -1) {
      const line = state.tail.slice(0, index);
      state.tail = state.tail.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        messages.push(msg);
        onMessage(msg);
      } catch {}
    }
  };

  return { messages, state, feed };
}

function createDiagnostics(messages, stderrChunks) {
  return (waitingFor) => {
    const last5 = messages.slice(-5).map((m) => JSON.stringify(m)).join("\n");
    return `Timeout waiting for ${waitingFor}.\nLast 5 messages:\n${last5}\nCaptured stderr:\n${stderrChunks.join("")}`;
  };
}

function createRequest(child, pending, nextId, diagnostics) {
  return (cmd) =>
    new Promise((resolve, reject) => {
      const id = cmd.id ?? nextId.current++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(diagnostics(`response id=${id} (${JSON.stringify(cmd)})`)));
        }
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
    });
}

function createNext(stream, diagnostics) {
  return async (pred, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      while (stream.state.cursor < stream.messages.length) {
        const msg = stream.messages[stream.state.cursor++];
        if (pred(msg)) return msg;
      }
      await sleep(50);
    }
    throw new Error(diagnostics("message matching predicate"));
  };
}

function createUiWaiter(uiQueue, diagnostics) {
  return async (method, pred, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = uiQueue.find((msg) => msg.method === method && (!pred || pred(msg)));
      if (found) {
        uiQueue.splice(uiQueue.indexOf(found), 1);
        return found;
      }
      await sleep(50);
    }
    throw new Error(diagnostics(`UI method "${method}"`));
  };
}

function createCloser(child, state) {
  return () =>
    new Promise((resolve) => {
      if (state.closed) {
        resolve(undefined);
        return;
      }
      state.closed = true;
      child.on("exit", (code) => resolve(code));
      child.stdin.end();
      const forceTimer = setTimeout(() => {
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
        killTimer.unref?.();
      }, 5000);
      forceTimer.unref?.();
      child.on("exit", () => clearTimeout(forceTimer));
    });
}

function createCleanup(child, state, tmp, ownsTemp) {
  return async () => {
    if (!state.closed) {
      state.closed = true;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      killTimer.unref?.();
    }
    if (ownsTemp) tmp.cleanup();
  };
}

export async function withRpc(fn, options = {}) {
  const tmp = options.tmp || makeTempRoot();
  const ownsTemp = !options.tmp;
  const extensionPath = options.extensionPath || join(process.cwd(), "extensions", "index.ts");

  const child = spawnRpcProcess(extensionPath, options.extraArgs || [], tmp);
  const stderrChunks = [];
  const pending = new Map();
  const uiQueue = [];
  const nextId = { current: 1 };
  const state = { closed: false };

  const stream = createLineStream((msg) => {
    if (msg.type === "response" && msg.id !== undefined) {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
    }
    if (msg.type === "extension_ui_request") uiQueue.push(msg);
  });
  child.stdout.on("data", stream.feed);
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));

  const diagnostics = createDiagnostics(stream.messages, stderrChunks);
  const request = createRequest(child, pending, nextId, diagnostics);
  const close = createCloser(child, state);

  try {
    return await fn({
      tmp,
      send: (cmd) => {
        if (state.closed) throw new Error("RPC client closed");
        child.stdin.write(JSON.stringify(cmd) + "\n");
      },
      request,
      next: createNext(stream, diagnostics),
      ui: createUiWaiter(uiQueue, diagnostics),
      respondUi: (id, payload) => child.stdin.write(JSON.stringify({ type: "extension_ui_response", id, ...payload }) + "\n"),
      prompt: (text) => request({ type: "prompt", message: text }),
      commands: async () => (await request({ type: "get_commands" })).data?.commands ?? [],
      stderr: () => stderrChunks.join(""),
      close,
    });
  } finally {
    await createCleanup(child, state, tmp, ownsTemp)();
  }
}
