/**
 * NVIDIA NIM client for Llama 4 Maverick.
 *
 * Thin fetch() wrapper around the OpenAI-compatible chat completions API.
 * Supports vision (image+text) messages for tract map analysis.
 */

const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NIM_MODEL =
  process.env.NVIDIA_NIM_MODEL || "meta/llama-4-maverick-17b-128e-instruct";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<TextContent | ImageContent>;
}

interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image_url";
  image_url: { url: string };
}

interface NimResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function getApiKey(): string {
  const key = process.env.NVIDIA_NIM_API_KEY;
  if (!key) throw new Error("NVIDIA_NIM_API_KEY not set");
  return key;
}

/**
 * Send a chat completion request to Llama 4 Maverick via NVIDIA NIM.
 */
export async function nimChat(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const { maxTokens = 4096, temperature = 0.2 } = opts;

  const res = await fetch(`${NIM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: NIM_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NIM API error ${res.status}: ${body}`);
  }

  const data: NimResponse = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("NIM returned empty response");

  console.log(
    `[nim] tokens: ${data.usage?.prompt_tokens ?? "?"}in/${data.usage?.completion_tokens ?? "?"}out`,
  );
  return content;
}

/**
 * Send a vision request — image + text prompt.
 * Accepts a base64 JPEG/PNG and a text prompt.
 */
export async function nimVision(
  imageBase64: string,
  prompt: string,
  opts: {
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    mimeType?: string;
  } = {},
): Promise<string> {
  const { systemPrompt, maxTokens = 4096, temperature = 0.2, mimeType = "image/jpeg" } = opts;

  const messages: ChatMessage[] = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  messages.push({
    role: "user",
    content: [
      {
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${imageBase64}` },
      },
      { type: "text", text: prompt },
    ],
  });

  return nimChat(messages, { maxTokens, temperature });
}

/**
 * Send a vision request with multiple images.
 */
export async function nimVisionMulti(
  images: Array<{ base64: string; mimeType?: string }>,
  prompt: string,
  opts: {
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
  } = {},
): Promise<string> {
  const { systemPrompt, maxTokens = 4096, temperature = 0.2 } = opts;

  const messages: ChatMessage[] = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  const content: Array<TextContent | ImageContent> = images.map((img) => ({
    type: "image_url" as const,
    image_url: {
      url: `data:${img.mimeType ?? "image/jpeg"};base64,${img.base64}`,
    },
  }));
  content.push({ type: "text", text: prompt });

  messages.push({ role: "user", content });

  return nimChat(messages, { maxTokens, temperature });
}

/**
 * Parse JSON from LLM response, stripping markdown fences if present.
 * Handles truncated responses where the closing ``` may be missing.
 */
export function parseJsonResponse<T>(response: string): T {
  let cleaned = response.trim();

  // Strip ```json ... ``` fences (greedy — handles truncated responses)
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)(?:\n?\s*```|$)/);
  if (fenceMatch && fenceMatch[1].trim().startsWith("{") || fenceMatch && fenceMatch[1].trim().startsWith("[")) {
    cleaned = fenceMatch[1].trim();
  }

  // If response starts with non-JSON text, try to find the JSON object/array
  if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) {
    const jsonStart = cleaned.search(/[\[{]/);
    if (jsonStart >= 0) {
      cleaned = cleaned.slice(jsonStart);
    }
  }

  // Pre-process: escape unescaped double quotes inside string values.
  // Bearing strings like N 75°22'10" W have unescaped " that break JSON.
  // Also handles delta angles like 7°33'15"
  // Strategy: replace DMS seconds mark " with escaped \" when preceded by digits
  cleaned = cleaned.replace(
    /(\d+)[''′](\d+(?:\.\d+)?)[""″](\s*[NSEW\\\},])/g,
    "$1'$2\\\"$3",
  );
  // Also handle standalone DMS angles (delta fields): 7°33'15"
  cleaned = cleaned.replace(
    /(\d+)°(\d+)[''′](\d+(?:\.\d+)?)[""″]/g,
    '$1°$2\'$3\\"',
  );

  // Try parsing with progressively more aggressive repair
  const attempts = [cleaned];

  // Repair attempt: fix missing closing brackets/braces
  {
    let repaired = cleaned;
    const opens = (repaired.match(/\{/g) || []).length;
    const closes = (repaired.match(/\}/g) || []).length;
    for (let i = 0; i < opens - closes; i++) repaired += "}";
    const openBrackets = (repaired.match(/\[/g) || []).length;
    const closeBrackets = (repaired.match(/\]/g) || []).length;
    for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += "]";
    repaired = repaired.replace(/,\s*([}\]])/g, "$1");
    if (repaired !== cleaned) attempts.push(repaired);
  }

  // Repair attempt: strip trailing partial key-value pairs
  {
    const lastGood = cleaned.lastIndexOf('",');
    if (lastGood > 0) {
      const truncated = cleaned.slice(0, lastGood + 1);
      const opens = (truncated.match(/\{/g) || []).length;
      const closes = (truncated.match(/\}/g) || []).length;
      let repaired = truncated;
      for (let i = 0; i < opens - closes; i++) repaired += "}";
      const ob = (repaired.match(/\[/g) || []).length;
      const cb = (repaired.match(/\]/g) || []).length;
      for (let i = 0; i < ob - cb; i++) repaired += "]";
      attempts.push(repaired);
    }
  }

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch { /* try next */ }
  }

  throw new Error(`Cannot parse JSON from LLM response: ${cleaned.slice(0, 200)}`);
}
