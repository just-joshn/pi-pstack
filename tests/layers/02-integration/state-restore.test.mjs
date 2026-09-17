import { expect, test } from "vitest";
import { withSession } from "../../support/session.mjs";

const STICKY_ENTRY = "pstack-poteto-mode";

async function withoutChildRole(run) {
  const saved = process.env.PSTACK_CHILD_ROLE;
  process.env.PSTACK_CHILD_ROLE = "";
  try {
    return await run();
  } finally {
    process.env.PSTACK_CHILD_ROLE = saved ?? "";
  }
}

async function withChildRole(role, run) {
  const saved = process.env.PSTACK_CHILD_ROLE;
  process.env.PSTACK_CHILD_ROLE = role;
  try {
    return await run();
  } finally {
    process.env.PSTACK_CHILD_ROLE = saved ?? "";
  }
}

async function send(f, text, options) {
  await f.session.prompt(text, options);
  await f.session.agent.waitForIdle();
}

function stickyEntries(f) {
  return f.session.sessionManager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === STICKY_ENTRY);
}

function stickyData(f) {
  return stickyEntries(f).map((entry) => entry.data);
}

function statusValues(f, key) {
  return f.ui.statuses.filter(([id]) => id === key).map(([, value]) => value);
}

function lastUserText(f) {
  const messages = f.session.sessionManager
    .getEntries()
    .filter((entry) => entry.type === "message" && entry.message?.role === "user");
  return messages.at(-1)?.message.content?.[0]?.text;
}

function hasNotification(f, level, message) {
  return f.ui.notifications.some(([type, text]) => type === level && text === message);
}

test("a strong investigation prompt arms sticky poteto and forces playbook routing", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack")]);
      await f.prompt("how does the sticky matcher work");

      const entries = stickyData(f);
      expect(entries.length).toBe(1);
      expect(entries[0].enabled).toBe(true);
      expect(entries[0].matchedPlaybookId).toBe("investigation");
      expect(entries[0].matchedScore).toBe(5);

      expect(statusValues(f, "pstack")).toEqual(["poteto:investigation"]);
      expect(statusValues(f, "pstack-ro")).toEqual(["readonly"]);
      expect(hasNotification(f, "info", "Poteto sticky armed via playbook match: investigation")).toBe(true);
      expect(hasNotification(f, "info", "Session readonly on (playbook:investigation): write/edit/bash blocked.")).toBe(true);
      expect(lastUserText(f)).toBe("/skill:poteto-mode playbooks/investigation how does the sticky matcher work");
      expect(f.session.getActiveToolNames().includes("bash"), "investigation routing strips bash").toBe(false);
    }),
  );
});

test("a weak match leaves sticky off and the turn untransformed", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack")]);
      await f.prompt("babysit");

      expect(stickyData(f)).toEqual([]);
      expect(statusValues(f, "pstack")).toEqual([]);
      expect(statusValues(f, "pstack-ro")).toEqual([]);
      expect(lastUserText(f)).toBe("babysit");
    }),
  );
});

test("an unmatched prompt leaves sticky off", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack")]);
      await f.prompt("say hello there");

      expect(stickyData(f)).toEqual([]);
      expect(statusValues(f, "pstack")).toEqual([]);
    }),
  );
});

test("child sessions skip sticky routing entirely", async () => {
  await withChildRole("poteto-agent", () =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack")]);
      await f.prompt("how does the sticky matcher work");

      expect(stickyData(f)).toEqual([]);
      expect(statusValues(f, "pstack")).toEqual([]);
      expect(lastUserText(f)).toBe("how does the sticky matcher work");
    }),
  );
});

test("extension-sourced input skips sticky routing", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack")]);
      await send(f, "how does the sticky matcher work", { source: "extension" });

      expect(stickyData(f)).toEqual([]);
      expect(statusValues(f, "pstack")).toEqual([]);
    }),
  );
});

test("an input with no text is treated as empty and leaves sticky off", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      await send(f, undefined, { expandPromptTemplates: false });

      expect(stickyData(f)).toEqual([]);
      expect(statusValues(f, "pstack")).toEqual([]);
    }),
  );
});

test("plain /poteto-mode input arms sticky without a playbook", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack")]);
      await send(f, "/poteto-mode", { expandPromptTemplates: false });

      const entries = stickyData(f);
      expect(entries.length).toBe(1);
      expect(entries[0].enabled).toBe(true);
      expect(entries[0].matchedPlaybookId).toBeUndefined();
      expect(statusValues(f, "pstack")).toEqual(["poteto"]);
    }),
  );
});

test("an explicit skill invocation persists the playbook on an already-armed session", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack")]);
      await f.prompt("/skill:poteto-mode playbooks/investigation find the cause");

      const entries = stickyData(f);
      expect(entries.length).toBe(2);
      expect(entries[0].enabled).toBe(true);
      expect(entries[0].matchedPlaybookId).toBeUndefined();
      expect(entries[1].matchedPlaybookId).toBe("investigation");
      expect(entries[1].matchedScore).toBe(10);
      expect(statusValues(f, "pstack-ro")).toEqual(["readonly"]);
    }),
  );
});

test("an armed session keeps routing on a casual follow-up turn", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack"), f.faux.assistant("ack")]);
      await f.prompt("how does the sticky matcher work");
      await f.prompt("thanks, continue");

      const entries = stickyData(f);
      expect(entries.length).toBe(1);
      expect(statusValues(f, "pstack")).toEqual(["poteto:investigation"]);
    }),
  );
});

test("poteto-mode command without a task arms plain sticky and ignores a repeat", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      await f.prompt("/poteto-mode");
      await f.prompt("/poteto-mode");

      const entries = stickyData(f);
      expect(entries.length).toBe(1);
      expect(entries[0].matchedPlaybookId).toBeUndefined();
      expect(statusValues(f, "pstack")).toEqual(["poteto"]);
      expect(f.ui.notifications.some(([type, message]) => type === "info" && message.startsWith("Poteto mode on"))).toBe(true);
    }),
  );
});

test("poteto-mode command with a matched task persists the playbook and arms readonly", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack")]);
      await f.prompt("/poteto-mode how does the matcher work");

      expect(stickyData(f).at(-1).matchedPlaybookId).toBe("investigation");
      expect(statusValues(f, "pstack")).toEqual(["poteto:investigation"]);
      expect(statusValues(f, "pstack-ro")).toEqual(["readonly"]);
      expect(hasNotification(f, "info", "Session readonly on (playbook:investigation): write/edit/bash blocked.")).toBe(true);
    }),
  );
});

test("poteto-mode with a non-readonly playbook stays writable", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack")]);
      await f.prompt("/poteto-mode check on PR 12 and get it green");

      expect(stickyData(f).at(-1).matchedPlaybookId).toBe("babysit");
      expect(statusValues(f, "pstack-ro")).toEqual([]);
      expect(f.session.getActiveToolNames().includes("bash"), "non-investigation stays writable").toBe(true);
    }),
  );
});

test("poteto-mode-off clears sticky and hides the status", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack")]);
      await f.prompt("/poteto-mode how does the matcher work");
      await f.prompt("/poteto-mode-off");

      expect(statusValues(f, "pstack").at(-1)).toBeUndefined();
      expect(stickyData(f).at(-1).enabled).toBe(false);
      expect(hasNotification(f, "info", "Poteto mode off.")).toBe(true);
    }),
  );
});

test("pstack alias reports the tool list and routes a matched task", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack")]);
      await f.prompt("/pstack");

      expect(statusValues(f, "pstack")).toEqual(["poteto"]);
      expect(f.ui.notifications.at(-1)[1]).toContain("/pstack-readonly");

      await f.prompt("/pstack how does the matcher work");

      expect(statusValues(f, "pstack")).toEqual(["poteto", "poteto:investigation"]);
      expect(stickyData(f).at(-1).matchedPlaybookId).toBe("investigation");
    }),
  );
});

test("pstack alias with an unmatched task arms sticky without a playbook", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack")]);
      await f.prompt("/pstack say hello there");

      expect(stickyData(f).at(-1).matchedPlaybookId).toBeUndefined();
      expect(statusValues(f, "pstack")).toEqual(["poteto"]);
    }),
  );
});

test("reload restores the matched playbook and readonly status", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      await f.prompt("/poteto-mode how does the matcher work");
      const before = f.ui.statuses.length;
      await f.reload();

      expect(f.extensionEvents.filter((event) => event.type === "session_start").length).toBeGreaterThanOrEqual(2);
      const restored = f.ui.statuses.slice(before);
      expect(restored).toContainEqual(["pstack", "poteto:investigation"]);
      expect(restored).toContainEqual(["pstack-ro", "readonly"]);
      expect(f.session.getActiveToolNames().includes("bash"), "restored readonly still strips bash").toBe(false);
    }),
  );
});

test("reload restores plain sticky poteto without a playbook", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      await f.prompt("/poteto-mode");
      const before = f.ui.statuses.length;
      await f.reload();

      expect(f.ui.statuses.slice(before)).toContainEqual(["pstack", "poteto"]);
    }),
  );
});
