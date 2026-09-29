import { closePool } from "./pool.js";
import { getAnnotationSummary, listInventoryItems, type InventorySource } from "./source.repository.js";

const QUEUES = ["needs-review", "needs-ocr", "needs-ocr-review", "ready-for-export"] as const;

async function main() {
  const source = parseSource(readArg("--source") ?? "all");
  const sampleLimit = Number(readArg("--samples") ?? 3);
  const summary = await getAnnotationSummary(source);
  const queues = await Promise.all(
    QUEUES.map(async (queue) => {
      const result = await listInventoryItems({
        source,
        annotationStatus: queue,
        limit: sampleLimit,
        offset: 0,
      });
      return {
        queue,
        total: result.total,
        samples: result.rows.map((item) => ({
          source: item.source,
          sourceItemId: item.sourceItemId,
          title: item.title,
          status: item.metadata?.annotationStatus ?? null,
          hasReviewedLabelRoi: item.metadata?.hasReviewedLabelRoi ?? false,
          hasBackendOcr: item.metadata?.hasBackendOcr ?? false,
          hasReviewedOcrText: item.metadata?.hasReviewedOcrText ?? false,
        })),
      };
    }),
  );

  console.log(
    JSON.stringify(
      {
        source,
        counts: {
          totalItems: summary.totalItems,
          withProposal: summary.withProposal,
          missingProposal: summary.missingProposal,
          needsReview: summary.needsReview,
          reviewedBbox: summary.reviewedBbox,
          needsOcr: summary.needsOcr,
          withBackendOcr: summary.withBackendOcr,
          needsOcrReview: summary.needsOcrReview,
          withReviewedOcrText: summary.withReviewedOcrText,
          textReadyForExport: summary.textReadyForExport,
          noLabel: summary.noLabel,
          invalidImage: summary.invalidImage,
          noAnnotation: summary.noAnnotation,
        },
        queues,
      },
      null,
      2,
    ),
  );
}

function parseSource(value: string): InventorySource {
  if (value === "all" || value === "svoe_vino" || value === "roskachestvo") return value;
  throw new Error(`Invalid --source value: ${value}`);
}

function readArg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
