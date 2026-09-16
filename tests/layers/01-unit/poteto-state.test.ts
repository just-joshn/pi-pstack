import { expect, test } from "vitest";
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
  expect(createInitialPotetoState()).toEqual({
    enabled: false,
    matchedPlaybookId: null,
    matchedScore: 0,
    assignedThisTurn: false,
    lastUserText: "",
  });
});

test("reduceSetEnabled arms on a strong match with a sticky entry and matched status", () => {
  const result = reduceSetEnabled(createInitialPotetoState(), true, { id: "babysit", score: 7 });
  expect(result.state).toEqual({
    enabled: true,
    matchedPlaybookId: "babysit",
    matchedScore: 7,
    assignedThisTurn: true,
    lastUserText: "",
  });
  expect(appendOf(result.effects)?.entryType).toBe("pstack-poteto-mode");
  expect(appendOf(result.effects)?.payload.enabled).toBe(true);
  expect(appendOf(result.effects)?.payload.matchedPlaybookId).toBe("babysit");
  expect(appendOf(result.effects)?.payload.matchedScore).toBe(7);
  expect(statusOf(result.effects)?.statusId).toBe("pstack");
  expect(statusOf(result.effects)?.value).toBe("poteto:babysit");
});

test("reduceSetEnabled without a match arms plain poteto and persists no playbook id", () => {
  const result = reduceSetEnabled(createInitialPotetoState(), true);
  expect(result.state.matchedPlaybookId).toBe(null);
  expect(appendOf(result.effects)?.payload.matchedPlaybookId).toBe(undefined);
  expect(statusOf(result.effects)?.value).toBe("poteto");
});

test("reduceSetEnabled is a no-op when the flag and match do not change", () => {
  const state = createInitialPotetoState();
  const result = reduceSetEnabled(state, false);
  expect(result.state).toBe(state);
  expect(result.effects).toEqual([]);
});

test("reduceSetEnabled with a null match clears the persisted playbook", () => {
  const result = reduceSetEnabled(armedState(), true, null);
  expect(result.state.matchedPlaybookId).toBe(null);
  expect(statusOf(result.effects)?.value).toBe("poteto");
});

test("reduceSetEnabled(false) clears the match and hides the status", () => {
  const result = reduceSetEnabled(armedState(), false);
  expect(result.state).toEqual({
    enabled: false,
    matchedPlaybookId: null,
    matchedScore: 0,
    assignedThisTurn: false,
    lastUserText: "",
  });
  expect(statusOf(result.effects)?.value).toBe(undefined);
});

test("reducePersistMatch updates the playbook and emits one sticky entry", () => {
  const result = reducePersistMatch(armedState(), { id: "babysit", score: 3 });
  expect(result.state.enabled).toBe(true);
  expect(result.state.matchedPlaybookId).toBe("babysit");
  expect(result.state.matchedScore).toBe(3);
  expect(result.state.assignedThisTurn).toBe(true);
  expect(result.effects.length).toBe(1);
  expect(appendOf(result.effects)?.payload.matchedPlaybookId).toBe("babysit");
});

test("reduceRecordText keeps the other fields and stores the text", () => {
  expect(reduceRecordText(armedState(), "babysit PR 12")).toEqual({
    enabled: true,
    matchedPlaybookId: "why",
    matchedScore: 5,
    assignedThisTurn: false,
    lastUserText: "babysit PR 12",
  });
});

test("reduceRestore folds custom entry data into the last sticky state", () => {
  expect(reduceRestore([
      { enabled: true, matchedPlaybookId: "why" },
      { enabled: true, matchedPlaybookId: "babysit" },
    ])).toEqual({ enabled: true, matchedPlaybookId: "babysit", matchedScore: 0, assignedThisTurn: false, lastUserText: "" });
});

test("reduceRestore ignores malformed entries and keeps a match after a disabled entry", () => {
  expect(reduceRestore([null, "junk", { enabled: "yes" }])).toEqual({
    enabled: false,
    matchedPlaybookId: null,
    matchedScore: 0,
    assignedThisTurn: false,
    lastUserText: "",
  });
  expect(reduceRestore([{ enabled: true, matchedPlaybookId: "why" }, { enabled: false }])).toEqual({
    enabled: false,
    matchedPlaybookId: "why",
    matchedScore: 0,
    assignedThisTurn: false,
    lastUserText: "",
  });
});
