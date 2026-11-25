import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function smokeProvider(pi: ExtensionAPI) {
  pi.registerProvider("smoke", {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "smoke",
    api: "openai-completions",
    models: [
      {
        id: "model",
        name: "Smoke model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      },
    ],
  });
  pi.registerCommand("smoke-provider", {
    description: "Registers a command so pstack can find this extension",
    handler: async () => {},
  });
}
