import assert from "node:assert/strict";
import test from "node:test";
import { adaptTaskRecord, adaptTaskRecords, buildTaskDatasets, type FrozenDatasetRecord } from "./datasetTaskAdapters.js";

const fixture: FrozenDatasetRecord = {
  id: "svoe_vino:test",
  source: "svoe_vino",
  sourceItemId: "test",
  split: "train",
  snapshotHash: "snapshot-sha",
  snapshot: {
    schemaVersion: 3,
    label: { id: "label", revision: 2, image_url: "svoe_vino/bottle/test.webp", bbox: { x: 10, y: 20, width: 100, height: 200 }, polygon: null },
    ocrRegions: { id: "regions", revision: 3, regions: [{ id: "word", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }, text: "wine" }] },
    sourceAssociations: { id: "associations", revision: 1, associations: [{ id: "match" }] },
    aliases: { id: "aliases", revision: 1, aliases: [{ value: "wine" }] },
    vision: {
      annotations: { bottle: { simplifiedContour: [[1, 2], [3, 4]] }, elements: [{ id: "element", status: "accepted" }], contours: [{ elementId: "element", points: [[1, 2]] }], palette: [{ rgb: [10, 20, 30] }] },
      cvMeta: { coordinateSpace: { width: 192, height: 192 }, bottleCoordinateSpace: { width: 508, height: 1920, imageUrl: "svoe_vino/bottle/test.webp" }, helpers: { schemaVersion: 1, records: [
        { helperId: "bottle-outline", algorithm: "bottle-border-flood-v2", configSchemaVersion: 1, config: { silhouetteThreshold: 18 }, role: "conditioning-input", provenance: { source: "reviewed-run" }, review: { status: "verified", targetRef: "vision.annotations.bottle" } },
        { helperId: "label-elements", algorithm: "element-grouping-v1", configSchemaVersion: 1, config: { groupingPrimary: "ocr-overlap" }, role: "conditioning-input", provenance: { source: "reviewed-run" }, review: { status: "valid", targetRef: "vision.annotations.elements" } },
        { helperId: "label-palette", algorithm: "label-palette-v1", configSchemaVersion: 1, config: { paletteColors: 6 }, role: "conditioning-input", provenance: { source: "reviewed-run" }, review: { status: "valid", targetRef: "vision.annotations.palette" } },
      ] } },
    },
  },
};

test("visual adapters preserve reviewed targets and explicit coordinate spaces", () => {
  const bottle = adaptTaskRecord(fixture, "bottle-outline");
  assert.deepEqual(bottle?.input.coordinateSpace, { width: 508, height: 1920, imageUrl: "svoe_vino/bottle/test.webp" });
  assert.deepEqual(objectValue(bottle?.target.bottle).simplifiedContour, [[1, 2], [3, 4]]);
  assert.equal(objectValue(bottle?.input.helperContext).helperId, "bottle-outline");
  assert.equal(objectValue(objectValue(bottle?.input.helperContext).config).silhouetteThreshold, 18);

  const elements = adaptTaskRecord(fixture, "label-elements");
  assert.deepEqual(elements?.input.coordinateSpace, { width: 192, height: 192 });
  assert.equal(arrayValue(elements?.target.elements).length, 1);
  assert.equal(arrayValue(elements?.target.contours).length, 1);
  assert.equal(objectValue(elements?.input.helperContext).helperId, "label-elements");
});

test("all supported task files are derived without CV proposal leakage", () => {
  const datasets = buildTaskDatasets([fixture]);
  assert.deepEqual(Object.fromEntries(Object.entries(datasets).map(([task, records]) => [task, records.length])), {
    "label-roi": 1,
    "physical-label-roi": 0,
    "ocr-region": 1,
    "source-matching": 1,
    "alias-ranking": 1,
    "bottle-outline": 1,
    "label-elements": 1,
    "label-palette": 1,
  });
  assert.equal(JSON.stringify(datasets).includes("componentProposals"), false);
});

test("canonical graph expands one catalog item into parent-scoped samples", () => {
  const canonical: FrozenDatasetRecord = {
    ...fixture,
    snapshot: {
      ...fixture.snapshot,
      schemaVersion: 5,
      annotationGraph: {
        schemaVersion: 9,
        packages: [
          {
            id: "package-bottle",
            sourceAssetRef: "assets/item.webp",
            scope: { geometry: null, source: "default-full-image", trainingRole: "helper-input" },
            packageType: { value: "bottle", status: "reviewed", source: "human" },
            objectContext: { status: "reviewed", geometry: { type: "polygon", points: [{ x: 1, y: 1 }], bbox: { x: 1, y: 1, width: 100, height: 300 } } },
            labels: [
              { id: "label-main", status: "reviewed", geometryReviewStatus: "reviewed", visualRegionKind: { value: "physical-label", status: "reviewed" }, geometry: { type: "quad", points: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 220 }, { x: 10, y: 220 }], bbox: { x: 10, y: 20, width: 100, height: 200 } }, rectification: null, ocr: [{ id: "ocr-label", regionStatus: "reviewed", transcription: { text: "WINE", status: "verified" }, coordinateSpace: { type: "label-rectified", units: "normalized", labelId: "label-main" } }], meta: [], cv: { crop: { imageUrl: "label-analysis/graph-cv/label-main/r1.webp" }, job: { preview: { elements: [{ id: "element-main", status: "accepted" }], contours: [{ elementId: "element-main", points: [[1, 2], [3, 4]] }], palette: [{ rgb: [9, 8, 7] }], cvDebug: { source: { width: 192, height: 192 } } }, workflow: { checkpoints: { elements: { execution: { helper: { id: "label-elements" } } }, palette: { execution: { helper: { id: "label-palette" } } } } } } } },
              { id: "label-neck", status: "reviewed", geometry: { type: "quad", points: [{ x: 30, y: 5 }, { x: 80, y: 5 }, { x: 80, y: 18 }, { x: 30, y: 18 }], bbox: { x: 30, y: 5, width: 50, height: 13 } }, rectification: null, ocr: [{ id: "ocr-rejected", regionStatus: "rejected" }], meta: [] },
            ],
            ocr: [{ id: "ocr-direct", regionStatus: "reviewed", transcription: { text: "2024", status: "verified" }, coordinateSpace: { type: "source-image", units: "pixels" } }],
            meta: [],
          },
          {
            id: "package-tube",
            sourceAssetRef: "assets/item.webp",
            scope: { geometry: { type: "quad", bbox: { x: 200, y: 0, width: 100, height: 400 } }, source: "human", trainingRole: "helper-input" },
            packageType: { value: "tube", status: "reviewed", source: "human" },
            objectContext: { status: "missing", geometry: null },
            labels: [{ id: "label-tube", status: "reviewed", geometry: { type: "quad", points: [], bbox: { x: 210, y: 20, width: 80, height: 300 } }, rectification: null, ocr: [], meta: [] }],
            ocr: [], meta: [],
          },
        ],
        operations: [{
          id: "operation-label-merge", operationType: "add_label", result: null,
          results: [{ type: "label", id: "label-main" }], helper: { id: "label-roi-detection", version: "v4" },
          initialConfig: { profile: "consensus" }, finalConfig: { profile: "consensus" }, selectedCandidateId: null,
          candidates: [{ id: "roi1" }, { id: "roi2" }],
          candidateReviews: [
            { candidateId: "roi1", state: "accepted", finalLabelId: "label-main" },
            { candidateId: "roi2", state: "accepted", finalLabelId: "label-main" },
          ],
          reviewOperations: [{
            type: "merge", inputCandidateIds: ["roi1", "roi2"], outputEntity: { type: "label", id: "label-main" },
            outputGeometry: { type: "quad", points: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 220 }, { x: 10, y: 220 }], bbox: { x: 10, y: 20, width: 100, height: 200 } },
            mode: "automatic",
          }],
          roiReviewGraph: {
            schemaVersion: 1,
            nodes: [
              { id: "candidate:roi1", origin: "autodetect", candidateId: "roi1", geometry: { type: "quad", points: [{ x: 10, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 220 }, { x: 10, y: 220 }], bbox: { x: 10, y: 20, width: 50, height: 200 } } },
              { id: "candidate:roi2", origin: "autodetect", candidateId: "roi2", geometry: { type: "quad", points: [{ x: 60, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 220 }, { x: 60, y: 220 }], bbox: { x: 60, y: 20, width: 50, height: 200 } } },
              { id: "derived:merge:1", origin: "derived", entity: { type: "label", id: "label-main" }, geometry: { type: "quad", points: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 220 }, { x: 10, y: 220 }], bbox: { x: 10, y: 20, width: 100, height: 200 } } },
            ],
            operations: [
              { type: "merge", inputs: ["candidate:roi1", "candidate:roi2"], output: "derived:merge:1", mode: "automatic" },
              { type: "approve", input: "derived:merge:1", outputEntity: { type: "label", id: "label-main" } },
            ],
            reviewedOutputIds: ["derived:merge:1"],
          },
          reviewMode: "accepted",
        }],
      },
    },
  };
  const labels = adaptTaskRecords(canonical, "label-roi");
  const physicalLabels = adaptTaskRecords(canonical, "physical-label-roi");
  const ocr = adaptTaskRecords(canonical, "ocr-region");
  const objects = adaptTaskRecords(canonical, "bottle-outline");
  const elements = adaptTaskRecords(canonical, "label-elements");
  const palettes = adaptTaskRecords(canonical, "label-palette");
  assert.equal(labels.length, 3);
  assert.equal(physicalLabels.length, 1);
  assert.equal(objectValue(physicalLabels[0]?.target.visualRegionKind).value, "physical-label");
  assert.equal(ocr.length, 1);
  assert.equal(objects.length, 1);
  assert.equal(elements.length, 1);
  assert.equal(palettes.length, 1);
  assert.equal(elements[0]?.target.elements && arrayValue(elements[0].target.elements).length, 1);
  assert.deepEqual(arrayValue(palettes[0]?.target.palette), [{ rgb: [9, 8, 7] }]);
  assert.deepEqual(ocr.map((item) => item.target.parentType), ["label"]);
  assert.equal(labels.every((item) => item.provenance.annotationGraphSchemaVersion === 9), true);
  const mergedLabelContext = objectValue(labels.find((item) => item.target.annotationId === "label-main")?.input.helperContext);
  assert.equal(mergedLabelContext.operationId, "operation-label-merge");
  assert.deepEqual(arrayValue(mergedLabelContext.reviewOperations), [{
    type: "merge", inputCandidateIds: ["roi1", "roi2"], outputEntity: { type: "label", id: "label-main" },
    outputGeometry: { type: "quad", points: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 220 }, { x: 10, y: 220 }], bbox: { x: 10, y: 20, width: 100, height: 200 } },
    mode: "automatic",
  }]);
  assert.deepEqual(objectValue(mergedLabelContext.roiReviewGraph).reviewedOutputIds, ["derived:merge:1"]);
  assert.equal(JSON.stringify(ocr).includes("ocr-rejected"), false);
});

function arrayValue(value: unknown) { return Array.isArray(value) ? value : []; }
function objectValue(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
