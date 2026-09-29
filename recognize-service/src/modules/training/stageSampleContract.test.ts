import assert from "node:assert/strict";
import test from "node:test";
import { bindHelperToCard, buildHelperConfigContract } from "../../shared/helperConfigContract.js";
import { buildRouteStageSampleV1, buildStageSamplesV1 } from "../../shared/stageSampleContract.js";

test("all wizard stages adapt into StageSampleV1 without inventing legacy initial params", () => {
  const cvConfig = {
    threshold: 100, invert: false, maskSize: 240,
    morphologyEnabled: true, morphologyOperation: "close", morphologyKernelWidth: 5, morphologyKernelHeight: 3, morphologyIterations: 2, morphologyMode: "manual",
    componentFilterPreset: "normal", minComponentAreaRatio: 0.001, maxComponentAreaRatio: 0.2,
    maxContourPoints: 128, contourDetail: "balanced", contourSimplifyRatio: 0.01,
    paletteColors: 6, paletteMinRatio: 0.02,
  };
  const checkpoints: Record<string, Record<string, unknown>> = Object.fromEntries(["mask", "morphology", "components", "elements", "contours", "palette"].map((stage) => [stage, { status: "valid", completedAt: "2026-08-24T12:00:00.000Z" }]));
  checkpoints.morphology.execution = {
    initialParams: { morphologyKernelWidth: 3, morphologyKernelHeight: 3, morphologyIterations: 1 },
    finalParams: { morphologyKernelWidth: 5, morphologyKernelHeight: 3, morphologyIterations: 2 },
    autoOutput: { score: 0.4 }, reviewedOutput: { score: 0.8 },
  };
  const visualFeatures = {
    labelSourceAnalysis: {
      algorithm: "label-detector-v2", runId: "source-run", savedAt: "2026-08-24T12:00:00.000Z",
      winningDetection: { config: { threshold: 38 } },
      bottleDetection: { algorithm: "bottle-v2", config: { tolerance: 12 }, selectedCandidateId: "b1", candidates: [{ id: "b1", contour: [[0, 0]] }], annotation: { status: "reviewed", contour: [[0, 0]] }, palette: [] },
    },
    labelCvJob: {
      analysisJobId: "analysis-run", reviewedAt: "2026-08-24T12:00:00.000Z", config: cvConfig,
      workflow: { checkpoints }, review: { componentDecisions: { "1": "accepted" }, elementsReviewed: true },
      preview: { cvDebug: { source: { width: 240, height: 240 }, effectiveMorphologyConfig: { kernelWidth: 5 } }, components: [{ id: 1 }], elements: [{ id: "e1", status: "accepted" }], contours: [{ elementId: "e1" }], palette: [{ rgb: [1, 2, 3] }] },
      palette: [{ rgb: [1, 2, 3] }], reviewResult: {},
    },
  };
  const labelRoi = {
    reviewed: true,
    prediction: { id: "prediction", roi: { x: 10, y: 20, width: 30, height: 40 }, algorithm: { id: "label-detector-v2", version: "2", params: { threshold: 38 }, defaultParams: { threshold: 32 } } },
    annotation: { id: "annotation", revision: 1, roi: { x: 11, y: 20, width: 30, height: 40 }, reviewedAt: "2026-08-24T12:01:00.000Z" },
  };
  const helperContract = buildHelperConfigContract(visualFeatures, { profileVersion: "ocr-v1", passes: [{ id: "base", psm: 6 }] }, "ocr-run", { ...labelRoi.prediction, reviewStatus: "reviewed" });
  const samples = buildStageSamplesV1({
    source: "roskachestvo", sourceItemId: "item-1", helperContract, labelRoi,
    sourceAnalysis: visualFeatures.labelSourceAnalysis, analysis: { crop: { assetPath: "label/crop.webp" }, ocr: { id: "ocr-run" }, textRegions: [{ id: "word" }] },
    ocrRegions: { id: "ocr-review", status: "reviewed", regions: [{ id: "word", text: "WINE" }] },
    cvJob: visualFeatures.labelCvJob, summary: { warnings: [] }, finalReview: { id: "review", createdAt: "2026-08-24T12:02:00.000Z" },
  });

  assert.deepEqual(samples.map((sample) => sample.stage), ["package", "label", "bottle", "ocr", "mask", "morphology", "components", "elements", "contours", "palette", "summary"]);
  assert.equal(samples.every((sample) => sample.cardId === "roskachestvo:item-1"), true);
  const label = samples.find((sample) => sample.stage === "label")!;
  assert.deepEqual(label.execution.defaultParams, { threshold: 32 });
  assert.deepEqual(label.execution.initialParams, { threshold: 38 });
  assert.equal(label.humanCorrection.outputEdited, true);
  const mask = samples.find((sample) => sample.stage === "mask")!;
  assert.deepEqual(mask.execution.initialParams, { availability: "unavailable", reason: "not-captured" });
  assert.equal(mask.humanCorrection.paramsEdited, null);
  assert.equal(mask.provenance.migrationGap, true);
  const morphology = samples.find((sample) => sample.stage === "morphology")!;
  assert.equal(morphology.humanCorrection.paramsEdited, true);
  assert.equal(morphology.humanCorrection.outputEdited, true);
  assert.equal(morphology.provenance.migrationGap, false);
  assert.equal(samples.find((sample) => sample.stage === "summary")!.humanCorrection.reviewed, true);
});

test("manual reviewed label is persisted while unavailable helper params stay explicit", () => {
  const binding = bindHelperToCard({ schemaVersion: 1, records: [] }, "roskachestvo", "manual-1", "label-roi-detection");
  const sample = buildRouteStageSampleV1(binding, {
    schemaVersion: 2, prediction: null,
    annotation: { id: "annotation", revision: 1, roi: { x: 1, y: 2, width: 3, height: 4 } },
    status: "reviewed", reviewed: true,
  });
  assert.deepEqual(sample.execution.initialParams, { availability: "unavailable", reason: "not-captured" });
  assert.deepEqual(sample.execution.finalParams, { availability: "unavailable", reason: "not-persisted" });
  assert.equal(sample.humanCorrection.reviewed, true);
  assert.equal(sample.provenance.persisted, true);
});

test("native execution evidence overrides legacy adapter values without losing first-run params", () => {
  const helperContract = buildHelperConfigContract({
    labelCvJob: { config: { threshold: 170, invert: false, maskSize: 192 }, workflow: { checkpoints: { mask: { status: "valid" } } } },
  });
  const samples = buildStageSamplesV1({
    source: "svoe_vino", sourceItemId: "native-1", helperContract,
    stageExecutions: [{
      id: "execution-1", stage: "mask", helperId: "label-mask", algorithm: "binary-threshold-mask-v1",
      algorithmVersion: "1", status: "reviewed",
      stageInput: { labelAnnotationId: "annotation-1", analysisJobId: "job-1" },
      initialParams: { threshold: 100, invert: false, maskSize: 240 },
      autoOutput: { mask: { assetPath: "debug/initial-mask.png" } },
      proposedOutput: { mask: { assetPath: "debug/controller-mask.png" } },
      proposalExecutor: "local_ml", proposalInteractionMode: "mixed", proposalPlanId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c",
      finalParams: { threshold: 170, invert: false, maskSize: 192 },
      reviewedOutput: { mask: { assetPath: "debug/reviewed-mask.png" } },
      helperRuns: [
        { id: "run-1", runIndex: 1, config: { threshold: 100 }, candidates: [], output: { mask: { id: "initial" } }, createdAt: "2026-08-25T09:00:00.000Z" },
        { id: "run-2", runIndex: 2, config: { threshold: 170 }, candidates: [{ id: "mask-2" }], output: { mask: { id: "reviewed" } },
          intermediateStates: [
            { id: "mask.build", parentId: null, sequence: 0, status: "completed", algorithm: "binary-threshold-mask-v1", summary: { pixels: 1200 } },
          ], createdAt: "2026-08-25T09:30:00.000Z" },
      ],
      selection: { runId: "run-2", candidateId: "mask-2" },
      reviewMode: "corrected",
      reviewedAt: "2026-08-25T10:00:00.000Z",
    }],
  });
  const mask = samples.find((sample) => sample.stage === "mask")!;
  assert.equal(mask.provenance.adapter, "mask-native-execution-v1");
  assert.equal(mask.provenance.persisted, true);
  assert.equal(mask.provenance.migrationGap, false);
  assert.deepEqual(mask.execution.initialParams, { threshold: 100, invert: false, maskSize: 240 });
  assert.deepEqual(mask.execution.finalParams, { threshold: 170, invert: false, maskSize: 192 });
  assert.equal("proposedOutput" in mask.execution, false);
  assert.deepEqual(mask.execution.proposal, { executor: "local_ml", interactionMode: "mixed", planId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" });
  assert.equal(mask.execution.runs.length, 2);
  assert.deepEqual(mask.execution.runs[1]?.intermediateStates, [
    { id: "mask.build", parentId: null, sequence: 0, status: "completed", algorithm: "binary-threshold-mask-v1", summary: { pixels: 1200 } },
  ]);
  assert.deepEqual(mask.execution.selection, { runId: "run-2", candidateId: "mask-2" });
  assert.equal(mask.execution.reviewMode, "corrected");
  assert.equal(mask.humanCorrection.paramsEdited, true);
  assert.equal(mask.humanCorrection.outputEdited, true);
});

test("LLM evaluation keeps only decision and review metadata in canonical StageSample", () => {
  const helperContract = buildHelperConfigContract({
    labelCvJob: { config: { threshold: 100 }, workflow: { checkpoints: { mask: { status: "valid" } } } },
  });
  const samples = buildStageSamplesV1({
    source: "svoe_vino", sourceItemId: "llm-review-1", helperContract,
    stageExecutions: [{
      stage: "mask", status: "reviewed", helperId: "label-mask", algorithm: "binary-threshold-mask-v1",
      initialParams: { threshold: 100 }, autoOutput: { mask: "correct" },
      proposedOutput: { mask: "wrong-llm-intermediate" },
      proposalExecutor: "llm", proposalInteractionMode: "mixed", proposalPlanId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c",
      proposalReview: {
        reviewedBy: "human", reviewerSubject: "reviewer-1", finalEditor: "human",
        verdict: "llm_false_correction", reviewedAt: "2026-09-01T12:00:00.000Z",
      },
      finalParams: { threshold: 100 }, reviewedOutput: { mask: "correct" },
    }],
  });
  const mask = samples.find((sample) => sample.stage === "mask")!;
  assert.equal("proposedOutput" in mask.execution, false);
  assert.deepEqual(mask.execution.initialParams, { threshold: 100 });
  assert.deepEqual(mask.execution.reviewedOutput, { mask: "correct" });
  assert.deepEqual(mask.execution.proposal, {
    executor: "llm", interactionMode: "mixed", planId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c",
    llmDecision: { mode: "modified_helper", executor: "llm" },
    review: {
      reviewedBy: "human", reviewerSubject: "reviewer-1", finalEditor: "human",
      verdict: "llm_false_correction", reviewedAt: "2026-09-01T12:00:00.000Z",
    },
  });
});
