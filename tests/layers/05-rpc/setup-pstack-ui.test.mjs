import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withRpc } from "../../support/rpc-client.mjs";

const BUDGET_OPTIONS = [
  "unlimited — keep max",
  "large — xhigh reasoning",
  "medium — high reasoning",
  "small — medium reasoning",
];

function configPath(rpc) {
  return join(rpc.tmp.home, ".pi", "agent", "pstack-models.json");
}

test("setup-pstack writes the chosen budget to the HOME config", async () => {
  await withRpc(async (rpc) => {
    const promptDone = rpc.prompt("/setup-pstack");

    const select = await rpc.ui("select");
    assert.equal(select.title, "pstack budget");
    assert.deepEqual(select.options, BUDGET_OPTIONS);
    rpc.respondUi(select.id, { value: "medium — high reasoning" });

    const confirm = await rpc.ui("confirm");
    assert.equal(confirm.title, "Write defaults?");
    assert.match(
      confirm.message,
      /^Write role defaults \(inherit-parent \/ mapped provider ids — no bare marketing slugs\) \(budget: medium — high reasoning\) to .*pstack-models\.json\?$/,
    );
    assert.ok(confirm.message.includes(rpc.tmp.home), `confirm missing HOME: ${confirm.message}`);
    rpc.respondUi(confirm.id, { confirmed: true });

    const notify = await rpc.ui("notify");
    assert.match(
      notify.message,
      /^Wrote .*pstack-models\.json \(edit to set real provider\/id\)\. Bare Cursor marketing slugs are mapped or refused\.$/,
    );
    assert.equal(notify.notifyType, "info");

    const response = await promptDone;
    assert.equal(response.success, true);

    const path = configPath(rpc);
    assert.ok(existsSync(path), `config not written at ${path}`);
    const config = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(config.budget, "medium — high reasoning");
    assert.equal(config.version, 1);
    assert.equal(config.roles["feature, refactoring"], "inherit-parent");
  });
});

test("setup-pstack cancelled on a rejected confirm does not write", async () => {
  await withRpc(async (rpc) => {
    const promptDone = rpc.prompt("/setup-pstack");

    const select = await rpc.ui("select");
    rpc.respondUi(select.id, { value: "medium — high reasoning" });

    const confirm = await rpc.ui("confirm");
    rpc.respondUi(confirm.id, { confirmed: false });

    const notify = await rpc.ui("notify");
    assert.equal(notify.message, "setup-pstack cancelled");

    const response = await promptDone;
    assert.equal(response.success, true);

    const path = configPath(rpc);
    assert.equal(existsSync(path), false, `config written despite cancel at ${path}`);
  });
});

test("pstack-readonly toggles the notify and status surface", async () => {
  await withRpc(async (rpc) => {
    const on = rpc.prompt("/pstack-readonly");
    const onNotify = await rpc.ui("notify");
    assert.equal(onNotify.message, "Session readonly on (command): write/edit/bash blocked.");
    assert.equal(onNotify.notifyType, "info");
    const onStatus = await rpc.ui("setStatus");
    assert.equal(onStatus.statusKey, "pstack-ro");
    assert.equal(onStatus.statusText, "readonly");
    await on;

    const off = rpc.prompt("/pstack-readonly-off");
    const offNotify = await rpc.ui("notify");
    assert.equal(offNotify.message, "Session readonly off.");
    const offStatus = await rpc.ui("setStatus");
    assert.equal(offStatus.statusKey, "pstack-ro");
    assert.equal(offStatus.statusText, undefined);
    await off;
  });
});
