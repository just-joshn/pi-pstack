// Pi's --no-extensions drops these built-in extensions too. Without them, the model can reach an MCP
// tool only if its server exposes it directly; codemode and tool_search reach the rest.
export const mcpExtensions = ["builtin:mcp", "builtin:codemode", "builtin:tool-search"];
export const mcpTools = ["codemode", "tool_search"];
