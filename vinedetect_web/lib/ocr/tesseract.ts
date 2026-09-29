import { createWorker, type Worker } from "tesseract.js";
import { normalizeOcrText } from "./normalizeOcrText";

const MIXED_WHITELIST =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" +
  "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ" +
  "абвгдеёжзийклмнопрстуфхцчшщъыьэюя" +
  " -.,'\"«»";
const DIGITS_WHITELIST = "0123456789";

let mixedWorkerPromise: Promise<Worker> | null = null;
let digitsWorkerPromise: Promise<Worker> | null = null;

export type OcrMode = "mixed" | "digits";

async function getWorker(mode: OcrMode) {
  if (mode === "digits") {
    digitsWorkerPromise ??= createWorker("eng");
    return digitsWorkerPromise;
  }

  mixedWorkerPromise ??= createWorker("rus+eng");
  return mixedWorkerPromise;
}

export type OcrResult = {
  rawText: string;
  normalizedText: string;
  confidence: number;
};

export type RecognizeOptions = {
  psm?: string;
  mode?: OcrMode;
  preserveInterwordSpaces?: boolean;
};

export async function recognizeLabelText(
  image: Blob,
  options: RecognizeOptions = {}
): Promise<OcrResult> {
  const mode = options.mode ?? "mixed";
  const worker = await getWorker(mode);
  await worker.setParameters({
    preserve_interword_spaces: options.preserveInterwordSpaces ? "1" : "0",
    tessedit_pageseg_mode: options.psm ?? "11",
    tessedit_char_whitelist: mode === "digits" ? DIGITS_WHITELIST : MIXED_WHITELIST,
  } as Parameters<Worker["setParameters"]>[0]);

  const result = await worker.recognize(image);
  const rawText = result.data.text ?? "";

  return {
    rawText,
    normalizedText: normalizeOcrText(rawText),
    confidence: result.data.confidence ?? 0,
  };
}
