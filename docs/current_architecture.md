# Current Architecture

Status: current architecture
Scope: service, data and UI architecture
Last verified against code: 2026-09-03

## Card-level LLM session

**Implemented additively (migration 049):** one annotation card/track owns one open DB `LLMSession`; provider history is a secondary transport. The session stores provider/conversation binding, model/prompt/adapter/wizard versions, compact canonical context and append-only context events. Every `LLMStageRun` stores its compact input-context snapshot, visual artifact references, decisions, provider response/request IDs, usage and latency. `human_required` changes the session to `blocked`, not `failed`; a later successful stage or applied LLM plan returns it to `active`. Applying a plan records a compact `stage_completed` event. Qwen supports the existing stateless Chat transport and an opt-in Responses/Conversations transport. In Responses mode the provider Conversation is initialized eagerly with the local session and reused by every stage; stage execution also retains a lazy recovery fallback. This transport requires an Alibaba workspace-specific base URL. Every turn still contains a fresh visual StageObservation and bounded policy; database state remains authoritative.

This document describes the current local VineDetect stack after the split between generated detection proposals and reviewed human annotations.

## Canonical Annotation Graph And Legacy Editor Tracks

**Implemented additively (migrations 030, 041 and 042, graph v9):** the persisted reviewed domain is no longer defined by wizard stage names. Its canonical hierarchy is strictly `Item -> Package[] -> Label/VisualRegion[] -> OCR[]`. A Label is an independent visual/design marking region and does not imply a physical sticker; it may contain only text, only graphics or both. Direct package-owned OCR is superseded. VisualRegion semantics are independently reviewable (`physical-label`, `direct-print`, `text-only`, `graphic-only`, `mixed`, `other`, `unknown`). `Meta` can attach to Item, Package, Label or OCR. `meta.annotation_operations` and candidates remain immutable helper/review evidence. Derived `reviewOperations` explicitly connects helper observations to canonical results for structural corrections such as candidate merge.

Migration `041` wraps every historical direct Package OCR in a minimal synthetic Label using the original OCR quad. Such a region has `origin = migrated_from_direct_ocr`, `geometryReviewStatus = suggested` and `status = draft`: it preserves OCR training data but is excluded from reviewed Label/VisualRegion detector GT until a human reviews its ROI. New OCR rows require `label_id`; Auto OCR and manual OCR accept only Label scope, while dedupe still searches across all Labels of the same Package and `reparent_ocr` moves identity only between those Labels. The deprecated `packages[].ocr` response field is retained as an always-empty compatibility field in v7.

**Implemented Package semantic split (migration 038, graph v6):** `Package.scope` is only the working crop/helper input. `null` means the complete source image; its provenance is `default-full-image | auto | human | legacy-unclassified`, and export marks it `trainingRole: helper-input`. `Package.objectContext` is the separately reviewed physical-object contour produced by the compatibility Bottle/Object Context smart-lasso stage and is the segmentation target only when `status = reviewed`. `Package.packageType` is the deliberately small taxonomy `bottle | tube | box | other | unknown` and becomes classification ground truth only when its status is reviewed. The old `Package.geometry` response field remains a deprecated alias for `scope.geometry`; canonical manual export removes that alias and states the three export policies explicitly.

**Implemented Package wizard stage (migration 039):** the workflow is now `Package -> Label -> Object Context -> OCR -> Mask -> Morphology -> Components -> Elements -> Contours -> Palette -> Summary`. Stage 1 is the single UI owner of Package crop editing; the generic entity constructor no longer contains duplicate crop controls. Full image remains a saved/valid default. The helper/stage union and new aggregate exports contain eleven ordered stage samples; older frozen snapshots are not rewritten.

**Implemented branch-aware entity navigation:** Package owns Scope, Object Context, package type and Package Meta. The selected Label/VisualRegion owns ROI, OCR and every Mask-to-Palette state. There is no Direct OCR action or Package/Label parent selector. A small marking such as one glass-printed word is represented by a minimal Label containing one OCR region. Changing Label geometry increments only that Label revision and invalidates only its crop/CV state.

**Implemented Label-scoped CV persistence (migration 040):** `meta.annotation_labels.revision`, `cv_crop` and `cv_job` bind the complete crop-CV chain to one canonical Label. `GET .../label-annotation/analysis/cv-job?track=<track>&label=<label>` hydrates the selected Label workspace; preview, checkpoint and final CV writes accept the same `track + label` scope. The server creates a deterministic rectified crop for the current Label revision, reads reviewed graph OCR as overlay input and persists Mask/Morphology/Components/Elements/Contours/Palette checkpoints only on that Label. Frozen schema-v5 graph snapshots include this state, and task adapter v3 emits Label-scoped `label-elements` and `label-palette` samples from reviewed data. **Partially implemented:** canonical Label checkpoints currently retain their execution snapshots under `label.cv.job.workflow`; they are not additionally inserted into the legacy track-and-stage-keyed `meta.wizard_stage_executions`, because that table cannot represent multiple Labels on one track without collisions.

**Implemented persistent interactive Summary:** item composition is visible throughout the wizard. It presents Package Scope/Object Context and every Label-owned ROI/OCR/Mask/Morphology/Components/Elements/Contours/Palette checkpoint; no separate Direct OCR node exists.

Recognize exposes graph CRUD under `/management/items/:source/:sourceItemId/...`; Swagger groups these operations under `Annotation Graph`. The Next BFF mirrors the hierarchy under `/api/admin/recognition/items/...`. `GET .../annotations` returns nested current entities and a separate flat `operations` array. Add, edit and delete are implemented; OCR enforces canonical convex quad geometry and independently stores region review, transcription/readability and layout state.

**Implemented Label-scoped Auto OCR (migration 041 supersedes the Package branch from migration 032):** `auto-ocr` accepts `{ type: label, id }`, rectifies that VisualRegion and produces only Label-owned candidates. The canonical OCR workspace begins with a Label-wide `Perspective / Cylindrical` normalization review: it edits the four source-space Label corners or guided cylindrical grid, previews the complete corrected Label and persists `Label.rectification` before any OCR candidate is requested. The optional `label-rectification / cv-label-rectification-v1` CV helper runs on a bounded preview before OCR, always retains the reviewed Label as an `Original` control and may suggest a directional-edge Perspective quad with confidence, retained-area, displacement and distortion diagnostics. It then searches the perspective-normalized crop for repeated, consistently curved horizontal evidence. Strong evidence produces a separate `Cylindrical` candidate with generated guides, signed curvature and evidence-row diagnostics; weak or contradictory evidence produces no cylindrical candidate. It never mutates canonical geometry automatically: selection and subsequent corner or guide edits are committed through the same Label editor and retained as accepted/edited operation evidence. The LLM OCR runner treats normalization as an explicit first phase with candidate previews; its validated Label edit is applied before the orchestrator invokes OCR again against the accepted full-label transform. One immutable `run_ocr` Operation still owns the normalized config and all OCR candidates; its viewer and every `label-rectified` OCR coordinate space are bound to the exact `Label.revision`. Changing Label geometry/rectification increments that revision, clears its CV state and makes older OCR viewers/regions stale rather than overlaying them on a different crop. Review records `accepted | edited | rejected | merged`. Dedupe remains Package-wide, so observations from overlapping Labels can merge to one canonical OCR identity. Final ownership is always one concrete Label and may later move only to another Label of the same Package.

The generic endpoints are `POST .../annotation/helpers/ocr/run`, `POST .../annotation/helpers/ocr/review` and the aggregate `GET .../packages/:packageId/ocr`. The last route returns OCR grouped by Labels; its deprecated `direct` field is always empty. The former `POST .../packages/:packageId/ocr` route is removed from runtime and Swagger. The shared quad editor restores unfinished Label-scoped review after refresh.

**Implemented OCR deduplication/merge (migration 033):** after parent suggestion, a separate matcher compares every candidate only with active canonical OCR entities in the same Package. `labelId` is intentionally not part of the dedupe key. Matching combines configurable bbox geometry/containment and normalized Levenshtein text scores and emits `probable_duplicate | possible_duplicate | overlapping`; missing transcription may produce only a reviewable geometry-based suggestion. The UI requires an explicit `Merge | Keep separate | Changed | Reject` decision. Merge does not create or mutate an OCR entity: it stores candidate review state `merged`, points its result at the existing stable OCR id and keeps both Operations/Candidates as separate observations. Canonical parent, transcription and geometry win by default; any later correction is a separate `edit_ocr` Operation. Canonical export therefore contains one OCR entity, while operation traces retain every positive repeated detection for helper training.

**Compatibility boundary:** `AnnotationTrack` is still the stable selector and state container used by the existing eleven-stage wizard. Each active track has one linked canonical Package. Package geometry is the track's spatial working scope, not the Bottle Context contour: `geometry = null` canonically means the complete source image, while a reviewed quad/polygon narrows the working area without changing the source asset or child source-image coordinates. Saving legacy Label and reviewed OCR synchronizes their canonical entities; Bottle Context stays stage evidence and no longer overwrites Package geometry. The item UI labels track selectors as Packages, shows canonical child counts/operation traces and includes an entity constructor for additional source-space Label quads, scope-aware OCR and Package/Label Meta. Wizard-managed primary Labels are explicitly edited only in the Label stage so graph CRUD cannot create a second source of truth. Existing stage tables remain adapters and execution evidence; they are not the target domain model and are not removed by migration 030.

## Annotation Tracks

**Implemented:** catalog identity and visual annotation are no longer forced into a one-to-one relation. The canonical cardinality is `Item 1 -> N AnnotationTracks`, and every track is one complete independent wizard (`Label -> Bottle Context -> OCR -> ... -> Summary`). Tracks may reuse the same source asset, but do not share reviewed ROI, helper runs/candidates, OCR/CV state, revisions, review state or completion status.

`meta.annotation_tracks` owns the stable UUID, ordinal, display name, optional source asset/target region and lifecycle status. `meta.annotation_track_states` owns the track-scoped JSON state formerly read from `meta.items.visual_features/annotations`. Revisioned wizard tables and generation jobs carry `annotation_track_id`; migration `028` backfills one primary track per existing annotated item, while migration `029` normalizes deterministic backfill IDs to RFC-valid UUIDs. Catalog fields, aliases and source identity remain item-scoped.

All annotation-wizard management routes require `?track=<annotationTrackId>`. Track discovery/creation is explicit through `GET|POST /management/metadata/:source/:sourceItemId/annotation-tracks`; the Next BFF forwards the same query. The canonical browser URL is `/admin/recognition/{source}/{sourceItemId}?section=annotation&track={uuid}`. The item page creates a primary track only when none exists. One track is rendered without a selector, two as explicit buttons, and three or more through a dropdown. Recognition inventory rows expose the same track list.

The live manual JSON export is graph-first schema v5: `items[]` contains one nested schema-v6 entity graph per catalog item without operation history, `operationTraces[]` contains provenance separately, and `legacyTracks[]` retains the previous track-scoped payload during migration. The root reports both distinct `itemCount` and `annotationTrackCount`. Frozen cohort selection remains item-key based, but new frozen snapshot schema v5 now stores the complete current annotation graph for every selected item.

## Reviewed-ROI Analysis: Audited Current State And Target

Audit verified against code on 2026-08-21.

### Current implementation

1. manual `label-bbox` revisions in `meta.image_annotations` are canonical ground truth;
2. `ANALYZE_LABEL` is bound to an exact reviewed annotation id/revision and supports one item or an explicit checked-item batch;
3. the V2 worker persists the exact reviewed crop under `asset-store/label-analysis/` and does not run label detection;
4. the same job runs the server-owned Tesseract cascade, persists consensus line/word regions plus versioned pass/observation evidence, computes source-data match candidates and extracts a compact palette, quality metrics and crop-boundary contours;
5. the composite V2 result is stored in the selected `meta.annotation_track_states.visual_features.labelAnalysis`; its generated OCR run is linked both to the job and annotation track;
6. an immutable `meta.label_analysis_reviews` revision accepts, rejects or marks one exact job/config result as needing tuning;
7. the item-level workspace is exposed through aggregate `GET .../label-annotation/analysis` and specialized `POST .../label-annotation/analysis/run` endpoints;
8. crop-local CV preview is separated from persisted wizard state: non-persisting `POST .../analysis/cv-preview` recalculates masks, contours and detected palette without rerunning OCR; `PUT .../analysis/cv-checkpoint` approves and stores each Mask-Palette stage in the selected track state; heavy RLE debug layers are stored as a referenced `label-analysis/.../*-cv-debug.json` asset and hydrated only in the analysis workspace; `PUT .../analysis/cv-job` remains the final Palette/Summary save;
9. the aggregate workspace returns a Summary recalculated from the latest reviewed OCR regions/source associations plus the current reviewed palette and contour preview. Saving a new reviewed OCR-region revision reloads this workspace and the current-item association workspace, so corrected strings are rematched against source fields and the cross-item catalog without rerunning OCR or CV. Association/catalog decisions bound to an older region-set id remain immutable history but are stale and excluded from current fixed links.

The Label Annotation screen now implements `Label -> Bottle Context -> OCR -> Mask -> Morphology -> Components -> Elements -> Contours -> Palette -> Summary`. The shared source canvas is used by Label and Bottle Context; later analysis stages use the reviewed-label crop. OCR has one source in this workflow: the current detector-free `ANALYZE_LABEL` result. It uses one editable crop workspace rather than separate viewer/editor canvases: boxes move/resize/draw there, text is editable inline, and clicking a region row or its canvas bbox selects the same object and opens the same type/text/status/provenance/bbox editor. Source/catalog list hover highlights that box. Exact reviewed-word to source-token matches are preselected as an unsaved association draft; explicit save remains the human ground-truth boundary. There is no analysis/standalone source switch, browser OCR button, direct backend OCR button, aggregate OCR textarea or separate OCR-text save in the wizard. Saving a reviewed region revision atomically derives the aggregate reviewed OCR text revision, so the dataset/export contract remains populated without duplicate UI. When current analysis is absent or stale, the step offers `Run label analysis`. Source matching exposes both full field values and token candidates so word regions are not penalized solely against an entire long title. Cascade diagnostics remain collapsed and read-only. Six label-crop CV/review stages use semantic controls and a debounced crop-local preview; Label Palette supports removal and eyedropper additions; Summary uses the shared stage viewer with switchable CV/OCR overlays and saves/reloads `labelCvJob`. CV Lab retains label-detector presets, candidate scoring, sweep and full-image detector tuning.

### Target contract

The main annotator flow is:

```text
source image
  -> manual reviewed label ROI
  -> save annotation
  -> label-analysis job (no label detection)
  -> OCR + text regions + normalization + source matching + visual features
  -> human review
  -> save and next
```

OpenCV detector preview, masks, candidate scoring, presets and sweep remain in CV Lab. Label Analysis operates inside an already known reviewed ROI and may use image-processing primitives for palette, contours or OCR preprocessing, but it must not run label detection. Advanced OCR/image tuning is a problem-case escape hatch, not the default annotation surface.

Stage 1 has an optional source-level label helper. `POST .../label-annotation/source-analysis/run` accepts `labelConfig: AutoLabelConfigV1` plus the active track's optional `packageScope`, and returns the normalized exact config, low-resolution debug geometry and ranked label candidates without writing ground truth. With the default full-image Package no spatial filter is applied; with a narrowed Package, candidates must substantially overlap its source-image bbox. The same scope is included in stage execution input and also filters Bottle candidates, so a second object in the shared source image is not offered to the active Package. Label is a collection-stage: with zero regions it offers `Auto detect` and `Draw Label` without creating an empty Label entity; one helper run scans the Package and its candidates are reviewed together. `POST .../packages/:packageId/labels/review` records accepted, edited, rejected or merged state for every candidate and may create `0..N` canonical Labels in one multi-result operation. At review commit, intersecting accepted candidates are automatically reduced to one canonical Label; separated fragments may be explicitly connected with a review-only `mergeGroupId`. The server derives the enclosing rectangular quad and persists every member review against the same `finalLabelId`, while `helper_output.labelMergeGroups` retains members, mode and resulting geometry. This candidate-to-candidate merge is distinct from dedupe with an existing Label: `state=merged + resultEntityId` preserves the existing canonical geometry. Manual drawing creates the same canonical Label type but with manual provenance. After creation the shared viewer shows all Label regions, while selection chooses the branch edited by OCR and Label-owned CV stages. The existing full-resolution quad editor remains constrained to Package bounds. `label-multi-family-consensus-v4` runs bounded low-resolution proposal generators and aggregates them in two steps: repeated neutral/RGB passes become one COLOR vote, repeated grayscale-boundary passes become one EDGE vote, and a Canny-component text-density envelope may contribute one low-weight TEXT vote. Presets inside one family improve its stability but never count as independent confirmation. Cross-family matching accepts both IoU and containment, fusion downweights the usually smaller text envelope, and every Top-K proposal exposes family support, spatial agreement, semantic evidence, geometry prior, confidence and exact contributors. Stable internal boxes remain evidence instead of standalone Label ROI. Each recalculation starts one helper execution containing the exact config and candidate set. It is typed-pixel processing through Sharp, not an OpenCV binding.

Label ROI persistence uses schema v2 with an explicit `prediction` / `annotation` boundary and migrations `026`/`027`. Canonical geometry is `geometry = { type: "quad", points: [TL, TR, BR, BL], bbox }`: four points in source-image pixels form a convex, non-self-intersecting quad with fixed winding, while `roi/bbox` is always its derived enclosing rectangle retained for compatibility. `prediction.helperRunId + prediction.candidateId` identifies the exact immutable helper run and candidate selected by the annotator; that run owns the config and full candidate set. `prediction.geometry`, confidence and `algorithm { id, version, params, defaultParams? }` retain a self-contained snapshot of the selected helper result and config. The shared canvas starts with a rectangle and lets the annotator drag any of its four corners; Save/Continue creates `annotation.geometry`. `Crop preview` projectively rectifies the current working quad, so it previews the same geometry that label-analysis and standalone backend OCR consume. Both OCR entry points persist `meta.label_crops.geometry`, emit it in the OCR snapshot/StageSample input and recognize the rectified crop rather than the enclosing bbox. A manual ROI has `prediction = null` and therefore no selection. `reviewed`, `labelRoiGt`, `roiEdited`, `source = auto | corrected | manual` and IoU are derived by the server/exporter and are not operator-controlled fields. The reviewed revision links to its exact prediction through `suggestion_id`; a later helper run cannot silently replace that provenance. Existing bbox-only rows and schema-v1 compatibility JSON normalize to rectangular quads on read/backfill.

After the reviewed label is saved, Stage 2 is presented as **Object Context** while retaining compatibility stage/API keys named `bottle`. It runs `bottle-border-flood-v1` against the source image with that label as an immutable anchor. It samples the source border colour, adds proportional padding, converts candidate pixels to Lab and flood-fills background from all padded border seeds while visual distance remains within the configured tolerance. The background mask is inverted, a fixed small close removes holes, and foreground connected components are ranked by area; the largest component containing most of the reviewed label becomes the physical-package candidate. Its ordered external boundary is canonical `rawContour`, while `simplifiedContour` is the smoothed `approxPolyDP`-style representation. Accepting it writes the inspected shape into `Package.objectContext`, never into Package scope. Connectivity is explicitly selectable as 4 or 8 neighbours. Canny is available in preview as a diagnostic overlay and is used lazily at full resolution only when the baseline border flood yields no acceptable component. Bézier generation and editing are not part of Stage 2. Object Context renders the source inside the same visible margin, and background/foreground/closed-mask/contour overlays share that padded transform.

Bottle contour calculation retains `preview` and `final` execution modes at the API level, but the annotation wizard uses `preview` as the reviewed result. Preview downsizes the source to a configurable maximum side (420 px by default), returns diagnostic rasters and converts candidate raw/smoothed contours back into source-image coordinates. Accept persists exactly those displayed coordinates and the curated palette; it does not rerun nonlinear flood-fill or palette extraction on a different raster. `final` remains an advanced/compatibility operation and is not an implicit annotation action. Candidate telemetry, config, raw/simplified evidence and editable Bottle Context palette are persisted under `visualFeatures.labelSourceAnalysis`; transient preview rasters are not persisted.

The Mask/Morphology/Components/Elements/Contours/Palette controls are not label-detector controls. They use bounded per-item `LabelAnalysisCvConfig` v3 applied only to the reviewed crop. Binary-mask value `1` consistently means foreground. Morphology defaults to Auto, tries a fixed bounded candidate set and scores downstream component topology; Manual exposes exact operation/kernel/iterations under Advanced. Its viewer shows added/removed/unchanged foreground as green/red/white. Components expose semantic noise presets plus optional exact area ratios. Their review UI keeps separate Accepted and Rejected lists: the canvas/list cross is a reject action rather than physical deletion, rejected candidates can be restored or batch-accepted, and a dedicated overlay toggle hides them on the canvas by default. Continue persists the accepted/rejected decision delta; downstream Elements use only accepted components.

Elements implement a two-level canonical model without a separate Group entity. Components remain atomic geometric observations and are never physically fused. Every reviewed component belongs to exactly one Element; an Element with one component is a valid singleton, while an unassigned component means unfinished review and blocks continuation. OCR-line coverage is the primary membership proposal and proximity/alignment is the fallback. The Element stores membership, a derived union bbox, optional OCR relation, visual `type = text | graphic | separator | shape | unknown`, independent semantic `role = brand | product_name | variety | producer | year | description | logo | signature | ornament | separator | unknown | other`, review status and schema-v4 `provenance`. `provenance.source = manual | ocr | geometry | model | imported` records the decision/hypothesis source. OCR-derived Elements use `provenance.sourceRef = { kind: "ocr-region", id }`; recognition confidence remains on the referenced region. Optional `provenance.grouping.method = manual | ocr-overlap | proximity | containment | alignment | model` independently records the membership algorithm and `provenance.grouping.confidence` records its score. Legacy detailed type values, element-level `textRegionId`/`confidence`, `groupingMeta`, top-level `provenance.confidence`, and the early `provenance.method` shape remain accepted as compatibility input and normalize on the next save. Contours remain one real raw/simplified contour per member component and share `elementId`; together they are a MultiPolygon-like derived representation, not an artificial enclosing polygon. Dataset exporters choose bbox, component contours or a composite representation for a trainer without changing canonical ground truth. These fields remain in the existing JSON Meta contract, so no DB migration is required.

Debounced trial previews remain non-persisting. Continue/approval writes a stage checkpoint with its config/review input signature to the existing JSON Meta field; changing an upstream input marks dependent saved checkpoints stale instead of silently presenting them as current. The wizard restores the first missing/stale stage after refresh, while direct navigation remains available with a dependency warning.

New frozen dataset versions use schema v5. Existing label/OCR/source/catalog keys remain present for compatibility, while `annotationGraph` freezes every Package, Label, parent-scoped OCR, Meta entity and immutable operation trace in the same repeatable-read transaction. `vision.annotations` contains reviewed bottle state/palette, component decisions, reviewed elements, their derived contours and reviewed label palette. `vision.cvMeta` contains the CVJOB config, auto/effective morphology configs and score, machine component/element proposals and raw contour evidence. Helper Config Contract v1 additionally stores one normalized record for every wizard stage under `vision.cvMeta.helpers`. Task adapter v3 expands one catalog item into multiple canonical `label-roi`, `ocr-region` and `bottle-outline` samples when multiple Packages/Labels exist; legacy source-matching, alias and Label-CV adapters remain compatible. Helper config never becomes a visual ground-truth target. Existing frozen schema-v1 through v4 snapshots remain immutable and readable.

Helper Config Contract v1 is not itself the canonical execution unit. `StageSampleV1 = card/stage + stageInput + helper identity + helper runs + selection + proposal metadata + final review` is implemented as a domain adapter contract for all eleven stages. Individual Swagger operations return `stageSample`; aggregate workspace and export paths return ordered `stageSamples[11]`. Migration `024` adds revisioned `meta.wizard_stage_executions`; migration `025` adds immutable `meta.wizard_helper_runs` and the unified `selectedRunId + selectedCandidateId + reviewMode` decision. Migration `044` adds persisted operational `meta.annotation_correction_plans`; their full ProposedOutput is used for validation/replay but is not a third canonical StageSample content state. `initialParams/autoOutput` remain immutable helper evidence and `finalParams/reviewedOutput/humanCorrection` remain the accepted boundary. Proposal metadata carries executor/plan identity and, for LLM, the compact decision/review evaluation introduced by migration `047`. Historical rows remain readable with explicit unavailable values where evidence cannot be reconstructed.

The item UI exposes the same ordered `StageSampleV1` records through a read-only Execution Trace in Summary and Metadata. Each stage expands into its immutable runs, config, candidates, auto output, selected run/candidate, review mode, correction fields and final reviewed boundary; the complete trace can be copied independently from the legacy raw Meta JSON.

**Implemented headless Wizard boundary:** `GET /management/annotation-workflow` exposes the ordered eleven-stage contract and canonical command vocabulary. Stage guide/state and command routes validate Package/Label scope, prerequisites, ownership and canonical payloads. Deterministic helpers run synchronously or as persisted jobs without silently promoting candidates to GT. Correction plans retain executor, interaction mode, ProposedOutput and ordered Wizard operations; apply claims the plan once and replays it through the same executor. `executor = human | llm | local_ml | system` identifies who proposed the change, while `interactionMode = auto | manual | mixed` independently records how the proposal relates to helper output. Migration `046` persists both axes. For LLM plans they project to `accepted_helper | modified_helper | manual_created`; `PUT .../correction-plans/{planId}/review` records the trusted human verdict and separates `reviewedBy` from `finalEditor`. Migration `047` persists this compact evaluation on the final reviewed stage execution without adding intermediate model output to canonical StageSample content.

**Implemented Edit Engine contract and Label adapter:** `edit-engine-v1` is published by `GET /management/annotation-workflow` alongside the Wizard runtime. It defines the common immutable primitives `accept | reject | edit | merge | split | create | delete | reparent | set_semantic | approve`, their per-stage availability and the invariant `humanApprovalRequired=true`. LLM, local ML, human UI and system plans remain controllers of the same Wizard Command Executor rather than separate mutation implementations. Label LLM decisions may contain one bounded ordered `editOperations[]` program over immutable candidate/derived node IDs (`accept | reject | edit | merge`); Recognize validates references and cardinality, performs geometry edits and enclosing merges deterministically, then translates the result into the existing canonical Label review command. Label ROI lineage attributes every `reject | edit | merge | approve` primitive to `human | llm | local_ml | system`; old graphs normalize to `unknown` instead of inventing provenance. Proposal operations and approval are attributed independently: applying an LLM plan from the human UI stores LLM transformations with `actor=llm` and the final boundary with `actor=human`; a machine caller is never recorded as human. Label observations include immutable current candidate nodes, recent persisted ROI graphs and the stage capability snapshot. **Partially implemented:** a single response can now describe multiple Label operations, but automatic render -> LLM re-evaluation after each derived result is not implemented; the validated correction plan still stops at the explicit apply/review boundary.

**Implemented operation dispatch registry:** Edit primitives now carry their canonical input cardinality in the shared dictionary. Execution resolves a handler by `(stage, primitive)` and refuses declared-but-unimplemented combinations instead of falling through a stage-specific switch. Label currently registers deterministic handlers for `accept | reject | edit | merge`; its stage adapter only converts the resulting accepted/rejected node graph into the persisted Label review payload. `StageObservation.editEngine.primitives` exposes only registered executable handlers, while `declaredPrimitives` retains the larger target contract for incremental migration of the remaining stages.

**Implemented OCR review-state and bounded Edit Engine loop (migrations 051-053):** OCR review separates physical region topology, transcription and semantic composition. Existing word quads remain canonical detection nodes; `ocrCompositions[]` represents a string through ordered reviewed-region `memberIds` without replacing their geometry. Physical merge/split remains a distinct operation. Every immutable OCR review revision stores a derived `reviewOperations[]` diff with positive approvals and explicit reject/edit/create/merge/split/compose evidence. The stage-scoped Qwen contract accepts a strict ordered OCR program over immutable candidate/derived IDs. The deterministic registry executes `approve_region | approve_text | reject | edit_region | edit_text | merge_region | split_region | create_region | compose_string | decompose_string | set_status`; the OCR adapter converts the result into canonical Wizard commands. `split_region` accepts one quad plus a horizontal/vertical ordered fraction list and produces deterministic child IDs `op-N:1..K`. Each child is perspective-rectified and passed through the same bounded `tesseract-cascade-v6` rerun/verification loop as edit, merge and create. Migration 052 preserves the explicit one-candidate-to-many-canonical-outputs relation in `annotation_candidate_reviews.result_entity_ids`; a double approval outside distinct branches of one split is rejected. Migration 053 adds canonical Label-owned OCR compositions, backfills legacy reviewed compositions, and maps temporary Qwen node IDs to persisted OCR UUIDs within the review transaction. `decompose_string` soft-deletes only the semantic relation. Manual OCR review syncs to the same table; deleting or reparenting a member invalidates its compositions. Crop geometry and output dimensions remain in system evidence. Provider output cannot invoke `rerun_ocr` directly. The loop is capped at two correction iterations and four changed regions per iteration; another geometry change at the limit stops at human review. A physical merge creates one OCR entity and retains all `sourceCandidateIds`; a created node becomes a separate canonical `create_region` command. The full LLM/system program and helper evidence remain in the correction plan, which is unapplied until the trusted caller crosses the review boundary. **Partially implemented:** order/role/reparent operations are not yet enabled for LLM; split uses straight horizontal/vertical cuts rather than an arbitrary cut line; a `create_region` result can join a Qwen composition only in a later review after it has a canonical UUID.

VisionContext and Visual Service provide compact state, bounded WebP assets, a source-crop-scale transform and OverlayModel. `controllers/system/plan` chooses the next safe helper frontier. `controllers/local-ml/plan` keeps the correction-plan compatibility boundary. The primary `controllers/llm/plan` path is stage-scoped for Package multiplicity, Label, Object Context, OCR and the Label-owned Mask/Morphology/Components/Elements/Contours/Palette stages. Package uses the bounded `llm-package-count-gate-v1`: the model selects `single` only for exactly one visible physical commercial package or `multiple` for two or more. The accepted result is stored as item-level Meta with `package-multiplicity` plus `single-package`/`multipackage`; `multiple` is a hard stop for automatic LLM orchestration. Creating a second canonical Package through manual annotation derives the same `multipackage` Meta without consulting the model. Recognize runs or reuses the deterministic helper, limits candidate observations, renders a clean scope crop plus a versioned stable-ID result overlay, and builds `StageObservationV1`. The provider adapter may return `accept`, bounded granular `review`, semantic `rerun` or `human_required`. Server validation rejects invented IDs, raw numeric parameter patches and cross-domain review fields; duplicate OCR observations may only be rejected by granular review. Recognize, not the model, translates semantic adjustments, reruns helpers at most twice and maps a final decision into an unapplied Wizard correction plan. Summary is advisory. A provider failure degrades to `no-action`/human review and does not make manual annotation unavailable.

**Implemented runtime registry:** `wizard-runtime-v1` is exposed by `GET /management/annotation-workflow` and is the server-owned dictionary of stage algorithms, allowed LLM actions, action flows and runtime transitions. The LLM still evaluates exactly one current stage and cannot reorder the Wizard or add executable commands. Stage adapters replace the former central stage `if` dispatch. The provider output schema is generated per request from the server-supplied current stage, allowed actions and semantic adjustments; the Node controller retains only the provider-neutral decision vocabulary and strict payload/identity validation, so a new runtime stage no longer requires a duplicate controller stage entry. Helpers may return a bounded, optionally nested `intermediateStates` trace when intermediate helper output causes extra internal passes. Migration `050` persists that trace on each track-level `wizard_helper_run`; Label-owned CV checkpoints store the same `helperRuns[].intermediateStates` contract inside their per-Label workflow. `StageSampleV1`, manual/dataset exports, `StageObservation.runtimeState`, LLM decision evidence and the UI Execution trace all preserve it. Historical helper runs explicitly expose an empty trace. These states are helper evidence, not new Wizard stages and not model-authored algorithms.

Compose includes two isolated instances of the Node.js controller runtime. `annotation-controller` is the deterministic local-ML reference planner. `llm-controller` is provider-selectable through `LLM_CONTROLLER_BACKEND`: `openai` uses the official OpenAI Node.js SDK and Responses API, while `qwen` uses Qwen Model Studio's OpenAI-compatible Chat Completions vision/JSON-Schema boundary through the same SDK. Both provider adapters normalize into the same stage decision contract and retain model, prompt and renderer provenance; provider keys remain inside the controller container. The annotation wizard sidebar exposes the single-item loop: request review, inspect the validated unapplied plan, explicitly apply it, then record the human verdict. **Implemented:** stage-scoped Label/Object Context/OCR/CV review, stable-ID overlays, strict candidate validation, graceful provider failure and semantic reruns for the stages with real adjustable configs. The model selects a named adjustment, never a raw numeric patch; Recognize maps it to bounded config, permits at most two reruns and stores the full iteration trace. OCR/Components/Elements additionally expose a strict review-target list: Qwen may correct/reject OCR, accept/reject Components, classify/reject Elements and move known Components between known or bounded new Element groups. Recognize creates persisted group identities and provenance itself; membership and field validation reject invented identities, duplicate ownership and cross-domain edits. **Partially implemented:** the old whole-Wizard LLM planner remains compatibility code, and decision traces live in correction-plan ProposedOutput rather than a dedicated append-only StageSample field. **Planned:** cache, calibrated metrics and batch execution.

Card-level LLM continuity is DB-owned. `meta.llm_sessions` stores the active annotation-track session, model/prompt/Wizard versions and compact canonical context; `meta.llm_stage_runs` stores each atomic session-stage invocation, ordered decisions, input artifact references, status and correction-plan link. Provider-side chat history is never authoritative. Without an active session, the stage sidebar can perform an explicit one-shot request that still produces the normal validated correction plan and provider evidence but no `LLMStageRun`. Alternatively, the reviewer can start/resume a card session; all later stage requests automatically include its `llmSessionId`, expose the transition trace and continue until the session is completed. `ANNOTATION_LLM_PIPELINE` freezes explicit `(source, sourceItemId, annotationTrackId)` cards and accepts `llmExecutionMode = session-chain | one-shot-chain`. The first mode creates/reuses one card conversation and persists `LLMStageRun` rows; the second sends independent provider requests while chaining them through canonical state committed after every validated correction plan. Both execute the same stage runners and stop only the affected Label/card branch on `human_required`. Swagger exposes this choice on the Jobs request. **Implemented:** one-shot stage review, card sessions/monitoring, both explicit-card batch modes, and OCR normalization-before-recognition. **Planned:** pause/resume controls, configurable concurrency per job, cost/latency aggregates and calibrated quality metrics; Jobs must not become a second annotation editor.

Every wizard stage also exposes a read-only Algorithm binding before execution. An unbound stage shows its explicit current default/draft config with `persisted = false` and provenance `default-config`; it never renders an ambiguous empty `{}`. Once a helper has run, the card switches to the exact normalized run config and run id. Historical persisted records whose configuration was never captured remain explicit `unavailable` migration gaps rather than being backfilled with current defaults.

Canonical annotation graph v9 keeps OCR geometry self-describing. Current OCR uses `{ type: "label-rectified", labelId, cropRevision, width, height }`; irrecoverable historical context may remain explicit `{ type: "unavailable", reason }`. Migration `041` supersedes the earlier source-image Package OCR variant by wrapping it in a synthetic VisualRegion and converting its quad to normalized Label space. Migration `042` adds independently reviewed VisualRegion classification and a separate `physical-label-roi` training projection. Wizard resync replaces only legacy-managed projections, so manually created graph OCR is not deleted by a later OCR-stage review.

Canonical annotation graph schema v4 separates OCR concerns instead of overloading geometry or one status field. `regionStatus = reviewed | rejected` belongs to the physical region; `transcription = { text, status: verified | partial | unreadable }` describes recognition GT/readability; `layout = { type, flow, baselineAngleDeg, baseline, characterOrientation }` describes reading flow independently from glyph orientation; optional `rectification` stores the local recognition transform. Detection `geometry` always remains in the original entity coordinate space and is never rewritten merely to deskew OCR. Migration `035` introduced canonical statuses/Meta; migration `036` adds layout and rectification fields and backfills the former direction/orientation values. Parent ownership remains in `parentRelation`, helper/manual/edit/merge history remains in immutable operations, and semantic annotations such as `lettering` or `decorative` remain nested `meta[]`. Mixed-script remains a derived warning rather than duplicated persisted metadata.

This V2 target is **implemented** for single-item manual review. Batch `ANALYZE_LABEL` remains supported by the job layer, but the main annotation UI intentionally drives one reviewed item at a time. Automatic model training and model-assisted proposal generation remain planned.

For the practical documentation map, start with [docs/README.md](README.md).

## Project Shape

The repository is a local monorepo with three services:

- `vinedetect_api` - Python/FastAPI catalog API, database access, import/crawler tools and JWT auth.
- `recognize-service` - Node/Fastify internal service for recognition metadata, CV preview, generation jobs, detection proposals and reviewed annotation storage.
- `vinedetect_web` - Next.js admin/scanner UI and BFF routes.

The Recognize Service, current Web admin/BFF implementation and restored-dataset tooling are tracked together in the repository.

Local data folders:

- `.basedata` - dataset archives and restore staging. Ignored by git; current archives are transferred between the two development machines outside Git.
- `asset-store` - local image files. Ignored by git.
- `.dev_logs/current` - dev stack logs.

## Runtime Services

Default local ports:

- PostgreSQL: `localhost:5432/wines`
- Python API: `http://127.0.0.1:8000`
- Recognize service: `http://127.0.0.1:4001`
- Next.js: `http://127.0.0.1:3000`

Recommended reproducible launcher after restoring the dataset:

```bash
docker compose up -d --build
```

Native Windows launcher:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev_stack.ps1 -Action run -CleanPorts
```

The root Compose runtime contains PostgreSQL, Python API, a one-shot restored-dataset check, a one-shot Recognize migration container, Node.js annotation controllers, Recognize Service and Next.js. PostgreSQL uses a named volume; all image consumers share the host `asset-store` through bind mounts. The base file runs compiled production-like images. `compose.dev.yaml` overlays source mounts plus `uvicorn --reload` for the catalog API, `node --watch` for controllers, `tsx watch` for Recognize and `next dev`. The PowerShell launcher remains supported as a non-containerized workflow.

## Database Profiles

The full local stack currently targets a restored dataset with:

```text
svoe_vino.wines
svoe_vino.wine_images
roskachestvo.products
meta.*
database search_path = svoe_vino, public
```

The dump is also the current shared-state handoff. Database content is developed on either of two machines; when new catalog or `meta.*` rows must be available to the other developer, a new archive is created and transferred. The repository alone therefore describes code and schema intent, but not which dump is operationally current.

Python repository SQL uses unqualified `wines`/`wine_images`, so the restored `search_path` resolves those names into `svoe_vino`. Recognize Service names `svoe_vino.wines` and `svoe_vino.wine_images` explicitly.

The nested Python migration-only Docker profile creates catalog tables in the active default schema, normally `public`. It remains valid for the Python API alone, but is not equivalent to the restored dataset profile and does not satisfy Recognize Service queries. The root Compose does not pretend to resolve this difference: `dataset-check` fails before the application services start unless the required restored source schemas exist.

The restore helper does not apply Python SQL migrations to the restored dump; it records their filenames in `public.schema_migrations`. Recognize Service migrations are then run separately and re-execute idempotent SQL without a migration ledger.

Operational distinction:

- **Data handoff:** create/transfer a new dump for changed `meta.items`, jobs, proposals, reviewed label/OCR annotations, OCR runs/regions and other shared rows.
- **Current clean baseline:** source-data is restored from the latest agreed full dump; migrations `001`-`025` create the recognition/annotation schema, while operational pipeline tables start empty. Pipeline rows appear only after generation or manual/semi-automatic annotation begins.
- **Schema handoff:** commit a migration even if the latest dump already contains that schema; after restoring an older dump, apply migrations/backfills required by the current code.

There are also two distinct recognition schema lines in repository history:

- Python migration `009_recognition_schema_foundation.sql` creates legacy/foundation tables such as `recognition_assets`, `recognition_profiles`, `recognition_annotations`, `ocr_observations` and `asset_processing_jobs`.
- The active Fastify/Next.js workflow uses the separate `meta.*` schema created by `recognize-service/migrations`.

No current service bridges these two models. The `recognition_*` foundation is not used by the active admin annotation/job flow and should be considered superseded/unused until an explicit consolidation decision is made.

## Assets

The database stores image paths, not image bytes.

Current boundary:

- catalog/API data says which image belongs to an item;
- static route returns image bytes;
- Next.js does not keep a second image copy;
- Recognize service reads files directly from `ASSET_ROOT`.

Expected local layout:

```text
asset-store/
  svoe-vino/
  roskachestvo/
  label-analysis/
```

Current local image route:

```text
/api/admin/assets/[...path]
```

Path mapping:

- `svoe_vino/...` and legacy `data/...` prefer `asset-store/svoe-vino/...`; the BFF also accepts dump-native `svoe_vino` and Python `storage/images` compatibility layouts;
- `roskachestvo/...` and legacy `storage/...` map to `asset-store/roskachestvo/...`.

Inside root Compose the same host directory is mounted at `/data/assets`: read/write for Recognize Service because reviewed-ROI analysis writes crop artifacts, and read-only for Python API and Next BFF. `NEXT_ADMIN_ASSET_ROOT` and `ASSET_ROOT` point to that shared container path.

## Container Runtime And Restore

The root `compose.yaml` implements the restored-dataset runtime profile:

```text
postgres -> dataset-check -> api
                         -> recognize-migrate -> recognize
                                                  -> web
```

`scripts/restore_dataset.sh` starts only PostgreSQL, recreates the database from `db/*.dump`, sets `search_path=svoe_vino,public`, records the Python migration filenames, overlays archive media into `asset-store` and runs the idempotent Recognize migrations. It does not delete pre-existing media files. With `--start`, it then builds and starts the full Compose graph.

This is implemented deployment reproducibility for the current development dataset, not yet a production topology: secrets use overridable local defaults, media is a single-host bind mount, PostgreSQL is directly published and there is no reverse proxy/TLS/CDN or off-host backup automation.

The hot-reload development command is:

```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

Development observability is implemented through the root UI activity collector. Each launcher/Web-process session writes JSONL under `.dev_logs/activity/` and mirrors entries to Web stdout. The trace correlates UI controls and canvas actions with browser request method/URL, redacted JSON request body, response status and duration. Native `scripts/dev_stack.ps1 -Action run` streams these lines together with Uvicorn and Fastify request logs; Docker exposes the same stream through `docker compose logs`.

## Data Ownership

The project now has four different kinds of recognition-adjacent data. They must not be collapsed into one object.

Source catalog data:

- comes from `svoe_vino` and `roskachestvo` in the restored runtime profile;
- is owned by the Python/catalog side;
- contains product fields and source image paths.

Generated metadata:

- lives primarily in `meta.items`;
- contains aliases, normalized tokens, visual features, `cvMeta`, hashes and warnings;
- is produced by recognition jobs;
- is not training ground truth.

Detection proposals:

- live in `meta.detection_proposals`;
- are candidate label ROIs proposed by OpenCV/CV Lab/future model runs;
- can be generated by queued jobs or by using a CV Lab preview candidate;
- are not reviewed annotations.

Reviewed annotations:

- live in `meta.image_annotations`;
- represent human-confirmed ground truth;
- are the only current source for label detector dataset export;
- can point back to a proposal through `suggestion_id`.

Core rule:

```text
generated proposal != reviewed annotation
```

## Recognize Service

The Recognize service is an internal service behind the Next.js BFF. `/management/*` endpoints are protected by `X-Internal-Api-Key`.

It also exposes a generated OpenAPI 3.1 contract for the Label Annotation wizard at `/documentation/` and `/documentation/json`. Only tagged wizard operations are included. They are ordered from Label through Summary and carry `x-wizard-stage`, `x-helper-id`, `x-data-flow` and `x-bff-route` metadata so the direct Recognize input/output boundary and its browser-facing Next.js proxy can be traced together. Every successful stage response is additively decorated with a typed `helperBinding` containing `card = { source, sourceItemId }`, `wizardStage`, algorithm/config/provenance/review data and a persisted flag. The aggregate Analysis workspace returns all ten records as `helperBindings`. CV preview responses bind the requested draft stage and explicitly report `persisted = false`; persisted GET/PUT state is derived from the reviewed card metadata. Request bodies are generated from the same Zod schemas parsed by the handlers, while response schemas expose the binding without stripping evolving workspace fields. The documentation UI itself is readable locally, while direct `/management/*` execution still requires `x-internal-api-key`.

Primary responsibilities:

- expose recognition inventory;
- expose metadata detail and patch APIs;
- enqueue and process recognition jobs;
- run direct CV preview/sweep requests for CV Lab;
- store generated metadata in `meta.items`;
- store job state in `meta.generation_jobs`;
- store detector suggestions in `meta.detection_proposals`;
- store human ground truth in `meta.image_annotations`.

Current metadata tables:

- `meta.items` - aggregated generated recognition metadata per source item.
- `meta.generation_jobs` - parent and child job journal.
- `meta.detection_proposals` - generated/proposed label ROI candidates.
- `meta.image_annotations` - reviewed/manual image annotations.
- `meta.label_crops` - persisted crop metadata derived from the label quad; `bbox` is the enclosing source rectangle, `geometry` is the source quad, and width/height describe the rectified crop.
- `meta.ocr_runs` - persisted OCR run snapshots/provenance; V2 analysis runs may reference their `meta.generation_jobs` row through `analysis_job_id`.
- `meta.ocr_regions` - generated OCR line and word boxes tied to one OCR run.
- `meta.ocr_text_annotations` - revisioned human-reviewed OCR text.
- `meta.ocr_region_annotation_sets` - immutable item-level revisions of reviewed OCR-region layouts.
- `meta.ocr_region_annotations` - reviewed/corrected/manual regions with canonical convex quad geometry normalized to the rectified label crop, derived bbox and generated-region provenance.
- OCR text regions expose a prediction/annotation contract: immutable machine bbox/text/confidence are stored separately from the human bbox/text/transcription status. Unreviewed is implicit (`annotation = null`) before stage completion; persisted annotations use only `verified | partial | unreadable`. Review/source/edited/GT flags are derived, not operator-controlled. Existing generated `meta.ocr_regions` remain the source evidence, while migration 023 backfills the explicit prediction snapshot for existing one-to-one reviewed annotations.
- `meta.ocr_source_association_sets` - immutable revisions linking one reviewed OCR-region layout to source data.
- `meta.ocr_source_associations` - accepted/rejected region-to-field links with text snapshots, match score/kind and suggestion provenance.
- `meta.alias_annotation_sets` - immutable item-level revisions of reviewed aliases, optionally bound to a source-association revision.
- `meta.alias_annotations` - accepted/rejected generated, corrected and manual aliases with scores, components and association provenance.
- `meta.annotation_cohorts` / `meta.annotation_cohort_items` - named fixed item-key selections created from the annotation queue.
- `meta.dataset_versions` / `meta.dataset_version_items` - immutable reviewed-layer snapshots with per-item SHA-256 and deterministic train/validation/test split.
- `meta.dataset_artifacts` - registered filesystem exports of frozen dataset versions with manifest, path and annotation JSONL checksum.
- `meta.training_runs` - external training run registry bound to one registered dataset artifact, with immutable config/code provenance and an explicit lifecycle.
- `meta.evaluation_results` - train/validation/test metric records, optionally bound to a concrete model version.
- `meta.model_versions` - model artifact registry with checksum, runtime metadata and candidate/validated/promoted/deprecated lifecycle.
- `meta.pipeline_preset_revisions` - immutable versioned layer preset configs; currently consumed by the `label-roi` CV workflow.

Current backend OCR:

- invocation: both the detector-free `ANALYZE_LABEL` job and the Advanced direct item-level endpoint;
- execution mode: `label-analysis-cascade-v6` for analysis and `backend-cascade-v6` for the direct compatibility endpoint;
- engine: `tesseract.js`;
- input: exact reviewed label ROI for analysis; the direct compatibility endpoint may still resolve its legacy reviewed/generated bbox fallback;
- cascade: four cheap profiles (full/top/bottom, normalized/contrast, PSM 6/7/11), followed by three threshold/invert full/center profiles only when cheap evidence does not pass the stop gate; if combined cheap/deep evidence is still weak, rescue adds CLAHE, local adaptive threshold and highlight-compressed/glare-suppressed preprocessing plus confidence-gated deskew and perspective passes;
- evidence: every pass, raw line/word observation, validity decision/rejection reason, and cross-pass text/spatial consensus is stored as versioned JSON in `meta.ocr_runs.evidence` (migration `017`);
- output: clean consensus text plus persisted consensus line/word regions in the existing region contract; raw pass text remains evidence and is not mixed into reviewed OCR text;
- UI: the OCR step exposes pass diagnostics, accepted/rejected observation counts and word consensus; Summary exposes the compact cascade quality result;
- review: corrected/accepted text is saved separately in `meta.ocr_text_annotations`;
- region review: generated word boxes can be accepted, moved, resized, rejected, merged, split or replaced by manual `word`/`string` regions; legacy `line` values hydrate as `string`, hyphen compounds are auto-classified as strings, and every region persists reviewed layout/baseline, character orientation and local rectification; each save creates an immutable set revision. The implemented editor/runtime slice supports linear baselines and rotation rectification with a derived normalized preview. Affine, perspective and curved variants exist in the validated persistence/API union but their dedicated editors and rectification runtimes are planned. Global label dewarp remains a Label-level concern and is not synthesized from local OCR edits.

This is a recognition cascade, not literal OpenCV. Image variants are produced with Sharp/typed pixel transforms; Tesseract performs recognition. Current validity uses OCR confidence, character diversity, alphanumeric ratio, text length and bbox geometry with a small allow-list for domain short strings. Cascade v5 adds rule-based semantic types (`vintage`, `barcode`, `alcohol`, `volume`, `classification`, `color`, `region`, `producer`, `product-name`, `free-text`) and uses their confidence/compatibility to narrow current-item source fields before lexical matching. Its rescue stage implements CLAHE, a local integral-image adaptive threshold and highlight tone compression; it does not perform reflection inpainting. Rescue estimates text skew from baseline votes of connected dark components. It also fits four directed edge lines, validates quadrilateral coverage/fit/area/distortion and applies a projective warp only when confidence and non-trivial distortion both pass. Deskew and perspective OCR boxes are mapped back into original reviewed-crop coordinates before consensus. Robust glare-region reconstruction and learned semantic classification are still planned.

Label analysis profile `label-analysis-cascade-v7` combines the existing catalog narrowing/OCR profile with staged crop features v2. Strong semantic phrases, years and barcodes prefilter at most 250 rows from the existing combined `svoe_vino`/`roskachestvo` catalog SQL, including Meta aliases/tokens. Detailed ranking then compares OCR evidence with tokenized candidate fields, uses semantic discriminative weights, clusters spatially overlapping line/word regions that describe the same text, supports deterministic Cyrillic-to-Latin variants and returns an explainable top-10 shortlist plus the current item when it falls outside the top ten. A line and its nested words therefore cannot inflate one candidate through duplicate evidence; latest human-reviewed regions are trusted for rematch rather than treated as generated OCR with missing confidence. The current item is included for audit but receives no score boost. Summary recalculates this shortlist from the latest reviewed OCR regions when available; saving corrected regions immediately reloads the recalculated current-item and cross-item matches without a new analysis job. Migration `018` adds immutable `meta.catalog_identity_reviews`: a human decision (`confirmed`, `corrected`, `no-match`, `ambiguous`) is bound to the completed `ANALYZE_LABEL` job, optionally to the reviewed OCR-region revision, and stores the selected cross-source identity plus candidate snapshot. A decision with a different OCR-region-set id is stale, not deleted, and must be reviewed again. It does not mutate either source catalog.

## Job Types

Current recognition job types:

- `ANALYZE_LABEL` - detector-free composite analysis inside an exact reviewed ROI: crop, OCR, line/word regions, source matching and compact visual features. It uses a server-owned V2 profile and rejects CV Lab presets/config snapshots.
- `GENERATE_ALIASES` - source-text metadata only.
- `GENERATE_CV_META` - image-derived generated metadata only.
- `GENERATE_DETECTION_PROPOSAL` - detector proposal only; does not create reviewed annotations.
- `GENERATE_ALL_META` - source-text plus image-derived metadata.
- `REGENERATE_ALL_META` - forced regeneration of both metadata streams.

Jobs can be single-item or batch. Batch jobs create child rows in `meta.generation_jobs`. The worker claims queued jobs with `FOR UPDATE SKIP LOCKED`.

## Pipeline Preset Registry

The first server-side preset vertical slice is implemented for `label-roi`:

- immutable revisions live in `meta.pipeline_preset_revisions`;
- the migration seeds one deterministic validated OpenCV baseline;
- Recognize Service exposes list/create/history/create-revision management endpoints;
- concurrent revision creation uses `baseRevision` conflict detection;
- CV Lab reads shared presets through the authenticated Next.js BFF and can create a new preset or revision;
- jobs that reference a preset load the exact config revision on the Recognize server, persist its snapshot/hash in job options and reject incompatible/deprecated presets;
- detection proposals created by those jobs retain preset id, revision and config hash provenance.

Implemented layer/config validation currently covers the full `label-roi` CV Lab config. Reviewed `ocr-region`, source-association and alias storage/API/UI are implemented, but their batch generator preset schemas are not. Registry layer names for OCR recognition and composite pipelines exist in the contract, but their runtime schemas and UI are still planned.

Application scopes for `label-roi` proposals now include item, frozen selection, one source and global inventory. The recognition inventory provides estimate-then-run controls. Every batch parent stores the resolved item keys and timestamp in its target, while each child stores the server-resolved preset snapshot/hash in job options. Visual multi-item sample preview, validation datasets/metrics and preset promotion workflow are not implemented yet.

## CV Preview And Sweep

CV Lab preview and sweep are exploratory direct HTTP calls.

Preview:

```text
Frontend -> Next BFF /api/admin/cv/playground/run
         -> Recognize /management/cv/playground/run
         -> response with cvMeta/debug stages/metrics
         -> UI overlay
```

Sweep:

```text
Frontend -> Next BFF /api/admin/cv/playground/sweep
         -> Recognize /management/cv/playground/sweep
         -> response with variants
         -> UI comparison
```

Preview and sweep do not create jobs, do not update `meta.items`, and do not create reviewed annotations.

CV Lab may create a proposal by taking a selected preview candidate and saving it to `meta.detection_proposals`. That still is only a proposal.

## Manual Annotation Workflow

The human annotation workflow is documented in detail in [label_annotation_workflow_ru.md](label_annotation_workflow_ru.md).

Short flow:

```text
generate proposal
  -> open annotation queue
  -> inspect Generated ROI
  -> Accept proposal or Edit manually
  -> Save reviewed annotation
  -> export reviewed dataset
```

`Accept proposal` copies the generated bbox into a reviewed annotation draft. It becomes ground truth only after saving.

`Mark no label` stores a reviewed status that excludes the item from positive label-bbox export.

## Admin UI

Main pages:

- `/admin` - catalog list from Python API.
- `/admin/recognition` - recognition inventory with metadata/proposal/annotation state, checkboxes and group actions. Row-level `Del` and selection-level `Del meta` atomically reset operational Meta for chosen items; active jobs block deletion, while source catalogs, assets, presets, cohorts and frozen dataset snapshots are preserved.
- `/admin/recognition/annotations` - label annotation queue.
- `/admin/recognition/jobs` - unified recognition job journal and batch controls.
- `/admin/recognition/[source]/[sourceItemId]` - canonical item card.

Canonical item card sections:

- `Catalog` - source item data.
- `Saved Metadata` - persisted generated metadata and job actions.
- `Text Metadata` - editable aliases and normalized tokens.
- `CV Lab` - draft config, preview, sweep and proposal creation from preview.
- `Label Annotation` - `Label -> Bottle Context -> OCR -> Mask -> Morphology -> Components -> Elements -> Contours -> Palette -> Summary`: reviewed label ground truth, optional reviewed/skipped source-level bottle context, detector-free label-crop analysis, OCR-region/source/catalog correction, crop-local preprocessing, component/element review, combined final overlay review and save-and-next. Alias review is not part of this wizard; item aliases/tokens are managed under Metadata.
- `Jobs` - item job history.

Entry behavior:

- catalog list item click opens the card with catalog section;
- recognition inventory item click opens recognition/metadata context;
- jobs item click opens recognition/metadata context;
- annotation queue item click opens `Label Annotation`.

## Next.js BFF

Next.js proxies admin recognition routes under:

```text
/api/admin/recognition/*
```

The authentication boundary uses three environment-configured accounts and signed roles: `admin`, `annotator` and `ml-service`. The Python API authenticates all three, places `sub`, `role` and derived `actor_type` into an HS256 JWT, and exposes `/api/v1/auth/me`. Catalog mutations remain `admin`-only. The Next BFF verifies signature, expiry, role and actor consistency before forwarding any Recognition inventory/detail/mutation request with the internal Recognize key. It derives annotation actor headers from the verified principal: `admin` and `annotator` become `human`, while `ml-service` becomes `ml-agent`; caller-supplied actor headers are never trusted. Recognize Service itself remains private behind the BFF internal key for `/management/*`. The media asset route remains intentionally unauthenticated for image delivery.

Important route groups:

- inventory;
- annotation dataset readiness summary;
- metadata detail and patch;
- manual annotations compatibility API;
- label annotation state;
- detection proposal state/history;
- label annotation OCR snapshot/run;
- aggregate label-analysis workspace/run and immutable analysis review;
- reviewed OCR text read/write;
- OCR-to-source candidate workspace and reviewed association read/write;
- generated alias candidate workspace and reviewed alias read/write;
- generation jobs;
- job child items, retry and cancel;
- CV playground preview/sweep.

## Annotation Dataset Export

Annotation dataset export is CLI-based:

```powershell
cd .\recognize-service
cmd /c npm run export:annotation-dataset -- --name annotation-dataset-v1 --source all
```

Output:

```text
exports/
  annotation-dataset-v1/
    manifest.json
    annotations.jsonl
    splits.json
```

The export includes only:

```text
meta.image_annotations.annotation_type = label-bbox
meta.image_annotations.status = reviewed
```

For each exported item, the script also attaches:

```text
latest meta.ocr_text_annotations row with its status, when available
latest meta.ocr_runs + meta.ocr_regions word boxes, when available
latest reviewed meta.ocr_region_annotation_sets revision + reviewed child regions, when available
latest reviewed source-association revision for that OCR-region revision, when available
latest reviewed alias revision for that source-association revision, when available
```

Generated word boxes stay under `ocr.generated` as auxiliary model output. Reviewed ground truth is exported separately under `ocr.regionsReview`, `ocr.sourceAssociations` and `ocr.aliasesReview`; revision links and provenance are retained.

Current export/readiness SQL does not filter `meta.ocr_text_annotations.status = 'reviewed'`; the latest `empty` or `rejected` row is also attached/counts as present. The manifest wording calls it reviewed OCR text, so this is a known contract mismatch. Consumers must inspect `ocr.review.status` until the query/metric contract is tightened.

It does not train on:

- `meta.detection_proposals`;
- `visualFeatures.cvMeta.label.roi`;
- CV Lab preview results;
- raw generated metadata.

Annotation readiness is exposed through:

```text
GET /management/annotations/summary?source=all|svoe_vino|roskachestvo
GET /api/admin/recognition/annotations/summary?source=all|svoe_vino|roskachestvo
```

The admin annotation queue uses this summary to show dataset progress before export.

## Scanner/OCR Playground

The frontend scanner/OCR path is still separate from Recognize service jobs.

Current scanner-side pieces include:

- camera scanner page;
- ROI crop utilities;
- Tesseract.js OCR flow;
- Fuse.js catalog text matching.

This is a **partial prototype**. `/api/catalog/search-index` serves a hard-coded mock index. `/api/scan` accepts the multipart payload but only returns `{ ok: true, finalResults: [] }`; it does not persist uploads or produce server-side final recognition results.

Fuse.js belongs to the frontend scanner/catalog search path, not to the Recognize worker.

## Current Limitations And Planned Work

- **Implemented:** `ANALYZE_LABEL` V2 is detector-free and orchestrates exact crop, persisted OCR line/word regions, generated source matching and compact visual features inside the reviewed ROI.
- **Implemented:** Tesseract cascade v5 preserves raw per-pass observations separately from catalog hypotheses, filters obvious OCR garbage, combines repeated spatial/text evidence and conditionally escalates through cheap, deep and rescue profiles. Evidence includes deskew and quadrilateral perspective confidence/application provenance and remains visible in the annotation OCR/Summary UI.
- **Implemented:** consensus regions receive explainable rule-based semantic types. Generated source matching prunes strongly incompatible current-item fields and returns lexical score, semantic confidence and field compatibility separately from the final score.
- **Implemented:** bounded cross-item catalog prefilter/ranking across both restored source schemas with semantic weights, evidence deduplication, transliteration variants and per-field score explanations. It is part of analysis/review diagnostics, not yet a public client recognition endpoint.
- **Partially implemented:** semantic typing is deterministic and limited to known label patterns; it is not a trained classifier. Rescue preprocessing improves local contrast/threshold/highlights and implements confidence-gated rotation/projective correction, but curved-surface dewarping, reflection reconstruction and learned field-specific quality gates are not implemented yet.
- **Implemented / compatibility split:** V2 backend OCR belongs to the Recognize job and is linked through `analysis_job_id`. The older direct OCR endpoint remains in the API for compatibility but is no longer exposed by the Label Annotation wizard; browser Tesseract and standalone/direct source switching were removed from that UI.
- **Partially implemented:** the server suggests OCR-region matches against current item fields, aliases and normalized tokens; the annotator can correct, accept/reject and save immutable reviewed association revisions. Cross-item shortlist computation, single-item revisioned catalog identity review and identity-aware dataset snapshot/export are implemented. Batch entity resolution and a versioned source-matching preset remain planned.
- **Implemented / API compatibility:** item-level alias candidates, immutable manual/corrected/rejected alias reviews and dataset export exist in backend contracts. Their editor was removed from Label Annotation because automatically accepted drafts were not a meaningful mandatory annotation step. Operational item aliases/tokens remain editable in Metadata; a dedicated, task-oriented alias curation UI and batch alias jobs remain planned.
- **Partially implemented:** the scanner has camera/OCR/Fuse logic, but uses a mock index and a stub upload response.
- **Partially implemented:** the shared versioned preset registry and CV Lab `label-roi` integration work. Frozen selection/source/global proposal runs are implemented; OCR/source/alias preset schemas, sample validation and promotion workflow remain absent.
- **Implemented:** item-level reviewed OCR-region revisions, provenance-preserving editing and dataset export. This is manual review over generated OCR boxes, not a trained region detector or batch OCR stage.
- **Planned:** one iterative annotation/training pipeline for `label-roi`, OCR regions/text, source associations and aliases. It preserves generated proposals and reviewed ground truth as separate entities.
- **Implemented for `label-roi` proposals:** presets can be applied to one item, a frozen selection, one source or the global inventory. Batch execution creates generated proposals and does not overwrite canonical reviewed annotations.
- **Planned:** non-persisting visual sample validation, quality gates and preset promotion based on validation metrics.
- **Implemented:** annotation-queue selection can filter catalog identity outcomes (`missing`, `confirmed`, `corrected`, `no-match`, `ambiguous`), show readiness counters, create a fixed cohort and freeze repeated immutable dataset versions. Each version uses a repeatable-read transaction, snapshots reviewed layers, hashes every item and stores deterministic 70/20/10 splits. Schema v2 introduced optional `catalogIdentity`; schema v3 added separated `vision.annotations` / `vision.cvMeta`; schema v4 added ordered stage samples; schema v5 adds the complete canonical annotation graph. Existing frozen v1-v4 snapshots are not rewritten.
- **Implemented:** the Recognition inventory derives annotation progress from the canonical Package/Label graph, reviewed Object Context, Label-owned OCR/CV checkpoints and Summary review instead of inferring it from the presence of legacy Meta. Each annotation track exposes `completedStages / 11`, the first unfinished stage and `not-started | in-progress | complete`; the queue filters use the same derived state. Provenance is split into two orthogonal axes. `executionActor.type = human | ml-agent | hybrid` records who mutated the workflow; it is derived from the verified JWT role (`admin|annotator -> human`, `ml-service -> ml-agent`), not from User-Agent or caller-supplied provenance. Migration `043` stores the accumulated actor and distinct account-scoped sources on the track. Separately, stage helper review is derived from the latest persisted execution: `accepted -> auto`, `corrected -> mixed`, `manual -> manual`. The inventory exposes per-stage modes plus aggregate counts/rate and `automation.mode = auto | mixed | manual`; it can therefore distinguish a human reviewer accepting every helper result from unattended ML execution. The old Status filter remains explicitly Meta status.
- **Implemented:** Recognition-list `Del meta` is a transactional reset of all operational item state, including the canonical annotation graph (`annotation_packages` with cascading Label/OCR children, operations/candidates/reviews, annotation Meta and annotation tracks/stage executions), legacy Meta/OCR/proposals and item jobs. Source catalog rows, media assets, presets and frozen dataset artifacts are retained. Consequently the derived Annotation progress returns to `not-started` after deletion.
- **Implemented:** Summary exposes item-level Recognition tags (`needs-manual-review`, `nonstandard-package`, `nonstandard-label`, `low-image-quality`, `exclude-from-training`). They are persisted as canonical `annotation_meta` records marked with `recognition-list`, rendered in a dedicated Recognition-list column and available through the `recognitionTag` inventory filter. The structural `multipackage` Meta is included automatically. Workflow progress, execution actor and automation mode remain derived and cannot be overwritten by these tags.
- **Implemented:** LLM Wizard failures propagate across all three execution levels. The interrupted `llm_stage_run` is finalized as `failed` with its stage/Label/error and a `stage_failed` session event; its session becomes `failed`; the card generation job stores a structured `failure` plus already completed stages. An LLM batch with any failed card finishes as `failed` after all sibling cards reach a terminal state, while successful sibling outputs remain committed and retry requeues only failed children. Worker logs include job, parent, source item, annotation track, failed stage and stack.
- **Implemented:** a selected frozen DB dataset version can be exported atomically to `manifest.json`, `annotations.jsonl` and `splits.json`. The exporter reads stored snapshots rather than live annotations, records the JSONL SHA-256, registers the filesystem artifact in the DB and never overwrites an existing artifact directory.
- **Implemented:** new frozen exports also contain deterministic adapter-v4 files under `tasks/` for every training task. Records contain a minimal task input, reviewed target, fixed split and snapshot provenance. Canonical graph adapters emit one generic VisualRegion sample per reviewed Label, a separate `physical-label-roi` sample only for reviewed physical-label semantics, one OCR sample per Label scope, and one object-outline sample per reviewed Package object context. Consequently one eligible item may produce multiple task samples; readiness reports both counts and validates the materialized task JSONL against the sample count. Visual inputs retain Package/Label parent scope and the exact helper operation/config/candidates/reviews as `helperContext`; multi-result Label operations are resolved through `results[]`. `reviewOperations[]` remains the compact merge compatibility view, while `roiReviewGraph` is the canonical immutable lineage of autodetect/manual/derived geometry with explicit `reject | edit | merge | approve` primitives, per-operation actors and reviewed output node IDs. This preserves both `ROI1 + ROI2 -> merge -> ROI3` and a later `ROI3 -> edit -> ROI4` without mutating candidates. Reviewed targets remain config-free. Per-task count/checksum/version is frozen in both filesystem and registered DB manifests and revalidated before a run is queued.
- **Implemented as registry/control plane:** training runs are bound to registered immutable dataset artifacts; run transitions, split metrics, model artifacts/checksums and validation-gated model promotion have DB/API/BFF/admin UI support. Before queueing a run, the artifact consumer resolves the portable export directory, verifies `annotations.jsonl` against both the registered and manifest SHA-256, parses schema v1-v4 records and reports task-specific eligible/skipped counts per fixed split. The same validation is enforced server-side during run creation. Migration `021` adds `bottle-outline`, `label-elements` and `label-palette`; these targets consume reviewed `vision.annotations`, never CV proposals from `vision.cvMeta`. Docker bind-mounts `./exports` at `/exports`, configured by `DATASET_EXPORT_ROOT`, so registered files survive container recreation.
- **Planned:** an actual trainer/worker, model-backed proposal execution, evaluation computation, artifact storage synchronization and model-neutral client bundle publication. The target contract and implemented/planned boundary are defined in [annotation_pipeline_ru.md](annotation_pipeline_ru.md).
- **Planned:** user-upload recognition/scoring and final wine-card resolution.
- **Planned:** trained detector integration; current proposals are heuristic/OpenCV-style output.
- **Planned:** TensorFlow-specific conversion/training after the JSONL/splits export.
- **Deprecated / compatibility only:** legacy label annotation state in `meta.items.annotations.labelAnnotation` and `visualFeatures.cvMeta.label.roi` remains as fallback/backfill input, not canonical ground truth.

## Implemented Backend Delta For Detector-Free Label Analysis

Keep and reuse:

- `ANALYZE_LABEL`, `meta.generation_jobs` and existing item/selection job mechanics;
- exact reviewed annotation validation;
- `meta.label_crops`, `meta.ocr_runs`, `meta.ocr_regions`;
- normalization and source-value/matching functions;
- `meta.label_analysis_reviews` and existing reviewed OCR/source-association tables;
- asset route and crop storage.

Implemented changes:

1. introduce a versioned `LabelAnalysisResultV2` contract;
2. replace `extractCvMetaFromFile(crop)` in this job with a detector-free orchestrator;
3. refactor OCR into a lower-level function that accepts the exact annotation/crop supplied by the job. Do not use generated-bbox fallback in this path;
4. make standard OCR emit word and line regions and persist their parent linkage;
5. generalize source matching so generated OCR regions can produce generated match candidates without first requiring a reviewed OCR-region set;
6. add a crop-feature extractor for palette, quality and normalized contours that does not calculate bottle/label candidates;
7. retain OpenCV detector config as a CV Lab concern. The analysis job uses a server-owned analysis profile/version; optional problem-case overrides are OCR/feature settings, not `label-roi` detector settings;
8. expose one aggregate analysis workspace read contract and one run command so the client does not need to assemble state from eight sequential requests.

Proposed minimal endpoints:

```text
POST /management/metadata/:source/:sourceItemId/label-annotation/analysis/run
GET  /management/metadata/:source/:sourceItemId/label-annotation/analysis
PUT  /management/metadata/:source/:sourceItemId/label-annotation/analysis/review  (existing, evolve compatibly)
POST /management/metadata/:source/:sourceItemId/label-annotation/analysis/cv-preview
PUT  /management/metadata/:source/:sourceItemId/label-annotation/analysis/cv-checkpoint
PUT  /management/metadata/:source/:sourceItemId/label-annotation/analysis/cv-job
```

The run command resolves the latest reviewed annotation revision on the server and accepts `force` plus bounded detector-free CVJOB config. It does not accept label-detector config. The preview command accepts `stage = mask | morphology | components | elements | contours | palette`, config v3 and optional component/element review delta. The normalized config snapshot and its hash are persisted with the job/result. The GET response aggregates annotation identity, current job, composite result, review and staleness.

Proposed result shape:

```text
LabelAnalysisResultV2
  annotation: id + revision
  crop: id + assetPath + sourceRect + dimensions
  ocr: runId + engine/profile + raw/normalized text + confidence + versioned cascade evidence
  textRegions: generated word/line regions
  sourceMatches: generated candidates with field/value/score/kind
  visualFeatures: palette + quality + normalized contours
  warnings
  provenance: jobId + analysisProfileVersion + config hashes + runtimes
```

Implemented DB approach: existing ROI rows remain canonical; the aggregate result/pointers live in the job result plus `meta.items.visual_features.labelAnalysis`, `meta.ocr_runs.analysis_job_id` links analysis OCR to its job, and `meta.ocr_runs.evidence` stores versioned cascade diagnostics. Reviewed ROI is not duplicated and no second ROI ground-truth table is introduced. Catalog identity is a separate human-reviewed ground-truth layer in `meta.catalog_identity_reviews` because it describes entity resolution rather than ROI geometry.

The live manual metadata can also be read as one JSON document through `GET /management/metadata/export/manual`. Optional `?source=svoe_vino|roskachestvo` limits the export. Manual export schema v2 includes the current `meta.items` payload, the complete revision history for label annotations, OCR text/regions, source associations, aliases, label-analysis reviews and catalog-identity reviews, plus the normalized reviewed Helper Config Contract at `items[].vision.cvMeta.helpers`. Its OCR helper is built from the latest persisted OCR-run evidence; the remaining helpers are derived from the same saved `labelSourceAnalysis` and `labelCvJob` state used by the wizard. The Next BFF exposes the same contract at `GET /api/admin/recognition/metadata/export/manual`. It does not write rows or replace the immutable dataset snapshot/export flow.

## Implementation Status And Remaining Order

1. **Implemented:** V2 contract and detector-free backend behind the existing job type.
2. **Implemented:** aggregate run/workspace API, BFF route and frontend type mirror.
3. **Implemented:** `Label -> Bottle Context -> OCR -> Mask -> Morphology -> Components -> Elements -> Contours -> Palette -> Summary`; label ROI editing is restricted to Label, source-level bottle candidates/debug overlays/verified-or-skipped decision live in Stage 2, and linked OCR overlay/list hover, debounced crop previews, component/element review, editable Label Palette, separate `labelCvJob` Meta state and server-recalculated Summary follow it.
4. **Implemented:** OCR cascade v6 plus label-analysis v7: additive evidence persistence, cheap/deep/rescue stop gates, CLAHE/local adaptive threshold/highlight compression, confidence-gated deskew/perspective correction, an always-on PSM 5 vertically-aligned-text pass plus ±90° passes with inverse bbox mapping, per-region direction/glyph semantics, consensus/semantic typing, current-item matching and bounded cross-item catalog shortlist diagnostics.
5. **Implemented:** explicit reviewed catalog-identity revisions with current-item confirmation, corrected cross-source selection, no-match/ambiguous outcomes, evidence snapshot and Summary visibility.
6. **Partially implemented:** queue filters and checked-item batch support exist; dedicated problem-case queue UX can still be improved.
7. **Planned after real annotation trials:** tune cascade/semantic/catalog thresholds, add curved-label/reflection recovery, implement the trainer consuming reviewed identity outcomes, refine warnings and retire any V1 compatibility readers proven unused. A new dump is needed only after shared operational rows must move to the second machine.

## Verification

Common checks:

```powershell
cd .\recognize-service
cmd /c npm run typecheck
cmd /c npm run build
```

## OCR identity and parent relation

Canonical OCR identity and structural parent semantics are separate concerns:

- `merge` means that a helper/manual observation refers to an existing canonical OCR. It never edits that entity.
- `edit_ocr` changes canonical geometry/transcription/status but does not silently change its parent.
- `reparent_ocr` changes only the Package/Label relation. Geometry is converted through source-image coordinates before it is stored in the target coordinate space.

Manual OCR creation and Auto OCR use the same persisted dedupe-run shape (`run_ocr` operation, candidate, duplicate matches, explicit accepted/merged review). A possible duplicate stays an observation and does not create a second canonical OCR until `Keep separate` is chosen. `AnnotationGraph.validation.unresolvedIdentityConflicts` is therefore a canonical-export blocker and Summary-style safety signal.

`annotation_ocr.parent_relation_*` records relation review independently from recognition GT. In graph v9 the relation always targets a Label; suggested state is retained for migrated synthetic regions and explicit Label-to-Label refinement. Parent-classifier consumers must use only `parentRelation.status = reviewed`.

OCR semantic Meta is independent from all of the above. The UI can attach multiple `{ tags, note?, source }` records directly to one OCR entity, for example `brand`, `logo`, `vintage`, `technical-text`, `curved`, `low-contrast`, `decorative` or `lettering`. Deleting a Meta record does not delete or reject the OCR region. Derived script warnings are not automatically copied into this layer.

```powershell
cd .\vinedetect_web
cmd /c npm run lint
cmd /c npm run build
```
# Label surface normalization

Reviewed Label теперь состоит из двух независимых слоёв: source-space `geometry` (quad ground truth для detector) и optional `rectification` (ground truth нормализации поверхности). `guided-cylindrical` хранит normalized guides и детерминированный sampled-grid transform. Сервер всегда заново строит OCR/CV crop из source asset; UI preview и сохранённые raster artifacts являются cache/debug output, а не canonical annotation.

`meta.image_annotations.rectification` хранит reviewed legacy-track значение, `meta.detection_proposals.rectification` зарезервирован для immutable helper suggestion, `meta.annotation_labels.rectification` переносит reviewed значение в canonical graph. Annotation graph schema для этого слоя — v5.
