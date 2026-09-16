import { test } from "node:test";
import assert from "node:assert/strict";
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
    assert.equal(hostedBaseUrl(), undefined);
    assert.throws(
      () => requireHostedBaseUrl(),
      /set PSTACK_HOSTED_URL to the services\/worker base URL/,
    );
    await assert.rejects(() => postTask(envelopeFor()), /hosted worker unavailable/);
    process.env.PSTACK_HOSTED_URL = "  http://worker.test///  ";
    assert.equal(hostedBaseUrl(), "http://worker.test");
    assert.equal(requireHostedBaseUrl(), "http://worker.test");
    process.env.PSTACK_HOSTED_URL = "   ";
    assert.equal(hostedBaseUrl(), undefined);
  } finally {
    restoreEnv("PSTACK_HOSTED_URL", saved);
  }
});

test("buildTaskEnvelope derives capabilities and defaults the optional fields", () => {
  const inherit = envelopeFor();
  assert.deepEqual(inherit.capabilities, ALL_CATEGORIES);
  assert.equal(inherit.idempotencyKey, "idem-run-1");
  assert.deepEqual(inherit.parentOwnership, { sessionId: "", cwd: "/tmp/parent" });
  assert.equal(inherit.parentSessionCwd, "/tmp/parent");
  assert.equal(inherit.thinkingLevel, null);
  assert.equal(inherit.isolation, "remote");
  assert.equal(inherit.timeoutMs, 600000);
  assert.equal(inherit.reportSchema, null);
  assert.equal(inherit.role, "general");
  assert.deepEqual(inherit.secretRefs, []);
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
  assert.deepEqual(explicit.capabilities, ["team-chat"]);
  assert.equal(explicit.idempotencyKey, "key-explicit");
  assert.equal(explicit.parentOwnership.sessionId, "s1");
  assert.equal(explicit.thinkingLevel, "high");
  assert.equal(explicit.isolation, "process");
  assert.equal(explicit.timeoutMs, 5);
  assert.deepEqual(explicit.reportSchema, { type: "object" });
  assert.deepEqual(explicit.secretRefs, ["SLACK_TOKEN"]);
  assert.deepEqual(envelopeFor({ policy: { ...POLICY, integrations: "none" } }).capabilities, []);
  assert.deepEqual(
    envelopeFor({ policy: { ...POLICY, integrations: ["analytics", "team-chat"] } }).capabilities,
    ["analytics", "team-chat"],
  );
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
    assert.equal(reply.status, 202);
    assert.equal(reply.text, '{"runId":"run-1","attempt":1,"state":"running"}');
    assert.deepEqual(reply.record, { runId: "run-1", attempt: 1, state: "running" });
    assert.deepEqual(server.requests(), [
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
    assert.equal(got.status, 200);
    assert.deepEqual(got.record, { ok: true });
    const cancelled = await cancelTask("run 1/2", { base: server.base });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.record.ok, true);
    assert.deepEqual(
      server.requests().map((entry) => `${entry.method} ${entry.url}`),
      ["GET /v1/tasks/run%201%2F2", "POST /v1/tasks/run%201%2F2/cancel"],
    );
    assert.equal(server.requests()[0].authorization, undefined);
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
    await assert.rejects(
      () => getTask("run-1", { base: server.base }),
      /pstack_task hosted worker GET \/v1\/tasks\/run-1 failed: HTTP 500 Internal Server Error \{"error":"boom"\}/,
    );
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
    assert.deepEqual(reply, { status: 200, text: "plain ok", record: undefined });
  } finally {
    await server.close();
  }
});

test("an aborted hosted request rejects instead of resolving", async () => {
  const server = await startLoopback(() => {});
  try {
    await assert.rejects(
      () => getTask("run-1", { base: server.base, signal: AbortSignal.timeout(50) }),
      (error) => error.name === "TimeoutError",
    );
  } finally {
    await server.close();
  }
});

test("splitFrontmatter parses folded scalars and unquotes escaped values", () => {
  const folded = splitFrontmatter(
    ["---", "name: demo", "reminder: >-", "  line one", "  line two", "color: |", "  red", "---", "body"].join("\n"),
  );
  assert.deepEqual(folded.fields, { name: "demo", reminder: "line one line two", color: "red" });
  assert.equal(folded.body, "body");
  assert.equal(parseSkillChrome(folded.body).icon, undefined);
  const quoted = splitFrontmatter(['---', 'name: "say \\"hi\\""', "---", "body"].join("\n"));
  assert.equal(quoted.fields.name, 'say "hi"');
  const badEscape = splitFrontmatter(['---', 'name: "a\\qb"', "---", "body"].join("\n"));
  assert.equal(badEscape.fields.name, "a\\qb");
  assert.deepEqual(splitFrontmatter("plain\n").fields, {});
  assert.deepEqual(splitFrontmatter("---\nunclosed\n"), { fields: {}, body: "---\nunclosed" });
});

test("capToolOutput writes the full text and reports the degenerate and tail truncations", () => {
  const longLine = "x".repeat(60000);
  const head = capToolOutput(longLine, { keep: "head", label: "lib-head" });
  assert.equal(head.truncated, true);
  assert.match(head.text, /\[Output truncated: 1 of 1 lines \(50\.0KB of 58\.6KB\)\./);
  assert.equal(existsSync(head.outputPath), true);
  assert.equal(readFileSync(head.outputPath, "utf8"), longLine);
  const lines = Array.from({ length: 6000 }, (_unused, index) => `line-${index}`).join("\n");
  const tail = capToolOutput(lines, { keep: "tail", label: "lib-tail" });
  assert.equal(tail.truncated, true);
  assert.equal(tail.text.includes("line-5999"), true);
  assert.equal(tail.text.includes("line-0\n"), false);
  assert.match(tail.text, /\[Output truncated: 2000 of 6000 lines/);
  assert.equal(readFileSync(tail.outputPath, "utf8"), lines);
  const short = capToolOutput("small", { keep: "head", label: "lib-short" });
  assert.deepEqual(short, { text: "small", truncated: false });
});
