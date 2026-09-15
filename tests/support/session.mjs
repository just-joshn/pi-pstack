import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage as assistant, fauxToolCall as toolCall, streamSimple } from "@earendil-works/pi-ai/compat";
import { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeTempRoot } from "./temp-env.mjs";
import { bestEffort } from "./best-effort.mjs";

function createLiveList() {
  let items = [];
  return {
    add: (item) => {
      items = [...items, item];
    },
    all: () => items,
  };
}

function inertUiContext() {  return {
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
  let notifications = [];
  let statuses = [];
  let dialogs = [];
  const confirmResult = options.confirm ?? true;
  const selectResult = options.select;

  const context = {
    ...inertUiContext(),
    select: async (title) => {
      dialogs = [...dialogs, { method: "select", title }];
      return selectResult;
    },
    confirm: async (title, message) => {
      dialogs = [...dialogs, { method: "confirm", title, message }];
      return confirmResult;
    },
    input: async (title) => {
      dialogs = [...dialogs, { method: "input", title }];
      return undefined;
    },
    editor: async (title) => {
      dialogs = [...dialogs, { method: "editor", title }];
      return undefined;
    },
    notify: (message, type = "info") => {
      notifications = [...notifications, [type, message]];
    },
    setStatus: (key, text) => {
      statuses = [...statuses, [key, text]];
    },
  };

  return {
    context,
    get notifications() {
      return notifications;
    },
    get statuses() {
      return statuses;
    },
    get dialogs() {
      return dialogs;
    },
    confirmResult,
    selectResult,
  };
}

function buildExtensionProbe(container) {
  return (pi) => {
    pi.on("session_start", (event) => {
      container.add(event);
    });
    pi.on("session_shutdown", (event) => {
      container.add(event);
    });
  };
}

function createLoader(options, tmp, extensionEventsContainer, settingsManager) {
  return new DefaultResourceLoader({
    cwd: tmp.cwd,
    agentDir: tmp.agentDir,
    settingsManager,
    additionalExtensionPaths: options.extensionPaths,
    extensionFactories: [buildExtensionProbe(extensionEventsContainer), ...options.extensionFactories],
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
  const events = createLiveList();
  const extensionEvents = createLiveList();
  const handlerErrors = createLiveList();
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
  session.subscribe((event) => events.add(event));

  return {
    session,
    loader,
    faux,
    events,
    extensionEvents,
    handlerErrors,
    ui,
  };
}

function buildFixture(faux, resources, tmp, bind) {
  const { session, loader, ui } = resources;

  return {
    session,
    get events() {
      return resources.events.all();
    },
    get extensionEvents() {
      return resources.extensionEvents.all();
    },
    get handlerErrors() {
      return resources.handlerErrors.all();
    },
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
        onError: (error) => { resources.handlerErrors.add(error); },
      });
    }
    return await fn(buildFixture(resources.faux, resources, tmp, opts.bind));
  } finally {
    bestEffort("session dispose", () => resources.session.dispose());
    bestEffort("faux unregister", () => resources.faux.unregister());
    tmp.cleanup();
  }
}
