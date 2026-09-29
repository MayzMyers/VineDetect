import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./pool.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";
import type {
  CreatePresetInput,
  CreatePresetRevisionInput,
  ListPresetsQuery,
} from "../modules/presets/presets.schemas.js";
import { validatePresetConfig } from "../modules/presets/presets.schemas.js";

export type PipelinePresetDto = {
  revisionId: string;
  id: string;
  revision: number;
  layer: string;
  name: string;
  description: string | null;
  status: string;
  engineKind: string;
  engineVersion: string | null;
  config: Record<string, unknown>;
  createdFrom: { source: string; sourceItemId: string } | null;
  createdBy: string | null;
  basedOnRevision: number | null;
  validationDatasetVersion: string | null;
  validationMetrics: Record<string, unknown> | null;
  createdAt: string;
};

export async function listLatestPipelinePresets(query: ListPresetsQuery): Promise<PipelinePresetDto[]> {
  const filters: string[] = [];
  const values: unknown[] = [];
  if (query.layer) {
    values.push(query.layer);
    filters.push(`layer = $${values.length}`);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const latestFilters: string[] = [];
  if (query.status) {
    values.push(query.status);
    latestFilters.push(`status = $${values.length}`);
  } else if (!query.includeDeprecated) {
    latestFilters.push("status <> 'deprecated'");
  }
  const latestWhere = latestFilters.length ? `WHERE ${latestFilters.join(" AND ")}` : "";
  const result = await pool.query(
    `
    SELECT *
    FROM (
      SELECT DISTINCT ON (preset_id) *
      FROM meta.pipeline_preset_revisions
      ${where}
      ORDER BY preset_id, revision DESC
    ) latest
    ${latestWhere}
    ORDER BY created_at DESC, name ASC
    `,
    values,
  );
  return result.rows.map((row) => rowToDto(row as Record<string, unknown>));
}

export async function getPipelinePresetRevision(presetId: string, revision: number): Promise<PipelinePresetDto> {
  const result = await pool.query(
    `SELECT * FROM meta.pipeline_preset_revisions WHERE preset_id = $1 AND revision = $2`,
    [presetId, revision],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new NotFoundError("Pipeline preset revision not found");
  return rowToDto(row);
}

export async function listPipelinePresetRevisions(presetId: string): Promise<PipelinePresetDto[]> {
  const result = await pool.query(
    `SELECT * FROM meta.pipeline_preset_revisions WHERE preset_id = $1 ORDER BY revision DESC`,
    [presetId],
  );
  if (!result.rowCount) throw new NotFoundError("Pipeline preset not found");
  return result.rows.map((row) => rowToDto(row as Record<string, unknown>));
}

export async function createPipelinePreset(input: CreatePresetInput): Promise<PipelinePresetDto> {
  validatePresetConfig(input.layer, input.config);
  const row = await insertRevision(pool, randomUUID(), 1, null, input);
  return rowToDto(row);
}

export async function createPipelinePresetRevision(
  presetId: string,
  input: CreatePresetRevisionInput,
): Promise<PipelinePresetDto> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [presetId]);
    const currentResult = await client.query(
      `
      SELECT *
      FROM meta.pipeline_preset_revisions
      WHERE preset_id = $1
      ORDER BY revision DESC
      LIMIT 1
      FOR UPDATE
      `,
      [presetId],
    );
    const current = currentResult.rows[0] as Record<string, unknown> | undefined;
    if (!current) throw new NotFoundError("Pipeline preset not found");
    const currentRevision = Number(current.revision);
    if (input.baseRevision !== currentRevision) {
      throw new ConflictError(`Preset revision conflict: expected ${input.baseRevision}, current ${currentRevision}`);
    }
    const merged = mergeRevisionInput(current, input);
    validatePresetConfig(merged.layer, merged.config);
    const row = await insertRevision(client, presetId, currentRevision + 1, currentRevision, merged);
    await client.query("COMMIT");
    return rowToDto(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertRevision(
  executor: Pick<PoolClient, "query">,
  presetId: string,
  revision: number,
  basedOnRevision: number | null,
  input: CreatePresetInput,
) {
  const result = await executor.query(
    `
    INSERT INTO meta.pipeline_preset_revisions (
      id, preset_id, revision, layer, name, description, status,
      engine_kind, engine_version, config,
      created_from_source, created_from_source_item_id, created_by,
      based_on_revision, validation_dataset_version, validation_metrics
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10,
      $11, $12, $13,
      $14, $15, $16
    )
    RETURNING *
    `,
    [
      randomUUID(),
      presetId,
      revision,
      input.layer,
      input.name,
      input.description ?? null,
      input.status,
      input.engineKind,
      input.engineVersion ?? null,
      JSON.stringify(input.config),
      input.createdFrom?.source ?? null,
      input.createdFrom?.sourceItemId ?? null,
      input.createdBy ?? null,
      basedOnRevision,
      input.validationDatasetVersion ?? null,
      input.validationMetrics ? JSON.stringify(input.validationMetrics) : null,
    ],
  );
  return result.rows[0] as Record<string, unknown>;
}

function mergeRevisionInput(current: Record<string, unknown>, input: CreatePresetRevisionInput): CreatePresetInput {
  const createdFromSource = stringValue(current.created_from_source);
  const createdFromSourceItemId = stringValue(current.created_from_source_item_id);
  return {
    layer: current.layer as CreatePresetInput["layer"],
    name: input.name ?? String(current.name),
    description: input.description ?? stringValue(current.description) ?? undefined,
    status: input.status ?? (current.status as CreatePresetInput["status"]),
    engineKind: input.engineKind ?? String(current.engine_kind),
    engineVersion: input.engineVersion ?? stringValue(current.engine_version) ?? undefined,
    config: input.config,
    createdFrom:
      input.createdFrom ??
      (createdFromSource && createdFromSourceItemId
        ? { source: createdFromSource as "svoe_vino" | "roskachestvo", sourceItemId: createdFromSourceItemId }
        : undefined),
    createdBy: input.createdBy ?? stringValue(current.created_by) ?? undefined,
    validationDatasetVersion:
      input.validationDatasetVersion ?? stringValue(current.validation_dataset_version) ?? undefined,
    validationMetrics:
      input.validationMetrics ?? objectValue(current.validation_metrics) ?? undefined,
  };
}

function rowToDto(row: Record<string, unknown>): PipelinePresetDto {
  const source = stringValue(row.created_from_source);
  const sourceItemId = stringValue(row.created_from_source_item_id);
  return {
    revisionId: String(row.id),
    id: String(row.preset_id),
    revision: Number(row.revision),
    layer: String(row.layer),
    name: String(row.name),
    description: stringValue(row.description),
    status: String(row.status),
    engineKind: String(row.engine_kind),
    engineVersion: stringValue(row.engine_version),
    config: objectValue(row.config) ?? {},
    createdFrom: source && sourceItemId ? { source, sourceItemId } : null,
    createdBy: stringValue(row.created_by),
    basedOnRevision: numberValue(row.based_on_revision),
    validationDatasetVersion: stringValue(row.validation_dataset_version),
    validationMetrics: objectValue(row.validation_metrics),
    createdAt: dateValue(row.created_at),
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function dateValue(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}
