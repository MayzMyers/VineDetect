import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const formData = await request.formData();

  const fullImage = formData.get("fullImage");
  const labelCrop = formData.get("labelCrop");

  console.log({
    hasFullImage: fullImage instanceof Blob,
    hasLabelCrop: labelCrop instanceof Blob,
    clientOcr: formData.get("clientOcr"),
    clientCandidates: formData.get("clientCandidates"),
    quality: formData.get("quality"),
    catalogIndexVersion: formData.get("catalogIndexVersion"),
  });

  return NextResponse.json({
    ok: true,
    finalResults: [],
  });
}
