import assert from "node:assert/strict";

const CENSUS_PREFIX = "pi-pstack tools: ";
const CENSUS_TOOLS = [
  "pstack_spawn",
  "pstack_jobs",
  "pstack_swarm",
  "pstack_arena",
  "pstack_loop",
  "pstack_deslop",
  "pstack_ship",
  "pstack_babysit",
  "pstack_benny_wake",
];

function assertSingleRegistration(registrations) {
  const counts = new Map();
  for (const name of registrations) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const [name, count] of counts) assert.equal(count, 1, `${name} registered ${count} times`);
}

function assertToolSurface(toolNames) {
  const floor = CENSUS_TOOLS.length;
  assert.ok(toolNames.length >= floor, `expected at least ${floor} tools, saw ${toolNames.length}`);
  assert.equal(new Set(toolNames).size, toolNames.length, `duplicate tool names: ${toolNames.join(", ")}`);
  for (const name of CENSUS_TOOLS) assert.ok(toolNames.includes(name), `${name} missing from the tool surface`);
}

function censusedTools(censusText) {
  return censusText.slice(CENSUS_PREFIX.length).split(". ")[0].split(", ");
}

async function run(user) {
  const registrations = user.registrations();
  assert.ok(registrations.length >= 40, `expected a full command surface, saw ${registrations.length}`);
  assertSingleRegistration(registrations);
  assert.deepEqual(registrations.toSorted(), user.commands().toSorted(), "registrations disagree with handlers");

  const toolNames = user.tools();
  assertToolSurface(toolNames);

  await user.command("pstack", "");
  const census = user.notifications().at(-1);
  assert.equal(census?.[0], "info", `unexpected census level: ${census?.[0]}`);
  assert.ok(String(census?.[1]).startsWith(`${CENSUS_PREFIX}pstack_spawn, `), `unexpected census: ${census?.[1]}`);
  const listed = censusedTools(String(census?.[1]));
  assert.deepEqual(listed, CENSUS_TOOLS, "census lists unexpected tools");
  for (const name of listed) assert.ok(toolNames.includes(name), `${name} listed in the census but not registered`);
}

export const JOURNEYS = [
  {
    id: "install-and-orient",
    title: "a user installs the package and sees the pstack surface",
    critical: true,
    surfaces: ["content", "commands"],
    run,
  },
];
