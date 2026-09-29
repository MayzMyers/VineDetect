import { getAnnotationSummary, listInventoryItems, type InventoryItemRow } from "../../db/source.repository.js";

export async function listInventoryRecords(params: Parameters<typeof listInventoryItems>[0]) {
  const { rows, total } = await listInventoryItems(params);
  return {
    items: rows.map(toInventoryDto),
    total,
    limit: params.limit,
    offset: params.offset,
  };
}

export async function getAnnotationSummaryRecord(source: Parameters<typeof getAnnotationSummary>[0]) {
  const summary = await getAnnotationSummary(source);
  return {
    ...summary,
    reviewedPercent: percent(summary.reviewedBbox, summary.totalItems),
    exportReadyPercent: percent(summary.readyForExport, summary.totalItems),
    ocrReadyPercent: percent(summary.textReadyForExport, summary.totalItems),
    proposalCoveragePercent: percent(summary.withProposal, summary.totalItems),
    catalogIdentityReadyPercent: percent(summary.withCatalogIdentity, summary.withLabelAnalysis),
  };
}

function percent(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((value / total) * 1000) / 10;
}

function toInventoryDto(row: InventoryItemRow) {
  return {
    source: row.source,
    sourceItemId: row.sourceItemId,
    title: row.title,
    manufacturer: row.manufacturer,
    category: row.category,
    region: row.region,
    year: row.year,
    barcode: row.barcode,
    color: row.color,
    description: row.description,
    imageUrls: row.imageUrls,
    annotationTracks: row.annotationTracks,
    annotationWorkflow: row.annotationWorkflow,
    metadata: row.metadata
      ? {
          ...row.metadata,
          updatedAt: row.metadata.updatedAt?.toISOString() ?? null,
        }
      : null,
    latestJob: row.latestJob
      ? {
          ...row.latestJob,
          createdAt: row.latestJob.createdAt.toISOString(),
          completedAt: row.latestJob.completedAt?.toISOString() ?? null,
        }
      : null,
  };
}
