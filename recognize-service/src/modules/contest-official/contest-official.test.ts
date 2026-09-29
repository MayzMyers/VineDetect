import { enqueueRecognizeJob } from "../jobs/jobs.service.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pool } from "../../db/pool.js";
import {
  isManagedContestPath,
  sourceAssetRef,
  assertReferenceMatches,
  type OfficialReference,
} from "../../shared/officialReference.js";
import { listOfficialReferences } from "../../db/official-reference.repository.js";
import {
  createOfficialDraft,
  createOfficialDraftWithClient,
  officialTargetForTrack,
  getSourceItemForTrack,
} from "../../db/official-draft.repository.js";
import {
  officialPreflight,
  officialPreflightPlan,
  queueOfficialBatch,
  validateOfficialJobTarget,
} from "./contest-official.service.js";
import { getSourceItem } from "../../db/source.repository.js";
import { detectionInput } from "../generation/generation.pipeline.js";
import { resolveLocalAssetPath } from "../recognize-node/assets.js";
import type { SourceItem } from "../../shared/types.js";
import { getAnnotationGraph } from "../../db/annotation-graph.repository.js";
import { updateGraphEntityRecord } from "../metadata/metadata.service.js";
import { buildVisionContext } from "../wizard/wizard-vision-context.service.js";
import { getLabelAnnotationRecord } from "../metadata/metadata.service.js";

const sha = "a".repeat(64),
  managed = `contest/lct-rshb-2026-09-15/sha256/aa/${sha}.webp`;
const base: OfficialReference = {
  source: "svoe_vino",
  sourceItemId: "historic",
  catalogItemId: "1",
  officialSlug: "official",
  wineId: "2",
  referenceAssetId: "3",
  referencePath: managed,
  referenceSha256: sha,
  width: 100,
  height: 200,
  method: "re_slug",
  provenance: {},
};
test("managed contest path whitelist accepts only the content-addressed current namespace", () => {
  assert.ok(isManagedContestPath(managed));
  for (const value of [
    managed.replace("/aa/", "/bb/"),
    managed.replace("/sha256/", "/../"),
    "/" + managed,
    managed.replaceAll("/", "\\"),
    managed + "%2f..",
    managed + "/../secret",
    managed.replace(".webp", ".json"),
    "contest/other/sha256/aa/" + sha + ".webp",
  ])
    assert.equal(isManagedContestPath(value), false, value);
});
test("historical asset behavior remains available", () => {
  assert.match(
    resolveLocalAssetPath("svoe_vino/bottle/1/a.webp")!,
    /svoe-vino\/bottle\/1\/a.webp$/,
  );
  assert.equal(
    sourceAssetRef({ imageUrls: ["historic"] } as SourceItem),
    "historic",
  );
  assert.equal(resolveLocalAssetPath("contest/../../etc/passwd"), null);
});
test("official detection never falls back to historical imageUrls[0]", () => {
  const item = {
    imageUrls: ["historic"],
    sourceAssetRef: managed,
    officialReference: base,
  } as SourceItem;
  assert.equal(detectionInput(item).imageRef, managed);
  assert.throws(
    () => detectionInput({ ...item, sourceAssetRef: undefined }),
    /binding/,
  );
});
test("frozen reference rejects ID, identity, path and SHA drift", () => {
  for (const key of [
    "referenceAssetId",
    "referencePath",
    "referenceSha256",
    "sourceItemId",
    "wineId",
  ] as const)
    assert.throws(
      () => assertReferenceMatches(base, { ...base, [key]: "changed" }),
      /changed/,
    );
});
test("batch planning preserves shared wine and shared SHA as distinct assignments", () => {
  const plan = officialPreflightPlan([
    base,
    {
      ...base,
      catalogItemId: "4",
      officialSlug: "second",
      referenceAssetId: "5",
    },
  ]);
  assert.equal(plan.targets.length, 2);
  assert.equal(plan.targets[0]!.wineId, plan.targets[1]!.wineId);
  assert.equal(
    plan.targets[0]!.referenceSha256,
    plan.targets[1]!.referenceSha256,
  );
  assert.equal(
    plan.planSha256,
    officialPreflightPlan([
      base,
      {
        ...base,
        catalogItemId: "4",
        officialSlug: "second",
        referenceAssetId: "5",
      },
    ]).planSha256,
  );
});

const integration = process.env.CONTEST_OFFICIAL_TEST_DATABASE_URL;
test(
  "official reference integration on isolated migration-058 database",
  { skip: !integration },
  async (t) => {
    assert.match(
      new URL(integration!).pathname,
      /_test$/,
      "Refuse writes outside a test database",
    );
    assert.equal(
      process.env.DATABASE_URL,
      integration,
      "Pool must target the isolated fixture",
    );
    const protectedTables = [
      "contest.catalog_items",
      "contest.item_links",
      "contest.reference_assets",
      "svoe_vino.wines",
      "svoe_vino.wine_images",
      "meta.annotation_versions",
      "meta.annotation_version_pointers",
      "meta.annotation_tracks",
      "meta.annotation_track_states",
      "meta.annotation_packages",
      "meta.annotation_labels",
      "meta.annotation_ocr",
      "meta.annotation_meta",
      "meta.image_annotations",
    ];
    const before = new Map<string, Set<string>>();
    for (const table of protectedTables)
      before.set(
        table,
        new Set(
          (
            await pool.query(`SELECT to_jsonb(t)::text data FROM ${table} t`)
          ).rows.map((r) => r.data),
        ),
      );
    try {
      const refs = await listOfficialReferences();
      await t.test(
        "2103 references and exact/re-slug/materialized canonical identities",
        async () => {
          assert.equal(refs.length, 2103);
          assert.deepEqual(officialPreflightPlan(refs).methods, {
            exact_slug: 1839,
            materialized_official: 248,
            re_slug: 16,
          });
          for (const method of [
            "exact_slug",
            "re_slug",
            "materialized_official",
          ]) {
            const ref = refs.find((r) => r.method === method)!;
            const wine = (
              await pool.query(
                "SELECT COALESCE(external_id,slug,id::text) key FROM svoe_vino.wines WHERE id=$1",
                [ref.wineId],
              )
            ).rows[0];
            assert.equal(ref.sourceItemId, wine.key);
            assert.equal(ref.source, "svoe_vino");
            if (method === "materialized_official")
              assert.equal(ref.sourceItemId, ref.officialSlug);
          }
        },
      );
      await t.test(
        "preflight verifies all bytes and creates no jobs",
        async () => {
          const beforeJobs = (
            await pool.query("SELECT count(*) n FROM meta.generation_jobs")
          ).rows[0].n;
          const plan = await officialPreflight();
          assert.equal(plan.total, 2103);
          assert.equal(plan.verifiedAssets, 2103);
          assert.equal(plan.jobsCreated, 0);
          assert.equal(plan.readOnly, true);
          assert.equal(
            (await pool.query("SELECT count(*) n FROM meta.generation_jobs"))
              .rows[0].n,
            beforeJobs,
          );
        },
      );
      const ref = refs.find((r) => r.method === "re_slug")!;
      const historical = await getSourceItem(ref.source, ref.sourceItemId);
      const draft = await createOfficialDraft(ref);
      await t.test(
        "draft Package, track, version and actual detection input share the official asset",
        async () => {
          const bound = await getSourceItemForTrack(
            ref.source,
            ref.sourceItemId,
            draft.annotationTrackId,
          );
          assert.ok(bound);
          assert.deepEqual(bound.imageUrls, historical!.imageUrls);
          assert.equal(detectionInput(bound).imageRef, ref.referencePath);
          assert.ok(detectionInput(bound).localPath);
          assert.ok((await readFile(detectionInput(bound).localPath!)).length);
          const graph = await getAnnotationGraph(ref.source, ref.sourceItemId);
          const pack = graph.packages.find((p) => p.id === draft.packageId)!;
          assert.equal(pack.sourceAssetRef, ref.referencePath);
          assert.equal(pack.labels.length, 0);
          assert.equal(
            (await officialTargetForTrack(
              ref.source,
              ref.sourceItemId,
              draft.annotationTrackId,
            ))!.referenceAssetId,
            ref.referenceAssetId,
          );
          const annotation = await getLabelAnnotationRecord(
            ref.source,
            ref.sourceItemId,
            draft.annotationTrackId,
          );
          assert.equal(annotation.annotation, null);
          const vision = await buildVisionContext(
            ref.source,
            ref.sourceItemId,
            draft.annotationTrackId,
          );
          assert.equal(vision.assets.source, ref.referencePath);
          await assert.rejects(
            updateGraphEntityRecord(
              ref.source,
              ref.sourceItemId,
              "package",
              draft.packageId,
              {
                sourceAssetRef: "svoe_vino/wrong.webp",
                operation: { helperId: "test", reviewMode: "manual" },
              },
            ),
            /immutable/,
          );
        },
      );
      await t.test(
        "single Wizard job freezes official context without resetting historical versions",
        async () => {
          const queued = await enqueueRecognizeJob({
            type: "ANNOTATION_LLM_PIPELINE",
            target: { source: ref.source, sourceItemId: ref.sourceItemId },
            options: {
              annotationTrackId: draft.annotationTrackId,
              annotationVersionId: draft.annotationVersionId,
              annotationVersionInitialization: "empty",
              annotationVersionPublishPolicy: "auto-on-success",
            },
          });
          const row = (
            await pool.query("SELECT * FROM meta.generation_jobs WHERE id=$1", [
              queued.jobId,
            ])
          ).rows[0];
          assert.equal(row.target.referencePath, ref.referencePath);
          assert.equal(row.options.annotationVersionPublishPolicy, "review");
          assert.equal(row.options.annotationVersionInitialization, undefined);
          await validateOfficialJobTarget(row);
          await assert.rejects(
            enqueueRecognizeJob({
              type: "ANNOTATION_LLM_PIPELINE",
              target: { source: ref.source, sourceItemId: ref.sourceItemId },
              options: {
                annotationVersionId: draft.annotationVersionId,
                annotationVersionInitialization: "empty",
              },
            }),
            /explicit bound track/,
          );
        },
      );
      const plan = officialPreflightPlan(refs);
      const batch = await queueOfficialBatch({
        expectedPlanSha256: plan.planSha256,
        catalogItemIds: [refs[0]!.catalogItemId, refs[1]!.catalogItemId],
        type: "GENERATE_DETECTION_PROPOSAL",
      });
      const job = (
        await pool.query(
          "SELECT * FROM meta.generation_jobs WHERE parent_job_id=$1 ORDER BY id",
          [batch.jobId],
        )
      ).rows[0];
      await t.test(
        "batch children persist frozen IDs/path/SHA and draft context; worker accepts original",
        async () => {
          assert.equal(batch.queuedChildren, 2);
          assert.equal(batch.targets.length, 2);
          const validated = await validateOfficialJobTarget(job);
          assert.ok(validated);
          assert.equal(validated.referenceAssetId, job.target.referenceAssetId);
          assert.equal(validated.referencePath, job.target.referencePath);
          assert.equal(validated.referenceSha256, job.target.referenceSha256);
          assert.equal(validated.annotationTrackId, job.annotation_track_id);
          assert.equal(
            validated.annotationVersionId,
            job.annotation_version_id,
          );
        },
      );
      await t.test("worker rejects tampered frozen target", async () => {
        for (const key of [
          "referenceSha256",
          "referencePath",
          "referenceAssetId",
          "packageId",
          "annotationVersionId",
        ])
          await assert.rejects(
            validateOfficialJobTarget({
              ...job,
              target: { ...job.target, [key]: "changed" },
            }),
          );
      });
      await t.test(
        "worker rejects reference path and SHA changed in database",
        async () => {
          const original = {
            sha: job.target.referenceSha256,
            path: job.target.referencePath,
          };
          for (const changed of [
            {
              sha: "f".repeat(64),
              path: `contest/lct-rshb-2026-09-15/sha256/ff/${"f".repeat(64)}.webp`,
            },
            {
              sha: original.sha,
              path: original.path.replace(/\.[^.]+$/, ".png"),
            },
          ]) {
            try {
              await pool.query(
                "UPDATE contest.reference_assets SET sha256=$1,local_path=$2 WHERE id=$3",
                [changed.sha, changed.path, job.target.referenceAssetId],
              );
              await assert.rejects(validateOfficialJobTarget(job));
            } finally {
              await pool.query(
                "UPDATE contest.reference_assets SET sha256=$1,local_path=$2 WHERE id=$3",
                [original.sha, original.path, job.target.referenceAssetId],
              );
            }
          }
        },
      );
      await t.test(
        "shared wine and SHA assignments create separate Package/track/version contexts",
        async () => {
          const sameWine = refs.filter(
            (r) =>
              r.wineId ===
              refs.find((r, i) =>
                refs.some((other, j) => j !== i && r.wineId === other.wineId),
              )!.wineId,
          );
          const sameSha = refs.filter(
            (r) =>
              r.referenceSha256 ===
              refs.find((r, i) =>
                refs.some(
                  (other, j) =>
                    j !== i && r.referenceSha256 === other.referenceSha256,
                ),
              )!.referenceSha256,
          );
          for (const pair of [sameWine.slice(0, 2), sameSha.slice(0, 2)]) {
            assert.equal(pair.length, 2);
            const created = await queueOfficialBatch({
              expectedPlanSha256: plan.planSha256,
              catalogItemIds: pair.map((r) => r.catalogItemId),
              type: "ANNOTATION_HELPER_PIPELINE",
            });
            assert.equal(created.queuedChildren, 2);
            assert.notEqual(
              created.targets[0]!.annotationTrackId,
              created.targets[1]!.annotationTrackId,
            );
            assert.notEqual(
              created.targets[0]!.annotationVersionId,
              created.targets[1]!.annotationVersionId,
            );
          }
        },
      );
      await t.test(
        "draft transaction rollback leaves no partial track",
        async () => {
          const db = await pool.connect();
          try {
            await db.query("BEGIN");
            const target = await createOfficialDraftWithClient(db, ref);
            await db.query("ROLLBACK");
            assert.equal(
              (
                await pool.query(
                  "SELECT id FROM meta.annotation_tracks WHERE id=$1",
                  [target.annotationTrackId],
                )
              ).rows.length,
              0,
            );
          } finally {
            db.release();
          }
        },
      );
      await t.test("stale preflight creates no batch or drafts", async () => {
        const beforeCount = (
          await pool.query("SELECT count(*) n FROM meta.annotation_tracks")
        ).rows[0].n;
        await assert.rejects(
          queueOfficialBatch({
            expectedPlanSha256: "0".repeat(64),
            catalogItemIds: [ref.catalogItemId],
            type: "GENERATE_DETECTION_PROPOSAL",
          }),
          /preflight changed/,
        );
        assert.equal(
          (await pool.query("SELECT count(*) n FROM meta.annotation_tracks"))
            .rows[0].n,
          beforeCount,
        );
      });
      await t.test(
        "existing catalog, reviewed graph and all version pointers are unchanged",
        async () => {
          for (const table of protectedTables) {
            const after = new Set(
              (
                await pool.query(
                  `SELECT to_jsonb(t)::text data FROM ${table} t`,
                )
              ).rows.map((r) => r.data),
            );
            for (const row of before.get(table)!)
              assert.ok(after.has(row), `Existing row changed in ${table}`);
            if (
              ![
                "meta.annotation_tracks",
                "meta.annotation_track_states",
                "meta.annotation_packages",
                "meta.annotation_versions",
              ].includes(table)
            )
              assert.equal(after.size, before.get(table)!.size, table);
          }
        },
      );
    } finally {
      await pool.end();
    }
  },
);
