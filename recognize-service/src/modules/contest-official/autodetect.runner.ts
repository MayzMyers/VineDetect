import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  OfficialReference,
  OfficialTarget,
} from "../../shared/officialReference.js";
import { assertReferenceMatches } from "../../shared/officialReference.js";
import {
  terminal,
  validateProposal,
  type Evidence,
  type Row,
  type Validation,
} from "./autodetect.validation.js";
export const PILOT_IDS = ["1", "2", "152", "193", "976", "1842", "1843"];
export type Manifest = {
  planSha256: string;
  excludedPilotCatalogItemIds: (string | number)[];
  catalogItemIds: (string | number)[];
};
export type Plan = {
  total: number;
  planSha256: string;
  targets: OfficialReference[];
  runnerProtocolVersion?: number;
};
export type Batch = {
  requestId: string;
  catalogItemIds: string[];
  planSha256: string;
  jobId?: string;
  childJobIds?: string[];
  targets?: OfficialTarget[];
  classified?: boolean;
};
export type State = {
  schemaVersion: 1;
  manifestSha256: string;
  planSha256: string;
  assignments: Record<
    string,
    {
      status: "pending" | "pilot" | "success" | "failed" | "inconsistent";
      jobId?: string;
      issues?: string[];
    }
  >;
  batches: Batch[];
};
export type BatchEvidence = { parent: Row; children: Evidence[] };
export type Dependencies = {
  preflight: () => Promise<Plan>;
  pilots: (ids: string[]) => Promise<Evidence[]>;
  lookup: (requestId: string) => Promise<BatchEvidence | null>;
  submit: (batch: Batch) => Promise<{
    jobId: string;
    childJobIds: string[];
    targets: OfficialTarget[];
  }>;
  save: (state: State) => Promise<void>;
  artifact: (batch: Batch, results: Validation[]) => Promise<void>;
  pause: () => Promise<void>;
  log: (message: string) => void;
};
export function validateManifest(manifest: Manifest, plan: Plan) {
  const pilots = manifest.excludedPilotCatalogItemIds.map(String),
    ids = manifest.catalogItemIds.map(String),
    all = [...pilots, ...ids];
  if (
    plan.total !== 2103 ||
    plan.targets.length !== 2103 ||
    new Set(plan.targets.map((r) => r.catalogItemId)).size !== 2103
  )
    throw new Error("Preflight must enumerate exactly 2103 assignments");
  if (plan.planSha256 !== manifest.planSha256)
    throw new Error(
      "Plan hash drift: reconcile the manifest before submitting anything",
    );
  if (
    !isDeepStrictEqual([...pilots].sort(), [...PILOT_IDS].sort()) ||
    ids.length !== 2096 ||
    new Set(all).size !== 2103 ||
    plan.targets.some((r) => !all.includes(r.catalogItemId))
  )
    throw new Error(
      "Manifest must contain 2096 unique assignments and the seven verified pilots",
    );
  return { pilots, ids };
}
export function selectedIds(state: State, retryFailed: boolean) {
  return Object.entries(state.assignments)
    .filter(([, v]) => v.status === (retryFailed ? "failed" : "pending"))
    .map(([id]) => id)
    .sort((a, b) => Number(a) - Number(b));
}
export function chunks<T>(values: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1)
    throw new Error("Invalid batch size");
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size)
    result.push(values.slice(i, i + size));
  return result;
}
export async function runControlled(
  manifest: Manifest,
  state: State | null,
  options: {
    dryRun: boolean;
    batchSize: number;
    maxBatches: number;
    retryFailed: boolean;
  },
  deps: Dependencies,
) {
  const initial = await deps.preflight(),
    { pilots, ids } = validateManifest(manifest, initial);
  const digest = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  if (
    state &&
    (state.schemaVersion !== 1 ||
      state.manifestSha256 !== digest ||
      state.planSha256 !== initial.planSha256)
  )
    throw new Error("Checkpoint or manifest changed; refusing to resume");
  if (!state)
    state = {
      schemaVersion: 1,
      manifestSha256: digest,
      planSha256: initial.planSha256,
      assignments: Object.fromEntries(
        [...pilots, ...ids].map((id) => [id, { status: "pending" as const }]),
      ),
      batches: [],
    };
  if (
    Object.keys(state.assignments).length !== 2103 ||
    initial.targets.some((r) => !state!.assignments[r.catalogItemId])
  )
    throw new Error("Checkpoint assignment set is incomplete");
  const refs = new Map(initial.targets.map((r) => [r.catalogItemId, r]));
  const pilotEvidence = await deps.pilots(pilots),
    pilotResults: Validation[] = [];
  for (const id of pilots) {
    const evidence = pilotEvidence.filter(
      (e) => String(e.job.target?.catalogItemId) === id,
    );
    const good = evidence
      .map((e) => validateProposal(refs.get(id)!, e.job.target, e))
      .filter((r) => r.status === "success");
    if (good.length !== 1)
      throw new Error(
        `Pilot ${id} must have exactly one verified completed proposal; found ${good.length}`,
      );
    pilotResults.push(good[0]!);
    state.assignments[id] = { status: "pilot", jobId: good[0]!.jobId };
  }
  await deps.save(state);
  await deps.artifact(
    {
      requestId: "pilot-validation",
      catalogItemIds: pilots,
      planSha256: state.planSha256,
    },
    pilotResults,
  );
  const classify = async (
    batch: Batch,
    found: BatchEvidence,
  ): Promise<boolean> => {
    if (batch.jobId && batch.jobId !== String(found.parent.id))
      throw new Error("Parent job changed");
    if (
      found.parent.target.planSha256 !== batch.planSha256 ||
      found.parent.job_type !== "GENERATE_DETECTION_PROPOSAL"
    )
      throw new Error("Parent plan/type changed");
    const targets = found.parent.target.items as OfficialTarget[];
    if (
      !Array.isArray(targets) ||
      !isDeepStrictEqual(
        targets.map((t) => t.catalogItemId).sort(),
        [...batch.catalogItemIds].sort(),
      )
    )
      throw new Error("Parent assignment set changed");
    if (batch.targets && !isDeepStrictEqual(batch.targets, targets))
      throw new Error("Frozen parent targets changed");
    for (const t of targets)
      assertReferenceMatches(refs.get(t.catalogItemId)!, t);
    if (
      found.children.length !== targets.length ||
      new Set(found.children.map((e) => e.job.target?.catalogItemId)).size !==
        targets.length
    )
      throw new Error(
        "Missing or duplicate child jobs; manual reconciliation required",
      );
    const childIds = found.children.map((e) => String(e.job.id));
    if (
      batch.childJobIds &&
      !isDeepStrictEqual([...batch.childJobIds].sort(), [...childIds].sort())
    )
      throw new Error("Child job IDs changed");
    batch.jobId = String(found.parent.id);
    batch.childJobIds = childIds;
    batch.targets = targets;
    await deps.save(state!); // Persist database reconciliation before waiting or rendering.
    if (
      !terminal(found.parent.status) ||
      found.children.some((e) => !terminal(e.job.status))
    ) {
      if (batch.classified)
        throw new Error(
          "Previously classified jobs returned to a nonterminal state",
        );
      return false;
    }
    const results = targets.map((t) =>
      validateProposal(
        refs.get(t.catalogItemId)!,
        t,
        found.children.find(
          (e) => e.job.target.catalogItemId === t.catalogItemId,
        )!,
      ),
    );
    await deps.artifact(batch, results);
    for (const r of results) {
      // Re-auditing an earlier failed attempt must not replace a later successful retry.
      const latest = [...state!.batches]
        .reverse()
        .find((b) => b.catalogItemIds.includes(r.catalogItemId));
      if (latest === batch)
        state!.assignments[r.catalogItemId] = {
          status: r.status,
          jobId: r.jobId,
          issues: r.issues,
        };
    }
    batch.classified = true;
    await deps.save(state!);
    return true;
  };
  const resumed = new Set(
    state.batches.filter((b) => !b.classified).map((b) => b.requestId),
  );
  // Every recorded parent is queried, including completed parents and jobs that
  // finished while the runner was offline. Never infer completion from counters.
  for (const batch of state.batches) {
    const found = await deps.lookup(batch.requestId);
    if (!found && batch.jobId)
      throw new Error(
        "Recorded parent is missing; refusing to create another draft",
      );
    if (found) await classify(batch, found);
  }
  if (options.dryRun) {
    const pending = selectedIds(state, options.retryFailed);
    return {
      state,
      dryRun: true,
      pending: pending.length,
      batches: chunks(pending, options.batchSize).length,
      unclassified: state.batches.filter((b) => !b.classified).length,
      jobsCreated: 0,
      draftsCreated: 0,
    };
  }
  // Snapshot eligibility so a failed attempt is never retried repeatedly in one invocation.
  const eligible = new Set(selectedIds(state, options.retryFailed));
  let processed = state.batches.filter(
    (batch) => resumed.has(batch.requestId) && batch.classified,
  ).length;
  for (;;) {
    let batch = state.batches.find((b) => !b.classified);
    if (!batch) {
      if (processed >= options.maxBatches) break;
      const pending = selectedIds(state, options.retryFailed).filter((id) =>
        eligible.has(id),
      );
      if (!pending.length) break;
      batch = {
        requestId: randomUUID(),
        catalogItemIds: pending.slice(0, options.batchSize),
        planSha256: state.planSha256,
      };
      state.batches.push(batch);
      await deps.save(state); // Durable intent MUST precede POST.
    }
    const fresh = await deps.preflight();
    validateManifest(manifest, fresh);
    if (fresh.runnerProtocolVersion !== 1)
      throw new Error(
        "Deploy the Phase 3D idempotent batch API before a real run",
      );
    let found = await deps.lookup(batch.requestId);
    if (!found) {
      if (batch.jobId) throw new Error("Recorded parent is missing");
      const requiredStatus = options.retryFailed ? "failed" : "pending";
      if (
        batch.catalogItemIds.some(
          (id) => state!.assignments[id]?.status !== requiredStatus,
        )
      )
        throw new Error(
          "Unsubmitted intent does not match this retry mode; resume with the original --retry-failed setting",
        );
      const submitted = await deps.submit(batch);
      batch.jobId = submitted.jobId;
      batch.childJobIds = submitted.childJobIds;
      batch.targets = submitted.targets;
      await deps.save(state); // Record parent/children immediately, before any polling.
    }
    for (;;) {
      found = await deps.lookup(batch.requestId);
      if (!found)
        throw new Error(
          "Submitted parent not visible in configured PostgreSQL; checkpoint preserved",
        );
      if (await classify(batch, found)) break;
      deps.log(
        `Waiting for ${batch.jobId}: ${found.children.filter((e) => terminal(e.job.status)).length}/${batch.catalogItemIds.length} terminal`,
      );
      await deps.pause();
    }
    for (const id of batch.catalogItemIds) eligible.delete(id);
    processed++;
    if (processed >= options.maxBatches) break;
  }
  return {
    state,
    dryRun: false,
    pending: selectedIds(state, false).length,
    batchesProcessed: processed,
    resumed: resumed.size,
  };
}
