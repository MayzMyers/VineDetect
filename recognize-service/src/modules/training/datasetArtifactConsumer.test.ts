import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { env } from "../../config/env.js";
import { inspectDatasetArtifactFiles } from "./datasetArtifactConsumer.js";

test("schema-v3 artifact reports task readiness and visual layers", async () => {
  const fixture = await createFixture();
  try {
    const label = await inspectDatasetArtifactFiles(fixture.artifact, "label-roi");
    assert.equal(label.ready, true);
    assert.equal(label.schemaVersion, 3);
    assert.equal(label.eligibleItems, 1);
    assert.deepEqual(label.splits.train, { total: 1, eligible: 1 });
    assert.equal(label.layers.bottle, 1);
    assert.equal(label.layers.elements, 1);
    assert.equal(label.layers.contours, 1);
    assert.equal(label.layers.palette, 1);
    assert.equal(label.taskArtifact?.adapterVersion, 1);

    const elements = await inspectDatasetArtifactFiles(fixture.artifact, "label-elements");
    assert.equal(elements.ready, true);
    assert.equal(elements.eligibleItems, 1);

    const sourceMatching = await inspectDatasetArtifactFiles(fixture.artifact, "source-matching");
    assert.equal(sourceMatching.ready, false);
    assert.equal(sourceMatching.eligibleItems, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("artifact checksum mismatch is rejected", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      inspectDatasetArtifactFiles({ ...fixture.artifact, annotationsSha256: "0".repeat(64) }, "label-roi"),
      /checksum does not match/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("schema-v5 readiness distinguishes eligible items from canonical task samples", async () => {
  const fixture = await createCanonicalFixture();
  try {
    const label = await inspectDatasetArtifactFiles(fixture.artifact, "label-roi");
    assert.equal(label.schemaVersion, 5);
    assert.equal(label.eligibleItems, 1);
    assert.equal(label.eligibleSamples, 2);
    assert.equal(label.taskArtifact?.count, 2);
    assert.equal(label.layers.annotationGraph, 1);
    assert.equal(label.layers.packages, 1);
    assert.equal(label.layers.canonicalLabels, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture() {
  const exportRoot = path.resolve(process.cwd(), env.DATASET_EXPORT_ROOT);
  await mkdir(exportRoot, { recursive: true });
  const root = await mkdtemp(path.join(exportRoot, `.consumer-test-${os.platform()}-`));
  const record = {
    id: "svoe_vino:test",
    source: "svoe_vino",
    sourceItemId: "test",
    split: "train",
    snapshotHash: "fixture",
    snapshot: {
      schemaVersion: 3,
      label: { id: "label", status: "reviewed" },
      ocrRegions: { regions: [{ id: "word" }] },
      sourceAssociations: { associations: [] },
      aliases: null,
      vision: { annotations: { bottle: { status: "reviewed" }, elements: [{ id: "element" }], contours: [{ elementId: "element" }], palette: [{ rgb: [1, 2, 3] }] }, cvMeta: {} },
    },
  };
  const annotations = `${JSON.stringify(record)}\n`;
  const checksum = createHash("sha256").update(annotations).digest("hex");
  const taskContents = `${JSON.stringify({ id: "svoe_vino:test", split: "train" })}\n`;
  const taskChecksum = createHash("sha256").update(taskContents).digest("hex");
  const manifest = {
    schemaVersion: 3,
    annotationsSha256: checksum,
    files: { tasks: { "label-roi": { file: "tasks/label-roi.jsonl", count: 1, sha256: taskChecksum, adapterVersion: 1 } } },
  };
  await mkdir(path.join(root, "tasks"));
  await Promise.all([
    writeFile(path.join(root, "annotations.jsonl"), annotations, "utf8"),
    writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest), "utf8"),
    writeFile(path.join(root, "tasks", "label-roi.jsonl"), taskContents, "utf8"),
  ]);
  return { root, artifact: { id: randomUUID(), outputPath: root, annotationsSha256: checksum, manifest } };
}

async function createCanonicalFixture() {
  const exportRoot = path.resolve(process.cwd(), env.DATASET_EXPORT_ROOT);
  await mkdir(exportRoot, { recursive: true });
  const root = await mkdtemp(path.join(exportRoot, `.consumer-v5-test-${os.platform()}-`));
  const record = {
    id: "svoe_vino:canonical",
    source: "svoe_vino",
    sourceItemId: "canonical",
    split: "train",
    snapshotHash: "canonical-fixture",
    snapshot: {
      schemaVersion: 5,
      annotationGraph: {
        schemaVersion: 6,
        packages: [{
          id: "package",
          sourceAssetRef: "assets/canonical.webp",
          scope: { geometry: null, source: "default-full-image", trainingRole: "helper-input" },
          packageType: { value: "bottle", status: "reviewed", source: "human" },
          objectContext: { geometry: null, status: "missing" },
          labels: [
            { id: "label-1", status: "reviewed", geometry: { type: "quad", bbox: { x: 1, y: 1, width: 10, height: 20 } }, rectification: null, ocr: [], meta: [] },
            { id: "label-2", status: "reviewed", geometry: { type: "quad", bbox: { x: 20, y: 1, width: 10, height: 20 } }, rectification: null, ocr: [], meta: [] },
          ],
          ocr: [], meta: [],
        }],
        operations: [],
      },
    },
  };
  const annotations = `${JSON.stringify(record)}\n`;
  const checksum = createHash("sha256").update(annotations).digest("hex");
  const taskContents = `${JSON.stringify({ id: "sample-1" })}\n${JSON.stringify({ id: "sample-2" })}\n`;
  const taskChecksum = createHash("sha256").update(taskContents).digest("hex");
  const manifest = {
    schemaVersion: 5,
    annotationsSha256: checksum,
    files: { tasks: { "label-roi": { file: "tasks/label-roi.jsonl", count: 2, sha256: taskChecksum, adapterVersion: 3 } } },
  };
  await mkdir(path.join(root, "tasks"));
  await Promise.all([
    writeFile(path.join(root, "annotations.jsonl"), annotations, "utf8"),
    writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest), "utf8"),
    writeFile(path.join(root, "tasks", "label-roi.jsonl"), taskContents, "utf8"),
  ]);
  return { root, artifact: { id: randomUUID(), outputPath: root, annotationsSha256: checksum, manifest } };
}
