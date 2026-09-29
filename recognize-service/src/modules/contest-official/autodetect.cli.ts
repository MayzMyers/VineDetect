import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { officialPreflight } from "./contest-official.service.js";
import { readBatch, readPilotEvidence } from "./autodetect.repository.js";
import { atomicJson } from "./autodetect.files.js";
import {
  runControlled,
  type Manifest,
  type State,
  type Plan,
} from "./autodetect.runner.js";
import { writeReview } from "./autodetect.review.js";

async function main() {
  const { values } = parseArgs({
    options: {
      "state-dir": {
        type: "string",
        default: "../backups/lct/contest_reference_phase3d",
      },
      "batch-size": { type: "string", default: "100" },
      "max-batches": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "retry-failed": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "autodetect:contest-official --state-dir PATH --batch-size 100 [--dry-run] [--max-batches N] [--retry-failed]\nUses RECOGNIZE_BASE_URL (default http://127.0.0.1:4001), INTERNAL_API_KEY, DATABASE_URL, ASSET_ROOT. Run dry-run before generation.",
    );
    return;
  }
  const batchSize = Number(values["batch-size"]),
    maxBatches =
      values["max-batches"] === undefined
        ? Infinity
        : Number(values["max-batches"]);
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 2103 ||
    (maxBatches !== Infinity &&
      (!Number.isInteger(maxBatches) || maxBatches < 1))
  )
    throw new Error(
      "batch-size must be 1..2103; max-batches must be a positive integer",
    );
  const dir = path.resolve(values["state-dir"]!),
    stateFile = path.join(dir, "runner-state.json");
  const manifest = JSON.parse(
    await readFile(
      path.resolve(
        "../backups/lct/contest_reference_phase3c/full-autodetect-remaining.json",
      ),
      "utf8",
    ),
  ) as Manifest;
  let state: State | null = null;
  // A session lock protects against concurrent runners (even different state dirs).
  // It releases automatically on process death and writes no persistent DB state.
  const lock = await pool.connect();
  try {
    await lock.query("SET default_transaction_read_only=on");
    const acquired = (
      await lock.query(
        "SELECT pg_try_advisory_lock(hashtextextended('contest-official-controlled-runner-v1',0)) AS locked",
      )
    ).rows[0]?.locked;
    if (!acquired)
      throw new Error("Another controlled official runner is active");
    try {
      state = JSON.parse(await readFile(stateFile, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    for (const name of ["batches", "reports", "review"])
      await mkdir(path.join(dir, name), { recursive: true });
    const url = process.env.RECOGNIZE_BASE_URL ?? "http://127.0.0.1:4001";
    async function api(endpoint: string, body?: unknown) {
      const response = await fetch(url + endpoint, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-internal-api-key": env.INTERNAL_API_KEY,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok)
        throw new Error(
          `Official API ${response.status}: ${await response.text()}`,
        );
      return response.json();
    }
    let protocol: number | undefined;
    const result = await runControlled(
      manifest,
      state,
      {
        dryRun: values["dry-run"]!,
        batchSize,
        maxBatches,
        retryFailed: values["retry-failed"]!,
      },
      {
        preflight: async () => {
          const remote = (await api(
            "/management/contest-official/preflight",
          )) as Plan;
          const local = await officialPreflight(); // Read-only: confirms API and PG/assets point at the same plan.
          if (
            remote.planSha256 !== local.planSha256 ||
            remote.total !== local.total
          )
            throw new Error("API and local database preflight disagree");
          protocol = remote.runnerProtocolVersion;
          return remote;
        },
        pilots: readPilotEvidence,
        lookup: readBatch,
        submit: async (batch) =>
          api("/management/contest-official/batch", {
            runnerRequestId: batch.requestId,
            expectedPlanSha256: batch.planSha256,
            catalogItemIds: batch.catalogItemIds,
            type: "GENERATE_DETECTION_PROPOSAL",
          }),
        save: async (current) => {
          await atomicJson(stateFile, current);
          for (const batch of current.batches)
            await atomicJson(
              path.join(dir, "batches", batch.requestId + ".json"),
              batch,
            );
        },
        artifact: async (batch, results) => {
          await writeReview(dir, batch.requestId, results);
        },
        pause: () => pause(5000),
        log: console.log,
      },
    );
    const { state: finalState, ...summary } = result;
    const report = {
      ...summary,
      officialAssignments: 2103,
      verifiedPilots: 7,
      batchSize,
      planSha256: finalState.planSha256,
      statuses: Object.values(finalState.assignments).reduce<
        Record<string, number>
      >((a, v) => {
        a[v.status] = (a[v.status] ?? 0) + 1;
        return a;
      }, {}),
      runnerProtocolVersion: protocol ?? null,
      readyForRealSubmission: protocol === 1,
    };
    await atomicJson(
      path.join(dir, values["dry-run"] ? "dry-run.json" : "last-run.json"),
      report,
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await lock.query(
      "SELECT pg_advisory_unlock(hashtextextended('contest-official-controlled-runner-v1',0))",
    );
    lock.release();
  }
}
main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
