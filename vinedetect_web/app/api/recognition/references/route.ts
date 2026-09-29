import { parseRecognitionReferences } from "../../../../lib/recognition/references.ts";

export async function GET() {
  const baseUrl = (
    process.env.API_INTERNAL_URL ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    "http://127.0.0.1:8000"
  ).replace(/\/+$/, "");
  const headers = { "Cache-Control": "no-store" };

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v1/recognition/references`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    return Response.json({ error: "Recognition references unavailable" }, { status: 503, headers });
  }

  if (!response.ok) {
    return Response.json(
      { error: "Recognition references unavailable" },
      { status: response.status, headers },
    );
  }

  try {
    return Response.json(parseRecognitionReferences(await response.json()), { headers });
  } catch {
    return Response.json({ error: "Invalid recognition references response" }, { status: 502, headers });
  }
}
