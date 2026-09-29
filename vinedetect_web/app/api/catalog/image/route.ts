import { NextRequest } from "next/server";

const API_SERVICE_URL =
  process.env.API_INTERNAL_URL ??
  process.env.API_SERVICE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://127.0.0.1:8000";

export async function GET(request: NextRequest) {
  const rawPath = request.nextUrl.searchParams.get("path")?.trim().replaceAll("\\", "/") ?? "";
  const segments = rawPath.split("/").filter(Boolean);
  const safePath = segments.length > 0 &&
    !segments.includes("..") &&
    segments.every((segment) => /^[a-zA-Z0-9._-]+$/.test(segment));

  if (!safePath) return new Response("Invalid image path", { status: 400 });

  try {
    const candidatePaths = [segments];
    if (segments[0] === "svoe_vino") candidatePaths.push(["svoe-vino", ...segments.slice(1)]);

    for (const candidate of candidatePaths) {
      const upstream = new URL(`/static/images/${candidate.map(encodeURIComponent).join("/")}`, API_SERVICE_URL);
      const response = await fetch(upstream, {
        cache: "force-cache",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok || !response.body) continue;

      return new Response(response.body, {
        status: 200,
        headers: {
          "Content-Type": imageContentType(candidate.at(-1), response.headers.get("content-type")),
          "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        },
      });
    }
    return new Response("Image not found", { status: 404 });
  } catch {
    return new Response("Image service unavailable", { status: 502 });
  }
}

function imageContentType(fileName: string | undefined, upstreamType: string | null) {
  if (upstreamType?.startsWith("image/")) return upstreamType;
  const extension = fileName?.split(".").pop()?.toLowerCase();
  if (extension === "webp") return "image/webp";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return upstreamType ?? "application/octet-stream";
}
