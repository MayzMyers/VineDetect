import { sourceAssetRef } from "../../shared/officialReference.js";
import type { SourceName } from "../../shared/types.js";
import { getSourceItemForTrack } from "../../db/official-draft.repository.js";
import { NotFoundError } from "../../shared/errors.js";
import { resolveLocalAssetPath } from "../recognize-node/assets.js";
import sharp from "sharp";
import { runLabelDetection, type AutoLabelConfigV1, type PackageAwareLabelContext } from "./labelDetection.js";
import { runBottleContext, runPackageContext, type PartialBottleConfig } from "./bottleContext.js";
import { enrichLabelCandidatesWithSiglip } from "../../vision/siglipClient.js";
import { env } from "../../config/env.js";
import type { SiglipLabelMode, VisionEvidenceConfig } from "../../vision/semanticEvidence.js";

type Rect = { x: number; y: number; width: number; height: number };

export async function runSourceAnalysis(input: { source: SourceName; sourceItemId: string; annotationTrackId: string; verifiedLabel?: Rect; packageScope?: Rect; packageContext?: PackageAwareLabelContext | null; outerConfig?: PartialBottleConfig; labelConfig?: Partial<AutoLabelConfigV1>; visionEvidence?: { labelMode?: SiglipLabelMode } }) {
  const sourceItem = await getSourceItemForTrack(input.source, input.sourceItemId, input.annotationTrackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const imageUrl = sourceAssetRef(sourceItem);
  const imagePath = imageUrl ? resolveLocalAssetPath(imageUrl) : null;
  if (!imageUrl) throw new NotFoundError("Source image is missing");
  if (!imagePath) throw new NotFoundError("Source image not found in asset store");
  const metadata = await sharp(imagePath, { failOn: "none" }).rotate().metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const packageConditioningContext = await resolveLabelPackageContext(imagePath, width, height, input.packageContext);
  const initialDetection = await runLabelDetection(imagePath, width, height, input.labelConfig, packageConditioningContext);
  const detection = initialDetection.candidates.length
    ? initialDetection
    : await recoverEmptyLabelDetection({
        imagePath, width, height, inputConfig: input.labelConfig, packageContext: packageConditioningContext, initialDetection,
      });
  const packageScope = input.packageScope ? clampRect(input.packageScope, width, height) : null;
  const cvCandidates = packageScope ? filterCandidatesToPackageScope(detection.candidates, packageScope, 0.5) : detection.candidates;
  const visionEvidenceConfig: VisionEvidenceConfig = {
    labelMode: input.visionEvidence?.labelMode ?? defaultLabelMode(),
    source: input.visionEvidence?.labelMode ? "run-override" : "server-default",
  };
  const semantic = await enrichLabelCandidatesWithSiglip({
    imagePath,
    candidates: cvCandidates,
    mode: visionEvidenceConfig.labelMode,
    enabled: input.visionEvidence?.labelMode ? input.visionEvidence.labelMode !== "off" : undefined,
  });
  const evaluatedCandidates = semantic.candidates.map((candidate) => ({ ...candidate, verifiedIoU: input.verifiedLabel ? rectIoU(candidate.bbox, input.verifiedLabel) : null }));
  const winner = input.verifiedLabel ? [...evaluatedCandidates].sort((left, right) => (right.verifiedIoU ?? 0) - (left.verifiedIoU ?? 0))[0] : null;
  const rawBottleDetection = input.verifiedLabel && imagePath ? await runBottleContext(imagePath, width, height, input.verifiedLabel, input.outerConfig) : null;
  const bottleDetection = rawBottleDetection && packageScope ? scopeBottleDetection(rawBottleDetection, packageScope) : rawBottleDetection;
  const selectedBottle = bottleDetection?.candidates.find((candidate) => candidate.id === bottleDetection.selectedCandidateId) ?? null;
  const outerObject = selectedBottle && bottleDetection ? {
    bbox: selectedBottle.bbox,
    contour: selectedBottle.contour,
    palette: bottleDetection.palette,
    confidence: selectedBottle.score,
    method: bottleDetection.algorithm,
    config: bottleDetection.config,
    verifiedLabel: input.verifiedLabel,
    warnings: ["DERIVED_BOTTLE_CANDIDATE; NOT_VERIFIED_BOTTLE_GROUND_TRUTH"],
  } : null;
  return {
    schemaVersion: 1,
    runId: `source-analysis-${Date.now().toString(36)}`,
    algorithm: detection.algorithm,
    version: 7,
    sourceImage: { width, height, imageUrl },
    packageScope,
    packageContext: input.packageContext ?? null,
    packageConditioningContext,
    visionEvidenceConfig,
    semanticEvidence: semantic.evidence,
    candidates: evaluatedCandidates,
    labelDetection: { config: detection.config, debug: detection.debug },
    passes: detection.passes,
    intermediateStates: labelIntermediateStates(detection.algorithm, detection.passes, evaluatedCandidates.length, semantic.evidence),
    outerObject,
    bottleDetection,
    winningDetection: winner ? { candidateId: winner.id, passId: winner.detection.passId, config: winner.detection.config, verifiedIoU: winner.verifiedIoU ?? 0 } : null,
    createdAt: new Date().toISOString(),
  };
}

async function resolveLabelPackageContext(imagePath: string, width: number, height: number, reviewed: PackageAwareLabelContext | null | undefined): Promise<PackageAwareLabelContext | null> {
  if (!reviewed || reviewed.packageType !== "bottle" || reviewed.contour.length > 4) return reviewed ?? null;
  const helper = await runPackageContext(imagePath, width, height);
  const selected = helper.candidates.find((candidate) => candidate.id === helper.selectedCandidateId);
  if (!selected || selected.contour.length <= 4 || selected.classification.type !== "bottle" || selected.classification.confidence < .55) return reviewed;
  return {
    bbox: selected.bbox,
    contour: selected.contour,
    packageType: "bottle",
    confidence: selected.classification.confidence,
    source: "runtime-package-helper",
  };
}

function defaultLabelMode(): SiglipLabelMode {
  return env.SIGLIP_MODE === "score-only" || env.SIGLIP_MODE === "rerank" ? env.SIGLIP_MODE : "off";
}

async function recoverEmptyLabelDetection(input: {
  imagePath: string;
  width: number;
  height: number;
  inputConfig?: Partial<AutoLabelConfigV1>;
  packageContext?: PackageAwareLabelContext | null;
  initialDetection: Awaited<ReturnType<typeof runLabelDetection>>;
}) {
  const initialPreviewMaxSide = input.initialDetection.config.previewMaxSide;
  const previewMaxSides = [640, 512, 420]
    .filter((value) => value < initialPreviewMaxSide)
    .filter((value, index, values) => values.indexOf(value) === index);
  if (!previewMaxSides.length) return input.initialDetection;
  const attempts = await Promise.all(previewMaxSides.map(async (previewMaxSide) => ({
    previewMaxSide,
    detection: await runLabelDetection(
      input.imagePath,
      input.width,
      input.height,
      { ...input.inputConfig, previewMaxSide },
      input.packageContext,
    ),
  })));
  const selected = attempts
    .filter((attempt) => attempt.detection.candidates.length > 0)
    .sort((left, right) => detectionRecoveryScore(right.detection) - detectionRecoveryScore(left.detection)
      || right.previewMaxSide - left.previewMaxSide)[0];
  const recovery = {
    trigger: "zero-candidates",
    initialPreviewMaxSide,
    attempts: attempts.map((attempt) => ({
      previewMaxSide: attempt.previewMaxSide,
      candidateCount: attempt.detection.candidates.length,
      bestScore: roundRecoveryScore(detectionRecoveryScore(attempt.detection)),
    })),
    selectedPreviewMaxSide: selected?.previewMaxSide ?? null,
  };
  if (!selected) return {
    ...input.initialDetection,
    debug: { ...input.initialDetection.debug, multiScaleRecovery: recovery },
  };
  return {
    ...selected.detection,
    debug: {
      ...selected.detection.debug,
      multiScaleRecovery: recovery,
      initialPreview: input.initialDetection.debug.preview,
    },
  };
}

function detectionRecoveryScore(detection: Awaited<ReturnType<typeof runLabelDetection>>) {
  return Math.max(0, ...detection.candidates.map((candidate) => (
    candidate.geometrySemantic?.confidence ?? candidate.score
  )));
}

function roundRecoveryScore(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function labelIntermediateStates(algorithm: string, passes: Array<{ id: string; candidateIds: string[]; stats: Record<string, unknown> }>, candidateCount: number, semanticEvidence: Awaited<ReturnType<typeof enrichLabelCandidatesWithSiglip>>["evidence"]) {
  const boundedPasses = passes.slice(0, 30);
  return [
    { id: "label.detect", parentId: null, sequence: 0, status: "completed" as const, algorithm, summary: { passCount: passes.length } },
    ...boundedPasses.map((pass, index) => ({
      id: `label.pass.${index + 1}`, parentId: "label.detect", sequence: index + 1, status: "completed" as const,
      algorithm: pass.id, summary: { candidateIds: pass.candidateIds, stats: pass.stats },
    })),
    { id: "label.consensus", parentId: "label.detect", sequence: boundedPasses.length + 1, status: "completed" as const, algorithm: "multi-family-consensus", summary: { candidateCount } },
    { id: "label.semantic", parentId: "label.detect", sequence: boundedPasses.length + 2, status: semanticEvidence.status === "available" ? "completed" as const : "skipped" as const, algorithm: semanticEvidence.status === "disabled" ? "siglip-disabled" : "siglip2-label-reranker-v1", summary: semanticEvidence },
    { id: "label.rank", parentId: "label.detect", sequence: boundedPasses.length + 3, status: "completed" as const, algorithm: semanticEvidence.mode === "rerank" && semanticEvidence.status === "available" ? "label-fusion-v2" : "label-candidate-ranking-v1", summary: { candidateCount } },
  ];
}

async function buildOuterObject(root: Record<string, unknown>, width: number, height: number, verifiedLabel: Rect, imageUrl: string, outerConfig?: PartialBottleConfig) {
  const derived = await deriveOuterForeground(imageUrl, verifiedLabel, width, height, outerConfig);
  if (derived) return derived;
  const bottle = record(root.bottle);
  const roi = normalizedRect(bottle.roi);
  if (!roi.width || !roi.height) return null;
  const bbox = toNatural(roi, width, height);
  const palette = await outerPalette(imageUrl, bbox, verifiedLabel, width, height);
  return {
    bbox,
    contour: rectPolygon(bbox),
    palette,
    confidence: number(record(bottle.detection).confidence) ?? 0,
    method: "parent-roi-minus-label-v1",
    config: {},
    verifiedLabel,
    warnings: ["OUTER_CONTOUR_IS_DERIVED_SOURCE_FOREGROUND; NOT_REVIEWED_BOTTLE_GROUND_TRUTH"],
  };
}

async function deriveOuterForeground(imageUrl: string, label: Rect, sourceWidth: number, sourceHeight: number, inputConfig?: PartialBottleConfig) {
  const imagePath = resolveLocalAssetPath(imageUrl); if (!imagePath) return null;
  const raster = await sharp(imagePath, { failOn: "none" }).rotate().resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true }).removeAlpha().toColorspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = raster.info; const border: number[][] = [];
  for (let x=0;x<width;x+=1){border.push(pixel(raster.data,channels,width,x,0),pixel(raster.data,channels,width,x,height-1));}
  for(let y=1;y<height-1;y+=1){border.push(pixel(raster.data,channels,width,0,y),pixel(raster.data,channels,width,width-1,y));}
  const background=[0,1,2].map((channel)=>border.reduce((sum,value)=>sum+(value[channel]??0),0)/Math.max(1,border.length));
  const colorDistanceThreshold=Math.max(4,Math.min(120,inputConfig?.colorDistanceThreshold??22));
  const closeKernel=Math.max(1,Math.min(15,Math.round(inputConfig?.closeKernel??3))); const normalizedKernel=closeKernel%2===0?Math.min(15,closeKernel+1):closeKernel;
  let mask=new Uint8Array(width*height); for(let y=0;y<height;y+=1)for(let x=0;x<width;x+=1){const rgb=pixel(raster.data,channels,width,x,y);const distance=Math.sqrt(rgb.reduce((sum,value,index)=>sum+(value-(background[index]??0))**2,0));if(distance>=colorDistanceThreshold)mask[y*width+x]=1;}
  mask=closeMask(mask,width,height,normalizedKernel); const components=maskComponents(mask,width,height);
  const scaleX=width/sourceWidth,scaleY=height/sourceHeight; const labelCenter={x:(label.x+label.width/2)*scaleX,y:(label.y+label.height/2)*scaleY};
  const parent=components.filter((item)=>labelCenter.x>=item.minX&&labelCenter.x<=item.maxX&&labelCenter.y>=item.minY&&labelCenter.y<=item.maxY&&item.area>=label.width*scaleX*label.height*scaleY).sort((a,b)=>b.area-a.area)[0];
  if(!parent)return null;
  const labelLeft=Math.floor(label.x*scaleX),labelTop=Math.floor(label.y*scaleY),labelRight=Math.ceil((label.x+label.width)*scaleX),labelBottom=Math.ceil((label.y+label.height)*scaleY);
  const counts=new Map<number,number>();let pixels=0;const boundary:Array<[number,number]>=[];
  for(const index of parent.indices){const x=index%width,y=Math.floor(index/width);if(x>=labelLeft&&x<=labelRight&&y>=labelTop&&y<=labelBottom)continue;const rgb=pixel(raster.data,channels,width,x,y);const key=(Math.round((rgb[0]??0)/32)<<16)|(Math.round((rgb[1]??0)/32)<<8)|Math.round((rgb[2]??0)/32);counts.set(key,(counts.get(key)??0)+1);pixels+=1;if(!mask[index-1]||!mask[index+1]||!mask[index-width]||!mask[index+width])boundary.push([Math.round(x/scaleX),Math.round(y/scaleY)]);}
  const centerX=(parent.minX+parent.maxX)/2/scaleX,centerY=(parent.minY+parent.maxY)/2/scaleY;
  boundary.sort((left,right)=>Math.atan2(left[1]-centerY,left[0]-centerX)-Math.atan2(right[1]-centerY,right[0]-centerX));
  const stride=Math.max(1,Math.ceil(boundary.length/512)); const contour=boundary.filter((_value,index)=>index%stride===0).slice(0,512);
  const bbox={x:Math.round(parent.minX/scaleX),y:Math.round(parent.minY/scaleY),width:Math.round((parent.maxX-parent.minX+1)/scaleX),height:Math.round((parent.maxY-parent.minY+1)/scaleY)};
  const palette=[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([key,count])=>{const rgb=[Math.min(255,((key>>16)&255)*32),Math.min(255,((key>>8)&255)*32),Math.min(255,(key&255)*32)];return{rgb,lab:rgbToLab(rgb),ratio:pixels?Math.round(count/pixels*10000)/10000:0};});
  const coverage=parent.area/(width*height); const confidence=Math.round(Math.max(0,Math.min(1,.45+Math.min(.35,coverage*.5)+Math.min(.2,contour.length/1000)))*10000)/10000;
  return {bbox,contour:contour.length>=3?contour:rectPolygon(bbox),palette,confidence,method:"border-foreground-minus-label-v1",config:{colorDistanceThreshold,closeKernel:normalizedKernel},verifiedLabel:label,warnings:["DERIVED_OUTER_CONTEXT; NOT_REVIEWED_BOTTLE_GROUND_TRUTH"]};
}

function pixel(data:Buffer,channels:number,width:number,x:number,y:number){const offset=(y*width+x)*channels;return[data[offset]??0,data[offset+1]??0,data[offset+2]??0];}
function closeMask(mask:Uint8Array,width:number,height:number,kernel:number){const radius=Math.floor(kernel/2);const dilated=new Uint8Array(mask.length);for(let y=0;y<height;y+=1)for(let x=0;x<width;x+=1){for(let dy=-radius;dy<=radius&&!dilated[y*width+x];dy+=1)for(let dx=-radius;dx<=radius;dx+=1){const nx=x+dx,ny=y+dy;if(nx>=0&&ny>=0&&nx<width&&ny<height&&mask[ny*width+nx])dilated[y*width+x]=1;}}const output=new Uint8Array(mask.length);for(let y=radius;y<height-radius;y+=1)for(let x=radius;x<width-radius;x+=1){let on=1;for(let dy=-radius;dy<=radius&&on;dy+=1)for(let dx=-radius;dx<=radius;dx+=1)if(!dilated[(y+dy)*width+x+dx]){on=0;break;}output[y*width+x]=on;}return output;}
function maskComponents(mask:Uint8Array,width:number,height:number){const seen=new Uint8Array(mask.length);const output:Array<{minX:number;minY:number;maxX:number;maxY:number;area:number;indices:number[]}>=[];for(let start=0;start<mask.length;start+=1){if(!mask[start]||seen[start])continue;const queue=[start],indices:number[]=[];seen[start]=1;let cursor=0,minX=width,minY=height,maxX=0,maxY=0;while(cursor<queue.length){const index=queue[cursor++]!,x=index%width,y=Math.floor(index/width);indices.push(index);minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);for(let dy=-1;dy<=1;dy+=1)for(let dx=-1;dx<=1;dx+=1){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=width||ny>=height)continue;const n=ny*width+nx;if(mask[n]&&!seen[n]){seen[n]=1;queue.push(n);}}}output.push({minX,minY,maxX,maxY,area:indices.length,indices});}return output;}

async function outerPalette(imageUrl: string, outer: Rect, label: Rect, sourceWidth: number, sourceHeight: number) {
  const imagePath = resolveLocalAssetPath(imageUrl);
  if (!imagePath) return [];
  const raster = await sharp(imagePath, { failOn: "none" }).rotate().resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true }).removeAlpha().toColorspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const scaleX = raster.info.width / Math.max(1, sourceWidth); const scaleY = raster.info.height / Math.max(1, sourceHeight);
  const counts = new Map<number, number>(); let pixels = 0;
  for (let y = Math.max(0, Math.floor(outer.y * scaleY)); y < Math.min(raster.info.height, Math.ceil((outer.y + outer.height) * scaleY)); y += 1) for (let x = Math.max(0, Math.floor(outer.x * scaleX)); x < Math.min(raster.info.width, Math.ceil((outer.x + outer.width) * scaleX)); x += 1) {
    const sourceX = x / scaleX; const sourceY = y / scaleY;
    if (sourceX >= label.x && sourceX <= label.x + label.width && sourceY >= label.y && sourceY <= label.y + label.height) continue;
    const offset = (y * raster.info.width + x) * raster.info.channels;
    const r = raster.data[offset] ?? 0; const g = raster.data[offset + 1] ?? 0; const b = raster.data[offset + 2] ?? 0;
    const key = (Math.round(r / 32) << 16) | (Math.round(g / 32) << 8) | Math.round(b / 32);
    counts.set(key, (counts.get(key) ?? 0) + 1); pixels += 1;
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, count]) => {
    const rgb = [Math.min(255, ((key >> 16) & 255) * 32), Math.min(255, ((key >> 8) & 255) * 32), Math.min(255, (key & 255) * 32)];
    return { rgb, lab: rgbToLab(rgb), ratio: pixels ? Math.round(count / pixels * 10000) / 10000 : 0 };
  });
}

function normalizedRect(value: unknown): Rect {
  const item = record(value);
  return { x: number(item.x) ?? 0, y: number(item.y) ?? 0, width: number(item.width) ?? 0, height: number(item.height) ?? 0 };
}
function toNatural(rect: Rect, width: number, height: number): Rect {
  return { x: Math.round(rect.x * width), y: Math.round(rect.y * height), width: Math.round(rect.width * width), height: Math.round(rect.height * height) };
}
function rectPolygon(rect: Rect): Array<[number, number]> { return [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height]]; }
function rectIoU(left: Rect, right: Rect) {
  const x1 = Math.max(left.x, right.x); const y1 = Math.max(left.y, right.y); const x2 = Math.min(left.x + left.width, right.x + right.width); const y2 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return Math.round(intersection / Math.max(1, left.width * left.height + right.width * right.height - intersection) * 10000) / 10000;
}
function rectCoverage(inner: Rect, outer: Rect) {
  const x1 = Math.max(inner.x, outer.x), y1 = Math.max(inner.y, outer.y);
  const x2 = Math.min(inner.x + inner.width, outer.x + outer.width), y2 = Math.min(inner.y + inner.height, outer.y + outer.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1) / Math.max(1, inner.width * inner.height);
}
export function filterCandidatesToPackageScope<T extends { bbox: Rect }>(candidates: T[], scope: Rect, minimumCoverage = 0.5): T[] {
  return candidates.filter((candidate) => rectCoverage(candidate.bbox, scope) >= minimumCoverage);
}
function clampRect(value: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width, value.x)), y = Math.max(0, Math.min(height, value.y));
  const right = Math.max(x, Math.min(width, value.x + value.width)), bottom = Math.max(y, Math.min(height, value.y + value.height));
  return { x, y, width: right - x, height: bottom - y };
}
function scopeBottleDetection<T extends { candidates: Array<{ id: string; bbox: Rect }>; selectedCandidateId: string | null }>(detection: T, scope: Rect): T {
  const candidates = filterCandidatesToPackageScope(detection.candidates, scope, 0.75);
  const selectedCandidateId = candidates.some((candidate) => candidate.id === detection.selectedCandidateId)
    ? detection.selectedCandidateId
    : candidates[0]?.id ?? null;
  return { ...detection, candidates, selectedCandidateId };
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function number(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function string(value: unknown) { return typeof value === "string" ? value : null; }
function rgbToLab(rgb: number[]) {
  const [r, g, b] = rgb.map((value) => { const channel = value / 255; return channel > 0.04045 ? ((channel + 0.055) / 1.055) ** 2.4 : channel / 12.92; });
  const x = (r! * 0.4124 + g! * 0.3576 + b! * 0.1805) / 0.95047;
  const y = r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
  const z = (r! * 0.0193 + g! * 0.1192 + b! * 0.9505) / 1.08883;
  const f = (value: number) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  return [Math.round((116 * f(y) - 16) * 10) / 10, Math.round((500 * (f(x) - f(y))) * 10) / 10, Math.round((200 * (f(y) - f(z))) * 10) / 10];
}
