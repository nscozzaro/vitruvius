import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const SYSTEM_PROMPT = `You are Vitruvius AI, an expert architectural design assistant. You help users understand property data, design buildings, and generate BIM models.

You have access to collected property data including building footprints, assessor records, elevation data, and imagery. Use this data to provide informed architectural advice.

When discussing design:
- Reference the actual property dimensions and data provided
- Suggest practical, code-compliant designs
- Consider the existing building characteristics
- Be specific about materials, dimensions, and structural elements

Keep responses concise and actionable. Use markdown formatting when helpful.`;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messages, propertyData } = body as {
      messages: ChatMessage[];
      propertyData: Record<string, unknown>;
    };

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "Missing messages" }, { status: 400 });
    }

    const apiKey =
      process.env.GOOGLE_GEMINI_API_KEY ||
      process.env.GOOGLE_STREET_VIEW_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "No Google API key configured" },
        { status: 500 }
      );
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    // Build context from property data
    const dataContext = propertyData
      ? `\n\nCollected property data:\n${JSON.stringify(propertyData, null, 2)}`
      : "";

    const model = genAI.getGenerativeModel({
      model: "gemini-3-flash-preview",
      systemInstruction: SYSTEM_PROMPT + dataContext,
    });

    // Convert messages to Gemini format, ensuring history starts with "user"
    const allGemini = messages.map((m) => ({
      role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: m.content }],
    }));

    // Gemini requires first message to be "user" — skip leading model messages
    const firstUserIdx = allGemini.findIndex((m) => m.role === "user");
    const trimmed =
      firstUserIdx >= 0 ? allGemini.slice(firstUserIdx) : allGemini;

    const geminiHistory = trimmed.slice(0, -1);
    const lastMessage = trimmed[trimmed.length - 1];

    const chat = model.startChat({
      history: geminiHistory,
    });

    const result = await chat.sendMessage(lastMessage.parts[0].text);
    const content = result.response.text();

    return NextResponse.json({ content });
  } catch (error) {
    console.error("Chat API Error:", error);
    const errMsg = error instanceof Error ? error.message : "Chat request failed";

    // Provide helpful message for common Gemini errors
    if (errMsg.includes("429") || errMsg.includes("quota")) {
      return NextResponse.json({
        content:
          "⚠️ The Gemini API free tier quota has been reached. This usually resets within a few minutes. Please try again shortly.\n\nIf this persists, the API key may need the free tier activated at https://aistudio.google.com/apikey",
      });
    }

    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
