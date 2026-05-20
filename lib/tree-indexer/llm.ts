type ChatMessage = {
  content: string;
  role: "user";
};

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | Array<{ text?: string; type?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
  service_tier?: string;
};

export class TreeLlmMissingConfigError extends Error {
  constructor() {
    super("Falta configurar SDA_TREE_LLM_API_KEY y SDA_TREE_LLM_MODEL para construir el arbol.");
    this.name = "TreeLlmMissingConfigError";
  }
}

export class TreeLlmJsonParseError extends Error {
  readonly rawContent: string;

  constructor(message: string, rawContent: string) {
    super(message);
    this.name = "TreeLlmJsonParseError";
    this.rawContent = rawContent;
  }
}

type TreeLlmPurpose = "structure" | "summary";

type TreeLlmConfig = {
  allowFallbacks: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
  providerOrder: string[];
  reasoningEffort?: string;
  reasoningExclude: boolean;
  serviceTier?: string;
  timeoutMs: number;
};

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function csvEnv(name: string) {
  return (process.env[name] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function boolEnv(name: string, fallback: boolean) {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function inferProvider() {
  if (process.env.SDA_TREE_LLM_PROVIDER) {
    return process.env.SDA_TREE_LLM_PROVIDER;
  }

  if (process.env.OPENROUTER_API_KEY) {
    return "openrouter";
  }

  return "openai";
}

function inferBaseUrl(provider: string) {
  if (process.env.SDA_TREE_LLM_BASE_URL) {
    return process.env.SDA_TREE_LLM_BASE_URL.replace(/\/$/, "");
  }

  if (provider === "openrouter") {
    return "https://openrouter.ai/api/v1";
  }

  return "https://api.openai.com/v1";
}

function getApiKey(provider: string) {
  return (
    process.env.SDA_TREE_LLM_API_KEY ??
    (provider === "openrouter" ? process.env.OPENROUTER_API_KEY : undefined) ??
    process.env.OPENAI_API_KEY
  );
}

export function isTreeLlmConfigured() {
  const provider = inferProvider();

  return Boolean(getApiKey(provider) && process.env.SDA_TREE_LLM_MODEL);
}

function getTreeLlmConfig(purpose: TreeLlmPurpose): TreeLlmConfig {
  const provider = inferProvider();
  const apiKey = getApiKey(provider);
  const model =
    purpose === "summary"
      ? process.env.SDA_TREE_SUMMARY_MODEL ?? process.env.SDA_TREE_LLM_MODEL
      : process.env.SDA_TREE_LLM_MODEL;

  if (!apiKey || !model) {
    throw new TreeLlmMissingConfigError();
  }

  return {
    allowFallbacks: boolEnv("SDA_TREE_LLM_ALLOW_FALLBACKS", true),
    apiKey,
    baseUrl: inferBaseUrl(provider),
    model,
    provider,
    providerOrder: csvEnv("SDA_TREE_LLM_PROVIDER_ORDER"),
    reasoningEffort: process.env.SDA_TREE_LLM_REASONING_EFFORT,
    reasoningExclude: boolEnv("SDA_TREE_LLM_REASONING_EXCLUDE", true),
    serviceTier: process.env.SDA_TREE_LLM_SERVICE_TIER,
    timeoutMs: positiveNumber(process.env.SDA_TREE_LLM_TIMEOUT_MS, 120_000)
  };
}

function contentFromResponse(response: ChatCompletionResponse) {
  const content = response.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part) => part.text ?? "").join("");
  }

  return "";
}

function stripJsonFences(content: string) {
  const trimmed = content.trim();

  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

export function extractJson<T>(content: string): T {
  const withoutFences = stripJsonFences(content);

  try {
    return JSON.parse(withoutFences) as T;
  } catch {
    const objectStart = withoutFences.indexOf("{");
    const arrayStart = withoutFences.indexOf("[");
    const starts = [objectStart, arrayStart].filter((index) => index >= 0);
    const start = starts.length > 0 ? Math.min(...starts) : -1;
    const end = Math.max(withoutFences.lastIndexOf("}"), withoutFences.lastIndexOf("]"));

    if (start >= 0 && end > start) {
      try {
        return JSON.parse(withoutFences.slice(start, end + 1)) as T;
      } catch {
        throw new TreeLlmJsonParseError("El LLM devolvio JSON invalido.", content);
      }
    }

    throw new TreeLlmJsonParseError("El LLM no devolvio JSON parseable.", content);
  }
}

async function callChatCompletion(
  prompt: string,
  purpose: TreeLlmPurpose,
  expectJson: boolean
) {
  const config = getTreeLlmConfig(purpose);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const messages: ChatMessage[] = [{ content: prompt, role: "user" }];
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json"
  };

  if (config.provider === "openrouter") {
    headers["HTTP-Referer"] = process.env.APP_ORIGIN ?? "https://sda-framework.vercel.app";
    headers["X-Title"] = "SDA Framework";
  }

  try {
    const payload: Record<string, unknown> = {
      messages,
      model: config.model,
      temperature: 0,
      ...(expectJson && process.env.SDA_TREE_LLM_JSON_MODE === "1"
        ? { response_format: { type: "json_object" } }
        : {})
    };

    if (config.provider === "openrouter") {
      if (config.providerOrder.length > 0) {
        payload.provider = {
          allow_fallbacks: config.allowFallbacks,
          order: config.providerOrder
        };
      }

      if (config.serviceTier) {
        payload.service_tier = config.serviceTier;
      }

      if (config.reasoningEffort) {
        payload.reasoning = {
          effort: config.reasoningEffort,
          exclude: config.reasoningExclude
        };
      }
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      body: JSON.stringify(payload),
      headers,
      method: "POST",
      signal: controller.signal
    });

    const raw = (await response.json()) as ChatCompletionResponse;

    if (!response.ok) {
      throw new Error(raw.error?.message ?? `Tree LLM fallo con HTTP ${response.status}.`);
    }

    const content = contentFromResponse(raw);

    if (!content) {
      throw new Error("Tree LLM devolvio una respuesta vacia.");
    }

    return {
      content,
      finishReason: raw.choices?.[0]?.finish_reason ?? null,
      model: config.model,
      provider: config.provider,
      providerOrder: config.providerOrder,
      serviceTier: raw.service_tier ?? config.serviceTier
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function callTreeLlmJson<T>(prompt: string, purpose: TreeLlmPurpose) {
  const response = await callChatCompletion(prompt, purpose, true);

  return {
    ...response,
    json: extractJson<T>(response.content)
  };
}

export async function callTreeLlmText(prompt: string, purpose: TreeLlmPurpose) {
  return callChatCompletion(prompt, purpose, false);
}
