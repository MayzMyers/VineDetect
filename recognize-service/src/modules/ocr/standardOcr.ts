import sharp, { type Sharp } from "sharp";
import { createWorker, type Worker } from "tesseract.js";
import { normalizeOcrText } from "./normalize.js";
import { classifyOcrSemantic, type OcrSemanticClassification } from "./semantic.js";
import { estimateDeskewAngle, type DeskewEstimate } from "./deskew.js";
import { estimateLabelPerspective, mapPerspectiveBox, warpPerspectiveGrayscale, type PerspectiveCorners, type PerspectiveEstimate } from "./perspective.js";

const MIXED_WHITELIST =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" +
  "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ" +
  "абвгдеёжзийклмнопрстуфхцчшщъыьэюя" +
  " -.,'\"«»%";

export const OCR_CASCADE_PROFILE_VERSION = "tesseract-cascade-v6";

let workerPromise: Promise<Worker> | null = null;

type NormalizedBox = { x: number; y: number; width: number; height: number };
type OcrLevel = "line" | "word";
type OcrStage = "cheap" | "deep" | "rescue";
type OcrPreprocess = "normalized" | "contrast" | "threshold" | "invert" | "clahe" | "adaptive-threshold" | "glare-suppressed" | "deskew" | "perspective" | "rotate-cw" | "rotate-ccw";
type OcrCropRegion = "full" | "top" | "center" | "bottom";
export type OcrTextDirection = "right" | "left" | "down" | "up" | "mixed";
export type OcrGlyphOrientation = "upright" | "clockwise" | "counterclockwise" | "upside-down" | "mixed";

type OcrProfile = {
  id: string;
  stage: OcrStage;
  region: OcrCropRegion;
  preprocess: OcrPreprocess;
  psm: "5" | "6" | "7" | "11";
  minWidth: number;
  weight: number;
  deskewAngleDegrees?: number;
  perspectiveCorners?: PerspectiveCorners;
  rotationDegrees?: 90 | -90;
  textDirection?: OcrTextDirection;
  glyphOrientation?: OcrGlyphOrientation;
};

const CHEAP_PROFILES: OcrProfile[] = [
  { id: "full-normalized-sparse", stage: "cheap", region: "full", preprocess: "normalized", psm: "11", minWidth: 800, weight: 1 },
  { id: "full-contrast-block", stage: "cheap", region: "full", preprocess: "contrast", psm: "6", minWidth: 900, weight: 0.95 },
  { id: "top-contrast-line", stage: "cheap", region: "top", preprocess: "contrast", psm: "7", minWidth: 800, weight: 0.9 },
  { id: "bottom-normalized-line", stage: "cheap", region: "bottom", preprocess: "normalized", psm: "7", minWidth: 800, weight: 0.85 },
];

const DEEP_PROFILES: OcrProfile[] = [
  { id: "full-threshold-sparse", stage: "deep", region: "full", preprocess: "threshold", psm: "11", minWidth: 1100, weight: 0.88 },
  { id: "full-invert-block", stage: "deep", region: "full", preprocess: "invert", psm: "6", minWidth: 1000, weight: 0.82 },
  { id: "center-threshold-block", stage: "deep", region: "center", preprocess: "threshold", psm: "6", minWidth: 1000, weight: 0.86 },
];

const RESCUE_PROFILES: OcrProfile[] = [
  // Metallic/light lettering on a black label is usually sparse rather than
  // one rectangular paragraph. The deep invert+PSM6 pass can return text but
  // no usable blocks for this layout, so retry the same polarity with sparse
  // segmentation before declaring the Label empty.
  { id: "full-invert-sparse", stage: "rescue", region: "full", preprocess: "invert", psm: "11", minWidth: 1400, weight: 0.88 },
  { id: "full-clahe-sparse", stage: "rescue", region: "full", preprocess: "clahe", psm: "11", minWidth: 1200, weight: 0.84 },
  { id: "full-adaptive-threshold-block", stage: "rescue", region: "full", preprocess: "adaptive-threshold", psm: "6", minWidth: 1200, weight: 0.8 },
  { id: "full-glare-suppressed-sparse", stage: "rescue", region: "full", preprocess: "glare-suppressed", psm: "11", minWidth: 1100, weight: 0.78 },
];

const ORIENTATION_PROFILES: OcrProfile[] = [
  { id: "full-normalized-vertical-block", stage: "rescue", region: "full", preprocess: "normalized", psm: "5", minWidth: 1100, weight: 0.72, textDirection: "down", glyphOrientation: "upright" },
  { id: "full-rotate-cw-sparse", stage: "rescue", region: "full", preprocess: "rotate-cw", psm: "11", minWidth: 1100, weight: 0.84, rotationDegrees: 90 },
  { id: "full-rotate-ccw-sparse", stage: "rescue", region: "full", preprocess: "rotate-ccw", psm: "11", minWidth: 1100, weight: 0.84, rotationDegrees: -90 },
];

export type StandardOcrInput = {
  imagePath: string;
  bbox: { x: number; y: number; width: number; height: number };
};

export type OcrCascadeObservation = {
  id: string;
  passId: string;
  profileWeight: number;
  parentObservationId: string | null;
  level: OcrLevel;
  bbox: NormalizedBox;
  rawText: string;
  normalizedText: string;
  confidence: number | null;
  validityScore: number;
  valid: boolean;
  rejectionReasons: string[];
  textDirection: OcrTextDirection;
  glyphOrientation: OcrGlyphOrientation;
};

export type OcrCascadePass = {
  id: string;
  stage: OcrStage;
  region: OcrCropRegion;
  preprocess: OcrPreprocess;
  psm: string;
  minWidth: number;
  weight: number;
  rawText: string;
  normalizedText: string;
  confidence: number;
  runtimeMs: number;
  observationCount: number;
  validObservationCount: number;
  deskewAngleDegrees: number | null;
  rotationDegrees: number | null;
};

export type OcrConsensusRegion = {
  key: string;
  parentKey: string | null;
  level: OcrLevel;
  bbox: NormalizedBox;
  rawText: string;
  normalizedText: string;
  confidence: number | null;
  support: number;
  passIds: string[];
  observationIds: string[];
  validityScore: number;
  textConsensus: number;
  spatialConsensus: number;
  consensus: number;
  semantic: OcrSemanticClassification;
  textDirection: OcrTextDirection;
  glyphOrientation: OcrGlyphOrientation;
};

export type OcrCascadeEvidence = {
  schemaVersion: 1;
  profileVersion: typeof OCR_CASCADE_PROFILE_VERSION;
  completedStage: OcrStage;
  stopReason: "strong-cheap-evidence" | "strong-deep-evidence" | "strong-rescue-evidence" | "rescue-exhausted";
  passes: OcrCascadePass[];
  observations: OcrCascadeObservation[];
  consensusRegions: OcrConsensusRegion[];
  geometry: DeskewEstimate & { perspective: PerspectiveEstimate };
  quality: {
    observationCount: number;
    validObservationCount: number;
    rejectedObservationCount: number;
    consensusRegionCount: number;
    supportedConsensusRegionCount: number;
    averageOcrConfidence: number;
    averageValidityScore: number;
    averageConsensus: number;
    semanticRegionCount: number;
    highConfidenceSemanticRegionCount: number;
  };
};

export type StandardOcrResult = {
  rawText: string;
  normalizedText: string;
  confidence: number;
  engine: string;
  engineVersion: string;
  runtimeMs: number;
  crop: { width: number; height: number };
  regions: StandardOcrRegion[];
  evidence: OcrCascadeEvidence;
};

export type StandardOcrRegion = {
  key: string;
  parentKey: string | null;
  level: OcrLevel;
  bbox: NormalizedBox;
  rawText: string;
  normalizedText: string;
  confidence: number | null;
  textDirection: OcrTextDirection;
  glyphOrientation: OcrGlyphOrientation;
};

export async function runStandardOcrOnCrop(input: StandardOcrInput): Promise<StandardOcrResult> {
  const started = Date.now();
  const sourceMetadata = await sharp(input.imagePath).metadata();
  const sourceWidth = sourceMetadata.width ?? input.bbox.x + input.bbox.width;
  const sourceHeight = sourceMetadata.height ?? input.bbox.y + input.bbox.height;
  const left = clampInt(input.bbox.x, 0, Math.max(0, sourceWidth - 1));
  const top = clampInt(input.bbox.y, 0, Math.max(0, sourceHeight - 1));
  const width = clampInt(input.bbox.width, 1, Math.max(1, sourceWidth - left));
  const height = clampInt(input.bbox.height, 1, Math.max(1, sourceHeight - top));
  const crop = await sharp(input.imagePath).extract({ left, top, width, height }).png().toBuffer();
  return runOcrCascadeBuffer(crop, width, height, started);
}

export async function runStandardOcrOnBuffer(image: Buffer): Promise<StandardOcrResult> {
  const started = Date.now();
  const metadata = await sharp(image).metadata();
  if (!metadata.width || !metadata.height) throw new Error("OCR image buffer dimensions are unavailable");
  return runOcrCascadeBuffer(image, metadata.width, metadata.height, started);
}

async function runOcrCascadeBuffer(crop: Buffer, width: number, height: number, started: number) {
  const cheap = await runProfiles(crop, width, height, CHEAP_PROFILES);
  const cheapConsensus = buildConsensus(cheap.observations, CHEAP_PROFILES.length);
  const strongCheapEvidence = hasStrongEvidence(cheap.passes, cheapConsensus);
  const deep = strongCheapEvidence
    ? { passes: [] as OcrCascadePass[], observations: [] as OcrCascadeObservation[] }
    : await runProfiles(crop, width, height, DEEP_PROFILES);
  const preRescuePasses = [...cheap.passes, ...deep.passes];
  const preRescueObservations = [...cheap.observations, ...deep.observations];
  const deepConsensus = buildConsensus(preRescueObservations, preRescuePasses.length);
  const strongDeepEvidence = !strongCheapEvidence && hasStrongEvidence(preRescuePasses, deepConsensus);
  const needsRescue = !strongCheapEvidence && !strongDeepEvidence;
  const [deskew, perspective] = needsRescue
    ? await Promise.all([estimateDeskewAngle(crop), estimateLabelPerspective(crop)])
    : [notEvaluatedDeskew(), notEvaluatedPerspective()];
  const geometry = { ...deskew, perspective };
  const geometryProfiles: OcrProfile[] = [];
  if (deskew.applied && deskew.angleDegrees !== null) geometryProfiles.push({
    id: "full-deskew-sparse", stage: "rescue", region: "full", preprocess: "deskew", psm: "11", minWidth: 1200, weight: 0.9,
    deskewAngleDegrees: deskew.angleDegrees,
  });
  if (perspective.applied && perspective.corners) geometryProfiles.push({
    id: "full-perspective-sparse", stage: "rescue", region: "full", preprocess: "perspective", psm: "11", minWidth: 1200, weight: 0.88,
    perspectiveCorners: perspective.corners,
  });
  const rescueProfiles = [...geometryProfiles, ...RESCUE_PROFILES];
  const rescue = strongCheapEvidence || strongDeepEvidence
    ? { passes: [] as OcrCascadePass[], observations: [] as OcrCascadeObservation[] }
    : await runProfiles(crop, width, height, rescueProfiles);
  const orientation = await runProfiles(crop, width, height, ORIENTATION_PROFILES);
  const passes = [...preRescuePasses, ...rescue.passes, ...orientation.passes];
  const observations = [...preRescueObservations, ...rescue.observations, ...orientation.observations];
  const consensusRegions = buildConsensus(observations, passes.length);
  const strongRescueEvidence = rescue.passes.length > 0 && hasStrongEvidence(passes, consensusRegions);
  const regions = consensusRegions.map(toStandardRegion);
  const normalizedText = buildConsensusText(consensusRegions);
  const rawText = buildConsensusRawText(consensusRegions)
    || [...passes].sort((left, right) => right.confidence - left.confidence)[0]?.rawText
    || "";
  const confidence = average(consensusRegions.map((region) => region.confidence ?? 0));
  const evidence: OcrCascadeEvidence = {
    schemaVersion: 1,
    profileVersion: OCR_CASCADE_PROFILE_VERSION,
    completedStage: strongCheapEvidence ? "cheap" : strongDeepEvidence ? "deep" : "rescue",
    stopReason: strongCheapEvidence ? "strong-cheap-evidence" : strongDeepEvidence ? "strong-deep-evidence"
      : strongRescueEvidence ? "strong-rescue-evidence" : "rescue-exhausted",
    passes,
    observations,
    consensusRegions,
    geometry,
    quality: buildEvidenceQuality(passes, observations, consensusRegions),
  };

  return {
    rawText,
    normalizedText,
    confidence,
    engine: "tesseract.js",
    engineVersion: "7.0.0",
    runtimeMs: Date.now() - started,
    crop: { width, height },
    regions,
    evidence,
  };
}

async function runProfiles(crop: Buffer, cropWidth: number, cropHeight: number, profiles: OcrProfile[]) {
  const passes: OcrCascadePass[] = [];
  const observations: OcrCascadeObservation[] = [];
  for (const profile of profiles) {
    const result = await runProfile(crop, cropWidth, cropHeight, profile);
    passes.push(result.pass);
    observations.push(...result.observations);
  }
  return { passes, observations };
}

async function runProfile(crop: Buffer, cropWidth: number, cropHeight: number, profile: OcrProfile) {
  const started = Date.now();
  const region = profileRegion(profile.region);
  const pixels = normalizedToPixels(region, cropWidth, cropHeight);
  const processed = await preprocessProfile(crop, pixels, profile);
  const worker = await getWorker();
  await worker.setParameters({
    preserve_interword_spaces: "1",
    tessedit_pageseg_mode: profile.psm,
    tessedit_char_whitelist: MIXED_WHITELIST,
  } as Parameters<Worker["setParameters"]>[0]);
  const result = await worker.recognize(processed.data, {}, { blocks: true });
  const extracted = extractPassObservations(result.data.blocks, processed.info.width, processed.info.height, profile.id, profile.weight, region, profile.deskewAngleDegrees, profile.perspectiveCorners, profile.rotationDegrees, profile.textDirection, profile.glyphOrientation);
  const observations = extracted.map((observation) => ({ ...observation, ...scoreObservation(observation) }));
  const rawText = result.data.text ?? "";
  return {
    pass: {
      id: profile.id,
      stage: profile.stage,
      region: profile.region,
      preprocess: profile.preprocess,
      psm: profile.psm,
      minWidth: profile.minWidth,
      weight: profile.weight,
      rawText,
      normalizedText: normalizeOcrText(rawText),
      confidence: finite(result.data.confidence) ?? 0,
      runtimeMs: Date.now() - started,
      observationCount: observations.length,
      validObservationCount: observations.filter((observation) => observation.valid).length,
      deskewAngleDegrees: profile.deskewAngleDegrees ?? null,
      rotationDegrees: profile.rotationDegrees ?? null,
    } satisfies OcrCascadePass,
    observations,
  };
}

async function preprocessProfile(crop: Buffer, pixels: { left: number; top: number; width: number; height: number }, profile: OcrProfile) {
  let pipeline: Sharp = sharp(crop).extract(pixels)
    .resize({ width: Math.max(profile.minWidth, pixels.width), withoutEnlargement: false })
    .grayscale();
  if (profile.preprocess === "normalized") pipeline = pipeline.normalize();
  if (profile.preprocess === "contrast") pipeline = pipeline.normalize().linear(1.35, -42);
  if (profile.preprocess === "threshold") pipeline = pipeline.normalize().threshold(158);
  if (profile.preprocess === "invert") pipeline = pipeline.normalize().negate();
  if (profile.preprocess === "clahe") pipeline = pipeline.clahe({ width: 32, height: 32, maxSlope: 3 }).sharpen({ sigma: 0.8 });
  if (profile.preprocess === "glare-suppressed") pipeline = pipeline.gamma(1.8).clahe({ width: 40, height: 40, maxSlope: 2 }).sharpen({ sigma: 1 });
  if (profile.preprocess === "deskew") return renderDeskewed(pipeline.normalize().sharpen({ sigma: 0.8 }), profile.deskewAngleDegrees ?? 0);
  if (profile.preprocess === "perspective" && profile.perspectiveCorners) return renderPerspective(pipeline.normalize().sharpen({ sigma: 0.8 }), profile.perspectiveCorners);
  if (profile.preprocess === "rotate-cw") return pipeline.normalize().sharpen({ sigma: 0.8 }).rotate(90, { background: "#ffffff" }).png().toBuffer({ resolveWithObject: true });
  if (profile.preprocess === "rotate-ccw") return pipeline.normalize().sharpen({ sigma: 0.8 }).rotate(-90, { background: "#ffffff" }).png().toBuffer({ resolveWithObject: true });
  if (profile.preprocess !== "adaptive-threshold") return pipeline.png().toBuffer({ resolveWithObject: true });

  const grayscale = await pipeline.clahe({ width: 32, height: 32, maxSlope: 3 }).raw().toBuffer({ resolveWithObject: true });
  const thresholded = localAdaptiveThreshold(grayscale.data, grayscale.info.width, grayscale.info.height);
  return sharp(thresholded, { raw: { width: grayscale.info.width, height: grayscale.info.height, channels: 1 } })
    .png().toBuffer({ resolveWithObject: true });
}

async function renderDeskewed(pipeline: Sharp, angleDegrees: number) {
  const fixed = await pipeline.png().toBuffer({ resolveWithObject: true });
  const rotated = await sharp(fixed.data).rotate(angleDegrees, { background: "#ffffff" }).png().toBuffer({ resolveWithObject: true });
  const left = Math.max(0, Math.floor((rotated.info.width - fixed.info.width) / 2));
  const top = Math.max(0, Math.floor((rotated.info.height - fixed.info.height) / 2));
  return sharp(rotated.data).extract({ left, top, width: fixed.info.width, height: fixed.info.height })
    .png().toBuffer({ resolveWithObject: true });
}

async function renderPerspective(pipeline: Sharp, corners: PerspectiveCorners) {
  const grayscale = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const warped = warpPerspectiveGrayscale(grayscale.data, grayscale.info.width, grayscale.info.height, corners);
  return sharp(warped, { raw: { width: grayscale.info.width, height: grayscale.info.height, channels: 1 } })
    .png().toBuffer({ resolveWithObject: true });
}

function localAdaptiveThreshold(input: Buffer, width: number, height: number) {
  const stride = width + 1;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y += 1) {
    let rowSum = 0;
    for (let x = 1; x <= width; x += 1) {
      rowSum += input[(y - 1) * width + x - 1] ?? 0;
      integral[y * stride + x] = integral[(y - 1) * stride + x] + rowSum;
    }
  }
  const output = Buffer.allocUnsafe(width * height);
  const radius = Math.max(9, Math.min(31, Math.round(Math.min(width, height) / 24)));
  const bias = 8;
  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - radius); const bottom = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius); const right = Math.min(width - 1, x + radius);
      const sum = integral[(bottom + 1) * stride + right + 1] - integral[top * stride + right + 1]
        - integral[(bottom + 1) * stride + left] + integral[top * stride + left];
      const area = (right - left + 1) * (bottom - top + 1);
      output[y * width + x] = (input[y * width + x] ?? 0) < sum / area - bias ? 0 : 255;
    }
  }
  return output;
}

async function getWorker() {
  workerPromise ??= createWorker("rus+eng");
  return workerPromise;
}

type RawObservation = Omit<OcrCascadeObservation, "validityScore" | "valid" | "rejectionReasons">;
type TesseractBbox = { x0?: number; y0?: number; x1?: number; y1?: number };
type TesseractWord = { text?: string; confidence?: number; bbox?: TesseractBbox };
type TesseractLine = { text?: string; confidence?: number; bbox?: TesseractBbox; words?: TesseractWord[] };
type TesseractParagraph = { lines?: TesseractLine[] };
type TesseractBlock = { paragraphs?: TesseractParagraph[] };

function extractPassObservations(blocks: unknown, width: number, height: number, passId: string, profileWeight: number, region: NormalizedBox, deskewAngleDegrees?: number, perspectiveCorners?: PerspectiveCorners, rotationDegrees?: 90 | -90, textDirection?: OcrTextDirection, glyphOrientation?: OcrGlyphOrientation): RawObservation[] {
  const observations: RawObservation[] = [];
  const orientation = profileOrientation(rotationDegrees, textDirection, glyphOrientation);
  if (!Array.isArray(blocks)) return observations;
  for (const [blockIndex, block] of (blocks as TesseractBlock[]).entries()) {
    for (const [paragraphIndex, paragraph] of (block.paragraphs ?? []).entries()) {
      for (const [lineIndex, line] of (paragraph.lines ?? []).entries()) {
        const lineWords = line.words ?? [];
        const localLineBox = normalizeTesseractBbox(line.bbox ?? unionWordBoxes(lineWords), width, height);
        const lineText = line.text?.trim() || lineWords.map((word) => word.text?.trim() ?? "").filter(Boolean).join(" ");
        const lineId = `${passId}:line:${blockIndex}:${paragraphIndex}:${lineIndex}`;
        if (lineText && localLineBox) observations.push({
          id: lineId, passId, profileWeight, parentObservationId: null, level: "line", bbox: mapRegionBox(restoreGeometryBox(localLineBox, width, height, deskewAngleDegrees, perspectiveCorners, rotationDegrees), region),
          rawText: lineText, normalizedText: normalizeOcrText(lineText), confidence: finite(line.confidence),
          ...orientation,
        });
        for (const [wordIndex, word] of lineWords.entries()) {
          const rawText = word.text?.trim() ?? "";
          const localBox = normalizeTesseractBbox(word.bbox, width, height);
          if (!rawText || !localBox) continue;
          observations.push({
            id: `${lineId}:word:${wordIndex}`, passId, profileWeight,
            parentObservationId: lineText && localLineBox ? lineId : null,
            level: "word", bbox: mapRegionBox(restoreGeometryBox(localBox, width, height, deskewAngleDegrees, perspectiveCorners, rotationDegrees), region), rawText,
            normalizedText: normalizeOcrText(rawText), confidence: finite(word.confidence),
            ...orientation,
          });
        }
      }
    }
  }
  return observations;
}

function scoreObservation(observation: RawObservation) {
  const text = observation.normalizedText;
  const chars = [...text].filter((character) => !/\s/.test(character));
  const alphaNumeric = chars.filter((character) => /[\p{L}\p{N}]/u.test(character));
  const distinct = new Set(alphaNumeric.map((character) => character.toLowerCase())).size;
  const confidence = Math.max(0, Math.min(1, (observation.confidence ?? 0) / 100));
  const alphaNumericRatio = chars.length ? alphaNumeric.length / chars.length : 0;
  const diversity = alphaNumeric.length ? distinct / alphaNumeric.length : 0;
  const lengthScore = Math.min(1, alphaNumeric.length / (observation.level === "line" ? 10 : 5));
  const aspect = observation.bbox.width / Math.max(0.0001, observation.bbox.height);
  const geometryScore = aspect >= 0.12 && aspect <= 35 && observation.bbox.height >= 0.006 ? 1 : 0;
  const domainShort = isDomainShortToken(text);
  const reasons: string[] = [];
  if (!alphaNumeric.length) reasons.push("NO_ALPHANUMERIC_CONTENT");
  if (alphaNumeric.length <= 2 && confidence < 0.45 && !domainShort) reasons.push("LOW_CONFIDENCE_SHORT_TEXT");
  if (alphaNumericRatio < 0.5) reasons.push("LOW_ALPHANUMERIC_RATIO");
  if (!geometryScore) reasons.push("IMPLAUSIBLE_BBOX_GEOMETRY");
  const validityScore = round01(
    confidence * 0.4 + lengthScore * 0.18 + diversity * 0.14 + alphaNumericRatio * 0.16 + geometryScore * 0.12,
  );
  const valid = domainShort || (reasons.length === 0 && validityScore >= 0.38);
  return { validityScore, valid, rejectionReasons: valid ? [] : reasons.length ? reasons : ["LOW_VALIDITY_SCORE"] };
}

function isDomainShortToken(text: string) {
  if (/^(19|20)\d{2}$/.test(text)) return true;
  if (/^\d{2,4}$/.test(text)) return true;
  return /^(xo|vs|igp|doc|aoc|docg)$/i.test(text);
}

type ConsensusGroup = { level: OcrLevel; observations: OcrCascadeObservation[] };

function buildConsensus(observations: OcrCascadeObservation[], totalPasses: number): OcrConsensusRegion[] {
  const candidates = observations.filter((observation) => observation.valid)
    .sort((left, right) => evidenceWeight(right) - evidenceWeight(left));
  const groups: ConsensusGroup[] = [];
  for (const observation of candidates) {
    const group = groups.find((candidate) => candidate.level === observation.level
      && candidate.observations.some((member) => sameSpatialTextEntity(member, observation)));
    if (group) group.observations.push(observation);
    else groups.push({ level: observation.level, observations: [observation] });
  }
  const regions = groups.map((group, index) => consensusRegion(group, index, totalPasses))
    .sort((left, right) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x);
  for (const word of regions.filter((region) => region.level === "word")) {
    const parent = regions.filter((region) => region.level === "line")
      .map((line) => ({ line, score: containment(word.bbox, line.bbox) + rectIou(word.bbox, line.bbox) }))
      .sort((left, right) => right.score - left.score)[0];
    if (parent && parent.score >= 0.55) word.parentKey = parent.line.key;
  }
  return regions;
}

function consensusRegion(group: ConsensusGroup, index: number, totalPasses: number): OcrConsensusRegion {
  const canonical = selectCanonicalObservation(group.observations);
  const bbox = weightedBox(group.observations);
  const passIds = [...new Set(group.observations.map((observation) => observation.passId))];
  const totalWeight = group.observations.reduce((sum, observation) => sum + evidenceWeight(observation), 0);
  const textConsensus = round01(group.observations.reduce((sum, observation) => sum
    + textSimilarity(canonical.normalizedText, observation.normalizedText) * evidenceWeight(observation), 0) / Math.max(0.0001, totalWeight));
  const spatialConsensus = round01(average(group.observations.map((observation) => spatialAgreement(bbox, observation.bbox))));
  const supportScore = Math.min(1, passIds.length / Math.max(1, Math.min(3, totalPasses)));
  const consensus = round01(textConsensus * 0.5 + spatialConsensus * 0.3 + supportScore * 0.2);
  const semantic = classifyOcrSemantic(canonical.rawText || canonical.normalizedText, group.level, bbox);
  return {
    key: `consensus:${group.level}:${index}`, parentKey: null, level: group.level, bbox,
    rawText: canonical.rawText, normalizedText: canonical.normalizedText,
    confidence: round(average(group.observations.map((observation) => observation.confidence ?? 0)), 2),
    support: passIds.length, passIds, observationIds: group.observations.map((observation) => observation.id),
    validityScore: round01(average(group.observations.map((observation) => observation.validityScore))),
    textConsensus, spatialConsensus, consensus, semantic,
    textDirection: canonical.textDirection,
    glyphOrientation: canonical.glyphOrientation,
  };
}

function sameSpatialTextEntity(left: OcrCascadeObservation, right: OcrCascadeObservation) {
  if (textSimilarity(left.normalizedText, right.normalizedText) < 0.72) return false;
  const iou = rectIou(left.bbox, right.bbox);
  const contained = Math.max(containment(left.bbox, right.bbox), containment(right.bbox, left.bbox));
  const proximity = centerDistance(left.bbox, right.bbox);
  return iou >= 0.18 || contained >= 0.72 || proximity <= 0.065;
}

function selectCanonicalObservation(observations: OcrCascadeObservation[]) {
  return [...observations].sort((left, right) => {
    const leftScore = observations.reduce((sum, observation) => sum + textSimilarity(left.normalizedText, observation.normalizedText) * evidenceWeight(observation), 0);
    const rightScore = observations.reduce((sum, observation) => sum + textSimilarity(right.normalizedText, observation.normalizedText) * evidenceWeight(observation), 0);
    return rightScore - leftScore;
  })[0];
}

function evidenceWeight(observation: OcrCascadeObservation) {
  return Math.max(0.05, observation.validityScore)
    * Math.max(0.2, (observation.confidence ?? 0) / 100)
    * observation.profileWeight;
}

function weightedBox(observations: OcrCascadeObservation[]): NormalizedBox {
  const total = observations.reduce((sum, observation) => sum + evidenceWeight(observation), 0);
  const weighted = (key: keyof NormalizedBox) => observations.reduce((sum, observation) => sum + observation.bbox[key] * evidenceWeight(observation), 0) / Math.max(0.0001, total);
  return { x: round01(weighted("x")), y: round01(weighted("y")), width: round01(weighted("width")), height: round01(weighted("height")) };
}

function hasStrongEvidence(passes: OcrCascadePass[], regions: OcrConsensusRegion[]) {
  const useful = regions.filter((region) => region.level === "word" && region.validityScore >= 0.55);
  const supported = useful.filter((region) => region.support >= 2 && region.consensus >= 0.65);
  const reliablePassConfidence = average(passes
    .filter((pass) => pass.validObservationCount >= 2)
    .map((pass) => pass.confidence)
    .sort((left, right) => right - left)
    .slice(0, 3));
  const textLength = useful.reduce((sum, region) => sum + region.normalizedText.length, 0);
  return useful.length >= 2 && supported.length >= 1 && reliablePassConfidence >= 62 && textLength >= 8;
}

function buildEvidenceQuality(passes: OcrCascadePass[], observations: OcrCascadeObservation[], regions: OcrConsensusRegion[]) {
  const valid = observations.filter((observation) => observation.valid);
  return {
    observationCount: observations.length,
    validObservationCount: valid.length,
    rejectedObservationCount: observations.length - valid.length,
    consensusRegionCount: regions.length,
    supportedConsensusRegionCount: regions.filter((region) => region.support >= 2).length,
    averageOcrConfidence: round(average(passes.map((pass) => pass.confidence)), 2),
    averageValidityScore: round(average(valid.map((observation) => observation.validityScore)), 4),
    averageConsensus: round(average(regions.map((region) => region.consensus)), 4),
    semanticRegionCount: regions.filter((region) => region.semantic.type !== "unknown").length,
    highConfidenceSemanticRegionCount: regions.filter((region) => region.semantic.type !== "unknown" && region.semantic.confidence >= 0.75).length,
  };
}

function buildConsensusText(regions: OcrConsensusRegion[]) {
  const lines = regions.filter((region) => region.level === "line" && region.consensus >= 0.35);
  const source = lines.length ? lines : regions.filter((region) => region.level === "word" && region.consensus >= 0.35);
  return normalizeOcrText(source.map((region) => region.normalizedText).join(" "));
}

function buildConsensusRawText(regions: OcrConsensusRegion[]) {
  const lines = regions.filter((region) => region.level === "line" && region.rawText);
  const source = lines.length ? lines : regions.filter((region) => region.level === "word" && region.rawText);
  return source.map((region) => region.rawText).join(lines.length ? "\n" : " ").trim();
}

function toStandardRegion(region: OcrConsensusRegion): StandardOcrRegion {
  return { key: region.key, parentKey: region.parentKey, level: region.level, bbox: region.bbox, rawText: region.rawText, normalizedText: region.normalizedText, confidence: region.confidence, textDirection: region.textDirection, glyphOrientation: region.glyphOrientation };
}

function profileRegion(region: OcrCropRegion): NormalizedBox {
  if (region === "top") return { x: 0, y: 0, width: 1, height: 0.42 };
  if (region === "center") return { x: 0, y: 0.22, width: 1, height: 0.56 };
  if (region === "bottom") return { x: 0, y: 0.58, width: 1, height: 0.42 };
  return { x: 0, y: 0, width: 1, height: 1 };
}

function normalizedToPixels(rect: NormalizedBox, width: number, height: number) {
  const left = clampInt(rect.x * width, 0, Math.max(0, width - 1));
  const top = clampInt(rect.y * height, 0, Math.max(0, height - 1));
  return { left, top, width: clampInt(rect.width * width, 1, width - left), height: clampInt(rect.height * height, 1, height - top) };
}

function restoreDeskewBox(box: NormalizedBox, width: number, height: number, angleDegrees?: number): NormalizedBox {
  if (!angleDegrees) return box;
  const radians = angleDegrees * Math.PI / 180;
  const sin = Math.sin(radians); const cos = Math.cos(radians);
  const corners = [
    [box.x, box.y], [box.x + box.width, box.y],
    [box.x, box.y + box.height], [box.x + box.width, box.y + box.height],
  ].map(([x, y]) => {
    const dx = (x - 0.5) * width; const dy = (y - 0.5) * height;
    return { x: clamp01((cos * dx - sin * dy) / width + 0.5), y: clamp01((sin * dx + cos * dy) / height + 0.5) };
  });
  const minX = Math.min(...corners.map((point) => point.x)); const maxX = Math.max(...corners.map((point) => point.x));
  const minY = Math.min(...corners.map((point) => point.y)); const maxY = Math.max(...corners.map((point) => point.y));
  return { x: round01(minX), y: round01(minY), width: round01(maxX - minX), height: round01(maxY - minY) };
}

function restoreGeometryBox(box: NormalizedBox, width: number, height: number, angleDegrees?: number, perspectiveCorners?: PerspectiveCorners, rotationDegrees?: 90 | -90) {
  if (rotationDegrees) return restoreQuarterTurnBox(box, rotationDegrees);
  if (perspectiveCorners) return mapPerspectiveBox(box, perspectiveCorners);
  return restoreDeskewBox(box, width, height, angleDegrees);
}

function restoreQuarterTurnBox(box: NormalizedBox, rotationDegrees: 90 | -90): NormalizedBox {
  if (rotationDegrees === 90) return {
    x: round01(box.y),
    y: round01(1 - box.x - box.width),
    width: round01(box.height),
    height: round01(box.width),
  };
  return {
    x: round01(1 - box.y - box.height),
    y: round01(box.x),
    width: round01(box.height),
    height: round01(box.width),
  };
}

function profileOrientation(rotationDegrees?: 90 | -90, textDirection?: OcrTextDirection, glyphOrientation?: OcrGlyphOrientation): { textDirection: OcrTextDirection; glyphOrientation: OcrGlyphOrientation } {
  if (textDirection || glyphOrientation) return { textDirection: textDirection ?? "right", glyphOrientation: glyphOrientation ?? "upright" };
  if (rotationDegrees === 90) return { textDirection: "up", glyphOrientation: "counterclockwise" };
  if (rotationDegrees === -90) return { textDirection: "down", glyphOrientation: "clockwise" };
  return { textDirection: "right", glyphOrientation: "upright" };
}

function notEvaluatedDeskew(): DeskewEstimate {
  return { evaluated: false, angleDegrees: null, confidence: 0, applied: false, method: "component-baseline-v1" };
}

function notEvaluatedPerspective(): PerspectiveEstimate {
  return { evaluated: false, applied: false, confidence: 0, distortion: 0, corners: null, method: "directional-edge-quad-v1" };
}

function mapRegionBox(box: NormalizedBox, region: NormalizedBox): NormalizedBox {
  return { x: round01(region.x + box.x * region.width), y: round01(region.y + box.y * region.height), width: round01(box.width * region.width), height: round01(box.height * region.height) };
}

function normalizeTesseractBbox(bbox: TesseractBbox | undefined, width: number, height: number): NormalizedBox | null {
  if (!bbox) return null;
  const x0 = finite(bbox.x0); const y0 = finite(bbox.y0); const x1 = finite(bbox.x1); const y1 = finite(bbox.y1);
  if (x0 === null || y0 === null || x1 === null || y1 === null || x1 <= x0 || y1 <= y0) return null;
  return { x: clamp01(x0 / Math.max(1, width)), y: clamp01(y0 / Math.max(1, height)), width: clamp01((x1 - x0) / Math.max(1, width)), height: clamp01((y1 - y0) / Math.max(1, height)) };
}

function unionWordBoxes(words: TesseractWord[]): TesseractBbox | undefined {
  const boxes = words.map((word) => word.bbox).filter((bbox): bbox is TesseractBbox => Boolean(bbox));
  const values = (key: keyof TesseractBbox) => boxes.map((box) => finite(box[key])).filter((value): value is number => value !== null);
  const x0 = values("x0"); const y0 = values("y0"); const x1 = values("x1"); const y1 = values("y1");
  return x0.length && y0.length && x1.length && y1.length ? { x0: Math.min(...x0), y0: Math.min(...y0), x1: Math.max(...x1), y1: Math.max(...y1) } : undefined;
}

function textSimilarity(left: string, right: string) {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const distance = levenshtein(left, right);
  return Math.max(0, 1 - distance / Math.max(left.length, right.length));
}

function levenshtein(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) current[column] = left[row - 1] === right[column - 1]
      ? previous[column - 1]
      : Math.min(previous[column - 1], previous[column], current[column - 1]) + 1;
    for (let column = 0; column < current.length; column += 1) previous[column] = current[column];
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function rectIou(left: NormalizedBox, right: NormalizedBox) {
  const intersection = intersectionArea(left, right);
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function containment(inner: NormalizedBox, outer: NormalizedBox) {
  const area = inner.width * inner.height;
  return area > 0 ? intersectionArea(inner, outer) / area : 0;
}

function intersectionArea(left: NormalizedBox, right: NormalizedBox) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function centerDistance(left: NormalizedBox, right: NormalizedBox) {
  return Math.hypot(left.x + left.width / 2 - right.x - right.width / 2, left.y + left.height / 2 - right.y - right.height / 2);
}

function spatialAgreement(left: NormalizedBox, right: NormalizedBox) {
  return Math.max(rectIou(left, right), Math.max(containment(left, right), containment(right, left)) * 0.9, Math.max(0, 1 - centerDistance(left, right) / 0.2) * 0.75);
}

function clampInt(value: number, min: number, max: number) { return Math.max(min, Math.min(max, Math.round(value))); }
function finite(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function clamp01(value: number) { return Math.max(0, Math.min(1, value)); }
function round01(value: number) { return round(clamp01(value), 4); }
function round(value: number, digits: number) { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
