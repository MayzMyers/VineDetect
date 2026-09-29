export type SiglipMode = "off" | "score-only" | "rerank" | "proposals";
export type SiglipLabelMode = Exclude<SiglipMode, "proposals">;

export type VisionEvidenceConfig = {
  labelMode: SiglipLabelMode;
  source: "run-override" | "server-default";
};

export type SiglipCandidateScores = {
  id: string;
  positiveScore: number;
  negativeScore: number;
  semanticScore: number;
  scores: Record<string, number>;
};

export type SemanticEvidenceV1 = {
  schemaVersion: 1;
  provider: "siglip2";
  status: "disabled" | "available" | "unavailable";
  mode: SiglipMode;
  model: { id: string; revision: string };
  preprocessing: { resize: 256; mode: "candidate-crop"; version: "candidate-crop-v1" };
  conceptSet: { id: "wine-label-v1"; version: 1 };
  fusion: { version: "label-fusion-v2"; cvWeight: .5; semanticWeight: .35; contourGeometryWeight: .15 };
  results: SiglipCandidateScores[];
  cache: { hits: number; misses: number };
  error?: { code: string; message: string };
};

export type LabelSemanticFeatures = SiglipCandidateScores & {
  provider: "siglip2";
  modelId: string;
  modelRevision: string;
  conceptSet: "wine-label-v1";
};
