import { NextRequest, NextResponse } from "next/server";
import { callLLM } from "@/app/lib/llm";

const SYSTEM_PROMPT = `You are an expert architectural 3D modeler. Given property data (footprint, elevation, assessor records, etc.), generate a THREE.js scene that renders the building.

OUTPUT FORMAT: Return ONLY valid JavaScript code that creates a THREE.js scene. The code will be executed in a context where these variables exist:
- \`scene\` (THREE.Scene) - add meshes to this
- \`THREE\` (the THREE.js library)

REQUIREMENTS:
- Use the footprint coordinates (x/y in meters) to extrude the building shape
- Use assessor data (stories, sqft) to determine height
- Default story height: 3 meters
- Create walls using THREE.ExtrudeGeometry from a THREE.Shape based on the footprint
- Add a simple roof (flat or gabled based on roof_type)
- Use realistic materials: light gray for walls, darker for roof
- Position the model centered at origin
- Add ground plane

Use the ACTUAL footprint points and property data provided. Be precise with dimensions.
Return ONLY the JavaScript code, no markdown fences or explanations.`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { propertyData, userPrompt } = body;

    const dataContext = JSON.stringify(propertyData, null, 2);
    const prompt = userPrompt
      ? `Property data:\n${dataContext}\n\nUser request: ${userPrompt}\n\nGenerate THREE.js code for this building. Return ONLY the JavaScript code.`
      : `Property data:\n${dataContext}\n\nGenerate THREE.js code for this building based on the footprint and available data. Return ONLY the JavaScript code.`;

    let code = await callLLM(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      { maxTokens: 2048 }
    );

    // Strip markdown code fences if present
    code = code.replace(/^```(?:javascript|js)?\n?/m, "").replace(/\n?```$/m, "").trim();

    return NextResponse.json({ code });
  } catch (error) {
    console.error("Model generation error:", error);
    const msg = error instanceof Error ? error.message : "Generation failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
