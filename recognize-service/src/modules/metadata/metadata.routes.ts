import type { FastifyInstance } from "fastify";
import { annotationRequestActor, recordAnnotationTrackActor } from "../../db/annotation-actor.repository.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import {
  deleteManualAnnotationRecord,
  deleteMetadataRecords,
  exportManualMetadataRecords,
  getAliasReviewWorkspace,
  getCatalogIdentityReviewRecord,
  getLabelAnnotationRecord,
  getLabelAnalysisReviewRecord,
  getLabelAnalysisWorkspaceRecord,
  getCanonicalLabelCvWorkspaceRecord,
  getLabelAnnotationOcrRecord,
  getLabelAnnotationOcrReviewRecord,
  getLabelAnnotationOcrRegionReviewRecord,
  getManualAnnotationRecord,
  getOcrSourceAssociationWorkspace,
  listDetectionProposalRecords,
  getMetadataSandbox,
  listMetadataRecords,
  patchMetadataRecord,
  previewLabelCvJobRecord,
  putLabelCvJobCheckpointRecord,
  putDetectionProposalRecord,
  putLabelAnnotationRecord,
  putLabelAnalysisReviewRecord,
  putLabelCvJobRecord,
  putLabelAnnotationOcrReviewRecord,
  putLabelAnnotationOcrRegionReviewRecord,
  putManualAnnotationRecord,
  putAliasReviewRecord,
  putCatalogIdentityReviewRecord,
  putOcrSourceAssociationReviewRecord,
  runLabelAnnotationOcrRecord,
  runLabelAnalysisRecord,
  runSourceAnalysisRecord,
  putSourceAnalysisRecord,
  listAnnotationTrackRecords,
  createAnnotationTrackRecord,
  getAnnotationGraphRecord,
  getGraphPackageOcrRecord,
  createGraphPackageRecord,
  createGraphLabelRecord,
  reviewGraphLabelCandidatesRecord,
  createGraphOcrRecord,
  createGraphMetaRecord,
  deleteGraphEntityRecord,
  updateGraphEntityRecord,
  runGraphAutoOcrRecord,
  runGraphLabelRectificationRecord,
  runGraphPackageDetectionRecord,
  reviewGraphAutoOcrRecord,
  reviewGraphAutoOcrActionsRecord,
  runManualOcrDedupePreflightRecord,
  reparentGraphOcrRecord,
  listAnnotationVersionRecords,
  getAnnotationVersionRecord,
  createAnnotationVersionRecord,
  bootstrapAnnotationVersionRecord,
  deleteAnnotationVersionRecord,
  editAnnotationVersionRecord,
  promoteAnnotationVersionRecord,
  listMetadataVersionRecords,
  makeMetadataVersionDefaultRecord,
  deleteMetadataVersionRecord,
} from "./metadata.service.js";
import { aliasReviewSchema, annotationTrackQuerySchema, catalogIdentityReviewSchema, createAnnotationTrackSchema, createGraphLabelSchema, createGraphMetaSchema, createGraphOcrSchema, createGraphPackageSchema, deleteMetadataItemsSchema, detectionProposalSchema, graphEntityTypeSchema, labelAnalysisReviewSchema, labelAnalysisRunSchema, labelAnnotationSchema, labelCvJobCheckpointSchema, labelCvJobPreviewSchema, labelCvJobReviewSchema, listMetadataQuerySchema, manualAnnotationsSchema, manualMetadataExportQuerySchema, manualOcrDedupePreflightSchema, ocrRegionReviewSchema, ocrSourceAssociationReviewSchema, ocrTextReviewSchema, parseGraphEntityUpdate, patchMetadataSchema, reparentGraphOcrSchema, reviewAutoOcrActionsSchema, reviewAutoOcrSchema, reviewGraphLabelCandidatesSchema, runAutoOcrSchema, runLabelRectificationSchema, runPackageDetectionSchema, sourceAnalysisRunSchema, sourceAnalysisStateSchema, sourceNameSchema } from "./metadata.schemas.js";

export async function metadataRoutes(app: FastifyInstance) {
  app.get("/management/items/:source/:sourceItemId/annotation-versions", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try { return await listAnnotationVersionRecords(params.source, params.sourceItemId); }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.post("/management/items/:source/:sourceItemId/annotation-versions", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try { return reply.code(201).send(await createAnnotationVersionRecord(params.source, params.sourceItemId)); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/items/:source/:sourceItemId/annotation-versions/bootstrap", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try {
      const result = await bootstrapAnnotationVersionRecord(params.source, params.sourceItemId);
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/items/:source/:sourceItemId/annotation-versions/:versionId", async (request, reply) => {
    const params = parseVersionParams(request.params);
    try { return await getAnnotationVersionRecord(params.source, params.sourceItemId, params.versionId); }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.delete("/management/items/:source/:sourceItemId/annotation-versions/:versionId", async (request, reply) => {
    const params = parseVersionParams(request.params);
    try { return await deleteAnnotationVersionRecord(params.source, params.sourceItemId, params.versionId); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/items/:source/:sourceItemId/annotation-versions/:versionId/edit", async (request, reply) => {
    const params = parseVersionParams(request.params);
    try { return reply.code(201).send(await editAnnotationVersionRecord(params.source, params.sourceItemId, params.versionId)); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/items/:source/:sourceItemId/annotation-versions/:versionId/default", async (request, reply) => {
    const params = parseVersionParams(request.params);
    try { return await promoteAnnotationVersionRecord(params.source, params.sourceItemId, params.versionId); }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.get("/management/items/:source/:sourceItemId/metadata-versions", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try { return await listMetadataVersionRecords(params.source, params.sourceItemId); }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.post("/management/items/:source/:sourceItemId/metadata-versions/:versionId/default", async (request, reply) => {
    const params = parseVersionParams(request.params);
    try { return await makeMetadataVersionDefaultRecord(params.source, params.sourceItemId, params.versionId); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/management/items/:source/:sourceItemId/metadata-versions/:versionId", async (request, reply) => {
    const params = parseVersionParams(request.params);
    try { return await deleteMetadataVersionRecord(params.source, params.sourceItemId, params.versionId); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/items/:source/:sourceItemId/annotations", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try { return await getAnnotationGraphRecord(params.source, params.sourceItemId); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/items/:source/:sourceItemId/packages", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = createGraphPackageSchema.parse(request.body);
    try { return reply.code(201).send(await createGraphPackageRecord(params.source, params.sourceItemId, body)); }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.post("/management/items/:source/:sourceItemId/packages/:packageId/labels", async (request, reply) => {
    const params = parseGraphParams(request.params);
    const body = createGraphLabelSchema.parse(request.body);
    try { return reply.code(201).send(await createGraphLabelRecord(params.source, params.sourceItemId, params.entityId, body)); }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.post("/management/items/:source/:sourceItemId/packages/:packageId/labels/review", async (request, reply) => {
    const params = parseGraphParams(request.params);
    const body = reviewGraphLabelCandidatesSchema.parse(request.body);
    try { return reply.code(201).send(await reviewGraphLabelCandidatesRecord(params.source, params.sourceItemId, params.entityId, body)); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/items/:source/:sourceItemId/packages/:packageId/ocr", async (request, reply) => {
    const params = parseGraphParams(request.params);
    try { return await getGraphPackageOcrRecord(params.source, params.sourceItemId, params.entityId); }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.post("/management/items/:source/:sourceItemId/labels/:labelId/ocr", async (request, reply) => {
    const params = parseGraphParams(request.params);
    const body = createGraphOcrSchema.parse(request.body);
    try { return reply.code(201).send(await createGraphOcrRecord(params.source, params.sourceItemId, { type: "label", id: params.entityId }, body)); }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.post("/management/items/:source/:sourceItemId/annotation/helpers/ocr/run", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = runAutoOcrSchema.parse(request.body);
    try { return reply.code(201).send(await runGraphAutoOcrRecord(params.source, params.sourceItemId, body)); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/items/:source/:sourceItemId/annotation/helpers/label-rectification/run", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = runLabelRectificationSchema.parse(request.body);
    try { return reply.code(201).send(await runGraphLabelRectificationRecord(params.source, params.sourceItemId, body)); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/items/:source/:sourceItemId/annotation/helpers/package/run", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = runPackageDetectionSchema.parse(request.body);
    try { return reply.code(201).send(await runGraphPackageDetectionRecord(params.source, params.sourceItemId, body)); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/items/:source/:sourceItemId/annotation/helpers/ocr/review", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = reviewAutoOcrSchema.parse(request.body);
    try { return await reviewGraphAutoOcrRecord(params.source, params.sourceItemId, body); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/items/:source/:sourceItemId/annotation/helpers/ocr/review-actions", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = reviewAutoOcrActionsSchema.parse(request.body);
    try { return await reviewGraphAutoOcrActionsRecord(params.source, params.sourceItemId, body); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/items/:source/:sourceItemId/annotation/ocr/dedupe-preflight", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = manualOcrDedupePreflightSchema.parse(request.body);
    try { return reply.code(201).send(await runManualOcrDedupePreflightRecord(params.source, params.sourceItemId, body)); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/items/:source/:sourceItemId/annotation/ocr/:ocrId/reparent", async (request, reply) => {
    const params = parseOcrActionParams(request.params);
    const body = reparentGraphOcrSchema.parse(request.body);
    try { return await reparentGraphOcrRecord(params.source, params.sourceItemId, params.ocrId, body); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/items/:source/:sourceItemId/annotation-meta", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = createGraphMetaSchema.parse(request.body);
    try { return reply.code(201).send(await createGraphMetaRecord(params.source, params.sourceItemId, body)); }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.delete("/management/items/:source/:sourceItemId/annotation-entities/:entityType/:entityId", async (request, reply) => {
    const params = parseDeleteGraphParams(request.params);
    try { return await deleteGraphEntityRecord(params.source, params.sourceItemId, params.entityType, params.entityId); }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.patch("/management/items/:source/:sourceItemId/annotation-entities/:entityType/:entityId", async (request, reply) => {
    const params = parseDeleteGraphParams(request.params);
    const body = parseGraphEntityUpdate(params.entityType, request.body);
    try { return await updateGraphEntityRecord(params.source, params.sourceItemId, params.entityType, params.entityId, body); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/metadata", async (request) => {
    const query = listMetadataQuerySchema.parse(request.query);
    return listMetadataRecords(query);
  });

  app.get("/management/metadata/:source/:sourceItemId/annotations", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try {
      return await getManualAnnotationRecord(params.source, params.sourceItemId);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.put("/management/metadata/:source/:sourceItemId/annotations", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = manualAnnotationsSchema.parse(request.body);
    try {
      return await putManualAnnotationRecord(params.source, params.sourceItemId, body);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/management/metadata/:source/:sourceItemId/annotations", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try {
      return await deleteManualAnnotationRecord(params.source, params.sourceItemId);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/metadata/:source/:sourceItemId/label-annotation", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try {
      return await getLabelAnnotationRecord(params.source, params.sourceItemId, parseTrack(request.query));
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.put("/management/metadata/:source/:sourceItemId/label-annotation", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = labelAnnotationSchema.parse(request.body);
    try {
      return await putLabelAnnotationRecord(params.source, params.sourceItemId, parseTrack(request.query), body);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/metadata/:source/:sourceItemId/label-annotation/proposal", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = detectionProposalSchema.parse(request.body);
    try {
      return await putDetectionProposalRecord(params.source, params.sourceItemId, parseTrack(request.query), body);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/metadata/:source/:sourceItemId/label-annotation/analysis/review", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try {
      const review = await getLabelAnalysisReviewRecord(params.source, params.sourceItemId, parseTrack(request.query));
      return review ?? reply.code(404).send({ error: "Label analysis review not found" });
    }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.get("/management/metadata/:source/:sourceItemId/annotation-tracks", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try { return await listAnnotationTrackRecords(params.source, params.sourceItemId); }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.post("/management/metadata/:source/:sourceItemId/annotation-tracks", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = createAnnotationTrackSchema.parse(request.body ?? {});
    try {
      const track = await createAnnotationTrackRecord(params.source, params.sourceItemId, body);
      const actor = annotationRequestActor(request.headers);
      if (actor) await recordAnnotationTrackActor(track.id, actor);
      return reply.code(201).send(track);
    }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.get("/management/metadata/:source/:sourceItemId/label-annotation/analysis", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try { return await getLabelAnalysisWorkspaceRecord(params.source, params.sourceItemId, parseTrack(request.query)); }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.post("/management/metadata/:source/:sourceItemId/label-annotation/analysis/run", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = labelAnalysisRunSchema.parse(request.body ?? {});
    try { return await runLabelAnalysisRecord(params.source, params.sourceItemId, parseTrack(request.query), body); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/metadata/export/manual", async (request, reply) => {
    const query = manualMetadataExportQuerySchema.parse(request.query);
    const payload = await exportManualMetadataRecords(query.source);
    reply.header("Content-Disposition", `attachment; filename="manual-metadata-${query.source ?? "all"}.json"`);
    return payload;
  });

  app.post("/management/metadata/:source/:sourceItemId/label-annotation/source-analysis/run", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = sourceAnalysisRunSchema.parse(request.body ?? {});
    try { return await runSourceAnalysisRecord(params.source, params.sourceItemId, parseTrack(request.query), body); }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.put("/management/metadata/:source/:sourceItemId/label-annotation/source-analysis", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = sourceAnalysisStateSchema.parse(request.body);
    try { return await putSourceAnalysisRecord(params.source, params.sourceItemId, parseTrack(request.query), body); }
    catch (error) { if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message }); throw error; }
  });

  app.delete("/management/metadata", async (request, reply) => {
    const body = deleteMetadataItemsSchema.parse(request.body);
    try {
      return await deleteMetadataRecords(body.items);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/metadata/:source/:sourceItemId/label-annotation/analysis/cv-preview", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = labelCvJobPreviewSchema.parse(request.body);
    const scope = parseTrackScope(request.query);
    try { return await previewLabelCvJobRecord(params.source, params.sourceItemId, scope.track, body, scope.label); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.put("/management/metadata/:source/:sourceItemId/label-annotation/analysis/cv-checkpoint", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = labelCvJobCheckpointSchema.parse(request.body);
    const scope = parseTrackScope(request.query);
    try { return await putLabelCvJobCheckpointRecord(params.source, params.sourceItemId, scope.track, body, scope.label); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/metadata/:source/:sourceItemId/label-annotation/analysis/cv-job", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const scope = parseTrackScope(request.query);
    if (!scope.label) return reply.code(400).send({ error: "label query is required for canonical Label CV workspace" });
    try { return await getCanonicalLabelCvWorkspaceRecord(params.source, params.sourceItemId, scope.track, scope.label); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.put("/management/metadata/:source/:sourceItemId/label-annotation/analysis/cv-job", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = labelCvJobReviewSchema.parse(request.body);
    const scope = parseTrackScope(request.query);
    try { return await putLabelCvJobRecord(params.source, params.sourceItemId, scope.track, body, scope.label); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.put("/management/metadata/:source/:sourceItemId/label-annotation/analysis/review", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = labelAnalysisReviewSchema.parse(request.body);
    try { return await putLabelAnalysisReviewRecord(params.source, params.sourceItemId, parseTrack(request.query), body); }
    catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/metadata/:source/:sourceItemId/label-annotation/proposals", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try {
      return await listDetectionProposalRecords(params.source, params.sourceItemId, parseTrack(request.query));
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/metadata/:source/:sourceItemId/label-annotation/ocr", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try {
      return await getLabelAnnotationOcrRecord(params.source, params.sourceItemId, parseTrack(request.query));
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/metadata/:source/:sourceItemId/label-annotation/ocr/run", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try {
      return await runLabelAnnotationOcrRecord(params.source, params.sourceItemId, parseTrack(request.query));
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof Error && (error.message === "No label bbox available for OCR" || error.message === "No local image available for OCR")) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/management/metadata/:source/:sourceItemId/label-annotation/ocr/review", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try {
      return await getLabelAnnotationOcrReviewRecord(params.source, params.sourceItemId, parseTrack(request.query));
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.put("/management/metadata/:source/:sourceItemId/label-annotation/ocr/review", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = ocrTextReviewSchema.parse(request.body);
    try {
      return await putLabelAnnotationOcrReviewRecord(params.source, params.sourceItemId, parseTrack(request.query), body);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/metadata/:source/:sourceItemId/label-annotation/ocr/regions/review", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try {
      const review = await getLabelAnnotationOcrRegionReviewRecord(params.source, params.sourceItemId, parseTrack(request.query));
      return review ?? reply.code(404).send({ error: "OCR region review not found" });
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.put("/management/metadata/:source/:sourceItemId/label-annotation/ocr/regions/review", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = ocrRegionReviewSchema.parse(request.body);
    try {
      return await putLabelAnnotationOcrRegionReviewRecord(params.source, params.sourceItemId, parseTrack(request.query), body);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/metadata/:source/:sourceItemId/label-annotation/ocr/source-associations", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try {
      return await getOcrSourceAssociationWorkspace(params.source, params.sourceItemId, parseTrack(request.query));
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.put("/management/metadata/:source/:sourceItemId/label-annotation/ocr/source-associations", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = ocrSourceAssociationReviewSchema.parse(request.body);
    try {
      return await putOcrSourceAssociationReviewRecord(params.source, params.sourceItemId, parseTrack(request.query), body);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/metadata/:source/:sourceItemId/label-annotation/catalog-identity", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try {
      return await getCatalogIdentityReviewRecord(params.source, params.sourceItemId, parseTrack(request.query));
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.put("/management/metadata/:source/:sourceItemId/label-annotation/catalog-identity", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = catalogIdentityReviewSchema.parse(request.body);
    try {
      return await putCatalogIdentityReviewRecord(params.source, params.sourceItemId, parseTrack(request.query), body);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/metadata/:source/:sourceItemId/label-annotation/aliases", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try {
      return await getAliasReviewWorkspace(params.source, params.sourceItemId, parseTrack(request.query));
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.put("/management/metadata/:source/:sourceItemId/label-annotation/aliases", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = aliasReviewSchema.parse(request.body);
    try {
      return await putAliasReviewRecord(params.source, params.sourceItemId, parseTrack(request.query), body);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/metadata/:source/:sourceItemId", async (request, reply) => {
    const params = parseSourceParams(request.params);
    try {
      return await getMetadataSandbox(params.source, params.sourceItemId);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.patch("/management/metadata/:source/:sourceItemId", async (request, reply) => {
    const params = parseSourceParams(request.params);
    const body = patchMetadataSchema.parse(request.body);
    try {
      return await patchMetadataRecord(params.source, params.sourceItemId, body);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });
}

function parseSourceParams(params: unknown) {
  const value = params as { source?: string; sourceItemId?: string };
  return {
    source: sourceNameSchema.parse(value.source),
    sourceItemId: String(value.sourceItemId ?? ""),
  };
}

function parseTrack(query: unknown) {
  return annotationTrackQuerySchema.parse(query).track;
}

function parseTrackScope(query: unknown) {
  return annotationTrackQuerySchema.parse(query);
}

function parseGraphParams(params: unknown) {
  const value = params as { source?: string; sourceItemId?: string; packageId?: string; labelId?: string };
  return { ...parseSourceParams(value), entityId: zUuid(value.packageId ?? value.labelId) };
}

function parseDeleteGraphParams(params: unknown) {
  const value = params as { source?: string; sourceItemId?: string; entityType?: string; entityId?: string };
  return { ...parseSourceParams(value), entityType: graphEntityTypeSchema.parse(value.entityType), entityId: zUuid(value.entityId) };
}

function parseOcrActionParams(params: unknown) {
  const value = params as { source?: string; sourceItemId?: string; ocrId?: string };
  return { ...parseSourceParams(value), ocrId: zUuid(value.ocrId) };
}

function parseVersionParams(params: unknown) {
  const value = params as { source?: string; sourceItemId?: string; versionId?: string };
  return { ...parseSourceParams(value), versionId: zUuid(value.versionId) };
}

function zUuid(value: unknown) {
  return annotationTrackQuerySchema.shape.track.parse(value);
}
