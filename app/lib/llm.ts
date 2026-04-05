/**
 * LLM abstraction — Nvidia NIM (OpenAI-compatible API).
 *
 * callLLM        – text-only chat completion
 * callVisionLLM  – chat completion with an inline image
 */

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = "meta/llama-4-maverick-17b-128e-instruct";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function callLLM(
  messages: LLMMessage[],
  options?: { maxTokens?: number; temperature?: number },
): Promise<string> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY not configured");

  const resp = await fetch(NVIDIA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages,
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Nvidia LLM ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

export async function callVisionLLM(
  systemPrompt: string,
  imageBase64: string,
  imageMimeType: string,
  userPrompt: string,
  options?: { maxTokens?: number; temperature?: number },
): Promise<string> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY not configured");

  const dataUrl = `data:${imageMimeType};base64,${imageBase64}`;

  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: userPrompt },
      ],
    },
  ];

  const resp = await fetch(NVIDIA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages,
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Nvidia vision ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}
