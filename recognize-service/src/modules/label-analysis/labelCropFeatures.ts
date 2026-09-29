import sharp from "sharp";

export type LabelCvStage = "mask" | "morphology" | "components" | "elements" | "contours" | "palette";
export type ComponentReviewStatus = "accepted" | "rejected" | "unreviewed";
export type LabelElementType = "text" | "graphic" | "separator" | "shape" | "unknown";
export type LabelElementRole = "brand" | "product_name" | "variety" | "producer" | "year" | "description" | "logo" | "signature" | "ornament" | "separator" | "unknown" | "other";
type LegacyLabelElementType = LabelElementType | "logo" | "illustration" | "border" | "signature" | "badge" | "other";
export type LabelElementProvenance = {
  source: "manual" | "ocr" | "geometry" | "model" | "imported";
  sourceRef?: { kind: "ocr-region"; id: string };
  grouping?: { method: "manual" | "ocr-overlap" | "proximity" | "containment" | "alignment" | "model"; confidence?: number };
};
type LegacyElementProvenance = { method: "manual" | "ocr" | "geometry" | "model"; confidence?: number; grouping?: { method: "manual" | "ocr-overlap" | "proximity" } };
type ElementProvenanceInput = {
  source?: LabelElementProvenance["source"];
  method?: LegacyElementProvenance["method"];
  sourceRef?: LabelElementProvenance["sourceRef"];
  // Early schema-v4 stored grouping confidence at provenance level.
  confidence?: number;
  grouping?: LabelElementProvenance["grouping"];
};
type LegacyGroupingMeta = { method: "ocr" | "proximity" | "geometry" | "manual" | "model"; score?: number };

export type ElementOcrRegion = {
  id: string;
  level: "line" | "word";
  bbox: { x: number; y: number; width: number; height: number };
  text: string;
  confidence?: number | null;
};

export type LabelElement = {
  id: string;
  bbox: { x: number; y: number; width: number; height: number };
  sourceComponentIds: number[];
  type: LabelElementType;
  role?: LabelElementRole;
  status: ComponentReviewStatus;
  source: "auto" | "modified";
  text?: string;
  provenance?: LabelElementProvenance;
};

export type LabelCvReviewState = {
  componentDecisions?: Record<string, Exclude<ComponentReviewStatus, "unreviewed">>;
  elements?: Array<Pick<LabelElement, "id" | "sourceComponentIds" | "role" | "status" | "text"> & {
    type: LegacyLabelElementType;
    provenance?: ElementProvenanceInput;
    // Read compatibility for schema-v3 and the early schema-v4 shape.
    textRegionId?: string;
    confidence?: number | null;
    groupingMeta?: LegacyGroupingMeta;
  }>;
  elementsReviewed?: boolean;
};

export type LabelAnalysisCvConfig = {
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
  /** Optional deterministic pipeline selected from the morphology variant search. */
  morphologyPipeline?: MorphologyStep[];
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

export type MorphologyStep = {
  operation: "open" | "close" | "dilate" | "erode";
  kernel: [number, number];
  iterations: number;
};

export type MorphologyCandidate = {
  id: string;
  family: "identity" | "erode" | "dilate" | "open" | "close" | "open-dilate" | "close-erode";
  strength: "identity" | "weak" | "medium" | "strong" | "wide" | "vertical";
  pipeline: MorphologyStep[];
  config: LabelAnalysisCvConfig;
  score: number;
  metrics: {
    foregroundRatio: number;
    foregroundDelta: number;
    connectedComponentCount: number;
    smallComponentCount: number;
    largestComponentRatio: number;
    fragmentation: number;
    holesCount: number;
    boundaryDelta: number;
  };
  mask: { width: number; height: number; encoding: "rle-u8"; data: string };
  addedMask: { width: number; height: number; encoding: "rle-u8"; data: string };
  removedMask: { width: number; height: number; encoding: "rle-u8"; data: string };
};

export type MaskCandidate = {
  id: string;
  family: "dark-foreground" | "light-foreground";
  strength: "low" | "medium-low" | "medium" | "medium-high" | "high";
  config: LabelAnalysisCvConfig;
  score: number;
  metrics: {
    foregroundRatio: number;
    foregroundDelta: number;
    connectedComponentCount: number;
    smallNoiseCount: number;
    largestBlobRatio: number;
    fragmentation: number;
    edgeTouchRatio: number;
    holesCount: number;
    holeRatio: number;
    textLikeRegionCoverage: number;
  };
  mask: { width: number; height: number; encoding: "rle-u8"; data: string };
};

export type ComponentCandidate = {
  id: string;
  config: LabelAnalysisCvConfig;
  score: number;
  metrics: {
    connectedComponentCount: number;
    acceptedComponentCount: number;
    rejectedComponentCount: number;
    acceptedCoverage: number;
    fragmentation: number;
    largestComponentRatio: number;
    diagonalMergeCount: number;
  };
};

type Component = {
  id: number;
  area: number;
  bbox: { x: number; y: number; width: number; height: number };
  centroid: { x: number; y: number };
  accepted: boolean;
  proposalAccepted: boolean;
  touchesBorder: boolean;
  areaRatio: number;
  width: number;
  height: number;
  aspectRatio: number;
  fillRatio: number;
  borderTouch: { top: boolean; right: boolean; bottom: boolean; left: boolean };
  reviewStatus: ComponentReviewStatus;
};

const STAGE_ORDER: LabelCvStage[] = ["mask", "morphology", "components", "elements", "contours", "palette"];

export const DEFAULT_LABEL_ANALYSIS_CV_CONFIG: LabelAnalysisCvConfig = {
  schemaVersion: 3,
  threshold: 170,
  invert: false,
  maskSize: 192,
  maskMode: "auto",
  morphologyEnabled: true,
  morphologyOperation: "close",
  morphologyKernelWidth: 3,
  morphologyKernelHeight: 3,
  morphologyIterations: 1,
  morphologyMode: "auto",
  componentFilterPreset: "normal",
  componentMode: "auto",
  componentConnectivity: 4,
  minComponentAreaRatio: 0.0005,
  maxComponentAreaRatio: 0.7,
  maxContourPoints: 256,
  contourDetail: "balanced",
  contourSimplifyRatio: 0.005,
  contourVectorization: "bezier",
  paletteColors: 8,
  paletteMinRatio: 0.01,
};

export function normalizeLabelAnalysisCvConfig(value: unknown): LabelAnalysisCvConfig {
  const config = recordValue(value);
  const morphologyPipeline = normalizeMorphologyPipeline(config.morphologyPipeline);
  // Configs saved before mask variant search represented an explicit threshold,
  // so keep interpreting them as manual instead of silently changing their output.
  const legacyMaskMode = Object.keys(config).length > 0 ? "manual" : DEFAULT_LABEL_ANALYSIS_CV_CONFIG.maskMode;
  const legacyComponentMode = Object.keys(config).length > 0 ? "manual" : DEFAULT_LABEL_ANALYSIS_CV_CONFIG.componentMode;
  return {
    schemaVersion: 3,
    threshold: clampInteger(config.threshold, 0, 255, DEFAULT_LABEL_ANALYSIS_CV_CONFIG.threshold),
    invert: typeof config.invert === "boolean" ? config.invert : DEFAULT_LABEL_ANALYSIS_CV_CONFIG.invert,
    maskSize: clampInteger(config.maskSize, 64, 512, DEFAULT_LABEL_ANALYSIS_CV_CONFIG.maskSize),
    maskMode: config.maskMode === "auto" || config.maskMode === "candidate" || config.maskMode === "manual" ? config.maskMode : legacyMaskMode,
    morphologyEnabled: booleanValue(config.morphologyEnabled, DEFAULT_LABEL_ANALYSIS_CV_CONFIG.morphologyEnabled),
    morphologyOperation: morphologyOperation(config.morphologyOperation),
    morphologyKernelWidth: oddInteger(config.morphologyKernelWidth, 1, 21, DEFAULT_LABEL_ANALYSIS_CV_CONFIG.morphologyKernelWidth),
    morphologyKernelHeight: oddInteger(config.morphologyKernelHeight, 1, 21, DEFAULT_LABEL_ANALYSIS_CV_CONFIG.morphologyKernelHeight),
    morphologyIterations: clampInteger(config.morphologyIterations, 1, 5, DEFAULT_LABEL_ANALYSIS_CV_CONFIG.morphologyIterations),
    morphologyMode: config.morphologyMode === "manual" ? "manual" : "auto",
    ...(morphologyPipeline ? { morphologyPipeline } : {}),
    componentFilterPreset: componentFilterPreset(config.componentFilterPreset),
    componentMode: config.componentMode === "auto" || config.componentMode === "candidate" || config.componentMode === "manual" ? config.componentMode : legacyComponentMode,
    componentConnectivity: config.componentConnectivity === 8 ? 8 : 4,
    minComponentAreaRatio: clampNumber(config.minComponentAreaRatio, 0, 0.25, DEFAULT_LABEL_ANALYSIS_CV_CONFIG.minComponentAreaRatio),
    maxComponentAreaRatio: clampNumber(config.maxComponentAreaRatio, 0.01, 1, DEFAULT_LABEL_ANALYSIS_CV_CONFIG.maxComponentAreaRatio),
    maxContourPoints: clampInteger(config.maxContourPoints, 32, 2048, DEFAULT_LABEL_ANALYSIS_CV_CONFIG.maxContourPoints),
    contourDetail: contourDetail(config.contourDetail),
    contourSimplifyRatio: clampNumber(config.contourSimplifyRatio, 0.0005, 0.05, DEFAULT_LABEL_ANALYSIS_CV_CONFIG.contourSimplifyRatio),
    contourVectorization: config.contourVectorization === "polygon" ? "polygon" : "bezier",
    paletteColors: clampInteger(config.paletteColors, 1, 12, DEFAULT_LABEL_ANALYSIS_CV_CONFIG.paletteColors),
    paletteMinRatio: clampNumber(config.paletteMinRatio, 0, 0.5, DEFAULT_LABEL_ANALYSIS_CV_CONFIG.paletteMinRatio),
  };
}

export async function extractLabelCropFeatures(cropPath: string, inputConfig?: unknown, requestedStage: LabelCvStage = "palette", review: LabelCvReviewState = {}, ocrRegions: ElementOcrRegion[] = []) {
  const config = normalizeLabelAnalysisCvConfig(inputConfig);
  const componentConfig = resolveComponentPreset(config);
  const stage = normalizeStage(requestedStage);
  const pipeline = sharp(cropPath, { failOn: "none" }).rotate();
  const stats = await pipeline.clone().stats();
  const raster = await pipeline.clone().resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
    .removeAlpha().toColorspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const maskPipeline = pipeline.clone().resize({ width: config.maskSize, height: config.maskSize, fit: "inside", withoutEnlargement: true })
    .grayscale().normalize().threshold(config.threshold);
  const maskRaster = await maskPipeline.raw().toBuffer({ resolveWithObject: true });
  // Label artwork is dark on a light substrate in the common case. Keep `1` as
  // foreground throughout the CV pipeline and let `invert` explicitly select
  // light artwork instead.
  const manualMask = Uint8Array.from(maskRaster.data, (value) => config.invert ? (value >= 128 ? 1 : 0) : (value < 128 ? 1 : 0));
  const maskSearch = includesStage(stage, "mask") && config.maskMode === "auto" ? await searchMaskVariants(cropPath, componentConfig) : null;
  const maskResult = maskSearch?.selected ?? { mask: manualMask, width: maskRaster.info.width, height: maskRaster.info.height, config, score: null };
  const rawMask = maskResult.mask; const maskWidth = maskResult.width; const maskHeight = maskResult.height;
  const morphologySearch = includesStage(stage, "morphology") && config.morphologyEnabled
    ? searchMorphologyVariants(rawMask, maskWidth, maskHeight, { ...componentConfig, ...maskResult.config })
    : null;
  const autoMorphologyResult = morphologySearch?.selected ?? null;
  const morphologyResult = includesStage(stage, "morphology") && config.morphologyEnabled
    ? config.morphologyMode === "auto"
      ? autoMorphologyResult!
      : { mask: applyMorphology(rawMask, maskWidth, maskHeight, config), config, score: null }
    : { mask: new Uint8Array(rawMask), config: { ...config, morphologyEnabled: false }, score: null };
  const morphologyMask = morphologyResult.mask;
  const componentSearch = includesStage(stage, "components") ? searchComponentVariants(morphologyMask, maskWidth, maskHeight, componentConfig) : null;
  const effectiveComponentConfig = componentSearch && config.componentMode === "auto" ? componentSearch.selected.config : componentConfig;
  const componentProposals = includesStage(stage, "components") ? connectedComponents(morphologyMask, maskWidth, maskHeight, effectiveComponentConfig) : [];
  const components = applyComponentReview(componentProposals, review.componentDecisions);
  const elementProposals = includesStage(stage, "elements") ? buildElements(componentProposals, [], ocrRegions) : [];
  const useReviewedElements = review.elementsReviewed === true || Boolean(review.elements?.length);
  const elements = includesStage(stage, "elements")
    ? useReviewedElements ? buildElements(components, review.elements, ocrRegions, true) : buildElements(components, [], ocrRegions)
    : [];
  const contours = includesStage(stage, "contours")
    ? buildElementContours(morphologyMask, maskWidth, maskHeight, components, elements, { ...config, componentConnectivity: effectiveComponentConfig.componentConnectivity })
    : [];
  const palette = includesStage(stage, "palette")
    ? quantizedPalette(raster.data, raster.info.channels, config.paletteColors, config.paletteMinRatio)
    : [];
  const layers: Array<Record<string, unknown>> = [];
  if (includesStage(stage, "mask")) layers.push(maskLayer("raw-mask", "Raw threshold mask", "color-mask", rawMask, maskWidth, maskHeight));
  if (includesStage(stage, "morphology")) layers.push(maskLayer("morphology-mask", "Morphology result", "morphology", morphologyMask, maskWidth, maskHeight));
  if (includesStage(stage, "morphology")) {
    layers.push(maskLayer("morphology-added", "Pixels added by morphology", "morphology-added", maskDifference(rawMask, morphologyMask, "added"), maskWidth, maskHeight));
    layers.push(maskLayer("morphology-removed", "Pixels removed by morphology", "morphology-removed", maskDifference(rawMask, morphologyMask, "removed"), maskWidth, maskHeight));
  }
  if (includesStage(stage, "components")) layers.push({
    id: "components", name: "Connected components", kind: "components", stage: "connected-components",
    coordinateSpaceId: "label-crop", schemaVersion: 1, visibleByDefault: true,
    components: components.map((component) => ({
      id: component.id, bbox: component.bbox, centroid: component.centroid, area: component.area,
      accepted: component.accepted, proposalAccepted: component.proposalAccepted, selected: component.accepted, touchesBorder: component.touchesBorder, reviewStatus: component.reviewStatus,
      features: { area: component.area, areaRatio: component.areaRatio, width: component.width, height: component.height, aspectRatio: component.aspectRatio, fillRatio: component.fillRatio, borderTouch: component.borderTouch },
    })),
  });
  if (includesStage(stage, "elements")) layers.push({
    id: "elements", name: "Label element proposals", kind: "elements", stage: "elements",
    coordinateSpaceId: "label-crop", schemaVersion: 1, visibleByDefault: true, elements,
  });
  return {
    stage,
    palette: includesStage(stage, "palette") ? palette : [],
    quality: { entropy: finite(stats.entropy), sharpness: finite(stats.sharpness) },
    components: includesStage(stage, "components") ? components : [],
    elementProposals: includesStage(stage, "elements") ? elementProposals : [],
    elements: includesStage(stage, "elements") ? elements : [],
    contours: includesStage(stage, "contours") ? contours : [],
    stageMetrics: {
      rawCoverage: coverage(rawMask), morphologyCoverage: coverage(morphologyMask),
      componentCount: components.length, acceptedComponentCount: components.filter((component) => component.accepted).length,
      elementCount: elements.length, reviewedElementCount: elements.filter((element) => element.status !== "unreviewed").length,
      contourCount: contours.length, contourPointCount: contours.reduce((sum, contour) => sum + contour.points.length, 0), paletteColorCount: palette.length,
      morphologyAddedRatio: coverage(maskDifference(rawMask, morphologyMask, "added")), morphologyRemovedRatio: coverage(maskDifference(rawMask, morphologyMask, "removed")),
      morphologyAutoScore: morphologyResult.score ?? 0,
    },
    cvDebug: {
      schemaVersion: 3,
      source: { width: maskWidth, height: maskHeight },
      foregroundPolarity: maskResult.config.invert ? "light" : "dark",
      effectiveMaskConfig: maskResult.config,
      maskSearch: maskSearch ? {
        generatedCount: maskSearch.generatedCount,
        baselineMetrics: maskSearch.baselineMetrics,
        evaluatedCandidates: maskSearch.evaluations,
        candidates: maskSearch.shortlist,
      } : null,
      autoMorphologyConfig: autoMorphologyResult?.config ?? null,
      autoMorphologyScore: autoMorphologyResult?.score ?? null,
      morphologySearch: morphologySearch ? {
        generatedCount: morphologySearch.generatedCount,
        baselineMetrics: morphologySearch.baselineMetrics,
        evaluatedCandidates: morphologySearch.evaluations,
        candidates: morphologySearch.shortlist,
      } : null,
      effectiveMorphologyConfig: morphologyResult.config,
      componentSearch: componentSearch ? { candidates: componentSearch.candidates, selectedId: componentSearch.selected.id } : null,
      effectiveComponentConfig,
      label: { debug: { layers } },
    },
  };
}

function applyMorphology(input: Uint8Array, width: number, height: number, config: LabelAnalysisCvConfig) {
  let current = new Uint8Array(input);
  const pipeline = Array.isArray(config.morphologyPipeline) ? config.morphologyPipeline : [{ operation: config.morphologyOperation, kernel: [config.morphologyKernelWidth, config.morphologyKernelHeight] as [number, number], iterations: config.morphologyIterations }];
  for (const step of pipeline) {
    const stepConfig = { ...config, morphologyOperation: step.operation, morphologyKernelWidth: step.kernel[0], morphologyKernelHeight: step.kernel[1], morphologyIterations: step.iterations, morphologyPipeline: undefined };
    for (let iteration = 0; iteration < step.iterations; iteration += 1) {
      if (step.operation === "dilate") current = rectangularMorphology(current, width, height, stepConfig, "dilate");
      else if (step.operation === "erode") current = rectangularMorphology(current, width, height, stepConfig, "erode");
      else if (step.operation === "open") current = rectangularMorphology(rectangularMorphology(current, width, height, stepConfig, "erode"), width, height, stepConfig, "dilate");
      else current = rectangularMorphology(rectangularMorphology(current, width, height, stepConfig, "dilate"), width, height, stepConfig, "erode");
    }
  }
  return current;
}

function rectangularMorphology(input: Uint8Array, width: number, height: number, config: LabelAnalysisCvConfig, operation: "dilate" | "erode") {
  const stride = width + 1;
  const integral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y += 1) {
    let sum = 0;
    for (let x = 1; x <= width; x += 1) {
      sum += input[(y - 1) * width + x - 1] ?? 0;
      integral[y * stride + x] = (integral[(y - 1) * stride + x] ?? 0) + sum;
    }
  }
  const radiusX = Math.floor(config.morphologyKernelWidth / 2);
  const radiusY = Math.floor(config.morphologyKernelHeight / 2);
  const output = new Uint8Array(input.length);
  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - radiusY); const bottom = Math.min(height - 1, y + radiusY);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radiusX); const right = Math.min(width - 1, x + radiusX);
      const sum = (integral[(bottom + 1) * stride + right + 1] ?? 0) - (integral[top * stride + right + 1] ?? 0)
        - (integral[(bottom + 1) * stride + left] ?? 0) + (integral[top * stride + left] ?? 0);
      const area = (right - left + 1) * (bottom - top + 1);
      output[y * width + x] = operation === "dilate" ? (sum > 0 ? 1 : 0) : (sum === area ? 1 : 0);
    }
  }
  return output;
}

function connectedComponents(mask: Uint8Array, width: number, height: number, config: LabelAnalysisCvConfig) {
  const labels = new Int32Array(mask.length);
  const components: Component[] = [];
  const neighborOffsets = config.componentConnectivity === 8
    ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
    : [[0, -1], [-1, 0], [1, 0], [0, 1]];
  let id = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue;
    id += 1;
    const queue = [start]; labels[start] = id;
    let cursor = 0; let area = 0; let sumX = 0; let sumY = 0;
    let minX = width; let minY = height; let maxX = 0; let maxY = 0;
    while (cursor < queue.length) {
      const index = queue[cursor++] ?? 0; const x = index % width; const y = Math.floor(index / width);
      area += 1; sumX += x; sumY += y; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      for (const [dx, dy] of neighborOffsets) {
        const nx = x + dx!; const ny = y + dy!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (labels[neighbor] || !mask[neighbor]) continue;
        labels[neighbor] = id; queue.push(neighbor);
      }
    }
    const areaRatio = area / Math.max(1, mask.length);
    const borderTouch = { top: minY === 0, right: maxX === width - 1, bottom: maxY === height - 1, left: minX === 0 };
    const borderSides = Number(borderTouch.left) + Number(borderTouch.top) + Number(borderTouch.right) + Number(borderTouch.bottom);
    const bboxAreaRatio = ((maxX - minX + 1) * (maxY - minY + 1)) / Math.max(1, mask.length);
    const backgroundLike = borderSides >= 3 || (borderSides >= 2 && bboxAreaRatio >= 0.5);
    const componentWidth = maxX - minX + 1; const componentHeight = maxY - minY + 1;
    const accepted = !backgroundLike && areaRatio >= config.minComponentAreaRatio && areaRatio <= config.maxComponentAreaRatio;
    components.push({
      id, area, accepted, proposalAccepted: accepted,
      bbox: { x: round(minX / width), y: round(minY / height), width: round((maxX - minX + 1) / width), height: round((maxY - minY + 1) / height) },
      centroid: { x: round(sumX / area / width), y: round(sumY / area / height) },
      touchesBorder: borderSides > 0,
      areaRatio: round(areaRatio), width: componentWidth, height: componentHeight,
      aspectRatio: round(componentWidth / Math.max(1, componentHeight)), fillRatio: round(area / Math.max(1, componentWidth * componentHeight)),
      borderTouch, reviewStatus: "unreviewed",
    });
  }
  return components.sort((left, right) => right.area - left.area);
}

export function searchComponentVariants(mask: Uint8Array, width: number, height: number, config: LabelAnalysisCvConfig) {
  const evaluated = ([4, 8] as const).map((componentConnectivity) => {
    const candidateConfig: LabelAnalysisCvConfig = { ...config, componentMode: "candidate", componentConnectivity };
    const components = connectedComponents(mask, width, height, candidateConfig);
    const accepted = components.filter((component) => component.accepted);
    return {
      id: `components-${componentConnectivity}-connected`,
      config: candidateConfig,
      components,
      metrics: {
        connectedComponentCount: components.length,
        acceptedComponentCount: accepted.length,
        rejectedComponentCount: components.length - accepted.length,
        acceptedCoverage: round(accepted.reduce((sum, component) => sum + component.areaRatio, 0)),
        fragmentation: round(components.length ? components.filter((component) => component.areaRatio < .0005).length / components.length : 0),
        largestComponentRatio: round(Math.max(0, ...components.map((component) => component.areaRatio))),
        diagonalMergeCount: 0,
      },
    };
  });
  const four = evaluated[0]!; const eight = evaluated[1]!;
  const diagonalMergeCount = Math.max(0, four.metrics.connectedComponentCount - eight.metrics.connectedComponentCount);
  eight.metrics.diagonalMergeCount = diagonalMergeCount;
  const largestGrowth = eight.metrics.largestComponentRatio - four.metrics.largestComponentRatio;
  const reductionRatio = diagonalMergeCount / Math.max(1, four.metrics.connectedComponentCount);
  const eightIsSafe = diagonalMergeCount > 0 && largestGrowth <= .15 && reductionRatio <= .4
    && eight.metrics.acceptedCoverage >= four.metrics.acceptedCoverage * .9;
  const selected = eightIsSafe ? eight : four;
  const candidates: ComponentCandidate[] = evaluated.map((candidate) => ({
    id: candidate.id,
    config: candidate.config,
    score: round(topologyScore(candidate.components) + (candidate === selected ? .1 : 0)),
    metrics: candidate.metrics,
  })).sort((left, right) => Number(right.id === selected.id) - Number(left.id === selected.id));
  return { generatedCount: candidates.length, selected: candidates.find((candidate) => candidate.id === selected.id)!, candidates };
}

export function buildElementContours(mask: Uint8Array, width: number, height: number, components: Component[], elements: LabelElement[], config: LabelAnalysisCvConfig) {
  const acceptedElements = elements.filter((element) => element.status !== "rejected");
  const elementByComponent = new Map(acceptedElements.flatMap((element) => element.sourceComponentIds.map((id) => [id, element] as const)));
  const accepted = components.filter((component) => component.accepted && elementByComponent.has(component.id));
  const labels = labelForeground(mask, width, height, config.componentConnectivity);
  const ringsByComponent = traceBoundaryRings(labels, width, height);
  const perComponent = Math.max(8, Math.floor(config.maxContourPoints / Math.max(1, accepted.length)));
  const epsilon = contourEpsilon(config);
  return accepted.flatMap((component) => {
    const pixelRings = ringsByComponent.get(component.id) ?? [];
    const meaningfulRings = pixelRings.filter((ring) => Math.abs(signedArea(ring)) >= 1)
      .sort((left, right) => Math.abs(signedArea(right)) - Math.abs(signedArea(left)))
      .slice(0, Math.max(1, Math.floor(perComponent / 4)));
    const perRing = Math.max(4, Math.floor(perComponent / Math.max(1, meaningfulRings.length)));
    const element = elementByComponent.get(component.id)!;
    return meaningfulRings.map((pixelRing, ringIndex) => {
      const rawPoints = pixelRing.map(([x, y]) => [round(x / width), round(y / height)] as [number, number]);
      const points = limitClosedContour(simplifyClosedContour(rawPoints, epsilon), perRing);
      return {
        kind: "binary-boundary" as const,
        componentId: component.id,
        elementId: element.id,
        ringIndex,
        ringKind: signedArea(pixelRing) >= 0 ? "outer" as const : "hole" as const,
        rawPoints,
        points,
        vectorization: config.contourVectorization,
        ...(config.contourVectorization === "bezier" ? { bezier: closedBezierPath(points) } : {}),
        shapeDeviation: contourDeviation(rawPoints, points, width, height),
      };
    });
  }).filter((contour) => contour.points.length >= 3);
}

type PixelPoint = [number, number];
type BoundaryEdge = { from: PixelPoint; to: PixelPoint; direction: 0 | 1 | 2 | 3; used: boolean };

function labelForeground(mask: Uint8Array, width: number, height: number, connectivity: 4 | 8) {
  const labels = new Int32Array(mask.length); let id = 0;
  const offsets = connectivity === 8
    ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
    : [[0, -1], [-1, 0], [1, 0], [0, 1]];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue;
    labels[start] = ++id; const queue = [start];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]!; const x = index % width; const y = Math.floor(index / width);
      for (const [dx, dy] of offsets) {
        const nx = x + dx!; const ny = y + dy!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!mask[next] || labels[next]) continue;
        labels[next] = id; queue.push(next);
      }
    }
  }
  return labels;
}

function traceBoundaryRings(labels: Int32Array, width: number, height: number) {
  const edgesByComponent = new Map<number, BoundaryEdge[]>();
  const add = (id: number, from: PixelPoint, to: PixelPoint, direction: BoundaryEdge["direction"]) => {
    const edges = edgesByComponent.get(id) ?? [];
    edges.push({ from, to, direction, used: false }); edgesByComponent.set(id, edges);
  };
  const at = (x: number, y: number) => x < 0 || y < 0 || x >= width || y >= height ? 0 : labels[y * width + x] ?? 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const id = at(x, y); if (!id) continue;
    if (at(x, y - 1) !== id) add(id, [x, y], [x + 1, y], 0);
    if (at(x + 1, y) !== id) add(id, [x + 1, y], [x + 1, y + 1], 1);
    if (at(x, y + 1) !== id) add(id, [x + 1, y + 1], [x, y + 1], 2);
    if (at(x - 1, y) !== id) add(id, [x, y + 1], [x, y], 3);
  }
  const output = new Map<number, PixelPoint[][]>();
  for (const [id, edges] of edgesByComponent) {
    const outgoing = new Map<string, BoundaryEdge[]>();
    for (const edge of edges) {
      const key = pointKey(edge.from); const candidates = outgoing.get(key) ?? [];
      candidates.push(edge); outgoing.set(key, candidates);
    }
    const rings: PixelPoint[][] = [];
    for (const first of edges) {
      if (first.used) continue;
      const ring: PixelPoint[] = []; let edge: BoundaryEdge | undefined = first;
      const startKey = pointKey(first.from); let guard = 0;
      while (edge && !edge.used && guard++ <= edges.length) {
        edge.used = true; ring.push(edge.from);
        const endKey = pointKey(edge.to); if (endKey === startKey) break;
        const turnOrder: number[] = [((edge.direction + 1) % 4), edge.direction, ((edge.direction + 3) % 4), ((edge.direction + 2) % 4)];
        const candidates = (outgoing.get(endKey) ?? []).filter((candidate) => !candidate.used);
        edge = turnOrder.map((direction) => candidates.find((candidate) => candidate.direction === direction)).find(Boolean);
      }
      if (ring.length >= 4) rings.push(ring);
    }
    output.set(id, rings);
  }
  return output;
}

function pointKey([x, y]: PixelPoint) { return `${x}:${y}`; }
function signedArea(points: PixelPoint[]) { return points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]!; return sum + point[0] * next[1] - next[0] * point[1]; }, 0) / 2; }

function limitClosedContour(points: Array<[number, number]>, limit: number) {
  if (points.length <= limit) return points;
  const step = points.length / limit;
  return Array.from({ length: limit }, (_, index) => points[Math.floor(index * step)]!);
}

function closedBezierPath(points: Array<[number, number]>) {
  if (points.length < 3) return null;
  return {
    kind: "closed-cubic-bezier" as const,
    start: points[0]!,
    segments: points.map((point, index) => {
      const previous = points[(index - 1 + points.length) % points.length]!;
      const next = points[(index + 1) % points.length]!;
      const afterNext = points[(index + 2) % points.length]!;
      return {
        control1: [normalizedCoordinate(point[0] + (next[0] - previous[0]) / 6), normalizedCoordinate(point[1] + (next[1] - previous[1]) / 6)] as [number, number],
        control2: [normalizedCoordinate(next[0] - (afterNext[0] - point[0]) / 6), normalizedCoordinate(next[1] - (afterNext[1] - point[1]) / 6)] as [number, number],
        end: next,
      };
    }),
  };
}

function normalizedCoordinate(value: number) { return round(Math.max(0, Math.min(1, value))); }

export async function searchMaskVariants(cropPath: string, config: LabelAnalysisCvConfig) {
  const sizes = [256, 400, 512] as const;
  const strengths = [
    { id: "low" as const, delta: -32 }, { id: "medium-low" as const, delta: -16 },
    { id: "medium" as const, delta: 0 }, { id: "medium-high" as const, delta: 16 }, { id: "high" as const, delta: 32 },
  ];
  const rasters = await Promise.all(sizes.map(async (size) => {
    const raster = await sharp(cropPath, { failOn: "none" }).rotate().resize({ width: size, height: size, fit: "inside", withoutEnlargement: false })
      .grayscale().normalize().raw().toBuffer({ resolveWithObject: true });
    return { size, data: raster.data, width: raster.info.width, height: raster.info.height, center: otsuThreshold(raster.data) };
  }));
  const rawCandidates: Array<{ id: string; family: MaskCandidate["family"]; strength: MaskCandidate["strength"]; config: LabelAnalysisCvConfig; mask: Uint8Array; width: number; height: number; components: Component[] }> = [];
  for (const raster of rasters) for (const invert of [false, true]) for (const strength of strengths) {
    const threshold = Math.max(1, Math.min(254, raster.center + strength.delta));
    const mask = Uint8Array.from(raster.data, (value) => invert ? (value >= threshold ? 1 : 0) : (value < threshold ? 1 : 0));
    const candidateConfig: LabelAnalysisCvConfig = { ...config, threshold, invert, maskSize: raster.size, maskMode: "candidate" };
    const components = connectedComponents(mask, raster.width, raster.height, candidateConfig);
    rawCandidates.push({ id: `mask-${invert ? "light" : "dark"}-${raster.size}-${strength.id}-${threshold}`, family: invert ? "light-foreground" : "dark-foreground", strength: strength.id, config: candidateConfig, mask, width: raster.width, height: raster.height, components });
  }
  const baseline = rawCandidates.find((candidate) => candidate.family === "dark-foreground" && candidate.config.maskSize === 400 && candidate.strength === "medium") ?? rawCandidates[0]!;
  const baselineRatio = coverage(baseline.mask);
  const candidates = rawCandidates.map((candidate): MaskCandidate & { rawMask: Uint8Array; width: number; height: number } => {
    const metrics = maskCandidateMetrics(candidate.mask, candidate.width, candidate.height, candidate.components, baselineRatio);
    const foregroundBalance = Math.max(0, 1 - Math.abs(metrics.foregroundRatio - .38) / .62);
    const score = round(topologyScore(candidate.components) + metrics.textLikeRegionCoverage * 1.25 + foregroundBalance * .2
      - metrics.edgeTouchRatio * .45 - metrics.fragmentation * .18 - (metrics.largestBlobRatio > .82 ? .8 : 0));
    return { id: candidate.id, family: candidate.family, strength: candidate.strength, config: candidate.config, score, metrics, rawMask: candidate.mask, width: candidate.width, height: candidate.height, mask: encodedMask(candidate.mask, candidate.width, candidate.height) };
  });
  const ranked = [...candidates].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const shortlist: typeof candidates = [];
  const add = (candidate: typeof candidates[number] | undefined) => { if (candidate && shortlist.length < 4 && !shortlist.some((item) => item.id === candidate.id)) shortlist.push(candidate); };
  add(ranked[0]);
  add(ranked.find((candidate) => candidate.family !== ranked[0]!.family));
  for (const size of sizes) add(ranked.find((candidate) => candidate.config.maskSize === size));
  for (const candidate of ranked) add(candidate);
  shortlist.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const selected = ranked[0]!;
  const summarize = ({ rawMask: _rawMask, width: _width, height: _height, mask: _mask, ...candidate }: typeof candidates[number]) => candidate;
  return {
    generatedCount: candidates.length,
    baselineMetrics: maskCandidateMetrics(baseline.mask, baseline.width, baseline.height, baseline.components, baselineRatio),
    selected: { mask: selected.rawMask, width: selected.width, height: selected.height, config: selected.config, score: selected.score },
    evaluations: candidates.map(summarize),
    shortlist: shortlist.map(({ rawMask: _rawMask, width: _width, height: _height, ...candidate }) => candidate),
  };
}

function maskCandidateMetrics(mask: Uint8Array, width: number, height: number, components: Component[], baselineRatio: number): MaskCandidate["metrics"] {
  const foregroundRatio = coverage(mask); const foregroundPixels = Math.max(1, foregroundRatio * mask.length);
  const smallNoiseCount = components.filter((component) => component.areaRatio < .0005).length;
  const textLikeArea = components.filter((component) => component.areaRatio >= .0001 && component.areaRatio <= .2 && component.aspectRatio >= .08 && component.aspectRatio <= 15 && component.fillRatio <= .92)
    .reduce((sum, component) => sum + component.area, 0);
  const edgeArea = components.filter((component) => component.touchesBorder).reduce((sum, component) => sum + component.area, 0);
  const holesCount = enclosedBackgroundCount(mask, width, height);
  return {
    foregroundRatio, foregroundDelta: round(foregroundRatio - baselineRatio), connectedComponentCount: components.length,
    smallNoiseCount, largestBlobRatio: round(Math.max(0, ...components.map((component) => component.areaRatio))),
    fragmentation: round(components.length ? smallNoiseCount / components.length : 0), edgeTouchRatio: round(edgeArea / foregroundPixels),
    holesCount, holeRatio: round(holesCount / Math.max(1, components.length)), textLikeRegionCoverage: round(textLikeArea / foregroundPixels),
  };
}

function otsuThreshold(data: Uint8Array) {
  const histogram = new Uint32Array(256); for (const value of data) histogram[value] += 1;
  let sum = 0; for (let value = 0; value < 256; value += 1) sum += value * histogram[value]!;
  let backgroundWeight = 0; let backgroundSum = 0; let bestVariance = -1; let best = 127;
  for (let threshold = 0; threshold < 256; threshold += 1) {
    backgroundWeight += histogram[threshold]!; if (!backgroundWeight) continue;
    const foregroundWeight = data.length - backgroundWeight; if (!foregroundWeight) break;
    backgroundSum += threshold * histogram[threshold]!;
    const backgroundMean = backgroundSum / backgroundWeight; const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) { bestVariance = variance; best = threshold; }
  }
  return best;
}

export function searchMorphologyVariants(input: Uint8Array, width: number, height: number, config: LabelAnalysisCvConfig) {
  const strengths = [
    { id: "weak" as const, kernel: [3, 3] as [number, number], iterations: 1 },
    { id: "medium" as const, kernel: [3, 3] as [number, number], iterations: 2 },
    { id: "strong" as const, kernel: [3, 3] as [number, number], iterations: 3 },
    { id: "wide" as const, kernel: [5, 3] as [number, number], iterations: 1 },
    { id: "vertical" as const, kernel: [3, 5] as [number, number], iterations: 1 },
  ];
  const definitions: Array<{ id: string; family: MorphologyCandidate["family"]; strength: MorphologyCandidate["strength"]; pipeline: MorphologyStep[] }> = [
    { id: "morph-identity", family: "identity", strength: "identity", pipeline: [] },
    ...(["erode", "dilate", "open", "close"] as const).flatMap((operation) => strengths.map((strength) => ({
      id: `morph-${operation}-${strength.id}`, family: operation, strength: strength.id,
      pipeline: [{ operation, kernel: strength.kernel, iterations: strength.iterations }],
    }))),
    ...strengths.slice(0, 3).flatMap((strength) => ([
      { id: `morph-open-dilate-${strength.id}`, family: "open-dilate" as const, strength: strength.id, pipeline: [{ operation: "open" as const, kernel: strength.kernel, iterations: 1 }, { operation: "dilate" as const, kernel: [3, 3] as [number, number], iterations: 1 }] },
      { id: `morph-close-erode-${strength.id}`, family: "close-erode" as const, strength: strength.id, pipeline: [{ operation: "close" as const, kernel: strength.kernel, iterations: 1 }, { operation: "erode" as const, kernel: [3, 3] as [number, number], iterations: 1 }] },
    ])),
  ];
  const baselineComponents = connectedComponents(input, width, height, config);
  const baselineMetrics = morphologyMetrics(input, input, baselineComponents, width, height);
  const candidates = definitions.map((definition): MorphologyCandidate & { rawMask: Uint8Array } => {
    const primary = definition.pipeline[0];
    const candidateConfig: LabelAnalysisCvConfig = definition.pipeline.length ? {
      ...config, morphologyEnabled: true, morphologyMode: "manual", morphologyOperation: primary!.operation,
      morphologyKernelWidth: primary!.kernel[0], morphologyKernelHeight: primary!.kernel[1], morphologyIterations: primary!.iterations,
      morphologyPipeline: definition.pipeline,
    } : { ...config, morphologyEnabled: true, morphologyMode: "manual", morphologyPipeline: [] };
    const mask = definition.pipeline.length ? applyMorphology(input, width, height, candidateConfig) : new Uint8Array(input);
    const components = connectedComponents(mask, width, height, candidateConfig);
    const metrics = morphologyMetrics(input, mask, components, width, height);
    const improvement = baselineMetrics.connectedComponentCount > 0
      ? Math.max(-1, Math.min(1, (baselineMetrics.connectedComponentCount - metrics.connectedComponentCount) / baselineMetrics.connectedComponentCount)) : 0;
    const score = round(topologyScore(components) + Math.max(0, improvement) * .16
      - Math.abs(metrics.foregroundDelta) * 2.4 - Math.max(0, metrics.foregroundDelta - .12) * 4
      - metrics.fragmentation * .18 - (metrics.largestComponentRatio > .65 ? .8 : 0));
    return {
      id: definition.id, family: definition.family, strength: definition.strength, pipeline: definition.pipeline,
      config: candidateConfig, score, metrics, rawMask: mask,
      mask: encodedMask(mask, width, height),
      addedMask: encodedMask(maskDifference(input, mask, "added"), width, height),
      removedMask: encodedMask(maskDifference(input, mask, "removed"), width, height),
    };
  });
  const ranked = [...candidates].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const shortlist: typeof candidates = [];
  const identity = candidates.find((candidate) => candidate.family === "identity")!;
  shortlist.push(identity);
  for (const candidate of ranked) {
    if (shortlist.length >= 4) break;
    if (candidate.id === identity.id || shortlist.some((item) => item.family === candidate.family)) continue;
    shortlist.push(candidate);
  }
  while (shortlist.length < Math.min(4, ranked.length)) {
    const candidate = ranked.find((item) => !shortlist.some((selected) => selected.id === item.id));
    if (!candidate) break;
    shortlist.push(candidate);
  }
  shortlist.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const selected = ranked[0]!;
  return {
    generatedCount: candidates.length, baselineMetrics, selected: { mask: selected.rawMask, config: selected.config, score: selected.score },
    evaluations: candidates.map(({ rawMask: _rawMask, mask: _mask, addedMask: _addedMask, removedMask: _removedMask, ...candidate }) => candidate),
    shortlist: shortlist.map(({ rawMask: _rawMask, ...candidate }) => candidate),
  };
}

function morphologyMetrics(input: Uint8Array, output: Uint8Array, components: Component[], width: number, height: number): MorphologyCandidate["metrics"] {
  const foregroundRatio = coverage(output); const inputRatio = coverage(input);
  const smallComponentCount = components.filter((component) => component.areaRatio < .0005).length;
  const inputBoundary = boundaryPixelCount(input, width, height);
  return {
    foregroundRatio, foregroundDelta: round(foregroundRatio - inputRatio), connectedComponentCount: components.length,
    smallComponentCount, largestComponentRatio: round(Math.max(0, ...components.map((component) => component.areaRatio))),
    fragmentation: round(components.length ? smallComponentCount / components.length : 0),
    holesCount: enclosedBackgroundCount(output, width, height),
    boundaryDelta: round((boundaryPixelCount(output, width, height) - inputBoundary) / Math.max(1, inputBoundary)),
  };
}

function boundaryPixelCount(mask: Uint8Array, width: number, height: number) {
  let count = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = y * width + x;
    if (!mask[index]) continue;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || !mask[index - 1] || !mask[index + 1] || !mask[index - width] || !mask[index + width]) count += 1;
  }
  return count;
}

function enclosedBackgroundCount(mask: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(mask.length); let holes = 0;
  const flood = (start: number) => {
    const queue = [start]; visited[start] = 1; let touchesBorder = false;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]!; const x = index % width; const y = Math.floor(index / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      for (const next of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1]) {
        if (next >= 0 && !mask[next] && !visited[next]) { visited[next] = 1; queue.push(next); }
      }
    }
    return touchesBorder;
  };
  for (let index = 0; index < mask.length; index += 1) if (!mask[index] && !visited[index] && !flood(index)) holes += 1;
  return holes;
}

function topologyScore(components: Component[]) {
  const accepted = components.filter((component) => component.accepted);
  const microRatio = components.length ? components.filter((component) => component.areaRatio < 0.0005).length / components.length : 1;
  const giantPenalty = components.some((component) => component.areaRatio > 0.65) ? 1 : 0;
  const acceptedCoverage = accepted.reduce((sum, component) => sum + component.areaRatio, 0);
  const countScore = Math.min(1, accepted.length / 12) * Math.max(0, 1 - Math.max(0, accepted.length - 120) / 120);
  return round(countScore * 0.35 + Math.min(1, acceptedCoverage * 4) * 0.35 + (1 - microRatio) * 0.3 - giantPenalty * 0.8);
}

function resolveComponentPreset(config: LabelAnalysisCvConfig): LabelAnalysisCvConfig {
  const preset = config.componentFilterPreset;
  if (preset === "none") return { ...config, minComponentAreaRatio: 0, maxComponentAreaRatio: 1 };
  if (preset === "light") return { ...config, minComponentAreaRatio: 0.0002, maxComponentAreaRatio: 0.85 };
  if (preset === "strong") return { ...config, minComponentAreaRatio: 0.0015, maxComponentAreaRatio: 0.5 };
  if (preset === "normal") return { ...config, minComponentAreaRatio: 0.0005, maxComponentAreaRatio: 0.7 };
  return config;
}

function applyComponentReview(components: Component[], decisions: LabelCvReviewState["componentDecisions"] = {}) {
  return components.map((component) => {
    const decision = decisions[String(component.id)];
    if (!decision) return component;
    return { ...component, accepted: decision === "accepted", reviewStatus: decision };
  });
}

export function buildElements(components: Component[], reviewed: LabelCvReviewState["elements"] = [], ocrRegions: ElementOcrRegion[] = [], reviewedMode = Boolean(reviewed.length)): LabelElement[] {
  const available = new Map(components.filter((component) => component.accepted).map((component) => [component.id, component]));
  if (reviewedMode) {
    const claimed = new Set<number>();
    return reviewed.flatMap((element) => {
    const sourceComponents = element.sourceComponentIds
      .filter((id) => !claimed.has(id))
      .map((id) => available.get(id))
      .filter((component): component is Component => Boolean(component));
    for (const component of sourceComponents) claimed.add(component.id);
    const semantics = normalizeElementSemantics(element.type, element.role);
    return sourceComponents.length ? [{
      id: element.id, ...semantics, status: element.status, text: element.text,
      sourceComponentIds: sourceComponents.map((component) => component.id),
      bbox: unionBbox(sourceComponents.map((component) => component.bbox)), source: "modified" as const,
      provenance: normalizeElementProvenance(element.provenance, element.groupingMeta, element.textRegionId),
    }] : [];
    });
  }
  const assigned = new Set<number>();
  const groups: Component[][] = [];
  const elements: LabelElement[] = [];
  const groupingRegions = preferredGroupingRegions(ocrRegions);
  for (const region of groupingRegions) {
    const group = [...available.values()].filter((component) => !assigned.has(component.id) && componentRegionScore(component.bbox, region.bbox) >= 0.5);
    if (!group.length) continue;
    for (const component of group) assigned.add(component.id);
    elements.push({
      id: `element:ocr:${safeElementId(region.id)}`,
      bbox: unionBbox(group.map((component) => component.bbox)),
      sourceComponentIds: group.map((component) => component.id),
      type: "text",
      status: "unreviewed",
      source: "auto",
      text: region.text,
      provenance: {
        source: "ocr", sourceRef: { kind: "ocr-region", id: region.id },
        grouping: { method: "ocr-overlap", confidence: round(group.reduce((sum, component) => sum + componentRegionScore(component.bbox, region.bbox), 0) / group.length) },
      },
    });
  }
  for (const component of available.values()) {
    if (assigned.has(component.id)) continue;
    const group = groups.find((candidate) => candidate.some((other) => componentsBelongTogether(component, other)));
    if (group) group.push(component); else groups.push([component]);
  }
  elements.push(...groups.map((group, index) => ({
    id: `element:geometry:${index + 1}`, bbox: unionBbox(group.map((component) => component.bbox)),
    sourceComponentIds: group.map((component) => component.id), type: "unknown" as const, status: "unreviewed" as const, source: "auto" as const,
    provenance: { source: "geometry" as const, grouping: { method: "proximity" as const } },
  })));
  return elements;
}

function normalizeElementProvenance(value?: ElementProvenanceInput, groupingMeta?: LegacyGroupingMeta, textRegionId?: string): LabelElementProvenance {
  const sourceRef = value?.sourceRef ?? (textRegionId ? { kind: "ocr-region" as const, id: textRegionId } : undefined);
  if (value?.source) return { source: value.source, sourceRef, grouping: normalizeGrouping(value.grouping, value.confidence) };
  if (value?.method) return { source: value.method, sourceRef, grouping: normalizeGrouping(value.grouping, value.confidence) };
  if (groupingMeta?.method === "ocr") return { source: "ocr", sourceRef, grouping: { method: "ocr-overlap", confidence: groupingMeta.score } };
  if (groupingMeta?.method === "proximity") return { source: "geometry", grouping: { method: "proximity" } };
  if (groupingMeta?.method === "manual") return { source: "manual", grouping: { method: "manual" } };
  if (groupingMeta?.method === "model") return { source: "model", grouping: { method: "model", confidence: groupingMeta.score } };
  if (groupingMeta?.method === "geometry") return { source: "geometry", grouping: { method: "proximity", confidence: groupingMeta.score } };
  return { source: "manual", grouping: { method: "manual" } };
}

function normalizeGrouping(grouping?: LabelElementProvenance["grouping"], legacyConfidence?: number): LabelElementProvenance["grouping"] {
  if (!grouping) return undefined;
  return { ...grouping, confidence: grouping.confidence ?? legacyConfidence };
}

function normalizeElementSemantics(type: LegacyLabelElementType, role?: LabelElementRole): { type: LabelElementType; role?: LabelElementRole } {
  if (type === "logo") return { type: "graphic", role: role ?? "logo" };
  if (type === "signature") return { type: "graphic", role: role ?? "signature" };
  if (type === "illustration" || type === "border" || type === "badge" || type === "other") return { type: "graphic", role: role ?? "other" };
  return role ? { type, role } : { type };
}

function preferredGroupingRegions(regions: ElementOcrRegion[]) {
  const usable = regions.filter((region) => region.text.trim() && region.bbox.width > 0 && region.bbox.height > 0);
  const lines = usable.filter((region) => region.level === "line");
  return lines.length ? lines : usable.filter((region) => region.level === "word");
}

function componentRegionScore(component: Component["bbox"], region: ElementOcrRegion["bbox"]) {
  const intersection = overlap(component.x, component.x + component.width, region.x, region.x + region.width)
    * overlap(component.y, component.y + component.height, region.y, region.y + region.height);
  const coverage = intersection / Math.max(0.000001, component.width * component.height);
  const centroidX = component.x + component.width / 2;
  const centroidY = component.y + component.height / 2;
  const centroidInside = centroidX >= region.x && centroidX <= region.x + region.width && centroidY >= region.y && centroidY <= region.y + region.height;
  return Math.max(coverage, centroidInside ? 0.75 : 0);
}

function safeElementId(value: string) { return value.replace(/[^a-zA-Z0-9:_-]+/g, "-").slice(0, 120) || "region"; }

function componentsBelongTogether(left: Component, right: Component) {
  const verticalOverlap = overlap(left.bbox.y, left.bbox.y + left.bbox.height, right.bbox.y, right.bbox.y + right.bbox.height) / Math.max(0.0001, Math.min(left.bbox.height, right.bbox.height));
  const horizontalGap = Math.max(0, Math.max(left.bbox.x, right.bbox.x) - Math.min(left.bbox.x + left.bbox.width, right.bbox.x + right.bbox.width));
  const horizontalOverlap = overlap(left.bbox.x, left.bbox.x + left.bbox.width, right.bbox.x, right.bbox.x + right.bbox.width) / Math.max(0.0001, Math.min(left.bbox.width, right.bbox.width));
  const verticalGap = Math.max(0, Math.max(left.bbox.y, right.bbox.y) - Math.min(left.bbox.y + left.bbox.height, right.bbox.y + right.bbox.height));
  return (verticalOverlap >= 0.45 && horizontalGap <= Math.max(left.bbox.height, right.bbox.height) * 1.5)
    || (horizontalOverlap >= 0.55 && verticalGap <= Math.max(left.bbox.width, right.bbox.width) * 0.75);
}

function unionBbox(boxes: Component["bbox"][]) {
  const left = Math.min(...boxes.map((bbox) => bbox.x)); const top = Math.min(...boxes.map((bbox) => bbox.y));
  const right = Math.max(...boxes.map((bbox) => bbox.x + bbox.width)); const bottom = Math.max(...boxes.map((bbox) => bbox.y + bbox.height));
  return { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) };
}

function overlap(a0: number, a1: number, b0: number, b1: number) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

function maskDifference(before: Uint8Array, after: Uint8Array, kind: "added" | "removed") {
  return Uint8Array.from(before, (value, index) => kind === "added" ? Number(!value && Boolean(after[index])) : Number(Boolean(value) && !after[index]));
}

function contourEpsilon(config: LabelAnalysisCvConfig) {
  if (config.contourDetail === "precise") return 0.001;
  if (config.contourDetail === "simplified") return 0.01;
  if (config.contourDetail === "balanced") return 0.005;
  return config.contourSimplifyRatio;
}

function simplifyClosedContour(points: Array<[number, number]>, epsilon: number) {
  if (points.length < 4) return points;
  const anchor = points[0]!;
  let splitIndex = 1; let farthest = 0;
  for (let index = 1; index < points.length; index += 1) {
    const distance = Math.hypot(points[index]![0] - anchor[0], points[index]![1] - anchor[1]);
    if (distance > farthest) { farthest = distance; splitIndex = index; }
  }
  const first = rdp(points.slice(0, splitIndex + 1), epsilon);
  const second = rdp([...points.slice(splitIndex), anchor], epsilon);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function rdp(points: Array<[number, number]>, epsilon: number): Array<[number, number]> {
  if (points.length <= 2) return points;
  let maxDistance = 0; let splitIndex = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = pointLineDistance(points[index]!, points[0]!, points[points.length - 1]!);
    if (distance > maxDistance) { maxDistance = distance; splitIndex = index; }
  }
  if (maxDistance <= epsilon) return [points[0]!, points[points.length - 1]!];
  return [...rdp(points.slice(0, splitIndex + 1), epsilon).slice(0, -1), ...rdp(points.slice(splitIndex), epsilon)];
}

function pointLineDistance(point: [number, number], start: [number, number], end: [number, number]) {
  const dx = end[0] - start[0]; const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  return Math.abs(dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0]) / Math.hypot(dx, dy);
}

function contourDeviation(raw: Array<[number, number]>, simplified: Array<[number, number]>, width: number, height: number) {
  if (!raw.length || !simplified.length) return 0;
  const total = raw.reduce((sum, point) => sum + Math.min(...simplified.map((candidate) => Math.hypot((point[0] - candidate[0]) * width, (point[1] - candidate[1]) * height))), 0);
  return round(total / raw.length);
}

type PaletteBin = { count: number; sum: [number, number, number] };

export function quantizedPalette(data: Buffer, channels: number, limit: number, minRatio: number) {
  // Discretize first, then aggregate all bins belonging to one basic color.
  // Filtering and the palette size limit apply to groups, not individual shades.
  const bins = new Map<number, PaletteBin>(); let pixels = 0;
  for (let offset = 0; offset + 2 < data.length; offset += channels) {
    const r = data[offset] ?? 0; const g = data[offset + 1] ?? 0; const b = data[offset + 2] ?? 0;
    const key = (Math.floor(r / 32) << 16) | (Math.floor(g / 32) << 8) | Math.floor(b / 32);
    const bin = bins.get(key) ?? { count: 0, sum: [0, 0, 0] as [number, number, number] };
    bin.count += 1; bin.sum[0] += r; bin.sum[1] += g; bin.sum[2] += b;
    bins.set(key, bin); pixels += 1;
  }
  const groups = new Map<string, { count: number; representative: PaletteBin }>();
  for (const bin of bins.values()) {
    const rgb = bin.sum.map((sum) => sum / bin.count) as [number, number, number];
    const family = paletteColorFamily(rgb);
    const group = groups.get(family);
    if (group) {
      group.count += bin.count;
      if (bin.count > group.representative.count) group.representative = bin;
    } else groups.set(family, { count: bin.count, representative: bin });
  }
  return [...groups.values()].sort((left, right) => right.count - left.count)
    .filter((group) => pixels > 0 && group.count / pixels >= minRatio)
    .slice(0, limit).map((group) => ({
      rgb: group.representative.sum.map((sum) => Math.round(sum / group.representative.count)) as [number, number, number],
      ratio: round(group.count / pixels),
    }));
}

function paletteColorFamily([r, g, b]: [number, number, number]) {
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const chroma = max - min;
  if (max < 48 || chroma / Math.max(1, max) < .15) return max < 128 ? "neutral-dark" : "neutral-light";
  let hue = max === r ? ((g - b) / chroma) * 60
    : max === g ? (2 + (b - r) / chroma) * 60
      : (4 + (r - g) / chroma) * 60;
  hue = (hue + 360) % 360;
  // Bands distinguish genuinely new hues while keeping brighter/darker shades
  // of the same hue in one group (including across several RGB bins).
  if (hue < 15 || hue >= 345) return "red";
  if (hue < 45) return "orange";
  if (hue < 75) return "yellow";
  if (hue < 110) return "lime";
  if (hue < 165) return "green";
  if (hue < 200) return "cyan";
  if (hue < 255) return "blue";
  if (hue < 305) return "violet";
  return "magenta";
}

function maskLayer(id: string, name: string, stage: string, values: Uint8Array, width: number, height: number) {
  return { id, name, kind: "binary-mask", stage, coordinateSpaceId: "label-crop", schemaVersion: 1, visibleByDefault: true, opacity: 1,
    width, height, encoding: "rle-u8", data: encodeBinaryMaskRle(values), foregroundValue: 1, metrics: { coverage: coverage(values) } };
}

function encodedMask(values: Uint8Array, width: number, height: number): MorphologyCandidate["mask"] {
  return { width, height, encoding: "rle-u8", data: encodeBinaryMaskRle(values) };
}

function includesStage(requested: LabelCvStage, stage: LabelCvStage) { return STAGE_ORDER.indexOf(stage) <= STAGE_ORDER.indexOf(requested); }
function normalizeStage(value: unknown): LabelCvStage { return STAGE_ORDER.includes(value as LabelCvStage) ? value as LabelCvStage : "palette"; }
function coverage(values: Uint8Array) { return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0; }
function finite(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? round(value) : null; }
function round(value: number) { return Math.round(value * 10000) / 10000; }
function recordValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function booleanValue(value: unknown, fallback: boolean) { return typeof value === "boolean" ? value : fallback; }
function morphologyOperation(value: unknown): LabelAnalysisCvConfig["morphologyOperation"] { return value === "open" || value === "dilate" || value === "erode" ? value : "close"; }
function normalizeMorphologyPipeline(value: unknown): MorphologyStep[] | null {
  if (!Array.isArray(value) || value.length > 3) return null;
  if (!value.length) return [];
  const result = value.map((raw) => {
    const step = recordValue(raw); const kernel = Array.isArray(step.kernel) ? step.kernel : [];
    const operation = morphologyOperation(step.operation);
    if (!["open", "close", "dilate", "erode"].includes(String(step.operation)) || kernel.length !== 2) return null;
    return {
      operation,
      kernel: [oddInteger(kernel[0], 1, 21, 3), oddInteger(kernel[1], 1, 21, 3)] as [number, number],
      iterations: clampInteger(step.iterations, 1, 5, 1),
    };
  });
  return result.every(Boolean) ? result as MorphologyStep[] : null;
}
function componentFilterPreset(value: unknown): LabelAnalysisCvConfig["componentFilterPreset"] { return value === "none" || value === "light" || value === "strong" || value === "custom" ? value : "normal"; }
function contourDetail(value: unknown): LabelAnalysisCvConfig["contourDetail"] { return value === "precise" || value === "simplified" || value === "custom" ? value : "balanced"; }
function clampNumber(value: unknown, min: number, max: number, fallback: number) { return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback; }
function clampInteger(value: unknown, min: number, max: number, fallback: number) { return Math.round(clampNumber(value, min, max, fallback)); }
function oddInteger(value: unknown, min: number, max: number, fallback: number) { const result = clampInteger(value, min, max, fallback); return result % 2 === 0 ? Math.min(max, result + 1) : result; }

function encodeBinaryMaskRle(values: Uint8Array) {
  const runs: Array<{ value: number; length: number }> = [];
  for (const value of values) { const current = runs[runs.length - 1]; if (current?.value === value) current.length += 1; else runs.push({ value, length: 1 }); }
  const encoded = Buffer.allocUnsafe(runs.length * 8);
  for (const [index, run] of runs.entries()) { encoded.writeUInt32LE(run.value, index * 8); encoded.writeUInt32LE(run.length, index * 8 + 4); }
  return encoded.toString("base64");
}
