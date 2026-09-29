import Fuse from "fuse.js";
import { searchWineCandidates } from "@/lib/catalog/buildFuse";
import type { ClientWineSearchItem, WineCandidate } from "@/lib/catalog/types";
import type { FrameCandidate, Rect } from "@/lib/scanner/types";
import { recognizeLabelText, type OcrResult } from "./tesseract";

type OcrRegion = "full" | "top" | "center" | "bottom";
type OcrPreprocess = "original" | "contrast" | "threshold" | "invert";
type WhitelistMode = "words" | "digits" | "mixed";

type OcrProfile = {
  id: string;
  region: OcrRegion;
  preprocess: OcrPreprocess;
  psm: "6" | "7" | "11" | "13";
  whitelistMode: WhitelistMode;
  weight: number;
};

export type OcrDebugPass = {
  frameId: string;
  profileId: string;
  region: OcrRegion;
  preprocess: OcrPreprocess;
  psm: string;
  rawText: string;
  normalizedText: string;
  confidence: number;
  tokens: string[];
};

export type AccumulatedTokenDebug = {
  token: string;
  canonical?: string;
  score: number;
  occurrences: number;
  kind?: string;
  sources: string[];
};

export type MultiPassOcrDebugReport = {
  stage: "fast" | "deep";
  decision: StopDecision;
  frames: Array<{
    frameId: string;
    quality: FrameCandidate["analysis"];
  }>;
  passes: OcrDebugPass[];
  accumulator: AccumulatedTokenDebug[];
  yearCandidates: Array<{ year: number; score: number }>;
  rawDigitTexts: string[];
  queries: FuseQueryBundle;
  candidates: Array<WineCandidate & {
    finalScore: number;
    textScore: number;
    matchedTokens: string[];
    sources: string[];
  }>;
};

export type MultiPassOcrResult = {
  ocr: OcrResult;
  candidates: WineCandidate[];
  debugReport: MultiPassOcrDebugReport;
  bestFrame: FrameCandidate;
};

type TokenSource = {
  frameId: string;
  profileId: string;
  region: OcrRegion;
  confidence: number;
};

type AccumulatedToken = {
  rawForms: string[];
  canonical?: string;
  score: number;
  occurrences: number;
  bestConfidence: number;
  confidenceTotal: number;
  kind?: "producer" | "grape" | "region" | "year" | "keyword" | "unknown";
  sources: TokenSource[];
};

type OcrAccumulator = {
  tokens: Map<string, AccumulatedToken>;
  rawTexts: string[];
  rawDigitTexts: string[];
  yearCandidates: Map<number, number>;
};

type WineDictionary = {
  all: Array<{ value: string; kind: NonNullable<AccumulatedToken["kind"]> }>;
};

type FuseQueryBundle = {
  strongQuery: string;
  wideQuery: string;
  entityQuery: string;
};

type CandidateEvidence = WineCandidate & {
  finalScore: number;
  textScore: number;
  matchedTokens: string[];
  sources: string[];
};

type StopDecision =
  | { action: "stop"; reason: "high_confidence"; topWineId: string }
  | { action: "continue"; reason: "need_more_evidence" }
  | { action: "ask_user"; reason: "ambiguous_candidates" };

const FAST_OCR_PROFILES: OcrProfile[] = [
  { id: "full_sparse_contrast", region: "full", preprocess: "contrast", psm: "11", whitelistMode: "mixed", weight: 1 },
  { id: "center_block_contrast", region: "center", preprocess: "contrast", psm: "6", whitelistMode: "mixed", weight: 1 },
  { id: "top_line_contrast", region: "top", preprocess: "contrast", psm: "7", whitelistMode: "mixed", weight: 0.9 },
];

const DEEP_OCR_PROFILES: OcrProfile[] = [
  { id: "full_threshold_sparse", region: "full", preprocess: "threshold", psm: "11", whitelistMode: "mixed", weight: 0.9 },
  { id: "center_invert_block", region: "center", preprocess: "invert", psm: "6", whitelistMode: "mixed", weight: 0.85 },
  { id: "bottom_threshold_digits", region: "bottom", preprocess: "threshold", psm: "11", whitelistMode: "digits", weight: 0.8 },
];

const REGION_WEIGHT: Record<OcrRegion, number> = {
  full: 0.8,
  top: 1,
  center: 1,
  bottom: 0.85,
};

export async function runMultiIterationOcrScan(input: {
  frames: FrameCandidate[];
  fuse: Fuse<ClientWineSearchItem>;
  catalogItems: ClientWineSearchItem[];
}) {
  const frames = pickBestFrames(input.frames, 3);
  const bestFrame = frames[0];

  if (!bestFrame) throw new Error("No frame candidate available");

  const dictionary = buildWineDictionary(input.catalogItems);
  const accumulator = createAccumulator();
  const candidateEvidence = new Map<string, CandidateEvidence>();
  const passes: OcrDebugPass[] = [];

  await runProfileBatch({
    frames,
    profiles: FAST_OCR_PROFILES,
    dictionary,
    accumulator,
    passes,
  });

  let queries = buildFuseQueries(accumulator);
  updateCandidateScores(candidateEvidence, queryFuseBundle(input.fuse, queries, "fast"));
  let ranked = rankCandidates(candidateEvidence);
  let decision = decideStop(ranked);
  let stage: "fast" | "deep" = "fast";

  if (decision.action !== "stop") {
    stage = "deep";
    await runProfileBatch({
      frames,
      profiles: DEEP_OCR_PROFILES,
      dictionary,
      accumulator,
      passes,
    });

    queries = buildFuseQueries(accumulator);
    updateCandidateScores(candidateEvidence, queryFuseBundle(input.fuse, queries, "deep"));
    ranked = rankCandidates(candidateEvidence);
    decision = decideStop(ranked);
  }

  const rawText = accumulator.rawTexts.filter(Boolean).join("\n---\n");
  const normalizedText = buildOutputText(accumulator);
  const confidence = estimateAccumulatorConfidence(accumulator);
  const debugCandidates = ranked.slice(0, 8);

  return {
    ocr: {
      rawText,
      normalizedText,
      confidence,
    },
    candidates: debugCandidates.map((candidate) => ({
      wineId: candidate.wineId,
      title: candidate.title,
      producer: candidate.producer,
      score: candidate.score,
      source: candidate.source,
    })),
    debugReport: {
      stage,
      decision,
      frames: frames.map((frame, index) => ({
        frameId: getFrameId(frame, index),
        quality: frame.analysis,
      })),
      passes,
      accumulator: [...accumulator.tokens.entries()]
        .map(([token, value]) => ({
          token,
          canonical: value.canonical,
          score: value.score,
          occurrences: value.occurrences,
          kind: value.kind,
          sources: value.sources.map((source) => `${source.frameId}:${source.profileId}`),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 24),
      yearCandidates: [...accumulator.yearCandidates.entries()]
        .map(([year, score]) => ({ year, score }))
        .sort((a, b) => b.score - a.score),
      rawDigitTexts: accumulator.rawDigitTexts,
      queries,
      candidates: debugCandidates,
    },
    bestFrame,
  } satisfies MultiPassOcrResult;
}

async function runProfileBatch(input: {
  frames: FrameCandidate[];
  profiles: OcrProfile[];
  dictionary: WineDictionary;
  accumulator: OcrAccumulator;
  passes: OcrDebugPass[];
}) {
  for (const [frameIndex, frame] of input.frames.entries()) {
    const frameId = getFrameId(frame, frameIndex);

    for (const profile of input.profiles) {
      const image = await createProfileImage(frame.labelCropBlob, profile);
      const ocr = await recognizeLabelText(image, {
        psm: profile.psm,
        mode: profile.whitelistMode === "digits" ? "digits" : "mixed",
        preserveInterwordSpaces: profile.whitelistMode !== "digits",
      });
      const tokens = extractTokens(ocr.normalizedText);

      if (profile.whitelistMode === "digits") {
        input.accumulator.rawDigitTexts.push(ocr.rawText);
        for (const year of extractLikelyYears(normalizeYearLikeText(ocr.rawText))) {
          const current = input.accumulator.yearCandidates.get(year) ?? 0;
          input.accumulator.yearCandidates.set(
            year,
            current + calcYearScore(ocr.confidence, frame.analysis.captureReadiness, profile.weight)
          );
        }
      } else {
        input.accumulator.rawTexts.push(ocr.rawText);
      }

      input.passes.push({
        frameId,
        profileId: profile.id,
        region: profile.region,
        preprocess: profile.preprocess,
        psm: profile.psm,
        rawText: ocr.rawText,
        normalizedText: ocr.normalizedText,
        confidence: ocr.confidence,
        tokens,
      });

      if (profile.whitelistMode === "digits") continue;

      for (const token of [...tokens, ...buildNgrams(tokens, 3), ...buildJoinedForms(tokens)]) {
        addTokenEvidence(input.accumulator, {
          token,
          dictionary: input.dictionary,
          wordConfidence: ocr.confidence,
          frameQuality: frame.analysis.captureReadiness,
          profile,
          frameId,
        });
      }
    }
  }
}

function createAccumulator(): OcrAccumulator {
  return {
    tokens: new Map(),
    rawTexts: [],
    rawDigitTexts: [],
    yearCandidates: new Map(),
  };
}

function pickBestFrames(frames: FrameCandidate[], count: number) {
  return [...frames].sort((a, b) => b.analysis.captureReadiness - a.analysis.captureReadiness).slice(0, count);
}

function getFrameId(frame: FrameCandidate, index: number) {
  return `frame_${index + 1}_${Math.round(frame.timestamp)}`;
}

function extractTokens(text: string) {
  return text
    .split(/\s+/)
    .flatMap((token) => expandTokenForms([token.trim()]))
    .filter((token) => token.length >= 2);
}

function expandTokenForms(tokens: string[]) {
  const forms = new Set<string>();

  for (const raw of tokens) {
    const token = normalizeWineOcrToken(raw);
    if (token.lower.length >= 2) forms.add(token.lower);
    if (token.cyrFolded.length >= 2) forms.add(token.cyrFolded);
    if (token.latFolded.length >= 2) forms.add(token.latFolded);
  }

  return [...forms];
}

function buildNgrams(tokens: string[], maxN = 3) {
  const ngrams: string[] = [];

  for (let n = 2; n <= maxN; n++) {
    for (let i = 0; i <= tokens.length - n; i++) {
      ngrams.push(tokens.slice(i, i + n).join(" "));
    }
  }

  return ngrams;
}

function buildJoinedForms(tokens: string[]) {
  const joined: string[] = [];

  for (let i = 0; i < tokens.length - 1; i++) {
    joined.push(`${tokens[i]}${tokens[i + 1]}`);
  }

  return joined;
}

function addTokenEvidence(
  accumulator: OcrAccumulator,
  input: {
    token: string;
    dictionary: WineDictionary;
    wordConfidence: number;
    frameQuality: number;
    profile: OcrProfile;
    frameId: string;
  }
) {
  const correction = correctToken(input.token, input.dictionary);
  const key = correction.canonical ?? input.token;
  const current = accumulator.tokens.get(key) ?? {
    rawForms: [],
    canonical: correction.canonical,
    score: 0,
    occurrences: 0,
    bestConfidence: 0,
    confidenceTotal: 0,
    kind: correction.kind,
    sources: [],
  };
  const evidenceScore = calcTokenEvidenceScore({
    wordConfidence: input.wordConfidence,
    frameQuality: input.frameQuality,
    regionWeight: REGION_WEIGHT[input.profile.region],
    profileWeight: input.profile.weight,
    dictionaryBoost: correction.similarity,
  });

  current.rawForms.push(input.token);
  current.occurrences += 1;
  current.bestConfidence = Math.max(current.bestConfidence, input.wordConfidence);
  current.confidenceTotal += input.wordConfidence;
  current.score += evidenceScore;
  current.sources.push({
    frameId: input.frameId,
    profileId: input.profile.id,
    region: input.profile.region,
    confidence: input.wordConfidence,
  });

  accumulator.tokens.set(key, current);
}

function calcTokenEvidenceScore(input: {
  wordConfidence: number;
  frameQuality: number;
  regionWeight: number;
  profileWeight: number;
  dictionaryBoost: number;
}) {
  const confidenceScore = Math.max(0.15, input.wordConfidence / 100);

  return (
    0.35 * confidenceScore +
    0.25 * input.frameQuality +
    0.15 * input.regionWeight +
    0.1 * input.profileWeight +
    0.15 * input.dictionaryBoost
  );
}

function buildWineDictionary(items: ClientWineSearchItem[]): WineDictionary {
  const entries: WineDictionary["all"] = [];

  for (const item of items) {
    pushEntry(entries, item.producer, "producer");
    pushEntry(entries, item.region, "region");
    pushEntry(entries, item.color, "keyword");
    pushEntry(entries, item.sugar, "keyword");
    pushEntry(entries, item.category, "keyword");
    if (item.year) pushEntry(entries, String(item.year), "year");
    item.grapes?.forEach((value) => pushEntry(entries, value, "grape"));
    item.aliases?.forEach((value) => pushEntry(entries, value, "unknown"));
    item.title.split(/\s+/).forEach((value) => pushEntry(entries, value, "keyword"));
  }

  return {
    all: dedupeDictionary(entries),
  };
}

function pushEntry(
  entries: WineDictionary["all"],
  value: string | number | undefined,
  kind: NonNullable<AccumulatedToken["kind"]>
) {
  if (!value) return;
  const normalized = String(value).toLowerCase().trim();
  if (normalized.length >= 2) entries.push({ value: normalized, kind });
}

function dedupeDictionary(entries: WineDictionary["all"]) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.kind}:${entry.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function correctToken(token: string, dictionary: WineDictionary) {
  if (/^(19|20)\d{2}$/.test(token)) {
    return { canonical: token, similarity: 1, kind: "year" as const };
  }

  let best: { value: string; similarity: number; kind: NonNullable<AccumulatedToken["kind"]> } | null = null;
  const tokenForms = expandTokenForms([token]);

  for (const entry of dictionary.all) {
    const entryForms = expandTokenForms([entry.value]);
    const similarity = Math.max(
      ...tokenForms.flatMap((tokenForm) => entryForms.map((entryForm) => calcSimilarity(tokenForm, entryForm)))
    );
    if (!best || similarity > best.similarity) {
      best = { ...entry, similarity };
    }
  }

  if (best && best.similarity >= 0.78) {
    return {
      canonical: best.value,
      similarity: best.similarity,
      kind: best.kind,
    };
  }

  return {
    similarity: best?.similarity ?? 0,
    kind: "unknown" as const,
  };
}

function calcSimilarity(a: string, b: string) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string) {
  const rows = Array.from({ length: a.length + 1 }, (_, index) => [index]);

  for (let j = 1; j <= b.length; j++) rows[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] =
        a[i - 1] === b[j - 1]
          ? rows[i - 1][j - 1]
          : Math.min(rows[i - 1][j - 1], rows[i][j - 1], rows[i - 1][j]) + 1;
    }
  }

  return rows[a.length][b.length];
}

function buildFuseQueries(accumulator: OcrAccumulator): FuseQueryBundle {
  const tokens = [...accumulator.tokens.values()].sort((a, b) => b.score - a.score);
  const years = [...accumulator.yearCandidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([year]) => String(year))
    .slice(0, 3);
  const strong = tokens
    .filter((token) => token.canonical && token.score > 0.55)
    .flatMap((token) => expandTokenForms([token.canonical ?? ""]))
    .slice(0, 10);
  const wide = tokens
    .flatMap((token) => expandTokenForms([token.canonical ?? token.rawForms[0] ?? ""]))
    .filter(Boolean)
    .slice(0, 18);
  const entities = tokens
    .filter((token) => ["producer", "grape", "region", "year"].includes(token.kind ?? ""))
    .flatMap((token) => expandTokenForms([token.canonical ?? token.rawForms[0] ?? ""]))
    .filter(Boolean);

  return {
    strongQuery: [...new Set([...strong, ...years])].join(" "),
    wideQuery: [...new Set([...wide, ...years])].join(" "),
    entityQuery: [...new Set([...entities, ...years])].join(" "),
  };
}

function queryFuseBundle(
  fuse: Fuse<ClientWineSearchItem>,
  queries: FuseQueryBundle,
  source: string
): CandidateEvidence[] {
  const merged = new Map<string, CandidateEvidence>();
  const queryInputs: Array<[keyof FuseQueryBundle, number]> = [
    ["strongQuery", 1],
    ["entityQuery", 0.88],
    ["wideQuery", 0.72],
  ];

  for (const [queryKey, weight] of queryInputs) {
    const query = queries[queryKey];
    if (!query.trim()) continue;

    for (const candidate of searchWineCandidates(fuse, query, 8)) {
      const current = merged.get(candidate.wineId);
      const score = candidate.score * weight;
      const next: CandidateEvidence = current
        ? {
            ...current,
            textScore: Math.max(current.textScore, score),
            finalScore: Math.max(current.finalScore, score),
            sources: [...current.sources, `${source}_${queryKey}`],
          }
        : {
            ...candidate,
            textScore: score,
            finalScore: score,
            matchedTokens: query.split(/\s+/).slice(0, 8),
            sources: [`${source}_${queryKey}`],
          };

      merged.set(candidate.wineId, next);
    }
  }

  return [...merged.values()];
}

function updateCandidateScores(
  previous: Map<string, CandidateEvidence>,
  results: CandidateEvidence[]
) {
  for (const result of results) {
    const current = previous.get(result.wineId);

    if (!current) {
      previous.set(result.wineId, result);
      continue;
    }

    current.textScore = Math.max(current.textScore, result.textScore);
    current.finalScore = Math.min(1, Math.max(current.finalScore, result.finalScore) + 0.06);
    current.matchedTokens = [...new Set([...current.matchedTokens, ...result.matchedTokens])];
    current.sources = [...current.sources, ...result.sources];
  }
}

function rankCandidates(candidates: Map<string, CandidateEvidence>) {
  return [...candidates.values()].sort((a, b) => b.finalScore - a.finalScore);
}

function decideStop(candidates: CandidateEvidence[]): StopDecision {
  const [top1, top2] = candidates;

  if (!top1) return { action: "continue", reason: "need_more_evidence" };

  const margin = top2 ? top1.finalScore - top2.finalScore : top1.finalScore;

  if (top1.finalScore > 0.82 && margin > 0.14) {
    return { action: "stop", reason: "high_confidence", topWineId: top1.wineId };
  }

  if (top1.finalScore > 0.68 && margin < 0.06) {
    return { action: "ask_user", reason: "ambiguous_candidates" };
  }

  return { action: "continue", reason: "need_more_evidence" };
}

function buildOutputText(accumulator: OcrAccumulator) {
  const years = [...accumulator.yearCandidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([year]) => String(year))
    .slice(0, 2);

  return [
    ...[...accumulator.tokens.values()]
      .sort((a, b) => b.score - a.score)
      .map((token) => token.canonical ?? token.rawForms[0])
      .filter(Boolean)
      .slice(0, 16),
    ...years,
  ].join(" ");
}

function estimateAccumulatorConfidence(accumulator: OcrAccumulator) {
  const tokens = [...accumulator.tokens.values()];
  if (tokens.length === 0) return 0;

  const top = tokens.sort((a, b) => b.score - a.score).slice(0, 8);
  return Math.min(100, top.reduce((sum, token) => sum + token.bestConfidence, 0) / top.length);
}

async function createProfileImage(blob: Blob, profile: OcrProfile) {
  const bitmap = await createImageBitmap(blob);
  const region = getRegionRect(bitmap.width, bitmap.height, profile.region);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(region.width);
  canvas.height = Math.round(region.height);

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D context is not available");

  ctx.drawImage(bitmap, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  applyPreprocess(ctx, canvas, profile.preprocess);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (!nextBlob) {
        reject(new Error("Failed to create OCR profile image"));
        return;
      }

      resolve(nextBlob);
    }, "image/jpeg", 0.92);
  });
}

function getRegionRect(width: number, height: number, region: OcrRegion): Rect {
  if (region === "top") return { x: 0, y: 0, width, height: height * 0.42 };
  if (region === "center") return { x: 0, y: height * 0.22, width, height: height * 0.56 };
  if (region === "bottom") return { x: 0, y: height * 0.58, width, height: height * 0.42 };
  return { x: 0, y: 0, width, height };
}

function applyPreprocess(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, preprocess: OcrPreprocess) {
  if (preprocess === "original") return;

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] ?? 0;
    let g = data[i + 1] ?? 0;
    let b = data[i + 2] ?? 0;
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

    if (preprocess === "contrast") {
      r = clampByte((r - 128) * 1.45 + 128);
      g = clampByte((g - 128) * 1.45 + 128);
      b = clampByte((b - 128) * 1.45 + 128);
    } else if (preprocess === "threshold") {
      r = g = b = luminance > 145 ? 255 : 0;
    } else if (preprocess === "invert") {
      r = 255 - r;
      g = 255 - g;
      b = 255 - b;
    }

    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }

  ctx.putImageData(imageData, 0, 0);
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, value));
}

function normalizeYearLikeText(input: string) {
  return input
    .replace(/[oOОо]/g, "0")
    .replace(/[!Il|]/g, "1")
    .replace(/[Зз]/g, "3")
    .replace(/[Бб]/g, "6");
}

function extractLikelyYears(text: string) {
  return [...text.matchAll(/\b(19|20)\d{2}\b/g)]
    .map((match) => Number(match[0]))
    .filter((year) => year >= 1900 && year <= 2030);
}

function calcYearScore(confidence: number, frameQuality: number, profileWeight: number) {
  return 0.55 * Math.max(0.15, confidence / 100) + 0.3 * frameQuality + 0.15 * profileWeight;
}

const LAT_TO_CYR_CONFUSABLE: Record<string, string> = {
  a: "а",
  b: "в",
  e: "е",
  k: "к",
  m: "м",
  h: "н",
  o: "о",
  p: "р",
  c: "с",
  t: "т",
  x: "х",
  y: "у",
};

const CYR_TO_LAT_CONFUSABLE: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  х: "x",
  у: "y",
};

function normalizeWineOcrToken(input: string) {
  const lower = input
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}-]/gu, "");

  return {
    raw: input,
    lower,
    cyrFolded: foldConfusables(lower, LAT_TO_CYR_CONFUSABLE),
    latFolded: foldConfusables(lower, CYR_TO_LAT_CONFUSABLE),
  };
}

function foldConfusables(input: string, map: Record<string, string>) {
  return [...input].map((char) => map[char] ?? char).join("");
}
