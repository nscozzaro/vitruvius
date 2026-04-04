/**
 * LLM provider abstraction with fallback chain:
 *   1. Nvidia NIM (free, OpenAI-compatible)
 *      - Text: llama-3.3-nemotron-super-49b-v1
 *      - Vision: meta/llama-3.2-90b-vision-instruct
 *   2. Google Gemini (paid, fallback)
 *      - gemini-3-flash-preview (text + vision)
 */

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_TEXT_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1";
const NVIDIA_VISION_MODEL = "meta/llama-3.2-90b-vision-instruct";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface VisionMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
}

// ── Text-only LLM call ──────────────────────────────────────────────
export async function callLLM(
  messages: LLMMessage[],
  options?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const geminiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_STREET_VIEW_API_KEY;

  if (nvidiaKey) {
    try {
      return await callNvidiaText(nvidiaKey, messages, options);
    } catch (err) {
      console.warn("Nvidia text failed:", err instanceof Error ? err.message : err);
    }
  }

  if (geminiKey) {
    return await callGeminiText(geminiKey, messages, options);
  }

  throw new Error("No LLM API key configured");
}

// ── Vision LLM call (with images) ───────────────────────────────────
export async function callVisionLLM(
  systemPrompt: string,
  imageBase64: string,
  imageMimeType: string,
  userPrompt: string,
  options?: { maxTokens?: number }
): Promise<string> {
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const geminiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_STREET_VIEW_API_KEY;

  if (nvidiaKey) {
    try {
      return await callNvidiaVision(nvidiaKey, systemPrompt, imageBase64, imageMimeType, userPrompt, options);
    } catch (err) {
      console.warn("Nvidia vision failed:", err instanceof Error ? err.message : err);
    }
  }

  if (geminiKey) {
    return await callGeminiVision(geminiKey, systemPrompt, imageBase64, imageMimeType, userPrompt, options);
  }

  throw new Error("No vision LLM API key configured");
}

// ── Nvidia NIM Text ─────────────────────────────────────────────────
async function callNvidiaText(
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
      model: NVIDIA_TEXT_MODEL,
      messages,
      max_tokens: options?.maxTokens || 1024,
      temperature: options?.temperature || 0.7,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Nvidia text ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

// ── Nvidia NIM Vision ───────────────────────────────────────────────
async function callNvidiaVision(
  apiKey: string,
  systemPrompt: string,
  imageBase64: string,
  imageMimeType: string,
  userPrompt: string,
  options?: { maxTokens?: number }
): Promise<string> {
  const dataUrl = `data:${imageMimeType};base64,${imageBase64}`;

  const messages: VisionMessage[] = [
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
      model: NVIDIA_VISION_MODEL,
      messages,
      max_tokens: options?.maxTokens || 1024,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Nvidia vision ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

// ── Gemini Text ─────────────────────────────────────────────────────
async function callGeminiText(
  apiKey: string,
  messages: LLMMessage[],
  options?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);

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

  const firstUser = geminiMsgs.findIndex((m) => m.role === "user");
  const trimmed = firstUser >= 0 ? geminiMsgs.slice(firstUser) : geminiMsgs;
  if (trimmed.length === 0) throw new Error("No user messages");

  const history = trimmed.slice(0, -1);
  const last = trimmed[trimmed.length - 1];
  const chat = model.startChat({ history });
  const result = await chat.sendMessage(last.parts[0].text);
  return result.response.text();
}

// ── Gemini Vision ───────────────────────────────────────────────────
async function callGeminiVision(
  apiKey: string,
  systemPrompt: string,
  imageBase64: string,
  imageMimeType: string,
  userPrompt: string,
  options?: { maxTokens?: number }
): Promise<string> {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);

  const model = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    systemInstruction: systemPrompt,
    generationConfig: { maxOutputTokens: options?.maxTokens || 1024 },
  });

  const result = await model.generateContent([
    { inlineData: { data: imageBase64, mimeType: imageMimeType } },
    { text: userPrompt },
  ]);

  return result.response.text();
}
