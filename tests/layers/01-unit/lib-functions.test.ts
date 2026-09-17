import { expect, test } from "vitest";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import {
  buildTaskEnvelope,
  cancelTask,
  getTask,
  hostedBaseUrl,
  postTask,
  requireHostedBaseUrl,
} from "../../../extensions/hosted/client.ts";
import { capToolOutput } from "../../../extensions/lib/tool-output.ts";
import { parseSkillChrome, splitFrontmatter } from "../../../extensions/lib/skill-chrome.ts";

const POLICY = {
  filesystem: "workspace-write",
  shell: "full",
  git: "branch-write",
  network: "allowed",
  integrations: "inherit",
  environment: "hosted",
  background: false,
  isolation: "remote",
};

const ALL_CATEGORIES = [
  "source-control",
  "issue-tracker",
  "long-form-docs",
  "team-chat",
  "observability",
  "error-tracking",
  "analytics",
  "browser-ui",
  "cli-tui",
];

function restoreEnv(name, value) {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

function envelopeFor(overrides = {}) {
  return buildTaskEnvelope({
    runId: "run-1",
    task: "do it",
    role: "general",
    model: "test/model",
    policy: POLICY,
    parentCwd: "/tmp/parent",
    ...overrides,
  });
}

async function startLoopback(handler) {
  let requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body = body + chunk.toString();
    });
    req.on("end", () => {
      const entry = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body,
      };
      requests = [...requests, entry];
      handler(req, res, entry);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    requests: () => requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("hostedBaseUrl trims the env base and requireHostedBaseUrl fails closed", async () => {
  const saved = process.env.PSTACK_HOSTED_URL;
  try {
    Reflect.deleteProperty(process.env, "PSTACK_HOSTED_URL");
    expect(hostedBaseUrl()).toBe(undefined);
    expect(() => requireHostedBaseUrl()).toThrow(/set PSTACK_HOSTED_URL to the services\/worker base URL/);
    await expect(() => postTask(envelopeFor())).rejects.toThrow(/hosted worker unavailable/);
    process.env.PSTACK_HOSTED_URL = "  http://worker.test///  ";
    expect(hostedBaseUrl()).toBe("http://worker.test");
    expect(requireHostedBaseUrl()).toBe("http://worker.test");
    process.env.PSTACK_HOSTED_URL = "   ";
    expect(hostedBaseUrl()).toBe(undefined);
  } finally {
    restoreEnv("PSTACK_HOSTED_URL", saved);
  }
});

test("buildTaskEnvelope derives capabilities and defaults the optional fields", () => {
  const inherit = envelopeFor();
  expect(inherit.capabilities).toEqual(ALL_CATEGORIES);
  expect(inherit.idempotencyKey).toBe("idem-run-1");
  expect(inherit.parentOwnership).toEqual({ sessionId: "", cwd: "/tmp/parent" });
  expect(inherit.parentSessionCwd).toBe("/tmp/parent");
  expect(inherit.thinkingLevel).toBe(null);
  expect(inherit.isolation).toBe("remote");
  expect(inherit.timeoutMs).toBe(600000);
  expect(inherit.reportSchema).toBe(null);
  expect(inherit.role).toBe("general");
  expect(inherit.secretRefs).toEqual([]);
  const explicit = envelopeFor({
    capabilities: ["team-chat"],
    parentSessionId: "s1",
    idempotencyKey: "key-explicit",
    thinkingLevel: "high",
    isolation: "process",
    timeoutMs: 5,
    reportSchema: { type: "object" },
    secretRefs: ["SLACK_TOKEN"],
  });
  expect(explicit.capabilities).toEqual(["team-chat"]);
  expect(explicit.idempotencyKey).toBe("key-explicit");
  expect(explicit.parentOwnership.sessionId).toBe("s1");
  expect(explicit.thinkingLevel).toBe("high");
  expect(explicit.isolation).toBe("process");
  expect(explicit.timeoutMs).toBe(5);
  expect(explicit.reportSchema).toEqual({ type: "object" });
  expect(explicit.secretRefs).toEqual(["SLACK_TOKEN"]);
  expect(envelopeFor({ policy: { ...POLICY, integrations: "none" } }).capabilities).toEqual([]);
  expect(envelopeFor({ policy: { ...POLICY, integrations: ["analytics", "team-chat"] } }).capabilities).toEqual(["analytics", "team-chat"]);
});

test("postTask posts the envelope with the worker token and parses the reply", async () => {
  const server = await startLoopback((_req, res) => {
    res.writeHead(202, { "content-type": "application/json" });
    res.end('{"runId":"run-1","attempt":1,"state":"running"}');
  });
  const saved = process.env.PSTACK_WORKER_TOKEN;
  process.env.PSTACK_WORKER_TOKEN = "worker-secret";
  try {
    const envelope = envelopeFor();
    const reply = await postTask(envelope, { base: server.base });
    expect(reply.status).toBe(202);
    expect(reply.text).toBe('{"runId":"run-1","attempt":1,"state":"running"}');
    expect(reply.record).toEqual({ runId: "run-1", attempt: 1, state: "running" });
    expect(server.requests()).toEqual([
      {
        method: "POST",
        url: "/v1/tasks",
        authorization: "Bearer worker-secret",
        body: JSON.stringify(envelope),
      },
    ]);
  } finally {
    restoreEnv("PSTACK_WORKER_TOKEN", saved);
    await server.close();
  }
});

test("getTask and cancelTask address the worker routes with encoded ids", async () => {
  const server = await startLoopback((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  try {
    const got = await getTask("run 1/2", { base: server.base });
    expect(got.status).toBe(200);
    expect(got.record).toEqual({ ok: true });
    const cancelled = await cancelTask("run 1/2", { base: server.base });
    expect(cancelled.status).toBe(200);
    expect(cancelled.record.ok).toBe(true);
    expect(server.requests().map((entry) => `${entry.method} ${entry.url}`)).toEqual(["GET /v1/tasks/run%201%2F2", "POST /v1/tasks/run%201%2F2/cancel"]);
    expect(server.requests()[0].authorization).toBe(undefined);
  } finally {
    await server.close();
  }
});

test("a non-2xx hosted reply throws with the status and body", async () => {
  const server = await startLoopback((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"boom"}');
  });
  try {
    await expect(() => getTask("run-1", { base: server.base })).rejects.toThrow(/pstack_task hosted worker GET \/v1\/tasks\/run-1 failed: HTTP 500 Internal Server Error \{"error":"boom"\}/);
  } finally {
    await server.close();
  }
});

test("a non-JSON hosted reply keeps the status and text with no record", async () => {
  const server = await startLoopback((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("plain ok");
  });
  try {
    const reply = await getTask("run-1", { base: server.base });
    expect(reply).toEqual({ status: 200, text: "plain ok", record: undefined });
  } finally {
    await server.close();
  }
});

test("an aborted hosted request rejects instead of resolving", async () => {
  const server = await startLoopback(() => {});
  try {
    await expect(
      getTask("run-1", { base: server.base, signal: AbortSignal.timeout(50) }),
    ).rejects.toSatisfy((error: Error) => error.name === "TimeoutError");
  } finally {
    await server.close();
  }
});

test("splitFrontmatter parses folded scalars and unquotes escaped values", () => {
  const folded = splitFrontmatter(
    ["---", "name: demo", "reminder: >-", "  line one", "  line two", "color: |", "  red", "---", "body"].join("\n"),
  );
  expect(folded.fields).toEqual({ name: "demo", reminder: "line one line two", color: "red" });
  expect(folded.body).toBe("body");
  expect(parseSkillChrome(folded.body).icon).toBe(undefined);
  const quoted = splitFrontmatter(['---', 'name: "say \\"hi\\""', "---", "body"].join("\n"));
  expect(quoted.fields.name).toBe('say "hi"');
  const badEscape = splitFrontmatter(['---', 'name: "a\\qb"', "---", "body"].join("\n"));
  expect(badEscape.fields.name).toBe("a\\qb");
  expect(splitFrontmatter("plain\n").fields).toEqual({});
  expect(splitFrontmatter("---\nunclosed\n")).toEqual({ fields: {}, body: "---\nunclosed" });
});

test("capToolOutput writes the full text and reports the degenerate and tail truncations", () => {
  const longLine = "x".repeat(60000);
  const head = capToolOutput(longLine, { keep: "head", label: "lib-head" });
  expect(head.truncated).toBe(true);
  expect(head.text).toMatch(/\[Output truncated: 1 of 1 lines \(\d+\.\dKB of 58\.6KB\)\./);
  expect(Buffer.byteLength(head.text, "utf8") <= 51200).toBeTruthy();
  expect(existsSync(head.outputPath)).toBe(true);
  expect(readFileSync(head.outputPath, "utf8")).toBe(longLine);
  const lines = Array.from({ length: 6000 }, (_unused, index) => `line-${index}`).join("\n");
  const tail = capToolOutput(lines, { keep: "tail", label: "lib-tail" });
  expect(tail.truncated).toBe(true);
  expect(tail.text.includes("line-5999")).toBe(true);
  expect(tail.text.includes("line-0\n")).toBe(false);
  expect(tail.text).toMatch(/\[Output truncated: 2000 of 6000 lines/);
  expect(readFileSync(tail.outputPath, "utf8")).toBe(lines);
  const short = capToolOutput("small", { keep: "head", label: "lib-short" });
  expect(short).toEqual({ text: "small", truncated: false });
});
