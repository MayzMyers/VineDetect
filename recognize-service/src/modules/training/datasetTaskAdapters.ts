import type { TrainingTask } from "../../db/training.repository.js";

export const TASK_ADAPTER_VERSION = 4;
export const ADAPTER_TASKS = ["label-roi", "physical-label-roi", "ocr-region", "source-matching", "alias-ranking", "bottle-outline", "label-elements", "label-palette"] as const satisfies readonly TrainingTask[];

export type FrozenDatasetRecord = {
  id: string;
  source: string;
  sourceItemId: string;
  split: "train" | "validation" | "test";
  snapshotHash: string;
  snapshot: Record<string, unknown>;
};

export type TaskDatasetRecord = {
  id: string;
  source: string;
  sourceItemId: string;
  split: FrozenDatasetRecord["split"];
  adapterVersion: number;
  input: Record<string, unknown>;
  target: Record<string, unknown>;
  provenance: { snapshotHash: string; snapshotSchemaVersion: number; annotationGraphSchemaVersion?: number };
};

export function buildTaskDatasets(records: FrozenDatasetRecord[]) {
  return Object.fromEntries(ADAPTER_TASKS.map((task) => [task, records.flatMap((record) => adaptTaskRecords(record, task))])) as Record<TrainingTask, TaskDatasetRecord[]>;
}

export function adaptTaskRecord(record: FrozenDatasetRecord, task: TrainingTask): TaskDatasetRecord | null {
  return adaptTaskRecords(record, task)[0] ?? null;
}

export function adaptTaskRecords(record: FrozenDatasetRecord, task: TrainingTask): TaskDatasetRecord[] {
  const canonical = adaptCanonicalTaskRecords(record, task);
  if (canonical.length > 0) return canonical;
  const legacy = adaptLegacyTaskRecord(record, task);
  return legacy ? [legacy] : [];
}

function adaptLegacyTaskRecord(record: FrozenDatasetRecord, task: TrainingTask): TaskDatasetRecord | null {
  const snapshot = record.snapshot;
  const label = objectValue(snapshot.label);
  const vision = objectValue(snapshot.vision);
  const annotations = objectValue(vision?.annotations);
  const cvMeta = objectValue(vision?.cvMeta);
  const base = {
    id: record.id,
    source: record.source,
    sourceItemId: record.sourceItemId,
    split: record.split,
    adapterVersion: TASK_ADAPTER_VERSION,
    provenance: { snapshotHash: record.snapshotHash, snapshotSchemaVersion: integerValue(snapshot.schemaVersion) ?? 1 },
  };
  const imageRef = stringValue(label?.image_url) ?? stringValue(objectValue(cvMeta?.bottleCoordinateSpace)?.imageUrl);
  const helperRecords = arrayValue(objectValue(cvMeta?.helpers)?.records);
  const helperContext = (helperId: string) => helperRecords.find((value) => objectValue(value)?.helperId === helperId) ?? null;

  if (task === "physical-label-roi") return null;
  if (task === "label-roi") {
    const bbox = objectValue(label?.bbox);
    if (!label || !bbox || !imageRef) return null;
    return { ...base, input: { imageRef, coordinateSpace: "source-image-pixels", helperContext: helperContext("label-roi-detection") }, target: { annotationId: label.id ?? null, revision: label.revision ?? null, bbox, polygon: arrayValue(label.polygon) } };
  }
  if (task === "ocr-region") {
    const regionSet = objectValue(snapshot.ocrRegions);
    const regions = arrayValue(regionSet?.regions);
    if (!regions.length || !imageRef || !objectValue(label?.bbox)) return null;
    return { ...base, input: { imageRef, labelRoi: label!.bbox, coordinateSpace: "reviewed-label-crop-normalized" }, target: { annotationSetId: regionSet?.id ?? null, revision: regionSet?.revision ?? null, regions } };
  }
  if (task === "source-matching") {
    const associationSet = objectValue(snapshot.sourceAssociations);
    const associations = arrayValue(associationSet?.associations);
    if (!associations.length) return null;
    return { ...base, input: { ocrRegions: arrayValue(objectValue(snapshot.ocrRegions)?.regions) }, target: { associationSetId: associationSet?.id ?? null, revision: associationSet?.revision ?? null, associations } };
  }
  if (task === "alias-ranking") {
    const aliasSet = objectValue(snapshot.aliases);
    const aliases = arrayValue(aliasSet?.aliases);
    if (!aliases.length) return null;
    return { ...base, input: { sourceAssociations: arrayValue(objectValue(snapshot.sourceAssociations)?.associations) }, target: { annotationSetId: aliasSet?.id ?? null, revision: aliasSet?.revision ?? null, aliases } };
  }
  if (task === "bottle-outline") {
    const bottle = objectValue(annotations?.bottle);
    if (!bottle || !imageRef) return null;
    return { ...base, input: { imageRef, labelAnchor: objectValue(label?.bbox), coordinateSpace: objectValue(cvMeta?.bottleCoordinateSpace) ?? { units: "source-image-pixels" }, helperContext: helperContext("bottle-outline") }, target: { bottle } };
  }
  if (task === "label-elements") {
    const elements = arrayValue(annotations?.elements);
    const contours = arrayValue(annotations?.contours);
    if (!elements.length || !contours.length || !imageRef || !objectValue(label?.bbox)) return null;
    return { ...base, input: { imageRef, labelRoi: label!.bbox, coordinateSpace: objectValue(cvMeta?.coordinateSpace) ?? { units: "label-crop-mask-pixels" }, helperContext: helperContext("label-elements") }, target: { elements, contours } };
  }
  const palette = arrayValue(annotations?.palette);
  if (!palette.length || !imageRef || !objectValue(label?.bbox)) return null;
  return { ...base, input: { imageRef, labelRoi: label!.bbox, coordinateSpace: "reviewed-label-crop", helperContext: helperContext("label-palette") }, target: { palette } };
}

function adaptCanonicalTaskRecords(record: FrozenDatasetRecord, task: TrainingTask): TaskDatasetRecord[] {
  if (task !== "label-roi" && task !== "physical-label-roi" && task !== "ocr-region" && task !== "bottle-outline" && task !== "label-elements" && task !== "label-palette") return [];
  const graph = objectValue(record.snapshot.annotationGraph);
  const packages = arrayValue(graph?.packages).map(objectValue).filter((value): value is Record<string, unknown> => value !== null);
  if (!graph || packages.length === 0) return [];
  const graphSchemaVersion = integerValue(graph.schemaVersion) ?? 1;
  const legacyLabel = objectValue(record.snapshot.label);
  const legacyVision = objectValue(record.snapshot.vision);
  const legacyCvMeta = objectValue(legacyVision?.cvMeta);
  const legacyImageRef = stringValue(legacyLabel?.image_url) ?? stringValue(objectValue(legacyCvMeta?.bottleCoordinateSpace)?.imageUrl);
  const base = {
    source: record.source,
    sourceItemId: record.sourceItemId,
    split: record.split,
    adapterVersion: TASK_ADAPTER_VERSION,
    provenance: {
      snapshotHash: record.snapshotHash,
      snapshotSchemaVersion: integerValue(record.snapshot.schemaVersion) ?? 1,
      annotationGraphSchemaVersion: graphSchemaVersion,
    },
  };

  if (task === "label-roi" || task === "physical-label-roi") return packages.flatMap((packageItem, packageIndex) => {
    const packageId = stringValue(packageItem.id);
    const imageRef = stringValue(packageItem.sourceAssetRef) ?? legacyImageRef;
    if (!packageId || !imageRef) return [];
    const labels = arrayValue(packageItem.labels).map(objectValue).filter((value): value is Record<string, unknown> => value !== null);
    return labels.flatMap((label, labelIndex) => {
      const labelId = stringValue(label.id);
      const geometry = objectValue(label.geometry);
      const geometryReviewStatus = stringValue(label.geometryReviewStatus) ?? (label.status === "reviewed" ? "reviewed" : "suggested");
      const visualRegionKind = objectValue(label.visualRegionKind) ?? { value: "unknown", status: "unreviewed" };
      if (!labelId || label.status !== "reviewed" || geometryReviewStatus !== "reviewed" || !geometry || !objectValue(geometry.bbox)) return [];
      if (task === "physical-label-roi" && (visualRegionKind.status !== "reviewed" || visualRegionKind.value !== "physical-label")) return [];
      return [{
        ...base,
        id: `${record.id}:label:${labelId}`,
        input: {
          imageRef,
          coordinateSpace: "source-image-pixels",
          package: { id: packageId, ordinal: packageIndex + 1, scope: objectValue(packageItem.scope) },
          helperContext: graphOperationContext(graph, "label", labelId),
        },
        target: { annotationId: labelId, ordinal: labelIndex + 1, geometry, bbox: geometry.bbox, rectification: label.rectification ?? null, visualRegionKind },
      }];
    });
  });

  if (task === "ocr-region") return packages.flatMap((packageItem, packageIndex) => {
    const packageId = stringValue(packageItem.id);
    const imageRef = stringValue(packageItem.sourceAssetRef) ?? legacyImageRef;
    if (!packageId || !imageRef) return [];
    const output: TaskDatasetRecord[] = [];
    for (const [labelIndex, label] of arrayValue(packageItem.labels).map(objectValue).filter((value): value is Record<string, unknown> => value !== null).entries()) {
      const labelId = stringValue(label.id);
      const regions = reviewedGraphOcr(label.ocr);
      if (!labelId || regions.length === 0) continue;
      output.push({
        ...base,
        id: `${record.id}:ocr:label:${labelId}`,
        input: {
          imageRef,
          parent: { type: "label", packageId, labelId, packageOrdinal: packageIndex + 1, labelOrdinal: labelIndex + 1 },
          labelGeometry: objectValue(label.geometry),
          helperContext: graphScopeOperationContext(graph, "label", labelId, "run_ocr"),
        },
        target: { parentType: "label", parentId: labelId, regions },
      });
    }
    return output;
  });

  if (task === "label-elements" || task === "label-palette") return packages.flatMap((packageItem, packageIndex) => {
    const packageId = stringValue(packageItem.id);
    const imageRef = stringValue(packageItem.sourceAssetRef) ?? legacyImageRef;
    if (!packageId || !imageRef) return [];
    return arrayValue(packageItem.labels).map(objectValue).filter((value): value is Record<string, unknown> => value !== null).flatMap((label, labelIndex): TaskDatasetRecord[] => {
      const labelId = stringValue(label.id);
      const cv = objectValue(label.cv);
      const job = objectValue(cv?.job);
      const preview = objectValue(job?.preview);
      if (!labelId || !job || !preview) return [];
      const workflow = objectValue(job.workflow);
      const checkpoints = objectValue(workflow?.checkpoints);
      if (task === "label-elements") {
        const elements = arrayValue(preview.elements).filter((value) => objectValue(value)?.status === "accepted");
        const acceptedIds = new Set(elements.map((value) => stringValue(objectValue(value)?.id)).filter(Boolean));
        const contours = arrayValue(preview.contours).filter((value) => acceptedIds.has(stringValue(objectValue(value)?.elementId)));
        if (!elements.length || !contours.length) return [];
        return [{ ...base, id: `${record.id}:elements:${labelId}`, input: {
          imageRef, parent: { type: "label", packageId, labelId, packageOrdinal: packageIndex + 1, labelOrdinal: labelIndex + 1 },
          labelGeometry: objectValue(label.geometry), coordinateSpace: objectValue(objectValue(preview.cvDebug)?.source) ?? { units: "label-crop-mask-pixels" },
          helperContext: objectValue(objectValue(checkpoints?.elements)?.execution),
        }, target: { elements, contours } }];
      }
      const palette = arrayValue(job.palette).length ? arrayValue(job.palette) : arrayValue(preview.palette);
      if (!palette.length) return [];
      return [{ ...base, id: `${record.id}:palette:${labelId}`, input: {
        imageRef, parent: { type: "label", packageId, labelId, packageOrdinal: packageIndex + 1, labelOrdinal: labelIndex + 1 },
        labelGeometry: objectValue(label.geometry), coordinateSpace: { units: "reviewed-label-crop" },
        helperContext: objectValue(objectValue(checkpoints?.palette)?.execution),
      }, target: { palette } }];
    });
  });

  return packages.flatMap((packageItem, packageIndex) => {
    const packageId = stringValue(packageItem.id);
    const imageRef = stringValue(packageItem.sourceAssetRef) ?? legacyImageRef;
    const objectContext = objectValue(packageItem.objectContext);
    const geometry = objectValue(objectContext?.geometry);
    if (!packageId || !imageRef || objectContext?.status !== "reviewed" || !geometry) return [];
    const labelAnchors = arrayValue(packageItem.labels).map(objectValue).filter((value): value is Record<string, unknown> => value !== null).map((label) => objectValue(label.geometry)).filter(Boolean);
    return [{
      ...base,
      id: `${record.id}:object:${packageId}`,
      input: {
        imageRef,
        package: { id: packageId, ordinal: packageIndex + 1, scope: objectValue(packageItem.scope), packageType: objectValue(packageItem.packageType) },
        labelAnchors,
        coordinateSpace: "source-image-pixels",
        helperContext: graphScopeOperationContext(graph, "package", packageId, "edit_package"),
      },
      target: { packageId, geometry, packageType: objectValue(packageItem.packageType) },
    }];
  });
}

function reviewedGraphOcr(value: unknown) {
  return arrayValue(value).map(objectValue).filter((region): region is Record<string, unknown> => region !== null && region.regionStatus === "reviewed");
}

function graphOperationContext(graph: Record<string, unknown>, entityType: string, entityId: string) {
  const operations = arrayValue(graph.operations).map(objectValue).filter((value): value is Record<string, unknown> => value !== null);
  const operation = [...operations].reverse().find((item) => {
    const result = objectValue(item.result);
    const multiResults = arrayValue(item.results).map(objectValue).filter((value): value is Record<string, unknown> => value !== null);
    return (result?.type === entityType && result.id === entityId)
      || multiResults.some((candidate) => candidate.type === entityType && candidate.id === entityId);
  });
  return operation ? operationContext(operation) : null;
}

function graphScopeOperationContext(graph: Record<string, unknown>, scopeType: string, scopeId: string, operationType: string) {
  const operations = arrayValue(graph.operations).map(objectValue).filter((value): value is Record<string, unknown> => value !== null);
  const operation = [...operations].reverse().find((item) => {
    const scope = objectValue(item.scope);
    return item.operationType === operationType && scope?.type === scopeType && scope.id === scopeId;
  });
  return operation ? operationContext(operation) : null;
}

function operationContext(operation: Record<string, unknown>) {
  return {
    operationId: operation.id ?? null,
    helper: operation.helper ?? null,
    initialConfig: objectValue(operation.initialConfig),
    finalConfig: objectValue(operation.finalConfig),
    candidates: arrayValue(operation.candidates),
    selectedCandidateId: operation.selectedCandidateId ?? null,
    candidateReviews: arrayValue(operation.candidateReviews),
    reviewOperations: arrayValue(operation.reviewOperations),
    roiReviewGraph: objectValue(operation.roiReviewGraph),
    reviewMode: operation.reviewMode ?? null,
  };
}

function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function objectValue(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.length ? value : null; }
function integerValue(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) ? value : null; }
