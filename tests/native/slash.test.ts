import { describe, expect, it } from "vitest";
import slash from "../../extensions/pstack-slash.ts";

type InputEvent = { source?: string; text: string };
type InputResult = { action: string; text?: string };

function inputHandler() {
  let captured: ((event: InputEvent) => Promise<InputResult>) | undefined;
  slash({
    on: (_name: string, handler: (event: InputEvent) => Promise<InputResult>) => {
      captured = handler;
    },
  } as never);
  if (!captured) throw new Error("slash did not register an input handler");
  return captured;
}

describe("pstack-slash", () => {
  it("rewrites a bundled skill slash to /skill:<name> and keeps args", async () => {
    const handle = inputHandler();
    const result = await handle({ text: "/how does auth work?" });
    expect(result).toEqual({ action: "transform", text: "/skill:how does auth work?" });
  });

  it("leaves non-skill slashes and extension-sourced text alone", async () => {
    const handle = inputHandler();
    const other = await handle({ text: "/todos" });
    const injected = await handle({ source: "extension", text: "/poteto-mode" });
    const plain = await handle({ text: "poteto-mode" });
    expect(other).toEqual({ action: "continue" });
    expect(injected).toEqual({ action: "continue" });
    expect(plain).toEqual({ action: "continue" });
  });
});
