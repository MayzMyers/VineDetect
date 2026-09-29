import type { OcrSemanticType } from "../modules/ocr/semantic.js";

export type SourceName = "svoe_vino" | "roskachestvo";

export type SourceItem = {
  source: SourceName;
  sourceItemId: string;
  title: string;
  manufacturer: string | null;
  category: string | null;
  region: string | null;
  year: number | null;
  barcode: string | null;
  color: string | null;
  description: string | null;
  imageUrls: string[];
  sourceAssetRef?: string;
  officialReference?: import("./officialReference.js").OfficialTarget;
};

export type MetadataPayload = {
  aliases: string[];
  normalizedTokens: string[];
  visualFeatures: Record<string, unknown>;
  annotations: Record<string, unknown>;
  status: string;
};

export type AliasType =
  | "normalized-title"
  | "title-without-service-words"
  | "manufacturer"
  | "category"
  | "region"
  | "year"
  | "barcode";

export type Alias = {
  value: string;
  type: AliasType;
  weight: number;
};

export type AliasSet = {
  schemaVersion: 1;
  generatorVersion: string;
  normalizationVersion: string;
  aliases: Alias[];
  generatedAt: string;
};

export type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ColorZone = NormalizedRect & {
  averageLab: [number, number, number];
  saturation: number;
  lightness: number;
};

export type CvMetaV1 = {
  schemaVersion: 1 | 2;
  extractorVersion: string;
  source: {
    imageId: string;
    width: number;
    height: number;
    aspectRatio: number;
  };
  color: {
    averageLab: [number, number, number];
    dominantLab: Array<{ value: [number, number, number]; ratio: number }>;
    zones: ColorZone[];
  };
  geometry: Record<string, unknown>;
  hashes: {
    dHash?: string;
  };
  quality: {
    sourceScore: number;
    sharpness?: number;
    exposure?: Record<string, number>;
    warnings: string[];
  };
  sourceImage?: Record<string, unknown>;
  background?: Record<string, unknown>;
  foreground?: Record<string, unknown>;
  bottle?: Record<string, unknown>;
  label?: Record<string, unknown>;
  colors?: Record<string, unknown>;
  ocr?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
};

export type RecognizeJobType =
  | "ANNOTATION_HELPER_PIPELINE"
  | "ANNOTATION_LLM_PIPELINE"
  | "ANALYZE_LABEL"
  | "GENERATE_ALIASES"
  | "GENERATE_DETECTION_PROPOSAL"
  | "GENERATE_CV_META"
  | "GENERATE_ALL_META"
  | "REGENERATE_ALL_META";

export type LabelAnalysisTextRegion = {
  id: string;
  parentId: string | null;
  level: "line" | "word";
  bbox: NormalizedRect;
  geometry?: {
    type: "quad";
    points: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
    bbox: NormalizedRect;
  };
  rawText: string;
  normalizedText: string;
  confidence: number | null;
  textDirection: "right" | "left" | "down" | "up" | "mixed";
  glyphOrientation: "upright" | "clockwise" | "counterclockwise" | "upside-down" | "mixed";
  semantic: {
    type: OcrSemanticType;
    confidence: number;
    reasons: string[];
  } | null;
};

export type LabelAnalysisSourceMatch = {
  ocrRegionId: string;
  regionText: string;
  sourceField: string;
  sourceValue: string;
  score: number;
  matchKind: "exact" | "contains" | "token-overlap";
  lexicalScore: number;
  semanticType: OcrSemanticType;
  semanticConfidence: number;
  semanticCompatibility: number;
};

export type LabelAnalysisCatalogCandidate = {
  source: SourceName;
  sourceItemId: string;
  title: string;
  manufacturer: string | null;
  score: number;
  matchedRegionCount: number;
  isCurrentItem: boolean;
  matches: Array<{
    ocrRegionId: string; regionText: string; semanticType: OcrSemanticType;
    sourceField: string; sourceValue: string; lexicalScore: number;
    semanticCompatibility: number; score: number;
    matchKind: "exact" | "contains" | "token-overlap" | "fuzzy";
  }>;
};

export type OcrCascadeEvidenceV1 = {
  schemaVersion: 1;
  profileVersion: string;
  completedStage: "cheap" | "deep" | "rescue";
  stopReason: "strong-cheap-evidence" | "strong-deep-evidence" | "strong-rescue-evidence" | "rescue-exhausted";
  passes: Array<{
    id: string; stage: "cheap" | "deep" | "rescue"; region: "full" | "top" | "center" | "bottom";
    preprocess: "normalized" | "contrast" | "threshold" | "invert" | "clahe" | "adaptive-threshold" | "glare-suppressed" | "deskew" | "perspective" | "rotate-cw" | "rotate-ccw"; psm: string;
    minWidth: number; weight: number; rawText: string; normalizedText: string;
    confidence: number; runtimeMs: number; observationCount: number; validObservationCount: number; deskewAngleDegrees: number | null; rotationDegrees: number | null;
  }>;
  observations: Array<{
    id: string; passId: string; profileWeight: number; parentObservationId: string | null; level: "line" | "word";
    bbox: NormalizedRect; rawText: string; normalizedText: string; confidence: number | null;
    validityScore: number; valid: boolean; rejectionReasons: string[];
    textDirection: "right" | "left" | "down" | "up" | "mixed";
    glyphOrientation: "upright" | "clockwise" | "counterclockwise" | "upside-down" | "mixed";
  }>;
  consensusRegions: Array<{
    key: string; parentKey: string | null; level: "line" | "word"; bbox: NormalizedRect;
    rawText: string; normalizedText: string; confidence: number | null; support: number;
    passIds: string[]; observationIds: string[]; validityScore: number;
    textConsensus: number; spatialConsensus: number; consensus: number;
    semantic: {
      type: OcrSemanticType;
      confidence: number;
      reasons: string[];
    };
    textDirection: "right" | "left" | "down" | "up" | "mixed";
    glyphOrientation: "upright" | "clockwise" | "counterclockwise" | "upside-down" | "mixed";
  }>;
  geometry: {
    evaluated: boolean; angleDegrees: number | null; confidence: number; applied: boolean;
    method: "component-baseline-v1";
    perspective: {
      evaluated: boolean; applied: boolean; confidence: number; distortion: number;
      corners: null | { topLeft: { x: number; y: number }; topRight: { x: number; y: number }; bottomRight: { x: number; y: number }; bottomLeft: { x: number; y: number } };
      method: "directional-edge-quad-v1";
    };
  };
  quality: {
    observationCount: number; validObservationCount: number; rejectedObservationCount: number;
    consensusRegionCount: number; supportedConsensusRegionCount: number;
    averageOcrConfidence: number; averageValidityScore: number; averageConsensus: number;
    semanticRegionCount: number; highConfidenceSemanticRegionCount: number;
  };
};

export type LabelAnalysisResultV2 = {
  schemaVersion: 2;
  jobId: string;
  annotationId: string;
  annotationRevision: number;
  crop: {
    id: string;
    assetPath: string;
    sourceImage: string;
    sourceRect: { x: number; y: number; width: number; height: number };
    sourceGeometry: {
      type: "quad";
      points: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
      bbox: { x: number; y: number; width: number; height: number };
    };
    width: number;
    height: number;
    transformMode?: "source-bbox" | "perspective" | "guided-cylindrical";
  };
  ocr: {
    runId: string;
    engine: string;
    engineVersion: string | null;
    rawText: string;
    normalizedText: string;
    confidence: number | null;
    runtimeMs: number | null;
    evidence: OcrCascadeEvidenceV1 | null;
  };
  textRegions: LabelAnalysisTextRegion[];
  sourceMatches: LabelAnalysisSourceMatch[];
  catalogCandidates: LabelAnalysisCatalogCandidate[];
  visualFeatures: {
    palette: Array<{ rgb: [number, number, number]; ratio: number }>;
    quality: { entropy: number | null; sharpness: number | null };
    components: Array<{
      id: number;
      area: number;
      bbox: { x: number; y: number; width: number; height: number };
      centroid: { x: number; y: number };
      accepted: boolean;
      proposalAccepted: boolean;
      areaRatio: number;
      width: number;
      height: number;
      aspectRatio: number;
      fillRatio: number;
      borderTouch: { top: boolean; right: boolean; bottom: boolean; left: boolean };
      reviewStatus: "accepted" | "rejected" | "unreviewed";
    }>;
    elements: Array<{
      id: string; bbox: { x: number; y: number; width: number; height: number }; sourceComponentIds: number[];
      type: "text" | "graphic" | "separator" | "shape" | "unknown";
      role?: "brand" | "product_name" | "variety" | "producer" | "year" | "description" | "logo" | "signature" | "ornament" | "separator" | "unknown" | "other";
      status: "accepted" | "rejected" | "unreviewed"; source: "auto" | "modified"; text?: string;
      provenance?: { source: "manual" | "ocr" | "geometry" | "model" | "imported"; sourceRef?: { kind: "ocr-region"; id: string }; grouping?: { method: "manual" | "ocr-overlap" | "proximity" | "containment" | "alignment" | "model"; confidence?: number } };
    }>;
    elementProposals: Array<{
      id: string; bbox: { x: number; y: number; width: number; height: number }; sourceComponentIds: number[];
      type: "text" | "graphic" | "separator" | "shape" | "unknown";
      role?: "brand" | "product_name" | "variety" | "producer" | "year" | "description" | "logo" | "signature" | "ornament" | "separator" | "unknown" | "other";
      status: "accepted" | "rejected" | "unreviewed"; source: "auto" | "modified"; text?: string;
      provenance?: { source: "manual" | "ocr" | "geometry" | "model" | "imported"; sourceRef?: { kind: "ocr-region"; id: string }; grouping?: { method: "manual" | "ocr-overlap" | "proximity" | "containment" | "alignment" | "model"; confidence?: number } };
    }>;
    contours: Array<{ kind: "binary-boundary"; componentId: number; elementId: string; ringIndex?: number; ringKind?: "outer" | "hole"; rawPoints: Array<[number, number]>; points: Array<[number, number]>; vectorization?: "polygon" | "bezier"; bezier?: { kind: "closed-cubic-bezier"; start: [number, number]; segments: Array<{ control1: [number, number]; control2: [number, number]; end: [number, number] }> } | null; shapeDeviation: number }>;
    stage: "mask" | "morphology" | "components" | "elements" | "contours" | "palette";
    stageMetrics: Record<string, number>;
    cvDebug: Record<string, unknown>;
  };
  configSnapshot: {
    schemaVersion: 3;
    threshold: number;
    invert: boolean;
    maskSize: number;
    maskMode: "auto" | "candidate" | "manual";
    morphologyEnabled: boolean;
    morphologyOperation: "open" | "close" | "dilate" | "erode";
    morphologyKernelWidth: number;
    morphologyKernelHeight: number;
    morphologyIterations: number;
    morphologyMode: "auto" | "manual";
    morphologyPipeline?: Array<{ operation: "open" | "close" | "dilate" | "erode"; kernel: [number, number]; iterations: number }>;
    componentFilterPreset: "none" | "light" | "normal" | "strong" | "custom";
    componentMode: "auto" | "candidate" | "manual";
    componentConnectivity: 4 | 8;
    minComponentAreaRatio: number;
    maxComponentAreaRatio: number;
    maxContourPoints: number;
    contourDetail: "precise" | "balanced" | "simplified" | "custom";
    contourSimplifyRatio: number;
    contourVectorization: "polygon" | "bezier";
    paletteColors: number;
    paletteMinRatio: number;
  };
  warnings: string[];
  runtimeMs: number;
  provenance: {
    pipelineVersion: "label-analysis-v2";
    analysisProfileVersion: string;
    engine: "detector-free-label-analysis";
    configHash: string;
  };
};
