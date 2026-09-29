import { NextResponse } from "next/server";
import keywordAsset from "@/public/mock/recognition-keywords.v1.json";
import { getMockRecognitionTags } from "@/lib/recognition/mockFullstack";

export async function GET() {
  if (process.env.RECOGNITION_RUNTIME === "mock") {
    return NextResponse.json(
      getMockRecognitionTags(),
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { version: keywordAsset.version, tags: keywordAsset.keywords },
    { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" } },
  );
}
