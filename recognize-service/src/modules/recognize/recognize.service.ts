import { findRecognitionCandidates } from "../../db/meta.repository.js";
import { detectRecognitionTarget, recognizeV5 } from "../../vision/v5Client.js";
import { extractRecognitionLabelRoi } from "../recognize-node/cvMeta.js";

export async function recognize(input: { ocrTokens: string[]; limit: number }) {
  const candidates = await findRecognitionCandidates(input.ocrTokens, input.limit);
  return { candidates };
}

export async function recognizeImage(imageBase64: string, diagnostics = false) {
  const started = performance.now();
  const detected = await detectRecognitionTarget(imageBase64);
  let roi: [number, number, number, number] | null = null;
  const labelStarted = performance.now();
  let labelFailed = false;
  if (detected.bottleImageBase64) {
    try {
      const label = await extractRecognitionLabelRoi(Buffer.from(detected.bottleImageBase64, "base64"));
      if (label) roi = [label.x, label.y, label.width, label.height];
    } catch (error) {
      labelFailed = true;
      console.error("V5 label ROI unavailable; label evidence abstains", error);
    }
  }
  const labelRoiMs = performance.now() - labelStarted;
  const response = await recognizeV5(imageBase64, detected.target, roi);
  response.diagnostics.timingsMs.labelRoi = labelRoiMs;
  response.diagnostics.timingsMs.total = performance.now() - started;
  if (labelFailed) response.diagnostics.failures.push("labelRoi");
  console.info("V5 request timing", response.diagnostics.timingsMs);
  return {
    architecture: response.architecture,
    result: response.result,
    ...(diagnostics ? { diagnostics: response.diagnostics } : {}),
  };
}
