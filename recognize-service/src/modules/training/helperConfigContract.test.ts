import assert from "node:assert/strict";
import test from "node:test";
import { bindAllHelpersToCard, bindHelperToCard, buildHelperConfigContract } from "../../shared/helperConfigContract.js";

test("reviewed wizard metadata produces one helper record per stage", () => {
  const contract = buildHelperConfigContract({
    labelSourceAnalysis: {
      algorithm: "source-label-helper-v1",
      runId: "source-run",
      savedAt: "2026-08-24T00:00:00.000Z",
      winningDetection: { config: { threshold: 42 } },
      bottleDetection: {
        algorithm: "bottle-border-flood-v2",
        config: { colorDistanceThreshold: 12 },
        annotation: { status: "reviewed" },
      },
    },
    labelCvJob: {
      analysisJobId: "analysis-run",
      reviewedAt: "2026-08-24T00:00:00.000Z",
      config: {
        threshold: 100,
        invert: false,
        maskSize: 240,
        morphologyEnabled: true,
        morphologyOperation: "close",
        morphologyKernelWidth: 3,
        morphologyKernelHeight: 3,
        morphologyIterations: 1,
        morphologyMode: "manual",
        componentFilterPreset: "text",
        minComponentAreaRatio: 0.001,
        maxComponentAreaRatio: 0.2,
        maxContourPoints: 64,
        contourDetail: "balanced",
        contourSimplifyRatio: 0.01,
        paletteColors: 6,
        paletteMinRatio: 0.02,
      },
      workflow: { checkpoints: { mask: { status: "saved" } } },
      review: {},
    },
  }, {
    profileVersion: "ocr-cascade-v1",
    passes: [{ id: "base", stage: "full", psm: 6, output: { ignored: true } }],
  }, "ocr-run");

  assert.deepEqual(contract.records.map((item) => item.helperId), [
    "label-roi-detection", "bottle-outline", "label-ocr-cascade", "label-mask", "label-morphology",
    "label-components", "label-elements", "label-contours", "label-palette", "label-summary",
  ]);
  assert.equal(contract.records.length, 10);
  assert.deepEqual(contract.records.find((item) => item.helperId === "label-mask")?.config, { threshold: 100, invert: false, maskSize: 240 });
  assert.equal("threshold" in (contract.records.find((item) => item.helperId === "label-morphology")?.config ?? {}), false);
  assert.equal("output" in ((contract.records.find((item) => item.helperId === "label-ocr-cascade")?.config.passes as Array<Record<string, unknown>>)[0]), false);
  assert.equal(contract.records.find((item) => item.helperId === "label-ocr-cascade")?.provenance.runId, "ocr-run");
  const mask = bindHelperToCard(contract, "svoe_vino", "item-1", "label-mask");
  assert.deepEqual(mask.card, { source: "svoe_vino", sourceItemId: "item-1" });
  assert.equal(mask.wizardStage, "mask");
  const bindings = bindAllHelpersToCard(contract, "svoe_vino", "item-1");
  assert.equal(bindings.length, 12);
  assert.deepEqual(bindings.find((item) => item.helperId === "label-rectification")?.config, {
    schemaVersion: 1, previewMaxSide: 640, minConfidence: .42, minRetainedArea: .55,
    maxCornerDisplacement: .35, minCylindricalConfidence: .48, minCylindricalCurvature: .006,
    maxCylindricalCurvature: .12, detectPerspective: true, detectCylindrical: true,
  });
});

test("canonical label prediction supplies the persisted label helper binding", () => {
  const contract = buildHelperConfigContract({}, undefined, undefined, {
    id: "prediction-1",
    algorithm: {
      id: "label-detector-v2",
      version: "2.4.1",
      params: { threshold: 38 },
      defaultParams: { threshold: 32 },
    },
    createdAt: "2026-08-24T12:00:00.000Z",
    reviewStatus: "reviewed",
  });

  const binding = bindHelperToCard(contract, "roskachestvo", "3946117", "label-roi-detection");
  assert.equal(binding.persisted, true);
  assert.equal(binding.algorithm, "label-detector-v2");
  assert.deepEqual(binding.config, {
    params: { threshold: 38 },
    defaultParams: { threshold: 32 },
    algorithmVersion: "2.4.1",
  });
  assert.equal(binding.provenance.runId, "prediction-1");
  assert.equal(binding.review.status, "reviewed");
});

test("unbound wizard helpers expose explicit defaults instead of empty configs", () => {
  const bindings = bindAllHelpersToCard({ schemaVersion: 1, records: [] }, "svoe_vino", "draft-item");
  assert.equal(bindings.length, 12);
  for (const binding of bindings) {
    assert.equal(binding.persisted, false);
    assert.ok(Object.keys(binding.config).length > 0, `${binding.helperId} must expose a default config`);
    assert.equal(binding.provenance.source, "default-config");
  }
  assert.equal(bindings.find((item) => item.wizardStage === "label")?.algorithm, "label-multi-family-consensus-v7");
  assert.equal(bindings.find((item) => item.wizardStage === "package")?.algorithm, "package-smart-lasso-v1");
  assert.equal(bindings.find((item) => item.wizardStage === "ocr")?.algorithm, "tesseract-cascade-v6");
  assert.equal(bindings.find((item) => item.helperId === "label-rectification")?.algorithm, "cv-label-rectification-v1");
  assert.equal(bindings.find((item) => item.helperId === "label-palette")?.config.paletteColors, 8);
});
