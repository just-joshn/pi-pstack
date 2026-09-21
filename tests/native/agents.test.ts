import { describe, expect, it } from "vitest";
import { discoverAgents, formatAgentList } from "../../extensions/subagent/agents.ts";

describe("bundled agents", () => {
  it("discovers poteto-agent, Comment Sicko, reviewer, and worker from the package", () => {
    const { agents } = discoverAgents(process.cwd(), "user");
    const names = agents.filter((agent) => agent.source === "package").map((agent) => agent.name);
    expect(names.toSorted()).toEqual(["Comment Sicko", "poteto-agent", "reviewer", "worker"]);
  });

  it("marks Comment Sicko and reviewer as read-only tool lists", () => {
    const { agents } = discoverAgents(process.cwd(), "user");
    const byName = new Map(agents.map((agent) => [agent.name, agent]));
    expect(byName.get("Comment Sicko")?.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(byName.get("reviewer")?.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(byName.get("worker")?.tools).toBeUndefined();
    expect(byName.get("poteto-agent")?.tools).toBeUndefined();
  });

  it("formatAgentList truncates with a remaining count", () => {
    const { agents } = discoverAgents(process.cwd(), "user");
    const packaged = agents.filter((agent) => agent.source === "package");
    const listed = formatAgentList(packaged, 2);
    expect(listed.remaining).toBe(packaged.length - 2);
    expect(listed.text.split("; ")).toHaveLength(2);
  });
});
