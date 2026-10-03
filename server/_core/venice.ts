import { ENV } from "./env";

export type VeniceRole = "system" | "user" | "assistant";

export type VeniceMessage = {
  role: VeniceRole;
  content: string;
};

export type VeniceChatParams = {
  messages: VeniceMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export type VeniceUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type VeniceChatResult = {
  id: string;
  model: string;
  content: string;
  finishReason: string | null;
  usage?: VeniceUsage;
};

type VeniceChatResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: VeniceUsage;
  error?: { message?: string };
};

const RETRY_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 15_000;

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

// Equal-jitter exponential backoff. Inference gateways throttle with 429s, so
// this retries those in addition to 5xx; the cap/2 floor keeps a tight retry
// loop from hammering the upstream while it is still shedding load.
const computeBackoffDelay = (attempt: number): number => {
  const cap = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  return cap / 2 + Math.random() * (cap / 2);
};

const resolveBaseUrl = () => ENV.veniceApiBaseUrl.replace(/\/+$/, "");

const resolveApiKey = () => {
  const key = ENV.veniceApiKey.trim();
  if (!key) {
    throw new Error("VENICE_API_KEY is not configured");
  }
  return key;
};

const isRetryableStatus = (status: number) =>
  status === 408 || status === 429 || status >= 500;

const chatCompletionsUrl = () => `${resolveBaseUrl()}/chat/completions`;

const fetchWithBackoff = async (
  url: string,
  init: RequestInit
): Promise<Response> => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok || !isRetryableStatus(response.status)) {
        return response;
      }

      if (attempt === RETRY_MAX_RETRIES) {
        return response;
      }

      try {
        await response.body?.cancel();
      } catch {
        // Body already settled; nothing to clean up.
      }

      console.warn(
        `Venice request retry ${attempt + 1}/${RETRY_MAX_RETRIES} after status ${response.status}`
      );
      await sleep(computeBackoffDelay(attempt));
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_MAX_RETRIES) throw error;
      console.warn(
        `Venice request retry ${attempt + 1}/${RETRY_MAX_RETRIES} after network error`
      );
      await sleep(computeBackoffDelay(attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Venice request failed after exhausting retries");
};

export async function chatCompletion(
  params: VeniceChatParams
): Promise<VeniceChatResult> {
  const apiKey = resolveApiKey();

  const { messages, model, maxTokens, temperature } = params;

  const payload: Record<string, unknown> = {
    model: model ?? ENV.veniceModel,
    messages,
  };

  if (typeof maxTokens === "number") {
    payload.max_tokens = maxTokens;
  }

  if (typeof temperature === "number") {
    payload.temperature = temperature;
  }

  const response = await fetchWithBackoff(chatCompletionsUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Venice chat completion failed: ${response.status} ${response.statusText} – ${text}`
    );
  }

  let data: VeniceChatResponse;
  try {
    data = JSON.parse(text) as VeniceChatResponse;
  } catch {
    throw new Error("Venice chat completion returned a non-JSON response");
  }

  // Venice answers 200 for some upstream failures, surfacing the reason in an
  // `error` field rather than an HTTP status, so this cannot be a status check.
  if (data.error?.message) {
    throw new Error(`Venice chat completion failed: ${data.error.message}`);
  }

  const choice = data.choices?.[0];
  const content = choice?.message?.content;

  if (typeof content !== "string") {
    throw new Error("Venice chat completion returned no message content");
  }

  return {
    id: data.id ?? "",
    model: data.model ?? (model ?? ENV.veniceModel),
    content,
    finishReason: choice?.finish_reason ?? null,
    usage: data.usage,
  };
}

export type VeniceModelInfo = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

export type VeniceModelsResponse = {
  object: string;
  data: VeniceModelInfo[];
};

export async function listVeniceModels(): Promise<VeniceModelsResponse> {
  const apiKey = resolveApiKey();

  const response = await fetchWithBackoff(`${resolveBaseUrl()}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `List Venice models failed: ${response.status} ${response.statusText} – ${text}`
    );
  }

  return JSON.parse(text) as VeniceModelsResponse;
}
