import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage as assistant, fauxToolCall as toolCall, streamSimple } from "@earendil-works/pi-ai/compat";
import { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeTempRoot } from "./temp-env.mjs";

function inertUiContext() {
  return {
    onTerminalInput: () => () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => {},
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}

function recordingUi(options) {
  const notifications = [];
  const statuses = [];
  const dialogs = [];
  const confirmResult = options.confirm ?? true;
  const selectResult = options.select;

  const context = {
    ...inertUiContext(),
    select: async (title) => {
      dialogs.push({ method: "select", title });
      return selectResult;
    },
    confirm: async (title, message) => {
      dialogs.push({ method: "confirm", title, message });
      return confirmResult;
    },
    input: async (title) => {
      dialogs.push({ method: "input", title });
      return undefined;
    },
    editor: async (title) => {
      dialogs.push({ method: "editor", title });
      return undefined;
    },
    notify: (message, type = "info") => {
      notifications.push([type, message]);
    },
    setStatus: (key, text) => {
      statuses.push([key, text]);
    },
  };

  return { context, notifications, statuses, dialogs, confirmResult, selectResult };
}

function buildExtensionProbe(extensionEvents) {
  return (pi) => {
    pi.on("session_start", (event) => {
      extensionEvents.push(event);
    });
    pi.on("session_shutdown", (event) => {
      extensionEvents.push(event);
    });
  };
}

function createLoader(options, tmp, extensionEvents, settingsManager) {
  return new DefaultResourceLoader({
    cwd: tmp.cwd,
    agentDir: tmp.agentDir,
    settingsManager,
    additionalExtensionPaths: options.extensionPaths,
    extensionFactories: [buildExtensionProbe(extensionEvents), ...options.extensionFactories],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
}

function registerFauxOnRuntime(modelRuntime, model, faux) {
  modelRuntime.registerProvider(model.provider, {
    baseUrl: model.baseUrl,
    apiKey: "faux-key",
    api: faux.provider ?? faux.api,
    models: faux.models.map((m) => ({
      id: m.id,
      name: m.name,
      api: m.api,
      reasoning: !!m.reasoning,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      baseUrl: m.baseUrl,
    })),
  });
  return modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
}

async function createResources(options, tmp) {
  const events = [];
  const extensionEvents = [];
  const handlerErrors = [];
  const ui = recordingUi(options.ui ?? {});

  for (const [rel, data] of Object.entries(options.initialFiles)) {
    writeFileSync(join(tmp.cwd, rel), data, "utf8");
  }

  const faux = registerFauxProvider({ models: [{ id: "faux-1", name: "Faux" }] });
  const model = faux.getModel();
  if (options.fauxResponses.length > 0) {
    faux.setResponses(options.fauxResponses);
  }

  const settingsManager = SettingsManager.inMemory();
  const loader = createLoader(options, tmp, extensionEvents, settingsManager);
  await loader.reload();

  const modelRuntime = await ModelRuntime.create({
    authPath: join(tmp.agentDir, "auth.json"),
    // Null keeps the model store in memory; a file-backed store flushes on a
    // detached lock and recreates the temp root after cleanup.
    modelsPath: null,
    refreshOnCreate: false,
  });
  await registerFauxOnRuntime(modelRuntime, model, faux);

  const { session } = await createAgentSession({
    cwd: tmp.cwd,
    agentDir: tmp.agentDir,
    model,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    resourceLoader: loader,
    modelRuntime,
    tools: options.tools,
  });
  session.agent.streamFunction = streamSimple;
  session.subscribe((event) => events.push(event));

  return { session, loader, faux, events, extensionEvents, handlerErrors, ui };
}

function buildFixture(faux, resources, tmp, bind) {
  const { session, loader, events, extensionEvents, handlerErrors, ui } = resources;

  return {
    session,
    events,
    extensionEvents,
    handlerErrors,
    ui,
    tmp,
    faux: {
      setResponses: (steps) => faux.setResponses(steps),
      assistant,
      toolCall,
    },
    tool: (name) => {
      for (const ext of loader.getExtensions().extensions) {
        if (ext.tools.has(name)) return ext.tools.get(name);
      }
      return undefined;
    },
    prompt: async (text) => {
      await session.prompt(text, { source: "interactive" });
      await session.agent.waitForIdle();
    },
    reload: async () => {
      if (!bind) throw new Error("reload requires bind:true");
      await session.reload();
      const after = session.resourceLoader.getExtensions();
      if (after.errors.length > 0) {
        throw new Error(`Extension reload failed: ${JSON.stringify(after.errors)}`);
      }
    },
    read: (rel) => readFileSync(join(tmp.cwd, rel), "utf8"),
    write: (rel, data) => writeFileSync(join(tmp.cwd, rel), data, "utf8"),
    exists: (rel) => existsSync(join(tmp.cwd, rel)),
  };
}

export async function withSession(fn, options = {}) {
  const opts = {
    fauxResponses: [],
    extensionPaths: [join(process.cwd(), "extensions", "index.ts")],
    extensionFactories: [],
    tools: undefined,
    initialFiles: {},
    bind: true,
    ui: undefined,
    ...options,
  };

  const tmp = makeTempRoot();
  const resources = await createResources(opts, tmp);

  try {
    if (opts.bind) {
      await resources.session.bindExtensions({
        uiContext: resources.ui.context,
        onError: (error) => resources.handlerErrors.push(error),
      });
    }
    return await fn(buildFixture(resources.faux, resources, tmp, opts.bind));
  } finally {
    try {
      resources.session.dispose();
    } catch {}
    try {
      resources.faux.unregister();
    } catch {}
    tmp.cleanup();
  }
}
