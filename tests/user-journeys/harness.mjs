/**
 * User-journey bench.
 *
 * `createJourneyBench({ entry })` builds the behavior inventory once from a probe host, then runs
 * each journey against a fresh fake host: fresh temp root for cwd and PATH stubs, a wiped HOME,
 * `session_start` already emitted, and the user facade as the only invocation surface.
 *
 * Teardown always runs: `session_shutdown`, env and argv restores, and temp-root removal. A failed
 * journey still contributes whatever it observed.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createHost,
  installChildScript,
  installEnvVar,
  installFakeGh,
  installFakeGit,
  installHome,
  makeHostTempRoot,
  runGit,
  writeStubChild,
} from "../support/pi-host.mjs";
import { __resetBackgroundJobsForTests } from "../../extensions/subagents/child-runner.ts";
import { buildInventory } from "./inventory.mjs";

const HARNESS_HOME_PREFIX = "pstack-journeys-home-";
const harnessHomeState = { home: undefined, savedHome: undefined };

function installHarnessHome(prefix = HARNESS_HOME_PREFIX) {
  if (harnessHomeState.home !== undefined) return harnessHomeState.home;
  const home = mkdtempSync(join(tmpdir(), prefix));
  harnessHomeState.savedHome = process.env.HOME;
  harnessHomeState.home = home;
  process.env.HOME = home;
  return home;
}

function removeHarnessHome() {
  const home = harnessHomeState.home;
  if (home === undefined) return;
  const savedHome = harnessHomeState.savedHome;
  harnessHomeState.home = undefined;
  harnessHomeState.savedHome = undefined;
  rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) Reflect.deleteProperty(process.env, "HOME");
  else process.env.HOME = savedHome;
}

function resetHarnessHome(home) {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
}

function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function createRestoreStack() {
  let restores = [];
  return {
    add(restore) {
      if (typeof restore === "function") restores = [...restores, restore];
    },
    runAll() {
      const pending = restores.toReversed();
      restores = [];
      for (const restore of pending) runRestore(restore);
    },
  };
}

function runRestore(restore) {
  try {
    restore();
  } catch (error) {
    process.stderr.write(`user-journeys: teardown step failed: ${messageOf(error)}\n`);
  }
}

function createRecorder() {
  let observed = [];
  return {
    record(id) {
      observed = [...observed, id];
    },
    observed: () => [...observed],
  };
}

function assertRegistrationParity(host, probe) {
  assert.deepEqual([...host.tools.keys()].toSorted(), probe.toolNames.toSorted(), "tool registration drifted");
  assert.deepEqual([...host.commands.keys()].toSorted(), probe.commandNames.toSorted(), "command registration drifted");
}

async function createProbe(entry) {
  const tmp = makeHostTempRoot("pstack-journey-probe-");
  const restores = createRestoreStack();
  restores.add(installChildScript(writeStubChild(tmp.root)));
  const host = createHost(tmp.cwd, { entry });
  await host.emitSessionStart();
  const probe = {
    inventory: buildInventory({ commands: host.commands, tools: host.tools }),
    toolNames: [...host.tools.keys()],
    commandNames: [...host.commands.keys()],
  };
  const dispose = async () => {
    await shutdownHost(host);
    restores.runAll();
    rmSync(tmp.root, { recursive: true, force: true });
  };
  return { ...probe, dispose };
}

function createUserAccessors(host, tmp) {
  return {
    message: () => host.messages().at(-1)?.text,
    messages: () => host.messages(),
    status: (key) => host.statuses().filter(([candidate]) => candidate === key).at(-1)?.[1],
    statuses: () => host.statuses(),
    notifications: () => host.notifications(),
    entry: (type) => host.lastEntry(type),
    entries: () => host.entries(),
    activeTools: () => host.activeTools(),
    execCalls: () => host.execCalls(),
    registrations: () => host.registrations(),
    commands: () => [...host.commands.keys()],
    tools: () => [...host.tools.keys()],
    path: (rel) => join(tmp.cwd, rel),
    read: (rel) => readFileSync(join(tmp.cwd, rel), "utf8"),
    write: (rel, text) => writeUserFile(join(tmp.cwd, rel), text),
    exists: (rel) => existsSync(join(tmp.cwd, rel)),
    git: (argv) => runGit({ cwd: tmp.cwd, tmp }, argv),
  };
}

function writeUserFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

function createUserEmitters(host) {
  return {
    emitSessionStart: () => host.emitSessionStart(),
    emitBeforeAgentStart: (prompt, systemPrompt) => host.emitBeforeAgentStart(prompt, systemPrompt),
    emitInput: (text, source) => host.emitInput(text, source),
    emitToolCall: (name, input) => host.emitToolCall(name, input),
    emitAgentSettled: () => host.emitAgentSettled(),
    emitSessionShutdown: (reason) => host.emitSessionShutdown(reason),
  };
}

function createWaitFor() {
  return async (predicate, timeoutMs = 5000, label = "condition") => {
    const deadline = Date.now() + timeoutMs;
    let ready = await predicate();
    while (!ready) {
      if (Date.now() >= deadline) throw new Error(`user.waitFor timed out after ${timeoutMs}ms waiting for ${label}`);
      await sleep(10);
      ready = await predicate();
    }
  };
}

function createUserActions({ host, tmp, restores, recorder, nextId, resolveUnitId, fetchState }) {
  return {
    async tool(name, params) {
      if (!host.tools.has(name)) throw new Error(`user.tool: ${name} is not a registered tool`);
      recorder.record(resolveUnitId(name, params));
      return host.tools.get(name).execute(nextId(), params, undefined, undefined, host.ctx());
    },
    async command(name, args = "") {
      if (!host.commands.has(name)) throw new Error(`user.command: ${name} is not a registered command`);
      recorder.record(`command:/${name}`);
      return host.commands.get(name).handler(args, host.ctx());
    },
    waitFor: createWaitFor(),
    setExec: (fn) => host.setExec(fn),
    setConfirm: (fn) => host.setConfirm(fn),
    setFetch(fn) {
      if (!fetchState.installed) {
        fetchState.saved = globalThis.fetch;
        fetchState.installed = true;
        restores.add(() => {
          globalThis.fetch = fetchState.saved;
        });
      }
      globalThis.fetch = fn;
    },
    stubChild(source) {
      writeStubChild(tmp.root, source);
    },
    setSessionFile: (path) => host.setSessionFile(path),
    installFakeGit(mode) {
      restores.add(installFakeGit(tmp.root, mode));
    },
    installFakeGh(fixtures) {
      restores.add(installFakeGh(tmp.root, fixtures));
    },
  };
}

function createUserFacade({ host, tmp, inventory, recorder, restores }) {
  const callSeq = { value: 0 };
  const fetchState = { saved: undefined, installed: false };
  const nextId = () => {
    callSeq.value = callSeq.value + 1;
    return `u${callSeq.value}`;
  };
  const resolveUnitId = (name, params) => {
    const action = params?.action;
    const actionId = typeof action === "string" ? `tool:${name}#${action}` : undefined;
    return actionId !== undefined && inventory.byId.has(actionId) ? actionId : `tool:${name}`;
  };
  return {
    ...createUserAccessors(host, tmp),
    ...createUserEmitters(host),
    ...createUserActions({ host, tmp, restores, recorder, nextId, resolveUnitId, fetchState }),
  };
}

async function shutdownHost(host) {
  if (host === undefined) return;
  try {
    await host.emitSessionShutdown("journey-teardown");
  } catch (error) {
    process.stderr.write(`user-journeys: session_shutdown failed: ${messageOf(error)}\n`);
  }
  __resetBackgroundJobsForTests();
}

async function runTeardown(host, restores) {
  await shutdownHost(host);
  restores.runAll();
}

async function executeJourney({ entry, probe, home, journey }) {
  const tmp = makeHostTempRoot(`pstack-journey-${journey.id}-`);
  const restores = createRestoreStack();
  const recorder = createRecorder();
  const savedCwd = process.cwd();
  resetHarnessHome(home);
  restores.add(installHome(home));
  restores.add(installEnvVar("PSTACK_CHILD_ROLE", undefined));
  restores.add(installChildScript(writeStubChild(tmp.root)));
  restores.add(() => process.chdir(savedCwd));
  process.chdir(tmp.cwd);

  let host;
  let result;
  let error;
  try {
    host = createHost(tmp.cwd, { entry });
    await host.emitSessionStart();
    assertRegistrationParity(host, probe);
    const user = createUserFacade({ host, tmp, inventory: probe.inventory, recorder, restores });
    await journey.run(user);
    result = { id: journey.id, title: journey.title, status: "pass", observed: recorder.observed() };
  } catch (caught) {
    error = caught;
    const failed = { id: journey.id, title: journey.title, status: "fail", observed: recorder.observed() };
    result = { ...failed, error: messageOf(caught) };
  } finally {
    await runTeardown(host, restores);
    rmSync(tmp.root, { recursive: true, force: true });
  }
  return { result, error };
}

export async function createJourneyBench({ entry }) {
  installHarnessHome();
  const home = harnessHomeState.home;
  const state = { observed: [], results: [] };
  const probe = await createProbe(entry);
  return {
    inventory: probe.inventory,
    get observed() {
      return [...state.observed];
    },
    get results() {
      return [...state.results];
    },
    async runJourney(journey) {
      const outcome = await executeJourney({ entry, probe, home, journey });
      state.observed = [...state.observed, ...outcome.result.observed];
      state.results = [...state.results, outcome.result];
      if (outcome.error !== undefined) throw outcome.error;
      return outcome.result;
    },
    async dispose() {
      await probe.dispose();
      removeHarnessHome();
    },
  };
}
