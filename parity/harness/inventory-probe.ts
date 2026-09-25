import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    const out = process.env.PSTACK_INVENTORY_OUT;
    if (!out) return;
    const tools = pi.getAllTools().map((tool) => ({ name: tool.name, source: tool.sourceInfo?.path ?? "builtin" }));
    writeFileSync(out, JSON.stringify({ tools, active: pi.getActiveTools() }, null, 2));
  });
}
