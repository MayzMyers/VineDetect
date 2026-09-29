import { NextResponse } from "next/server";
import { mockCatalogIndex } from "@/lib/catalog/mockCatalog";

export async function GET() {
  return NextResponse.json(mockCatalogIndex, {
    headers: {
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      ETag: `"${mockCatalogIndex.version}"`,
    },
  });
}
