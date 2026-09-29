import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pool } from "../../db/pool.js";
import {
  officialPreflight,
  queueOfficialBatch,
} from "./contest-official.service.js";
import { readBatch, readPilotEvidence } from "./autodetect.repository.js";
import {
  validateProposal,
  summarize,
  type Evidence,
} from "./autodetect.validation.js";
import {
  runControlled,
  chunks,
  PILOT_IDS,
  type State,
  type Dependencies,
  type BatchEvidence,
  type Manifest,
} from "./autodetect.runner.js";
import { writeReview } from "./autodetect.review.js";
import type { OfficialTarget } from "../../shared/officialReference.js";
const sha = "a".repeat(64);
const target = (id: string): OfficialTarget => ({
  catalogItemId: id,
  officialSlug: "official-" + id,
  wineId: "same-wine",
  source: "svoe_vino",
  sourceItemId: "same-source",
  referenceAssetId: id,
  referencePath: `contest/lct-rshb-2026-09-15/sha256/aa/${sha}.webp`,
  referenceSha256: sha,
  width: 100,
  height: 200,
  method: "exact_slug",
  provenance: {},
  annotationTrackId: "track-" + id,
  packageId: "package-" + id,
  annotationVersionId: "version-" + id,
});
function evidence(t: OfficialTarget): Evidence {
  const bbox = { x: 10, y: 20, width: 60, height: 140 };
  return {
    job: {
      id: "job-" + t.catalogItemId,
      status: "completed",
      error: null,
      job_type: "GENERATE_DETECTION_PROPOSAL",
      target: t,
      source: t.source,
      source_item_id: t.sourceItemId,
      annotation_track_id: t.annotationTrackId,
      annotation_version_id: t.annotationVersionId,
    },
    track: {
      id: t.annotationTrackId,
      source: t.source,
      source_item_id: t.sourceItemId,
      source_asset_ref: t.referencePath,
      status: "in-progress",
    },
    package: {
      id: t.packageId,
      source: t.source,
      source_item_id: t.sourceItemId,
      legacy_annotation_track_id: t.annotationTrackId,
      source_asset_ref: t.referencePath,
      status: "draft",
      deleted_at: null,
    },
    version: {
      id: t.annotationVersionId,
      annotation_track_id: t.annotationTrackId,
      source: t.source,
      source_item_id: t.sourceItemId,
      status: "draft",
      snapshot: {
        officialReference: t,
        packages: [
          {
            id: t.packageId,
            legacyAnnotationTrackId: t.annotationTrackId,
            sourceAssetRef: t.referencePath,
          },
        ],
      },
    },
    pointers: [],
    resolutionMethod: "exact_filename",
    proposals: [
      {
        id: "proposal-" + t.catalogItemId,
        source: t.source,
        source_item_id: t.sourceItemId,
        annotation_track_id: t.annotationTrackId,
        image_url: t.referencePath,
        confidence: 0.8,
        bbox,
        geometry: {
          type: "quad",
          bbox,
          points: [
            { x: 10, y: 20 },
            { x: 70, y: 20 },
            { x: 70, y: 160 },
            { x: 10, y: 160 },
          ],
        },
      },
    ],
  };
}
const manifest: Manifest = {
  planSha256: sha,
  excludedPilotCatalogItemIds: PILOT_IDS,
  catalogItemIds: Array.from({ length: 2103 }, (_, i) => String(i + 1)).filter(
    (id) => !PILOT_IDS.includes(id),
  ),
};
function harness() {
  let saved: State | null = null,
    posts = 0,
    preflights = 0;
  const db = new Map<string, BatchEvidence>();
  const deps: Dependencies = {
    preflight: async () => {
      preflights++;
      return {
        total: 2103,
        planSha256: sha,
        runnerProtocolVersion: 1,
        targets: Array.from({ length: 2103 }, (_, i) => target(String(i + 1))),
      };
    },
    pilots: async (ids) => ids.map((id) => evidence(target(id))),
    lookup: async (id) => structuredClone(db.get(id) ?? null),
    submit: async (batch) => {
      posts++;
      assert.ok(
        saved?.batches.some((b) => b.requestId === batch.requestId),
        "intent persisted before POST",
      );
      const targets = batch.catalogItemIds.map((id) => ({
        ...target(id),
        annotationTrackId: randomUUID(),
        packageId: randomUUID(),
        annotationVersionId: randomUUID(),
      }));
      const children = targets.map(evidence);
      const parent = {
        id: randomUUID(),
        status: "completed",
        job_type: "GENERATE_DETECTION_PROPOSAL",
        target: { planSha256: sha, items: targets },
      };
      db.set(batch.requestId, { parent, children });
      return {
        jobId: parent.id,
        childJobIds: children.map((e) => e.job.id),
        targets,
      };
    },
    save: async (s) => {
      saved = structuredClone(s);
    },
    artifact: async () => {},
    pause: async () => {},
    log: () => {},
  };
  return {
    deps,
    db,
    get saved() {
      return saved;
    },
    get posts() {
      return posts;
    },
    get preflights() {
      return preflights;
    },
  };
}
const options = {
  dryRun: false,
  batchSize: 100,
  maxBatches: 1,
  retryFailed: false,
};
test("2096 pending, seven verified pilots excluded, 21 batches, dry run creates zero jobs/drafts", async () => {
  const h = harness(),
    result = await runControlled(
      manifest,
      null,
      { ...options, dryRun: true },
      h.deps,
    );
  assert.equal(result.pending, 2096);
  assert.equal("batches" in result && result.batches, 21);
  assert.equal(h.posts, 0);
  assert.equal(result.state.batches.length, 0);
  assert.equal(
    Object.values(result.state.assignments).filter((v) => v.status === "pilot")
      .length,
    7,
  );
  assert.deepEqual(
    chunks(manifest.catalogItemIds, 100).map((a) => a.length),
    [...Array(20).fill(100), 96],
  );
});
test("one batch retains 100 distinct assignments sharing wine, source and physical SHA", async () => {
  const h = harness();
  await runControlled(manifest, null, options, h.deps);
  assert.equal(h.posts, 1);
  assert.equal(h.preflights, 2);
  assert.equal(
    Object.values(h.saved!.assignments).filter((v) => v.status === "success")
      .length,
    100,
  );
  const batch = h.saved!.batches[0]!;
  assert.equal(new Set(batch.targets!.map((t) => t.catalogItemId)).size, 100);
  assert.equal(new Set(batch.targets!.map((t) => t.wineId)).size, 1);
  assert.equal(new Set(batch.targets!.map((t) => t.referenceSha256)).size, 1);
  assert.ok(!batch.catalogItemIds.some((id) => PILOT_IDS.includes(id)));
});
test("crash after POST before checkpoint: resume finds completed parent and never reposts", async () => {
  const h = harness(),
    submit = h.deps.submit;
  h.deps.submit = async (b) => {
    await submit(b);
    throw new Error("lost response");
  };
  await assert.rejects(
    runControlled(manifest, null, options, h.deps),
    /lost response/,
  );
  assert.equal(h.saved!.batches[0]!.jobId, undefined);
  assert.equal(h.posts, 1);
  h.deps.submit = submit;
  // A dry-run resumes by read-only reconciliation, including completed parents.
  await runControlled(manifest, h.saved, { ...options, dryRun: true }, h.deps);
  assert.equal(h.posts, 1);
  assert.ok(h.saved!.batches[0]!.classified);
  assert.equal(
    Object.values(h.saved!.assignments).filter((v) => v.status === "success")
      .length,
    100,
  );
  await runControlled(manifest, h.saved, { ...options, dryRun: true }, h.deps);
  assert.equal(h.posts, 1);
});
test("resume after successful checkpoint starts only remaining assignments", async () => {
  const h = harness();
  await runControlled(manifest, null, options, h.deps);
  const first = h.saved!.batches[0]!.catalogItemIds;
  await runControlled(manifest, h.saved, options, h.deps);
  assert.equal(h.posts, 2);
  assert.ok(
    h.saved!.batches[1]!.catalogItemIds.every((id) => !first.includes(id)),
  );
});
test("failed-only retries create fresh drafts; inconsistent/success/pilots stay excluded", async () => {
  const h = harness();
  await runControlled(manifest, null, { ...options, dryRun: true }, h.deps);
  const s = h.saved!;
  s.assignments["3"] = { status: "failed" };
  s.assignments["4"] = { status: "inconsistent" };
  s.assignments["5"] = { status: "success" };
  await runControlled(manifest, s, { ...options, retryFailed: true }, h.deps);
  assert.equal(h.posts, 1);
  assert.deepEqual(h.saved!.batches[0]!.catalogItemIds, ["3"]);
  assert.notEqual(
    h.saved!.batches[0]!.targets![0]!.annotationTrackId,
    target("3").annotationTrackId,
  );
  assert.equal(h.saved!.assignments["4"]!.status, "inconsistent");
});
test("fresh preflight detects plan hash drift before POST", async () => {
  const h = harness(),
    preflight = h.deps.preflight;
  h.deps.preflight = async () => {
    const p = await preflight();
    return { ...p, planSha256: h.preflights > 1 ? "b".repeat(64) : sha };
  };
  await assert.rejects(
    runControlled(manifest, null, options, h.deps),
    /hash drift/,
  );
  assert.equal(h.posts, 0);
});
test("unverified pilot or old API protocol prevents generation", async () => {
  const h = harness();
  h.deps.pilots = async () => [];
  await assert.rejects(runControlled(manifest, null, options, h.deps), /Pilot/);
  assert.equal(h.posts, 0);
  const second = harness(),
    p = second.deps.preflight;
  second.deps.preflight = async () => ({
    ...(await p()),
    runnerProtocolVersion: undefined,
  });
  await assert.rejects(
    runControlled(manifest, null, options, second.deps),
    /Deploy/,
  );
  assert.equal(second.posts, 0);
});
test("waits for every terminal child before advancing", async () => {
  const h = harness(),
    submit = h.deps.submit;
  let pauses = 0;
  h.deps.submit = async (b) => {
    const r = await submit(b);
    const found = h.db.get(b.requestId)!;
    found.parent.status = "running";
    found.children[0]!.job.status = "running";
    return r;
  };
  h.deps.pause = async () => {
    pauses++;
    for (const b of h.db.values()) {
      b.parent.status = "completed";
      b.children[0]!.job.status = "completed";
    }
  };
  await runControlled(manifest, null, options, h.deps);
  assert.equal(pauses, 1);
  assert.equal(h.posts, 1);
});
test("missing recorded parent or changed child IDs blocks automatic resubmission", async () => {
  const h = harness();
  await runControlled(manifest, null, options, h.deps);
  h.db.clear();
  await assert.rejects(
    runControlled(manifest, h.saved, options, h.deps),
    /missing/,
  );
  assert.equal(h.posts, 1);
});
test("proposal validation rejects identity, geometry and publication defects independently of confidence", () => {
  const t = target("3"),
    base = evidence(t);
  assert.equal(validateProposal(t, t, base).status, "success");
  const cases: [string, (e: Evidence) => void][] = [
    [
      "proposal_path_mismatch",
      (e) => {
        e.proposals[0]!.image_url = "historical.webp";
      },
    ],
    [
      "proposal_track_mismatch",
      (e) => {
        e.proposals[0]!.annotation_track_id = "wrong";
      },
    ],
    [
      "track_binding_mismatch",
      (e) => {
        e.track!.source_asset_ref = "wrong";
      },
    ],
    [
      "package_binding_mismatch",
      (e) => {
        e.package!.source_asset_ref = "wrong";
      },
    ],
    [
      "version_promoted",
      (e) => {
        e.pointers = [{ default_version_id: t.annotationVersionId }];
      },
    ],
    [
      "version_promoted",
      (e) => {
        e.pointers = [{ active_version_id: t.annotationVersionId }];
      },
    ],
    [
      "invalid_bbox",
      (e) => {
        e.proposals[0]!.bbox.width = 0;
      },
    ],
    [
      "invalid_bbox",
      (e) => {
        e.proposals[0]!.bbox.x = NaN;
      },
    ],
    [
      "bbox_out_of_bounds",
      (e) => {
        e.proposals[0]!.bbox.width = 1000;
      },
    ],
    [
      "quad_out_of_bounds",
      (e) => {
        e.proposals[0]!.geometry.points[0].x = -1;
      },
    ],
    [
      "invalid_quad",
      (e) => {
        e.proposals[0]!.geometry.points[0].y = Infinity;
      },
    ],
    [
      "degenerate_quad",
      (e) => {
        e.proposals[0]!.geometry.points.fill({ x: 1, y: 1 });
      },
    ],
    [
      "missing_proposal",
      (e) => {
        e.proposals = [];
      },
    ],
    [
      "job_error",
      (e) => {
        e.job.error = "bad";
      },
    ],
    [
      "job_identity_mismatch",
      (e) => {
        e.job.annotation_track_id = "wrong";
      },
    ],
  ];
  for (const [issue, mutate] of cases) {
    const e = structuredClone(base);
    e.proposals[0]!.confidence = 0.999;
    mutate(e);
    const r = validateProposal(t, t, e);
    assert.ok(r.issues.includes(issue), issue);
    assert.equal(r.status, "inconsistent", issue);
  }
  const low = structuredClone(base);
  low.proposals[0]!.confidence = 0.01;
  assert.equal(validateProposal(t, t, low).status, "success");
  const failed = structuredClone(base);
  failed.job.status = "failed";
  failed.job.error = "detector failure";
  failed.version!.status = "failed";
  failed.proposals = [];
  assert.equal(validateProposal(t, t, failed).status, "failed");
});
test("deterministic summaries contain quantiles and structural anomalies at high confidence", () => {
  const a = validateProposal(target("3"), target("3"), evidence(target("3"))),
    e = evidence(target("4"));
  e.proposals[0]!.confidence = 0.999;
  e.proposals[0]!.bbox.x = -1;
  const b = validateProposal(target("4"), target("4"), e),
    first = summarize("test", [a, b]);
  assert.deepEqual(first, summarize("test", [b, a]));
  assert.ok(first.groups["high-confidence"]!.includes("4"));
  assert.equal(first.inconsistent, 1);
  assert.ok(first.structuralAnomalies.bbox_out_of_bounds);
});
test("max-batches 1 counts a recovered completed batch and submits nothing further", async () => {
  const h = harness(),
    submit = h.deps.submit;
  h.deps.submit = async (batch) => {
    await submit(batch);
    throw new Error("offline");
  };
  await assert.rejects(
    runControlled(manifest, null, options, h.deps),
    /offline/,
  );
  h.deps.submit = submit;
  await runControlled(manifest, h.saved, options, h.deps);
  assert.equal(h.posts, 1);
  assert.equal(h.saved!.batches.length, 1);
  assert.ok(h.saved!.batches[0]!.classified);
});

test("retry-failed never submits an unsubmitted normal-batch intent", async () => {
  const h = harness();
  const submit = h.deps.submit;
  h.deps.submit = async () => {
    throw new Error("offline before POST");
  };
  await assert.rejects(
    runControlled(manifest, null, options, h.deps),
    /offline before POST/,
  );
  h.deps.submit = submit;
  await assert.rejects(
    runControlled(manifest, h.saved, { ...options, retryFailed: true }, h.deps),
    /retry mode/,
  );
  assert.equal(h.posts, 0);
});

const integration = process.env.CONTEST_OFFICIAL_TEST_DATABASE_URL;
test(
  "isolated PostgreSQL: idempotency, pilot validation, deterministic review artifacts and read-only dry run",
  { skip: !integration },
  async () => {
    assert.match(new URL(integration!).pathname, /_test$/);
    assert.equal(process.env.DATABASE_URL, integration);
    const p = await officialPreflight(),
      existing = new Set(
        (
          await pool.query(
            "SELECT target->>'catalogItemId' AS id FROM meta.generation_jobs WHERE job_type='GENERATE_DETECTION_PROPOSAL' AND status <> 'failed'",
          )
        ).rows.map((r) => r.id),
      ),
      ids = p.targets
        .filter((t) => !existing.has(t.catalogItemId))
        .slice(0, 2)
        .map((t) => t.catalogItemId),
      request = {
        runnerRequestId: randomUUID(),
        expectedPlanSha256: p.planSha256,
        catalogItemIds: ids,
        type: "GENERATE_DETECTION_PROPOSAL" as const,
      };
    const tables = [
      "meta.generation_jobs",
      "meta.annotation_tracks",
      "meta.annotation_packages",
      "meta.annotation_versions",
      "meta.annotation_version_pointers",
      "meta.detection_proposals",
    ];
    const fingerprint = async () =>
      Promise.all(
        tables.map(
          async (table) =>
            (
              await pool.query(
                `SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS hash FROM ${table} t`,
              )
            ).rows[0]!.hash,
        ),
      );
    const first = await queueOfficialBatch(request),
      beforeRetry = await fingerprint();
    const second = await queueOfficialBatch(request);
    assert.equal(second.jobId, first.jobId);
    assert.deepEqual(second.childJobIds, first.childJobIds);
    assert.deepEqual(await fingerprint(), beforeRetry);
    await assert.rejects(
      queueOfficialBatch({ ...request, catalogItemIds: ["5"] }),
      /different payload/,
    );
    await assert.rejects(
      queueOfficialBatch({ ...request, runnerRequestId: randomUUID() }),
      /already have non-failed/,
    );
    await assert.rejects(
      queueOfficialBatch({
        ...request,
        runnerRequestId: randomUUID(),
        type: "ANNOTATION_LLM_PIPELINE",
      }),
      /detection only/,
    );
    await pool.query(
      "UPDATE meta.generation_jobs SET status='completed',deleted_at=now() WHERE id=$1",
      [first.jobId],
    );
    assert.equal(
      (await queueOfficialBatch(request)).jobId,
      first.jobId,
      "terminal/deleted parents remain idempotent",
    );
    const pilot = (await readPilotEvidence(["1"]))[0]!,
      r = validateProposal(pilot.job.target, pilot.job.target, pilot);
    assert.equal(r.status, "success", r.issues.join(","));
    const root = await mkdtemp(path.join(tmpdir(), "contest-review-"));
    await writeReview(root, "test", [r]);
    const files = async () => {
      const entries = await readdir(root, {
        recursive: true,
        withFileTypes: true,
      });
      const result: Record<string, string> = {};
      for (const e of entries)
        if (e.isFile()) {
          const file = path.join(e.parentPath, e.name);
          result[path.relative(root, file)] = (await readFile(file)).toString(
            "base64",
          );
        }
      return result;
    };
    const artifacts = await files();
    await writeReview(root, "test", [r]);
    assert.deepEqual(await files(), artifacts);
    const liveManifest = JSON.parse(
      await readFile(
        "../backups/lct/contest_reference_phase3c/full-autodetect-remaining.json",
        "utf8",
      ),
    );
    const before = await fingerprint();
    let posts = 0;
    const result = await runControlled(
      liveManifest,
      null,
      { ...options, dryRun: true },
      {
        preflight: officialPreflight,
        pilots: readPilotEvidence,
        lookup: readBatch,
        submit: async () => {
          posts++;
          throw new Error("NO POST");
        },
        save: async () => {},
        artifact: async () => {},
        pause: async () => {},
        log: () => {},
      },
    );
    assert.equal(result.pending, 2096);
    assert.equal(posts, 0);
    assert.deepEqual(await fingerprint(), before);
  },
);
test.after(async () => {
  await pool.end();
});
