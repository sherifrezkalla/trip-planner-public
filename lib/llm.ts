import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";

export type LlmCaller = (prompt: string) => Promise<string>;
export type Callers = { primary: LlmCaller; fallback: LlmCaller };

/** Enough for a single swap or a short plan; long plans pass their own. */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

function makeCaller(model: LanguageModel, timeoutMs: number): LlmCaller {
  return async (prompt: string) => {
    const { text } = await generateText({
      model,
      prompt,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    return text;
  };
}

export function getCallers(timeoutMs: number = DEFAULT_LLM_TIMEOUT_MS): Callers {
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const fallbackModel = anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5");

  const ollama = createOpenAICompatible({
    name: "ollama",
    baseURL: process.env.OLLAMA_BASE_URL ?? "https://ollama.com/v1",
    apiKey: process.env.OLLAMA_API_KEY,
  });
  const primaryModel =
    process.env.LLM_PROVIDER === "anthropic"
      ? fallbackModel
      : ollama(process.env.OLLAMA_MODEL ?? "glm-5.2:cloud");

  return { primary: makeCaller(primaryModel, timeoutMs), fallback: makeCaller(fallbackModel, timeoutMs) };
}

export async function callWithFallback(
  prompt: string,
  callers: Callers,
): Promise<{ text: string; usedFallback: boolean }> {
  try {
    return { text: await callers.primary(prompt), usedFallback: false };
  } catch {
    return { text: await callers.fallback(prompt), usedFallback: true };
  }
}

export const DEFAULT_CONCIERGE_TIMEOUT_MS = 60_000;

/** The trip concierge intentionally stays on the Ollama model requested for it. */
export async function askConcierge(args: {
  instructions: string;
  messages: ModelMessage[];
  timeoutMs?: number;
}): Promise<string> {
  const ollama = createOpenAICompatible({
    name: "ollama",
    baseURL: process.env.OLLAMA_BASE_URL ?? "https://ollama.com/v1",
    apiKey: process.env.OLLAMA_API_KEY,
  });
  const { text } = await generateText({
    model: ollama(process.env.OLLAMA_CHAT_MODEL ?? "deepseek-v4-flash:cloud"),
    instructions: args.instructions,
    messages: args.messages,
    maxOutputTokens: 700,
    abortSignal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_CONCIERGE_TIMEOUT_MS),
  });
  return text;
}
