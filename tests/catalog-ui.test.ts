import assert from "node:assert/strict";

import { describe, test } from "vitest";

import { lookup, nodes } from "../lib/catalog.ts";
import { type Host, host, readResult } from "./host.ts";
import { nth, shaped } from "./support.ts";

interface Screen {
  title: string;
  choices: string[];
}
/** Once the answers run out, the menu is closed. */
function browsing(h: Host, answers: string[]) {
  const screens: Screen[] = [];
  h.ctx.ui.select = async (title, choices) => {
    screens.push({ title, choices });
    return answers[screens.length - 1];
  };
  return screens;
}

describe("catalog commands", () => {
  test("a slash skill sends its workflow and the trimmed request as the next message", async () => {
    const h = host();
    await h.cmd("how", "  trace the pool  ");
    await h.cmd("how");
    const [asked, bare] = h.messages;
    assert.match(asked ?? "", /^Execute the Pi-native workflow how for the operator's request\./);
    assert.match(asked ?? "", /\nOperator request:\ntrace the pool$/);
    assert.match(bare ?? "", /\nOperator request:\n\(Use the current conversation context\.\)$/);
    assert.equal(h.messages.length, 2);
  });

  test("/pstack-create-skill starts the skill-authoring playbook with the request", async () => {
    const h = host();
    await h.cmd("pstack-create-skill", "a release checklist");
    const prompt = nth(h.messages, 0);
    assert.match(prompt, /^Execute the Pi-native workflow pb-authoring-a-skill /);
    assert.match(prompt, /Ordered steps[^]*\nOperator request:\na release checklist$/);
  });

  test("/pstack-map shows the node it is given, or the nodes that match a search", async () => {
    const h = host();
    h.ctx.ui.select = () => assert.fail("Only a view opens the browser");
    await h.cmd("pstack-map", " how ");
    await h.cmd("pstack-map", "runtime diagnosis");
    const node = shaped<{ id: string; label: string }>(JSON.parse(nth(h.notifications, 0)));
    assert.equal(node.id, "how");
    assert.equal(node.label, "/how");
    const found = shaped<{ id: string }[]>(JSON.parse(nth(h.notifications, 1)));
    assert(found.some((match) => match.id === "pb-runtime-forensics"));
    assert.deepEqual(found, lookup("runtime diagnosis"));
    assert.equal(h.notifications.length, 2);
    assert.equal(h.messages.length, 0);
  });

  test("without a UI, /pstack-map prints the view instead of opening the browser", async () => {
    const h = host({ mode: "print" });
    h.ctx.ui.select = () => assert.fail("There is no menu without a UI");
    await h.cmd("pstack-map");
    await h.cmd("pstack-map", "setup");
    assert.equal(h.messages.length, 2);
    const [root, setup] = h.messages.map((message) =>
      shaped<{ id: string; parent: string | null; children: string[] }>(JSON.parse(message)),
    );
    assert.equal(root?.id, "root");
    assert.equal(root.parent, null);
    assert(root.children.includes("setup"));
    assert.equal(setup?.id, "setup");
    assert.equal(setup.parent, "root");
  });

  test("the map browser opens a child view, returns to its parent and exits", async () => {
    const h = host();
    const screens = browsing(h, ["view:setup", "view:root (back)", "Exit"]);
    await h.cmd("pstack-map");
    const [root, setup, back] = screens;
    assert.equal(screens.length, 3);
    assert(root?.choices.includes("view:setup"));
    assert(!root?.choices.some((choice) => choice.endsWith("(back)")));
    assert.equal(root?.choices.at(-1), "Exit");
    assert.equal(setup?.choices[0], "view:root (back)");
    assert.notEqual(setup.title, root.title);
    assert.deepEqual(back, root);
    assert.equal(h.messages.length, 0);
  });

  test("closing the map menu ends browsing at the view that was asked for", async () => {
    const h = host();
    const screens = browsing(h, []);
    await h.cmd("pstack-map", "setup");
    assert.equal(screens.length, 1);
    assert.equal(nth(screens, 0).choices[0], "view:root (back)");
  });

  test("a node's full details reach the transcript only when the operator asks", async () => {
    const h = host();
    const send = "Send full details to transcript";
    const screens = browsing(h, ["node:poteto-mode", "Back", "node:poteto-mode", send, "Exit"]);
    await h.cmd("pstack-map");
    const details = nth(screens, 1);
    assert.match(details.title, /^poteto-mode: /);
    assert.match(details.title, /\nplaybooks: /);
    assert.deepEqual(details.choices, ["Back", send]);
    assert.deepEqual(nth(screens, 2), nth(screens, 0));
    assert.equal(h.messages.length, 1);
    const sent = shaped<{ id: string }>(JSON.parse(nth(h.messages, 0)));
    assert.equal(sent.id, "poteto-mode");
    const node = await h.call("pstack_catalog", { action: "node", id: "poteto-mode" });
    assert.deepEqual(sent, readResult(node));
  });

  test("the catalog tool searches everything by default but never guesses a node", async () => {
    const h = host();
    const everything = shaped<unknown[]>(
      readResult(await h.call("pstack_catalog", { action: "search" })),
    );
    assert.equal(everything.length, nodes.size);
    await assert.rejects(() => h.call("pstack_catalog", { action: "node" }), /Unknown node/);
  });

  test("catalog tools expose routes, views, search results and node instructions", async () => {
    const h = host();
    const read = async (action: string, id?: string) =>
      readResult(await h.call("pstack_catalog", { action, id }));
    const listed = async (action: string, id?: string) =>
      shaped<{ id: string }[]>(await read(action, id));
    const one = async (action: string, id?: string) =>
      shaped<{ id: string; instructions?: string }>(await read(action, id));
    assert((await listed("routes")).some((route) => route.id === "bug-fix"));
    assert.equal((await one("view")).id, "root");
    assert(
      (await listed("search", "runtime diagnosis")).some(
        (node) => node.id === "pb-runtime-forensics",
      ),
    );
    assert.match((await one("node", "pb-bug-fix")).instructions ?? "", /Ordered steps/);
  });
});
