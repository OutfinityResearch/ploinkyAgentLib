var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.mjs
var src_exports = {};
__export(src_exports, {
  Agent: () => Agent,
  __resetForTests: () => __resetForTests,
  brainstorm: () => brainstorm,
  callOperator: () => callOperator,
  cancelTasks: () => cancelTasks,
  chooseOperator: () => chooseOperator,
  doTask: () => doTask,
  doTaskWithHumanReview: () => doTaskWithHumanReview,
  doTaskWithReview: () => doTaskWithReview,
  listAgents: () => listAgents2,
  registerDefaultLLMAgent: () => registerDefaultLLMAgent2,
  registerLLMAgent: () => registerLLMAgent,
  registerOperator: () => registerOperator
});
module.exports = __toCommonJS(src_exports);

// AgentLib.mjs
var import_node_readline = __toESM(require("node:readline"), 1);

// models/providers/modelsConfigLoader.mjs
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_node_url = require("node:url");
var import_meta = {};
var moduleFilename = typeof __filename === "string" ? __filename : (0, import_node_url.fileURLToPath)(import_meta.url);
var moduleDirname = typeof __dirname === "string" ? __dirname : import_node_path.default.dirname(moduleFilename);
var DEFAULT_PROVIDER_ENV_MAP = {
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  huggingface: "HUGGINGFACE_API_KEY"
};
var VALID_MODES = /* @__PURE__ */ new Set(["fast", "deep"]);
function loadRawConfig(configPath = import_node_path.default.join(moduleDirname, "models.json")) {
  if (!import_node_fs.default.existsSync(configPath)) {
    return { raw: { providers: {}, models: {} }, issues: { errors: [`models.json not found at ${configPath}`], warnings: [] } };
  }
  try {
    const rawContent = import_node_fs.default.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(rawContent);
    return { raw: parsed || {}, issues: { errors: [], warnings: [] } };
  } catch (error) {
    return { raw: { providers: {}, models: {} }, issues: { errors: [`Failed to read models.json: ${error.message}`], warnings: [] } };
  }
}
function normalizeConfig(rawConfig, options = {}) {
  const issues = { errors: [], warnings: [] };
  const providers = /* @__PURE__ */ new Map();
  const models = /* @__PURE__ */ new Map();
  const providerModels = /* @__PURE__ */ new Map();
  const orderedModelNames = [];
  const rawProviders = rawConfig?.providers && typeof rawConfig.providers === "object" ? rawConfig.providers : {};
  const rawModels = Array.isArray(rawConfig?.models) ? rawConfig.models : [];
  for (const [providerKey, entry] of Object.entries(rawProviders)) {
    const normalized = normalizeProvider(providerKey, entry, issues, options);
    providers.set(providerKey, normalized);
    providerModels.set(providerKey, []);
  }
  for (const entry of rawModels) {
    const normalized = normalizeModel(entry, providers, issues, options);
    if (!normalized) {
      continue;
    }
    const modelName = normalized.name;
    models.set(modelName, normalized);
    orderedModelNames.push(modelName);
    if (!providerModels.has(normalized.providerKey)) {
      providerModels.set(normalized.providerKey, []);
    }
    providerModels.get(normalized.providerKey).push(normalized);
  }
  validateProviders(providers, models, providerModels, issues);
  return {
    providers,
    models,
    providerModels,
    issues,
    raw: rawConfig,
    orderedModels: orderedModelNames
  };
}
function normalizeProvider(providerKey, entry, issues, options) {
  if (!entry || typeof entry !== "object") {
    issues.warnings.push(`Provider "${providerKey}" configuration must be an object.`);
  }
  const config = entry && typeof entry === "object" ? entry : {};
  const apiKeyEnv = selectString(config.apiKeyEnv, DEFAULT_PROVIDER_ENV_MAP[providerKey]);
  if (!apiKeyEnv) {
    issues.warnings.push(`Provider "${providerKey}" does not declare apiKeyEnv and no fallback is known.`);
  }
  const baseURL = selectString(config.baseURL, null);
  if (!baseURL) {
    issues.warnings.push(`Provider "${providerKey}" is missing baseURL; requests may fail unless overridden per model.`);
  }
  const modulePath = selectString(config.module, null);
  const defaultModel = selectString(config.defaultModel, null);
  return {
    name: providerKey,
    providerKey,
    apiKeyEnv,
    baseURL,
    defaultModel,
    module: modulePath,
    extra: config.extra || {}
  };
}
function normalizeModel(entry, providers, issues, options) {
  const modelName = selectString(entry && typeof entry === "object" ? entry.name : null, null);
  let providerKey = null;
  let mode = "fast";
  let apiKeyEnvOverride = null;
  let baseURLOverride = null;
  if (!modelName) {
    issues.warnings.push('Model entry is missing required "name" property.');
    return null;
  }
  if (entry && typeof entry === "object") {
    providerKey = entry.provider || entry.providerKey || null;
    mode = normalizeMode(entry.mode ?? entry.modes, issues, `model "${modelName}"`);
    apiKeyEnvOverride = selectString(entry.apiKeyEnv, null);
    baseURLOverride = selectString(entry.baseURL, null);
  } else {
    issues.warnings.push(`Model "${modelName}" configuration must be an object.`);
    return null;
  }
  if (!providerKey) {
    issues.errors.push(`Model "${modelName}" is missing provider reference.`);
    return null;
  }
  if (!providers.has(providerKey)) {
    issues.warnings.push(`Model "${modelName}" references unknown provider "${providerKey}".`);
  }
  return {
    name: modelName,
    providerKey,
    mode,
    apiKeyEnv: apiKeyEnvOverride,
    baseURL: baseURLOverride
  };
}
function normalizeMode(rawMode, issues, context) {
  if (rawMode === void 0 || rawMode === null) {
    return "fast";
  }
  if (Array.isArray(rawMode)) {
    const normalized = rawMode.filter((value) => typeof value === "string").map((value) => value.toLowerCase()).filter((value) => VALID_MODES.has(value));
    if (normalized.length > 1) {
      issues.warnings.push(`Model configuration for ${context} lists multiple modes; using "${normalized[0]}".`);
    }
    if (normalized.length) {
      return normalized[0];
    }
    issues.warnings.push(`No valid mode found for ${context}; defaulting to 'fast'.`);
    return "fast";
  }
  if (typeof rawMode === "string") {
    const lower = rawMode.toLowerCase();
    if (VALID_MODES.has(lower)) {
      return lower;
    }
  }
  issues.warnings.push(`Invalid mode value for ${context}; defaulting to 'fast'.`);
  return "fast";
}
function validateProviders(providers, models, providerModels, issues) {
  for (const provider of providers.values()) {
    if (provider.defaultModel) {
      const model = models.get(provider.defaultModel);
      if (!model) {
        issues.warnings.push(`Provider "${provider.name}" defaultModel "${provider.defaultModel}" is not defined.`);
      } else if (model.providerKey !== provider.providerKey) {
        issues.warnings.push(`Provider "${provider.name}" defaultModel "${provider.defaultModel}" belongs to provider "${model.providerKey}".`);
      }
    }
    if (!providerModels.get(provider.providerKey)?.length) {
      issues.warnings.push(`Provider "${provider.name}" has no models defined.`);
    }
  }
}
function selectString(preferred, fallback) {
  if (typeof preferred === "string" && preferred.trim()) {
    return preferred.trim();
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return null;
}
function loadModelsConfiguration(options = {}) {
  const configPath = options.configPath || process.env.LLM_MODELS_CONFIG_PATH || import_node_path.default.join(__dirname, "models.json");
  const { raw, issues: loadIssues } = loadRawConfig(configPath);
  const normalized = normalizeConfig(raw, options);
  normalized.issues.errors.push(...loadIssues.errors);
  normalized.issues.warnings.push(...loadIssues.warnings);
  normalized.path = configPath;
  return normalized;
}

// models/providers/providerRegistry.mjs
var registry = /* @__PURE__ */ new Map();
function normalizeKey(key) {
  return typeof key === "string" ? key.trim().toLowerCase() : "";
}
function registerProvider({ key, handler, metadata = {} }) {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) {
    throw new Error("registerProvider requires a non-empty provider key.");
  }
  if (!handler || typeof handler.callLLM !== "function") {
    throw new Error(`Provider "${key}" must expose a callLLM function.`);
  }
  registry.set(normalizedKey, {
    key: normalizedKey,
    handler,
    metadata
  });
}
function getProviderRecord(key) {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) {
    return null;
  }
  return registry.get(normalizedKey) || null;
}
function ensureProvider(key) {
  const record = getProviderRecord(key);
  if (!record) {
    throw new Error(`Provider "${key}" is not registered. Ensure its module has been loaded.`);
  }
  return record.handler;
}

// models/providers/openai.mjs
var openai_exports = {};
__export(openai_exports, {
  callLLM: () => callLLM
});

// models/providers/messageAdapters/openAIChat.mjs
function toOpenAIChatMessages(chatContext = []) {
  const convertedContext = [];
  for (const reply of chatContext) {
    const normalized = {
      content: reply.message
    };
    switch (reply.role) {
      case "system":
        normalized.role = "system";
        break;
      case "assistant":
      case "ai":
        normalized.role = "assistant";
        break;
      case "user":
      case "human":
        normalized.role = "user";
        break;
      case "tool":
      case "function":
      case "observation":
        normalized.role = "tool";
        break;
      default:
        normalized.role = "user";
        break;
    }
    convertedContext.push(normalized);
  }
  return convertedContext;
}

// models/providers/openai.mjs
async function callLLM(chatContext, options) {
  if (!options || typeof options !== "object") {
    throw new Error("OpenAI provider requires invocation options.");
  }
  const { model, apiKey, baseURL, signal, params, headers } = options;
  if (!model) {
    throw new Error("OpenAI provider requires a model name.");
  }
  if (!apiKey) {
    throw new Error("OpenAI provider requires an API key.");
  }
  if (!baseURL) {
    throw new Error("OpenAI provider requires a baseURL.");
  }
  const convertedContext = toOpenAIChatMessages(chatContext);
  const payload = {
    model,
    messages: convertedContext
  };
  if (params && typeof params === "object") {
    Object.assign(payload, params);
  }
  const response = await fetch(baseURL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...headers || {}
    },
    body: JSON.stringify(payload),
    signal
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI API Error (${response.status}): ${errorBody}`);
  }
  const data = await response.json();
  if (data.error) {
    throw new Error(JSON.stringify(data.error));
  }
  return data.choices?.[0]?.message?.content;
}

// models/providers/google.mjs
var google_exports = {};
__export(google_exports, {
  callLLM: () => callLLM2
});

// models/providers/messageAdapters/googleGemini.mjs
function toGeminiPayload(chatContext = []) {
  const contents = [];
  const systemInstruction = { parts: [] };
  for (const reply of chatContext) {
    if (reply.role === "system") {
      systemInstruction.parts.push({ text: reply.message });
      continue;
    }
    const message = {
      parts: [{ text: reply.message }]
    };
    if (reply.role === "human" || reply.role === "user") {
      message.role = "user";
    } else if (reply.role === "assistant" || reply.role === "ai") {
      message.role = "model";
    } else if (reply.role === "tool" || reply.role === "function" || reply.role === "observation") {
      message.role = "model";
    } else {
      message.role = message.role || "user";
    }
    contents.push(message);
  }
  return { contents, systemInstruction };
}

// models/providers/google.mjs
async function callLLM2(chatContext, options) {
  if (!options || typeof options !== "object") {
    throw new Error("Google provider requires invocation options.");
  }
  const { model, apiKey, baseURL, signal, params, headers } = options;
  if (!model) {
    throw new Error("Google provider requires a model name.");
  }
  if (!apiKey) {
    throw new Error("Google provider requires an API key.");
  }
  if (!baseURL) {
    throw new Error("Google provider requires a baseURL.");
  }
  const convertedContext = toGeminiPayload(chatContext);
  const payload = { ...convertedContext };
  if (params && typeof params === "object") {
    Object.assign(payload, params);
  }
  const normalizedBase = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  const url = `${normalizedBase}${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers || {}
    },
    body: JSON.stringify(payload),
    signal
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google Generative API Error (${response.status}): ${errorBody}`);
  }
  const responseJSON = await response.json();
  if (responseJSON.error) {
    throw new Error(JSON.stringify(responseJSON.error));
  }
  return responseJSON.candidates?.[0]?.content?.parts?.[0]?.text;
}

// models/providers/anthropic.mjs
var anthropic_exports = {};
__export(anthropic_exports, {
  callLLM: () => callLLM3
});

// models/providers/messageAdapters/anthropicMessages.mjs
function toAnthropicMessages(chatContext = []) {
  const messages = [];
  const systemParts = [];
  for (const reply of chatContext) {
    if (reply.role === "system") {
      systemParts.push(reply.message);
      continue;
    }
    const message = {
      role: reply.role === "assistant" || reply.role === "ai" ? "assistant" : "user",
      content: reply.message
    };
    if (reply.role === "tool" || reply.role === "function" || reply.role === "observation") {
      message.role = "assistant";
    }
    messages.push(message);
  }
  return {
    system: systemParts.length ? systemParts.join("\n\n") : void 0,
    messages
  };
}

// models/providers/anthropic.mjs
async function callLLM3(chatContext, options) {
  if (!options || typeof options !== "object") {
    throw new Error("Anthropic provider requires invocation options.");
  }
  const { model, apiKey, baseURL, signal, params, headers } = options;
  if (!model) {
    throw new Error("Anthropic provider requires a model name.");
  }
  if (!apiKey) {
    throw new Error("Anthropic provider requires an API key.");
  }
  if (!baseURL) {
    throw new Error("Anthropic provider requires a baseURL.");
  }
  const { messages, system } = toAnthropicMessages(chatContext);
  const payload = {
    model,
    max_tokens: 1e3,
    messages
  };
  if (system) {
    payload.system = system;
  }
  if (params && typeof params === "object") {
    Object.assign(payload, params);
  }
  const response = await fetch(baseURL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      ...headers || {}
    },
    body: JSON.stringify(payload),
    signal
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API Error (${response.status}): ${errorBody}`);
  }
  const data = await response.json();
  if (data.error) {
    throw new Error(JSON.stringify(data.error));
  }
  return data.content?.[0]?.text;
}

// models/providers/huggingFace.mjs
var huggingFace_exports = {};
__export(huggingFace_exports, {
  callLLM: () => callLLM4
});

// models/providers/messageAdapters/huggingFaceConversational.mjs
function toHuggingFacePrompt(chatContext = []) {
  const lines = chatContext.map((reply) => {
    const role = reply.role === "human" ? "User" : reply.role === "system" ? "System" : "Assistant";
    return `${role}: ${reply.message}`;
  });
  lines.push("Assistant: ");
  return `${lines.join("\n")}
`;
}

// models/providers/huggingFace.mjs
async function callLLM4(chatContext, options) {
  if (!options || typeof options !== "object") {
    throw new Error("Hugging Face provider requires invocation options.");
  }
  const { model, apiKey, baseURL, signal, params, headers } = options;
  if (!model) {
    throw new Error("Hugging Face provider requires a model name.");
  }
  if (!baseURL) {
    throw new Error("Hugging Face provider requires a baseURL.");
  }
  const normalizedBase = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;
  const url = `${normalizedBase}/${model}`;
  const requestHeaders = {
    "Content-Type": "application/json",
    ...headers || {}
  };
  if (apiKey) {
    requestHeaders.Authorization = `Bearer ${apiKey}`;
  }
  const payload = {
    inputs: toHuggingFacePrompt(chatContext),
    parameters: {
      return_full_text: false,
      max_new_tokens: 500
    }
  };
  if (params && typeof params === "object") {
    const { parameters, ...rest } = params;
    if (parameters && typeof parameters === "object") {
      payload.parameters = { ...payload.parameters, ...parameters };
    }
    Object.assign(payload, rest);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(payload),
    signal
  });
  if (!response.ok) {
    const errorBody = await response.text();
    if (response.status === 503) {
      throw new Error("Hugging Face model is currently loading or unavailable (503 Service Unavailable). Please try again later.");
    }
    throw new Error(`Hugging Face API Error (${response.status}): ${errorBody}`);
  }
  const data = await response.json();
  if (Array.isArray(data) && data[0]?.generated_text) {
    return data[0].generated_text.trim();
  }
  if (data.error) {
    throw new Error(`Hugging Face API Error: ${data.error}`);
  }
  return typeof data === "string" ? data : JSON.stringify(data);
}

// models/providers/index.mjs
var registered = false;
function registerBuiltInProviders(options = {}) {
  if (registered) {
    return;
  }
  const skip = options.skip || process.env.PLOINKY_SKIP_BUILTIN_PROVIDERS === "1";
  if (skip) {
    registered = true;
    return;
  }
  registerProvider({ key: "openai", handler: openai_exports, metadata: { module: "./openai.mjs" } });
  registerProvider({ key: "google", handler: google_exports, metadata: { module: "./google.mjs" } });
  registerProvider({ key: "anthropic", handler: anthropic_exports, metadata: { module: "./anthropic.mjs" } });
  registerProvider({ key: "huggingface", handler: huggingFace_exports, metadata: { module: "./huggingFace.mjs" } });
  registerProvider({ key: "openrouter", handler: openai_exports, metadata: { module: "./openai.mjs" } });
  registerProvider({ key: "custom", handler: openai_exports, metadata: { module: "./openai.mjs" } });
  registered = true;
}

// models/providers/providerBootstrap.mjs
var import_node_path2 = __toESM(require("node:path"), 1);
var import_node_url2 = require("node:url");
async function resolveModuleExports(moduleId, baseDir) {
  const isRelativeOrAbsolute = moduleId.startsWith(".") || moduleId.startsWith("/");
  const resolvedId = isRelativeOrAbsolute ? import_node_path2.default.resolve(baseDir, moduleId) : moduleId;
  if (isRelativeOrAbsolute) {
    const moduleUrl = (0, import_node_url2.pathToFileURL)(resolvedId).href;
    const exports3 = await import(moduleUrl);
    return { exports: exports3, resolvedId };
  }
  const exports2 = await import(resolvedId);
  return { exports: exports2, resolvedId };
}
function extractHandler(exports2) {
  if (!exports2) {
    return null;
  }
  if (typeof exports2.callLLM === "function") {
    return exports2;
  }
  if (typeof exports2 === "function") {
    return { callLLM: exports2 };
  }
  if (exports2.default) {
    return extractHandler(exports2.default);
  }
  return null;
}
async function registerProvidersFromConfig(modelsConfiguration3, options = {}) {
  const warnings = [];
  const baseDir = options.baseDir || (modelsConfiguration3.path ? import_node_path2.default.dirname(modelsConfiguration3.path) : __dirname);
  for (const provider of modelsConfiguration3.providers.values()) {
    const moduleId = provider.module;
    if (!moduleId) {
      continue;
    }
    try {
      const { exports: exports2, resolvedId } = await resolveModuleExports(moduleId, baseDir);
      const handler = extractHandler(exports2);
      if (!handler) {
        warnings.push(`Provider "${provider.providerKey}" module "${moduleId}" does not export a callLLM handler.`);
        continue;
      }
      registerProvider({
        key: provider.providerKey,
        handler,
        metadata: {
          module: moduleId,
          resolvedModule: resolvedId,
          source: "config"
        }
      });
    } catch (error) {
      warnings.push(`Failed to register provider "${provider.providerKey}" from module "${moduleId}": ${error.message}`);
    }
  }
  if (warnings.length && modelsConfiguration3?.issues?.warnings) {
    modelsConfiguration3.issues.warnings.push(...warnings);
  }
  return warnings;
}

// LLMClient.mjs
var modelsConfiguration = loadModelsConfiguration();
registerBuiltInProviders();
var providersReady = (async () => {
  await registerProvidersFromConfig(modelsConfiguration);
})();
var llmCalls = [];
function getModelMetadata(modelName) {
  const modelDescriptor = modelsConfiguration.models.get(modelName);
  if (!modelDescriptor) {
    return null;
  }
  const providerConfig = modelsConfiguration.providers.get(modelDescriptor.providerKey) || null;
  return {
    model: modelDescriptor,
    provider: providerConfig
  };
}
function resolveProviderKey(modelName, invocationOptions, metadata) {
  if (invocationOptions.providerKey) {
    return invocationOptions.providerKey;
  }
  if (metadata?.model?.providerKey) {
    return metadata.model.providerKey;
  }
  if (metadata?.provider?.providerKey) {
    return metadata.provider.providerKey;
  }
  throw new Error(`Model "${modelName}" is not configured with a provider.`);
}
async function callLLMWithModelInternal(modelName, historyArray, prompt, invocationOptions = {}) {
  await providersReady;
  const controller = new AbortController();
  llmCalls.push(controller);
  const history = Array.isArray(historyArray) ? historyArray.slice() : [];
  if (prompt) {
    history.push({ role: "human", message: prompt });
  }
  const externalSignal = invocationOptions.signal;
  if (externalSignal && typeof externalSignal.addEventListener === "function") {
    const abortHandler = () => controller.abort();
    externalSignal.addEventListener("abort", abortHandler, { once: true });
  }
  try {
    const metadata = getModelMetadata(modelName);
    const providerKey = resolveProviderKey(modelName, invocationOptions, metadata);
    const provider = ensureProvider(providerKey);
    const baseURL = invocationOptions.baseURL || metadata?.model?.baseURL || metadata?.provider?.baseURL;
    if (!baseURL) {
      throw new Error(`Missing base URL for provider "${providerKey}" and model "${modelName}".`);
    }
    const apiKey = invocationOptions.apiKey || process.env.LLM_API_KEY;
    if (!apiKey && providerKey !== "huggingface") {
      throw new Error(`Missing API key for provider "${providerKey}".`);
    }
    return await provider.callLLM(history, {
      model: modelName,
      providerKey,
      apiKey,
      baseURL,
      signal: controller.signal,
      params: invocationOptions.params || {},
      headers: invocationOptions.headers || {}
    });
  } catch (error) {
    throw error;
  } finally {
    const index = llmCalls.indexOf(controller);
    if (index > -1) {
      llmCalls.splice(index, 1);
    }
  }
}
var callLLMWithModelImpl = callLLMWithModelInternal;
async function callLLMWithModel(modelName, historyArray, prompt, invocationOptions = {}) {
  return callLLMWithModelImpl(modelName, historyArray, prompt, invocationOptions);
}
function cancelRequests() {
  llmCalls.forEach((controller) => controller.abort());
  llmCalls.length = 0;
}

// search/flexsearchAdapter.mjs
var import_flexsearch = __toESM(require("flexsearch"), 1);
var DEFAULT_TYPE = "index";
var STATIC_METHODS = [
  "registerEncoder",
  "registerDecoder",
  "registerLanguage",
  "registerMatcher",
  "registerPipeline",
  "registerStemmer",
  "release"
];
function inferTypeFromInstance(candidate) {
  if (typeof candidate?.get === "function" || typeof candidate?.set === "function") {
    return "document";
  }
  return DEFAULT_TYPE;
}
function isFlexSearchInstance(candidate) {
  return Boolean(candidate && typeof candidate === "object" && typeof candidate.add === "function" && typeof candidate.search === "function");
}
function resolveConstructor(flexsearchLib, type) {
  const lib = flexsearchLib || import_flexsearch.default;
  if (!lib) {
    throw new Error("FlexSearch module is not available.");
  }
  const upperType = (typeof type === "string" ? type : DEFAULT_TYPE).toLowerCase();
  if (upperType === "document") {
    if (!lib.Document) {
      throw new Error("FlexSearch.Document constructor is not available.");
    }
    return lib.Document;
  }
  if (!lib.Index) {
    throw new Error("FlexSearch.Index constructor is not available.");
  }
  return lib.Index;
}
function exposeInstanceMethods(target, source) {
  if (!source) {
    return;
  }
  const seen = /* @__PURE__ */ new Set();
  const bindMethod = (methodName, methodFn) => {
    if (seen.has(methodName)) {
      return;
    }
    if (methodName === "constructor" || methodName in target) {
      return;
    }
    if (typeof methodFn === "function") {
      Object.defineProperty(target, methodName, {
        value: methodFn.bind(source),
        writable: false,
        enumerable: false
      });
      seen.add(methodName);
    }
  };
  let proto = Object.getPrototypeOf(source);
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor && typeof descriptor.value === "function") {
        bindMethod(name, descriptor.value);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  for (const name of Object.keys(source)) {
    const value = source[name];
    if (typeof value === "function") {
      bindMethod(name, value);
    }
  }
}
var FlexSearchAdapter = class _FlexSearchAdapter {
  constructor(configOrInstance = {}, options = {}) {
    const typeProvided = options && Object.prototype.hasOwnProperty.call(options, "type");
    const typeHint = typeProvided ? options.type : void 0;
    const flexsearchLib = options?.flexsearch;
    if (isFlexSearchInstance(configOrInstance)) {
      this.index = configOrInstance;
      this.config = options.config || null;
      this.type = typeof typeHint === "string" ? typeHint : inferTypeFromInstance(this.index);
    } else {
      const ctor = resolveConstructor(flexsearchLib, typeHint);
      this.config = configOrInstance || {};
      this.index = new ctor(this.config);
      this.type = typeof typeHint === "string" ? typeHint : DEFAULT_TYPE;
    }
    exposeInstanceMethods(this, this.index);
  }
  getIndex() {
    return this.index;
  }
  getType() {
    return this.type;
  }
  clone(overrides = {}) {
    const nextConfig = { ...this.config || {}, ...overrides };
    return new _FlexSearchAdapter(nextConfig, { type: this.type });
  }
  hasMethod(name) {
    return typeof this.index?.[name] === "function";
  }
};
for (const methodName of STATIC_METHODS) {
  if (typeof import_flexsearch.default?.[methodName] === "function") {
    Object.defineProperty(FlexSearchAdapter, methodName, {
      value: (...args) => import_flexsearch.default[methodName](...args),
      writable: false,
      enumerable: false
    });
  }
}
function createFlexSearchAdapter(config = {}, options = {}) {
  return new FlexSearchAdapter(config, options);
}

// skills/SkillRegistry.mjs
var DEFAULT_INDEX_OPTIONS = {
  tokenize: "forward"
};
var SEARCHABLE_FIELDS = ["name", "what", "why", "description", "arguments", "requiredArguments", "roles"];
var VALIDATOR_PREFIX = "@";
var ENUMERATOR_PREFIX = "%";
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function normalizeToken(token) {
  if (typeof token !== "string") {
    return "";
  }
  return token.trim();
}
function stripPrefix(value, prefix) {
  if (!value || !prefix) {
    return value;
  }
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
function resolveHandler(skillObj, name, kind) {
  if (!name) {
    return null;
  }
  const direct = skillObj && typeof skillObj[name] === "function" ? skillObj[name] : null;
  if (direct) {
    return direct.bind(skillObj);
  }
  const containerNames = kind === "validator" ? ["argumentValidators", "validators", "validationHandlers"] : ["argumentEnumerators", "enumerators", "optionProviders"];
  for (const containerName of containerNames) {
    const container = skillObj && isPlainObject(skillObj[containerName]) ? skillObj[containerName] : null;
    if (!container) {
      continue;
    }
    const handler = typeof container[name] === "function" ? container[name] : null;
    if (handler) {
      return handler.bind(skillObj);
    }
  }
  return null;
}
function normalizeArgumentDefinition(argumentName, rawDefinition, skillObj) {
  if (!isPlainObject(rawDefinition)) {
    throw new TypeError(`Argument "${argumentName}" must be described with an object definition.`);
  }
  const description = typeof rawDefinition.description === "string" ? rawDefinition.description : "";
  const llmHint = typeof rawDefinition.llmHint === "string" ? rawDefinition.llmHint : "";
  const defaultValue = Object.prototype.hasOwnProperty.call(rawDefinition, "default") ? rawDefinition.default : Object.prototype.hasOwnProperty.call(rawDefinition, "defaultValue") ? rawDefinition.defaultValue : void 0;
  const typeToken = normalizeToken(rawDefinition.type);
  const validatorToken = normalizeToken(rawDefinition.validator || rawDefinition.validation || rawDefinition.validate);
  const enumToken = normalizeToken(rawDefinition.enum || rawDefinition.enumerator || rawDefinition.optionsProvider);
  let baseType = null;
  let validatorName = validatorToken ? stripPrefix(validatorToken, VALIDATOR_PREFIX) : "";
  let enumeratorName = enumToken ? stripPrefix(enumToken, ENUMERATOR_PREFIX) : "";
  if (typeToken) {
    if (typeToken.startsWith(VALIDATOR_PREFIX)) {
      validatorName = stripPrefix(typeToken, VALIDATOR_PREFIX);
    } else if (typeToken.startsWith(ENUMERATOR_PREFIX)) {
      enumeratorName = stripPrefix(typeToken, ENUMERATOR_PREFIX);
    } else if (!baseType) {
      baseType = typeToken.toLowerCase();
    }
  }
  if (!baseType) {
    const fallback = normalizeToken(rawDefinition.valueType || rawDefinition.baseType);
    baseType = fallback ? fallback.toLowerCase() : "string";
  }
  const staticOptions = Array.isArray(rawDefinition.options) ? rawDefinition.options.slice() : null;
  let validator = validatorName ? resolveHandler(skillObj, validatorName, "validator") : null;
  if (validatorName && !validator && typeof rawDefinition.validator === "function") {
    validator = rawDefinition.validator.bind(skillObj);
  }
  if (!validator && typeof rawDefinition.validator === "function") {
    validator = rawDefinition.validator.bind(skillObj);
  }
  let enumerator = enumeratorName ? resolveHandler(skillObj, enumeratorName, "enumerator") : null;
  if (enumeratorName && !enumerator && typeof rawDefinition.enum === "function") {
    enumerator = rawDefinition.enum.bind(skillObj);
  }
  if (!enumerator && typeof rawDefinition.enum === "function") {
    enumerator = rawDefinition.enum.bind(skillObj);
  }
  if (validatorName && !validator) {
    throw new Error(`Validator "${validatorName}" for argument "${argumentName}" was not found on the skill module.`);
  }
  if (enumeratorName && !enumerator) {
    throw new Error(`Enumerator "${enumeratorName}" for argument "${argumentName}" was not found on the skill module.`);
  }
  if (!enumerator && staticOptions) {
    enumerator = async () => staticOptions.slice();
    enumeratorName = "";
  }
  return {
    name: argumentName,
    description,
    llmHint,
    type: baseType,
    defaultValue,
    validatorName: validatorName || "",
    validator,
    enumeratorName: enumeratorName || "",
    enumerator,
    hasStaticOptions: Array.isArray(staticOptions)
  };
}
function toSearchableText(value) {
  if (value === null || value === void 0) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toSearchableText).join(" ");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }
  return String(value);
}
function normalizeSearchResults(result) {
  if (!result) {
    return [];
  }
  if (Array.isArray(result)) {
    return result.map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry && typeof entry === "object") {
        if (typeof entry.id === "string") {
          return entry.id;
        }
        if (typeof entry.doc === "string") {
          return entry.doc;
        }
        if (typeof entry.key === "string") {
          return entry.key;
        }
      }
      return null;
    }).filter(Boolean);
  }
  if (typeof result === "object") {
    if (Array.isArray(result.result)) {
      return normalizeSearchResults(result.result);
    }
    if (Array.isArray(result.ids)) {
      return result.ids.filter((id) => typeof id === "string");
    }
  }
  return [];
}
function buildSearchText(skill) {
  return SEARCHABLE_FIELDS.map((field) => toSearchableText(skill[field])).filter(Boolean).join(" ");
}
function normalizeSkillName(name) {
  if (typeof name !== "string") {
    return "";
  }
  return name.trim().toLowerCase();
}
function sanitizeSpecs(specs) {
  if (!specs || typeof specs !== "object") {
    throw new TypeError("Skill specifications must be provided as an object.");
  }
  const normalized = {};
  const normalizedArguments = {};
  let hasArguments = false;
  let requiredArguments = [];
  for (const key of Object.keys(specs)) {
    const value = specs[key];
    if (value === void 0) {
      continue;
    }
    if (key === "arguments") {
      if (!isPlainObject(value)) {
        throw new TypeError('Skill specification "arguments" must be an object keyed by argument name.');
      }
      for (const [argName, rawDefinition] of Object.entries(value)) {
        if (typeof argName !== "string" || !argName.trim()) {
          throw new Error("Argument names must be non-empty strings.");
        }
        normalizedArguments[argName.trim()] = rawDefinition;
      }
      hasArguments = true;
      continue;
    }
    if (key === "args") {
      throw new Error('Skill specification no longer supports the "args" array. Use the "arguments" object instead.');
    }
    if (key === "requiredArgs") {
      throw new Error('Skill specification no longer supports "requiredArgs". Use "requiredArguments" instead.');
    }
    if (key === "requiredArguments") {
      if (!Array.isArray(value)) {
        throw new TypeError('Skill specification "requiredArguments" must be an array of strings.');
      }
      requiredArguments = value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
      continue;
    }
    normalized[key] = value;
  }
  if (!hasArguments) {
    throw new Error('Skill specification requires an "arguments" object describing inputs.');
  }
  normalized.arguments = normalizedArguments;
  normalized.requiredArguments = requiredArguments;
  if (!normalized.name || typeof normalized.name !== "string") {
    throw new Error('Skill specification requires a "name" string.');
  }
  if (!normalized.description || typeof normalized.description !== "string") {
    throw new Error('Skill specification requires a "description" string.');
  }
  return normalized;
}
var SkillRegistry = class {
  constructor(options = {}) {
    const { flexSearchAdapter, indexOptions } = options;
    this.index = flexSearchAdapter || createFlexSearchAdapter(indexOptions || DEFAULT_INDEX_OPTIONS);
    this.skills = /* @__PURE__ */ new Map();
    this.actions = /* @__PURE__ */ new Map();
  }
  registerSkill(skillObj) {
    if (!skillObj || typeof skillObj !== "object") {
      throw new TypeError("registerSkill requires a skill configuration object.");
    }
    const { specs, action, roles } = skillObj;
    if (!specs || typeof specs !== "object") {
      throw new TypeError('registerSkill requires a "specs" object.');
    }
    if (typeof action !== "function") {
      throw new TypeError("registerSkill requires a function action handler.");
    }
    const normalizedSpecs = sanitizeSpecs(specs);
    const canonicalName = normalizeSkillName(normalizedSpecs.name);
    if (!canonicalName) {
      throw new Error("Skill specification requires a non-empty name.");
    }
    if (!Array.isArray(roles)) {
      throw new TypeError('registerSkill requires a "roles" array.');
    }
    const normalizedRoles = Array.from(new Set(roles.map((role) => typeof role === "string" ? role.trim() : "").filter(Boolean).map((role) => role.toLowerCase())));
    if (!normalizedRoles.length) {
      throw new Error("registerSkill requires at least one role.");
    }
    const argumentOrder = Object.keys(normalizedSpecs.arguments);
    const argumentMetadata = {};
    const publicArguments = {};
    for (const argumentName of argumentOrder) {
      const rawDefinition = normalizedSpecs.arguments[argumentName];
      const meta = normalizeArgumentDefinition(argumentName, rawDefinition, skillObj);
      argumentMetadata[argumentName] = meta;
      const publicEntry = {};
      if (meta.type) {
        publicEntry.type = meta.type;
      }
      if (meta.description) {
        publicEntry.description = meta.description;
      }
      if (meta.llmHint) {
        publicEntry.llmHint = meta.llmHint;
      }
      if (meta.defaultValue !== void 0) {
        publicEntry.default = meta.defaultValue;
      }
      if (meta.validatorName) {
        publicEntry.validator = `${VALIDATOR_PREFIX}${meta.validatorName}`;
      }
      if (meta.enumeratorName) {
        publicEntry.enumerator = `${ENUMERATOR_PREFIX}${meta.enumeratorName}`;
      } else if (meta.enumerator) {
        publicEntry.enumerator = "inline";
      }
      publicArguments[argumentName] = publicEntry;
    }
    const requiredArguments = Array.isArray(normalizedSpecs.requiredArguments) ? normalizedSpecs.requiredArguments.slice() : [];
    const record = {
      canonicalName,
      ...normalizedSpecs,
      arguments: publicArguments,
      requiredArguments,
      roles: normalizedRoles,
      registeredAt: (/* @__PURE__ */ new Date()).toISOString(),
      argumentMetadata,
      argumentOrder
    };
    if (this.skills.has(canonicalName)) {
      this.skills.delete(canonicalName);
      this.actions.delete(canonicalName);
      if (typeof this.index.remove === "function") {
        try {
          this.index.remove(canonicalName);
        } catch (error) {
        }
      }
    }
    this.skills.set(canonicalName, record);
    this.actions.set(canonicalName, action);
    const searchText = buildSearchText(record);
    if (searchText) {
      this.index.add(canonicalName, searchText);
    }
    return record.name;
  }
  rankSkill(taskDescription, options = {}) {
    if (!this.skills.size) {
      return [];
    }
    const query = typeof taskDescription === "string" ? taskDescription.trim() : "";
    if (!query) {
      return [];
    }
    const normalizedRole = typeof options.role === "string" && options.role.trim() ? options.role.trim().toLowerCase() : typeof options.callerRole === "string" && options.callerRole.trim() ? options.callerRole.trim().toLowerCase() : "";
    if (!normalizedRole) {
      throw new Error("rankSkill requires a caller role for access filtering.");
    }
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : options.limit === 0 ? 0 : 5;
    const searchOptions = {
      bool: options?.bool === "and" ? "and" : "or",
      suggest: true,
      ...limit ? { limit } : {}
    };
    let rawResults;
    try {
      rawResults = this.index.search(query, searchOptions);
    } catch (error) {
      return [];
    }
    const matches = normalizeSearchResults(rawResults);
    if (!matches.length) {
      return [];
    }
    const seen = /* @__PURE__ */ new Set();
    const filtered = [];
    for (const key of matches) {
      const canonical = normalizeSkillName(key);
      if (!canonical || seen.has(canonical)) {
        continue;
      }
      if (this.skills.has(canonical)) {
        const record = this.skills.get(canonical);
        if (Array.isArray(record.roles) && record.roles.includes(normalizedRole)) {
          seen.add(canonical);
          filtered.push(record.name);
        }
      }
      if (limit && filtered.length >= limit) {
        break;
      }
    }
    return filtered;
  }
  getSkill(skillName) {
    const canonical = normalizeSkillName(skillName);
    if (!canonical) {
      return null;
    }
    return this.skills.get(canonical) || null;
  }
  getSkillAction(skillName) {
    const canonical = normalizeSkillName(skillName);
    if (!canonical) {
      return null;
    }
    return this.actions.get(canonical) || null;
  }
  listSkillsForRole(role) {
    const normalizedRole = typeof role === "string" ? role.trim().toLowerCase() : "";
    if (!normalizedRole) {
      return [];
    }
    const toSummary = (record) => ({
      name: record.name,
      description: record.humanDescription || record.description || record.what || record.name,
      needConfirmation: record.needConfirmation === true
    });
    return Array.from(this.skills.values()).filter((record) => Array.isArray(record.roles) && record.roles.includes(normalizedRole)).sort((a, b) => a.name.localeCompare(b.name)).map(toSummary);
  }
  clear() {
    this.skills.clear();
    this.actions.clear();
    if (typeof this.index.clear === "function") {
      this.index.clear();
    }
  }
};

// models/modelCatalog.mjs
var modelsConfiguration2 = loadModelsConfiguration();
var configurationDiagnosticsEmitted = false;
function emitConfigurationDiagnostics() {
  if (configurationDiagnosticsEmitted) {
    return;
  }
  configurationDiagnosticsEmitted = true;
  for (const error of modelsConfiguration2.issues.errors) {
    if (process.env.LLMAgentClient_DEBUG === "true") {
      console.error(`LLMAgentClient: ${error}`);
    }
  }
  for (const warning of modelsConfiguration2.issues.warnings) {
    if (process.env.LLMAgentClient_DEBUG === "true") {
      console.warn(`LLMAgentClient: ${warning}`);
    }
  }
}
function getModelsConfiguration() {
  return modelsConfiguration2;
}
function getProviderConfig(providerKey) {
  return modelsConfiguration2.providers.get(providerKey) || null;
}
function getModelDescriptor(modelName) {
  return modelsConfiguration2.models.get(modelName) || null;
}
function createAgentModelRecord(providerConfig, modelDescriptor) {
  if (!providerConfig || !modelDescriptor) {
    return null;
  }
  const apiKeyEnv = modelDescriptor.apiKeyEnv || providerConfig.apiKeyEnv || null;
  const baseURL = modelDescriptor.baseURL || providerConfig.baseURL || null;
  const mode = modelDescriptor.mode || "fast";
  return {
    name: modelDescriptor.name,
    providerKey: modelDescriptor.providerKey,
    apiKeyEnv,
    baseURL,
    mode
  };
}
function cloneAgentModelRecord(record) {
  return {
    name: record.name,
    providerKey: record.providerKey,
    apiKeyEnv: record.apiKeyEnv,
    baseURL: record.baseURL,
    mode: record.mode || "fast"
  };
}
function normalizeModePreference(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "deep" || normalized === "fast" ? normalized : null;
}
function normalizeInvocationRequest(input) {
  if (typeof input === "string") {
    return { mode: normalizeModePreference(input), modelName: null };
  }
  if (!input || typeof input !== "object") {
    return { mode: null, modelName: null };
  }
  const mode = normalizeModePreference(input.mode || input.preferredMode || input.modePreference);
  const modelRaw = input.modelName || input.model || input.preferredModel;
  const modelName = typeof modelRaw === "string" && modelRaw.trim() ? modelRaw.trim() : null;
  return { mode, modelName };
}
function getOrderedModelNames() {
  if (Array.isArray(modelsConfiguration2.orderedModels) && modelsConfiguration2.orderedModels.length) {
    return modelsConfiguration2.orderedModels.slice();
  }
  return Array.from(modelsConfiguration2.models.keys());
}
function categorizeModelsByMode(modelNames) {
  const fast = [];
  const deep = [];
  for (const name of modelNames) {
    const descriptor = getModelDescriptor(name);
    if (!descriptor) {
      continue;
    }
    if (descriptor.mode === "deep") {
      deep.push(name);
    } else {
      fast.push(name);
    }
  }
  return { fast, deep };
}
function buildModelRecordByName(modelName) {
  const descriptor = getModelDescriptor(modelName);
  if (!descriptor) {
    if (process.env.LLMAgentClient_DEBUG === "true") {
      console.warn(`LLMAgentClient: models.json does not define model "${modelName}".`);
    }
    return null;
  }
  const providerConfig = getProviderConfig(descriptor.providerKey);
  if (!providerConfig) {
    if (process.env.LLMAgentClient_DEBUG === "true") {
      console.warn(`LLMAgentClient: Model "${modelName}" references unknown provider "${descriptor.providerKey}".`);
    }
    return null;
  }
  return createAgentModelRecord(providerConfig, descriptor);
}
function dedupeRecordsByName(records) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const record of records) {
    if (!record || !record.name) {
      continue;
    }
    if (seen.has(record.name)) {
      continue;
    }
    seen.add(record.name);
    result.push(record);
  }
  return result;
}
function normalizeModelNameList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean);
}
function resetModelCatalogForTests() {
  configurationDiagnosticsEmitted = false;
}

// invocation/modelInvoker.mjs
function buildLegacyInvocationConfig(agent) {
  const providerKey = agent.providerKey || null;
  const apiKeyEnv = agent.apiKeyEnv || null;
  const baseURL = agent.baseURL || (providerKey ? getProviderConfig(providerKey)?.baseURL : null);
  return {
    record: {
      name: agent.model,
      providerKey,
      apiKeyEnv,
      baseURL,
      mode: agent.modelMode || "fast"
    },
    providerKey,
    apiKeyEnv,
    baseURL
  };
}
async function invokeAgent(agent, history, options = {}) {
  const request = normalizeInvocationRequest(options);
  const {
    record,
    providerKey,
    apiKeyEnv,
    baseURL
  } = typeof agent.getInvocationConfig === "function" ? agent.getInvocationConfig(request) : buildLegacyInvocationConfig(agent);
  if (!record?.name) {
    throw new Error(`Agent "${agent.name}" does not have a usable model.`);
  }
  const effectiveProviderKey = providerKey || record.providerKey;
  const effectiveBaseURL = baseURL || getProviderConfig(effectiveProviderKey)?.baseURL;
  if (!effectiveBaseURL) {
    throw new Error(`Missing base URL for agent "${agent.name}" (${effectiveProviderKey || "unknown provider"}).`);
  }
  const apiKeyName = apiKeyEnv || record.apiKeyEnv || agent.apiKeyEnv || null;
  const apiKey = apiKeyName ? process.env[apiKeyName] : null;
  if (!apiKey && effectiveProviderKey !== "huggingface") {
    throw new Error(`Missing API key for agent "${agent.name}" (${apiKeyName || "unspecified env var"}).`);
  }
  return callLLMWithModel(record.name, [...history], null, {
    apiKey,
    baseURL: effectiveBaseURL,
    providerKey: effectiveProviderKey
  });
}

// agents/agentRegistry.mjs
var PROVIDER_PRIORITY = ["openai", "google", "anthropic", "openrouter", "mistral", "deepseek", "huggingface"];
var agentRegistry = null;
var agentRegistrySummary = null;
var defaultAgentName = null;
function ensureAgentSummary() {
  if (!agentRegistrySummary) {
    agentRegistrySummary = { active: [], inactive: [] };
  }
  return agentRegistrySummary;
}
function removeAgentFromSummary(name) {
  if (!agentRegistrySummary) {
    return;
  }
  const filter = (entries) => entries.filter((entry) => entry.name !== name);
  agentRegistrySummary.active = filter(agentRegistrySummary.active);
  agentRegistrySummary.inactive = filter(agentRegistrySummary.inactive);
}
function createAgentRuntime(record) {
  const runtime = { ...record };
  const recordsByMode = /* @__PURE__ */ new Map();
  for (const modelRecord of runtime.availableModelRecords) {
    const mode = normalizeModePreference(modelRecord.mode) || "fast";
    if (!recordsByMode.has(mode)) {
      recordsByMode.set(mode, []);
    }
    recordsByMode.get(mode).push(modelRecord);
  }
  const getRecordForMode = (mode) => {
    const normalized = normalizeModePreference(mode);
    if (normalized && recordsByMode.has(normalized)) {
      return recordsByMode.get(normalized)[0];
    }
    if (normalized === "deep" && recordsByMode.has("fast")) {
      return recordsByMode.get("fast")[0];
    }
    if (normalized === "fast" && recordsByMode.has("deep")) {
      return recordsByMode.get("deep")[0];
    }
    if (runtime.model) {
      const configured = runtime.availableModelRecords.find((modelRecord) => modelRecord.name === runtime.model);
      if (configured) {
        return configured;
      }
    }
    return runtime.availableModelRecords[0] || null;
  };
  runtime.supportedModes = Array.from(recordsByMode.keys());
  runtime.supportsMode = function supportsMode(mode) {
    const normalized = normalizeModePreference(mode);
    return normalized ? recordsByMode.has(normalized) : false;
  };
  const findRecordByName = (modelName) => {
    if (!modelName) {
      return null;
    }
    return runtime.availableModelRecords.find((modelRecord) => modelRecord.name === modelName) || null;
  };
  const resolveRecord = (request) => {
    const recordByName = findRecordByName(request.modelName);
    if (recordByName) {
      return recordByName;
    }
    return getRecordForMode(request.mode);
  };
  runtime.selectModelRecord = function selectModelRecord(request) {
    const normalizedRequest = normalizeInvocationRequest(request);
    return resolveRecord(normalizedRequest);
  };
  runtime.getInvocationConfig = function getInvocationConfig(request) {
    const normalizedRequest = normalizeInvocationRequest(request);
    const record2 = resolveRecord(normalizedRequest);
    if (!record2) {
      throw new Error(`Agent "${runtime.name}" has no available models.`);
    }
    const providerKey = record2.providerKey || runtime.providerKey || null;
    const apiKeyEnv = record2.apiKeyEnv || runtime.apiKeyEnv || null;
    const baseURL = record2.baseURL || runtime.baseURL || (providerKey ? getProviderConfig(providerKey)?.baseURL : null);
    return {
      record: record2,
      providerKey,
      apiKeyEnv,
      baseURL
    };
  };
  return runtime;
}
function hasAvailableKey(record) {
  if (!record) {
    return false;
  }
  if (!record.apiKeyEnv) {
    return true;
  }
  if ((record.providerKey || "").toLowerCase() === "huggingface") {
    return true;
  }
  return Boolean(process.env[record.apiKeyEnv]);
}
function commitAgentRecord({
  name,
  role = "",
  job = "",
  expertise = "",
  instructions = "",
  kind = "task",
  configuredRecords = [],
  fastModelNames = [],
  deepModelNames = [],
  origin = "config"
}) {
  if (!name || typeof name !== "string") {
    throw new Error("commitAgentRecord requires a non-empty name.");
  }
  if (!agentRegistry) {
    agentRegistry = /* @__PURE__ */ new Map();
  }
  const normalizedKind = kind === "task" ? "task" : "chat";
  const summaryState = ensureAgentSummary();
  removeAgentFromSummary(name);
  const orderedRecords = dedupeRecordsByName(configuredRecords || []);
  const primaryProviderKey = orderedRecords[0]?.providerKey || null;
  if (!orderedRecords.length) {
    summaryState.inactive.push({
      name,
      kind: normalizedKind,
      role,
      job,
      expertise,
      instructions,
      providerKey: primaryProviderKey,
      reason: "no models configured",
      origin
    });
    agentRegistry.delete(name.toLowerCase());
    if (process.env.LLMAgentClient_DEBUG === "true") {
      console.warn(`LLMAgentClient: Agent "${name}" could not be registered because no models were supplied.`);
    }
    return { status: "inactive", reason: "no models configured" };
  }
  const availableRecords = orderedRecords.filter(hasAvailableKey);
  if (!availableRecords.length) {
    summaryState.inactive.push({
      name,
      kind: normalizedKind,
      role,
      job,
      expertise,
      instructions,
      providerKey: primaryProviderKey,
      reason: "missing API keys",
      origin
    });
    agentRegistry.delete(name.toLowerCase());
    if (process.env.LLMAgentClient_DEBUG === "true") {
      console.warn(`LLMAgentClient: Agent "${name}" has no models with available API keys.`);
    }
    return { status: "inactive", reason: "missing API keys" };
  }
  const defaultRecord = availableRecords[0];
  const fastSet = new Set((fastModelNames || []).map((value) => value?.toString().trim()).filter(Boolean));
  const deepSet = new Set((deepModelNames || []).map((value) => value?.toString().trim()).filter(Boolean));
  const fastRecords = availableRecords.filter((record) => fastSet.has(record.name) || fastSet.size === 0 && record.mode === "fast");
  const deepRecords = availableRecords.filter((record) => deepSet.has(record.name) || deepSet.size === 0 && record.mode === "deep");
  const agentRecord = {
    name,
    canonicalName: name,
    role,
    job,
    expertise,
    instructions,
    kind: normalizedKind,
    origin,
    model: defaultRecord.name,
    modelMode: defaultRecord.mode,
    apiKeyEnv: defaultRecord.apiKeyEnv || null,
    providerKey: defaultRecord.providerKey || null,
    baseURL: defaultRecord.baseURL || null,
    availableModels: availableRecords.map((record) => record.name),
    availableModelRecords: availableRecords.map(cloneAgentModelRecord),
    configuredModels: orderedRecords.map((record) => record.name),
    fastModels: fastRecords.map((record) => record.name),
    deepModels: deepRecords.map((record) => record.name),
    supportedModes: Array.from(new Set(availableRecords.map((record) => record.mode).filter(Boolean)))
  };
  const runtimeAgent = createAgentRuntime(agentRecord);
  agentRegistry.set(name.toLowerCase(), runtimeAgent);
  summaryState.active.push({
    name,
    kind: normalizedKind,
    role,
    job,
    expertise,
    instructions,
    origin,
    providerKey: runtimeAgent.providerKey,
    defaultModel: runtimeAgent.model,
    availableModels: runtimeAgent.availableModels.slice(),
    fastModels: runtimeAgent.fastModels.slice(),
    deepModels: runtimeAgent.deepModels.slice()
  });
  return { status: "active", agent: runtimeAgent };
}
function autoRegisterProviders() {
  const modelsConfiguration3 = getModelsConfiguration();
  for (const providerConfig of modelsConfiguration3.providers.values()) {
    const providerKey = providerConfig.providerKey;
    const descriptors = modelsConfiguration3.providerModels.get(providerKey) || [];
    if (!descriptors.length) {
      if (process.env.LLMAgentClient_DEBUG === "true") {
        console.warn(`LLMAgentClient: No models configured in models.json for provider "${providerKey}".`);
      }
      commitAgentRecord({
        name: providerKey,
        role: `${providerKey} agent`,
        job: `Handle requests using ${providerKey} models.`,
        expertise: "General",
        instructions: "",
        kind: "task",
        configuredRecords: [],
        origin: "provider"
      });
      continue;
    }
    const orderedNames = Array.isArray(modelsConfiguration3.orderedModels) ? modelsConfiguration3.orderedModels.filter((name) => descriptors.some((descriptor) => descriptor.name === name)) : descriptors.map((descriptor) => descriptor.name);
    const configuredRecords = [];
    for (const modelName of orderedNames) {
      const record = buildModelRecordByName(modelName);
      if (record && record.providerKey === providerKey) {
        configuredRecords.push(record);
      }
    }
    const fastNames = descriptors.filter((descriptor) => descriptor.mode === "fast").map((descriptor) => descriptor.name);
    const deepNames = descriptors.filter((descriptor) => descriptor.mode === "deep").map((descriptor) => descriptor.name);
    commitAgentRecord({
      name: providerKey,
      role: providerConfig.extra?.role || `${providerKey} agent`,
      job: providerConfig.extra?.job || `Handle requests routed to ${providerKey}.`,
      expertise: providerConfig.extra?.expertise || "Provider specialist",
      instructions: providerConfig.extra?.instructions || "",
      kind: providerConfig.extra?.kind || providerConfig.extra?.type || "task",
      configuredRecords,
      fastModelNames: fastNames,
      deepModelNames: deepNames,
      origin: "provider"
    });
  }
}
function determineDefaultAgent() {
  defaultAgentName = null;
  if (!agentRegistry || agentRegistry.size === 0) {
    return;
  }
  if (agentRegistry.has("default")) {
    defaultAgentName = "default";
    return;
  }
  for (const name of PROVIDER_PRIORITY) {
    if (agentRegistry.has(name)) {
      defaultAgentName = name;
      return;
    }
  }
  const firstAgent = agentRegistry.keys().next();
  if (!firstAgent.done) {
    defaultAgentName = firstAgent.value;
  }
}
function ensureAgentRegistry() {
  if (agentRegistry) {
    return agentRegistry;
  }
  emitConfigurationDiagnostics();
  agentRegistry = /* @__PURE__ */ new Map();
  agentRegistrySummary = { active: [], inactive: [] };
  autoRegisterProviders();
  registerDefaultLLMAgent({});
  determineDefaultAgent();
  return agentRegistry;
}
function getAgent(agentName) {
  const registry2 = ensureAgentRegistry();
  if (!registry2 || registry2.size === 0) {
    throw new Error("No agents are configured. Set provider API keys in the environment.");
  }
  if (agentName) {
    const normalized = agentName.toLowerCase();
    if (registry2.has(normalized)) {
      return registry2.get(normalized);
    }
  }
  if (defaultAgentName && registry2.has(defaultAgentName)) {
    return registry2.get(defaultAgentName);
  }
  throw new Error("Default agent is not configured.");
}
function cloneAgentSummary(summary) {
  return {
    name: summary.name,
    kind: summary.kind,
    role: summary.role,
    job: summary.job,
    expertise: summary.expertise,
    instructions: summary.instructions,
    origin: summary.origin,
    providerKey: summary.providerKey || null,
    defaultModel: summary.defaultModel,
    availableModels: Array.isArray(summary.availableModels) ? summary.availableModels.slice() : [],
    fastModels: Array.isArray(summary.fastModels) ? summary.fastModels.slice() : [],
    deepModels: Array.isArray(summary.deepModels) ? summary.deepModels.slice() : [],
    reason: summary.reason
  };
}
function listAgents() {
  ensureAgentRegistry();
  const summaries = agentRegistrySummary || { active: [], inactive: [] };
  return {
    defaultAgent: defaultAgentName,
    agents: {
      active: summaries.active.map(cloneAgentSummary),
      inactive: summaries.inactive.map(cloneAgentSummary)
    }
  };
}
function registerDefaultLLMAgent(options = {}) {
  const {
    role = "General-purpose assistant",
    job = "Plan and execute tasks accurately and reliably.",
    expertise = "Generalist",
    instructions = "Select the most capable model for each request.",
    kind = "task"
  } = options;
  const modelsConfiguration3 = getModelsConfiguration();
  const orderedNames = Array.isArray(modelsConfiguration3.orderedModels) ? modelsConfiguration3.orderedModels.slice() : Array.from(modelsConfiguration3.models.keys());
  const configuredRecords = [];
  const fastNames = [];
  const deepNames = [];
  for (const modelName of orderedNames) {
    const record = buildModelRecordByName(modelName);
    if (!record) {
      continue;
    }
    configuredRecords.push(record);
    if (record.mode === "fast") {
      fastNames.push(record.name);
    }
    if (record.mode === "deep") {
      deepNames.push(record.name);
    }
  }
  commitAgentRecord({
    name: "default",
    role,
    job,
    expertise,
    instructions,
    kind,
    configuredRecords,
    fastModelNames: fastNames,
    deepModelNames: deepNames,
    origin: "default"
  });
}
function resetAgentRegistryForTests() {
  agentRegistry = null;
  agentRegistrySummary = null;
  defaultAgentName = null;
}

// utils/json.mjs
function safeJsonParse(value) {
  if (typeof value !== "string") {
    return value;
  }
  let text = value.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  if (!text.startsWith("{") && !text.startsWith("[")) {
    const startBrace = text.indexOf("{");
    const startBracket = text.indexOf("[");
    const startCandidates = [startBrace, startBracket].filter((index) => index !== -1);
    if (startCandidates.length) {
      const start = Math.min(...startCandidates);
      const endBrace = text.lastIndexOf("}");
      const endBracket = text.lastIndexOf("]");
      const endCandidates = [endBrace, endBracket].filter((index) => index !== -1);
      if (endCandidates.length) {
        const end = Math.max(...endCandidates);
        if (end >= start) {
          text = text.slice(start, end + 1).trim();
        }
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

// skills/SkillExecutor.mjs
async function executeSkill({
  skillName,
  providedArgs = {},
  getSkill,
  getSkillAction,
  readUserPrompt,
  taskDescription = "",
  skipConfirmation = false
}) {
  if (typeof getSkill !== "function") {
    throw new Error("executeSkill requires a getSkill function.");
  }
  if (typeof getSkillAction !== "function") {
    throw new Error("executeSkill requires a getSkillAction function.");
  }
  if (typeof readUserPrompt !== "function") {
    throw new Error("executeSkill requires a readUserPrompt function.");
  }
  const skill = getSkill(skillName);
  if (!skill) {
    throw new Error(`Skill "${skillName}" is not registered.`);
  }
  const action = getSkillAction(skillName);
  if (typeof action !== "function") {
    throw new Error(`No executable action found for skill "${skillName}".`);
  }
  const normalizedArgs = providedArgs && typeof providedArgs === "object" ? { ...providedArgs } : {};
  const requiredArguments = Array.isArray(skill.requiredArguments) ? skill.requiredArguments.filter((name) => typeof name === "string" && name) : [];
  const argumentMetadata = skill.argumentMetadata && typeof skill.argumentMetadata === "object" ? skill.argumentMetadata : {};
  const argumentOrder = Array.isArray(skill.argumentOrder) && skill.argumentOrder.length ? skill.argumentOrder.filter((name) => typeof name === "string" && name) : Object.keys(argumentMetadata);
  const argumentDefinitions = argumentOrder.map((name) => argumentMetadata[name]).filter((entry) => entry && typeof entry.name === "string" && entry.name);
  const definitionNames = argumentDefinitions.map((def) => def.name);
  const allArgumentNames = definitionNames.length ? definitionNames : Array.from(new Set(requiredArguments));
  const requiredArgSet = new Set(requiredArguments);
  const optionalArgumentNames = allArgumentNames.filter((name) => !requiredArgSet.has(name));
  const validatorMap = new Map(argumentDefinitions.filter((def) => typeof def.validator === "function").map((def) => [def.name, def.validator]));
  const enumeratorMap = new Map(argumentDefinitions.filter((def) => typeof def.enumerator === "function").map((def) => [def.name, def.enumerator]));
  const definitionMap = new Map(argumentDefinitions.map((def) => [def.name, def]));
  const hasArgumentValue = (name) => Object.prototype.hasOwnProperty.call(normalizedArgs, name) && normalizedArgs[name] !== void 0 && normalizedArgs[name] !== null;
  const missingArgsFromList = (names) => names.filter((name) => !hasArgumentValue(name));
  const optionMap = /* @__PURE__ */ new Map();
  const optionIndexMap = /* @__PURE__ */ new Map();
  const debugMode = process.env.LLMAgentClient_DEBUG === "true";
  const toComparableToken = (input) => {
    if (input === void 0) {
      return "";
    }
    if (input === null) {
      return "null";
    }
    if (typeof input === "string") {
      return input.trim().toLowerCase().replace(/\s+/g, "");
    }
    if (typeof input === "number" || typeof input === "boolean") {
      return String(input).toLowerCase();
    }
    try {
      return JSON.stringify(input).toLowerCase();
    } catch (error) {
      return String(input).toLowerCase();
    }
  };
  const stringifyOptionValue = (value) => {
    if (value === null) {
      return "null";
    }
    if (value === void 0) {
      return "undefined";
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  };
  const createOptionEntries = (values) => {
    const entries = [];
    for (const entry of values) {
      if (entry === null || entry === void 0) {
        continue;
      }
      if (typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "label") && Object.prototype.hasOwnProperty.call(entry, "value")) {
        const rawLabel = entry.label === null || entry.label === void 0 ? "" : String(entry.label).trim();
        if (!rawLabel) {
          continue;
        }
        const option = {
          label: rawLabel,
          value: entry.value
        };
        option.labelToken = toComparableToken(option.label);
        option.valueToken = toComparableToken(option.value);
        const valueForDisplay = stringifyOptionValue(option.value);
        option.display = option.label === valueForDisplay ? option.label : `${option.label} (${valueForDisplay})`;
        entries.push(option);
        continue;
      }
      if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
        const label = String(entry);
        const option = {
          label,
          value: entry
        };
        option.labelToken = toComparableToken(option.label);
        option.valueToken = toComparableToken(option.value);
        option.display = option.label;
        entries.push(option);
      }
    }
    return entries;
  };
  for (const [name, enumerator] of enumeratorMap.entries()) {
    try {
      const values = await Promise.resolve(enumerator());
      if (Array.isArray(values)) {
        const entries = createOptionEntries(values);
        if (entries.length) {
          optionMap.set(name, entries);
          const searchIndex = createFlexSearchAdapter({ tokenize: "forward" });
          for (const option of entries) {
            const searchText = `${option.label} ${option.display}`;
            searchIndex.add(option.labelToken, searchText);
          }
          optionIndexMap.set(name, searchIndex);
        }
      }
    } catch (error) {
      console.warn(`Failed to load options for argument "${name}" on skill "${skill.name}": ${error.message}`);
    }
  }
  const matchOptionWithFlexSearch = (name, value) => {
    const searchIndex = optionIndexMap.get(name);
    const options = optionMap.get(name);
    if (!searchIndex || !options || !options.length) {
      return { matched: false, confidence: 0, value: null, matches: [] };
    }
    const candidateToken = toComparableToken(value);
    if (!candidateToken) {
      return { matched: false, confidence: 0, value: null, matches: [] };
    }
    for (const option of options) {
      if (candidateToken === option.labelToken || candidateToken === option.valueToken) {
        if (debugMode) {
          console.log(`[FlexSearch] Exact match for "${name}": "${value}" \u2192 "${option.label}"`);
        }
        return { matched: true, confidence: 1, value: option.value, matches: [option] };
      }
    }
    let searchResults;
    try {
      searchResults = searchIndex.search(candidateToken, { limit: 5 });
    } catch (error) {
      return { matched: false, confidence: 0, value: null, matches: [] };
    }
    if (!Array.isArray(searchResults) || searchResults.length === 0) {
      if (debugMode) {
        console.log(`[FlexSearch] No matches for "${name}": "${value}"`);
      }
      return { matched: false, confidence: 0, value: null, matches: [] };
    }
    const matchedOptions = searchResults.map((resultToken) => options.find((opt) => opt.labelToken === resultToken)).filter(Boolean);
    if (matchedOptions.length === 0) {
      return { matched: false, confidence: 0, value: null, matches: [] };
    }
    let confidence = 0;
    if (matchedOptions.length === 1) {
      confidence = 0.9;
    } else if (matchedOptions.length >= 2) {
      confidence = 0.3;
    }
    if (debugMode) {
      if (confidence >= 0.8) {
        console.log(`[FlexSearch] High-confidence match for "${name}": "${value}" \u2192 "${matchedOptions[0].label}"`);
      } else {
        console.log(`[FlexSearch] Low-confidence match for "${name}": "${value}" \u2192 [${matchedOptions.map((o) => o.label).join(", ")}]`);
      }
    }
    return {
      matched: confidence >= 0.8,
      confidence,
      value: matchedOptions[0].value,
      matches: matchedOptions.slice(0, 3)
    };
  };
  const normalizeOptionValue = (name, value) => {
    const options = optionMap.get(name);
    if (!options || !options.length) {
      return { valid: true, value };
    }
    const flexResult = matchOptionWithFlexSearch(name, value);
    if (flexResult.matched) {
      return { valid: true, value: flexResult.value };
    }
    return { valid: false, value: null };
  };
  const validateArgumentValue = (name, value) => {
    const validator = validatorMap.get(name);
    if (typeof validator !== "function") {
      return { valid: true, value };
    }
    try {
      const result = validator(value);
      if (result === false) {
        console.warn(`Validation for argument "${name}" rejected the provided value.`);
        return { valid: false, value: null };
      }
      if (result === true || result === void 0) {
        return { valid: true, value };
      }
      if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "valid")) {
        const normalizedValue = Object.prototype.hasOwnProperty.call(result, "value") ? result.value : value;
        if (!result.valid) {
          const message = typeof result.message === "string" ? result.message : "validator returned false";
          console.warn(`Validation for argument "${name}" failed: ${message}`);
        }
        return { valid: Boolean(result.valid), value: normalizedValue };
      }
      return { valid: true, value: result };
    } catch (error) {
      const message = error?.message || "validator threw an error";
      console.warn(`Validation for argument "${name}" failed: ${message}`);
      return { valid: false, value: null };
    }
  };
  const coerceScalarValue = (raw) => {
    const value = typeof raw === "string" ? raw.trim() : raw;
    if (typeof value !== "string") {
      return value;
    }
    if (!value.length) {
      return value;
    }
    const lower = value.toLowerCase();
    if (lower === "true") {
      return true;
    }
    if (lower === "false") {
      return false;
    }
    if (lower === "null") {
      return null;
    }
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) {
      const numeric = Number(value);
      if (!Number.isNaN(numeric)) {
        return numeric;
      }
    }
    if (value.startsWith("{") && value.endsWith("}") || value.startsWith("[") && value.endsWith("]")) {
      const parsed = safeJsonParse(value);
      if (parsed !== null) {
        return parsed;
      }
    }
    return value;
  };
  const sanitizeInitialArguments = () => {
    const currentEntries = Object.entries({ ...normalizedArgs });
    for (const [name, raw] of currentEntries) {
      if (!argumentMetadata[name]) {
        continue;
      }
      const optionCheck = normalizeOptionValue(name, raw);
      if (!optionCheck.valid) {
        delete normalizedArgs[name];
        continue;
      }
      const candidate = optionMap.has(name) ? optionCheck.value : raw;
      const validation = validateArgumentValue(name, candidate);
      if (!validation.valid) {
        delete normalizedArgs[name];
        continue;
      }
      normalizedArgs[name] = validation.value;
    }
  };
  sanitizeInitialArguments();
  const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const argumentNameVariationsMap = /* @__PURE__ */ new Map();
  for (const argName of allArgumentNames) {
    const variations = [argName];
    const spaceSeparated = argName.replace(/_/g, " ");
    if (spaceSeparated !== argName) {
      variations.push(spaceSeparated);
    }
    const noSeparator = argName.replace(/_/g, "");
    if (noSeparator !== argName && noSeparator !== spaceSeparated) {
      variations.push(noSeparator);
    }
    for (const variant of variations) {
      argumentNameVariationsMap.set(variant.toLowerCase(), argName);
    }
  }
  const parseNamedArguments = (input, candidateNames) => {
    const resolved = /* @__PURE__ */ new Map();
    const invalid = /* @__PURE__ */ new Set();
    if (!input || !candidateNames.length) {
      return { resolved, invalid };
    }
    const allVariations = [];
    const variationToCanonical = /* @__PURE__ */ new Map();
    for (const name of candidateNames) {
      const variations = [name];
      const spaceSeparated = name.replace(/_/g, " ");
      if (spaceSeparated !== name) {
        variations.push(spaceSeparated);
      }
      const noSeparator = name.replace(/_/g, "");
      if (noSeparator !== name && noSeparator !== spaceSeparated) {
        variations.push(noSeparator);
      }
      for (const variant of variations) {
        allVariations.push(variant);
        variationToCanonical.set(variant.toLowerCase(), name);
      }
    }
    allVariations.sort((a, b) => b.length - a.length);
    const nameAlternatives = allVariations.map(escapeRegex).join("|");
    const pattern = new RegExp(String.raw`\b(${nameAlternatives})\b\s*(?::|=)?\s*("[^"]*"|'[^']*'|[^\s"']+)`, "gi");
    let match;
    while ((match = pattern.exec(input)) !== null) {
      const rawName = match[1];
      const canonical = variationToCanonical.get(rawName.toLowerCase());
      if (!canonical) {
        continue;
      }
      if (resolved.has(canonical)) {
        invalid.add(canonical);
        continue;
      }
      let rawValue = match[2] || "";
      rawValue = rawValue.trim();
      if (!rawValue.length) {
        invalid.add(canonical);
        continue;
      }
      if (rawValue.startsWith('"') && rawValue.endsWith('"') || rawValue.startsWith("'") && rawValue.endsWith("'")) {
        rawValue = rawValue.slice(1, -1);
      }
      rawValue = rawValue.trim();
      if (!rawValue.length) {
        invalid.add(canonical);
        continue;
      }
      const optionCheck = normalizeOptionValue(canonical, rawValue);
      if (!optionCheck.valid) {
        invalid.add(canonical);
        continue;
      }
      const candidate = optionMap.has(canonical) ? optionCheck.value : coerceScalarValue(rawValue);
      const validation = validateArgumentValue(canonical, candidate);
      if (!validation.valid) {
        invalid.add(canonical);
        continue;
      }
      resolved.set(canonical, validation.value);
    }
    return { resolved, invalid };
  };
  const resolveFieldName = (name) => {
    if (typeof name !== "string") {
      return null;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      return null;
    }
    if (allArgumentNames.includes(trimmed)) {
      return trimmed;
    }
    const lower = trimmed.toLowerCase();
    const direct = allArgumentNames.find((candidate) => candidate.toLowerCase() === lower);
    if (direct) {
      return direct;
    }
    const argumentAliases = skill.argumentAliases && typeof skill.argumentAliases === "object" ? skill.argumentAliases : {};
    for (const [targetArg, keywords] of Object.entries(argumentAliases)) {
      if (!allArgumentNames.includes(targetArg)) {
        continue;
      }
      if (!Array.isArray(keywords) || !keywords.length) {
        continue;
      }
      const lowerKeywords = keywords.map((k) => String(k).toLowerCase());
      if (lowerKeywords.some((keyword) => lower.includes(keyword))) {
        return targetArg;
      }
    }
    const fuzzy = allArgumentNames.find((candidate) => {
      const canonical = candidate.toLowerCase();
      const distance = Math.abs(canonical.length - lower.length);
      return distance <= 2 && (canonical.startsWith(lower) || lower.startsWith(canonical));
    });
    return fuzzy || null;
  };
  const applyUpdatesMap = (updates) => {
    if (!updates || typeof updates !== "object") {
      return "unchanged";
    }
    let applied = false;
    for (const [rawName, rawValue] of Object.entries(updates)) {
      const field = resolveFieldName(rawName);
      if (!field) {
        continue;
      }
      const currentValue = normalizedArgs[field];
      const hasValue = hasArgumentValue(field);
      const optionCheck = normalizeOptionValue(field, rawValue);
      if (!optionCheck.valid) {
        continue;
      }
      const candidateValue = optionMap.has(field) ? optionCheck.value : coerceScalarValue(rawValue);
      const validation = validateArgumentValue(field, candidateValue);
      if (!validation.valid) {
        continue;
      }
      const nextValue = validation.value;
      const valuesMatch = () => {
        if (!hasValue) {
          return false;
        }
        const current = currentValue;
        if (typeof current === "string" && typeof nextValue === "string") {
          return current.trim() === nextValue.trim();
        }
        return current === nextValue;
      };
      if (valuesMatch()) {
        continue;
      }
      normalizedArgs[field] = nextValue;
      applied = true;
    }
    if (!applied) {
      return "unchanged";
    }
    return missingRequiredArgs().length > 0 ? "needsMissing" : "updated";
  };
  const applyDescriptionDefaults = () => {
    for (const definition of argumentDefinitions) {
      if (!definition || typeof definition.name !== "string") {
        continue;
      }
      if (hasArgumentValue(definition.name)) {
        continue;
      }
      const desc = typeof definition.description === "string" ? definition.description : "";
      const defaultMatch = desc.match(/defaults? to\s+([^.]+)/i);
      if (defaultMatch && defaultMatch[1]) {
        const rawDefault = defaultMatch[1].replace(/["']/g, "").replace(/[)\.]+$/, "").trim();
        if (!rawDefault) {
          continue;
        }
        const optionCheck = normalizeOptionValue(definition.name, rawDefault);
        if (!optionCheck.valid) {
          continue;
        }
        const candidateValue = optionMap.has(definition.name) ? optionCheck.value : coerceScalarValue(rawDefault);
        const validation = validateArgumentValue(definition.name, candidateValue);
        if (!validation.valid) {
          continue;
        }
        normalizedArgs[definition.name] = validation.value;
      }
    }
  };
  const autofillWithLanguageModel = async () => {
    if (!missingRequiredArgs().length) {
      return false;
    }
    let agent;
    try {
      agent = getAgent();
    } catch (error) {
      return false;
    }
    const flexSearchPrefills = /* @__PURE__ */ new Map();
    for (const argName of missingRequiredArgs()) {
      if (!optionIndexMap.has(argName)) {
        continue;
      }
      const flexResult = matchOptionWithFlexSearch(argName, taskDescription);
      if (flexResult.matched && flexResult.confidence >= 0.8) {
        flexSearchPrefills.set(argName, flexResult.value);
        if (debugMode) {
          console.log(`[FlexSearch] Pre-filled "${argName}" from task description`);
        }
      }
    }
    for (const [argName, value] of flexSearchPrefills.entries()) {
      const validation = validateArgumentValue(argName, value);
      if (validation.valid) {
        normalizedArgs[argName] = validation.value;
      }
    }
    if (!missingRequiredArgs().length) {
      if (debugMode && flexSearchPrefills.size > 0) {
        console.log(`[FlexSearch] Filled all required arguments without LLM`);
      }
      return flexSearchPrefills.size > 0;
    }
    const allowedKeys = JSON.stringify(allArgumentNames);
    const skillNameLower = (skill.name || "").toLowerCase();
    const commandWords = skillNameLower.split(/[-_\s]+/).filter(Boolean);
    const argumentNameVariations = allArgumentNames.map((argName) => {
      const variations = [argName];
      const spaceSeparated = argName.replace(/_/g, " ");
      if (spaceSeparated !== argName) {
        variations.push(spaceSeparated);
      }
      const noSeparator = argName.replace(/_/g, "");
      if (noSeparator !== argName && noSeparator !== spaceSeparated) {
        variations.push(noSeparator);
      }
      return { canonical: argName, variations };
    });
    const variationsText = argumentNameVariations.map(({ canonical, variations }) => `"${canonical}" can be spoken as: ${variations.map((v) => `"${v}"`).join(" or ")}`).join("\n");
    const typeHints = argumentDefinitions.map((def) => {
      const argType = def.type || "string";
      const hasOptions = optionMap.has(def.name);
      if (hasOptions) {
        const flexResult = matchOptionWithFlexSearch(def.name, taskDescription);
        if (flexResult.matches && flexResult.matches.length > 0) {
          const topMatches = flexResult.matches.slice(0, 3).map((o) => o.label).join(", ");
          return `${def.name}: enum/option (top matches: ${topMatches}) - stop at first matching option`;
        } else {
          const options = optionMap.get(def.name);
          const optionLabels = options.map((o) => o.label).slice(0, 3).join(", ");
          return `${def.name}: enum/option (sample values: ${optionLabels}${options.length > 3 ? ", ..." : ""}) - stop at first matching option`;
        }
      }
      if (argType === "number" || argType === "integer") {
        return `${def.name}: number - stop at first numeric value`;
      }
      if (argType === "boolean") {
        return `${def.name}: boolean - stop at true/false`;
      }
      return `${def.name}: string - capture all tokens until next argument name`;
    }).join("\n");
    if (debugMode) {
      console.log("[LLM] Invoking language model for argument extraction");
    }
    const systemPrompt = `You extract tool arguments from natural language requests, including VOICE INPUT patterns. Respond ONLY with JSON using keys from ${allowedKeys}. Use exact casing.

VOICE INPUT PATTERNS (no quotes in voice):
When you see "arg_name value value value arg_name2 value2" pattern:
- Capture ALL tokens after an argument name until you see another known argument name or end of input
- For multi-word values, keep all words together until next argument name
- Stop capturing when you encounter: another argument name, command word, or end of input

ARGUMENT NAME RECOGNITION (for voice):
Users may speak argument names without underscores. Map these variations to the canonical JSON key:
${variationsText}

Examples:
- "user name" or "username" \u2192 use key "user_name"
- "first name" or "firstname" \u2192 use key "first_name"
- "email address" or "emailaddress" \u2192 use key "email_address"

TYPE-BASED STOPPING RULES:
${typeHints}

NATURAL LANGUAGE SEPARATORS (recommended for voice):
- "called X" or "named X" \u2192 name-related arguments
- "for X" \u2192 purpose/target arguments
- "at X" or "in X" \u2192 location arguments
- "with X" \u2192 additional properties
- "status X" or "marked as X" \u2192 status arguments

GENERIC EXAMPLES (adapt to current skill):
1. Multi-word string values:
   "command arg1 value one value two arg2 value three"
   \u2192 Capture all words for arg1 until arg2 starts

2. Mixed types:
   "command name multi word name quantity 10 status active"
   \u2192 Stop at number for quantity, stop at option for status

3. Natural separators:
   "command called multi word value for another value"
   \u2192 Map natural language to appropriate arguments

4. Simple positional:
   "command value1 value2"
   \u2192 Extract based on context and task description

5. No parameters:
   "command" with no other words \u2192 {} (empty)

COMMAND WORDS TO IGNORE: "${commandWords.join('", "')}"
Use numbers for numeric fields, booleans for true/false. If value is ambiguous or not mentioned, omit that key.`;
    const sections = [
      `Skill name: ${skill.name}`,
      `Skill description: ${skill.description}`,
      `Existing arguments: ${JSON.stringify(normalizedArgs, null, 2)}`,
      `Missing arguments: ${JSON.stringify(missingRequiredArgs())}`,
      `Optional arguments: ${JSON.stringify(missingOptionalArgs())}`
    ];
    if (argumentDefinitions.length) {
      sections.push(`Argument definitions: ${JSON.stringify(argumentDefinitions, null, 2)}`);
    }
    if (taskDescription && typeof taskDescription === "string") {
      sections.push(`Original user request: ${taskDescription}`);
    }
    sections.push(`Apply the voice input pattern rules above. Remember to capture multi-word values until the next argument name. Map phrases to appropriate arguments. Return JSON only, empty object {} if no parameters found.`);
    let raw;
    try {
      raw = await invokeAgent(agent, [
        { role: "system", message: systemPrompt },
        { role: "human", message: sections.join("\n\n") }
      ], { mode: "fast" });
    } catch (error) {
      return false;
    }
    const parsed = safeJsonParse(typeof raw === "string" ? raw.trim() : raw);
    if (!parsed || typeof parsed !== "object") {
      return false;
    }
    const status = applyUpdatesMap(parsed);
    if (debugMode && status !== "unchanged") {
      console.log(`[LLM] Applied updates from language model: ${JSON.stringify(parsed)}`);
    }
    return status !== "unchanged";
  };
  const prefillFromTaskDescription = (rawDescription) => {
    if (typeof rawDescription !== "string") {
      return;
    }
    const trimmed = rawDescription.trim();
    if (!trimmed) {
      return;
    }
    const attemptPrefill = (name, rawValue) => {
      if (!allArgumentNames.includes(name)) {
        return;
      }
      if (hasArgumentValue(name)) {
        return;
      }
      const optionCheck = normalizeOptionValue(name, rawValue);
      if (!optionCheck.valid) {
        return;
      }
      const candidate = optionMap.has(name) ? optionCheck.value : coerceScalarValue(rawValue);
      const validation = validateArgumentValue(name, candidate);
      if (!validation.valid) {
        return;
      }
      normalizedArgs[name] = validation.value;
    };
    const candidateNames = allArgumentNames.length ? allArgumentNames : requiredArguments.length ? requiredArguments : missingRequiredArgs();
    if (candidateNames.length) {
      const { resolved: parsed } = parseNamedArguments(trimmed, candidateNames);
      for (const [name, value] of parsed.entries()) {
        if (!hasArgumentValue(name)) {
          normalizedArgs[name] = value;
        }
      }
    }
    const lowerDescription = trimmed.toLowerCase();
    if (!hasArgumentValue("role")) {
      if (lowerDescription.includes("system admin")) {
        attemptPrefill("role", "SystemAdmin");
      } else if (lowerDescription.includes("system administrator")) {
        attemptPrefill("role", "SystemAdmin");
      } else if (lowerDescription.includes("project manager")) {
        attemptPrefill("role", "ProjectManager");
      }
    }
    const stopWords = /* @__PURE__ */ new Set(["user", "manager", "admin", "administrator", "system", "project", "role", "password", "username", "given", "family", "name", "skip", "confirmation", "confirm", "new", "add", "task"]);
    const tokens = trimmed.split(/\s+/);
    for (let i = tokens.length - 2; i >= 0; i -= 1) {
      const first = tokens[i];
      const second = tokens[i + 1];
      if (!first || !second) {
        continue;
      }
      const isAlpha = (value) => /^[a-z]+$/i.test(value);
      const isNameCandidate = (value) => isAlpha(value) && !stopWords.has(value.toLowerCase());
      if (!isNameCandidate(first) || !isNameCandidate(second)) {
        continue;
      }
      const toTitle = (value) => value.length ? value[0].toUpperCase() + value.slice(1).toLowerCase() : value;
      if (!hasArgumentValue("givenName")) {
        attemptPrefill("givenName", toTitle(first));
      }
      if (!hasArgumentValue("familyName")) {
        attemptPrefill("familyName", toTitle(second));
      }
      break;
    }
  };
  const missingRequiredArgs = () => missingArgsFromList(requiredArguments);
  const missingOptionalArgs = () => missingArgsFromList(optionalArgumentNames);
  const describeArgument = (name) => {
    const definition = argumentDefinitions.find((arg) => arg.name === name);
    const options = optionMap.get(name);
    const descriptionPart = definition?.description ? `: ${definition.description}` : "";
    const baseLine = `${name}${descriptionPart}`;
    if (options && options.length) {
      const lines = options.map((option) => `  * ${option.display}`);
      return [baseLine, "Options:", ...lines].join("\n");
    }
    return baseLine;
  };
  const parseableArgumentNames = allArgumentNames.length ? allArgumentNames : requiredArguments.length ? requiredArguments : [];
  const interpretConfirmationResponse = async (rawInput, summaryText) => {
    let agent;
    try {
      agent = getAgent();
    } catch (error) {
      return null;
    }
    const systemPrompt = 'You interpret confirmation responses for tool execution. Respond ONLY with JSON like {"action":"confirm|cancel|edit","updates":{"field":"value"}}. Use lowercase action strings.';
    const humanSections = [
      "The user was shown a summary of the pending action and replied as follows.",
      `User reply: ${rawInput}`,
      `Current arguments: ${JSON.stringify(normalizedArgs, null, 2)}`
    ];
    if (summaryText) {
      humanSections.push(`Summary shown to user:
${summaryText}`);
    }
    if (argumentDefinitions.length) {
      humanSections.push(`Argument definitions: ${JSON.stringify(argumentDefinitions, null, 2)}`);
    }
    humanSections.push('Return JSON only. Use "confirm" to proceed, "cancel" to stop, or "edit" with updates to adjust specific arguments.');
    let raw;
    try {
      raw = await invokeAgent(agent, [
        { role: "system", message: systemPrompt },
        { role: "human", message: humanSections.join("\n\n") }
      ], { mode: "fast" });
    } catch (error) {
      return null;
    }
    const parsed = safeJsonParse(typeof raw === "string" ? raw.trim() : raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const action2 = typeof parsed.action === "string" ? parsed.action.trim().toLowerCase() : "";
    const updates = parsed.updates && typeof parsed.updates === "object" ? parsed.updates : null;
    if (!action2) {
      return null;
    }
    return { action: action2, updates };
  };
  const formatArgumentList = (descriptors) => descriptors.map((descriptor) => {
    if (descriptor === null || descriptor === void 0) {
      return "";
    }
    const lines = String(descriptor).split("\n");
    if (!lines.length) {
      return "";
    }
    const [first, ...rest] = lines;
    const formatted = [`    - ${first}`];
    for (const line of rest) {
      formatted.push(line ? `      ${line}` : "      ");
    }
    return formatted.join("\n");
  }).filter(Boolean).join("\n");
  let optionalPromptShown = false;
  const collectMissingArguments = async () => {
    optionalPromptShown = false;
    while (missingRequiredArgs().length > 0) {
      const missingRequiredAtStart = missingRequiredArgs();
      const missingRequired = missingRequiredAtStart;
      const missingOptional = optionalPromptShown ? [] : missingOptionalArgs();
      const requiredDescriptors = missingRequired.map(describeArgument);
      const promptSections = ["Missing required arguments:"];
      const formattedRequired = formatArgumentList(requiredDescriptors);
      if (formattedRequired) {
        promptSections.push(formattedRequired);
      }
      if (missingOptional.length) {
        const optionalDescriptors = missingOptional.map(describeArgument);
        const formattedOptional = formatArgumentList(optionalDescriptors);
        if (formattedOptional) {
          promptSections.push("Optional arguments you may also set now:", formattedOptional);
        } else {
          promptSections.push("Optional arguments you may also set now:");
        }
        optionalPromptShown = true;
      }
      promptSections.push("Provide values (or type 'cancel' to abort):\n");
      const userInput = await readUserPrompt(`${promptSections.join("\n")}`);
      const trimmedInput = typeof userInput === "string" ? userInput.trim() : "";
      if (!trimmedInput) {
        if (!optionalPromptShown && optionalArgumentNames.length) {
          optionalPromptShown = true;
        }
        continue;
      }
      if (trimmedInput.toLowerCase() === "cancel") {
        throw new Error("Skill execution cancelled by user.");
      }
      const parseTargets = parseableArgumentNames.length ? parseableArgumentNames : missingRequired;
      const { resolved: directlyParsed, invalid: ambiguous } = parseNamedArguments(trimmedInput, parseTargets);
      for (const [name, value] of directlyParsed.entries()) {
        normalizedArgs[name] = value;
      }
      const assignUnlabeledTokens = () => {
        const rawTokens = trimmedInput.match(/"[^"]*"|'[^']*'|\S+/g);
        if (!rawTokens || !rawTokens.length) {
          return;
        }
        const normalizedTokens = rawTokens.map((token) => {
          const trimmedToken = token.trim();
          if (!trimmedToken.length) {
            return "";
          }
          if (trimmedToken.startsWith('"') && trimmedToken.endsWith('"') || trimmedToken.startsWith("'") && trimmedToken.endsWith("'")) {
            return trimmedToken.slice(1, -1).trim();
          }
          return trimmedToken;
        }).filter(Boolean);
        if (!normalizedTokens.length) {
          return;
        }
        const candidateNameSet = new Set(parseTargets.map((name) => name.toLowerCase()));
        const consumedValueSet = new Set(Array.from(directlyParsed.values()).map((value) => typeof value === "string" ? value.trim().toLowerCase() : null).filter(Boolean));
        const tokensForAssignment = normalizedTokens.filter((token) => !candidateNameSet.has(token.toLowerCase())).filter((token) => !consumedValueSet.has(token.toLowerCase()));
        if (!tokensForAssignment.length) {
          return;
        }
        const takeField = (queue, predicate = () => true) => {
          const index = queue.findIndex(predicate);
          if (index === -1) {
            return null;
          }
          const [field] = queue.splice(index, 1);
          return field;
        };
        const requiredQueue = missingRequiredArgs();
        const optionalQueue = missingOptionalArgs();
        const tryAssignToken = (fieldName, tokenValue) => {
          if (!fieldName || hasArgumentValue(fieldName)) {
            return;
          }
          let value = tokenValue;
          const definition = definitionMap.get(fieldName);
          const fieldType = typeof definition?.type === "string" ? definition.type.toLowerCase() : "";
          if (optionMap.has(fieldName)) {
            const optionCheck = normalizeOptionValue(fieldName, value);
            if (!optionCheck.valid) {
              return;
            }
            const validation2 = validateArgumentValue(fieldName, optionCheck.value);
            if (!validation2.valid) {
              return;
            }
            normalizedArgs[fieldName] = validation2.value;
            return;
          }
          if (fieldType === "boolean") {
            const lower = value.toLowerCase();
            if (["true", "yes", "y", "1", "enable", "enabled", "allow", "allowed"].includes(lower)) {
              const validation2 = validateArgumentValue(fieldName, true);
              if (!validation2.valid) {
                return;
              }
              normalizedArgs[fieldName] = validation2.value;
              return;
            }
            if (["false", "no", "n", "0", "disable", "disabled", "deny", "denied"].includes(lower)) {
              const validation2 = validateArgumentValue(fieldName, false);
              if (!validation2.valid) {
                return;
              }
              normalizedArgs[fieldName] = validation2.value;
              return;
            }
          }
          if (fieldType === "integer" || fieldType === "number") {
            const numeric = Number(value);
            if (Number.isFinite(numeric)) {
              const normalizedNumeric = fieldType === "integer" ? Math.trunc(numeric) : numeric;
              const validation2 = validateArgumentValue(fieldName, normalizedNumeric);
              if (!validation2.valid) {
                return;
              }
              normalizedArgs[fieldName] = validation2.value;
              return;
            }
          }
          if (fieldType && fieldType !== "string") {
            const coerced = coerceScalarValue(value);
            const validation2 = validateArgumentValue(fieldName, coerced);
            if (!validation2.valid) {
              return;
            }
            normalizedArgs[fieldName] = validation2.value;
            return;
          }
          const validation = validateArgumentValue(fieldName, value);
          if (!validation.valid) {
            return;
          }
          normalizedArgs[fieldName] = validation.value;
        };
        for (const token of tokensForAssignment) {
          const emailField = token.includes("@") ? takeField(requiredQueue, (name) => {
            const definition = definitionMap.get(name);
            const description = definition?.description || "";
            return /email/i.test(name) || /email/i.test(description);
          }) || takeField(optionalQueue, (name) => {
            const definition = definitionMap.get(name);
            const description = definition?.description || "";
            return /email/i.test(name) || /email/i.test(description);
          }) : null;
          if (emailField) {
            tryAssignToken(emailField, token);
            continue;
          }
          const nextRequired = takeField(requiredQueue);
          if (nextRequired) {
            tryAssignToken(nextRequired, token);
            continue;
          }
          const nextOptional = takeField(optionalQueue);
          if (nextOptional) {
            tryAssignToken(nextOptional, token);
          }
        }
      };
      if (skill.disableAutoTokenAssignment !== true) {
        assignUnlabeledTokens();
      }
      if (ambiguous.size) {
        console.warn(`The following arguments were not understood: ${Array.from(ambiguous).join(", ")}.`);
      }
      const pendingAfterManual = missingRequiredArgs();
      if (!pendingAfterManual.length) {
        break;
      }
      const flexSearchMatches = /* @__PURE__ */ new Map();
      for (const argName of pendingAfterManual) {
        if (!optionIndexMap.has(argName)) {
          continue;
        }
        const flexResult = matchOptionWithFlexSearch(argName, trimmedInput);
        if (flexResult.matched && flexResult.confidence >= 0.8) {
          flexSearchMatches.set(argName, flexResult.value);
        }
      }
      for (const [argName, value] of flexSearchMatches.entries()) {
        const validation = validateArgumentValue(argName, value);
        if (validation.valid) {
          normalizedArgs[argName] = validation.value;
          if (debugMode) {
            console.log(`[FlexSearch] Matched "${argName}" from user input before LLM fallback`);
          }
        }
      }
      if (!missingRequiredArgs().length) {
        if (debugMode && flexSearchMatches.size > 0) {
          console.log(`[FlexSearch] Filled remaining arguments without LLM`);
        }
        break;
      }
      const currentPending = missingRequiredArgs();
      if (currentPending.length < missingRequiredAtStart.length) {
        if (debugMode) {
          console.log(`[Skip LLM] Progress made (${missingRequiredAtStart.length - currentPending.length} filled), prompting for remaining ${currentPending.length}`);
        }
        continue;
      }
      let agent;
      try {
        agent = getAgent();
      } catch (error) {
        throw new Error(`Unable to obtain language model for parsing arguments: ${error.message}`);
      }
      if (debugMode) {
        console.log("[LLM] Falling back to language model for remaining arguments");
      }
      const systemPrompt = "You extract structured JSON arguments for tool execution. Respond with JSON only, no commentary.";
      const humanPromptSections = [
        `Skill name: ${skill.name}`,
        `Skill description: ${skill.description}`
      ];
      if (argumentDefinitions.length) {
        humanPromptSections.push(`Argument definitions: ${JSON.stringify(argumentDefinitions, null, 2)}`);
      }
      humanPromptSections.push(`Missing argument names: ${JSON.stringify(pendingAfterManual)}`);
      const availableOptions = pendingAfterManual.map((name) => {
        const options = optionMap.get(name);
        if (!options || !options.length) {
          return null;
        }
        const flexResult = matchOptionWithFlexSearch(name, trimmedInput);
        if (flexResult.matches && flexResult.matches.length > 0) {
          const topMatches = flexResult.matches.slice(0, 3).map((option) => option.display).join(", ");
          return `${name} (top matches): ${topMatches}`;
        }
        const formatted = options.slice(0, 3).map((option) => option.display).join(", ");
        return `${name} (sample options): ${formatted}${options.length > 3 ? ", ..." : ""}`;
      }).filter(Boolean);
      if (availableOptions.length) {
        humanPromptSections.push(`Available options:
${availableOptions.join("\n")}`);
      }
      humanPromptSections.push(`User response: ${trimmedInput}`);
      humanPromptSections.push("Return a JSON object containing values for the missing argument names. Omit any extraneous fields.");
      let rawExtraction;
      try {
        rawExtraction = await invokeAgent(agent, [
          { role: "system", message: systemPrompt },
          { role: "human", message: humanPromptSections.join("\n\n") }
        ], { mode: "fast" });
      } catch (error) {
        throw new Error(`Failed to parse arguments with the language model: ${error.message}`);
      }
      const parsedExtraction = safeJsonParse(typeof rawExtraction === "string" ? rawExtraction.trim() : rawExtraction);
      if (!parsedExtraction || typeof parsedExtraction !== "object") {
        console.warn("The language model did not return valid JSON. Please try providing the details again.");
        continue;
      }
      const pendingSet = new Set(pendingAfterManual);
      const invalidFromModel = /* @__PURE__ */ new Set();
      let appliedFromModel = false;
      for (const [name, value] of Object.entries(parsedExtraction)) {
        if (!pendingSet.has(name)) {
          continue;
        }
        if (value === void 0 || value === null) {
          continue;
        }
        const optionCheck = normalizeOptionValue(name, value);
        if (!optionCheck.valid) {
          invalidFromModel.add(name);
          continue;
        }
        const candidateValue = optionMap.has(name) ? optionCheck.value : value;
        const validation = validateArgumentValue(name, candidateValue);
        if (!validation.valid) {
          invalidFromModel.add(name);
          continue;
        }
        normalizedArgs[name] = validation.value;
        appliedFromModel = true;
        if (debugMode) {
          console.log(`[LLM] Extracted "${name}" = ${JSON.stringify(validation.value)}`);
        }
      }
      if (invalidFromModel.size) {
        console.warn(`The model returned unsupported options for arguments: ${Array.from(invalidFromModel).join(", ")}.`);
      }
      if (!appliedFromModel) {
        console.warn("Unable to determine values for the remaining arguments. Please provide them again.");
      }
    }
  };
  const isSensitiveName = (name) => typeof name === "string" && /(password|secret|token|key)/i.test(name);
  const formatSummaryValue = (name, value) => {
    if (value === void 0) {
      return "(not provided)";
    }
    if (value === null) {
      return "null";
    }
    if (typeof value === "string") {
      if (!value.length) {
        return "(empty string)";
      }
      if (isSensitiveName(name)) {
        return "********";
      }
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  };
  const buildConfirmationSummary = () => {
    const descriptor = skill.humanDescription || skill.description || skill.what || skill.name;
    const heading = descriptor && descriptor !== skill.name ? `About to execute '${skill.name}': ${descriptor}` : `About to execute '${skill.name}'.`;
    const lines = [heading];
    const summaryNames = argumentDefinitions.length ? argumentDefinitions.map((def) => def?.name).filter(Boolean) : Array.from(/* @__PURE__ */ new Set([
      ...Object.keys(normalizedArgs),
      ...allArgumentNames,
      ...requiredArguments,
      ...optionalArgumentNames
    ])).filter(Boolean);
    if (!summaryNames.length) {
      lines.push("Arguments: (none)");
      return lines.join("\n");
    }
    lines.push("Arguments:");
    for (const name of summaryNames) {
      const value = Object.prototype.hasOwnProperty.call(normalizedArgs, name) ? normalizedArgs[name] : void 0;
      lines.push(`  - ${name}: ${formatSummaryValue(name, value)}`);
    }
    return lines.join("\n");
  };
  const requestArgumentEdits = async () => {
    const editTargets = parseableArgumentNames.length ? parseableArgumentNames : Array.from(/* @__PURE__ */ new Set([
      ...argumentDefinitions.map((def) => def?.name).filter(Boolean),
      ...Object.keys(normalizedArgs),
      ...requiredArguments,
      ...optionalArgumentNames
    ])).filter(Boolean);
    if (!editTargets.length) {
      return "unchanged";
    }
    const editInput = await readUserPrompt('Enter updates (e.g., "password newPass role Admin") or press Enter to keep current values:\n');
    const trimmedEdit = typeof editInput === "string" ? editInput.trim() : "";
    if (!trimmedEdit) {
      return "unchanged";
    }
    const { resolved: updates, invalid: invalidUpdates } = parseNamedArguments(trimmedEdit, editTargets);
    const updatesObject = Object.fromEntries(updates);
    const applyResult = applyUpdatesMap(updatesObject);
    if (invalidUpdates.size) {
      console.warn(`The following arguments were not understood: ${Array.from(invalidUpdates).join(", ")}.`);
    }
    return applyResult;
  };
  if (taskDescription && typeof taskDescription === "string" && taskDescription.trim()) {
    prefillFromTaskDescription(taskDescription);
  }
  await autofillWithLanguageModel();
  applyDescriptionDefaults();
  let needsArgumentCollection = true;
  while (true) {
    if (needsArgumentCollection) {
      await collectMissingArguments();
      needsArgumentCollection = false;
    }
    if (skipConfirmation || !skill.needConfirmation) {
      break;
    }
    const summary = buildConfirmationSummary();
    const confirmationInput = await readUserPrompt(`${summary}
Go ahead, edit, or cancel?
`);
    const normalizedResponse = typeof confirmationInput === "string" ? confirmationInput.trim().toLowerCase() : "";
    const affirmatives = /* @__PURE__ */ new Set(["y", "yes", "ok", "sure", "do it", "go ahead", "proceed"]);
    const negatives = /* @__PURE__ */ new Set(["c", "cancel", "n", "no", "stop", "abort", "never mind"]);
    const edits = /* @__PURE__ */ new Set(["e", "edit", "change", "update", "adjust"]);
    if (!normalizedResponse || affirmatives.has(normalizedResponse)) {
      break;
    }
    if (negatives.has(normalizedResponse)) {
      throw new Error("Skill execution cancelled by user.");
    }
    if (edits.has(normalizedResponse)) {
      const editResult = await requestArgumentEdits();
      if (editResult === "needsMissing") {
        needsArgumentCollection = true;
      }
      continue;
    }
    const interpreted = await interpretConfirmationResponse(confirmationInput, summary);
    if (interpreted && interpreted.action) {
      const action2 = interpreted.action;
      if (action2 === "confirm" || action2 === "yes" || action2 === "proceed") {
        break;
      }
      if (action2 === "cancel" || action2 === "stop" || action2 === "abort") {
        throw new Error("Skill execution cancelled by user.");
      }
      if (action2 === "edit") {
        if (interpreted.updates && Object.keys(interpreted.updates).length) {
          const editResult = applyUpdatesMap(interpreted.updates);
          if (editResult === "needsMissing") {
            needsArgumentCollection = true;
          } else if (editResult === "unchanged") {
            console.log("I could not apply those changes. Let\u2019s try again together.");
            const manualResult2 = await requestArgumentEdits();
            if (manualResult2 === "needsMissing") {
              needsArgumentCollection = true;
            }
          }
          continue;
        }
        const manualResult = await requestArgumentEdits();
        if (manualResult === "needsMissing") {
          needsArgumentCollection = true;
        }
        continue;
      }
    }
    console.log("Please answer in your own words\u2014for example 'yes', 'edit', or 'cancel'.");
  }
  const orderedNames = argumentDefinitions.length ? argumentDefinitions.map((def) => def.name) : requiredArguments.slice();
  if (!orderedNames.length) {
    return action({ ...normalizedArgs });
  }
  const positionalValues = orderedNames.map((name) => normalizedArgs[name]);
  if (action.length > 1) {
    return action(...positionalValues);
  }
  if (orderedNames.length === 1) {
    return action(positionalValues[0]);
  }
  return action({ ...normalizedArgs });
}

// context/contextBuilder.mjs
var CONTEXT_ROLE_ALIASES = /* @__PURE__ */ new Map([
  ["system", "system"],
  ["user", "human"],
  ["human", "human"],
  ["assistant", "assistant"],
  ["tool", "assistant"],
  ["function", "assistant"],
  ["observation", "assistant"]
]);
var TOOL_LIKE_ROLES = /* @__PURE__ */ new Set(["tool", "function", "observation"]);
function limitPreview(value, maxLength = 400) {
  if (value === void 0 || value === null) {
    return "";
  }
  let text;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch (error) {
      text = String(value);
    }
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}
function buildSuggestionBlock(title, lines) {
  if (!lines || !lines.length) {
    return null;
  }
  const body = lines.map((line) => `- ${line}`).join("\n");
  return `${title}:
${body}`;
}
function normalizeAgentKind(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "chat" ? "chat" : "task";
}
function buildAgentDescription(agent) {
  const kind = normalizeAgentKind(agent?.kind);
  const isChat = kind === "chat";
  const classification = isChat ? "Expert Conversationalist" : "Expert Task Executor";
  const role = agent?.role ? String(agent.role).trim() : "";
  const job = agent?.job ? String(agent.job).trim() : "";
  const expertise = agent?.expertise ? String(agent.expertise).trim() : "";
  const instructions = agent?.instructions ? String(agent.instructions).trim() : "";
  const details = [
    `Type: ${kind}`,
    `Classification: ${classification}`,
    role && `Role: ${role}`,
    job && `Job: ${job}`,
    expertise && `Expertise: ${expertise}`,
    instructions && `Guidance: ${instructions}`
  ].filter(Boolean).join(" | ");
  return details;
}
function normalizeTaskContext(_agent, context) {
  if (Array.isArray(context)) {
    const normalizedMessages = context.map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const rawRole = typeof entry.role === "string" ? entry.role.trim().toLowerCase() : "";
      const role = CONTEXT_ROLE_ALIASES.get(rawRole);
      if (!role) {
        return null;
      }
      let message = entry.message;
      if (typeof message === "undefined" || message === null) {
        message = entry.content;
      }
      if (typeof message === "undefined" || message === null) {
        message = entry.result;
      }
      if (typeof message === "undefined" || message === null) {
        message = entry.output;
      }
      if (typeof message === "undefined" || message === null) {
        return null;
      }
      if (typeof message === "object") {
        try {
          message = JSON.stringify(message, null, 2);
        } catch (error) {
          message = String(message);
        }
      }
      if (TOOL_LIKE_ROLES.has(rawRole)) {
        const label = entry.name ? `${rawRole}:${entry.name}` : rawRole;
        message = `[${label}] ${String(message)}`;
      }
      return {
        role,
        message: String(message)
      };
    }).filter(Boolean);
    if (normalizedMessages.length) {
      return {
        type: "messages",
        messages: normalizedMessages
      };
    }
    return {
      type: "text",
      text: ""
    };
  }
  const trimmed = context ? String(context).trim() : "";
  return {
    type: "text",
    text: trimmed
  };
}
function buildSystemHistory(agent, { instruction, context, description, outputSchema, extraContextParts = [] }) {
  const history = [];
  const agentLabel = agent.canonicalName || agent.name;
  const agentDescription = buildAgentDescription(agent);
  history.push({
    role: "system",
    message: `You are the ${agentLabel} agent. ${agentDescription} ${instruction}`.trim()
  });
  const normalizedContext = context && typeof context === "object" && (context.type === "text" || context.type === "messages") ? context : normalizeTaskContext(agent, context);
  if (normalizedContext.type === "messages") {
    for (const entry of normalizedContext.messages) {
      history.push({ role: entry.role, message: entry.message });
    }
  }
  const parts = [];
  if (normalizedContext.type === "text" && normalizedContext.text) {
    parts.push(`Context:
${normalizedContext.text}`);
  }
  if (Array.isArray(extraContextParts) && extraContextParts.length) {
    for (const part of extraContextParts) {
      if (part) {
        parts.push(part);
      }
    }
  }
  if (description) {
    parts.push(`Task:
${description}`);
  }
  if (outputSchema) {
    parts.push(`Desired output schema (JSON Schema):
${JSON.stringify(outputSchema, null, 2)}`);
    parts.push("Respond with JSON that strictly matches the schema.");
  }
  if (parts.length) {
    history.push({
      role: "human",
      message: parts.join("\n\n")
    });
  }
  return history;
}

// tasks/taskRunner.mjs
function normalizeTaskMode(mode, outputSchema, agent, fallback = "fast") {
  const normalized = (mode || "").toLowerCase();
  const agentModes = Array.isArray(agent?.supportedModes) ? agent.supportedModes.slice() : [];
  if (!agentModes.length && agent?.modelMode) {
    agentModes.push(agent.modelMode);
  }
  const supportsMode = (candidate) => {
    if (!candidate) {
      return false;
    }
    if (typeof agent?.supportsMode === "function") {
      return agent.supportsMode(candidate);
    }
    return agentModes.includes(candidate);
  };
  if (normalized === "deep" || normalized === "fast") {
    return supportsMode(normalized) ? normalized : supportsMode(fallback) ? fallback : agentModes[0] || fallback;
  }
  if (normalized === "any" || normalized === "") {
    if (outputSchema && supportsMode("deep")) {
      return "deep";
    }
    if (supportsMode("fast")) {
      return "fast";
    }
    if (supportsMode("deep")) {
      return "deep";
    }
  }
  if (supportsMode(fallback)) {
    return fallback;
  }
  return agentModes[0] || fallback;
}
async function executeFastTask(agent, context, description, outputSchema) {
  const contextInfo = normalizeTaskContext(agent, context);
  const history = buildSystemHistory(agent, {
    instruction: "Complete the task in a single response.",
    context: contextInfo,
    description,
    outputSchema,
    mode: "fast"
  });
  const raw = await invokeAgent(agent, history, { mode: "fast" });
  return buildTaskResult(raw, outputSchema);
}
async function generatePlan(agent, context, description, options = {}) {
  const contextInfo = normalizeTaskContext(agent, context);
  const hints = Array.isArray(options.hints) ? options.hints : [];
  const extraParts = [];
  if (hints.length) {
    const lines = hints.slice(0, 3).map((hint, index) => {
      const steps = Array.isArray(hint?.steps) ? hint.steps.slice(0, 3).map((step, stepIndex) => `${stepIndex + 1}. ${typeof step === "string" ? step : JSON.stringify(step)}`).join(" | ") : limitPreview(hint, 200);
      return `Plan #${index + 1}: ${steps}`;
    });
    const block = buildSuggestionBlock("Candidate plans for reuse", lines);
    if (block) {
      extraParts.push(block);
    }
  }
  const history = buildSystemHistory(agent, {
    instruction: "Create a concise step-by-step plan for the task before solving it.",
    context: contextInfo,
    description,
    outputSchema: { type: "object", properties: { steps: { type: "array" } }, required: ["steps"] },
    mode: "deep",
    extraContextParts: extraParts
  });
  const raw = await invokeAgent(agent, history, { mode: "deep" });
  const parsed = safeJsonParse(raw);
  if (parsed?.steps && Array.isArray(parsed.steps)) {
    return parsed;
  }
  return { steps: Array.from(String(raw).split("\n").filter(Boolean)).map((line, index) => ({ id: index + 1, action: line.trim() })) };
}
async function executeDeepTask(agent, context, description, outputSchema) {
  const contextInfo = normalizeTaskContext(agent, context);
  const plan = await generatePlan(agent, context, description);
  const extraParts = [`Plan:
${JSON.stringify(plan)}`];
  const executionHistory = buildSystemHistory(agent, {
    instruction: "Follow the plan and produce a final answer. Iterate internally as needed.",
    context: contextInfo,
    extraContextParts: extraParts,
    description,
    outputSchema,
    mode: "deep"
  });
  const raw = await invokeAgent(agent, executionHistory, { mode: "deep" });
  return buildTaskResult(raw, outputSchema);
}
async function executeIteration(agent, context, description, outputSchema, iteration, feedback, plan, mode, options = {}) {
  const contextInfo = normalizeTaskContext(agent, context);
  const extraParts = [`Task:
${description}`, `Iteration: ${iteration}`];
  if (plan) {
    extraParts.push(`Plan:
${JSON.stringify(plan)}`);
  }
  if (feedback) {
    extraParts.push(`Prior feedback:
${feedback}`);
  }
  const hints = Array.isArray(options.hints) ? options.hints : [];
  if (hints.length) {
    const block = buildSuggestionBlock("Retrieved guidance", hints.map((hint, index) => `${index + 1}. ${limitPreview(hint, 200)}`));
    if (block) {
      extraParts.push(block);
    }
  }
  const history = buildSystemHistory(agent, {
    instruction: "Work step-by-step, applying the plan and feedback to improve the solution.",
    context: contextInfo,
    extraContextParts: extraParts,
    description: "Return only the updated solution, no commentary unless necessary.",
    outputSchema,
    mode
  });
  const raw = await invokeAgent(agent, history, { mode });
  const parsed = buildTaskResult(raw, outputSchema);
  return { raw, parsed };
}
async function reviewCandidate(agent, context, description, candidate, outputSchema, iteration, mode) {
  const contextInfo = normalizeTaskContext(agent, context || "N/A");
  const reviewHistory = buildSystemHistory(agent, {
    instruction: "Review the candidate solution for quality, correctness, and alignment with the task.",
    context: contextInfo,
    extraContextParts: [
      `Task:
${description}`,
      `Iteration: ${iteration}`,
      `Candidate:
${candidate}`
    ],
    description: 'Return JSON:{"approved":boolean,"feedback":string}.',
    outputSchema: null,
    mode
  });
  const reviewRaw = await invokeAgent(agent, reviewHistory, { mode });
  const review = safeJsonParse(reviewRaw);
  if (typeof review?.approved !== "boolean") {
    return { approved: false, feedback: "Review response invalid; improve the solution with more rigor." };
  }
  return { approved: review.approved, feedback: review.feedback };
}
function buildTaskResult(raw, outputSchema) {
  if (!outputSchema) {
    return { result: raw };
  }
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") {
    return { result: raw };
  }
  return parsed;
}
function buildEvaluationContext(question, generationResults, reviewCriteria) {
  return JSON.stringify({
    question,
    reviewCriteria: reviewCriteria || "Use balanced judgement for quality and relevance.",
    alternatives: generationResults.map((entry) => ({ index: entry.index, agent: entry.agent, content: entry.content }))
  }, null, 2);
}
async function brainstormQuestion(agentName, question, generationCount, returnCount, reviewCriteria = null) {
  if (!question) {
    throw new Error("question is required for brainstorm.");
  }
  if (!Number.isInteger(generationCount) || generationCount < 1) {
    throw new Error("generationCount must be a positive integer.");
  }
  if (!Number.isInteger(returnCount) || returnCount < 1) {
    throw new Error("returnCount must be a positive integer.");
  }
  const registry2 = ensureAgentRegistry();
  const agents = Array.from(registry2.values());
  if (!agents.length) {
    throw new Error("No agents available for brainstorming.");
  }
  const generationResults = [];
  let nextIndex = 1;
  let generatedCount = 0;
  while (generationResults.length < generationCount) {
    const agent = agents[generatedCount % agents.length];
    const history = buildSystemHistory(agent, {
      instruction: "Generate one creative, self-contained answer option.",
      context: "",
      description: `Question: ${question}
You are variant #${nextIndex}.`,
      mode: "fast"
    });
    const raw = await invokeAgent(agent, history, { mode: "fast" });
    generationResults.push({ index: nextIndex, agent: agent.name, content: raw });
    nextIndex += 1;
    generatedCount += 1;
  }
  const evaluator = getAgent(agentName);
  const evaluationMode = evaluator.supportsMode && evaluator.supportsMode("deep") ? "deep" : "fast";
  const evaluationHistory = buildSystemHistory(evaluator, {
    instruction: "Evaluate brainstormed alternatives and return the top choices ranked by quality.",
    context: buildEvaluationContext(question, generationResults, reviewCriteria),
    description: 'Return JSON with property "ranked" listing objects {"index": number, "score": number, "rationale": string}.',
    mode: evaluationMode
  });
  const evaluationRaw = await invokeAgent(evaluator, evaluationHistory, { mode: evaluationMode });
  const evaluation = safeJsonParse(evaluationRaw);
  if (!evaluation?.ranked || !Array.isArray(evaluation.ranked)) {
    throw new Error("Brainstorm evaluation response did not include ranked results.");
  }
  const ranked = evaluation.ranked.filter((entry) => typeof entry.index === "number").slice(0, returnCount);
  return ranked.map((entry) => {
    const match = generationResults.find((option) => option.index === entry.index);
    if (!match) {
      return null;
    }
    return {
      choice: match.content,
      metadata: {
        agent: match.agent,
        index: match.index,
        score: entry.score,
        rationale: entry.rationale
      }
    };
  }).filter(Boolean);
}

// operators/operatorRegistry.mjs
var operatorRegistry = /* @__PURE__ */ new Map();
function registerOperator(operatorName, description, executionCallback) {
  if (!operatorName || typeof operatorName !== "string") {
    throw new Error("operatorName must be a non-empty string.");
  }
  if (!/^[a-z][a-zA-Z0-9-]*$/.test(operatorName)) {
    throw new Error("operatorName must start with a lowercase letter and can only contain alphanumeric characters and dashes.");
  }
  if (!description || typeof description !== "string") {
    throw new Error("description must be a non-empty string.");
  }
  if (typeof executionCallback !== "function") {
    throw new Error("executionCallback must be a function.");
  }
  if (operatorRegistry.has(operatorName)) {
    throw new Error(`Operator "${operatorName}" is already registered.`);
  }
  operatorRegistry.set(operatorName, {
    name: operatorName,
    description,
    execute: executionCallback
  });
}
async function callOperator(operatorName, params = {}) {
  if (!operatorRegistry.has(operatorName)) {
    throw new Error(`Operator "${operatorName}" is not registered.`);
  }
  const operator = operatorRegistry.get(operatorName);
  return operator.execute(params || {});
}
async function chooseOperator(agentName, currentTaskDescription, mode = "fast", threshold = 0.5) {
  if (!operatorRegistry.size) {
    return { suitableOperators: [] };
  }
  const agent = getAgent(agentName);
  const normalizedMode = normalizeTaskMode(mode, null, agent, "fast");
  const operatorList = Array.from(operatorRegistry.values()).map((op) => ({
    operatorName: op.name,
    description: op.description
  }));
  const contextInfo = normalizeTaskContext(agent, JSON.stringify({ operators: operatorList }, null, 2));
  const history = buildSystemHistory(agent, {
    instruction: normalizedMode === "deep" ? "Review the operator catalog and select the functions that can help with the task." : "Quickly select operators that can solve the task.",
    context: contextInfo,
    description: `Task description: ${currentTaskDescription}
Only return JSON: {"suitableOperators":[{"operatorName": string, "confidence": number}]}. Discard operators below confidence ${threshold}.`,
    mode: normalizedMode
  });
  const raw = await invokeAgent(agent, history, { mode: normalizedMode });
  const parsed = safeJsonParse(raw);
  if (parsed?.suitableOperators) {
    const filtered = parsed.suitableOperators.filter((op) => typeof op.confidence === "number" && op.confidence >= threshold);
    return { suitableOperators: filtered };
  }
  if (typeof raw === "string") {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const robustParsed = safeJsonParse(jsonMatch[0]);
      if (robustParsed?.suitableOperators) {
        const filtered = robustParsed.suitableOperators.filter((op) => typeof op.confidence === "number" && op.confidence >= threshold);
        return { suitableOperators: filtered };
      }
    }
  }
  throw new Error("Operator selection response is invalid.");
}
function resetOperatorRegistry() {
  operatorRegistry.clear();
}

// AgentLib.mjs
var agentLibraryInstance = null;
function registerLLMAgent(options = {}) {
  return getAgentLibrary().registerLLMAgent(options);
}
function registerDefaultLLMAgent2(options = {}) {
  return getAgentLibrary().registerDefaultLLMAgent(options);
}
async function doTask(agentName, context, description, outputSchema = null, mode = "fast", retries = 3) {
  return getAgentLibrary().doTask(agentName, context, description, outputSchema, mode, retries);
}
async function doTaskWithReview(agentName, context, description, outputSchema = null, mode = "deep", maxIterations = 5) {
  return getAgentLibrary().doTaskWithReview(agentName, context, description, outputSchema, mode, maxIterations);
}
async function doTaskWithHumanReview(agentName, context, description, outputSchema = null, mode = "deep") {
  return getAgentLibrary().doTaskWithHumanReview(agentName, context, description, outputSchema, mode);
}
async function brainstorm(agentName, question, generationCount, returnCount, reviewCriteria = null) {
  return getAgentLibrary().brainstormQuestion(agentName, question, generationCount, returnCount, reviewCriteria);
}
function cancelTasks() {
  getAgentLibrary().cancelTasks();
}
function listAgents2() {
  return listAgents();
}
function resetForTests() {
  resetOperatorRegistry();
  resetAgentRegistryForTests();
  resetModelCatalogForTests();
  agentLibraryInstance = null;
}
var Agent = class {
  constructor(options = {}) {
    const providedRegistry = options?.skillRegistry;
    if (providedRegistry && typeof providedRegistry.registerSkill === "function" && typeof providedRegistry.rankSkill === "function") {
      this.skillRegistry = providedRegistry;
    } else {
      this.skillRegistry = new SkillRegistry(options?.skillRegistryOptions);
    }
  }
  async readUserPrompt(query) {
    const rl = import_node_readline.default.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(query, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
  registerSkill(skillObj) {
    return this.skillRegistry.registerSkill(skillObj);
  }
  async rankSkill(taskDescription, options = {}) {
    const providedRole = typeof options.role === "string" && options.role.trim() ? options.role.trim() : typeof options.callerRole === "string" && options.callerRole.trim() ? options.callerRole.trim() : "";
    if (!providedRole) {
      throw new Error("Agent rankSkill requires a role for access control.");
    }
    const verboseMode = options.verbose === true;
    const startTime = options.startTime || Date.now();
    const progressiveDelay = process.env.LLMAgentClient_VERBOSE_DELAY ? parseInt(process.env.LLMAgentClient_VERBOSE_DELAY, 10) : 150;
    const useProgressiveDisplay = verboseMode && progressiveDelay > 0;
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const flexSearchStart = Date.now();
    const registryOptions = { ...options, role: providedRole };
    const matches = this.skillRegistry.rankSkill(taskDescription, registryOptions);
    if (!Array.isArray(matches) || matches.length === 0) {
      if (verboseMode) {
        const flexSearchTime = Date.now() - flexSearchStart;
        console.log(`[FlexSearch] No matches found (${flexSearchTime}ms)`);
      }
      throw new Error("No skills matched the provided task description.");
    }
    if (verboseMode) {
      const flexSearchTime = Date.now() - flexSearchStart;
      console.log(`
[FlexSearch] Found ${matches.length} candidate${matches.length > 1 ? "s" : ""} (${flexSearchTime}ms):
`);
      if (useProgressiveDisplay) {
        for (let index = 0; index < matches.length; index++) {
          const name = matches[index];
          const skill = this.getSkill(name);
          const desc = skill?.description || skill?.what || "No description";
          const truncated = desc.length > 70 ? desc.slice(0, 67) + "..." : desc;
          console.log(`  ${name}`);
          console.log(`  ${truncated}
`);
          if (index < matches.length - 1) {
            await delay(progressiveDelay);
          }
        }
      } else {
        matches.forEach((name, index) => {
          const skill = this.getSkill(name);
          const desc = skill?.description || skill?.what || "No description";
          const truncated = desc.length > 70 ? desc.slice(0, 67) + "..." : desc;
          console.log(`  ${name}`);
          console.log(`  ${truncated}
`);
        });
      }
    }
    if (matches.length === 1) {
      if (verboseMode) {
        console.log(`[Result] Single match found, using: ${matches[0]}`);
      }
      return matches[0];
    }
    const normalizeName = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";
    const candidates = matches.map((name) => {
      const skill = this.getSkill(name);
      if (!skill) {
        return null;
      }
      const canonical = normalizeName(skill.name || name);
      return {
        canonical,
        name: skill.name || name,
        spec: skill
      };
    }).filter(Boolean);
    if (!candidates.length) {
      throw new Error("Unable to load candidate skill specifications for selection.");
    }
    if (verboseMode) {
      console.log(`
[LLM] Analyzing context to select best match...`);
      console.log(`[LLM] Evaluating ${candidates.length} candidates`);
    }
    let selectorAgent;
    try {
      selectorAgent = getAgent(options?.agentName);
    } catch (error) {
      throw new Error(`Unable to obtain language model for skill selection: ${error.message}`);
    }
    const selectionMode = normalizeTaskMode(options?.mode || "fast", null, selectorAgent, "fast");
    const candidateSummaries = candidates.map((entry) => ({
      name: entry.name,
      description: entry.spec.description,
      what: entry.spec.what,
      why: entry.spec.why,
      arguments: entry.spec.arguments,
      requiredArguments: entry.spec.requiredArguments,
      roles: entry.spec.roles
    }));
    const contextPayload = {
      taskDescription,
      candidates: candidateSummaries
    };
    const history = buildSystemHistory(selectorAgent, {
      instruction: "Review the candidate skills and choose the single best match for the task.",
      context: JSON.stringify(contextPayload, null, 2),
      description: 'Return JSON like {"skill": "<skill name>"}. If no skills are suitable, return {"skill": null}.',
      mode: selectionMode
    });
    const llmStart = Date.now();
    const raw = await invokeAgent(selectorAgent, history, { mode: selectionMode });
    if (verboseMode) {
      const llmTime = Date.now() - llmStart;
      console.log(`[LLM] Selection completed (${llmTime}ms)`);
    }
    const candidateMap = /* @__PURE__ */ new Map();
    for (const candidate of candidates) {
      candidateMap.set(candidate.canonical, candidate.name);
    }
    const parseSelection = (value) => {
      const parsed = safeJsonParse(typeof value === "string" ? value : "");
      if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "skill")) {
        return parsed.skill;
      }
      return null;
    };
    let selected = parseSelection(raw);
    if (selected === null || selected === void 0) {
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        const normalized = normalizeName(trimmed);
        if (candidateMap.has(normalized)) {
          selected = candidateMap.get(normalized);
        }
      }
    }
    if (selected === null || normalizeName(selected) === "none" || normalizeName(selected) === "no skill") {
      throw new Error("No suitable skill was selected for the task description.");
    }
    if (typeof selected !== "string" || !selected.trim()) {
      throw new Error("Skill selection response was invalid.");
    }
    const normalizedSelected = normalizeName(selected);
    if (!candidateMap.has(normalizedSelected)) {
      throw new Error(`Selected skill "${selected}" was not among the matched candidates.`);
    }
    const finalSkill = candidateMap.get(normalizedSelected);
    if (verboseMode) {
      console.log(`[Result] LLM selected: ${finalSkill}`);
    }
    return finalSkill;
  }
  async useSkill(skillName, providedArgs = {}, options = {}) {
    const taskDescription = typeof options.taskDescription === "string" ? options.taskDescription : "";
    const skipConfirmation = options.skipConfirmation === true;
    return executeSkill({
      skillName,
      providedArgs,
      getSkill: this.getSkill.bind(this),
      getSkillAction: this.getSkillAction.bind(this),
      readUserPrompt: this.readUserPrompt.bind(this),
      taskDescription,
      skipConfirmation
    });
  }
  listSkillsForRole(role) {
    return this.skillRegistry.listSkillsForRole(role);
  }
  getSkill(skillName) {
    return this.skillRegistry.getSkill(skillName);
  }
  getSkillAction(skillName) {
    return this.skillRegistry.getSkillAction(skillName);
  }
  clearSkills() {
    this.skillRegistry.clear();
  }
  registerLLMAgent(options = {}) {
    const {
      name,
      role = "",
      job = "",
      expertise = "",
      instructions = "",
      fastModels = [],
      deepModels = [],
      kind = "task",
      modelOrder = [],
      origin = "registerLLMAgent"
    } = options;
    if (!name || typeof name !== "string") {
      throw new Error('registerLLMAgent requires a non-empty "name".');
    }
    let normalizedFast = normalizeModelNameList(fastModels);
    let normalizedDeep = normalizeModelNameList(deepModels);
    if (!normalizedFast.length && !normalizedDeep.length) {
      const fallbackNames = getOrderedModelNames();
      const categorized = categorizeModelsByMode(fallbackNames);
      normalizedFast = categorized.fast;
      normalizedDeep = categorized.deep;
    }
    const explicitOrder = normalizeModelNameList(modelOrder);
    const combinedOrder = [];
    const seen = /* @__PURE__ */ new Set();
    const pushInOrder = (list) => {
      for (const value of list) {
        if (!seen.has(value)) {
          seen.add(value);
          combinedOrder.push(value);
        }
      }
    };
    if (explicitOrder.length) {
      pushInOrder(explicitOrder);
    }
    pushInOrder(normalizedFast);
    pushInOrder(normalizedDeep);
    const configuredRecords = [];
    for (const modelName of combinedOrder) {
      const record = buildModelRecordByName(modelName);
      if (record) {
        configuredRecords.push(record);
      }
    }
    return commitAgentRecord({
      name,
      role,
      job,
      expertise,
      instructions,
      kind,
      configuredRecords,
      fastModelNames: normalizedFast,
      deepModelNames: normalizedDeep,
      origin
    });
  }
  registerDefaultLLMAgent(options = {}) {
    registerDefaultLLMAgent(options);
  }
  async doTask(agentName, context, description, outputSchema = null, mode = "fast", retries = 3) {
    const agent = getAgent(agentName);
    const normalizedMode = normalizeTaskMode(mode, outputSchema, agent);
    let attempt = 0;
    let lastError = null;
    while (attempt < Math.max(retries, 1)) {
      try {
        if (normalizedMode === "deep") {
          return await executeDeepTask(agent, context, description, outputSchema);
        }
        return await executeFastTask(agent, context, description, outputSchema);
      } catch (error) {
        lastError = error;
        attempt += 1;
      }
    }
    throw new Error(`Task failed after ${retries} retries: ${lastError?.message || "unknown error"}`);
  }
  async doTaskWithReview(agentName, context, description, outputSchema = null, mode = "deep", maxIterations = 5) {
    const agent = getAgent(agentName);
    const normalizedMode = normalizeTaskMode(mode, outputSchema, agent, "deep");
    const plan = normalizedMode === "deep" ? await generatePlan(agent, context, description) : null;
    let iteration = 0;
    let feedback = "";
    while (iteration < Math.max(maxIterations, 1)) {
      iteration += 1;
      const candidate = await executeIteration(agent, context, description, outputSchema, iteration, feedback, plan, normalizedMode);
      const review = await reviewCandidate(agent, context, description, candidate.raw, outputSchema, iteration, normalizedMode);
      if (review.approved) {
        return candidate.parsed ?? { result: candidate.raw };
      }
      feedback = review.feedback || "Improve and correct the prior answer.";
    }
    throw new Error("Maximum review iterations exceeded without an approved result.");
  }
  async doTaskWithHumanReview(agentName, context, description, outputSchema = null, mode = "deep") {
    const agent = getAgent(agentName);
    const normalizedMode = normalizeTaskMode(mode, outputSchema, agent, "deep");
    const plan = normalizedMode === "deep" ? await generatePlan(agent, context, description) : null;
    let feedback = "";
    let iteration = 0;
    while (true) {
      iteration += 1;
      const candidate = await executeIteration(agent, context, description, outputSchema, iteration, feedback || "", plan, normalizedMode);
      const finalResult = candidate.parsed ?? { result: candidate.raw };
      console.log("----- Agent Result -----");
      console.log(typeof candidate.raw === "string" ? candidate.raw : JSON.stringify(candidate.raw, null, 2));
      const approval = await this.readUserPrompt("Is the result okay? [Y/n/cancel]: ");
      const normalized = (approval || "").trim().toLowerCase();
      if (normalized === "" || normalized === "y" || normalized === "yes") {
        return finalResult;
      }
      if (normalized === "cancel") {
        throw new Error("Task cancelled by user.");
      }
      feedback = await this.readUserPrompt("Please provide feedback for the agent: ");
    }
  }
  cancelTasks() {
    cancelRequests();
  }
  async brainstormQuestion(agentName, question, generationCount, returnCount, reviewCriteria = null) {
    return brainstormQuestion(agentName, question, generationCount, returnCount, reviewCriteria);
  }
};
function getAgentLibrary() {
  if (!agentLibraryInstance) {
    agentLibraryInstance = new Agent();
  }
  return agentLibraryInstance;
}
var __resetForTests = resetForTests;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Agent,
  __resetForTests,
  brainstorm,
  callOperator,
  cancelTasks,
  chooseOperator,
  doTask,
  doTaskWithHumanReview,
  doTaskWithReview,
  listAgents,
  registerDefaultLLMAgent,
  registerLLMAgent,
  registerOperator
});
//# sourceMappingURL=index.js.map
