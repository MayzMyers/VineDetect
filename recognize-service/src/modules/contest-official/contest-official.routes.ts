import { ConflictError } from "../../shared/errors.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  listOfficialReferences,
  getOfficialReference,
} from "../../db/official-reference.repository.js";
import { createOfficialDraft } from "../../db/official-draft.repository.js";
import {
  officialPreflight,
  queueOfficialBatch,
} from "./contest-official.service.js";
const id = z.string().regex(/^[1-9][0-9]*$/);
const batch = z
  .object({
    runnerRequestId: z.string().uuid().optional(),
    expectedPlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
    catalogItemIds: z.array(id).min(1).max(2103),
    type: z.enum([
      "GENERATE_DETECTION_PROPOSAL",
      "ANNOTATION_HELPER_PIPELINE",
      "ANNOTATION_LLM_PIPELINE",
    ]),
    options: z
      .object({
        llmExecutionMode: z
          .enum(["session-chain", "one-shot-chain"])
          .optional(),
      })
      .optional(),
  })
  .strict();
export async function contestOfficialRoutes(app: FastifyInstance) {
  app.get("/management/contest-official/references", async () => ({
    items: await listOfficialReferences(),
  }));
  app.get("/management/contest-official/preflight", async () =>
    officialPreflight(),
  );
  app.post("/management/contest-official/drafts", async (request, reply) => {
    const input = z
      .object({
        catalogItemId: id,
        referenceAssetId: id,
        referenceSha256: z.string(),
        referencePath: z.string(),
      })
      .strict()
      .parse(request.body);
    const reference = await getOfficialReference(input.catalogItemId);
    if (
      reference.referenceAssetId !== input.referenceAssetId ||
      reference.referenceSha256 !== input.referenceSha256 ||
      reference.referencePath !== input.referencePath
    )
      return reply
        .code(409)
        .send({ error: "Selected official reference changed" });
    return reply.code(201).send(await createOfficialDraft(reference));
  });
  app.post("/management/contest-official/batch", async (request, reply) => {
    try {
      return reply
        .code(202)
        .send(await queueOfficialBatch(batch.parse(request.body)));
    } catch (error) {
      if (error instanceof ConflictError)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
}
