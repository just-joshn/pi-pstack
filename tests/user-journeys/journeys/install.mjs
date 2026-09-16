import { expect } from "vitest";

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
  for (const [name, count] of counts) expect(count, `${name} registered ${count} times`).toBe(1);
}

function assertToolSurface(toolNames) {
  const floor = CENSUS_TOOLS.length;
  expect(toolNames.length >= floor, `expected at least ${floor} tools, saw ${toolNames.length}`).toBeTruthy();
  expect(new Set(toolNames).size, `duplicate tool names: ${toolNames.join(", ")}`).toBe(toolNames.length);
  for (const name of CENSUS_TOOLS) expect(toolNames.includes(name), `${name} missing from the tool surface`).toBeTruthy();
}

function censusedTools(censusText) {
  return censusText.slice(CENSUS_PREFIX.length).split(". ")[0].split(", ");
}

async function run(user) {
  const registrations = user.registrations();
  expect(registrations.length >= 40, `expected a full command surface, saw ${registrations.length}`).toBeTruthy();
  assertSingleRegistration(registrations);
  expect(registrations.toSorted(), "registrations disagree with handlers").toEqual(user.commands().toSorted());

  const toolNames = user.tools();
  assertToolSurface(toolNames);

  await user.command("pstack", "");
  const census = user.notifications().at(-1);
  expect(census?.[0], `unexpected census level: ${census?.[0]}`).toBe("info");
  expect(String(census?.[1]).startsWith(`${CENSUS_PREFIX}pstack_spawn, `), `unexpected census: ${census?.[1]}`).toBeTruthy();
  const listed = censusedTools(String(census?.[1]));
  expect(listed, "census lists unexpected tools").toEqual(CENSUS_TOOLS);
  for (const name of listed) expect(toolNames.includes(name), `${name} listed in the census but not registered`).toBeTruthy();
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
