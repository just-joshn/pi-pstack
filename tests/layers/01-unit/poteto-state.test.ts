import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInitialPotetoState,
  reducePersistMatch,
  reduceRecordText,
  reduceRestore,
  reduceSetEnabled,
} from "../../../extensions/poteto-state/index.ts";

interface AppendEffect {
  type: "appendEntry";
  entryType: string;
  payload: { enabled: boolean; matchedPlaybookId?: string | null; matchedScore?: number };
}

interface StatusEffect {
  type: "setStatus";
  statusId: string;
  value: string | undefined;
}

const appendOf = (effects) => effects.find((effect) => effect.type === "appendEntry") as AppendEffect | undefined;
const statusOf = (effects) => effects.find((effect) => effect.type === "setStatus") as StatusEffect | undefined;
const armedState = () => reduceSetEnabled(createInitialPotetoState(), true, { id: "why", score: 5 }).state;

test("createInitialPotetoState starts disabled with no match and empty text", () => {
  assert.deepEqual(createInitialPotetoState(), { enabled: false, matchedPlaybookId: null, lastUserText: "" });
});

test("reduceSetEnabled arms on a strong match with a sticky entry and matched status", () => {
  const result = reduceSetEnabled(createInitialPotetoState(), true, { id: "babysit", score: 7 });
  assert.deepEqual(result.state, { enabled: true, matchedPlaybookId: "babysit", lastUserText: "" });
  assert.equal(appendOf(result.effects)?.entryType, "pstack-poteto-mode");
  assert.equal(appendOf(result.effects)?.payload.enabled, true);
  assert.equal(appendOf(result.effects)?.payload.matchedPlaybookId, "babysit");
  assert.equal(appendOf(result.effects)?.payload.matchedScore, 7);
  assert.equal(statusOf(result.effects)?.statusId, "pstack");
  assert.equal(statusOf(result.effects)?.value, "poteto:babysit");
});

test("reduceSetEnabled without a match arms plain poteto and persists no playbook id", () => {
  const result = reduceSetEnabled(createInitialPotetoState(), true);
  assert.equal(result.state.matchedPlaybookId, null);
  assert.equal(appendOf(result.effects)?.payload.matchedPlaybookId, undefined);
  assert.equal(statusOf(result.effects)?.value, "poteto");
});

test("reduceSetEnabled is a no-op when the flag and match do not change", () => {
  const state = createInitialPotetoState();
  const result = reduceSetEnabled(state, false);
  assert.equal(result.state, state);
  assert.deepEqual(result.effects, []);
});

test("reduceSetEnabled with a null match clears the persisted playbook", () => {
  const result = reduceSetEnabled(armedState(), true, null);
  assert.equal(result.state.matchedPlaybookId, null);
  assert.equal(statusOf(result.effects)?.value, "poteto");
});

test("reduceSetEnabled(false) clears the match and hides the status", () => {
  const result = reduceSetEnabled(armedState(), false);
  assert.deepEqual(result.state, { enabled: false, matchedPlaybookId: null, lastUserText: "" });
  assert.equal(statusOf(result.effects)?.value, undefined);
});

test("reducePersistMatch updates the playbook and emits one sticky entry", () => {
  const result = reducePersistMatch(armedState(), { id: "babysit", score: 3 });
  assert.equal(result.state.enabled, true);
  assert.equal(result.state.matchedPlaybookId, "babysit");
  assert.equal(result.effects.length, 1);
  assert.equal(appendOf(result.effects)?.payload.matchedPlaybookId, "babysit");
});

test("reduceRecordText keeps the other fields and stores the text", () => {
  assert.deepEqual(reduceRecordText(armedState(), "babysit PR 12"), {
    enabled: true,
    matchedPlaybookId: "why",
    lastUserText: "babysit PR 12",
  });
});

test("reduceRestore folds custom entry data into the last sticky state", () => {
  assert.deepEqual(
    reduceRestore([
      { enabled: true, matchedPlaybookId: "why" },
      { enabled: true, matchedPlaybookId: "babysit" },
    ]),
    { enabled: true, matchedPlaybookId: "babysit", lastUserText: "" },
  );
});

test("reduceRestore ignores malformed entries and keeps a match after a disabled entry", () => {
  assert.deepEqual(reduceRestore([null, "junk", { enabled: "yes" }]), {
    enabled: false,
    matchedPlaybookId: null,
    lastUserText: "",
  });
  assert.deepEqual(reduceRestore([{ enabled: true, matchedPlaybookId: "why" }, { enabled: false }]), {
    enabled: false,
    matchedPlaybookId: "why",
    lastUserText: "",
  });
});
