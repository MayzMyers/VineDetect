import sharp from "sharp";

export type BottleRect = { x: number; y: number; width: number; height: number };
export type BottleDetectionConfig = {
  processingMode: "preview" | "final";
  previewMaxSize: number;
  paddingPercent: number;
  silhouetteThreshold: number;
  connectivity: 4 | 8;
  simplifyTolerance: number;
  canny: { blurKernel: 3 | 5; low: number; high: number };
  morphology: { closeKernel: 0 | 3 | 5 | 7; iterations: number };
};

type Point = [number, number];
type Raster = { data: Buffer; width: number; height: number; channels: number };
type Component = { indices: number[]; minX: number; minY: number; maxX: number; maxY: number };

export const DEFAULT_BOTTLE_CONFIG: BottleDetectionConfig = {
  processingMode: "preview",
  previewMaxSize: 420,
  paddingPercent: 8,
  silhouetteThreshold: 18,
  connectivity: 4,
  simplifyTolerance: 2,
  canny: { blurKernel: 3, low: 40, high: 100 },
  morphology: { closeKernel: 5, iterations: 1 },
};

export async function runBottleContext(filePath: string, sourceWidth: number, sourceHeight: number, label: BottleRect, input?: PartialBottleConfig) {
  return runPhysicalPackageContext(filePath, sourceWidth, sourceHeight, label, input);
}

export async function runPackageContext(filePath: string, sourceWidth: number, sourceHeight: number, input?: PartialBottleConfig) {
  const result = await runPhysicalPackageContext(filePath, sourceWidth, sourceHeight, null, input);
  return {
    ...result,
    algorithm: "package-smart-lasso-v1" as const,
    candidates: result.candidates.map((candidate) => ({ ...candidate, classification: classifyPackageShape(candidate) })),
  };
}

async function runPhysicalPackageContext(filePath: string, sourceWidth: number, sourceHeight: number, label: BottleRect | null, input?: PartialBottleConfig) {
  const startedAt = Date.now();
  const config = normalizeBottleConfig(input);
  const raster = await loadRaster(filePath, config.processingMode, config.previewMaxSize);
  const scaleX = raster.width / Math.max(1, sourceWidth);
  const scaleY = raster.height / Math.max(1, sourceHeight);
  const paddingX = Math.max(2, Math.round(raster.width * config.paddingPercent / 100));
  const paddingY = Math.max(2, Math.round(raster.height * config.paddingPercent / 100));
  const sampledNeutral = medianBorderColor(raster);
  const neutral: [number, number, number] = [sampledNeutral[0] ?? 255, sampledNeutral[1] ?? 255, sampledNeutral[2] ?? 255];
  const padded = addNeutralPadding(raster, paddingX, paddingY, neutral);
  const labelRaster = label ? scaleRect(label, scaleX, scaleY) : null;
  const paddedLabel = labelRaster ? { ...labelRaster, x: labelRaster.x + paddingX, y: labelRaster.y + paddingY } : null;
  const previewReferenceMaxSide = Math.min(config.previewMaxSize, Math.max(raster.width, raster.height));
  const processingScale = config.processingMode === "final"
    ? Math.max(raster.width, raster.height) / Math.max(1, previewReferenceMaxSide)
    : 1;
  const cleanupOpenKernel = scaledOddKernel(9, processingScale);
  const cleanupCloseKernel = scaledOddKernel(3, processingScale);
  const background = borderBackgroundFlood(padded, rgbToLab(neutral), config.silhouetteThreshold, config.connectivity, paddedLabel ?? undefined);
  const alphaForeground = alphaForegroundMask(raster);
  const foreground = alphaForeground
    ? unionMasks(invertMask(background), padMask(alphaForeground, raster.width, raster.height, paddingX, paddingY, padded.width, padded.height))
    : invertMask(background);
  // Catalog images can contain thin scan/compression streaks connected to the
  // product. Remove those narrow branches before closing small silhouette gaps;
  // otherwise the external contour grows long horizontal excursions.
  const foregroundOpened = openMask(foreground, padded.width, padded.height, cleanupOpenKernel, 1);
  const foregroundClosed = closeMask(foregroundOpened, padded.width, padded.height, cleanupCloseKernel, 1);
  const effectiveSimplifyTolerance = config.simplifyTolerance * processingScale;
  let edges: Uint8Array<ArrayBufferLike> = new Uint8Array(padded.width * padded.height);
  let morphology: Uint8Array<ArrayBufferLike> = edges;
  let softMorphology: Uint8Array<ArrayBufferLike> = edges;
  const calculateEdgeFallback = () => {
    const gray = grayscale(padded);
    const blurred = boxBlur(gray, padded.width, padded.height, config.canny.blurKernel);
    edges = hysteresisEdges(blurred, padded.width, padded.height, config.canny.low, config.canny.high);
    const edgeCloseKernel = scaledOddKernel(config.morphology.closeKernel || 3, processingScale);
    morphology = closeMask(edges, padded.width, padded.height, edgeCloseKernel, config.morphology.iterations);
    const softEdges = hysteresisEdges(
      blurred,
      padded.width,
      padded.height,
      Math.min(config.canny.low, 10),
      Math.min(config.canny.high, 28),
    );
    softMorphology = closeMask(softEdges, padded.width, padded.height, edgeCloseKernel, config.morphology.iterations);
  };
  calculateEdgeFallback();
  const foregroundComponents = connectedComponents(foregroundClosed, padded.width, padded.height, config.connectivity);
  let evaluated = foregroundComponents.map((component) => ({ component, candidate: buildOutlineCandidate({
    component, operation: "border-flood", edges, morphology: foregroundClosed, paddedWidth: padded.width, paddedHeight: padded.height,
    sourceRasterWidth: raster.width, sourceRasterHeight: raster.height, paddingX, paddingY,
    label: paddedLabel, scaleX, scaleY, effectiveSimplifyTolerance,
  }) }));
  const edgeSilhouette = enclosedSilhouette(morphology, padded.width, padded.height);
  const referenceComponent = paddedLabel
    ? foregroundComponents
      .filter((component) => {
        const labelCenterX = paddedLabel.x + paddedLabel.width / 2;
        const labelCenterY = paddedLabel.y + paddedLabel.height / 2;
        return labelCenterX >= component.minX && labelCenterX <= component.maxX && labelCenterY >= component.minY && labelCenterY <= component.maxY;
      })
      .sort((left, right) => right.indices.length - left.indices.length)[0]
    : [...foregroundComponents].sort((left, right) => packageComponentPriority(right, padded.width) - packageComponentPriority(left, padded.width))[0];
  const guidedEdgeSilhouette = referenceComponent
    ? edgeSpanSilhouette(softMorphology, padded.width, padded.height, referenceComponent)
    : new Uint8Array(morphology.length);
  // Do not union the full edge silhouette here: catalog streaks and shadows can
  // form large closed regions outside the package. Only the centre-guided edge
  // corridor is allowed to extend an otherwise trusted flood-fill component.
  const combinedSilhouette = unionMasks(foregroundClosed, guidedEdgeSilhouette);
  evaluated = [...evaluated, ...connectedComponents(combinedSilhouette, padded.width, padded.height, config.connectivity).map((component) => ({ component, candidate: buildOutlineCandidate({
    component, operation: "combined-fill", edges, morphology: combinedSilhouette, paddedWidth: padded.width, paddedHeight: padded.height,
    sourceRasterWidth: raster.width, sourceRasterHeight: raster.height, paddingX, paddingY,
    label: paddedLabel, scaleX, scaleY, effectiveSimplifyTolerance,
  }) }))];
  if (!evaluated.some((item) => item.candidate)) {
    evaluated = [...evaluated, ...connectedComponents(edgeSilhouette, padded.width, padded.height, config.connectivity).map((component) => ({ component, candidate: buildOutlineCandidate({
      component, operation: "edge-fallback", edges, morphology, paddedWidth: padded.width, paddedHeight: padded.height,
      sourceRasterWidth: raster.width, sourceRasterHeight: raster.height, paddingX, paddingY,
      label: paddedLabel, scaleX, scaleY, effectiveSimplifyTolerance,
    }) }))];
  }
  const candidates = evaluated
    .map((item) => item.candidate)
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((left, right) => label ? right.selectionArea - left.selectionArea || right.score - left.score : right.score - left.score || right.selectionArea - left.selectionArea)
    .filter((candidate, index, all) => all.slice(0, index).every((other) => rectIoU(candidate.bbox, other.bbox) < 0.92))
    .slice(0, 8)
    .map((candidate, index) => ({ ...candidate, id: `${candidate.origin}-${index + 1}`, recommended: index === 0 }));

  const labelMask = labelRaster ? rectMask(raster.width, raster.height, labelRaster, 0) : new Uint8Array(raster.width * raster.height);
  const candidatesWithPalette = candidates.map((candidate) => ({ ...candidate, palette: paletteForPolygon(raster, candidate.rasterPolygon, labelMask) }));
  const selected = candidatesWithPalette[0] ?? null;
  const palette = selected?.palette ?? [];
  return {
    algorithm: label ? "bottle-border-flood-v2" as const : "package-smart-lasso-v1" as const,
    config,
    candidates: candidatesWithPalette.map(({ rasterPolygon: _rasterPolygon, selectionArea: _selectionArea, ...candidate }) => candidate),
    selectedCandidateId: selected?.id ?? null,
    annotation: null,
    palette,
    debug: {
      contourCount: evaluated.length,
      acceptedCount: candidates.length,
      rejectedContours: evaluated.filter((item) => !item.candidate).slice(0, 80).map(({ component }) => componentRectPolygonPadded(component, paddingX, paddingY, scaleX, scaleY, sourceWidth, sourceHeight)),
      raster: config.processingMode === "preview" ? {
        width: raster.width,
        height: raster.height,
        background: Buffer.from(cropMask(background, padded.width, paddingX, paddingY, raster.width, raster.height)).toString("base64"),
        foreground: Buffer.from(cropMask(foreground, padded.width, paddingX, paddingY, raster.width, raster.height)).toString("base64"),
        foregroundClosed: Buffer.from(cropMask(foregroundClosed, padded.width, paddingX, paddingY, raster.width, raster.height)).toString("base64"),
        edges: Buffer.from(cropMask(edges, padded.width, paddingX, paddingY, raster.width, raster.height)).toString("base64"),
        morphology: Buffer.from(cropMask(morphology, padded.width, paddingX, paddingY, raster.width, raster.height)).toString("base64"),
        edgeSilhouette: Buffer.from(cropMask(edgeSilhouette, padded.width, paddingX, paddingY, raster.width, raster.height)).toString("base64"),
        combinedSilhouette: Buffer.from(cropMask(combinedSilhouette, padded.width, paddingX, paddingY, raster.width, raster.height)).toString("base64"),
      } : undefined,
      padding: { percent: config.paddingPercent, x: paddingX, y: paddingY, fill: neutral },
      processing: { mode: config.processingMode, rasterWidth: raster.width, rasterHeight: raster.height, sourceWidth, sourceHeight, cleanupOpenKernel, cleanupCloseKernel, effectiveSimplifyTolerance: round(effectiveSimplifyTolerance), elapsedMs: Date.now() - startedAt },
    },
  };
}

export type PartialBottleConfig = {
  processingMode?: "preview" | "final";
  previewMaxSize?: number;
  backgroundThreshold?: number;
  colorDistanceThreshold?: number;
  labelExclusionDilate?: number;
  curveSegments?: number;
  paddingPercent?: number;
  silhouetteThreshold?: number;
  connectivity?: 4 | 8;
  simplifyTolerance?: number;
  closeKernel?: number;
  canny?: { blurKernel?: number; low?: number; high?: number };
  morphology?: { closeKernel?: number; iterations?: number };
};

function normalizeBottleConfig(input?: PartialBottleConfig): BottleDetectionConfig {
  const blurKernel = input?.canny?.blurKernel === 5 ? 5 : 3;
  const low = clamp(Math.round(input?.canny?.low ?? DEFAULT_BOTTLE_CONFIG.canny.low), 1, 400);
  const high = clamp(Math.round(input?.canny?.high ?? DEFAULT_BOTTLE_CONFIG.canny.high), low + 1, 800);
  const requestedClose = input?.morphology?.closeKernel ?? input?.closeKernel ?? DEFAULT_BOTTLE_CONFIG.morphology.closeKernel;
  const closeKernel = ([0, 3, 5, 7] as const).reduce((best, value) => Math.abs(value - requestedClose) < Math.abs(best - requestedClose) ? value : best, 5 as 0 | 3 | 5 | 7);
  return {
    processingMode: input?.processingMode === "final" ? "final" : "preview",
    previewMaxSize: clamp(Math.round(input?.previewMaxSize ?? DEFAULT_BOTTLE_CONFIG.previewMaxSize), 256, 960),
    paddingPercent: clamp(input?.paddingPercent ?? DEFAULT_BOTTLE_CONFIG.paddingPercent, 2, 20),
    silhouetteThreshold: clamp(input?.silhouetteThreshold ?? input?.backgroundThreshold ?? DEFAULT_BOTTLE_CONFIG.silhouetteThreshold, 2, 80),
    connectivity: input?.connectivity === 8 ? 8 : 4,
    simplifyTolerance: clamp(input?.simplifyTolerance ?? DEFAULT_BOTTLE_CONFIG.simplifyTolerance, 0.5, 8),
    canny: { blurKernel, low, high },
    morphology: { closeKernel, iterations: clamp(Math.round(input?.morphology?.iterations ?? DEFAULT_BOTTLE_CONFIG.morphology.iterations), 1, 2) },
  };
}

async function loadRaster(filePath: string, mode: "preview" | "final", previewMaxSize: number): Promise<Raster> {
  let pipeline = sharp(filePath, { failOn: "none" }).rotate();
  if (mode === "preview") pipeline = pipeline.resize({ width: previewMaxSize, height: previewMaxSize, fit: "inside", withoutEnlargement: true });
  const result = await pipeline.toColorspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: result.data, width: result.info.width, height: result.info.height, channels: result.info.channels };
}

function addNeutralPadding(raster: Raster, paddingX: number, paddingY: number, fill: [number, number, number]): Raster {
  const width = raster.width + paddingX * 2;
  const height = raster.height + paddingY * 2;
  const data = Buffer.alloc(width * height * raster.channels);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * raster.channels;
    for (let channel = 0; channel < raster.channels; channel += 1) data[offset + channel] = fill[Math.min(channel, 2)] ?? 255;
  }
  for (let y = 0; y < raster.height; y += 1) {
    const sourceStart = y * raster.width * raster.channels;
    const targetStart = ((y + paddingY) * width + paddingX) * raster.channels;
    raster.data.copy(data, targetStart, sourceStart, sourceStart + raster.width * raster.channels);
  }
  return { data, width, height, channels: raster.channels };
}

function grayscale(raster: Raster) {
  const output = new Uint8Array(raster.width * raster.height);
  for (let index = 0; index < output.length; index += 1) {
    const [r, g, b] = pixelAt(raster, index);
    output[index] = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
  }
  return output;
}

function cropMask(mask: Uint8Array, paddedWidth: number, paddingX: number, paddingY: number, width: number, height: number) {
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    output.set(mask.subarray((y + paddingY) * paddedWidth + paddingX, (y + paddingY) * paddedWidth + paddingX + width), y * width);
  }
  return output;
}

function padMask(mask: Uint8Array, width: number, height: number, paddingX: number, paddingY: number, paddedWidth: number, paddedHeight: number) {
  const output = new Uint8Array(paddedWidth * paddedHeight);
  for (let y = 0; y < height; y += 1) output.set(mask.subarray(y * width, (y + 1) * width), (y + paddingY) * paddedWidth + paddingX);
  return output;
}

function alphaForegroundMask(raster: Raster) {
  if (raster.channels < 4) return null;
  let borderPixels = 0;
  let transparentBorderPixels = 0;
  const inspect = (index: number) => {
    borderPixels += 1;
    if ((raster.data[index * raster.channels + 3] ?? 255) < 16) transparentBorderPixels += 1;
  };
  for (let x = 0; x < raster.width; x += 1) { inspect(x); inspect((raster.height - 1) * raster.width + x); }
  for (let y = 1; y < raster.height - 1; y += 1) { inspect(y * raster.width); inspect(y * raster.width + raster.width - 1); }
  if (transparentBorderPixels / Math.max(1, borderPixels) < 0.5) return null;
  const output = new Uint8Array(raster.width * raster.height);
  for (let index = 0; index < output.length; index += 1) if ((raster.data[index * raster.channels + 3] ?? 0) >= 16) output[index] = 1;
  return output;
}

function neutralDistanceMask(raster: Raster, neutral: [number, number, number], threshold: number) {
  const output = new Uint8Array(raster.width * raster.height);
  for (let index = 0; index < output.length; index += 1) {
    const rgb = pixelAt(raster, index);
    const distance = Math.hypot(rgb[0] - neutral[0], rgb[1] - neutral[1], rgb[2] - neutral[2]);
    if (distance >= threshold) output[index] = 1;
  }
  return output;
}

function borderBackgroundFlood(raster: Raster, backgroundLab: number[], tolerance: number, connectivity: 4 | 8, protectedForeground?: BottleRect) {
  const background = new Uint8Array(raster.width * raster.height); const tested = new Uint8Array(background.length); const queue: number[] = [];
  const enqueueSeed = (index: number) => { if (!tested[index]) { tested[index] = 1; background[index] = 1; queue.push(index); } };
  for (let x = 0; x < raster.width; x += 1) { enqueueSeed(x); enqueueSeed((raster.height - 1) * raster.width + x); }
  for (let y = 1; y < raster.height - 1; y += 1) { enqueueSeed(y * raster.width); enqueueSeed(y * raster.width + raster.width - 1); }
  const neighbors = connectivity === 8 ? [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]] : [[0,-1],[-1,0],[1,0],[0,1]];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]!; const x = index % raster.width; const y = Math.floor(index / raster.width);
    for (const [dx, dy] of neighbors) {
      const nx = x + dx!; const ny = y + dy!;
      if (nx < 0 || ny < 0 || nx >= raster.width || ny >= raster.height) continue;
      const next = ny * raster.width + nx;
      if (tested[next]) continue;
      tested[next] = 1;
      // A reviewed label is ground truth and must remain inside the bottle
      // foreground even when a generous background tolerance is used for
      // light catalog gradients and compression streaks.
      if (protectedForeground && pointInRect(nx, ny, protectedForeground)) continue;
      if (labDistance(rgbToLab(pixelAt(raster, next)), backgroundLab) <= tolerance) { background[next] = 1; queue.push(next); }
    }
  }
  return background;
}

function pointInRect(x: number, y: number, rect: BottleRect) {
  return x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height;
}

function invertMask(mask: Uint8Array) {
  const output = new Uint8Array(mask.length);
  for (let index = 0; index < output.length; index += 1) output[index] = mask[index] ? 0 : 1;
  return output;
}

function unionMasks(left: Uint8Array, right: Uint8Array) {
  const output = new Uint8Array(left.length);
  for (let index = 0; index < output.length; index += 1) output[index] = left[index] || right[index] ? 1 : 0;
  return output;
}

/**
 * Recover pale transparent bottle necks whose pixels look like the catalog
 * background. Border flood cannot keep those pixels, while Canny still sees
 * the two glass boundaries. Follow paired edge spans upward from the trusted
 * foreground component and fill only the narrow, centre-aligned corridor.
 */
function edgeSpanSilhouette(edges: Uint8Array, width: number, height: number, component: Component) {
  const output = new Uint8Array(edges.length);
  const center = (component.minX + component.maxX) / 2;
  const componentWidth = Math.max(4, component.maxX - component.minX + 1);
  const searchPadding = Math.max(3, Math.round(componentWidth * 0.08));
  const searchLeft = Math.max(1, component.minX - searchPadding);
  const searchRight = Math.min(width - 2, component.maxX + searchPadding);
  let previousLeft = component.minX;
  let previousRight = component.maxX;
  let previousY = component.minY;
  let hasPreviousSpan = false;
  let missedRows = 0;
  const gapBudget = Math.max(4, Math.round(height * 0.025));

  for (let y = component.minY; y >= 1; y -= 1) {
    let left = -1;
    let right = -1;
    for (let x = searchLeft; x <= searchRight; x += 1) {
      if (!edges[y * width + x]) continue;
      if (x < center) left = left < 0 ? x : Math.min(left, x);
      if (x > center) right = Math.max(right, x);
    }
    if (left < 0 || right < 0) {
      missedRows += 1;
      if (missedRows > gapBudget) break;
      continue;
    }
    const spanWidth = right - left;
    const previousWidth = Math.max(1, previousRight - previousLeft);
    const spanCenter = (left + right) / 2;
    const maxCenterShift = Math.max(3, previousWidth * 0.35);
    const plausible = spanWidth >= 3
      && spanWidth <= componentWidth * 1.15
      && Math.abs(spanCenter - center) <= componentWidth * 0.2
      && (!hasPreviousSpan || Math.abs(spanCenter - (previousLeft + previousRight) / 2) <= maxCenterShift)
      && (!hasPreviousSpan || spanWidth <= previousWidth * 1.6);
    if (!plausible) {
      missedRows += 1;
      if (missedRows > gapBudget) break;
      continue;
    }

    const gap = Math.max(1, previousY - y);
    for (let bridgeY = y; bridgeY <= previousY; bridgeY += 1) {
      const t = gap === 0 ? 0 : (bridgeY - y) / gap;
      const bridgeLeft = Math.round(left + (previousLeft - left) * t);
      const bridgeRight = Math.round(right + (previousRight - right) * t);
      for (let x = bridgeLeft; x <= bridgeRight; x += 1) output[bridgeY * width + x] = 1;
    }
    previousLeft = left;
    previousRight = right;
    previousY = y;
    hasPreviousSpan = true;
    missedRows = 0;
  }
  return output;
}

function enclosedSilhouette(barrier: Uint8Array, width: number, height: number) {
  const exterior = new Uint8Array(barrier.length); const queue: number[] = [];
  const enqueue = (index: number) => { if (!barrier[index] && !exterior[index]) { exterior[index] = 1; queue.push(index); } };
  for (let x = 0; x < width; x += 1) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y += 1) { enqueue(y * width); enqueue(y * width + width - 1); }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]!; const x = index % width; const y = Math.floor(index / width);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nx = x + dx; const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < width && ny < height) enqueue(ny * width + nx);
    }
  }
  const output = new Uint8Array(barrier.length);
  for (let index = 0; index < output.length; index += 1) if (!exterior[index]) output[index] = 1;
  return output;
}

function buildOutlineCandidate(input: { component: Component; operation: "border-flood" | "combined-fill" | "edge-fallback"; edges: Uint8Array; morphology: Uint8Array; paddedWidth: number; paddedHeight: number; sourceRasterWidth: number; sourceRasterHeight: number; paddingX: number; paddingY: number; label: BottleRect | null; scaleX: number; scaleY: number; effectiveSimplifyTolerance: number }) {
  const { component, operation, edges, morphology, paddedWidth: width, paddedHeight: height, sourceRasterWidth, sourceRasterHeight, paddingX, paddingY, label, scaleX, scaleY, effectiveSimplifyTolerance } = input;
  if (component.indices.length < 24) return null;
  const traced = traceExternalBoundary(component, width, height);
  if (traced.length < 4) return null;
  const rawRasterContour = resampleClosedPolygon(traced, Math.min(512, Math.max(64, traced.length)));
  const simplified = simplifyClosedContour(rawRasterContour, effectiveSimplifyTolerance);
  const rasterPolygon = simplified;
  if (rasterPolygon.length < 3) return null;
  const rasterBbox = polygonBbox(rasterPolygon);
  const area = polygonArea(rasterPolygon);
  const imageArea = sourceRasterWidth * sourceRasterHeight;
  const labelArea = label ? label.width * label.height : 0;
  const unpaddedArea = polygonArea(rasterPolygon.map(([x, y]) => [clamp(x - paddingX, 0, sourceRasterWidth), clamp(y - paddingY, 0, sourceRasterHeight)] as Point));
  const areaRatio = unpaddedArea / Math.max(1, imageArea);
  const labelContainment = label ? sampledRectContainment(label, rasterPolygon) : 0;
  const paddedAreaRatio = area / Math.max(1, width * height);
  if (label) {
    if (area < labelArea * 1.05 || paddedAreaRatio > 0.92 || labelContainment < 0.75) return null;
  } else if (areaRatio < 0.012 || paddedAreaRatio > 0.92) return null;
  const edgeSupport = polygonBoundarySupport(rawRasterContour, edges, morphology, width, height);
  const hullBoxArea = rasterBbox.width * rasterBbox.height;
  const solidity = clamp01(area / Math.max(1, hullBoxArea));
  const borderContact = {
    top: rasterBbox.y <= 1,
    bottom: rasterBbox.y + rasterBbox.height >= height - 1,
    left: rasterBbox.x <= 1,
    right: rasterBbox.x + rasterBbox.width >= width - 1,
  };
  const borderCount = Object.values(borderContact).filter(Boolean).length;
  const closedness = clamp01(1 - borderCount * 0.16);
  const centerX = rasterBbox.x + rasterBbox.width / 2;
  const centerOffset = Math.abs(centerX - width / 2) / Math.max(1, width / 2);
  const areaScore = clamp01(area / Math.max(1, imageArea * 0.65));
  const centeredness = clamp01(1 - centerOffset);
  const score = label
    ? round(0.55 * labelContainment + 0.25 * edgeSupport + 0.2 * areaScore)
    : round(0.25 * edgeSupport + 0.2 * areaScore + 0.2 * solidity + 0.2 * centeredness + 0.15 * closedness);
  const contourStatus = borderCount ? "cropInterrupted" : closedness >= 0.85 ? "closed" : "partiallyClosed";
  const rawContour = rawRasterContour.map((point) => paddedPointToNatural(point, paddingX, paddingY, scaleX, scaleY, sourceRasterWidth, sourceRasterHeight));
  const simplifiedContour = simplified.map((point) => paddedPointToNatural(point, paddingX, paddingY, scaleX, scaleY, sourceRasterWidth, sourceRasterHeight));
  const polygon = simplifiedContour.map(roundPoint);
  const sourceRasterPolygon = rasterPolygon.map(([x, y]) => [clamp(x - paddingX, 0, sourceRasterWidth), clamp(y - paddingY, 0, sourceRasterHeight)] as Point);
  const sourceBbox = polygonBbox(sourceRasterPolygon);
  const bbox = { x: Math.round(sourceBbox.x / scaleX), y: Math.round(sourceBbox.y / scaleY), width: Math.round(sourceBbox.width / scaleX), height: Math.round(sourceBbox.height / scaleY) };
  return {
    id: "pending",
    contour: polygon,
    polygon,
    rawContour,
    simplifiedContour,
    bbox,
    metrics: { areaRatio: round(areaRatio), labelContainment: round(labelContainment), foregroundSupport: 1, edgeSupport: round(edgeSupport), closedness: round(closedness), solidity: round(solidity), borderContact, centerOffset: round(centerOffset), contourStatus },
    score,
    origin: operation,
    rasterPolygon: sourceRasterPolygon,
    selectionArea: area,
  };
}

function packageComponentPriority(component: Component, width: number) {
  const centerX = (component.minX + component.maxX) / 2;
  const centeredness = clamp01(1 - Math.abs(centerX - width / 2) / Math.max(1, width / 2));
  return component.indices.length * (0.55 + centeredness * 0.45);
}

function classifyPackageShape(candidate: { polygon: Point[]; bbox: BottleRect; metrics: { solidity: number; closedness: number; centerOffset: number } }) {
  const aspectRatio = candidate.bbox.height / Math.max(1, candidate.bbox.width);
  const topWidthRatio = polygonWidthAt(candidate.polygon, candidate.bbox, 0.12);
  const shoulderWidthRatio = polygonWidthAt(candidate.polygon, candidate.bbox, 0.32);
  const middleWidthRatio = polygonWidthAt(candidate.polygon, candidate.bbox, 0.55);
  const bottomWidthRatio = polygonWidthAt(candidate.polygon, candidate.bbox, 0.82);
  const bodyWidth = Math.max(0.01, (middleWidthRatio + bottomWidthRatio) / 2);
  const neckTaper = clamp01((bodyWidth - topWidthRatio) / Math.max(0.01, bodyWidth * 0.72));
  const sideStability = clamp01(1 - Math.abs(middleWidthRatio - bottomWidthRatio) / Math.max(0.01, bodyWidth));
  const rectangularProfile = clamp01(1 - (Math.abs(topWidthRatio - bodyWidth) + Math.abs(shoulderWidthRatio - bodyWidth)) / Math.max(0.01, bodyWidth * 1.5));
  const tallness = clamp01((aspectRatio - 1.05) / 1.5);
  const bottleScore = clamp01(0.42 * neckTaper + 0.25 * tallness + 0.13 * sideStability + 0.1 * candidate.metrics.closedness + 0.1 * (1 - candidate.metrics.centerOffset));
  const boxScore = clamp01(0.42 * rectangularProfile + 0.28 * candidate.metrics.solidity + 0.15 * sideStability + 0.15 * candidate.metrics.closedness);
  const type = bottleScore >= boxScore ? "bottle" as const : "box" as const;
  const winner = Math.max(bottleScore, boxScore);
  const runnerUp = Math.min(bottleScore, boxScore);
  return {
    type,
    confidence: round(clamp01(0.5 + (winner - runnerUp) * 0.75)),
    scores: { bottle: round(bottleScore), box: round(boxScore) },
    features: { aspectRatio: round(aspectRatio), topWidthRatio: round(topWidthRatio), shoulderWidthRatio: round(shoulderWidthRatio), middleWidthRatio: round(middleWidthRatio), bottomWidthRatio: round(bottomWidthRatio), neckTaper: round(neckTaper), rectangularProfile: round(rectangularProfile) },
  };
}

function polygonWidthAt(polygon: Point[], bbox: BottleRect, relativeY: number) {
  const y = bbox.y + bbox.height * relativeY;
  const samples = 80;
  let first = -1;
  let last = -1;
  for (let index = 0; index <= samples; index += 1) {
    const x = bbox.x + bbox.width * index / samples;
    if (!pointInPolygon(x, y, polygon)) continue;
    if (first < 0) first = index;
    last = index;
  }
  return first < 0 ? 0 : (last - first + 1) / (samples + 1);
}

function paletteForPolygon(raster: Raster, polygon: Point[], labelMask: Uint8Array) {
  const bbox = polygonBbox(polygon); const counts = new Map<number, number>(); let total = 0;
  for (let y = Math.max(0, bbox.y); y <= Math.min(raster.height - 1, bbox.y + bbox.height); y += 1) for (let x = Math.max(0, bbox.x); x <= Math.min(raster.width - 1, bbox.x + bbox.width); x += 1) {
    const index = y * raster.width + x;
    if (labelMask[index] || !pointInPolygon(x, y, polygon)) continue;
    const rgb = pixelAt(raster, index);
    if (Math.max(...rgb) >= 248 && Math.min(...rgb) >= 235) continue;
    const key = (Math.round(rgb[0] / 24) << 16) | (Math.round(rgb[1] / 24) << 8) | Math.round(rgb[2] / 24);
    counts.set(key, (counts.get(key) ?? 0) + 1); total += 1;
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, count]) => {
    const rgb = [Math.min(255, ((key >> 16) & 255) * 24), Math.min(255, ((key >> 8) & 255) * 24), Math.min(255, (key & 255) * 24)];
    return { rgb, lab: rgbToLab(rgb), ratio: round(count / Math.max(1, total)) };
  });
}

function medianBorderColor(raster: Raster) {
  const values: number[][] = [[], [], []]; const band = Math.max(1, Math.round(Math.min(raster.width, raster.height) * 0.025));
  for (let y = 0; y < raster.height; y += 1) for (let x = 0; x < raster.width; x += 1) {
    if (x >= band && x < raster.width - band && y >= band && y < raster.height - band) continue;
    const rgb = pixelAt(raster, y * raster.width + x); for (let channel = 0; channel < 3; channel += 1) values[channel]!.push(rgb[channel]!);
  }
  return values.map((channel) => channel.sort((a, b) => a - b)[Math.floor(channel.length / 2)] ?? 0);
}

function rectMask(width: number, height: number, rect: BottleRect, dilatePixels: number) {
  const mask = new Uint8Array(width * height);
  const left = clamp(Math.floor(rect.x - dilatePixels), 0, width - 1); const right = clamp(Math.ceil(rect.x + rect.width + dilatePixels), 0, width - 1);
  const top = clamp(Math.floor(rect.y - dilatePixels), 0, height - 1); const bottom = clamp(Math.ceil(rect.y + rect.height + dilatePixels), 0, height - 1);
  for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) mask[y * width + x] = 1;
  return mask;
}

function boxBlur(input: Uint8Array, width: number, height: number, kernel: number) {
  const radius = Math.floor(kernel / 2); const output = new Uint8Array(input.length);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { let sum = 0; let count = 0;
    for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) { const nx = x + dx; const ny = y + dy; if (nx >= 0 && ny >= 0 && nx < width && ny < height) { sum += input[ny * width + nx] ?? 0; count += 1; } }
    output[y * width + x] = Math.round(sum / Math.max(1, count));
  }
  return output;
}

function hysteresisEdges(gray: Uint8Array, width: number, height: number, low: number, high: number) {
  const magnitude = new Uint16Array(gray.length);
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const at = (dx: number, dy: number) => gray[(y + dy) * width + x + dx] ?? 0;
    const gx = -at(-1, -1) + at(1, -1) - 2 * at(-1, 0) + 2 * at(1, 0) - at(-1, 1) + at(1, 1);
    const gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1);
    magnitude[y * width + x] = Math.min(1442, Math.round(Math.hypot(gx, gy)));
  }
  const output = new Uint8Array(gray.length); const queued = new Uint8Array(gray.length); const queue: number[] = [];
  for (let index = 0; index < magnitude.length; index += 1) if ((magnitude[index] ?? 0) >= high) { queued[index] = 1; queue.push(index); }
  for (let cursor = 0; cursor < queue.length; cursor += 1) { const index = queue[cursor]!; output[index] = 1; const x = index % width; const y = Math.floor(index / width);
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) { const nx = x + dx; const ny = y + dy; if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue; const next = ny * width + nx; if (!queued[next] && (magnitude[next] ?? 0) >= low) { queued[next] = 1; queue.push(next); } }
  }
  return output;
}

function closeMask(input: Uint8Array, width: number, height: number, kernel: number, iterations: number) {
  let output = input;
  for (let iteration = 0; iteration < iterations; iteration += 1) output = erode(dilate(output, width, height, kernel), width, height, kernel);
  return output;
}
function openMask(input: Uint8Array, width: number, height: number, kernel: number, iterations: number) {
  let output = input;
  for (let iteration = 0; iteration < iterations; iteration += 1) output = dilate(erode(output, width, height, kernel), width, height, kernel);
  return output;
}
function dilate(input: Uint8Array, width: number, height: number, kernel: number) { return binaryMorphology(input, width, height, kernel, "dilate"); }
function erode(input: Uint8Array, width: number, height: number, kernel: number) { return binaryMorphology(input, width, height, kernel, "erode"); }

function binaryMorphology(input: Uint8Array, width: number, height: number, kernel: number, operation: "dilate" | "erode") {
  const normalizedKernel = Math.max(1, Math.round(kernel) | 1);
  if (normalizedKernel === 1) return input.slice();
  const radius = Math.floor(normalizedKernel / 2);
  const horizontal = new Uint8Array(input.length);
  const output = new Uint8Array(input.length);
  const rowPrefix = new Int32Array(width + 1);
  for (let y = 0; y < height; y += 1) {
    rowPrefix[0] = 0;
    const offset = y * width;
    for (let x = 0; x < width; x += 1) rowPrefix[x + 1] = rowPrefix[x]! + (input[offset + x] ?? 0);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius); const right = Math.min(width - 1, x + radius);
      const sum = rowPrefix[right + 1]! - rowPrefix[left]!;
      horizontal[offset + x] = operation === "dilate" ? Number(sum > 0) : Number(left === x - radius && right === x + radius && sum === normalizedKernel);
    }
  }
  const columnPrefix = new Int32Array(height + 1);
  for (let x = 0; x < width; x += 1) {
    columnPrefix[0] = 0;
    for (let y = 0; y < height; y += 1) columnPrefix[y + 1] = columnPrefix[y]! + (horizontal[y * width + x] ?? 0);
    for (let y = 0; y < height; y += 1) {
      const top = Math.max(0, y - radius); const bottom = Math.min(height - 1, y + radius);
      const sum = columnPrefix[bottom + 1]! - columnPrefix[top]!;
      output[y * width + x] = operation === "dilate" ? Number(sum > 0) : Number(top === y - radius && bottom === y + radius && sum === normalizedKernel);
    }
  }
  return output;
}

function scaledOddKernel(kernel: number, scale: number) {
  const scaled = Math.max(1, Math.min(31, Math.round(kernel * scale)));
  return scaled % 2 === 0 ? Math.min(31, scaled + 1) : scaled;
}

function connectedComponents(mask: Uint8Array, width: number, height: number, connectivity: 4 | 8) { const seen = new Uint8Array(mask.length); const output: Component[] = []; const neighbors = connectivity === 8 ? [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]] : [[0,-1],[-1,0],[1,0],[0,1]]; for (let start = 0; start < mask.length; start += 1) { if (!mask[start] || seen[start]) continue; const queue = [start]; const indices: number[] = []; seen[start] = 1; let cursor = 0; let minX = width; let minY = height; let maxX = 0; let maxY = 0; while (cursor < queue.length) { const index = queue[cursor++]!; const x = index % width; const y = Math.floor(index / width); indices.push(index); minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); for (const [dx, dy] of neighbors) { const nx = x + dx!; const ny = y + dy!; if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue; const next = ny * width + nx; if (mask[next] && !seen[next]) { seen[next] = 1; queue.push(next); } } } output.push({ indices, minX, minY, maxX, maxY }); } return output; }
function mergeComponents(components: Component[]): Component { const indices = [...new Set(components.flatMap((component) => component.indices))]; return { indices, minX: Math.min(...components.map((component) => component.minX)), minY: Math.min(...components.map((component) => component.minY)), maxX: Math.max(...components.map((component) => component.maxX)), maxY: Math.max(...components.map((component) => component.maxY)) }; }

function traceExternalBoundary(component: Component, width: number, height: number): Point[] {
  const member = new Uint8Array(width * height);
  for (const index of component.indices) member[index] = 1;
  const edges: Array<{ start: Point; end: Point; used: boolean }> = [];
  const add = (start: Point, end: Point) => edges.push({ start, end, used: false });
  for (const index of component.indices) {
    const x = index % width; const y = Math.floor(index / width);
    if (y === 0 || !member[index - width]) add([x, y], [x + 1, y]);
    if (x === width - 1 || !member[index + 1]) add([x + 1, y], [x + 1, y + 1]);
    if (y === height - 1 || !member[index + width]) add([x + 1, y + 1], [x, y + 1]);
    if (x === 0 || !member[index - 1]) add([x, y + 1], [x, y]);
  }
  const byStart = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    const key = pointKey(edge.start);
    byStart.set(key, [...(byStart.get(key) ?? []), index]);
  });
  const loops: Point[][] = [];
  for (let startIndex = 0; startIndex < edges.length; startIndex += 1) {
    if (edges[startIndex]?.used) continue;
    const first = edges[startIndex]!; const loop: Point[] = [first.start];
    let edgeIndex: number | undefined = startIndex; let guard = 0;
    while (edgeIndex !== undefined && guard++ <= edges.length) {
      const edge: { start: Point; end: Point; used: boolean } = edges[edgeIndex]!; if (edge.used) break;
      edge.used = true; loop.push(edge.end);
      if (samePoint(edge.end, first.start)) break;
      edgeIndex = (byStart.get(pointKey(edge.end)) ?? []).find((candidate) => !edges[candidate]?.used);
    }
    if (loop.length >= 4 && samePoint(loop[0]!, loop.at(-1)!)) loops.push(loop.slice(0, -1));
  }
  return loops.sort((left, right) => polygonArea(right) - polygonArea(left))[0] ?? [];
}

function resampleClosedPolygon(points: Point[], count: number): Point[] {
  if (points.length < 2) return points;
  const lengths: number[] = [0]; let perimeter = 0;
  for (let index = 0; index < points.length; index += 1) {
    perimeter += pointDistance(points[index]!, points[(index + 1) % points.length]!);
    lengths.push(perimeter);
  }
  if (perimeter <= 0) return points.slice(0, count);
  const output: Point[] = []; let edge = 0;
  for (let sample = 0; sample < count; sample += 1) {
    const target = sample / count * perimeter;
    while (edge < points.length - 1 && (lengths[edge + 1] ?? perimeter) < target) edge += 1;
    const start = points[edge]!; const end = points[(edge + 1) % points.length]!;
    const edgeStart = lengths[edge] ?? 0; const edgeLength = Math.max(0.000001, (lengths[edge + 1] ?? perimeter) - edgeStart);
    const ratio = (target - edgeStart) / edgeLength;
    output.push([start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio]);
  }
  return output;
}

function smoothClosedPolygon(points: Point[], iterations: number): Point[] {
  let output = points;
  for (let iteration = 0; iteration < iterations; iteration += 1) output = output.map((point, index) => {
    const previous = output[(index - 1 + output.length) % output.length]!;
    const next = output[(index + 1) % output.length]!;
    return [(previous[0] + point[0] * 2 + next[0]) / 4, (previous[1] + point[1] * 2 + next[1]) / 4] as Point;
  });
  return output;
}

function simplifyClosedContour(points: Point[], tolerance: number): Point[] {
  if (points.length <= 4) return points;
  let first = 0; let second = 1; let maxDistance = 0;
  for (let left = 0; left < points.length; left += 1) for (let right = left + 1; right < points.length; right += 1) {
    const distance = pointDistance(points[left]!, points[right]!);
    if (distance > maxDistance) { maxDistance = distance; first = left; second = right; }
  }
  const arc = (start: number, end: number) => {
    const output: Point[] = [];
    for (let index = start; ; index = (index + 1) % points.length) {
      output.push(points[index]!);
      if (index === end) break;
    }
    return output;
  };
  const forward = simplifyOpenContour(arc(first, second), tolerance);
  const backward = simplifyOpenContour(arc(second, first), tolerance);
  const simplified = [...forward.slice(0, -1), ...backward.slice(0, -1)];
  return simplified.length >= 3 ? simplified : resampleClosedPolygon(points, 3);
}

function simplifyOpenContour(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points;
  const start = points[0]!; const end = points.at(-1)!;
  let maxDistance = 0; let split = -1;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = pointSegmentDistance(points[index]!, start, end);
    if (distance > maxDistance) { maxDistance = distance; split = index; }
  }
  if (split < 0 || maxDistance <= tolerance) return [start, end];
  const left = simplifyOpenContour(points.slice(0, split + 1), tolerance);
  const right = simplifyOpenContour(points.slice(split), tolerance);
  return [...left.slice(0, -1), ...right];
}

function pointSegmentDistance(point: Point, start: Point, end: Point) {
  const dx = end[0] - start[0]; const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.000001) return pointDistance(point, start);
  const ratio = clamp(((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared, 0, 1);
  return pointDistance(point, [start[0] + dx * ratio, start[1] + dy * ratio]);
}

function paddedPointToNatural(point: Point, paddingX: number, paddingY: number, scaleX: number, scaleY: number, sourceRasterWidth: number, sourceRasterHeight: number): Point {
  return roundPoint([
    clamp(point[0] - paddingX, 0, sourceRasterWidth) / Math.max(0.000001, scaleX),
    clamp(point[1] - paddingY, 0, sourceRasterHeight) / Math.max(0.000001, scaleY),
  ]);
}

function pointKey([x, y]: Point) { return `${x}:${y}`; }
function samePoint(left: Point, right: Point) { return left[0] === right[0] && left[1] === right[1]; }
function pointDistance(left: Point, right: Point) { return Math.hypot(left[0] - right[0], left[1] - right[1]); }
function roundPoint([x, y]: Point): Point { return [Math.round(x * 100) / 100, Math.round(y * 100) / 100]; }
function polygonBbox(points: Point[]) { const xs = points.map((point) => point[0]); const ys = points.map((point) => point[1]); const x = Math.floor(Math.min(...xs)); const y = Math.floor(Math.min(...ys)); return { x, y, width: Math.ceil(Math.max(...xs)) - x, height: Math.ceil(Math.max(...ys)) - y }; }
function polygonArea(points: Point[]) { let sum = 0; for (let index = 0; index < points.length; index += 1) { const current = points[index]!; const next = points[(index + 1) % points.length]!; sum += current[0] * next[1] - next[0] * current[1]; } return Math.abs(sum) / 2; }
function pointInPolygon(x: number, y: number, polygon: Point[]) { let inside = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i]!; const b = polygon[j]!; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; }
function sampledRectContainment(rect: BottleRect, polygon: Point[]) { let inside = 0; let total = 0; for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) { const x = rect.x + (column + 0.5) / 8 * rect.width; const y = rect.y + (row + 0.5) / 8 * rect.height; if (pointInPolygon(x, y, polygon)) inside += 1; total += 1; } return inside / total; }
function sampledPolygonSupport(polygon: Point[], bbox: BottleRect, mask: Uint8Array, width: number, height: number) { let supported = 0; let total = 0; const step = Math.max(1, Math.floor(Math.max(bbox.width, bbox.height) / 100)); for (let y = bbox.y; y <= bbox.y + bbox.height; y += step) for (let x = bbox.x; x <= bbox.x + bbox.width; x += step) { if (x < 0 || y < 0 || x >= width || y >= height || !pointInPolygon(x, y, polygon)) continue; total += 1; if (mask[y * width + x]) supported += 1; } return supported / Math.max(1, total); }
function polygonBoundarySupport(polygon: Point[], foreground: Uint8Array, edges: Uint8Array, width: number, height: number) { let supported = 0; for (const [x, y] of polygon) { let found = false; for (let dy = -2; dy <= 2 && !found; dy += 1) for (let dx = -2; dx <= 2; dx += 1) { const nx = x + dx; const ny = y + dy; if (nx >= 0 && ny >= 0 && nx < width && ny < height && (foreground[ny * width + nx] || edges[ny * width + nx])) { found = true; break; } } if (found) supported += 1; } return supported / Math.max(1, polygon.length); }
function scaleRect(rect: BottleRect, scaleX: number, scaleY: number): BottleRect { return { x: rect.x * scaleX, y: rect.y * scaleY, width: rect.width * scaleX, height: rect.height * scaleY }; }
function componentRectPolygon(component: Component, scaleX: number, scaleY: number): Point[] { const left = Math.round(component.minX / scaleX); const top = Math.round(component.minY / scaleY); const right = Math.round(component.maxX / scaleX); const bottom = Math.round(component.maxY / scaleY); return [[left, top], [right, top], [right, bottom], [left, bottom]]; }
function componentRectPolygonPadded(component: Component, paddingX: number, paddingY: number, scaleX: number, scaleY: number, sourceWidth: number, sourceHeight: number): Point[] { return [[component.minX, component.minY], [component.maxX, component.minY], [component.maxX, component.maxY], [component.minX, component.maxY]].map((point) => [clamp(Math.round((point[0] - paddingX) / scaleX), 0, sourceWidth), clamp(Math.round((point[1] - paddingY) / scaleY), 0, sourceHeight)] as Point); }
function pixelAt(raster: Raster, index: number) {
  const offset = index * raster.channels;
  const alpha = raster.channels >= 4 ? (raster.data[offset + 3] ?? 255) / 255 : 1;
  return [0, 1, 2].map((channel) => Math.round((raster.data[offset + channel] ?? 0) * alpha + 255 * (1 - alpha)));
}
function rgbToLab(rgb: number[]) { const [r, g, b] = rgb.map((value) => { const channel = value / 255; return channel > 0.04045 ? ((channel + 0.055) / 1.055) ** 2.4 : channel / 12.92; }); const x = ((r ?? 0) * 0.4124 + (g ?? 0) * 0.3576 + (b ?? 0) * 0.1805) / 0.95047; const y = (r ?? 0) * 0.2126 + (g ?? 0) * 0.7152 + (b ?? 0) * 0.0722; const z = ((r ?? 0) * 0.0193 + (g ?? 0) * 0.1192 + (b ?? 0) * 0.9505) / 1.08883; const transform = (value: number) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116; return [round(116 * transform(y) - 16), round(500 * (transform(x) - transform(y))), round(200 * (transform(y) - transform(z)))]; }
function labDistance(left: number[], right: number[]) { return Math.hypot((left[0] ?? 0) - (right[0] ?? 0), (left[1] ?? 0) - (right[1] ?? 0), (left[2] ?? 0) - (right[2] ?? 0)); }
function rectIoU(a: BottleRect, b: BottleRect) { const x1 = Math.max(a.x, b.x); const y1 = Math.max(a.y, b.y); const x2 = Math.min(a.x + a.width, b.x + b.width); const y2 = Math.min(a.y + a.height, b.y + b.height); const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return intersection / Math.max(1, a.width * a.height + b.width * b.height - intersection); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function clamp01(value: number) { return clamp(value, 0, 1); }
function round(value: number) { return Math.round(value * 10000) / 10000; }
