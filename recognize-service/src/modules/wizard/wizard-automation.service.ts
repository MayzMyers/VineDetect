import { getAnnotationGraphForTrack } from "../../db/official-draft.repository.js";
import { randomUUID } from "node:crypto";
import { getAnnotationGraph } from "../../db/annotation-graph.repository.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import { bindHelperToCard, type WizardStageId } from "../../shared/helperConfigContract.js";
import type { SourceName } from "../../shared/types.js";
import { DEFAULT_LABEL_ANALYSIS_CV_CONFIG } from "../label-analysis/labelCropFeatures.js";
import { previewLabelCvJobRecord, runGraphAutoOcrRecord, runSourceAnalysisRecord } from "../metadata/metadata.service.js";
import type { WizardAutomationRunRequest } from "./wizard.schemas.js";
import { getWizardStageState } from "./wizard.service.js";

const ORDER: WizardStageId[] = ["package", "label", "bottle", "ocr", "mask", "morphology", "components", "elements", "contours", "palette", "summary"];
const CV_STAGES = ["mask", "morphology", "components", "elements", "contours", "palette"] as const;

type RunRecord = { status: "completed" | "blocked" | "failed" | "skipped"; output?: unknown; reason?: string };

export async function runFullAutomaticPipeline(
  source: SourceName,
  sourceItemId: string,
  annotationId: string,
  input: WizardAutomationRunRequest,
) {
  const pipelineRunId = randomUUID();
  const startedAt = new Date().toISOString();
  const stages: Partial<Record<WizardStageId, RunRecord>> = {};
  const labelStages: Record<string, Partial<Record<WizardStageId, RunRecord>>> = {};
  const warnings: string[] = [];
  const failures: Array<{ stage: WizardStageId; labelId?: string; error: string }> = [];
  const throughIndex = ORDER.indexOf(input.through);

  const packageState = await getWizardStageState(source, sourceItemId, annotationId, "package");
  if (!packageState.validation.valid || packageState.status !== "reviewed") throw new ConflictError("A valid Package scope is required for automatic pipeline execution");
  stages.package = { status: "completed", output: packageState.state };
  if (throughIndex === 0) return finish();

  const defaultLabel = helperConfig(source, sourceItemId, "label-roi-detection");
  const defaultBottle = helperConfig(source, sourceItemId, "bottle-outline");
  const defaultOcr = helperConfig(source, sourceItemId, "label-ocr-cascade");
  await attempt("label", undefined, async () => {
    const output = await runSourceAnalysisRecord(source, sourceItemId, annotationId, {
      labelConfig: { ...defaultLabel, ...input.configs.label },
      outerConfig: { ...defaultBottle, ...input.configs.bottle },
    });
    stages.label = { status: "completed", output };
  });
  if (throughIndex === 1) return finish();

  const graph = await getAnnotationGraphForTrack(source, sourceItemId, annotationId);
  const packageEntity = graph.packages.find((item) => item.legacyAnnotationTrackId === annotationId);
  if (!packageEntity) throw new NotFoundError("Package for annotation track was not found");
  const reviewedLabels = packageEntity.labels.filter((item) => item.geometryReviewStatus === "reviewed" && item.geometry?.type === "quad");
  const requestedLabels = input.labelIds
    ? input.labelIds.map((id) => reviewedLabels.find((item) => item.id === id) ?? missingLabel(id))
    : reviewedLabels;
  if (!requestedLabels.length) {
    blockFrom("bottle", "No reviewed Label exists. Review a Label candidate before downstream automation.");
    return finish();
  }

  const objectLabel = input.objectContextLabelId
    ? requestedLabels.find((item) => item.id === input.objectContextLabelId) ?? missingLabel(input.objectContextLabelId)
    : [...requestedLabels].sort((left, right) => labelGeometryArea(right) - labelGeometryArea(left))[0]!;
  if (throughIndex >= 2) {
    await attempt("bottle", objectLabel.id, async () => {
      const output = await runSourceAnalysisRecord(source, sourceItemId, annotationId, {
        verifiedLabel: objectLabel.geometry!.bbox,
        labelConfig: { ...defaultLabel, ...input.configs.label },
        outerConfig: { ...defaultBottle, ...input.configs.bottle },
      });
      stages.bottle = { status: "completed", output };
    });
  }
  if (throughIndex === 2) return finish();

  for (const label of requestedLabels) {
    labelStages[label.id] = {};
    await attempt("ocr", label.id, async () => {
      const output = await runGraphAutoOcrRecord(source, sourceItemId, { scope: { type: "label", id: label.id }, config: { ...defaultOcr, ...input.configs.ocr } });
      labelStages[label.id]!.ocr = { status: "completed", output };
    });
  }
  stages.ocr = aggregate(requestedLabels, labelStages, "ocr");
  if (throughIndex === 3) return finish();

  const cvConfig = { ...DEFAULT_LABEL_ANALYSIS_CV_CONFIG, ...input.configs.cv };
  for (const label of requestedLabels) {
    if (!label.ocr.length || label.ocr.some((item) => item.regionStatus !== "reviewed")) {
      for (const stage of CV_STAGES) if (ORDER.indexOf(stage) <= throughIndex) labelStages[label.id]![stage] = { status: "blocked", reason: "Reviewed canonical OCR is required before Label CV automation." };
      warnings.push(`Label ${label.id}: OCR candidates were generated but must be reviewed before CV stages.`);
      continue;
    }
    for (const stage of CV_STAGES) {
      if (ORDER.indexOf(stage) > throughIndex) break;
      await attempt(stage, label.id, async () => {
        const output = await previewLabelCvJobRecord(source, sourceItemId, annotationId, { stage, config: cvConfig }, label.id);
        labelStages[label.id]![stage] = { status: "completed", output };
      });
    }
  }
  for (const stage of CV_STAGES) if (ORDER.indexOf(stage) <= throughIndex) stages[stage] = aggregate(requestedLabels, labelStages, stage);

  if (throughIndex >= ORDER.indexOf("summary")) {
    const state = await getWizardStageState(source, sourceItemId, annotationId, "summary");
    stages.summary = { status: state.status === "ready" ? "completed" : "blocked", output: state.state, reason: state.status === "ready" ? undefined : "Canonical review is incomplete." };
  }
  return finish();

  async function attempt(stage: WizardStageId, labelId: string | undefined, operation: () => Promise<void>) {
    try { await operation(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ stage, ...(labelId ? { labelId } : {}), error: message });
      if (labelId) labelStages[labelId]![stage] = { status: "failed", reason: message };
      else stages[stage] = { status: "failed", reason: message };
      if (!input.continueOnError) throw error;
    }
  }
  function blockFrom(stage: WizardStageId, reason: string) {
    for (const value of ORDER.slice(ORDER.indexOf(stage), throughIndex + 1)) stages[value] = { status: "blocked", reason };
    warnings.push(reason);
  }
  function finish() {
    return {
      schemaVersion: 1, pipelineRunId, annotationId, mode: "helper-only" as const, through: input.through,
      startedAt, finishedAt: new Date().toISOString(), stages, labelStages, warnings, failures,
      requiresReview: warnings.length > 0 || failures.length > 0 || Object.values(stages).some((item) => item?.status === "blocked" || item?.status === "failed"),
    };
  }
}

function labelGeometryArea(label: { geometry?: { bbox?: { width?: number; height?: number } } | null }) {
  return Math.max(0, Number(label.geometry?.bbox?.width) || 0) * Math.max(0, Number(label.geometry?.bbox?.height) || 0);
}

export function automationStagesThrough(stage: WizardStageId) { return ORDER.slice(0, ORDER.indexOf(stage) + 1); }

function helperConfig(source: string, sourceItemId: string, helperId: string) {
  return bindHelperToCard({ schemaVersion: 1, records: [] }, source, sourceItemId, helperId).config;
}
function missingLabel(id: string): never { throw new NotFoundError(`Reviewed Label ${id} does not belong to this annotation track`); }
function aggregate(labels: Array<{ id: string }>, values: Record<string, Partial<Record<WizardStageId, RunRecord>>>, stage: WizardStageId): RunRecord {
  const records = labels.map((label) => values[label.id]?.[stage]).filter(Boolean) as RunRecord[];
  if (records.some((item) => item.status === "failed")) return { status: "failed", output: Object.fromEntries(labels.map((label) => [label.id, values[label.id]?.[stage] ?? null])) };
  if (records.some((item) => item.status === "blocked")) return { status: "blocked", output: Object.fromEntries(labels.map((label) => [label.id, values[label.id]?.[stage] ?? null])) };
  return { status: records.length ? "completed" : "skipped", output: Object.fromEntries(labels.map((label) => [label.id, values[label.id]?.[stage] ?? null])) };
}
