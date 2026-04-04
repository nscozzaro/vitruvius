/**
 * LLM provider abstraction with fallback chain:
 *   1. Nvidia NIM (free, OpenAI-compatible) — for text-only tasks
 *   2. Google Gemini — for vision tasks or as fallback
 *
 * Nvidia NIM uses llama-3.3-nemotron-super-49b-v1
 * Gemini uses gemini-3-flash-preview
 */

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Call the best available text LLM (Nvidia first, Gemini fallback).
 */
export async function callLLM(
  messages: LLMMessage[],
  options?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const geminiKey =
    process.env.GOOGLE_GEMINI_API_KEY ||
    process.env.GOOGLE_STREET_VIEW_API_KEY;

  // Try Nvidia NIM first (free)
  if (nvidiaKey) {
    try {
      return await callNvidia(nvidiaKey, messages, options);
    } catch (err) {
      console.warn("Nvidia NIM failed:", err instanceof Error ? err.message : err);
    }
  }

  // Fallback to Gemini
  if (geminiKey) {
    return await callGemini(geminiKey, messages, options);
  }

  throw new Error("No LLM API key configured (set NVIDIA_API_KEY or GOOGLE_GEMINI_API_KEY)");
}

async function callNvidia(
  apiKey: string,
  messages: LLMMessage[],
  options?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const resp = await fetch(NVIDIA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages,
      max_tokens: options?.maxTokens || 1024,
      temperature: options?.temperature || 0.7,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Nvidia ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callGemini(
  apiKey: string,
  messages: LLMMessage[],
  options?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);

  // Separate system message from chat messages
  const systemMsg = messages.find((m) => m.role === "system");
  const chatMsgs = messages.filter((m) => m.role !== "system");

  const model = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    systemInstruction: systemMsg?.content || "",
    generationConfig: {
      maxOutputTokens: options?.maxTokens || 1024,
      temperature: options?.temperature || 0.7,
    },
  });

  const geminiMsgs = chatMsgs.map((m) => ({
    role: m.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: m.content }],
  }));

  // Gemini requires first message to be "user"
  const firstUser = geminiMsgs.findIndex((m) => m.role === "user");
  const trimmed = firstUser >= 0 ? geminiMsgs.slice(firstUser) : geminiMsgs;

  if (trimmed.length === 0) {
    throw new Error("No user messages to send");
  }

  const history = trimmed.slice(0, -1);
  const last = trimmed[trimmed.length - 1];

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(last.parts[0].text);
  return result.response.text();
}
