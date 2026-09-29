export type PipelineConfig = {
  schemaVersion: 1;
  preprocessing: {
    source: "full-image" | "bottle-roi";
    resize: {
      enabled: boolean;
      maxWidth: number;
      maxHeight: number;
    };
  };
  color: {
    colorSpace: "gray" | "hsv" | "lab";
    referenceMode: "auto-bottle-color" | "manual-samples" | "fixed-value";
    referenceColors: Array<{ r: number; g: number; b: number; weight: number }>;
    distanceThreshold: number;
  };
  threshold: {
    enabled: boolean;
    type: "binary" | "adaptive-mean" | "adaptive-gaussian" | "otsu" | "color-distance";
    value: number;
  };
  morphology: {
    enabled: boolean;
    operation: "open" | "close" | "dilate" | "erode";
    kernelWidth: number;
    kernelHeight: number;
    iterations: number;
  };
  scoring: {
    positionWeight: number;
    areaWeight: number;
    rectangularityWeight: number;
    edgeDensityWeight: number;
    colorDifferenceWeight: number;
  };
  selection: {
    minScore: number;
    maxCandidates: number;
  };
};

export type PipelinePreset = {
  revisionId: string;
  id: string;
  revision: number;
  layer: "label-roi" | "ocr-region" | "ocr-recognition" | "source-matching" | "alias-generation" | "pipeline";
  name: string;
  description: string | null;
  status: "draft" | "validated" | "deprecated";
  engineKind: string;
  engineVersion: string | null;
  config: PipelineConfig;
  createdFrom: {
    source: string;
    sourceItemId: string;
  } | null;
  createdBy: string | null;
  basedOnRevision: number | null;
  validationDatasetVersion: string | null;
  validationMetrics: Record<string, unknown> | null;
  createdAt: string;
};

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  schemaVersion: 1,
  preprocessing: {
    source: "full-image",
    resize: { enabled: true, maxWidth: 1200, maxHeight: 1600 },
  },
  color: {
    colorSpace: "lab",
    referenceMode: "auto-bottle-color",
    referenceColors: [],
    distanceThreshold: 42,
  },
  threshold: {
    enabled: true,
    type: "color-distance",
    value: 42,
  },
  morphology: {
    enabled: true,
    operation: "close",
    kernelWidth: 5,
    kernelHeight: 5,
    iterations: 1,
  },
  scoring: {
    positionWeight: 0.12,
    areaWeight: 0.16,
    rectangularityWeight: 0.14,
    edgeDensityWeight: 0.14,
    colorDifferenceWeight: 0.24,
  },
  selection: {
    minScore: 0.18,
    maxCandidates: 12,
  },
};

export function hashPipelineConfig(config: PipelineConfig) {
  const value = stableStringify(config);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
