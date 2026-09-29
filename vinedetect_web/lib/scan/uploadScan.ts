import type { WineCandidate } from "@/lib/catalog/types";
import type { OcrResult } from "@/lib/ocr/tesseract";
import type { FrameAnalysis } from "@/lib/scanner/types";

type UploadScanInput = {
  fullImage: Blob;
  labelCrop: Blob;
  clientOcr: OcrResult;
  clientCandidates: WineCandidate[];
  quality: FrameAnalysis;
  catalogIndexVersion: string;
};

export async function uploadScan(input: UploadScanInput) {
  const formData = new FormData();

  formData.append("fullImage", input.fullImage, "full-frame.jpg");
  formData.append("labelCrop", input.labelCrop, "label-crop.jpg");
  formData.append("clientOcr", JSON.stringify(input.clientOcr));
  formData.append("clientCandidates", JSON.stringify(input.clientCandidates));
  formData.append("quality", JSON.stringify(input.quality));
  formData.append("catalogIndexVersion", input.catalogIndexVersion);

  const response = await fetch("/api/scan", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) throw new Error("Failed to upload scan");
  return response.json();
}
