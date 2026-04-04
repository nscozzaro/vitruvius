import { NextRequest, NextResponse } from "next/server";
import { callLLM } from "@/app/lib/llm";

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

    const dataContext = propertyData
      ? `\n\nCollected property data:\n${JSON.stringify(propertyData, null, 2)}`
      : "";

    const content = await callLLM([
      { role: "system", content: SYSTEM_PROMPT + dataContext },
      ...messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ]);

    return NextResponse.json({ content });
  } catch (error) {
    console.error("Chat API Error:", error);
    const errMsg = error instanceof Error ? error.message : "Chat failed";
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
