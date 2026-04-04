import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

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

EXAMPLE OUTPUT:
\`\`\`javascript
// Create building shape from footprint
const shape = new THREE.Shape();
shape.moveTo(0, 0);
shape.lineTo(10, 0);
shape.lineTo(10, 8);
shape.lineTo(0, 8);
shape.closePath();

// Extrude to building height
const height = 6; // 2 stories * 3m
const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
const material = new THREE.MeshStandardMaterial({ color: 0xdddddd });
const building = new THREE.Mesh(geometry, material);
building.rotation.x = -Math.PI / 2;
scene.add(building);

// Ground plane
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(100, 100),
  new THREE.MeshStandardMaterial({ color: 0x88aa66 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.01;
scene.add(ground);
\`\`\`

Use the ACTUAL footprint points and property data provided. Be precise with dimensions.`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { propertyData, userPrompt } = body;

    const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_STREET_VIEW_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "No API key" }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-3-flash-preview",
      systemInstruction: SYSTEM_PROMPT,
    });

    const dataContext = JSON.stringify(propertyData, null, 2);
    const prompt = userPrompt
      ? `Property data:\n${dataContext}\n\nUser request: ${userPrompt}\n\nGenerate THREE.js code for this building. Return ONLY the JavaScript code, no markdown fences.`
      : `Property data:\n${dataContext}\n\nGenerate THREE.js code for this building based on the footprint and available data. Return ONLY the JavaScript code, no markdown fences.`;

    const result = await model.generateContent(prompt);
    let code = result.response.text();

    // Strip markdown code fences if present
    code = code.replace(/^```(?:javascript|js)?\n?/m, "").replace(/\n?```$/m, "").trim();

    return NextResponse.json({ code });
  } catch (error) {
    console.error("Model generation error:", error);
    const msg = error instanceof Error ? error.message : "Generation failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
