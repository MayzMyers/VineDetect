import { NextResponse } from "next/server";
import { getMockRecognitionTags } from "@/lib/recognition/mockFullstack";

export async function GET() {
  return NextResponse.json(getMockRecognitionTags(), { headers: { "Cache-Control": "no-store" } });
}
