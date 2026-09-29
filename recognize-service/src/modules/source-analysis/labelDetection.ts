import sharp from "sharp";

export type Rect = { x: number; y: number; width: number; height: number };
export type AutoLabelConfigV1 = {
  schemaVersion: 1;
  previewMaxSide: number;
  chromaTolerance: number;
  minimumLightness: number;
  minRegionWidthRatio: number;
  maxRegionWidthRatio: number;
  rowGapRatio: number;
  minimumBandCoverage: number;
  envelopeCoverage: number;
  envelopeSizeMultiplier: number;
};
export type PackageAwareLabelContext = {
  bbox: Rect;
  contour: Array<[number, number]>;
  packageType?: "bottle" | "box" | "tube" | "other" | "unknown";
  confidence?: number | null;
  source: "accepted-package-helper" | "reviewed-package-geometry" | "runtime-package-helper";
};
export type BottlePackageZone = "neck" | "shoulder" | "body" | "base";
export type BottleZoneModel = {
  algorithm: "bottle-contour-zones-v1";
  boundaries: { neckEndY: number; shoulderEndY: number; baseStartY: number };
  normalizedBoundaries: { neckEnd: number; shoulderEnd: number; baseStart: number };
  confidence: number;
  evidence: { sampleCount: number; maximumWidth: number; neckWidthRatio: number; bodyWidthRatio: number };
};
type PassConfig = { id: string; blurKernel: 3 | 5; low: number; high: number };
type Raster = { data: Buffer; width: number; height: number };
type ColorRaster = Raster & { channels: number };
type RawCandidate = { bbox: Rect; pass: PassConfig; edgeSupport: number; rectangularity: number; solidity: number; areaRatio: number; positionScore: number };
export type DetectorCandidate = {
  id: string;
  bbox: Rect;
  polygon: Array<[number, number]>;
  score: number;
  variant?: {
    groupId: string;
    kind: "tight" | "boundary-probed";
    mutuallyExclusive: true;
    areaDeltaRatio: number;
  };
  metrics: {
    edgeSupport: number; rectangularity: number; solidity: number; stability: number; areaRatio: number;
    packageEdgeAffinity?: number; bodyColorContinuation?: number; labelBoundaryContrast?: number;
    packageBottomAffinity?: number; sideInsetFromPackageContour?: number;
    packageEdgeAffinities?: { top: number; right: number; bottom: number; left: number };
    refinedEdges?: Array<"top" | "right" | "bottom" | "left">;
    boundaryProbe?: {
      algorithm: "package-local-boundary-probe-v1";
      edges: Partial<Record<"top" | "right" | "bottom" | "left", {
        action: "expand" | "keep" | "contract"; position: number; score: number;
        contrast: number; coverage: number; outsideBodySimilarity: number;
        insideBodyDifference: number; textLikeDrop: number; sideTermination: number; discardedTextLike: number; retainedTextLike: number;
      }>>;
      baseIntrusion: number;
    };
  };
  geometrySemantic?: {
    schemaVersion: 1;
    algorithm: "bottle-label-geometry-v2";
    role: "front-label" | "neck-label";
    verdict: "likely" | "unlikely";
    confidence: number;
    features: {
      normalizedCenterY: number;
      horizontalCentrality: number;
      localPackageWidthRatio: number;
      packageAreaRatio: number;
      packageHeightRatio: number;
      relativeCandidateArea: number;
      aspectRatio: number;
      independentAlternatives: number;
      containedAlternatives: number;
      packageZone: BottlePackageZone;
      packageZoneConfidence: number;
    };
  };
  detection: { passId: string; passIds: string[]; config: Record<string, unknown> };
};
type DetectorFamily = "edge" | "color" | "text" | "other";
type NeutralProfile = { id: string; family: "neutral"; chromaOffset: number; lightnessOffset: number; coverageOffset: number; rowGapOffset: number };
type BoundaryProfile = { id: string; family: "horizontal" | "color"; differenceThreshold: number; minimumDensity: number; blurKernel: 3 | 5 };

const PASSES: PassConfig[] = [
  { id: "soft", blurKernel: 3, low: 25, high: 70 },
  { id: "normal", blurKernel: 3, low: 40, high: 100 },
  { id: "hard", blurKernel: 3, low: 60, high: 150 },
  { id: "normal-blur5", blurKernel: 5, low: 40, high: 100 },
];

const NEUTRAL_PROFILES: NeutralProfile[] = [
  { id: "neutral-balanced", family: "neutral", chromaOffset: 0, lightnessOffset: 0, coverageOffset: 0, rowGapOffset: 0 },
  { id: "neutral-permissive", family: "neutral", chromaOffset: 10, lightnessOffset: -22, coverageOffset: -.08, rowGapOffset: .035 },
  { id: "neutral-strict", family: "neutral", chromaOffset: -7, lightnessOffset: 18, coverageOffset: .07, rowGapOffset: -.02 },
];
const BOUNDARY_PROFILES: BoundaryProfile[] = [
  { id: "horizontal-soft", family: "horizontal", differenceThreshold: 20, minimumDensity: .13, blurKernel: 5 },
  { id: "horizontal-balanced", family: "horizontal", differenceThreshold: 26, minimumDensity: .16, blurKernel: 3 },
  { id: "horizontal-strong", family: "horizontal", differenceThreshold: 34, minimumDensity: .18, blurKernel: 3 },
];
const COLOR_BOUNDARY_PROFILES: BoundaryProfile[] = [
  { id: "color-boundary-soft", family: "color", differenceThreshold: 28, minimumDensity: .11, blurKernel: 3 },
  { id: "color-boundary-strong", family: "color", differenceThreshold: 44, minimumDensity: .09, blurKernel: 3 },
];

export const DEFAULT_AUTO_LABEL_CONFIG: AutoLabelConfigV1 = {
  schemaVersion: 1,
  previewMaxSide: 720,
  chromaTolerance: 24,
  minimumLightness: 105,
  minRegionWidthRatio: .42,
  maxRegionWidthRatio: .985,
  rowGapRatio: .09,
  minimumBandCoverage: .48,
  envelopeCoverage: .65,
  envelopeSizeMultiplier: 1.45,
};

export async function runLabelDetection(filePath: string, sourceWidth: number, sourceHeight: number, inputConfig?: Partial<AutoLabelConfigV1>, packageContext?: PackageAwareLabelContext | null) {
  const config = normalizeAutoLabelConfig(inputConfig);
  const passResults: Array<{ config: PassConfig; contourCount: number; candidates: RawCandidate[] }> = [];
  const grayRasters = new Map<3 | 5, Raster>();
  for (const passConfig of PASSES) {
    let raster = grayRasters.get(passConfig.blurKernel);
    if (!raster) {
      raster = await loadGray(filePath, passConfig.blurKernel, config.previewMaxSide);
      grayRasters.set(passConfig.blurKernel, raster);
    }
    const edgeMask = hysteresisEdges(raster, passConfig.low, passConfig.high);
    const closed = erode(dilate(edgeMask, raster.width, raster.height), raster.width, raster.height);
    const components = connectedComponents(closed, raster.width, raster.height);
    const candidates = components.map((component) => scoreComponent(component, raster.width, raster.height, passConfig, sourceWidth, sourceHeight)).filter((value): value is RawCandidate => Boolean(value));
    passResults.push({ config: passConfig, contourCount: components.length, candidates: suppressOverlaps(candidates).slice(0, 40) });
  }
  const clusters = clusterCandidates(passResults.flatMap((result) => result.candidates));
  const clusteredCandidates = clusters.map((cluster, index) => {
    const passIds = [...new Set(cluster.map((item) => item.pass.id))];
    const stability = passIds.length / PASSES.length;
    const representative = weightedRect(cluster);
    const metrics = averageMetrics(cluster);
    const score = clamp01(stability * 0.38 + metrics.edgeSupport * 0.2 + metrics.rectangularity * 0.12 + metrics.solidity * 0.08 + areaPreference(metrics.areaRatio) * 0.12 + metrics.positionScore * 0.1);
    return {
      id: `label-canny-${index + 1}`,
      bbox: representative,
      polygon: rectPolygon(representative),
      score: round(score),
      metrics: { edgeSupport: round(metrics.edgeSupport), rectangularity: round(metrics.rectangularity), solidity: round(metrics.solidity), stability: round(stability), areaRatio: round(metrics.areaRatio) },
      detection: { passId: passIds[0] ?? "unknown", passIds, config: cluster[0]?.pass ?? {} },
    };
  });
  let searchWindow = sourceWidth / sourceHeight >= .65 ? labelSearchWindow(clusteredCandidates, sourceWidth, sourceHeight) : null;
  const colorRaster = await loadColor(filePath, config.previewMaxSide);
  const runRegionDetectors = (window: Rect | null) => {
    const neutralRuns = NEUTRAL_PROFILES.map((profile) => detectNeutralLabelRegions(colorRaster, sourceWidth, sourceHeight, window, config, profile, packageContext));
    const saturatedRun = detectSaturatedLabelRegions(colorRaster, sourceWidth, sourceHeight, window);
    const packageMaterialRun = packageContext?.packageType === "bottle"
      ? detectPackageMaterialLabelRegions(
          colorRaster,
          sourceWidth,
          sourceHeight,
          packageContext,
          neutralRuns.flatMap((run) => run.bands.map((band) => ({ ...band, profileId: run.id }))),
        )
      : null;
    const boundaryRuns = [
      ...BOUNDARY_PROFILES.map((profile) => {
        const raster = grayRasters.get(profile.blurKernel);
        if (!raster) throw new Error(`Missing cached grayscale preview for ${profile.id}`);
        return detectHorizontalBoundaryRegions(raster, sourceWidth, sourceHeight, window, profile);
      }),
      ...COLOR_BOUNDARY_PROFILES.map((profile) => detectHorizontalBoundaryRegions(colorRaster, sourceWidth, sourceHeight, window, profile)),
    ];
    return { neutralRuns, boundaryRuns, detectorRuns: [...neutralRuns, saturatedRun, ...(packageMaterialRun ? [packageMaterialRun] : []), ...boundaryRuns] };
  };
  let { neutralRuns, detectorRuns } = runRegionDetectors(searchWindow);
  const envelope = buildLabelEnvelope(clusteredCandidates, sourceWidth, sourceHeight);
  // Canny components are not extra EDGE votes. Their spatial envelope is used
  // once as a low-weight text-density proposal: it describes where printed
  // information clusters, while EDGE and COLOR still own the outer boundary.
  const aggregateRegionCandidates = () => {
    const rawProposals = [
      ...detectorRuns.flatMap((run) => run.candidates),
      ...(envelope ? [{
        ...envelope,
        detection: {
          ...envelope.detection,
          passId: "text-density-envelope",
          passIds: ["text-density-envelope"],
          config: { family: "text", method: "canny-component-envelope", trainingRole: "proposal-evidence" },
        },
      }] : []),
    ];
    const familyAggregation = aggregateDetectorFamilies(rawProposals, sourceWidth, sourceHeight);
    const consensus = buildDetectorConsensus(familyAggregation.candidates, sourceWidth, sourceHeight);
    const consolidated = mergeAlignedConsensusFragments(consensus.candidates, sourceWidth, sourceHeight);
    const refinedRegionCandidates = removeAdjacentSingleFamilyBodyBands(
      removePortraitBottleBodyCandidates(
        removeNestedDetectorCandidates(consolidated.candidates, sourceWidth, sourceHeight, colorRaster),
        sourceWidth,
        sourceHeight,
      ),
      sourceWidth,
      sourceHeight,
    )
      .slice(0, 6)
      .map((candidate) => snapBottomCandidateToTextureBand(candidate, colorRaster, sourceWidth, sourceHeight))
      .map((candidate) => trimDarkBottleTail(candidate, colorRaster, sourceWidth, sourceHeight))
      .map((candidate) => extendToStrongerLowerBoundary(candidate, colorRaster, sourceWidth, sourceHeight));
    // Geometry refinement can turn a former bottle-shell proposal into the
    // correct outer label. Re-run nesting suppression to remove internal
    // content boxes that were intentionally retained before the snap.
    const packageAwareCandidates = packageContext
      ? refineCandidatesWithPackageContext(refinedRegionCandidates, colorRaster, sourceWidth, sourceHeight, packageContext)
      : refinedRegionCandidates;
    const regionCandidates = removeNestedDetectorCandidates(packageAwareCandidates, sourceWidth, sourceHeight, colorRaster);
    return { familyAggregation, consensus, consolidated, regionCandidates };
  };
  let aggregation = aggregateRegionCandidates();
  let recoveryMode: "none" | "bottle-window" = "none";
  if (!aggregation.regionCandidates.length && !searchWindow) {
    const recoveryWindow = labelSearchWindow(clusteredCandidates, sourceWidth, sourceHeight);
    if (recoveryWindow) {
      searchWindow = recoveryWindow;
      ({ neutralRuns, detectorRuns } = runRegionDetectors(searchWindow));
      aggregation = aggregateRegionCandidates();
      recoveryMode = "bottle-window";
    }
  }
  const { familyAggregation, consensus, consolidated, regionCandidates } = aggregation;
  const bestRegion = regionCandidates[0] ?? null;
  const envelopeSupersedesPartialRegion = Boolean(bestRegion && envelope
    && overlapOverSmaller(envelope.bbox, bestRegion.bbox) >= config.envelopeCoverage
    && envelope.bbox.width * envelope.bbox.height >= bestRegion.bbox.width * bestRegion.bbox.height * config.envelopeSizeMultiplier
    // A text envelope spanning most of a portrait product image is normally
    // the bottle silhouette/background texture, not one label region.
    && envelope.bbox.height / Math.max(1, sourceHeight) <= .5);
  const primaryRegion = envelopeSupersedesPartialRegion ? envelope : bestRegion ?? envelope;
  const exposedRegions = envelopeSupersedesPartialRegion ? [] : regionCandidates;
  const cannyFallbacks = [...clusteredCandidates, ...(envelope ? [envelope] : [])].filter((candidate) => primaryRegion ? (
    rectIoU(candidate.bbox, primaryRegion.bbox) >= .35
    && candidate.bbox.width * candidate.bbox.height >= primaryRegion.bbox.width * primaryRegion.bbox.height * .6
  ) : candidate.bbox.height / sourceHeight <= .5);
  // Once at least one region detector has a stable result, Canny remains debug
  // evidence only. Otherwise a bottle-sized connected component can outrank a
  // real label merely because its outline is stronger.
  const exposedFallbacks = regionCandidates.length > 0 ? [] : cannyFallbacks;
  const candidates: DetectorCandidate[] = suppressCandidateOverlaps([...exposedRegions, ...exposedFallbacks], .82)
    .sort((left, right) => right.score - left.score)
    .slice(0, 12)
    .map((candidate, index) => ({
      ...candidate,
      id: candidate.detection.passId === "multi-profile-consensus"
        ? `label-consensus-${index + 1}`
        : candidate.detection.passId.startsWith("neutral-")
        ? `label-region-${index + 1}`
        : candidate.detection.passId.startsWith("horizontal-")
          ? `label-boundary-${index + 1}`
          : `label-canny-${index + 1}`,
    }));
  const reviewCandidates = packageContext?.packageType === "bottle"
    ? createBoundaryReviewVariants(candidates).slice(0, 12)
    : candidates;
  const classifiedCandidates = packageContext?.packageType === "bottle"
    ? classifyBottleLabelCandidates(reviewCandidates, packageContext)
    : reviewCandidates;
  return {
    algorithm: packageContext ? "label-multi-family-consensus-v7" : "label-multi-family-consensus-v4",
    config,
    candidates: classifiedCandidates,
    debug: {
      preview: { width: colorRaster.width, height: colorRaster.height, maxSide: config.previewMaxSide },
      searchWindow,
      recoveryMode,
      neutralBands: neutralRuns.flatMap((run) => run.bands.map((band) => ({ ...band, profileId: run.id }))),
      detectorRuns: detectorRuns.map((run) => ({ id: run.id, family: run.family, config: run.config, candidateCount: run.candidates.length })),
      familyCandidates: familyAggregation.debug,
      consensusClusters: consensus.clusters,
      fragmentMerges: consolidated.merges,
      cannyEvidence: clusteredCandidates.map((candidate) => ({ bbox: candidate.bbox, score: candidate.score, passIds: candidate.detection.passIds })),
      envelope: envelope?.bbox ?? null,
      packageAware: packageContext ? {
        mode: "package-aware",
        source: packageContext.source,
        packageType: packageContext.packageType ?? "unknown",
        contourPointCount: packageContext.contour.length,
        bbox: packageContext.bbox,
      } : { mode: "standalone" },
      labelGeometry: packageContext?.packageType === "bottle" ? {
        algorithm: "bottle-label-geometry-v2",
        zoneModel: deriveBottleZoneModel(packageContext),
        likelyCandidateIds: classifiedCandidates.filter((candidate) => candidate.geometrySemantic?.verdict === "likely").map((candidate) => candidate.id),
      } : null,
    },
    passes: [...detectorRuns.map((run) => ({
      id: run.id,
      config: run.config,
      candidateIds: candidates.filter((candidate) => candidate.detection.passIds.includes(run.id)).map((candidate) => candidate.id),
      stats: { contourCount: run.evidenceCount, acceptedCount: run.candidates.length },
    })), ...passResults.map((result) => ({
      id: result.config.id,
      config: result.config,
      candidateIds: candidates.filter((candidate) => (candidate.detection.passIds as string[]).includes(result.config.id)).map((candidate) => candidate.id),
      stats: { contourCount: result.contourCount, acceptedCount: result.candidates.length },
    }))],
  };
}

/**
 * Preserve a materially different pre-probe ROI as a review alternative.
 * These are competing geometries for one physical Label, not independent
 * annotations. Downstream reviewers must select at most one candidate from a
 * variant group.
 */
export function createBoundaryReviewVariants(candidates: DetectorCandidate[]): DetectorCandidate[] {
  return candidates.flatMap((candidate) => {
    const probeConfig = candidate.detection.config.boundaryProbe;
    if (!probeConfig || typeof probeConfig !== "object" || Array.isArray(probeConfig)) return [candidate];
    const from = readRect((probeConfig as Record<string, unknown>).from);
    if (!from) return [candidate];
    const area = Math.max(1, candidate.bbox.width * candidate.bbox.height);
    const fromArea = Math.max(1, from.width * from.height);
    const areaDeltaRatio = Math.abs(area - fromArea) / Math.max(area, fromArea);
    const edgeDelta = Math.max(
      Math.abs(candidate.bbox.x - from.x) / Math.max(1, from.width),
      Math.abs(candidate.bbox.y - from.y) / Math.max(1, from.height),
      Math.abs(candidate.bbox.x + candidate.bbox.width - from.x - from.width) / Math.max(1, from.width),
      Math.abs(candidate.bbox.y + candidate.bbox.height - from.y - from.height) / Math.max(1, from.height),
    );
    if (areaDeltaRatio < .08 && edgeDelta < .06) return [candidate];
    const groupId = `label-roi:${candidate.id}`;
    const variantEvidence = { groupId, mutuallyExclusive: true as const, areaDeltaRatio: round(areaDeltaRatio) };
    const boundaryProbed: DetectorCandidate = {
      ...candidate,
      variant: { ...variantEvidence, kind: "boundary-probed" },
      detection: { ...candidate.detection, config: { ...candidate.detection.config, reviewVariant: { kind: "boundary-probed", groupId } } },
    };
    const tight: DetectorCandidate = {
      ...candidate,
      id: `${candidate.id}-tight`,
      bbox: from,
      polygon: rectPolygon(from),
      score: round(clamp01(candidate.score - .035)),
      variant: { ...variantEvidence, kind: "tight" },
      metrics: { ...candidate.metrics, areaRatio: round(fromArea / Math.max(1, area / Math.max(candidate.metrics.areaRatio, .000001))) },
      detection: { ...candidate.detection, config: { ...candidate.detection.config, reviewVariant: { kind: "tight", groupId } } },
    };
    return [boundaryProbed, tight];
  });
}

function readRect(value: unknown): Rect | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rect = value as Record<string, unknown>;
  if (![rect.x, rect.y, rect.width, rect.height].every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  const result = { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number };
  return result.width > 0 && result.height > 0 ? result : null;
}

export function classifyBottleLabelCandidates<T extends DetectorCandidate>(candidates: T[], packageContext: PackageAwareLabelContext): T[] {
  if (!candidates.length || packageContext.packageType !== "bottle") return candidates;
  const zoneModel = deriveBottleZoneModel(packageContext);
  const packageArea = Math.max(1, packageContext.bbox.width * packageContext.bbox.height);
  const largestCandidateArea = Math.max(1, ...candidates.map((candidate) => candidate.bbox.width * candidate.bbox.height));
  return candidates.map((candidate) => {
    const centerX = candidate.bbox.x + candidate.bbox.width / 2;
    const centerY = candidate.bbox.y + candidate.bbox.height / 2;
    const localSpan = horizontalContourSpan(packageContext.contour, centerY) ?? {
      left: packageContext.bbox.x,
      right: packageContext.bbox.x + packageContext.bbox.width,
    };
    const localWidth = Math.max(1, localSpan.right - localSpan.left);
    const localCenterX = (localSpan.left + localSpan.right) / 2;
    const normalizedCenterY = clamp01((centerY - packageContext.bbox.y) / Math.max(1, packageContext.bbox.height));
    const horizontalCentrality = clamp01(1 - Math.abs(centerX - localCenterX) / Math.max(1, localWidth / 2));
    const localPackageWidthRatio = candidate.bbox.width / localWidth;
    const candidateArea = candidate.bbox.width * candidate.bbox.height;
    const packageAreaRatio = candidateArea / packageArea;
    const packageHeightRatio = candidate.bbox.height / Math.max(1, packageContext.bbox.height);
    const relativeCandidateArea = candidateArea / largestCandidateArea;
    const aspectRatio = candidate.bbox.width / Math.max(1, candidate.bbox.height);
    const independentAlternatives = candidates.filter((other) => other !== candidate
      && (!candidate.variant || !other.variant || candidate.variant.groupId !== other.variant.groupId)
      && rectIoU(candidate.bbox, other.bbox) < .18
      && Math.abs((other.bbox.y + other.bbox.height / 2) - centerY) / Math.max(1, packageContext.bbox.height) >= .06).length;
    const containedAlternatives = candidates.filter((other) => other !== candidate
      && (!candidate.variant || !other.variant || candidate.variant.groupId !== other.variant.groupId)
      && other.bbox.width * other.bbox.height >= candidateArea * 1.25
      && rectCoverage(candidate.bbox, other.bbox) >= .85).length;
    const zone = classifyBottlePackageZone(centerY, packageContext, zoneModel);
    const role = zone.zone === "neck" ? "neck-label" as const : "front-label" as const;
    const widthFit = bandFit(localPackageWidthRatio, .12, .25, .92, 1.06);
    const verticalFit = bandFit(normalizedCenterY, .08, .2, .9, .98);
    const aspectFit = clamp01(1 - Math.abs(Math.log(Math.max(.05, aspectRatio) / 1.15)) / 2.4);
    const heightFit = clamp01(1 - Math.max(0, packageHeightRatio - .38) / .3);
    const packageContainment = rectCoverage(candidate.bbox, packageContext.bbox);
    const collectionEvidence = independentAlternatives > 0 ? 1 : .55;
    const confidence = clamp01(
      horizontalCentrality * .25
      + widthFit * .16
      + verticalFit * .12
      + aspectFit * .1
      + heightFit * .13
      + Math.sqrt(clamp01(relativeCandidateArea)) * .1
      + packageContainment * .09
      + collectionEvidence * .05
      - Math.min(.3, containedAlternatives * .16)
      - (packageHeightRatio > .58 ? .25 : 0),
    );
    return {
      ...candidate,
      geometrySemantic: {
        schemaVersion: 1 as const,
        algorithm: "bottle-label-geometry-v2" as const,
        role,
        verdict: confidence >= .56 ? "likely" as const : "unlikely" as const,
        confidence: round(confidence),
        features: {
          normalizedCenterY: round(normalizedCenterY), horizontalCentrality: round(horizontalCentrality),
          localPackageWidthRatio: round(localPackageWidthRatio), packageAreaRatio: round(packageAreaRatio),
          packageHeightRatio: round(packageHeightRatio), relativeCandidateArea: round(relativeCandidateArea),
          aspectRatio: round(aspectRatio), independentAlternatives, containedAlternatives,
          packageZone: zone.zone, packageZoneConfidence: round(zone.confidence),
        },
      },
    };
  });
}

function horizontalContourSpan(contour: Array<[number, number]>, y: number): { left: number; right: number } | null {
  if (contour.length < 3) return null;
  const intersections: number[] = [];
  for (let index = 0; index < contour.length; index += 1) {
    const [x1, y1] = contour[index]!;
    const [x2, y2] = contour[(index + 1) % contour.length]!;
    if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) intersections.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1));
  }
  if (intersections.length < 2) return null;
  return { left: Math.min(...intersections), right: Math.max(...intersections) };
}

export function deriveBottleZoneModel(context: PackageAwareLabelContext): BottleZoneModel {
  const top = context.bbox.y;
  const height = Math.max(1, context.bbox.height);
  const sampleCount = 81;
  const raw = Array.from({ length: sampleCount }, (_value, index) => {
    const normalizedY = (index + .5) / sampleCount;
    const y = top + normalizedY * height;
    const span = horizontalContourSpan(context.contour, y);
    return span ? { normalizedY, y, width: Math.max(1, span.right - span.left) } : null;
  }).filter((value): value is { normalizedY: number; y: number; width: number } => Boolean(value));
  const fallback = (neckEnd: number, shoulderEnd: number, baseStart: number, confidence: number): BottleZoneModel => ({
    algorithm: "bottle-contour-zones-v1",
    boundaries: { neckEndY: round(top + neckEnd * height), shoulderEndY: round(top + shoulderEnd * height), baseStartY: round(top + baseStart * height) },
    normalizedBoundaries: { neckEnd: round(neckEnd), shoulderEnd: round(shoulderEnd), baseStart: round(baseStart) },
    confidence: round(confidence),
    evidence: { sampleCount: raw.length, maximumWidth: round(Math.max(1, ...raw.map((sample) => sample.width))), neckWidthRatio: 0, bodyWidthRatio: 0 },
  });
  if (raw.length < sampleCount * .55) return fallback(.28, .52, .94, .25);

  const widths = raw.map((sample, index) => {
    const neighbors = raw.slice(Math.max(0, index - 2), Math.min(raw.length, index + 3));
    return neighbors.reduce((sum, item) => sum + item.width, 0) / neighbors.length;
  });
  const maximumWidth = percentile(widths, .92);
  const ratios = widths.map((width) => width / Math.max(1, maximumWidth));
  const firstAtRatio = (minimumRatio: number, minimumY: number, maximumY: number) => raw.findIndex((sample, index) => (
    sample.normalizedY >= minimumY
    && sample.normalizedY <= maximumY
    && ratios.slice(index, Math.min(ratios.length, index + 4)).filter((ratio) => ratio >= minimumRatio).length >= 3
  ));
  const neckIndex = firstAtRatio(.46, .1, .5);
  const neckEnd = neckIndex >= 0 ? raw[neckIndex]!.normalizedY : .28;
  const shoulderIndex = firstAtRatio(.78, Math.min(.68, neckEnd + .06), .75);
  const shoulderEnd = shoulderIndex >= 0 ? raw[shoulderIndex]!.normalizedY : Math.max(neckEnd + .12, .52);

  let baseStart = .94;
  for (let index = raw.length - 2; index >= 0; index -= 1) {
    const sample = raw[index]!;
    if (sample.normalizedY < Math.max(.78, shoulderEnd + .18)) break;
    const forwardSlope = ratios[Math.min(ratios.length - 1, index + 2)]! - ratios[Math.max(0, index - 2)]!;
    if (forwardSlope <= -.055 || ratios[index]! < .86) baseStart = sample.normalizedY;
    else if (baseStart < .94) break;
  }
  baseStart = clampNumber(baseStart, Math.max(.8, shoulderEnd + .18), .97, .94);

  const neckSamples = raw.map((sample, index) => ({ sample, ratio: ratios[index]! })).filter(({ sample }) => sample.normalizedY <= neckEnd);
  const bodySamples = raw.map((sample, index) => ({ sample, ratio: ratios[index]! })).filter(({ sample }) => sample.normalizedY >= shoulderEnd && sample.normalizedY < baseStart);
  const neckWidthRatio = percentile(neckSamples.map((item) => item.ratio), .5);
  const bodyWidthRatio = percentile(bodySamples.map((item) => item.ratio), .5);
  const wideningEvidence = clamp01((bodyWidthRatio - neckWidthRatio) / .5);
  const boundarySeparation = bandFit(shoulderEnd - neckEnd, .04, .12, .34, .5);
  const confidence = clamp01(raw.length / sampleCount * .3 + wideningEvidence * .48 + boundarySeparation * .22);
  return {
    algorithm: "bottle-contour-zones-v1",
    boundaries: { neckEndY: round(top + neckEnd * height), shoulderEndY: round(top + shoulderEnd * height), baseStartY: round(top + baseStart * height) },
    normalizedBoundaries: { neckEnd: round(neckEnd), shoulderEnd: round(shoulderEnd), baseStart: round(baseStart) },
    confidence: round(confidence),
    evidence: { sampleCount: raw.length, maximumWidth: round(maximumWidth), neckWidthRatio: round(neckWidthRatio), bodyWidthRatio: round(bodyWidthRatio) },
  };
}

function classifyBottlePackageZone(y: number, context: PackageAwareLabelContext, model = deriveBottleZoneModel(context)): { zone: BottlePackageZone; confidence: number } {
  const { neckEndY, shoulderEndY, baseStartY } = model.boundaries;
  const zone: BottlePackageZone = y < neckEndY ? "neck" : y < shoulderEndY ? "shoulder" : y < baseStartY ? "body" : "base";
  const distance = Math.min(Math.abs(y - neckEndY), Math.abs(y - shoulderEndY), Math.abs(y - baseStartY));
  const boundaryDistance = clamp01(distance / Math.max(1, context.bbox.height * .08));
  return { zone, confidence: clamp01(model.confidence * (.58 + boundaryDistance * .42)) };
}

function rectCoverage(inner: Rect, outer: Rect) {
  const x1 = Math.max(inner.x, outer.x), y1 = Math.max(inner.y, outer.y);
  const x2 = Math.min(inner.x + inner.width, outer.x + outer.width), y2 = Math.min(inner.y + inner.height, outer.y + outer.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1) / Math.max(1, inner.width * inner.height);
}

function bandFit(value: number, minimum: number, plateauStart: number, plateauEnd: number, maximum: number) {
  if (value <= minimum || value >= maximum) return 0;
  if (value >= plateauStart && value <= plateauEnd) return 1;
  return value < plateauStart ? (value - minimum) / (plateauStart - minimum) : (maximum - value) / (maximum - plateauEnd);
}

function detectPackageMaterialLabelRegions(
  raster: ColorRaster,
  sourceWidth: number,
  sourceHeight: number,
  context: PackageAwareLabelContext,
  bands: Array<{ bbox: Rect; coverage: number; profileId: string }>,
) {
  const zoneModel = deriveBottleZoneModel(context);
  const observations = bands.flatMap((band) => {
    const centerX = band.bbox.x + band.bbox.width / 2;
    const centerY = band.bbox.y + band.bbox.height / 2;
    const span = polygonSpanAtY(context.contour, centerY) ?? { left: context.bbox.x, right: context.bbox.x + context.bbox.width };
    const localWidth = Math.max(1, span.right - span.left);
    const localCenter = (span.left + span.right) / 2;
    const widthRatio = band.bbox.width / localWidth;
    const heightRatio = band.bbox.height / Math.max(1, context.bbox.height);
    const normalizedCenterY = (centerY - context.bbox.y) / Math.max(1, context.bbox.height);
    const centrality = clamp01(1 - Math.abs(centerX - localCenter) / Math.max(1, localWidth / 2));
    if (normalizedCenterY < .06 || normalizedCenterY > .97 || widthRatio < .24 || widthRatio > 1.08 || heightRatio < .025 || heightRatio > .42 || centrality < .42) return [];
    const materialPalette = packageExteriorPalette(raster, sourceWidth, sourceHeight, context.contour, band.bbox);
    const regionColor = meanPackageStrip(
      raster, sourceWidth, sourceHeight, context.contour,
      band.bbox.x, band.bbox.x + band.bbox.width, band.bbox.y, band.bbox.y + band.bbox.height,
    );
    if (!materialPalette.length || !regionColor) return [];
    const materialDeviation = 1 - paletteSimilarity(regionColor, materialPalette);
    const textureDensity = packageRegionTextureDensity(raster, sourceWidth, sourceHeight, band.bbox);
    // A label can be chromatically distinct, texturally distinct, or both.
    // Neutral-band coverage is supporting evidence only: artwork and text make
    // a real label deliberately non-uniform.
    if (materialDeviation < .16 && textureDensity < .13) return [];
    const score = clamp01(
      materialDeviation * .38
      + textureDensity * .16
      + bandFit(widthRatio, .2, .42, .98, 1.1) * .2
      + centrality * .12
      + clamp01(band.coverage / .3) * .09
      + bandFit(normalizedCenterY, .04, .1, .94, .99) * .05,
    );
    if (score < .46) return [];
    return [{ ...band, score, materialDeviation, textureDensity, widthRatio, heightRatio, centrality, regionColor, materialPalette }];
  });
  const groups: typeof observations[] = [];
  for (const observation of observations.sort((left, right) => right.score - left.score)) {
    const group = groups.find((values) => values.some((value) => overlapOverSmaller(value.bbox, observation.bbox) >= .62));
    if (group) group.push(observation); else groups.push([observation]);
  }
  const candidates: DetectorCandidate[] = groups.map((group, index) => {
    const bbox = group.map((item) => item.bbox).reduce(unionRect);
    const profileIds = [...new Set(group.map((item) => item.profileId))];
    const best = [...group].sort((left, right) => right.score - left.score)[0]!;
    const zone = classifyBottlePackageZone(best.bbox.y + best.bbox.height / 2, context, zoneModel);
    const stability = profileIds.length / Math.max(1, NEUTRAL_PROFILES.length);
    const score = clamp01(best.score + Math.min(.12, Math.max(0, profileIds.length - 1) * .05));
    return {
      id: `package-material-label-${index + 1}`,
      bbox,
      polygon: rectPolygon(bbox),
      score: round(score),
      metrics: {
        edgeSupport: round(best.textureDensity), rectangularity: 1, solidity: 1,
        stability: round(stability), areaRatio: round(bbox.width * bbox.height / Math.max(1, sourceWidth * sourceHeight)),
        bodyColorContinuation: round(1 - best.materialDeviation), labelBoundaryContrast: round(best.materialDeviation),
      },
      detection: {
        passId: "package-material-deviation",
        passIds: ["package-material-deviation", ...profileIds],
        config: {
          family: "color", method: "package-conditioned-material-v1", trainingRole: "proposal-evidence",
          zone: zone.zone, zoneConfidence: round(zone.confidence), zoneModel,
          materialDeviation: round(best.materialDeviation), textureDensity: round(best.textureDensity),
          localPackageWidthRatio: round(best.widthRatio), horizontalCentrality: round(best.centrality),
          regionRgb: best.regionColor.map(round), materialPaletteRgb: best.materialPalette,
          contributors: group.map((item) => ({ profileId: item.profileId, bbox: item.bbox, coverage: round(item.coverage) })),
        },
      },
    };
  });
  return {
    id: "package-material-deviation", family: "color" as const,
    config: { method: "package-conditioned-material-v1", zones: ["neck", "shoulder", "body", "base"] },
    candidates: candidates.sort((left, right) => right.score - left.score).slice(0, 4),
    bands: [], evidenceCount: bands.length,
  };
}

function packageRegionTextureDensity(raster: ColorRaster, sourceWidth: number, sourceHeight: number, bbox: Rect) {
  const left = Math.max(1, Math.floor(bbox.x / sourceWidth * raster.width));
  const right = Math.min(raster.width - 2, Math.ceil((bbox.x + bbox.width) / sourceWidth * raster.width));
  const top = Math.max(1, Math.floor(bbox.y / sourceHeight * raster.height));
  const bottom = Math.min(raster.height - 2, Math.ceil((bbox.y + bbox.height) / sourceHeight * raster.height));
  let strong = 0; let samples = 0;
  const xStride = Math.max(1, Math.floor((right - left + 1) / 100));
  const yStride = Math.max(1, Math.floor((bottom - top + 1) / 80));
  for (let y = top; y <= bottom; y += yStride) for (let x = left; x <= right; x += xStride) {
    const horizontal = boundaryDifference(raster, x - 1, y, x + 1, y);
    const vertical = boundaryDifference(raster, x, y - 1, x, y + 1);
    if (Math.max(horizontal, vertical) >= 18) strong += 1;
    samples += 1;
  }
  return samples ? strong / samples : 0;
}

function detectHorizontalBoundaryRegions(raster: Raster, sourceWidth: number, sourceHeight: number, searchWindow: Rect | null, profile: BoundaryProfile) {
  const startX = searchWindow ? Math.max(2, Math.floor(searchWindow.x / sourceWidth * raster.width)) : 2;
  const endX = searchWindow ? Math.min(raster.width - 3, Math.ceil((searchWindow.x + searchWindow.width) / sourceWidth * raster.width)) : raster.width - 3;
  const searchWidth = Math.max(1, endX - startX + 1);
  const minimumSpan = searchWidth * .28;
  const curveWindow = profile.family === "color" ? 7 : profile.blurKernel === 5 ? 7 : 5;
  const rows: Array<{ y: number; left: number; right: number; score: number }> = [];
  for (let y = 2 + curveWindow; y < raster.height - 2 - curveWindow; y += 1) {
    const points: number[] = [];
    for (let x = startX; x <= endX; x += 1) {
      let localMaximum = 0;
      // A label wrapped around a cylinder has a slightly curved top/bottom.
      // Project the strongest vertical gradient in a narrow band onto the
      // current row instead of requiring all boundary pixels to share one y.
      for (let offset = -curveWindow; offset <= curveWindow; offset += 1) {
        localMaximum = Math.max(localMaximum, boundaryDifference(raster, x, y + offset - 2, x, y + offset + 2));
      }
      if (localMaximum >= profile.differenceThreshold) points.push(x);
    }
    if (points.length < searchWidth * .07) continue;
    // Keep almost the full horizontal edge. Wider percentile trimming turns a
    // real outer label boundary back into an internal content rectangle on
    // narrow catalog previews.
    const left = percentile(points, .02); const right = percentile(points, .98);
    const span = right - left + 1; if (span < minimumSpan) continue;
    const density = points.length / span; if (density < profile.minimumDensity) continue;
    rows.push({ y, left, right, score: clamp01(span / searchWidth * .44 + density * .56) });
  }
  const peaks = rows
    .filter((row) => rows.every((other) => Math.abs(other.y - row.y) > Math.max(2, raster.height * .012) || other.score <= row.score))
    .sort((left, right) => right.score - left.score)
    .slice(0, 24);
  const pairs: Array<{ top: typeof peaks[number]; bottom: typeof peaks[number]; score: number }> = [];
  for (const top of peaks) for (const bottom of peaks) {
    if (bottom.y <= top.y) continue;
    const heightRatio = (bottom.y - top.y) / raster.height;
    const centerY = (top.y + bottom.y) / 2 / raster.height;
    if (heightRatio < .08 || heightRatio > .46 || centerY < .43 || centerY > .88) continue;
    const overlap = Math.max(0, Math.min(top.right, bottom.right) - Math.max(top.left, bottom.left));
    const smallerWidth = Math.max(1, Math.min(top.right - top.left, bottom.right - bottom.left));
    const overlapRatio = overlap / smallerWidth;
    const widthDifference = Math.abs((top.right - top.left) - (bottom.right - bottom.left)) / Math.max(top.right - top.left, bottom.right - bottom.left);
    if (overlapRatio < .72 || widthDifference > .28) continue;
    const positionScore = clamp01(1 - Math.abs(centerY - .68) * 1.8);
    pairs.push({ top, bottom, score: clamp01(.5 + (top.score + bottom.score) * .17 + overlapRatio * .1 + positionScore * .06) });
  }
  const pass: PassConfig = { id: profile.id, blurKernel: profile.blurKernel, low: profile.differenceThreshold, high: 0 };
  const candidates: DetectorCandidate[] = suppressCandidateOverlaps(pairs.sort((a, b) => b.score - a.score).map((pair, index) => {
    const padding = Math.max(1, Math.round(raster.width * .008));
    const topY = localizeBoundaryRow(raster, pair.top.y, pair.top.left, pair.top.right, curveWindow);
    const bottomY = localizeBoundaryRow(raster, pair.bottom.y, pair.bottom.left, pair.bottom.right, curveWindow);
    const initialLeft = Math.max(0, Math.min(pair.top.left, pair.bottom.left) - padding);
    const initialRight = Math.min(raster.width - 1, Math.max(pair.top.right, pair.bottom.right) + padding);
    const refinedSides = refineBoundarySides(raster, topY, bottomY, initialLeft, initialRight, profile.differenceThreshold);
    const leftSnappedToBottle = refinedSides.left - startX <= searchWidth * .04 && initialLeft - startX > searchWidth * .06;
    const rightSnappedToBottle = endX - refinedSides.right <= searchWidth * .04 && endX - initialRight > searchWidth * .06;
    const left = leftSnappedToBottle ? initialLeft : refinedSides.left;
    const right = rightSnappedToBottle ? initialRight : refinedSides.right;
    const bbox = {
      x: Math.round(left / raster.width * sourceWidth), y: Math.round(topY / raster.height * sourceHeight),
      width: Math.round((right - left + 1) / raster.width * sourceWidth), height: Math.round((bottomY - topY + 1) / raster.height * sourceHeight),
    };
    const areaRatio = bbox.width * bbox.height / Math.max(1, sourceWidth * sourceHeight);
    return {
      id: `${profile.id}-${index + 1}`, bbox, polygon: rectPolygon(bbox), score: round(pair.score),
      metrics: { edgeSupport: round(((pair.top.score + pair.bottom.score) / 2) * .78 + refinedSides.support * .22), rectangularity: round(1 - Math.abs((pair.top.right - pair.top.left) - (pair.bottom.right - pair.bottom.left)) / Math.max(1, pair.top.right - pair.top.left, pair.bottom.right - pair.bottom.left)), solidity: 1, stability: 1, areaRatio: round(areaRatio) },
      detection: { passId: profile.id, passIds: [profile.id], config: { ...profile, sideRefinement: { initialLeft, initialRight, finalLeft: left, finalRight: right, support: round(refinedSides.support) } } },
    };
  }), .74).slice(0, 4);
  return { id: profile.id, family: profile.family, config: { ...profile }, candidates, evidenceCount: rows.length };
}

function localizeBoundaryRow(raster: Raster, approximateY: number, left: number, right: number, window: number) {
  let best = { y: approximateY, score: -1 };
  for (let y = Math.max(2, approximateY - window); y <= Math.min(raster.height - 3, approximateY + window); y += 1) {
    let score = 0; let samples = 0;
    const stride = Math.max(1, Math.floor((right - left + 1) / 120));
    for (let x = Math.max(2, left); x <= Math.min(raster.width - 3, right); x += stride) {
      score += Math.min(90, boundaryDifference(raster, x, y - 2, x, y + 2)) / 90;
      samples += 1;
    }
    const normalized = score / Math.max(1, samples);
    if (normalized > best.score) best = { y, score: normalized };
  }
  return best.y;
}

function refineBoundarySides(raster: Raster, top: number, bottom: number, initialLeft: number, initialRight: number, differenceThreshold: number) {
  const initialWidth = Math.max(1, initialRight - initialLeft + 1);
  const expansion = Math.max(Math.round(raster.width * .08), Math.round(initialWidth * .62));
  const minimumX = Math.max(2, initialLeft - expansion);
  const maximumX = Math.min(raster.width - 3, initialRight + expansion);
  const sideScore = (x: number) => {
    let strong = 0; let sum = 0; let samples = 0;
    const threshold = Math.max(12, differenceThreshold * .58);
    for (let y = Math.max(2, top + 2); y <= Math.min(raster.height - 3, bottom - 2); y += 2) {
      const delta = boundaryDifference(raster, x - 2, y, x + 2, y);
      if (delta >= threshold) strong += 1;
      sum += Math.min(80, delta) / 80;
      samples += 1;
    }
    return samples ? clamp01(strong / samples * .72 + sum / samples * .28) : 0;
  };
  const leftLimit = Math.min(maximumX, initialLeft + Math.round(initialWidth * .08));
  const rightLimit = Math.max(minimumX, initialRight - Math.round(initialWidth * .08));
  const leftCandidates = Array.from({ length: Math.max(0, leftLimit - minimumX + 1) }, (_value, index) => minimumX + index)
    .map((x) => ({ x, score: sideScore(x) })).sort((left, right) => right.score - left.score).slice(0, 10);
  const rightCandidates = Array.from({ length: Math.max(0, maximumX - rightLimit + 1) }, (_value, index) => rightLimit + index)
    .map((x) => ({ x, score: sideScore(x) })).sort((left, right) => right.score - left.score).slice(0, 10);
  const initialSupport = (sideScore(initialLeft) + sideScore(initialRight)) / 2;
  let best = { left: initialLeft, right: initialRight, support: initialSupport, score: initialSupport };
  for (const left of leftCandidates) for (const right of rightCandidates) {
    const width = right.x - left.x + 1;
    if (width < initialWidth * .82 || width > initialWidth * 2.25) continue;
    const expansionRatio = Math.max(0, width / initialWidth - 1);
    const centerShift = Math.abs((left.x + right.x) / 2 - (initialLeft + initialRight) / 2) / initialWidth;
    const support = (left.score + right.score) / 2;
    const score = support - expansionRatio * .035 - centerShift * .08;
    if (score > best.score + .035) best = { left: left.x, right: right.x, support, score };
  }
  return { left: best.left, right: best.right, support: best.support };
}

function boundaryDifference(raster: Raster | ColorRaster, x1: number, y1: number, x2: number, y2: number) {
  const channels = "channels" in raster ? raster.channels : 1;
  const first = (y1 * raster.width + x1) * channels;
  const second = (y2 * raster.width + x2) * channels;
  if (channels === 1) return Math.abs((raster.data[first] ?? 0) - (raster.data[second] ?? 0));
  let squared = 0;
  for (let channel = 0; channel < Math.min(3, channels); channel += 1) squared += ((raster.data[first + channel] ?? 0) - (raster.data[second + channel] ?? 0)) ** 2;
  return Math.sqrt(squared / 3);
}

export function extendToStrongerLowerBoundary(candidate: DetectorCandidate, raster: ColorRaster, sourceWidth: number, sourceHeight: number): DetectorCandidate {
  const bottom = candidate.bbox.y + candidate.bbox.height;
  if (bottom >= sourceHeight * .94 || candidate.bbox.width < sourceWidth * .2) return candidate;
  const rasterLeft = Math.max(2, Math.round(candidate.bbox.x / sourceWidth * raster.width));
  const rasterRight = Math.min(raster.width - 3, Math.round((candidate.bbox.x + candidate.bbox.width) / sourceWidth * raster.width));
  const rasterBottom = Math.max(3, Math.min(raster.height - 4, Math.round(bottom / sourceHeight * raster.height)));
  const maximumExtension = Math.min(sourceHeight * .095, Math.max(candidate.bbox.height * .55, sourceHeight * .045));
  const rasterLimit = Math.min(raster.height - 4, Math.round((bottom + maximumExtension) / sourceHeight * raster.height));
  const inset = Math.max(2, Math.round((rasterRight - rasterLeft) * .07));
  const boundaryScore = (y: number) => {
    let sum = 0; let samples = 0;
    const stride = Math.max(1, Math.floor((rasterRight - rasterLeft) / 100));
    for (let x = rasterLeft + inset; x <= rasterRight - inset; x += stride) {
      sum += Math.min(100, boundaryDifference(raster, x, y - 2, x, y + 2)) / 100;
      samples += 1;
    }
    return samples ? sum / samples : 0;
  };
  const currentScore = Math.max(...[-2, -1, 0, 1, 2].map((offset) => boundaryScore(rasterBottom + offset)));
  let best = { y: rasterBottom, score: currentScore };
  const minimumDistance = Math.max(3, Math.round(raster.height * .008));
  for (let y = rasterBottom + minimumDistance; y <= rasterLimit; y += 1) {
    const score = boundaryScore(y);
    if (score > best.score) best = { y, score };
  }
  const requiredScore = Math.max(.16, currentScore * 1.18);
  if (best.y === rasterBottom || best.score < requiredScore) return candidate;
  const extendedBottom = Math.min(sourceHeight, Math.round(best.y / raster.height * sourceHeight));
  if (extendedBottom <= bottom || extendedBottom >= sourceHeight * .955) return candidate;
  const bbox = { ...candidate.bbox, height: extendedBottom - candidate.bbox.y };
  return {
    ...candidate,
    bbox,
    polygon: rectPolygon(bbox),
    score: round(clamp01(candidate.score + .012)),
    metrics: {
      ...candidate.metrics,
      areaRatio: round(bbox.width * bbox.height / Math.max(1, sourceWidth * sourceHeight)),
    },
    detection: {
      ...candidate.detection,
      config: {
        ...candidate.detection.config,
        lowerBoundaryCompletion: {
          from: bottom,
          to: extendedBottom,
          internalBoundaryScore: round(currentScore),
          outerBoundaryScore: round(best.score),
        },
      },
    },
  };
}

export function trimDarkBottleTail(candidate: DetectorCandidate, raster: ColorRaster, sourceWidth: number, sourceHeight: number): DetectorCandidate {
  const bottom = candidate.bbox.y + candidate.bbox.height;
  if (bottom < sourceHeight * .94 || candidate.bbox.height < sourceHeight * .2) return candidate;
  const left = Math.max(2, Math.round(candidate.bbox.x / sourceWidth * raster.width));
  const right = Math.min(raster.width - 3, Math.round((candidate.bbox.x + candidate.bbox.width) / sourceWidth * raster.width));
  const top = Math.max(2, Math.round(candidate.bbox.y / sourceHeight * raster.height));
  const rasterBottom = Math.min(raster.height - 3, Math.round(bottom / sourceHeight * raster.height));
  const inset = Math.max(2, Math.round((right - left) * .08));
  const meanColor = (startY: number, endY: number) => {
    const sums = [0, 0, 0]; let samples = 0;
    const xStride = Math.max(1, Math.floor((right - left) / 50));
    const yStride = Math.max(1, Math.floor((endY - startY) / 20));
    for (let y = startY; y <= endY; y += yStride) for (let x = left + inset; x <= right - inset; x += xStride) {
      const offset = (y * raster.width + x) * raster.channels;
      for (let channel = 0; channel < 3; channel += 1) sums[channel] += raster.data[offset + channel] ?? 0;
      samples += 1;
    }
    return samples ? sums.map((sum) => sum / samples) : [0, 0, 0];
  };
  const height = rasterBottom - top;
  const bodyColor = meanColor(top + Math.round(height * .08), top + Math.round(height * .55));
  const tailColor = meanColor(top + Math.round(height * .82), rasterBottom - 2);
  const bodyLightness = bodyColor.reduce((sum, value) => sum + value, 0) / 3;
  const tailLightness = tailColor.reduce((sum, value) => sum + value, 0) / 3;
  const bodyTailColorDistance = Math.sqrt(bodyColor.reduce((sum, value, channel) => sum + (value - (tailColor[channel] ?? 0)) ** 2, 0) / 3);
  // Pale labels on rosé/amber glass can have almost identical average
  // lightness. RGB distance keeps that real material transition visible while
  // the existing lightness gate continues to protect uniform label artwork.
  if (Math.abs(tailLightness - bodyLightness) < 22 && bodyTailColorDistance < 24) return candidate;
  const boundaryScore = (y: number) => {
    let sum = 0; let samples = 0;
    const stride = Math.max(1, Math.floor((right - left) / 100));
    for (let x = left + inset; x <= right - inset; x += stride) {
      sum += Math.min(100, boundaryDifference(raster, x, y - 2, x, y + 2)) / 100;
      samples += 1;
    }
    return samples ? sum / samples : 0;
  };
  const searchStart = top + Math.round(height * .48);
  const searchEnd = rasterBottom - Math.max(4, Math.round(raster.height * .045));
  const peaks: Array<{ y: number; score: number }> = [];
  for (let y = searchStart; y <= searchEnd; y += 1) {
    const score = boundaryScore(y);
    if (score >= .1 && score >= boundaryScore(y - 1) && score >= boundaryScore(y + 1)) peaks.push({ y, score });
  }
  const selected = peaks.sort((leftPeak, rightPeak) => rightPeak.y - leftPeak.y || rightPeak.score - leftPeak.score)[0];
  if (!selected) return candidate;
  const trimmedBottom = Math.round(selected.y / raster.height * sourceHeight);
  if (trimmedBottom <= candidate.bbox.y + candidate.bbox.height * .48 || trimmedBottom >= bottom) return candidate;
  const bbox = { ...candidate.bbox, height: trimmedBottom - candidate.bbox.y };
  return {
    ...candidate,
    bbox,
    polygon: rectPolygon(bbox),
    metrics: { ...candidate.metrics, areaRatio: round(bbox.width * bbox.height / Math.max(1, sourceWidth * sourceHeight)) },
    detection: {
      ...candidate.detection,
      config: {
        ...candidate.detection.config,
        lowerBoundaryTrim: {
          from: bottom,
          to: trimmedBottom,
          boundaryScore: round(selected.score),
          bodyLightness: round(bodyLightness),
          tailLightness: round(tailLightness),
          bodyTailColorDistance: round(bodyTailColorDistance),
        },
      },
    },
  };
}

/**
 * A proposal that follows an accepted Package shell can include package body
 * on any side. Treat every edge independently: move it inwards only when the
 * discarded strip resembles the package material, the retained strip differs
 * from it, and a sufficiently strong boundary separates the two. The contour
 * is a soft prior, never a replacement for image evidence.
 */
export function refineCandidatesWithPackageContext(
  candidates: DetectorCandidate[],
  raster: ColorRaster,
  sourceWidth: number,
  sourceHeight: number,
  context: PackageAwareLabelContext,
) {
  if (context.contour.length < 3 || context.bbox.width <= 0 || context.bbox.height <= 0) return candidates;
  return candidates.map((candidate) => {
    const materialEvidence = refineCandidateWithPackageContext(candidate, raster, sourceWidth, sourceHeight, context);
    if (context.packageType !== "bottle") return materialEvidence;
    // Preserve the explainable package-affinity metrics from the legacy
    // material pass, but let the bidirectional probe own final geometry. The
    // legacy pass is inward-only and can otherwise cut at an internal layer.
    const probeBbox = {
      x: materialEvidence.bbox.x,
      width: materialEvidence.bbox.width,
      y: candidate.bbox.y,
      height: candidate.bbox.height,
    };
    const probeSeed = {
      ...candidate,
      bbox: probeBbox,
      polygon: rectPolygon(probeBbox),
      metrics: materialEvidence.metrics,
      detection: { ...candidate.detection, config: { ...candidate.detection.config, packageAware: materialEvidence.detection.config.packageAware } },
    };
    return refineBottleCandidateWithBoundaryProbe(probeSeed, raster, sourceWidth, sourceHeight, context);
  });
}

function refineCandidateWithPackageContext(candidate: DetectorCandidate, raster: ColorRaster, sourceWidth: number, sourceHeight: number, context: PackageAwareLabelContext): DetectorCandidate {
  const packageBottom = context.bbox.y + context.bbox.height;
  const candidateBottom = candidate.bbox.y + candidate.bbox.height;
  const packageBottomAffinity = clamp01(1 - Math.abs(candidateBottom - packageBottom) / Math.max(1, context.bbox.height * .12));
  const sideInsets = [.2, .5, .8].flatMap((fraction) => {
    const y = candidate.bbox.y + candidate.bbox.height * fraction;
    const span = polygonSpanAtY(context.contour, y);
    if (!span) return [];
    const width = Math.max(1, span.right - span.left);
    return [{
      left: Math.max(0, candidate.bbox.x - span.left) / width,
      right: Math.max(0, span.right - (candidate.bbox.x + candidate.bbox.width)) / width,
    }];
  });
  const leftInset = sideInsets.length ? sideInsets.reduce((sum, value) => sum + value.left, 0) / sideInsets.length : 1;
  const rightInset = sideInsets.length ? sideInsets.reduce((sum, value) => sum + value.right, 0) / sideInsets.length : 1;
  const sideInsetFromPackageContour = (leftInset + rightInset) / 2;
  const packageEdgeAffinity = clamp01(1 - sideInsetFromPackageContour / .12);
  const packageTopAffinity = clamp01(1 - Math.abs(candidate.bbox.y - context.bbox.y) / Math.max(1, context.bbox.height * .12));
  const edgeAffinities = {
    top: Math.max(packageTopAffinity, packageEdgeAffinity),
    right: clamp01(1 - rightInset / .12),
    bottom: Math.max(packageBottomAffinity, packageEdgeAffinity),
    left: clamp01(1 - leftInset / .12),
  };
  const baseMetrics = {
    ...candidate.metrics,
    packageEdgeAffinity: round(packageEdgeAffinity),
    packageBottomAffinity: round(packageBottomAffinity),
    sideInsetFromPackageContour: round(sideInsetFromPackageContour),
    packageEdgeAffinities: mapEdgeValues(edgeAffinities, round),
  };
  const bodyPalette = packageExteriorPalette(raster, sourceWidth, sourceHeight, context.contour, candidate.bbox);
  if (!bodyPalette.length) return { ...candidate, metrics: baseMetrics };

  const edgeOrder = ["top", "right", "bottom", "left"] as const;
  let bbox = { ...candidate.bbox };
  const refinements: Partial<Record<typeof edgeOrder[number], EdgeBoundaryMatch>> = {};
  for (const edge of edgeOrder) {
    if (edgeAffinities[edge] < .42) continue;
    const match = findPackageBoundary(edge, bbox, raster, sourceWidth, sourceHeight, context, bodyPalette);
    if (!match) continue;
    const next = applyInwardEdge(bbox, edge, match.position);
    if (next.width < candidate.bbox.width * .42 || next.height < candidate.bbox.height * .35) continue;
    bbox = next;
    refinements[edge] = match;
  }
  const refinedEdges = edgeOrder.filter((edge) => refinements[edge]);
  if (!refinedEdges.length) {
    const maximumAffinity = Math.max(...Object.values(edgeAffinities));
    return {
      ...candidate,
      score: round(clamp01(candidate.score - maximumAffinity * .04)),
      metrics: { ...baseMetrics, bodyColorContinuation: 0, labelBoundaryContrast: 0 },
      detection: { ...candidate.detection, config: { ...candidate.detection.config, packageAware: { mode: "no-boundary", reason: "package-shell-affinity-without-material-transition", bodyPaletteRgb: bodyPalette, edgeAffinities: mapEdgeValues(edgeAffinities, round) } } },
    };
  }
  const matches = refinedEdges.map((edge) => refinements[edge]!);
  const averageContinuation = matches.reduce((sum, match) => sum + match.continuation, 0) / matches.length;
  const averageContrast = matches.reduce((sum, match) => sum + match.contrast, 0) / matches.length;
  const averageBoundaryScore = matches.reduce((sum, match) => sum + match.score, 0) / matches.length;
  return {
    ...candidate,
    bbox,
    polygon: rectPolygon(bbox),
    score: round(clamp01(candidate.score + averageBoundaryScore * .07)),
    metrics: {
      ...baseMetrics,
      areaRatio: round(bbox.width * bbox.height / Math.max(1, sourceWidth * sourceHeight)),
      bodyColorContinuation: round(averageContinuation),
      labelBoundaryContrast: round(clamp01(averageContrast / 100)),
      refinedEdges,
    },
    detection: {
      ...candidate.detection,
      config: {
        ...candidate.detection.config,
        packageAware: {
          mode: "four-edge-material-refinement", from: candidate.bbox, to: bbox,
          bodyPaletteRgb: bodyPalette,
          edgeAffinities: mapEdgeValues(edgeAffinities, round),
          edges: Object.fromEntries(refinedEdges.map((edge) => [edge, { ...refinements[edge], position: Math.round(refinements[edge]!.position) }])),
        },
      },
    },
  };
}

type PackageEdge = "top" | "right" | "bottom" | "left";
type EdgeBoundaryMatch = { position: number; score: number; contrast: number; continuation: number };
type BoundaryProbeMatch = {
  position: number; score: number; contrast: number; coverage: number;
  outsideBodySimilarity: number; insideBodyDifference: number;
  textLikeDrop: number; sideTermination: number; discardedTextLike: number; retainedTextLike: number;
};

/**
 * Refine a bottle Label in both directions around every proposed edge. The
 * package palette remains a fallback prior, while the decision itself uses
 * local strips, edge coverage, texture/text-like continuation and termination
 * of the Label side walls. This keeps internal artwork dividers from becoming
 * outer Label boundaries and lets a clipped proposal grow inside the Package.
 */
export function refineBottleCandidateWithBoundaryProbe(
  candidate: DetectorCandidate,
  raster: ColorRaster,
  sourceWidth: number,
  sourceHeight: number,
  context: PackageAwareLabelContext,
): DetectorCandidate {
  if (context.packageType !== "bottle") return candidate;
  const bodyPalette = packageExteriorPalette(raster, sourceWidth, sourceHeight, context.contour, candidate.bbox);
  if (!bodyPalette.length) return candidate;
  const original = { ...candidate.bbox };
  const edges = ["top", "right", "bottom", "left"] as const;
  const matches: Partial<Record<PackageEdge, BoundaryProbeMatch>> = {};
  for (const edge of edges) {
    const match = findBottleBoundaryProbe(edge, original, raster, sourceWidth, sourceHeight, context, bodyPalette);
    if (match) matches[edge] = match;
  }
  let bbox = { ...original };
  if (matches.top) bbox = applyEdgePosition(bbox, "top", matches.top.position);
  if (matches.bottom) bbox = applyEdgePosition(bbox, "bottom", matches.bottom.position);
  if (matches.left) bbox = applyEdgePosition(bbox, "left", matches.left.position);
  if (matches.right) bbox = applyEdgePosition(bbox, "right", matches.right.position);
  if (bbox.width < original.width * .55 || bbox.height < original.height * .45) bbox = original;

  const zoneModel = deriveBottleZoneModel(context);
  const bottom = bbox.y + bbox.height;
  const baseIntrusion = clamp01((bottom - zoneModel.boundaries.baseStartY) / Math.max(1, context.bbox.height * .08));
  const bottomEvidence = matches.bottom;
  const provenBottom = Boolean(bottomEvidence && bottomEvidence.score >= .58 && (
    bottomEvidence.sideTermination >= .08 || bottomEvidence.textLikeDrop >= .07
  ));
  const basePenalty = provenBottom ? baseIntrusion * .025 : baseIntrusion * .14;
  const meanProbeScore = Object.values(matches).reduce((sum, match) => sum + match.score, 0) / Math.max(1, Object.keys(matches).length);
  const actionFor = (edge: PackageEdge, match: BoundaryProbeMatch) => {
    const origin = edge === "top" ? original.y : edge === "bottom" ? original.y + original.height : edge === "left" ? original.x : original.x + original.width;
    const inwardSign = edge === "top" || edge === "left" ? 1 : -1;
    const movement = (match.position - origin) * inwardSign;
    const threshold = (edge === "top" || edge === "bottom" ? original.height : original.width) * .012;
    return movement > threshold ? "contract" as const : movement < -threshold ? "expand" as const : "keep" as const;
  };
  const evidenceEdges = Object.fromEntries(Object.entries(matches).map(([edge, match]) => [edge, {
    action: actionFor(edge as PackageEdge, match), position: Math.round(match.position), score: round(match.score),
    contrast: round(match.contrast), coverage: round(match.coverage), outsideBodySimilarity: round(match.outsideBodySimilarity),
    insideBodyDifference: round(match.insideBodyDifference), textLikeDrop: round(match.textLikeDrop), sideTermination: round(match.sideTermination), discardedTextLike: round(match.discardedTextLike), retainedTextLike: round(match.retainedTextLike),
  }]));
  return {
    ...candidate,
    bbox,
    polygon: rectPolygon(bbox),
    score: round(clamp01(candidate.score + meanProbeScore * .035 - basePenalty)),
    metrics: {
      ...candidate.metrics,
      areaRatio: round(bbox.width * bbox.height / Math.max(1, sourceWidth * sourceHeight)),
      boundaryProbe: { algorithm: "package-local-boundary-probe-v1", edges: evidenceEdges, baseIntrusion: round(baseIntrusion) },
    },
    detection: {
      ...candidate.detection,
      config: {
        ...candidate.detection.config,
        boundaryProbe: { algorithm: "package-local-boundary-probe-v1", from: original, to: bbox, bodyPaletteRgb: bodyPalette, edges: evidenceEdges, baseIntrusion: round(baseIntrusion), basePenalty: round(basePenalty) },
      },
    },
  };
}

function findBottleBoundaryProbe(
  edge: PackageEdge,
  bbox: Rect,
  raster: ColorRaster,
  sourceWidth: number,
  sourceHeight: number,
  context: PackageAwareLabelContext,
  bodyPalette: number[][],
): BoundaryProbeMatch | null {
  const vertical = edge === "top" || edge === "bottom";
  const dimension = vertical ? bbox.height : bbox.width;
  const origin = edge === "top" ? bbox.y : edge === "bottom" ? bbox.y + bbox.height : edge === "left" ? bbox.x : bbox.x + bbox.width;
  const inwardSign = edge === "top" || edge === "left" ? 1 : -1;
  const step = Math.max(1, vertical ? sourceHeight / raster.height : sourceWidth / raster.width);
  const strip = Math.max(step * 2.5, dimension * .018);
  const outwardLimit = Math.min(dimension * .16, (vertical ? context.bbox.height : context.bbox.width) * .08);
  const inwardLimit = dimension * .42;
  const lower = vertical ? context.bbox.y : context.bbox.x;
  const upper = vertical ? context.bbox.y + context.bbox.height : context.bbox.x + context.bbox.width;
  const values: BoundaryProbeMatch[] = [];
  for (let offset = -outwardLimit; offset <= inwardLimit; offset += step) {
    const position = origin + inwardSign * offset;
    if (position <= lower + strip * 3 || position >= upper - strip * 3) continue;
    const outside = meanEdgeStrip(raster, sourceWidth, sourceHeight, context.contour, bbox, edge, position - inwardSign * strip * 3, position - inwardSign * strip);
    const inside = meanEdgeStrip(raster, sourceWidth, sourceHeight, context.contour, bbox, edge, position + inwardSign * strip, position + inwardSign * strip * 3);
    if (!outside || !inside) continue;
    const contrast = rgbDistance(outside, inside);
    const outsideBodySimilarity = paletteSimilarity(outside, bodyPalette);
    const insideBodyDifference = 1 - paletteSimilarity(inside, bodyPalette);
    const coverage = edgeBoundaryCoverage(raster, sourceWidth, sourceHeight, bbox, edge, position);
    const insideTexture = edgeStripTexture(raster, sourceWidth, sourceHeight, bbox, edge, position, inwardSign, strip, strip * 4);
    const outsideTexture = edgeStripTexture(raster, sourceWidth, sourceHeight, bbox, edge, position, -inwardSign, strip, strip * 4);
    const textLikeDrop = Math.max(0, insideTexture - outsideTexture);
    const sideTermination = boundarySideTermination(raster, sourceWidth, sourceHeight, bbox, edge, position, inwardSign, strip);
    const discardedTextLike = offset > dimension * .04
      ? maximumDiscardedTextLike(raster, sourceWidth, sourceHeight, bbox, edge, position, origin, -inwardSign, strip)
      : 0;
    const retainedTextLike = maximumDiscardedTextLike(raster, sourceWidth, sourceHeight, bbox, edge, position, position + inwardSign * dimension * .3, inwardSign, strip);
    const movementPenalty = Math.abs(offset) / Math.max(1, dimension) * .055;
    const score = clamp01(
      clamp01(contrast / 70) * .2
      + coverage * .25
      + outsideBodySimilarity * .22
      + insideBodyDifference * .12
      + clamp01(textLikeDrop / .22) * .11
      + sideTermination * .16
      + clamp01(retainedTextLike / .2) * .08
      - movementPenalty,
    );
    const movedInside = offset > dimension * .06;
    const continuationProven = sideTermination >= .055 || textLikeDrop >= .055 || retainedTextLike >= .065 || (outsideBodySimilarity >= .78 && coverage >= .34);
    // Prefer a slightly oversized ROI to silently cutting visible glyph-like
    // structure. The later OCR stage can tolerate glass margin; it cannot
    // recover content removed here.
    const discardsVisibleContent = movedInside && discardedTextLike >= .065;
    const lowContrastButSupported = outsideBodySimilarity >= .75 && retainedTextLike >= .065 && discardedTextLike < .06;
    if (outsideBodySimilarity < .42 || (contrast < 12 && coverage < .16 && textLikeDrop < .055 && sideTermination < .08 && !lowContrastButSupported) || score < .39 || (movedInside && (!continuationProven || discardsVisibleContent))) continue;
    values.push({ position, score, contrast, coverage, outsideBodySimilarity, insideBodyDifference, textLikeDrop, sideTermination, discardedTextLike, retainedTextLike });
  }
  if (!values.length) return null;
  values.sort((left, right) => right.score - left.score || Math.abs(left.position - origin) - Math.abs(right.position - origin));
  const bestScore = values[0]!.score;
  const competitive = values.filter((value) => value.score >= bestScore - .035);
  // When several nested horizontal transitions are equally plausible, prefer
  // the outermost one. The local body and side-termination gates above prevent
  // this from blindly extending to the bottle base.
  return competitive.sort((left, right) => {
    const leftOutward = (left.position - origin) * inwardSign;
    const rightOutward = (right.position - origin) * inwardSign;
    return leftOutward - rightOutward;
  })[0]!;
}

function applyEdgePosition(bbox: Rect, edge: PackageEdge, position: number) {
  const rounded = Math.round(position);
  if (edge === "top") return { ...bbox, y: rounded, height: bbox.y + bbox.height - rounded };
  if (edge === "bottom") return { ...bbox, height: rounded - bbox.y };
  if (edge === "left") return { ...bbox, x: rounded, width: bbox.x + bbox.width - rounded };
  return { ...bbox, width: rounded - bbox.x };
}

function edgeBoundaryCoverage(raster: ColorRaster, sourceWidth: number, sourceHeight: number, bbox: Rect, edge: PackageEdge, position: number) {
  const horizontal = edge === "top" || edge === "bottom";
  const normalStep = Math.max(1, Math.round(horizontal ? raster.height / sourceHeight * 2 : raster.width / sourceWidth * 2));
  const start = horizontal ? Math.round((bbox.x + bbox.width * .05) / sourceWidth * raster.width) : Math.round((bbox.y + bbox.height * .05) / sourceHeight * raster.height);
  const end = horizontal ? Math.round((bbox.x + bbox.width * .95) / sourceWidth * raster.width) : Math.round((bbox.y + bbox.height * .95) / sourceHeight * raster.height);
  const fixed = Math.round(position / (horizontal ? sourceHeight : sourceWidth) * (horizontal ? raster.height : raster.width));
  let strong = 0; let samples = 0;
  const stride = Math.max(1, Math.floor((end - start + 1) / 120));
  for (let value = start; value <= end; value += stride) {
    const x1 = horizontal ? value : fixed - normalStep; const y1 = horizontal ? fixed - normalStep : value;
    const x2 = horizontal ? value : fixed + normalStep; const y2 = horizontal ? fixed + normalStep : value;
    if (x1 < 0 || x2 >= raster.width || y1 < 0 || y2 >= raster.height) continue;
    if (boundaryDifference(raster, x1, y1, x2, y2) >= 14) strong += 1;
    samples += 1;
  }
  return samples ? strong / samples : 0;
}

function edgeStripTexture(raster: ColorRaster, sourceWidth: number, sourceHeight: number, bbox: Rect, edge: PackageEdge, position: number, direction: number, near: number, far: number) {
  const horizontal = edge === "top" || edge === "bottom";
  const from = position + direction * near; const to = position + direction * far;
  const region = horizontal
    ? { x: bbox.x + bbox.width * .06, y: Math.min(from, to), width: bbox.width * .88, height: Math.abs(to - from) }
    : { x: Math.min(from, to), y: bbox.y + bbox.height * .06, width: Math.abs(to - from), height: bbox.height * .88 };
  return packageRegionTextureDensity(raster, sourceWidth, sourceHeight, region);
}

function maximumDiscardedTextLike(raster: ColorRaster, sourceWidth: number, sourceHeight: number, bbox: Rect, edge: PackageEdge, position: number, origin: number, outwardDirection: number, strip: number) {
  const distance = Math.abs(origin - position);
  if (distance <= strip * 4) return 0;
  const window = Math.max(strip * 4, distance * .2);
  let maximum = 0;
  for (let offset = strip * 2; offset + window <= distance - strip; offset += Math.max(strip, window * .4)) {
    maximum = Math.max(maximum, edgeStripTexture(raster, sourceWidth, sourceHeight, bbox, edge, position, outwardDirection, offset, offset + window));
  }
  return maximum;
}

function boundarySideTermination(raster: ColorRaster, sourceWidth: number, sourceHeight: number, bbox: Rect, edge: PackageEdge, position: number, inwardSign: number, strip: number) {
  const horizontal = edge === "top" || edge === "bottom";
  const sideStrength = (normalPosition: number) => {
    const positions = horizontal ? [bbox.x, bbox.x + bbox.width] : [bbox.y, bbox.y + bbox.height];
    let total = 0; let count = 0;
    for (const side of positions) {
      for (const delta of [-strip, 0, strip]) {
        const sourceX1 = horizontal ? side - strip : normalPosition + delta;
        const sourceY1 = horizontal ? normalPosition + delta : side - strip;
        const sourceX2 = horizontal ? side + strip : normalPosition + delta;
        const sourceY2 = horizontal ? normalPosition + delta : side + strip;
        const x1 = Math.round(sourceX1 / sourceWidth * raster.width), y1 = Math.round(sourceY1 / sourceHeight * raster.height);
        const x2 = Math.round(sourceX2 / sourceWidth * raster.width), y2 = Math.round(sourceY2 / sourceHeight * raster.height);
        if (x1 < 0 || x2 >= raster.width || y1 < 0 || y2 >= raster.height) continue;
        total += Math.min(80, boundaryDifference(raster, x1, y1, x2, y2)); count += 1;
      }
    }
    return count ? total / count : 0;
  };
  const inside = sideStrength(position + inwardSign * strip * 3);
  const outside = sideStrength(position - inwardSign * strip * 3);
  return clamp01((inside - outside) / 36);
}

function findPackageBoundary(edge: PackageEdge, bbox: Rect, raster: ColorRaster, sourceWidth: number, sourceHeight: number, context: PackageAwareLabelContext, bodyPalette: number[][]): EdgeBoundaryMatch | null {
  const vertical = edge === "top" || edge === "bottom";
  const dimension = vertical ? bbox.height : bbox.width;
  const direction = edge === "top" || edge === "left" ? 1 : -1;
  const origin = edge === "top" ? bbox.y : edge === "bottom" ? bbox.y + bbox.height : edge === "left" ? bbox.x : bbox.x + bbox.width;
  const step = Math.max(1, vertical ? sourceHeight / raster.height : sourceWidth / raster.width);
  const strip = Math.max(2, step * 3);
  // Keep both comparison strips strictly inside the original proposal. If a
  // proposal already starts at the true Label edge, a strip straddling that
  // edge would manufacture false package similarity and shave a few pixels.
  const minimumTrim = Math.max(3, dimension * .025, strip * 3 + step);
  const maximumTrim = dimension * (context.packageType === "box" ? .28 : .45);
  const minimumScore = context.packageType === "box" ? .57 : .46;
  const minimumContrast = context.packageType === "box" ? 24 : 16;
  let best: EdgeBoundaryMatch | null = null;
  for (let distance = minimumTrim; distance <= maximumTrim; distance += step) {
    const position = origin + direction * distance;
    const outside = meanEdgeStrip(raster, sourceWidth, sourceHeight, context.contour, bbox, edge, position - direction * strip * 3, position - direction * strip);
    const inside = meanEdgeStrip(raster, sourceWidth, sourceHeight, context.contour, bbox, edge, position + direction * strip, position + direction * strip * 3);
    if (!outside || !inside) continue;
    const contrast = rgbDistance(outside, inside);
    const outsideBodySimilarity = paletteSimilarity(outside, bodyPalette);
    const insideBodyDifference = 1 - paletteSimilarity(inside, bodyPalette);
    const score = clamp01(contrast / 62) * .52 + outsideBodySimilarity * .32 + insideBodyDifference * .16;
    if (contrast < minimumContrast || outsideBodySimilarity < .5 || insideBodyDifference < .22 || score < minimumScore || (best && score <= best.score)) continue;
    best = { position, score: round(score), contrast: round(contrast), continuation: round(outsideBodySimilarity) };
  }
  return best;
}

function meanEdgeStrip(raster: ColorRaster, sourceWidth: number, sourceHeight: number, contour: Array<[number, number]>, bbox: Rect, edge: PackageEdge, from: number, to: number) {
  return edge === "top" || edge === "bottom"
    ? meanPackageStrip(raster, sourceWidth, sourceHeight, contour, bbox.x, bbox.x + bbox.width, Math.min(from, to), Math.max(from, to))
    : meanPackageStrip(raster, sourceWidth, sourceHeight, contour, Math.min(from, to), Math.max(from, to), bbox.y, bbox.y + bbox.height);
}

function applyInwardEdge(bbox: Rect, edge: PackageEdge, position: number): Rect {
  const rounded = Math.round(position);
  if (edge === "top") return { ...bbox, y: rounded, height: bbox.y + bbox.height - rounded };
  if (edge === "bottom") return { ...bbox, height: rounded - bbox.y };
  if (edge === "left") return { ...bbox, x: rounded, width: bbox.x + bbox.width - rounded };
  return { ...bbox, width: rounded - bbox.x };
}

function mapEdgeValues<T>(values: Record<PackageEdge, number>, transform: (value: number) => T): Record<PackageEdge, T> {
  return { top: transform(values.top), right: transform(values.right), bottom: transform(values.bottom), left: transform(values.left) };
}

function polygonSpanAtY(polygon: Array<[number, number]>, y: number) {
  const intersections: number[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const [x1, y1] = polygon[index]!; const [x2, y2] = polygon[(index + 1) % polygon.length]!;
    if ((y1 > y) === (y2 > y) || y1 === y2) continue;
    intersections.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
  }
  if (intersections.length < 2) return null;
  intersections.sort((left, right) => left - right);
  return { left: intersections[0]!, right: intersections.at(-1)! };
}

function meanPackageStrip(raster: ColorRaster, sourceWidth: number, sourceHeight: number, contour: Array<[number, number]>, left: number, right: number, top: number, bottom: number) {
  const startY = Math.max(0, Math.floor(top / sourceHeight * raster.height));
  const endY = Math.min(raster.height - 1, Math.ceil(bottom / sourceHeight * raster.height));
  const startX = Math.max(0, Math.floor(left / sourceWidth * raster.width));
  const endX = Math.min(raster.width - 1, Math.ceil(right / sourceWidth * raster.width));
  const sums = [0, 0, 0]; let samples = 0;
  const xStride = Math.max(1, Math.floor((endX - startX + 1) / 80));
  for (let rasterY = startY; rasterY <= endY; rasterY += 1) {
    const sourceY = (rasterY + .5) / raster.height * sourceHeight;
    const span = polygonSpanAtY(contour, sourceY); if (!span) continue;
    for (let rasterX = startX; rasterX <= endX; rasterX += xStride) {
      const sourceX = (rasterX + .5) / raster.width * sourceWidth;
      if (sourceX < span.left || sourceX > span.right) continue;
      const offset = (rasterY * raster.width + rasterX) * raster.channels;
      for (let channel = 0; channel < 3; channel += 1) sums[channel] += raster.data[offset + channel] ?? 0;
      samples += 1;
    }
  }
  return samples ? sums.map((value) => value / samples) : null;
}

function rgbDistance(left: number[], right: number[]) {
  return Math.sqrt(left.reduce((sum, value, index) => sum + (value - (right[index] ?? 0)) ** 2, 0) / 3);
}

function packageExteriorPalette(raster: ColorRaster, sourceWidth: number, sourceHeight: number, contour: Array<[number, number]>, excluded: Rect) {
  const counts = new Map<number, number>();
  const xStride = Math.max(1, Math.floor(raster.width / 220));
  const yStride = Math.max(1, Math.floor(raster.height / 320));
  for (let rasterY = 0; rasterY < raster.height; rasterY += yStride) {
    const sourceY = (rasterY + .5) / raster.height * sourceHeight;
    const span = polygonSpanAtY(contour, sourceY); if (!span) continue;
    const startX = Math.max(0, Math.floor(span.left / sourceWidth * raster.width));
    const endX = Math.min(raster.width - 1, Math.ceil(span.right / sourceWidth * raster.width));
    for (let rasterX = startX; rasterX <= endX; rasterX += xStride) {
      const sourceX = (rasterX + .5) / raster.width * sourceWidth;
      if (sourceX >= excluded.x && sourceX <= excluded.x + excluded.width && sourceY >= excluded.y && sourceY <= excluded.y + excluded.height) continue;
      const offset = (rasterY * raster.width + rasterX) * raster.channels;
      const red = raster.data[offset] ?? 0, green = raster.data[offset + 1] ?? 0, blue = raster.data[offset + 2] ?? 0;
      const key = (Math.round(red / 32) << 16) | (Math.round(green / 32) << 8) | Math.round(blue / 32);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  const minimumCount = (ranked[0]?.[1] ?? 0) * .2;
  return ranked.filter(([, count]) => count >= minimumCount).slice(0, 5).map(([key]) => [
    Math.min(255, ((key >> 16) & 255) * 32), Math.min(255, ((key >> 8) & 255) * 32), Math.min(255, (key & 255) * 32),
  ]);
}

function paletteSimilarity(color: number[], palette: number[][]) {
  if (!palette.length) return 0;
  return clamp01(1 - Math.min(...palette.map((entry) => rgbDistance(color, entry))) / 85);
}

/**
 * Dark labels on dark glass may have almost no mean-colour transition, while
 * their printed/embossed surface still has dense horizontal texture. For a
 * wide bottom candidate that reaches the bottle base, snap both vertical
 * edges to that texture band and leave ordinary candidates untouched.
 */
export function snapBottomCandidateToTextureBand(candidate: DetectorCandidate, raster: ColorRaster, sourceWidth: number, sourceHeight: number): DetectorCandidate {
  const bottom = candidate.bbox.y + candidate.bbox.height;
  if (bottom < sourceHeight * .94 || candidate.bbox.height < sourceHeight * .2 || candidate.bbox.width < sourceWidth * .6) return candidate;
  if (candidateIndependentFamilyCount(candidate) < 2) return candidate;

  const left = Math.max(2, Math.round(candidate.bbox.x / sourceWidth * raster.width));
  const right = Math.min(raster.width - 3, Math.round((candidate.bbox.x + candidate.bbox.width) / sourceWidth * raster.width));
  const inset = Math.max(3, Math.round((right - left) * .09));
  const searchTop = Math.max(2, Math.round(Math.max(0, candidate.bbox.y - sourceHeight * .07) / sourceHeight * raster.height));
  const searchBottom = Math.min(raster.height - 3, Math.round(Math.min(bottom, sourceHeight * .965) / sourceHeight * raster.height));
  const rowDensity = (y: number) => {
    let strong = 0; let samples = 0;
    for (let x = left + inset + 1; x <= right - inset; x += 1) {
      const current = (y * raster.width + x) * raster.channels;
      const previous = current - raster.channels;
      let squared = 0;
      for (let channel = 0; channel < Math.min(3, raster.channels); channel += 1) squared += ((raster.data[current + channel] ?? 0) - (raster.data[previous + channel] ?? 0)) ** 2;
      if (Math.sqrt(squared / 3) >= 12) strong += 1;
      samples += 1;
    }
    return strong / Math.max(1, samples);
  };

  const accepted = Array.from({ length: Math.max(0, searchBottom - searchTop + 1) }, (_value, index) => searchTop + index)
    .filter((y) => rowDensity(y) >= .18);
  if (!accepted.length) return candidate;
  const maximumGap = Math.max(2, Math.round(raster.height * .016));
  const bands: Array<{ top: number; bottom: number; rows: number[] }> = [];
  for (const y of accepted) {
    const band = bands.at(-1);
    if (!band || y - band.bottom > maximumGap) bands.push({ top: y, bottom: y, rows: [y] });
    else { band.bottom = y; band.rows.push(y); }
  }
  const best = bands
    .filter((band) => (band.bottom - band.top + 1) / raster.height >= .1 && band.rows.length / Math.max(1, band.bottom - band.top + 1) >= .42)
    .sort((leftBand, rightBand) => rightBand.rows.length - leftBand.rows.length)[0];
  if (!best) return candidate;
  const snappedTop = Math.max(0, Math.round(best.top / raster.height * sourceHeight));
  const snappedBottom = Math.min(sourceHeight, Math.round((best.bottom + 1) / raster.height * sourceHeight));
  const snappedHeight = snappedBottom - snappedTop;
  if (snappedHeight < sourceHeight * .1 || snappedHeight > sourceHeight * .34 || snappedBottom > sourceHeight * .94) return candidate;
  const bbox = { ...candidate.bbox, y: snappedTop, height: snappedHeight };
  return {
    ...candidate,
    bbox,
    polygon: rectPolygon(bbox),
    metrics: { ...candidate.metrics, areaRatio: round(bbox.width * bbox.height / Math.max(1, sourceWidth * sourceHeight)) },
    detection: { ...candidate.detection, config: { ...candidate.detection.config, textureBandSnap: { from: candidate.bbox, to: bbox, densityThreshold: .18 } } },
  };
}

function detectNeutralLabelRegions(raster: ColorRaster, sourceWidth: number, sourceHeight: number, searchWindow: Rect | null, baseConfig: AutoLabelConfigV1, profile: NeutralProfile, packageContext?: PackageAwareLabelContext | null) {
  const config = {
    ...baseConfig,
    chromaTolerance: clampNumber(baseConfig.chromaTolerance + profile.chromaOffset, 4, 80, baseConfig.chromaTolerance),
    minimumLightness: clampNumber(baseConfig.minimumLightness + profile.lightnessOffset, 40, 240, baseConfig.minimumLightness),
    minimumBandCoverage: clampNumber(baseConfig.minimumBandCoverage + profile.coverageOffset, .15, .95, baseConfig.minimumBandCoverage),
    rowGapRatio: clampNumber(baseConfig.rowGapRatio + profile.rowGapOffset, .01, .3, baseConfig.rowGapRatio),
  };
  const { width, height, channels } = raster;
  const startX = searchWindow ? Math.max(0, Math.floor(searchWindow.x / sourceWidth * width)) : 0;
  const endX = searchWindow ? Math.min(width - 1, Math.ceil((searchWindow.x + searchWindow.width) / sourceWidth * width)) : width - 1;
  const searchWidth = Math.max(1, endX - startX + 1);
  const rows = Array.from({ length: height }, () => ({ accepted: false, continuation: false, left: width, right: -1, searchWidth }));
  for (let y = 0; y < height; y += 1) {
    const sourceY = (y + .5) / height * sourceHeight;
    const packageSpan = packageContext ? polygonSpanAtY(packageContext.contour, sourceY) : null;
    if (packageContext && !packageSpan) continue;
    const rowStartX = packageSpan ? Math.max(startX, Math.floor(packageSpan.left / sourceWidth * width)) : startX;
    const rowEndX = packageSpan ? Math.min(endX, Math.ceil(packageSpan.right / sourceWidth * width)) : endX;
    const rowSearchWidth = Math.max(1, rowEndX - rowStartX + 1);
    let runStart = 0; let runLength = 0; let bestStart = 0; let bestLength = 0;
    for (let x = rowStartX; x <= rowEndX; x += 1) {
      const offset = (y * width + x) * channels;
      const red = raster.data[offset] ?? 0; const green = raster.data[offset + 1] ?? red; const blue = raster.data[offset + 2] ?? red;
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      const lightness = (red + green + blue) / 3;
      if (chroma <= config.chromaTolerance && lightness >= config.minimumLightness) {
        if (runLength === 0) runStart = x;
        runLength += 1;
        if (runLength > bestLength) { bestStart = runStart; bestLength = runLength; }
      } else runLength = 0;
    }
    const ratio = bestLength / rowSearchWidth;
    const center = bestStart + bestLength / 2;
    const searchCenter = rowStartX + rowSearchWidth / 2;
    const centered = Math.abs(center - searchCenter) / rowSearchWidth;
    const continuationMinimumWidth = Math.max(.14, config.minRegionWidthRatio * .38);
    const maximumRegionWidthRatio = packageContext?.packageType === "bottle" ? 1.08 : config.maxRegionWidthRatio;
    if (ratio >= continuationMinimumWidth && ratio <= maximumRegionWidthRatio && centered <= .3) {
      rows[y] = {
        accepted: ratio >= config.minRegionWidthRatio,
        continuation: true,
        left: bestStart,
        right: bestStart + bestLength - 1,
        searchWidth: rowSearchWidth,
      };
    }
  }

  // Printed text and large illustrations can interrupt an otherwise uniform label
  // for many consecutive rows. Keep those gaps inside one physical label band.
  const maximumGap = Math.max(3, Math.round(height * config.rowGapRatio));
  const bands: Array<{ top: number; bottom: number; rows: Array<{ left: number; right: number; searchWidth: number }> }> = [];
  for (let y = 0; y < height;) {
    while (y < height && !rows[y]!.accepted) y += 1;
    if (y >= height) break;
    const top = y; let bottom = y; let lastAccepted = y; const acceptedRows = [];
    while (y < height && y - lastAccepted <= maximumGap) {
      if (rows[y]!.accepted) { acceptedRows.push({ left: rows[y]!.left, right: rows[y]!.right, searchWidth: rows[y]!.searchWidth }); lastAccepted = y; bottom = y; }
      y += 1;
    }
    const maximumContinuation = Math.max(2, Math.round(height * .14));
    const continuationGap = Math.max(1, Math.round(height * .012));
    const expanded = extendBandThroughCenteredTaper(rows, top, bottom, maximumContinuation, continuationGap);
    bands.push({ top: expanded.top, bottom: expanded.bottom, rows: acceptedRows });
    y = Math.max(y, expanded.bottom + 1);
  }

  const candidates: DetectorCandidate[] = bands.flatMap((band) => {
    const bandHeight = band.bottom - band.top + 1;
    const minimumHeightRatio = packageContext?.packageType === "bottle" ? .035 : .08;
    if (bandHeight / height < minimumHeightRatio || band.rows.length / bandHeight < config.minimumBandCoverage) return [];
    const left = percentile(band.rows.map((row) => row.left), .18);
    const right = percentile(band.rows.map((row) => row.right), .82);
    const boxWidth = right - left + 1;
    const localSearchWidth = percentile(band.rows.map((row) => row.searchWidth), .5);
    const areaRatio = boxWidth * bandHeight / (localSearchWidth * height);
    const widthRatio = boxWidth / localSearchWidth; const centerY = (band.top + band.bottom) / 2 / height;
    const minimumAreaRatio = packageContext?.packageType === "bottle" ? .012 : .055;
    const minimumCenterY = packageContext?.packageType === "bottle" ? .04 : .32;
    if (areaRatio < minimumAreaRatio || areaRatio > .55 || widthRatio < config.minRegionWidthRatio || centerY < minimumCenterY || centerY > .9) return [];
    const bbox = {
      x: Math.round(left / width * sourceWidth), y: Math.round(band.top / height * sourceHeight),
      width: Math.round(boxWidth / width * sourceWidth), height: Math.round(bandHeight / height * sourceHeight),
    };
    const rowCoverage = band.rows.length / bandHeight;
    const positionScore = clamp01(1 - Math.abs(centerY - .7) * 1.4);
    const score = clamp01(.64 + rowCoverage * .18 + widthRatio * .1 + positionScore * .08);
    return [{
      id: "label-region", bbox, polygon: rectPolygon(bbox), score: round(score),
      metrics: { edgeSupport: round(rowCoverage), rectangularity: round(rowCoverage), solidity: round(rowCoverage), stability: 1, areaRatio: round(areaRatio) },
      detection: { passId: profile.id, passIds: [profile.id], config: { ...profile, effectiveConfig: config } },
    }];
  }).sort((left, right) => right.score - left.score).map((candidate, index) => ({ ...candidate, id: `${profile.id}-${index + 1}` }));
  const debugBands = bands.map((band) => {
    const left = percentile(band.rows.map((row) => row.left), .18);
    const right = percentile(band.rows.map((row) => row.right), .82);
    return {
      bbox: { x: Math.round(left / width * sourceWidth), y: Math.round(band.top / height * sourceHeight), width: Math.max(1, Math.round((right - left + 1) / width * sourceWidth)), height: Math.max(1, Math.round((band.bottom - band.top + 1) / height * sourceHeight)) },
      coverage: round(band.rows.length / Math.max(1, band.bottom - band.top + 1)),
    };
  });
  return { id: profile.id, family: profile.family, config: { ...profile, effectiveConfig: config }, candidates, bands: debugBands, evidenceCount: bands.length };
}

function detectSaturatedLabelRegions(raster: ColorRaster, sourceWidth: number, sourceHeight: number, searchWindow: Rect | null) {
  const { width, height, channels } = raster;
  const startX = searchWindow ? Math.max(0, Math.floor(searchWindow.x / sourceWidth * width)) : 0;
  const endX = searchWindow ? Math.min(width - 1, Math.ceil((searchWindow.x + searchWindow.width) / sourceWidth * width)) : width - 1;
  const searchWidth = Math.max(1, endX - startX + 1);
  const rows = Array.from({ length: height }, () => ({ accepted: false, left: width, right: -1 }));
  for (let y = 0; y < height; y += 1) {
    let runStart = 0; let runLength = 0; let bestStart = 0; let bestLength = 0;
    for (let x = startX; x <= endX; x += 1) {
      const offset = (y * width + x) * channels;
      const red = raster.data[offset] ?? 0; const green = raster.data[offset + 1] ?? red; const blue = raster.data[offset + 2] ?? red;
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      const lightness = (red + green + blue) / 3;
      if (chroma >= 32 && lightness >= 28 && lightness <= 232) {
        if (!runLength) runStart = x;
        runLength += 1;
        if (runLength > bestLength) { bestStart = runStart; bestLength = runLength; }
      } else runLength = 0;
    }
    const ratio = bestLength / searchWidth;
    const center = bestStart + bestLength / 2;
    if (ratio >= .28 && ratio <= .99 && Math.abs(center - (startX + searchWidth / 2)) / searchWidth <= .34) {
      rows[y] = { accepted: true, left: bestStart, right: bestStart + bestLength - 1 };
    }
  }
  const maximumGap = Math.max(3, Math.round(height * .04));
  const bands: Array<{ top: number; bottom: number; rows: Array<{ left: number; right: number }> }> = [];
  for (let y = 0; y < height;) {
    while (y < height && !rows[y]!.accepted) y += 1;
    if (y >= height) break;
    const top = y; let bottom = y; let lastAccepted = y; const acceptedRows = [];
    while (y < height && y - lastAccepted <= maximumGap) {
      if (rows[y]!.accepted) { acceptedRows.push({ left: rows[y]!.left, right: rows[y]!.right }); lastAccepted = y; bottom = y; }
      y += 1;
    }
    bands.push({ top, bottom, rows: acceptedRows });
  }
  const candidates = bands.flatMap((band, index): DetectorCandidate[] => {
    const bandHeight = band.bottom - band.top + 1;
    const coverage = band.rows.length / Math.max(1, bandHeight);
    const centerY = (band.top + band.bottom) / 2 / height;
    if (bandHeight / height < .06 || bandHeight / height > .42 || coverage < .3 || centerY < .35 || centerY > .9) return [];
    const left = percentile(band.rows.map((row) => row.left), .12);
    const right = percentile(band.rows.map((row) => row.right), .88);
    const bbox = {
      x: Math.round(left / width * sourceWidth), y: Math.round(band.top / height * sourceHeight),
      width: Math.round((right - left + 1) / width * sourceWidth), height: Math.round(bandHeight / height * sourceHeight),
    };
    const areaRatio = bbox.width * bbox.height / Math.max(1, sourceWidth * sourceHeight);
    return [{
      id: `saturated-color-${index + 1}`, bbox, polygon: rectPolygon(bbox),
      score: round(clamp01(.68 + coverage * .18 + Math.min(.1, bbox.width / sourceWidth * .12))),
      metrics: { edgeSupport: round(coverage), rectangularity: round(coverage), solidity: round(coverage), stability: 1, areaRatio: round(areaRatio) },
      detection: { passId: "saturated-color-regions", passIds: ["saturated-color-regions"], config: { family: "color", chromaThreshold: 32, trainingRole: "proposal-evidence" } },
    }];
  }).sort((left, right) => right.score - left.score).slice(0, 6);
  return { id: "saturated-color-regions", family: "color" as const, config: { chromaThreshold: 32 }, candidates, bands: [], evidenceCount: bands.length };
}

function extendBandThroughCenteredTaper(
  rows: Array<{ accepted: boolean; continuation: boolean; left: number; right: number }>,
  top: number,
  bottom: number,
  maximumContinuation: number,
  maximumGap: number,
) {
  const extend = (start: number, direction: -1 | 1) => {
    let edge = start;
    let lastEvidence = start;
    let gap = 0;
    for (let distance = 1; distance <= maximumContinuation; distance += 1) {
      const y = start + distance * direction;
      const row = rows[y];
      if (!row || row.accepted) break;
      if (row.continuation) {
        edge = y;
        lastEvidence = y;
        gap = 0;
      } else {
        gap += 1;
        if (gap > maximumGap) break;
      }
    }
    return Math.abs(lastEvidence - start) > maximumGap ? edge : start;
  };
  return { top: extend(top, -1), bottom: extend(bottom, 1) };
}

function aggregateDetectorFamilies(values: DetectorCandidate[], sourceWidth: number, sourceHeight: number) {
  const candidates: DetectorCandidate[] = [];
  const debug: Array<Record<string, unknown>> = [];
  for (const family of ["edge", "color", "text"] as const) {
    const familyValues = values.filter((candidate) => profileFamily(candidate.detection.passId) === family);
    const clusters: DetectorCandidate[][] = [];
    for (const candidate of [...familyValues].sort((left, right) => right.score - left.score)) {
      const cluster = clusters.find((items) => items.some((item) => sameFamilyRegion(item.bbox, candidate.bbox, sourceWidth, sourceHeight)));
      if (cluster) cluster.push(candidate); else clusters.push([candidate]);
    }
    for (const [index, allMembers] of clusters.entries()) {
      // Multiple presets in one family improve stability, but remain one vote.
      const members = [...allMembers].sort((left, right) => right.score - left.score)
        .filter((member, memberIndex, sorted) => sorted.findIndex((item) => item.detection.passId === member.detection.passId) === memberIndex);
      const bbox = weightedDetectorRect(members);
      const agreement = members.reduce((sum, member) => sum + rectIoU(member.bbox, bbox), 0) / Math.max(1, members.length);
      const quality = members.reduce((sum, member) => sum + member.score, 0) / Math.max(1, members.length);
      const profileIds = [...new Set(members.flatMap((member) => member.detection.passIds))];
      const availableProfiles = family === "edge"
        ? BOUNDARY_PROFILES.length
        : family === "color"
          ? NEUTRAL_PROFILES.length + COLOR_BOUNDARY_PROFILES.length + 1
          : 1;
      const profileSupport = Math.min(1, profileIds.length / Math.max(1, availableProfiles));
      const score = clamp01(quality * .72 + agreement * .18 + profileSupport * .1);
      const areaRatio = bbox.width * bbox.height / Math.max(1, sourceWidth * sourceHeight);
      const candidate: DetectorCandidate = {
        id: `label-family-${family}-${index + 1}`,
        bbox,
        polygon: rectPolygon(bbox),
        score: round(score),
        metrics: {
          edgeSupport: round(members.reduce((sum, item) => sum + item.metrics.edgeSupport, 0) / members.length),
          rectangularity: round(members.reduce((sum, item) => sum + item.metrics.rectangularity, 0) / members.length),
          solidity: round(members.reduce((sum, item) => sum + item.metrics.solidity, 0) / members.length),
          stability: round(agreement),
          areaRatio: round(areaRatio),
        },
        detection: {
          passId: `family-${family}`,
          passIds: profileIds,
          config: {
            family,
            fusion: "weighted-box-v1",
            profileSupport: round(profileSupport),
            contributors: members.map((member) => ({ candidateId: member.id, profileId: member.detection.passId, bbox: member.bbox, score: member.score })),
          },
        },
      };
      candidates.push(candidate);
      debug.push({ family, candidateId: candidate.id, profileIds, profileSupport: round(profileSupport), agreement: round(agreement), score: candidate.score, bbox });
    }
  }
  return { candidates, debug };
}

function buildDetectorConsensus(values: DetectorCandidate[], sourceWidth: number, sourceHeight: number) {
  const clusters: DetectorCandidate[][] = [];
  for (const candidate of [...values].sort((left, right) => right.score - left.score)) {
    const cluster = clusters.find((items) => items.some((item) => samePhysicalRegion(item.bbox, candidate.bbox, sourceWidth, sourceHeight)));
    if (cluster) cluster.push(candidate); else clusters.push([candidate]);
  }
  const ranked = clusters.map((allMembers, index) => {
    // Intra-family aggregation has already happened. A family gets at most one
    // vote in a cross-family cluster regardless of its preset count.
    const members = [...allMembers].sort((left, right) => right.score - left.score)
      .filter((member, memberIndex, sorted) => sorted.findIndex((item) => candidateFamily(item) === candidateFamily(member)) === memberIndex);
    const profileIds = [...new Set(members.flatMap((candidate) => candidate.detection.passIds))];
    const families = [...new Set(members.map(candidateFamily))];
    const bbox = weightedFamilyRect(members);
    const geometryStability = members.reduce((sum, candidate) => sum + rectIoU(candidate.bbox, bbox), 0) / members.length;
    const averageScore = members.reduce((sum, candidate) => sum + candidate.score, 0) / members.length;
    const familyConsensus = families.length / 3;
    const areaRatio = bbox.width * bbox.height / Math.max(1, sourceWidth * sourceHeight);
    const internalPenalty = areaRatio < .035 ? .18 : 0;
    const heightRatio = bbox.height / Math.max(1, sourceHeight);
    const centerY = (bbox.y + bbox.height / 2) / Math.max(1, sourceHeight);
    const objectBodyPenalty = Math.max(0, heightRatio - .36) * 1.25 + (heightRatio > .3 ? Math.max(0, .5 - centerY) * .7 : 0);
    const semanticEvidence = families.includes("text") ? 1 : families.includes("color") ? .55 : .2;
    const geometryPrior = clamp01(1 - internalPenalty - objectBodyPenalty);
    const scoreParts = {
      candidateQuality: round(averageScore),
      familySupport: round(familyConsensus),
      spatialAgreement: round(geometryStability),
      semanticEvidence: round(semanticEvidence),
      geometryPrior: round(geometryPrior),
      penalty: round(internalPenalty + objectBodyPenalty),
    };
    const score = clamp01(averageScore * .35 + familyConsensus * .25 + geometryStability * .18 + semanticEvidence * .07 + geometryPrior * .15 - internalPenalty - objectBodyPenalty);
    const candidate: DetectorCandidate = {
      id: `label-consensus-${index + 1}`,
      bbox,
      polygon: rectPolygon(bbox),
      score: round(score),
      metrics: {
        edgeSupport: round(members.reduce((sum, item) => sum + item.metrics.edgeSupport, 0) / members.length),
        rectangularity: round(members.reduce((sum, item) => sum + item.metrics.rectangularity, 0) / members.length),
        solidity: round(members.reduce((sum, item) => sum + item.metrics.solidity, 0) / members.length),
        stability: round(geometryStability),
        areaRatio: round(areaRatio),
      },
      detection: {
        passId: "multi-profile-consensus",
        passIds: profileIds,
        config: {
          fusion: "weighted-box-v1",
          profileIds,
          families,
          confidence: families.length >= 3 && geometryStability >= .7 ? "high" : families.length >= 2 ? "medium" : "low",
          scoreParts,
          contributors: members.map((member) => ({ candidateId: member.id, profileId: member.detection.passId, bbox: member.bbox, score: member.score })),
        },
      },
    };
    return { candidate, members, profileIds, families, geometryStability };
  }).filter((cluster) => cluster.candidate.score >= .42)
    .sort((left, right) => right.candidate.score - left.candidate.score);
  return {
    candidates: ranked.map((cluster) => cluster.candidate),
    clusters: ranked.map((cluster, index) => ({
      id: `label-cluster-${index + 1}`,
      profileIds: cluster.profileIds,
      families: cluster.families,
      consensusScore: cluster.candidate.score,
      geometryStability: round(cluster.geometryStability),
      scoreParts: cluster.candidate.detection.config.scoreParts,
      fusedBbox: cluster.candidate.bbox,
      contributors: cluster.members.map((member) => ({ id: member.id, profileId: member.detection.passId, bbox: member.bbox, score: member.score })),
    })),
  };
}

export function removeNestedDetectorCandidates(values: DetectorCandidate[], sourceWidth: number, sourceHeight: number, raster?: ColorRaster) {
  const withoutCompositeContainers = values.filter((candidate) => !candidateContainsVerticalLayout(candidate, values));
  const withoutBodyContainers = withoutCompositeContainers.filter((candidate) => !withoutCompositeContainers.some((inner) => {
    if (inner === candidate) return false;
    const candidateArea = candidate.bbox.width * candidate.bbox.height;
    const innerArea = inner.bbox.width * inner.bbox.height;
    const heightRatio = candidate.bbox.height / Math.max(1, sourceHeight);
    const widthRatio = candidate.bbox.width / Math.max(1, sourceWidth);
    const bottomRatio = (candidate.bbox.y + candidate.bbox.height) / Math.max(1, sourceHeight);
    const aspect = candidate.bbox.height / Math.max(1, candidate.bbox.width);
    const areaShare = innerArea / Math.max(1, candidateArea);
    const innerFamilies = candidateFamilies(inner);
    const independentlySupported = candidateIndependentFamilyCount(inner) >= 2;
    const strongSemanticWinner = innerFamilies.includes("text") && inner.score >= candidate.score + .04;
    const darkExcessContainer = Boolean(raster && candidateHasDarkUpperExcess(candidate.bbox, inner.bbox, raster, sourceWidth, sourceHeight));
    const elongatedBody = heightRatio >= .48 && aspect >= 1.65;
    const lowerBottleShell = bottomRatio >= .965 && widthRatio >= .7 && heightRatio >= .24;
    const evidenceWins = elongatedBody
      ? (independentlySupported ? inner.score >= candidate.score - .12 : strongSemanticWinner || (darkExcessContainer && inner.score >= candidate.score - .3))
      : innerFamilies.includes("text") && inner.score >= candidate.score + .06;
    return (elongatedBody || lowerBottleShell)
      && areaShare >= .18
      && areaShare <= .72
      && overlapOverSmaller(inner.bbox, candidate.bbox) >= .8
      && evidenceWins;
  }));
  return withoutBodyContainers.filter((candidate) => !withoutBodyContainers.some((outer) => {
    if (outer === candidate || candidateIndependentFamilyCount(outer) < 2) return false;
    const candidateArea = candidate.bbox.width * candidate.bbox.height;
    const outerArea = outer.bbox.width * outer.bbox.height;
    const outerHeightRatio = outer.bbox.height / Math.max(1, sourceHeight);
    const outerWidthRatio = outer.bbox.width / Math.max(1, sourceWidth);
    const outerAspect = outer.bbox.height / Math.max(1, outer.bbox.width);
    const outerBottomRatio = (outer.bbox.y + outer.bbox.height) / Math.max(1, sourceHeight);
    const bodyLikeOuter = (outerHeightRatio >= .45 && outerAspect >= 1.65)
      || (outerBottomRatio >= .965 && outerWidthRatio >= .7 && outerHeightRatio >= .24);
    if (bodyLikeOuter) return false;
    return candidateArea < outerArea * .62 && overlapOverSmaller(candidate.bbox, outer.bbox) >= .82;
  }));
}

/**
 * Saturation segmentation can mistake the coloured glass immediately above a
 * main label for another label. Keep this deliberately narrow: only a large,
 * colour-only upper band may lose to an aligned, multi-family lower candidate.
 * Real separated labels and small neck labels remain independent candidates.
 */
export function removeAdjacentSingleFamilyBodyBands(values: DetectorCandidate[], sourceWidth: number, sourceHeight: number) {
  return values.filter((candidate) => !values.some((anchor) => {
    if (anchor === candidate || candidateIndependentFamilyCount(candidate) !== 1 || candidateFamilies(candidate)[0] !== "color") return false;
    if (candidateIndependentFamilyCount(anchor) < 2 || candidate.score > anchor.score + .02) return false;
    if (!candidate.detection.passIds.includes("saturated-color-regions")) return false;

    const candidateBottom = candidate.bbox.y + candidate.bbox.height;
    const anchorBottom = anchor.bbox.y + anchor.bbox.height;
    if (candidate.bbox.y >= anchor.bbox.y || anchorBottom / Math.max(1, sourceHeight) < .82) return false;

    const horizontalIntersection = Math.max(0, Math.min(candidate.bbox.x + candidate.bbox.width, anchor.bbox.x + anchor.bbox.width) - Math.max(candidate.bbox.x, anchor.bbox.x));
    const horizontalOverlap = horizontalIntersection / Math.max(1, Math.min(candidate.bbox.width, anchor.bbox.width));
    const widthSimilarity = Math.min(candidate.bbox.width, anchor.bbox.width) / Math.max(1, candidate.bbox.width, anchor.bbox.width);
    const verticalIntersection = Math.max(0, Math.min(candidateBottom, anchorBottom) - Math.max(candidate.bbox.y, anchor.bbox.y));
    const verticalOverlap = verticalIntersection / Math.max(1, Math.min(candidate.bbox.height, anchor.bbox.height));
    const verticalGap = anchor.bbox.y - candidateBottom;
    const heightRatio = candidate.bbox.height / Math.max(1, anchor.bbox.height);

    return horizontalOverlap >= .88
      && widthSimilarity >= .78
      && verticalOverlap <= .08
      && verticalGap >= -sourceHeight * .02
      && verticalGap <= sourceHeight * .012
      && candidate.bbox.width / Math.max(1, sourceWidth) >= .4
      && candidate.bbox.height / Math.max(1, sourceHeight) >= .1
      && heightRatio >= .45;
  }));
}

/** Remove a tall upper bottle-shell proposal when a compact, independently
 * supported label sits at the bottom of the same portrait object. */
export function removePortraitBottleBodyCandidates(values: DetectorCandidate[], sourceWidth: number, sourceHeight: number) {
  return values.filter((candidate) => !values.some((lower) => {
    if (lower === candidate || lower.bbox.y <= candidate.bbox.y || candidateIndependentFamilyCount(lower) < 2) return false;
    const candidateHeightRatio = candidate.bbox.height / Math.max(1, sourceHeight);
    const candidateAspect = candidate.bbox.height / Math.max(1, candidate.bbox.width);
    const lowerHeightRatio = lower.bbox.height / Math.max(1, sourceHeight);
    const lowerBottomRatio = (lower.bbox.y + lower.bbox.height) / Math.max(1, sourceHeight);
    const horizontalIntersection = Math.max(0, Math.min(candidate.bbox.x + candidate.bbox.width, lower.bbox.x + lower.bbox.width) - Math.max(candidate.bbox.x, lower.bbox.x));
    const horizontalOverlap = horizontalIntersection / Math.max(1, Math.min(candidate.bbox.width, lower.bbox.width));
    const verticalIntersection = Math.max(0, Math.min(candidate.bbox.y + candidate.bbox.height, lower.bbox.y + lower.bbox.height) - Math.max(candidate.bbox.y, lower.bbox.y));
    const verticalOverlap = verticalIntersection / Math.max(1, Math.min(candidate.bbox.height, lower.bbox.height));
    return candidateHeightRatio >= .38
      && candidateAspect >= 1.55
      && lowerHeightRatio >= .12
      && lowerHeightRatio <= .38
      && lowerBottomRatio >= .9
      && lower.bbox.y >= candidate.bbox.y + candidate.bbox.height * .72
      && horizontalOverlap >= .8
      && verticalOverlap <= .22
      && lower.score >= candidate.score - .12;
  }));
}

function candidateContainsVerticalLayout(outer: DetectorCandidate, values: DetectorCandidate[]) {
  const outerArea = outer.bbox.width * outer.bbox.height;
  const children = values.filter((candidate) => {
    if (candidate === outer) return false;
    const area = candidate.bbox.width * candidate.bbox.height;
    const share = area / Math.max(1, outerArea);
    return share >= .1
      && share <= .9
      && overlapOverSmaller(candidate.bbox, outer.bbox) >= .8
      && candidate.score >= outer.score - .22;
  });
  for (let leftIndex = 0; leftIndex < children.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < children.length; rightIndex += 1) {
    const upper = children[leftIndex]!; const lower = children[rightIndex]!;
    const horizontalIntersection = Math.max(0, Math.min(upper.bbox.x + upper.bbox.width, lower.bbox.x + lower.bbox.width) - Math.max(upper.bbox.x, lower.bbox.x));
    const horizontalOverlap = horizontalIntersection / Math.max(1, Math.min(upper.bbox.width, lower.bbox.width));
    const verticalIntersection = Math.max(0, Math.min(upper.bbox.y + upper.bbox.height, lower.bbox.y + lower.bbox.height) - Math.max(upper.bbox.y, lower.bbox.y));
    const verticalOverlap = verticalIntersection / Math.max(1, Math.min(upper.bbox.height, lower.bbox.height));
    const union = unionRect(upper.bbox, lower.bbox);
    const combinedAreaShare = (upper.bbox.width * upper.bbox.height + lower.bbox.width * lower.bbox.height) / Math.max(1, outerArea);
    if (horizontalOverlap >= .7
      && verticalOverlap <= .18
      && union.height / Math.max(1, outer.bbox.height) >= .62
      && combinedAreaShare >= .45) return true;
  }
  return false;
}

function candidateHasDarkUpperExcess(outer: Rect, inner: Rect, raster: ColorRaster, sourceWidth: number, sourceHeight: number) {
  const excessHeight = inner.y - outer.y;
  if (excessHeight < sourceHeight * .075) return false;
  const horizontalIntersection = Math.max(0, Math.min(outer.x + outer.width, inner.x + inner.width) - Math.max(outer.x, inner.x));
  if (horizontalIntersection / Math.max(1, inner.width) < .78) return false;
  const sample = (rect: Rect) => {
    const left = Math.max(0, Math.floor(rect.x / sourceWidth * raster.width));
    const right = Math.min(raster.width - 1, Math.ceil((rect.x + rect.width) / sourceWidth * raster.width));
    const top = Math.max(0, Math.floor(rect.y / sourceHeight * raster.height));
    const bottom = Math.min(raster.height - 1, Math.ceil((rect.y + rect.height) / sourceHeight * raster.height));
    let sum = 0; let squared = 0; let count = 0;
    const xStride = Math.max(1, Math.floor((right - left + 1) / 45));
    const yStride = Math.max(1, Math.floor((bottom - top + 1) / 25));
    for (let y = top; y <= bottom; y += yStride) for (let x = left; x <= right; x += xStride) {
      const offset = (y * raster.width + x) * raster.channels;
      const lightness = ((raster.data[offset] ?? 0) + (raster.data[offset + 1] ?? 0) + (raster.data[offset + 2] ?? 0)) / 3;
      sum += lightness; squared += lightness * lightness; count += 1;
    }
    const mean = count ? sum / count : 0;
    return { mean, deviation: count ? Math.sqrt(Math.max(0, squared / count - mean * mean)) : 0 };
  };
  const outerInset = outer.width * .12;
  const excess = sample({ x: outer.x + outerInset, y: outer.y + excessHeight * .12, width: outer.width - outerInset * 2, height: excessHeight * .7 });
  const innerInset = inner.width * .12;
  const label = sample({ x: inner.x + innerInset, y: inner.y + inner.height * .12, width: inner.width - innerInset * 2, height: inner.height * .7 });
  return excess.mean + 28 < label.mean && excess.deviation <= 52;
}

export function mergeAlignedConsensusFragments(values: DetectorCandidate[], sourceWidth: number, sourceHeight: number) {
  const candidates = [...values];
  const merges: Array<{ sourceCandidateIds: string[]; bbox: Rect }> = [];
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
        const left = candidates[leftIndex]!; const right = candidates[rightIndex]!;
        if (!alignedFragmentsOfOneLabel(left.bbox, right.bbox, sourceWidth, sourceHeight)) continue;
        const bbox = unionRect(left.bbox, right.bbox);
        const families = [...new Set([...candidateFamilies(left), ...candidateFamilies(right)])];
        const passIds = [...new Set([...left.detection.passIds, ...right.detection.passIds])];
        const merged: DetectorCandidate = {
          id: `${left.id}+${right.id}`,
          bbox,
          polygon: rectPolygon(bbox),
          score: round(clamp01(Math.max(left.score, right.score) + .025)),
          metrics: {
            edgeSupport: round(Math.max(left.metrics.edgeSupport, right.metrics.edgeSupport)),
            rectangularity: round((left.metrics.rectangularity + right.metrics.rectangularity) / 2),
            solidity: round((left.metrics.solidity + right.metrics.solidity) / 2),
            stability: round((left.metrics.stability + right.metrics.stability) / 2),
            areaRatio: round(bbox.width * bbox.height / Math.max(1, sourceWidth * sourceHeight)),
          },
          detection: {
            passId: "multi-profile-consensus",
            passIds,
            config: {
              fusion: "aligned-fragment-union-v1",
              families,
              confidence: families.length >= 2 ? "medium" : "low",
              mergedCandidateIds: [left.id, right.id],
              contributors: [...candidateContributors(left), ...candidateContributors(right)],
            },
          },
        };
        candidates.splice(rightIndex, 1);
        candidates.splice(leftIndex, 1, merged);
        merges.push({ sourceCandidateIds: [left.id, right.id], bbox });
        changed = true;
        break outer;
      }
    }
  }
  return { candidates: candidates.sort((left, right) => right.score - left.score), merges };
}

function alignedFragmentsOfOneLabel(left: Rect, right: Rect, sourceWidth: number, sourceHeight: number) {
  const horizontalIntersection = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const verticalIntersection = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const horizontalOverlap = horizontalIntersection / Math.max(1, Math.min(left.width, right.width));
  const verticalOverlap = verticalIntersection / Math.max(1, Math.min(left.height, right.height));
  const widthSimilarity = Math.min(left.width, right.width) / Math.max(1, left.width, right.width);
  const sideDrift = (Math.abs(left.x - right.x) + Math.abs(left.x + left.width - right.x - right.width)) / Math.max(1, left.width + right.width);
  const union = unionRect(left, right);
  const centerY = (union.y + union.height / 2) / Math.max(1, sourceHeight);
  return horizontalOverlap >= .88
    && widthSimilarity >= .78
    && sideDrift <= .12
    && verticalOverlap >= .16
    && union.height / Math.max(1, sourceHeight) <= .48
    && union.width / Math.max(1, sourceWidth) >= .16
    && centerY >= .4
    && centerY <= .9;
}

function unionRect(left: Rect, right: Rect): Rect {
  const x = Math.min(left.x, right.x); const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width); const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

function candidateFamilies(candidate: DetectorCandidate) {
  const configured = candidate.detection.config.families;
  return Array.isArray(configured) ? configured.filter((value): value is string => typeof value === "string") : [candidateFamily(candidate)];
}

function candidateContributors(candidate: DetectorCandidate) {
  const configured = candidate.detection.config.contributors;
  return Array.isArray(configured) ? configured : [{ candidateId: candidate.id, bbox: candidate.bbox, score: candidate.score }];
}

function samePhysicalRegion(left: Rect, right: Rect, sourceWidth: number, sourceHeight: number) {
  if (rectIoU(left, right) >= .58) return true;
  const overlap = overlapOverSmaller(left, right);
  const leftCenter = { x: left.x + left.width / 2, y: left.y + left.height / 2 };
  const rightCenter = { x: right.x + right.width / 2, y: right.y + right.height / 2 };
  const centerDistance = Math.hypot((leftCenter.x - rightCenter.x) / Math.max(1, sourceWidth), (leftCenter.y - rightCenter.y) / Math.max(1, sourceHeight));
  const widthSimilarity = Math.min(left.width, right.width) / Math.max(1, left.width, right.width);
  const heightSimilarity = Math.min(left.height, right.height) / Math.max(1, left.height, right.height);
  // Text-density proposals normally sit inside the full label. Containment is
  // therefore valid cross-family evidence even when its IoU is modest.
  return overlap >= .82 && centerDistance <= .07 && widthSimilarity >= .55 && heightSimilarity >= .45;
}

function sameFamilyRegion(left: Rect, right: Rect, sourceWidth: number, sourceHeight: number) {
  if (rectIoU(left, right) >= .58) return true;
  const overlap = overlapOverSmaller(left, right);
  const leftCenter = { x: left.x + left.width / 2, y: left.y + left.height / 2 };
  const rightCenter = { x: right.x + right.width / 2, y: right.y + right.height / 2 };
  const centerDistance = Math.hypot((leftCenter.x - rightCenter.x) / Math.max(1, sourceWidth), (leftCenter.y - rightCenter.y) / Math.max(1, sourceHeight));
  const widthSimilarity = Math.min(left.width, right.width) / Math.max(1, left.width, right.width);
  const heightSimilarity = Math.min(left.height, right.height) / Math.max(1, left.height, right.height);
  return overlap >= .84 && centerDistance <= .045 && widthSimilarity >= .72 && heightSimilarity >= .72;
}

function weightedDetectorRect(values: DetectorCandidate[]): Rect {
  const weight = values.reduce((sum, item) => sum + Math.max(.15, item.score), 0);
  const average = (value: (item: DetectorCandidate) => number) => Math.round(values.reduce((sum, item) => sum + value(item) * Math.max(.15, item.score), 0) / weight);
  return { x: average((item) => item.bbox.x), y: average((item) => item.bbox.y), width: average((item) => item.bbox.width), height: average((item) => item.bbox.height) };
}

function weightedFamilyRect(values: DetectorCandidate[]): Rect {
  const familyWeight = (candidate: DetectorCandidate) => {
    const family = candidateFamily(candidate);
    // A text envelope is strong semantic evidence, but usually covers only the
    // printed interior and must not pull the fused outer boundary inward.
    const boundaryWeight = family === "text" ? .45 : 1;
    return Math.max(.15, candidate.score) * boundaryWeight;
  };
  const weight = values.reduce((sum, item) => sum + familyWeight(item), 0);
  const average = (value: (item: DetectorCandidate) => number) => Math.round(values.reduce((sum, item) => sum + value(item) * familyWeight(item), 0) / weight);
  return { x: average((item) => item.bbox.x), y: average((item) => item.bbox.y), width: average((item) => item.bbox.width), height: average((item) => item.bbox.height) };
}

function profileFamily(profileId: string): DetectorFamily {
  if (profileId.startsWith("neutral-")
    || profileId.startsWith("color-boundary-")
    || profileId === "saturated-color-regions"
    || profileId === "package-material-deviation") return "color";
  if (profileId.startsWith("horizontal-")) return "edge";
  if (profileId === "text-density-envelope") return "text";
  return "other";
}

function candidateFamily(candidate: DetectorCandidate): DetectorFamily {
  const configured = candidate.detection.config.family;
  return configured === "edge" || configured === "color" || configured === "text" ? configured : profileFamily(candidate.detection.passId);
}

function candidateIndependentFamilyCount(candidate: DetectorCandidate) {
  const configured = candidate.detection.config.families;
  return Array.isArray(configured) ? configured.length : new Set(candidate.detection.passIds.map(profileFamily)).size;
}

function labelSearchWindow(candidates: Array<{ bbox: Rect }>, sourceWidth: number, sourceHeight: number) {
  return [...candidates].filter((candidate) => {
    const heightRatio = candidate.bbox.height / sourceHeight;
    const widthRatio = candidate.bbox.width / sourceWidth;
    return heightRatio >= .55 && widthRatio <= .72 && candidate.bbox.height > candidate.bbox.width * 1.25;
  }).sort((left, right) => right.bbox.height - left.bbox.height)[0]?.bbox ?? null;
}

function buildLabelEnvelope(candidates: Array<{ id:string;bbox:Rect;polygon:Array<[number,number]>;score:number;metrics:{edgeSupport:number;rectangularity:number;solidity:number;stability:number;areaRatio:number};detection:{passId:string;passIds:string[];config:PassConfig} }>, sourceWidth:number, sourceHeight:number) {
  const internal = candidates.filter((candidate) => {
    const centerX = (candidate.bbox.x + candidate.bbox.width / 2) / sourceWidth;
    return centerX >= .1 && centerX <= .9 && candidate.bbox.width / sourceWidth <= .82 && candidate.bbox.height / sourceHeight <= .22;
  });
  if (internal.length < 3) return null;
  const left=Math.min(...internal.map((item)=>item.bbox.x)),top=Math.min(...internal.map((item)=>item.bbox.y));
  const right=Math.max(...internal.map((item)=>item.bbox.x+item.bbox.width)),bottom=Math.max(...internal.map((item)=>item.bbox.y+item.bbox.height));
  const padX=Math.round(sourceWidth*.07),padY=Math.round(sourceHeight*.025);
  const bbox={x:Math.max(0,left-padX),y:Math.max(0,top-padY),width:Math.min(sourceWidth,right+padX)-Math.max(0,left-padX),height:Math.min(sourceHeight,bottom+padY)-Math.max(0,top-padY)};
  const areaRatio=bbox.width*bbox.height/(sourceWidth*sourceHeight); if(areaRatio<.04||areaRatio>.8)return null;
  const passIds=[...new Set(internal.flatMap((item)=>item.detection.passIds))];
  const coverage=clamp01(internal.reduce((sum,item)=>sum+item.bbox.width*item.bbox.height,0)/Math.max(1,bbox.width*bbox.height));
  const stability=passIds.length/PASSES.length;
  return {id:"label-canny-envelope",bbox,polygon:rectPolygon(bbox),score:round(clamp01(.58+stability*.22+coverage*.12+Math.min(.12,internal.length*.012))),metrics:{edgeSupport:round(coverage),rectangularity:round(clamp01(.65+coverage*.35)),solidity:round(coverage),stability:round(stability),areaRatio:round(areaRatio)},detection:{passId:"multi-pass-envelope",passIds,config:{id:"multi-pass-envelope",blurKernel:3 as const,low:0,high:0}}};
}

async function loadGray(filePath: string, blurKernel: number, previewMaxSide: number): Promise<Raster> {
  const result = await sharp(filePath, { failOn: "none" }).rotate().resize({ width: previewMaxSide, height: previewMaxSide, fit: "inside", withoutEnlargement: true }).grayscale().blur(blurKernel === 5 ? 1.25 : 0.75).raw().toBuffer({ resolveWithObject: true });
  return { data: result.data, width: result.info.width, height: result.info.height };
}

async function loadColor(filePath: string, previewMaxSide: number): Promise<ColorRaster> {
  const result = await sharp(filePath, { failOn: "none" }).rotate().resize({ width: previewMaxSide, height: previewMaxSide, fit: "inside", withoutEnlargement: true }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  return { data: result.data, width: result.info.width, height: result.info.height, channels: result.info.channels };
}

function hysteresisEdges(raster: Raster, low: number, high: number) {
  const magnitude = new Uint16Array(raster.width * raster.height);
  for (let y = 1; y < raster.height - 1; y += 1) for (let x = 1; x < raster.width - 1; x += 1) {
    const at = (dx: number, dy: number) => raster.data[(y + dy) * raster.width + x + dx] ?? 0;
    const gx = -at(-1, -1) + at(1, -1) - 2 * at(-1, 0) + 2 * at(1, 0) - at(-1, 1) + at(1, 1);
    const gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1);
    magnitude[y * raster.width + x] = Math.min(1020, Math.round(Math.hypot(gx, gy)));
  }
  const edges = new Uint8Array(magnitude.length); const queued = new Uint8Array(magnitude.length); const queue: number[] = [];
  for (let index = 0; index < magnitude.length; index += 1) if ((magnitude[index] ?? 0) >= high) { queued[index] = 1; queue.push(index); }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]!; edges[index] = 1; const x = index % raster.width; const y = Math.floor(index / raster.width);
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const nx = x + dx; const ny = y + dy; if (nx < 0 || ny < 0 || nx >= raster.width || ny >= raster.height) continue;
      const neighbor = ny * raster.width + nx; if (!queued[neighbor] && (magnitude[neighbor] ?? 0) >= low) { queued[neighbor] = 1; queue.push(neighbor); }
    }
  }
  return edges;
}

function dilate(input: Uint8Array, width: number, height: number) { const output = new Uint8Array(input.length); for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { let on = 0; for (let dy = -1; dy <= 1 && !on; dy += 1) for (let dx = -1; dx <= 1; dx += 1) { const nx=x+dx, ny=y+dy; if(nx>=0&&ny>=0&&nx<width&&ny<height&&input[ny*width+nx]){on=1;break;} } output[y*width+x]=on; } return output; }
function erode(input: Uint8Array, width: number, height: number) { const output = new Uint8Array(input.length); for (let y = 1; y < height-1; y += 1) for (let x = 1; x < width-1; x += 1) { let on = 1; for (let dy=-1;dy<=1&&on;dy+=1) for(let dx=-1;dx<=1;dx+=1) if(!input[(y+dy)*width+x+dx]){on=0;break;} output[y*width+x]=on; } return output; }

function connectedComponents(mask: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(mask.length); const output: Array<{ minX:number;minY:number;maxX:number;maxY:number;area:number }> = [];
  for (let start=0;start<mask.length;start+=1) { if(!mask[start]||visited[start])continue; const queue=[start];visited[start]=1;let cursor=0,area=0,minX=width,minY=height,maxX=0,maxY=0;
    while(cursor<queue.length){const index=queue[cursor++]!;const x=index%width,y=Math.floor(index/width);area+=1;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);for(let dy=-1;dy<=1;dy+=1)for(let dx=-1;dx<=1;dx+=1){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=width||ny>=height)continue;const neighbor=ny*width+nx;if(mask[neighbor]&&!visited[neighbor]){visited[neighbor]=1;queue.push(neighbor);}}}
    output.push({minX,minY,maxX,maxY,area});
  } return output;
}

function scoreComponent(component: {minX:number;minY:number;maxX:number;maxY:number;area:number}, width:number,height:number,pass:PassConfig,sourceWidth:number,sourceHeight:number): RawCandidate|null {
  const boxWidth=component.maxX-component.minX+1,boxHeight=component.maxY-component.minY+1; const areaRatio=boxWidth*boxHeight/(width*height); const aspect=boxWidth/Math.max(1,boxHeight);
  if(areaRatio<0.01||areaRatio>0.8||aspect<0.15||aspect>8||component.area<24)return null;
  const bbox={x:Math.round(component.minX/width*sourceWidth),y:Math.round(component.minY/height*sourceHeight),width:Math.round(boxWidth/width*sourceWidth),height:Math.round(boxHeight/height*sourceHeight)};
  const edgeSupport=clamp01(component.area/Math.max(1,2*(boxWidth+boxHeight))*0.6); const fill=component.area/Math.max(1,boxWidth*boxHeight);
  const centerX=(component.minX+component.maxX)/2/width,centerY=(component.minY+component.maxY)/2/height; const positionScore=clamp01(1-Math.abs(centerX-.5)*1.4-Math.max(0,Math.abs(centerY-.58)-.32));
  return {bbox,pass,edgeSupport,rectangularity:clamp01(edgeSupport*.75+(1-Math.min(1,fill))*.25),solidity:clamp01(component.area/Math.max(1,boxWidth*boxHeight)*4),areaRatio,positionScore};
}

function suppressOverlaps(values:RawCandidate[]){return values.sort((a,b)=>b.bbox.width*b.bbox.height-a.bbox.width*a.bbox.height).filter((value,index,array)=>array.slice(0,index).every((other)=>rectIoU(value.bbox,other.bbox)<.92));}
function suppressCandidateOverlaps<T extends { bbox: Rect; score: number }>(values:T[],threshold:number){return values.sort((a,b)=>b.score-a.score).filter((value,index,array)=>array.slice(0,index).every((other)=>rectIoU(value.bbox,other.bbox)<threshold));}
function clusterCandidates(values:RawCandidate[]){const clusters:RawCandidate[][]=[];for(const value of values){const cluster=clusters.find((items)=>items.some((item)=>rectIoU(item.bbox,value.bbox)>=.72));if(cluster)cluster.push(value);else clusters.push([value]);}return clusters.filter((cluster)=>new Set(cluster.map((item)=>item.pass.id)).size>=2||cluster[0]!.edgeSupport>=.35);}
function weightedRect(values:RawCandidate[]):Rect{const weight=values.reduce((sum,item)=>sum+Math.max(.1,item.edgeSupport),0);return{x:Math.round(values.reduce((sum,item)=>sum+item.bbox.x*Math.max(.1,item.edgeSupport),0)/weight),y:Math.round(values.reduce((sum,item)=>sum+item.bbox.y*Math.max(.1,item.edgeSupport),0)/weight),width:Math.round(values.reduce((sum,item)=>sum+item.bbox.width*Math.max(.1,item.edgeSupport),0)/weight),height:Math.round(values.reduce((sum,item)=>sum+item.bbox.height*Math.max(.1,item.edgeSupport),0)/weight)};}
function averageMetrics(values:RawCandidate[]){const average=(key:keyof Omit<RawCandidate,"bbox"|"pass">)=>values.reduce((sum,item)=>sum+item[key],0)/values.length;return{edgeSupport:average("edgeSupport"),rectangularity:average("rectangularity"),solidity:average("solidity"),areaRatio:average("areaRatio"),positionScore:average("positionScore")};}
function areaPreference(value:number){return clamp01(1-Math.abs(value-.18)/.35);}
function rectIoU(a:Rect,b:Rect){const x1=Math.max(a.x,b.x),y1=Math.max(a.y,b.y),x2=Math.min(a.x+a.width,b.x+b.width),y2=Math.min(a.y+a.height,b.y+b.height);const intersection=Math.max(0,x2-x1)*Math.max(0,y2-y1);return intersection/Math.max(1,a.width*a.height+b.width*b.height-intersection);}
function overlapOverSmaller(a:Rect,b:Rect){const x1=Math.max(a.x,b.x),y1=Math.max(a.y,b.y),x2=Math.min(a.x+a.width,b.x+b.width),y2=Math.min(a.y+a.height,b.y+b.height);const intersection=Math.max(0,x2-x1)*Math.max(0,y2-y1);return intersection/Math.max(1,Math.min(a.width*a.height,b.width*b.height));}
function percentile(values:number[],ratio:number){const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.min(sorted.length-1,Math.round((sorted.length-1)*ratio)))]??0;}
function normalizeAutoLabelConfig(value?: Partial<AutoLabelConfigV1>): AutoLabelConfigV1 { return {
  schemaVersion: 1,
  previewMaxSide: clampNumber(value?.previewMaxSide, 256, 960, DEFAULT_AUTO_LABEL_CONFIG.previewMaxSide),
  chromaTolerance: clampNumber(value?.chromaTolerance, 4, 80, DEFAULT_AUTO_LABEL_CONFIG.chromaTolerance),
  minimumLightness: clampNumber(value?.minimumLightness, 40, 240, DEFAULT_AUTO_LABEL_CONFIG.minimumLightness),
  minRegionWidthRatio: clampNumber(value?.minRegionWidthRatio, .1, .9, DEFAULT_AUTO_LABEL_CONFIG.minRegionWidthRatio),
  maxRegionWidthRatio: clampNumber(value?.maxRegionWidthRatio, .5, 1, DEFAULT_AUTO_LABEL_CONFIG.maxRegionWidthRatio),
  rowGapRatio: clampNumber(value?.rowGapRatio, .01, .3, DEFAULT_AUTO_LABEL_CONFIG.rowGapRatio),
  minimumBandCoverage: clampNumber(value?.minimumBandCoverage, .15, .95, DEFAULT_AUTO_LABEL_CONFIG.minimumBandCoverage),
  envelopeCoverage: clampNumber(value?.envelopeCoverage, .2, 1, DEFAULT_AUTO_LABEL_CONFIG.envelopeCoverage),
  envelopeSizeMultiplier: clampNumber(value?.envelopeSizeMultiplier, 1, 4, DEFAULT_AUTO_LABEL_CONFIG.envelopeSizeMultiplier),
}; }
function clampNumber(value:number|undefined,min:number,max:number,fallback:number){return Math.max(min,Math.min(max,typeof value==="number"&&Number.isFinite(value)?value:fallback));}
function rectPolygon(rect:Rect):Array<[number,number]>{return[[rect.x,rect.y],[rect.x+rect.width,rect.y],[rect.x+rect.width,rect.y+rect.height],[rect.x,rect.y+rect.height]];}
function clamp01(value:number){return Math.max(0,Math.min(1,value));}function round(value:number){return Math.round(value*10000)/10000;}
