"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  createAnnotationGraphLabel,
  reviewAnnotationGraphLabelCandidates,
  createAnnotationGraphMeta,
  deleteAnnotationGraphEntity,
  preflightManualAnnotationGraphOcr,
  reparentAnnotationGraphOcr,
  reviewAnnotationGraphAutoOcr,
  reviewAnnotationGraphAutoOcrActions,
  runAnnotationGraphAutoOcr,
  runAnnotationGraphLabelRectification,
  updateAnnotationGraphEntity,
  type AnnotationGraph,
  type AnnotationGraphOcr,
  type AnnotationRegionGeometry,
  type AnnotationTrack,
  type LabelRectification,
  type LabelSourceAnalysisRun,
  type LabelSourceCandidate,
  type LabelRectificationRun,
  type AutoOcrRun,
  type OcrDuplicateMatch,
  type HumanOcrEditOperation,
  type QuadGeometry,
  type RecognitionPoint,
  type SiglipLabelMode,
  type DinoLabelMode,
  type VisionEvidenceRunOptions,
} from "@/lib/admin/api";
import { RECOGNITION_LIST_TAG_MARKER, RECOGNITION_LIST_TAGS } from "./recognitionTags";
import { RawJsonBlock } from "./RawJsonBlock";
import { ImageWorkspace, type WorkspaceCanvasSize, type WorkspacePoint } from "./image-workspace/ImageWorkspace";
import { moveQuad, moveQuadCorner, pointInQuad, rectangleQuad, visualRegionOverlapRatio } from "./image-workspace/quadGeometry";
import { addHorizontalGuide, cylindricalRectification, defaultCylindricalGuides, inverseQuadUnitPoint, mapQuadUnitPoint, perspectiveRectification, removeHorizontalGuide, setCylindricalCurvature, setCylindricalHorizontalScale, updateCylindricalGuide, type CylindricalGuideHandle } from "./image-workspace/labelRectification";
import { OcrNormalizedPreview } from "./image-workspace/OcrNormalizedPreview";
import { CropPreview, FloatingZoomLens, readZoomLensState, type ZoomLensState } from "./LabelAnnotationPanel";
import { isPersistedLabelCandidateRunReviewed } from "./labelCandidateReviewState";
import { previewLabelCandidateMerges } from "./labelCandidateMerge";
import { ocrStatusForEntity, type OcrStatus } from "./ocrStatus";

const EMPTY_LABEL_CANDIDATES: LabelSourceCandidate[] = [];

type Props = {
  source: string;
  sourceItemId: string;
  token: string | null;
  graph: AnnotationGraph;
  tracks: AnnotationTrack[];
  activeTrackId: string | null;
  selectedLabelId: string | null;
  activeStage: "package" | "label" | "bottle" | "ocr" | "mask" | "morphology" | "components" | "elements" | "contours" | "palette" | "summary";
  onSelectPackage: (trackId: string) => void;
  onAddPackage: () => void;
  onDeletePackage: (packageId: string) => void;
  onSelectLabel: (labelId: string) => void;
  onOpenPackage: () => void;
  onOpenLabelStage: () => void;
  onOpenLabel: (target: AnnotationGraphLabelTarget) => void;
  disabled?: boolean;
  onChanged: () => Promise<unknown>;
  onError: (message: string) => void;
};

export type AnnotationGraphLabelTarget =
  | { mode: "existing"; id: string }
  | { mode: "new"; packageId: string };

export function AnnotationGraphLabelCollectionWorkspace({ source, sourceItemId, token, imageUrl, graph, activeTrackId, target, sourceAnalysis, disabled, onRunAuto, onCreated, onCommitted, onEdit, onManual, onChanged, onCloseEditor, onError }: {
  source: string; sourceItemId: string; token: string | null; imageUrl: string | null; graph: AnnotationGraph; activeTrackId: string | null;
  target: AnnotationGraphLabelTarget | null; sourceAnalysis: LabelSourceAnalysisRun | null; disabled?: boolean;
  onRunAuto: (visionEvidence: VisionEvidenceRunOptions) => Promise<LabelSourceAnalysisRun | null>; onCreated: (labelId: string) => void; onCommitted: (labelIds: string[]) => void; onEdit: (labelId: string) => void; onManual: () => void;
  onChanged: () => Promise<unknown>; onCloseEditor: () => void; onError: (message: string) => void;
}) {
  const activePackage = graph.packages.find((item) => item.legacyAnnotationTrackId === activeTrackId) ?? null;
  const candidates = sourceAnalysis?.candidates ?? EMPTY_LABEL_CANDIDATES;
  const semanticEvidence = sourceAnalysis?.semanticEvidence ?? null;
  const semanticMode = semanticEvidence?.mode ?? sourceAnalysis?.visionEvidenceConfig?.labelMode ?? "off";
  const runKey = sourceAnalysis?.labelStageExecution?.helperRuns.at(-1)?.id ?? sourceAnalysis?.runId ?? "none";
  const reviewIdentity = sourceAnalysis?.labelStageExecution?.id ?? runKey;
  const [locallyReviewedIdentity, setLocallyReviewedIdentity] = useState<string | null>(null);
  const reviewedRun = locallyReviewedIdentity === reviewIdentity || isPersistedLabelCandidateRunReviewed({
    packageId: activePackage?.id ?? null,
    candidateIds: candidates.map((candidate) => candidate.id),
    transientExecutionId: sourceAnalysis?.labelStageExecution?.id ?? null,
    operations: graph.operations,
  });
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [labelVisible, setLabelVisible] = useState<Record<string, boolean>>({});
  const [mergeSelected, setMergeSelected] = useState<Record<string, boolean>>({});
  const [manualMergeGroupByCandidate, setManualMergeGroupByCandidate] = useState<Record<string, string>>({});
  const [reviewGeometryByCandidate, setReviewGeometryByCandidate] = useState<Record<string, QuadGeometry>>({});
  const [mergedGeometryByGroup, setMergedGeometryByGroup] = useState<Record<string, QuadGeometry>>({});
  const [editingRoi, setEditingRoi] = useState<{ kind: "candidate"; id: string } | { kind: "merge"; id: string } | null>(null);
  const [draftQuad, setDraftQuad] = useState<QuadGeometry | null>(null);
  const [zoomLens, setZoomLens] = useState<ZoomLensState | null>(null);
  const [undoCount, setUndoCount] = useState(0);
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [siglipMode, setSiglipMode] = useState<SiglipLabelMode>(() => sourceAnalysis?.visionEvidenceConfig?.labelMode ?? "off");
  const [dinoMode, setDinoMode] = useState<DinoLabelMode>(() => sourceAnalysis?.visionEvidenceConfig?.dinoMode ?? "off");
  const manualMergeSequence = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  const undoStackRef = useRef<Array<{
    reviewGeometryByCandidate: Record<string, QuadGeometry>;
    mergedGeometryByGroup: Record<string, QuadGeometry>;
    manualMergeGroupByCandidate: Record<string, string>;
  }>>([]);

  const matches = useMemo(() => new Map(candidates.map((candidate) => {
    const quad = rectangleQuad(candidate.bbox);
    const match = (activePackage?.labels ?? []).map((label, index) => ({ label, index, ratio: label.geometry.type === "quad" ? visualRegionOverlapRatio(quad, label.geometry) : 0 }))
      .filter((item) => item.ratio >= 0.75).sort((left, right) => right.ratio - left.ratio)[0] ?? null;
    return [candidate.id, match] as const;
  })), [activePackage?.labels, candidates]);

  /* eslint-disable react-hooks/set-state-in-effect -- a new immutable helper run resets its local review draft */
  useEffect(() => {
    setSelected(Object.fromEntries(candidates.map((candidate) => [candidate.id, !matches.get(candidate.id)])));
    setVisible(Object.fromEntries(candidates.map((candidate) => [candidate.id, true])));
    setMergeSelected({});
    setManualMergeGroupByCandidate({});
    setReviewGeometryByCandidate(Object.fromEntries(candidates.map((candidate) => [candidate.id, rectangleQuad(candidate.bbox)])));
    setMergedGeometryByGroup({});
    setEditingRoi(null);
    setDraftQuad(null);
    undoStackRef.current = [];
    setUndoCount(0);
    setActiveCandidateId(candidates[0]?.id ?? null);
  }, [candidates, matches, runKey]); // A helper run is an immutable candidate set.
  /* eslint-enable react-hooks/set-state-in-effect */

  const mergePreview = useMemo(() => previewLabelCandidateMerges(candidates
    .filter((candidate) => selected[candidate.id] && !matches.get(candidate.id))
    .map((candidate) => ({ id: candidate.id, bbox: reviewGeometryByCandidate[candidate.id]?.bbox ?? candidate.bbox, manualMergeGroupId: manualMergeGroupByCandidate[candidate.id] }))),
  [candidates, manualMergeGroupByCandidate, matches, reviewGeometryByCandidate, selected]);
  const mergedPreviewGroups = mergePreview.filter((group) => group.candidateIds.length > 1);
  const mergeSelectionCount = candidates.filter((candidate) => selected[candidate.id] && mergeSelected[candidate.id] && !matches.get(candidate.id)).length;

  function mergeChosenCandidates() {
    const candidateIds = candidates.filter((candidate) => selected[candidate.id] && mergeSelected[candidate.id] && !matches.get(candidate.id)).map((candidate) => candidate.id);
    if (candidateIds.length < 2) return;
    manualMergeSequence.current += 1;
    const groupId = `manual-${manualMergeSequence.current}`;
    pushUndo();
    setManualMergeGroupByCandidate((current) => ({ ...current, ...Object.fromEntries(candidateIds.map((candidateId) => [candidateId, groupId])) }));
    setMergeSelected({});
  }

  function dissolveManualMergeGroup(groupId: string) {
    pushUndo();
    setManualMergeGroupByCandidate((current) => Object.fromEntries(Object.entries(current).filter(([, value]) => value !== groupId)));
  }

  function pushUndo() {
    undoStackRef.current.push({ reviewGeometryByCandidate, mergedGeometryByGroup, manualMergeGroupByCandidate });
    if (undoStackRef.current.length > 30) undoStackRef.current.shift();
    setUndoCount(undoStackRef.current.length);
  }

  const undoReviewDraft = useCallback(() => {
    const snapshot = undoStackRef.current.pop();
    if (!snapshot) return;
    setUndoCount(undoStackRef.current.length);
    setReviewGeometryByCandidate(snapshot.reviewGeometryByCandidate);
    setMergedGeometryByGroup(snapshot.mergedGeometryByGroup);
    setManualMergeGroupByCandidate(snapshot.manualMergeGroupByCandidate);
    setEditingRoi(null);
    setDraftQuad(null);
  }, []);

  useEffect(() => {
    function keyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && undoStackRef.current.length > 0) {
        event.preventDefault();
        undoReviewDraft();
      }
    }
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [undoReviewDraft]);

  function beginCandidateEdit(candidateId: string) {
    const candidate = candidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    setEditingRoi({ kind: "candidate", id: candidateId });
    setDraftQuad(reviewGeometryByCandidate[candidateId] ?? rectangleQuad(candidate.bbox));
  }

  function resetCandidateEdit(candidateId: string) {
    const candidate = candidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    pushUndo();
    setReviewGeometryByCandidate((current) => ({ ...current, [candidateId]: rectangleQuad(candidate.bbox) }));
  }

  function beginMergedEdit(candidateIds: string[], bbox: { x: number; y: number; width: number; height: number }) {
    const id = labelMergeGroupKey(candidateIds);
    setEditingRoi({ kind: "merge", id });
    setDraftQuad(mergedGeometryByGroup[id] ?? rectangleQuad(bbox));
  }

  function applyRoiEdit() {
    if (!editingRoi || !draftQuad) return;
    pushUndo();
    if (editingRoi.kind === "candidate") setReviewGeometryByCandidate((current) => ({ ...current, [editingRoi.id]: draftQuad }));
    else setMergedGeometryByGroup((current) => ({ ...current, [editingRoi.id]: draftQuad }));
    setEditingRoi(null);
    setDraftQuad(null);
  }

  function cancelRoiEdit() {
    setEditingRoi(null);
    setDraftQuad(null);
    setZoomLens(null);
  }

  function pointerDown(point: WorkspacePoint, _event: unknown, context: { canvas: HTMLCanvasElement; image: HTMLImageElement }) {
    if (!draftQuad) return;
    const natural = toNatural(point, context.canvas, context.image);
    const corner = hitCorner(point, draftQuad, context.canvas, context.image);
    if (corner >= 0) { dragRef.current = { kind: "corner", index: corner }; return; }
    if (pointInQuad(natural, draftQuad)) dragRef.current = { kind: "move", start: natural, initial: draftQuad };
  }

  function pointerMove(point: WorkspacePoint, event: ReactPointerEvent<HTMLCanvasElement>, context: { canvas: HTMLCanvasElement; image: HTMLImageElement }) {
    if (!editingRoi || !draftQuad) return;
    setZoomLens(readZoomLensState(point, event, context.canvas, context.image));
    const drag = dragRef.current;
    if (!drag) return;
    const natural = toNatural(point, context.canvas, context.image);
    const scope = activePackage?.scope.geometry?.bbox;
    const bounds = scope
      ? { minX: scope.x, minY: scope.y, maxX: scope.x + scope.width, maxY: scope.y + scope.height }
      : { minX: 0, minY: 0, maxX: context.image.naturalWidth, maxY: context.image.naturalHeight };
    if (drag.kind === "move") setDraftQuad(moveQuad(drag.initial, natural.x - drag.start.x, natural.y - drag.start.y, bounds));
    else if (drag.kind === "corner") setDraftQuad(moveQuadCorner(draftQuad, drag.index, natural, bounds) ?? draftQuad);
  }

  const draw = useCallback(({ canvas, image }: { canvas: HTMLCanvasElement; image: HTMLImageElement; size: WorkspaceCanvasSize }) => {
    const context = canvas.getContext("2d"); if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const [index, label] of (activePackage?.labels ?? []).entries()) {
      if (labelVisible[label.id] !== false && label.geometry.type === "quad") drawQuad(context, canvas, image, label.geometry, "#16a34a", `Label #${index + 1}`);
    }
    for (const [index, candidate] of candidates.entries()) {
      if (!visible[candidate.id] || reviewedRun) continue;
      const geometry = reviewGeometryByCandidate[candidate.id] ?? rectangleQuad(candidate.bbox);
      drawQuad(context, canvas, image, geometry, candidate.id === activeCandidateId ? "#7c3aed" : selected[candidate.id] ? "#0284c7" : "#a1a1aa", `Candidate #${index + 1}`);
    }
    for (const [index, group] of mergedPreviewGroups.entries()) {
      const groupId = labelMergeGroupKey(group.candidateIds);
      drawQuad(context, canvas, image, mergedGeometryByGroup[groupId] ?? rectangleQuad(group.bbox), "#f97316", `Merged Label #${index + 1} · ${group.mode}`);
    }
    if (draftQuad) drawQuad(context, canvas, image, draftQuad, "#16a34a", editingRoi?.kind === "merge" ? "Edit merged ROI" : "Edit candidate ROI");
  }, [activeCandidateId, activePackage?.labels, candidates, draftQuad, editingRoi?.kind, labelVisible, mergedGeometryByGroup, mergedPreviewGroups, reviewGeometryByCandidate, reviewedRun, selected, visible]);

  async function createSelected() {
    if (!token || !activePackage || !sourceAnalysis || !candidates.length) return;
    setBusy(true);
    try {
      const config = {
        ...(sourceAnalysis.labelDetection?.config ?? {}),
        visionEvidence: sourceAnalysis.visionEvidenceConfig ?? { labelMode: semanticMode, source: "server-default" },
      };
      const candidateEdited = candidates.some((candidate) => JSON.stringify(reviewGeometryByCandidate[candidate.id] ?? rectangleQuad(candidate.bbox)) !== JSON.stringify(rectangleQuad(candidate.bbox)));
      const reviewMode = candidateEdited || Object.keys(mergedGeometryByGroup).length > 0 || Object.keys(manualMergeGroupByCandidate).length > 0 ? "edited" as const : "accepted" as const;
      const result = await reviewAnnotationGraphLabelCandidates(source, sourceItemId, activePackage.id, {
        operation: {
          helperId: "label-roi-detection", helperVersion: `${sourceAnalysis.algorithm}@${sourceAnalysis.version}`,
          initialConfig: config, finalConfig: config, reviewMode,
          candidates: candidates.map((candidate) => ({ id: candidate.id, payload: candidate as unknown as Record<string, unknown>, score: candidate.score })),
        },
        reviews: candidates.map((candidate) => {
          const match = matches.get(candidate.id);
          if (!selected[candidate.id]) return { candidateId: candidate.id, state: "rejected" as const };
          if (match) return { candidateId: candidate.id, state: "merged" as const, resultEntityId: match.label.id };
          const geometry = reviewGeometryByCandidate[candidate.id] ?? rectangleQuad(candidate.bbox);
          const state = JSON.stringify(geometry) === JSON.stringify(rectangleQuad(candidate.bbox)) ? "accepted" as const : "edited" as const;
          return { candidateId: candidate.id, state, geometry, mergeGroupId: manualMergeGroupByCandidate[candidate.id] };
        }),
        mergeReviews: mergedPreviewGroups.flatMap((group) => {
          const geometry = mergedGeometryByGroup[labelMergeGroupKey(group.candidateIds)];
          return geometry ? [{ candidateIds: group.candidateIds, geometry }] : [];
        }),
      }, token);
      setLocallyReviewedIdentity(reviewIdentity);
      await onChanged();
      if (result.resultEntityIds.length) onCommitted(result.resultEntityIds);
    } catch (error) { onError(error instanceof Error ? error.message : "Label candidate review failed"); }
    finally { setBusy(false); }
  }

  if (!activePackage) return null;
  if (target) return <AnnotationGraphLabelWorkspace source={source} sourceItemId={sourceItemId} token={token} imageUrl={imageUrl} graph={graph} activeTrackId={activeTrackId}
    target={target} disabled={disabled} onCreated={(labelId) => onCommitted([labelId])} onChanged={onChanged} onClose={onCloseEditor} onError={onError} />;
  const selectedCount = candidates.filter((candidate) => selected[candidate.id]).length;
  const manualMergeGroups = [...new Set(Object.values(manualMergeGroupByCandidate))].map((groupId) => ({
    groupId,
    candidateIds: candidates.filter((candidate) => manualMergeGroupByCandidate[candidate.id] === groupId).map((candidate) => candidate.id),
  })).filter((group) => group.candidateIds.length > 1);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-sm font-semibold uppercase text-violet-800">Labels · Package collection</h3><p className="mt-1 text-xs text-zinc-500">Detect or draw visual regions, then review every Label in this shared viewer.</p></div>
      <div className="flex flex-wrap justify-end gap-2">
        <select aria-label="Label helper SigLIP2 mode" value={siglipMode} onChange={(event) => setSiglipMode(event.target.value as SiglipLabelMode)} disabled={disabled || busy} className="h-9 rounded border border-violet-300 bg-white px-2 text-xs text-violet-950 disabled:opacity-40"><option value="off">SigLIP off</option><option value="score-only">SigLIP score only</option><option value="rerank">SigLIP rerank</option></select>
        <select aria-label="Label helper DINOv3 mode" value={dinoMode} onChange={(event) => setDinoMode(event.target.value as DinoLabelMode)} disabled={disabled || busy} className="h-9 rounded border border-emerald-300 bg-white px-2 text-xs text-emerald-950 disabled:opacity-40"><option value="off">DINO off</option><option value="observe">DINO observe</option><option value="refine">DINO refine ROI</option></select>
        <button type="button" onClick={() => void onRunAuto({ labelMode: siglipMode, dinoMode })} disabled={disabled || busy} className="h-9 rounded bg-violet-700 px-4 text-xs font-semibold text-white disabled:opacity-40">{candidates.length ? "Auto detect more" : "Auto detect"}</button>
        <button type="button" onClick={onManual} disabled={disabled || busy} className="h-9 rounded border border-violet-300 bg-white px-4 text-xs font-semibold text-violet-800 disabled:opacity-40">+ Draw Label</button>
      </div>
    </div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="relative">
        <ImageWorkspace imageUrl={imageUrl} mode={editingRoi ? "roi-editor" : "viewer"} draw={draw} cursor={editingRoi ? "move" : "default"}
          onPointerDown={editingRoi ? pointerDown : undefined} onPointerMove={editingRoi ? pointerMove : undefined}
          onPointerUp={editingRoi ? () => { dragRef.current = null; } : undefined}
          onPointerLeave={editingRoi ? () => { dragRef.current = null; setZoomLens(null); } : undefined} />
        {imageUrl && editingRoi && <FloatingZoomLens imageUrl={imageUrl} lens={zoomLens} />}
      </div>
      <aside className="space-y-3">
        {editingRoi && <section className="rounded border border-emerald-300 bg-emerald-50 p-3 text-xs">
          <p className="font-semibold">{editingRoi.kind === "merge" ? "Edit merged ROI" : "Edit helper candidate"}</p>
          <p className="mt-1 text-emerald-800">Move the quad or drag any corner. The helper candidate remains immutable.</p>
          <div className="mt-3"><CropPreview imageUrl={imageUrl} rect={draftQuad?.bbox ?? null} geometry={draftQuad} /></div>
          <div className="mt-3 grid grid-cols-2 gap-2"><button type="button" onClick={applyRoiEdit} disabled={!draftQuad} className="h-8 rounded bg-emerald-700 font-semibold text-white disabled:opacity-40">Apply edit</button><button type="button" onClick={cancelRoiEdit} className="h-8 rounded border bg-white">Cancel</button></div>
        </section>}
        <section className="rounded border border-zinc-200 bg-white p-3"><div className="flex items-center justify-between"><p className="text-xs font-semibold uppercase">Labels</p><span className="text-xs text-zinc-500">{activePackage.labels.length}</span></div>
          {activePackage.labels.length === 0 ? <p className="mt-3 text-xs text-zinc-500">No Label regions yet.</p> : <div className="mt-2 space-y-2">{activePackage.labels.map((label, index) => <div key={label.id} className="flex items-center gap-2 rounded border p-2 text-xs"><input aria-label={`Show Label ${index + 1}`} title="Show overlay" type="checkbox" checked={labelVisible[label.id] !== false} onChange={(event) => setLabelVisible((current) => ({ ...current, [label.id]: event.target.checked }))} /><button type="button" onClick={() => onCreated(label.id)} className="min-w-0 flex-1 text-left"><span className="font-semibold">Label #{index + 1}</span><span className="ml-2 text-zinc-500">{label.origin} · {label.geometryReviewStatus}</span></button><button type="button" onClick={() => onEdit(label.id)} className="rounded border px-2 py-1">Edit</button></div>)}</div>}
        </section>
        {sourceAnalysis?.labelDetection?.debug.multiScaleRecovery && <LabelDetectionRecoveryPanel analysis={sourceAnalysis} />}
        {sourceAnalysis && <LabelSemanticEvidencePanel analysis={sourceAnalysis} />}
        {sourceAnalysis && <LabelStructuralEvidencePanel analysis={sourceAnalysis} />}
        {candidates.length > 0 && !reviewedRun && <section className="rounded border border-violet-200 bg-violet-50 p-3">
          <div className="flex items-center justify-between"><p className="text-xs font-semibold uppercase text-violet-900">Candidates</p><span className="text-xs text-violet-700">{selectedCount}/{candidates.length}</span></div>
          <p className="mt-1 text-[11px] text-violet-800">Partially overlapping fragments become one Label automatically. Contained alternatives stay separate; use manual merge only after review.</p>
          <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">{candidates.map((candidate, index) => {
            const match = matches.get(candidate.id);
            const candidateEdited = JSON.stringify(reviewGeometryByCandidate[candidate.id] ?? rectangleQuad(candidate.bbox)) !== JSON.stringify(rectangleQuad(candidate.bbox));
            const previewIndex = mergedPreviewGroups.findIndex((group) => group.candidateIds.includes(candidate.id));
            const previewGroup = previewIndex >= 0 ? mergedPreviewGroups[previewIndex] : null;
            return <div key={candidate.id} onMouseEnter={() => setActiveCandidateId(candidate.id)} onMouseLeave={() => setActiveCandidateId(null)} className="rounded border border-violet-200 bg-white p-2 text-xs">
              <div className="flex items-start gap-2">
                <label className="flex min-w-0 flex-1 cursor-pointer gap-2"><input aria-label={`Accept candidate ${index + 1}`} type="checkbox" checked={Boolean(selected[candidate.id])} onChange={(event) => setSelected((current) => ({ ...current, [candidate.id]: event.target.checked }))} /><span className="min-w-0 flex-1"><span className="font-semibold">Candidate #{index + 1} · {candidatePrimaryScore(candidate, semanticMode, semanticEvidence?.status)}</span><span className={`ml-2 rounded px-1 py-0.5 text-[9px] uppercase ${candidateEdited ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>{candidateEdited ? "edited" : "unchanged"}</span><CandidateGeometrySemantic candidate={candidate} /><CandidateSemanticScores candidate={candidate} mode={semanticMode} status={semanticEvidence?.status} /><CandidateStructuralScores candidate={candidate} />{match && <span className="mt-1 block text-amber-700">Matches Label #{match.index + 1} · will merge with the existing Label</span>}{previewGroup && <span className="mt-1 block font-medium text-orange-700">Merged Label #{previewIndex + 1} · {previewGroup.mode}</span>}</span></label>
                <input aria-label={`Show candidate ${index + 1}`} title="Show overlay" type="checkbox" checked={Boolean(visible[candidate.id])} onChange={(event) => setVisible((current) => ({ ...current, [candidate.id]: event.target.checked }))} />
              </div>
              {!match && selected[candidate.id] && <div className="mt-2 flex items-center justify-between gap-2 border-t border-violet-100 pt-2 text-[11px] text-violet-800"><label className="flex cursor-pointer items-center gap-2"><input aria-label={`Select candidate ${index + 1} for manual merge`} type="checkbox" checked={Boolean(mergeSelected[candidate.id])} onChange={(event) => setMergeSelected((current) => ({ ...current, [candidate.id]: event.target.checked }))} />Select for manual merge</label><span className="flex gap-1">{candidateEdited && <button type="button" onClick={() => resetCandidateEdit(candidate.id)} className="rounded border bg-white px-2 py-1">Reset</button>}<button type="button" onClick={() => beginCandidateEdit(candidate.id)} className="rounded border border-violet-300 bg-white px-2 py-1">Edit ROI</button></span></div>}
            </div>;
          })}</div>
          <div className="mt-3 rounded border border-orange-200 bg-orange-50 p-2 text-[11px] text-orange-900">
            <div className="flex items-center justify-between gap-2"><strong>Manual merge</strong><button type="button" onClick={mergeChosenCandidates} disabled={mergeSelectionCount < 2} className="rounded border border-orange-400 bg-white px-2 py-1 font-semibold disabled:opacity-40">Merge chosen ({mergeSelectionCount})</button></div>
            {manualMergeGroups.length === 0 ? <p className="mt-1 text-orange-700">Choose two or more accepted candidates when automatic intersection cannot connect them.</p> : <div className="mt-2 space-y-1">{manualMergeGroups.map((group, index) => <div key={group.groupId} className="flex items-center justify-between gap-2"><span>Group #{index + 1} · {group.candidateIds.length} regions</span><button type="button" onClick={() => dissolveManualMergeGroup(group.groupId)} className="rounded border border-orange-300 bg-white px-2 py-1">Dissolve</button></div>)}</div>}
          </div>
          {mergedPreviewGroups.length > 0 && <div className="mt-2 space-y-1 text-[11px] text-orange-800">{mergedPreviewGroups.map((group, index) => { const key = labelMergeGroupKey(group.candidateIds); return <div key={key} className="flex items-center justify-between gap-2"><span>Merged Label #{index + 1}: {group.candidateIds.length} candidates · {mergedGeometryByGroup[key] ? "edited" : group.mode}</span><button type="button" onClick={() => beginMergedEdit(group.candidateIds, group.bbox)} className="rounded border border-orange-300 bg-white px-2 py-1">Edit result</button></div>; })}</div>}
          <details className="mt-3 text-[11px] text-zinc-600"><summary className="cursor-pointer font-semibold">Algorithm config</summary><RawJsonBlock value={sourceAnalysis?.labelDetection?.config ?? {}} containerClassName="mt-2" className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950 p-2 pr-20 font-mono text-[10px] leading-4 text-zinc-100" /></details>
          <div className="mt-3 flex items-center justify-between text-[10px] text-zinc-500"><span>Ctrl+Z undoes ROI edits and merge changes</span><button type="button" onClick={undoReviewDraft} disabled={undoCount === 0} className="rounded border bg-white px-2 py-1 disabled:opacity-40">Undo</button></div>
          <button type="button" onClick={() => void createSelected()} disabled={disabled || busy || Boolean(editingRoi)} className="mt-3 h-9 w-full rounded bg-violet-700 text-xs font-semibold text-white disabled:opacity-40">Approve candidates · create {mergePreview.length} new Label{mergePreview.length === 1 ? "" : "s"}</button>
        </section>}
      </aside>
    </div>
  </div>;
}

type LabelSemanticMode = NonNullable<LabelSourceAnalysisRun["semanticEvidence"]>["mode"];
type LabelSemanticStatus = NonNullable<LabelSourceAnalysisRun["semanticEvidence"]>["status"];

function LabelDetectionRecoveryPanel({ analysis }: { analysis: LabelSourceAnalysisRun }) {
  const recovery = analysis.labelDetection?.debug.multiScaleRecovery;
  if (!recovery) return null;
  const recovered = recovery.selectedPreviewMaxSide !== null && analysis.candidates.length > 0;
  return <section className={`rounded border p-3 text-xs ${recovered ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-amber-300 bg-amber-50 text-amber-950"}`}>
    <div className="flex items-center justify-between gap-2"><strong className="uppercase">OpenCV scale recovery</strong><span>{recovered ? "recovered" : "no candidates"}</span></div>
    <p className="mt-2 leading-5">Initial {recovery.initialPreviewMaxSide}px pass returned no candidates. {recovered ? `Selected ${recovery.selectedPreviewMaxSide}px fallback.` : "All bounded fallback scales also returned empty."}</p>
    <div className="mt-2 flex flex-wrap gap-1">{recovery.attempts.map((attempt) => <span key={attempt.previewMaxSide} className="rounded bg-white/80 px-2 py-1 font-mono text-[10px]">{attempt.previewMaxSide}px · {attempt.candidateCount} · {formatScore(attempt.bestScore)}</span>)}</div>
  </section>;
}

function LabelSemanticEvidencePanel({ analysis }: { analysis: LabelSourceAnalysisRun }) {
  const evidence = analysis.semanticEvidence;
  const mode = evidence?.mode ?? analysis.visionEvidenceConfig?.labelMode ?? "off";
  const status = evidence?.status ?? "disabled";
  const description = semanticAlgorithmDescription(mode, status);
  const tone = status === "unavailable"
    ? "border-amber-300 bg-amber-50 text-amber-950"
    : mode === "rerank" && status === "available"
      ? "border-violet-300 bg-violet-50 text-violet-950"
      : mode === "score-only" && status === "available"
        ? "border-sky-300 bg-sky-50 text-sky-950"
        : "border-zinc-200 bg-zinc-50 text-zinc-700";
  return <section className={`rounded border p-3 text-xs ${tone}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong className="uppercase">Label ranking</strong>
      <span className="rounded bg-white/80 px-2 py-1 font-mono text-[10px]">{mode} · {status}</span>
    </div>
    <p className="mt-2 leading-5">{description}</p>
    <div className="mt-2 grid gap-1 text-[10px] sm:grid-cols-2">
      <span>Configured by: {analysis.visionEvidenceConfig?.source ?? "legacy / unknown"}</span>
      {evidence && <span>Concepts: {evidence.conceptSet.id}@{evidence.conceptSet.version}</span>}
      {evidence?.status === "available" && <span>Model: {shortModelName(evidence.model.id)}</span>}
      {evidence?.status === "available" && <span>Cache: {evidence.cache.hits} hit / {evidence.cache.misses} miss</span>}
    </div>
    {evidence?.error && <p className="mt-2 rounded border border-amber-300 bg-white/70 p-2 text-[10px]">{evidence.error.code}: {evidence.error.message}</p>}
    {evidence && <details className="mt-2"><summary className="cursor-pointer text-[10px] font-semibold">Raw semantic evidence</summary><RawJsonBlock value={evidence} containerClassName="mt-2" className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950 p-2 pr-20 font-mono text-[9px] leading-4 text-zinc-100" /></details>}
  </section>;
}

function LabelStructuralEvidencePanel({ analysis }: { analysis: LabelSourceAnalysisRun }) {
  const evidence = analysis.structuralEvidence;
  const mode = evidence?.mode ?? analysis.visionEvidenceConfig?.dinoMode ?? "off";
  const status = evidence?.status ?? "disabled";
  const tone = status === "unavailable"
    ? "border-amber-300 bg-amber-50 text-amber-950"
    : status === "available"
      ? "border-emerald-300 bg-emerald-50 text-emerald-950"
      : "border-zinc-200 bg-zinc-50 text-zinc-700";
  return <section className={`rounded border p-3 text-xs ${tone}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong className="uppercase">Label structure</strong>
      <span className="rounded bg-white/80 px-2 py-1 font-mono text-[10px]">{mode} · {status}</span>
    </div>
    <p className="mt-2 leading-5">{status === "available"
      ? mode === "refine" ? "DINOv3 measures structural evidence and adds boundary-snapped ROI alternatives from the imported dense grid. Originals remain available for review; ranking is unchanged." : "DINOv3 measures ROI coherence and separation from its surrounding ring. Evidence is advisory; candidate ranking is unchanged."
      : status === "unavailable"
        ? "DINOv3 was requested but unavailable. OpenCV/SigLIP candidates remain usable without structural evidence."
        : mode === "off" ? "DINOv3 dense structural evidence is off for this helper run." : "DINOv3 was requested but disabled by the server feature gate."}</p>
    {evidence?.status === "available" && <div className="mt-2 grid gap-1 text-[10px] sm:grid-cols-2">
      <span>Model: {shortModelName(evidence.model.id)}</span>
      <span>Input: {evidence.preprocessing.inputLongSide}px · patch {evidence.preprocessing.patchSize}</span>
      <span>Artifact: {evidence.artifact?.cacheHit ? "cache hit" : "created"}</span>
      <span>Grid: {evidence.artifact?.gridWidth ?? "-"}×{evidence.artifact?.gridHeight ?? "-"}×{evidence.artifact?.featureDimensions ?? "-"}</span>
      <span>Ranking applied: no</span>
      <span>ROI refinement: {mode === "refine" ? `${analysis.candidates.filter((candidate) => candidate.variant?.kind === "dino-snapped").length} alternative(s)` : "off"}</span>
      <span>Configured by: {analysis.visionEvidenceConfig?.source ?? "legacy / unknown"}</span>
    </div>}
    {evidence?.error && <p className="mt-2 rounded border border-amber-300 bg-white/70 p-2 text-[10px]">{evidence.error.code}: {evidence.error.message}</p>}
    {evidence && <details className="mt-2"><summary className="cursor-pointer text-[10px] font-semibold">Raw structural evidence</summary><RawJsonBlock value={evidence} containerClassName="mt-2" className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950 p-2 pr-20 font-mono text-[9px] leading-4 text-zinc-100" /></details>}
  </section>;
}

function CandidateSemanticScores({ candidate, mode, status }: { candidate: LabelSourceCandidate; mode: LabelSemanticMode; status?: LabelSemanticStatus }) {
  const cvScore = candidate.cvScore ?? (mode === "rerank" && candidate.fusion ? null : candidate.score);
  if (mode === "off" || mode === "proposals" || status !== "available" || !candidate.semantic) {
    return <span className="mt-1 block text-[10px] text-zinc-500">CV {formatScore(cvScore ?? candidate.score)} · rank #{candidate.ranking?.cvRank ?? "-"}{status === "unavailable" ? " · semantic fallback" : ""}</span>;
  }
  if (mode === "score-only") return <>
    <span className="mt-1 block text-[10px] text-sky-800">Applied: CV {formatScore(cvScore ?? candidate.score)} · rank #{candidate.ranking?.cvRank ?? "-"}</span>
    <span className="mt-1 block text-[10px] text-violet-700">Advisory SigLIP {formatScore(candidate.semantic.semanticScore)} · rank #{candidate.ranking?.semanticRank ?? "-"} · fusion {formatScore(candidate.fusion?.score ?? null)} not applied</span>
  </>;
  return <>
    <span className="mt-1 block text-[10px] text-violet-800">Applied: fusion {formatScore(candidate.fusion?.score ?? candidate.score)} · rank #{candidate.ranking?.fusionRank ?? "-"}</span>
    <span className="mt-1 block text-[10px] text-zinc-600">CV {formatScore(cvScore)} · rank #{candidate.ranking?.cvRank ?? "-"} · SigLIP {formatScore(candidate.semantic.semanticScore)} · rank #{candidate.ranking?.semanticRank ?? "-"}</span>
  </>;
}

function CandidateStructuralScores({ candidate }: { candidate: LabelSourceCandidate }) {
  if (!candidate.structural) return null;
  return <span className="mt-1 block text-[10px] text-emerald-700">DINOv3: coherence {formatScore(candidate.structural.regionCoherence)} · separation {formatScore(candidate.structural.foregroundSeparation)} · patches {candidate.structural.insidePatchCount}+{candidate.structural.ringPatchCount}</span>;
}

function CandidateGeometrySemantic({ candidate }: { candidate: LabelSourceCandidate }) {
  const semantic = candidate.geometrySemantic;
  if (!semantic) return null;
  const likely = semantic.verdict === "likely";
  return <span className={`mt-1 block rounded px-1.5 py-1 text-[10px] ${likely ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
    Geometry: {semantic.role} {semantic.verdict} · {formatScore(semantic.confidence)}
    <span className="mt-0.5 block opacity-80">y {formatScore(semantic.features.normalizedCenterY)} · centered {formatScore(semantic.features.horizontalCentrality)} · local width {formatScore(semantic.features.localPackageWidthRatio)} · alternatives {semantic.features.independentAlternatives}</span>
  </span>;
}

function candidatePrimaryScore(candidate: LabelSourceCandidate, mode: LabelSemanticMode, status?: LabelSemanticStatus) {
  if (mode === "rerank" && status === "available" && candidate.fusion) return `fusion ${formatScore(candidate.fusion.score)}`;
  return `CV ${formatScore(candidate.cvScore ?? candidate.score)}`;
}

function semanticAlgorithmDescription(mode: LabelSemanticMode, status: LabelSemanticStatus) {
  if (status === "unavailable") return "SigLIP2 was requested but unavailable. Candidate order and approval use the original OpenCV score.";
  if (mode === "rerank" && status === "available") return "Applied algorithm: label-fusion-v2. Candidate ordering combines 50% normalized OpenCV evidence, 35% SigLIP2 semantic evidence, and 15% contour geometry / zone confidence.";
  if (mode === "score-only" && status === "available") return "Applied algorithm: OpenCV ranking. SigLIP2 scores are advisory evidence only and do not change candidate order.";
  if (mode === "proposals") return "SigLIP region proposals are reserved and currently disabled. Candidate ordering uses OpenCV only.";
  return "Applied algorithm: OpenCV candidate ranking. SigLIP2 is off for this helper run.";
}

function formatScore(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "-" : `${Math.round(value * 1000) / 10}%`;
}

function shortModelName(value: string) {
  return value.includes("/") ? value.split("/").at(-1) ?? value : value;
}

type DragState =
  | { kind: "draw"; start: RecognitionPoint }
  | { kind: "move"; start: RecognitionPoint; initial: QuadGeometry }
  | { kind: "corner"; index: number }
  | { kind: "baseline"; center: RecognitionPoint };

function labelMergeGroupKey(candidateIds: string[]) {
  return [...candidateIds].sort().join("\u001f");
}

type AutoOcrReviewDraft = {
  state: "accepted" | "edited" | "rejected" | "merged";
  mergeGroupId?: string;
  resultEntityId: string | null;
  finalParent: { type: "label"; packageId: string; labelId: string } | null;
  geometry?: QuadGeometry;
  transcription: string | null;
  transcriptionStatus: AnnotationGraphOcr["transcription"]["status"];
  regionStatus: AnnotationGraphOcr["regionStatus"];
  layout: AnnotationGraphOcr["layout"];
  rectification: AnnotationGraphOcr["rectification"];
  editedFields?: { region: boolean; text: boolean };
  split?: { axis: "horizontal" | "vertical"; fractions: number[] };
  splitOutputs?: Array<{
    geometry: QuadGeometry;
    regionStatus: "reviewed";
    transcription: AnnotationGraphOcr["transcription"];
    layout: AnnotationGraphOcr["layout"];
    rectification: AnnotationGraphOcr["rectification"];
    confidence: number | null;
    sourceOperationId: string;
  }>;
};

type ManualDedupeConflict = {
  operationId: string;
  candidateId: string;
  parent: { type: "label"; packageId: string; labelId: string };
  matches: OcrDuplicateMatch[];
  selectedOcrId: string;
};

export function AnnotationGraphLabelWorkspace({ source, sourceItemId, token, imageUrl, graph, activeTrackId, target, disabled, onCreated, onChanged, onClose, onError }: {
  source: string; sourceItemId: string; token: string | null; imageUrl: string | null; graph: AnnotationGraph; activeTrackId: string | null;
  target: AnnotationGraphLabelTarget; disabled?: boolean; onCreated: (labelId: string) => void; onChanged: () => Promise<unknown>; onClose: () => void; onError: (message: string) => void;
}) {
  const activePackage = graph.packages.find((item) => item.legacyAnnotationTrackId === activeTrackId) ?? null;
  const existing = target.mode === "existing" ? activePackage?.labels.find((label) => label.id === target.id) ?? null : null;
  const [draftQuad, setDraftQuad] = useState<QuadGeometry | null>(() => existing?.geometry.type === "quad" ? existing.geometry : null);
  const [busy, setBusy] = useState(false);
  const [overlapWarning, setOverlapWarning] = useState<{ id: string; index: number; ratio: number } | null>(null);
  const [zoomLens, setZoomLens] = useState<ZoomLensState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const draw = useCallback(({ canvas, image }: { canvas: HTMLCanvasElement; image: HTMLImageElement; size: WorkspaceCanvasSize }) => {
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const [index, label] of (activePackage?.labels ?? []).entries()) {
      if (label.geometry.type !== "quad" || label.id === existing?.id) continue;
      drawQuad(context, canvas, image, label.geometry, "#0284c7", `L${index + 1}`);
    }
    if (draftQuad) drawQuad(context, canvas, image, draftQuad, "#16a34a", existing ? "Edit Label" : "New Label");
  }, [activePackage, draftQuad, existing]);

  function pointerDown(point: WorkspacePoint, _event: unknown, context: { canvas: HTMLCanvasElement; image: HTMLImageElement }) {
    const natural = toNatural(point, context.canvas, context.image);
    if (draftQuad) {
      const corner = hitCorner(point, draftQuad, context.canvas, context.image);
      if (corner >= 0) { dragRef.current = { kind: "corner", index: corner }; return; }
      if (pointInQuad(natural, draftQuad)) { dragRef.current = { kind: "move", start: natural, initial: draftQuad }; return; }
    }
    const clickedLabel = activePackage?.labels.find((label) => label.id !== existing?.id && label.geometry.type === "quad" && pointInQuad(natural, label.geometry));
    if (clickedLabel) {
      onCreated(clickedLabel.id);
      onClose();
      return;
    }
    dragRef.current = { kind: "draw", start: natural };
    setDraftQuad(rectangleQuad({ x: natural.x, y: natural.y, width: 1, height: 1 }));
  }

  function pointerMove(point: WorkspacePoint, event: ReactPointerEvent<HTMLCanvasElement>, context: { canvas: HTMLCanvasElement; image: HTMLImageElement }) {
    setZoomLens(readZoomLensState(point, event, context.canvas, context.image));
    const drag = dragRef.current;
    if (!drag || !activePackage) return;
    const natural = toNatural(point, context.canvas, context.image);
    const scope = activePackage.scope.geometry?.bbox;
    const bounds = scope
      ? { minX: scope.x, minY: scope.y, maxX: scope.x + scope.width, maxY: scope.y + scope.height }
      : { minX: 0, minY: 0, maxX: context.image.naturalWidth, maxY: context.image.naturalHeight };
    if (drag.kind === "draw") setDraftQuad(rectangleQuad(clampRectToWorkspace({ x: drag.start.x, y: drag.start.y, width: natural.x - drag.start.x, height: natural.y - drag.start.y }, bounds)));
    else if (drag.kind === "move") setDraftQuad(moveQuad(drag.initial, natural.x - drag.start.x, natural.y - drag.start.y, bounds));
    else if (drag.kind === "corner" && draftQuad) setDraftQuad(moveQuadCorner(draftQuad, drag.index, natural, bounds) ?? draftQuad);
  }

  async function save(force = false) {
    if (!token || !activePackage || !draftQuad || draftQuad.bbox.width < 2 || draftQuad.bbox.height < 2) return;
    if (!existing && !force) {
      const possibleDuplicate = activePackage.labels
        .map((label, index) => ({ label, index, ratio: label.geometry.type === "quad" ? visualRegionOverlapRatio(draftQuad, label.geometry) : 0 }))
        .filter((candidate) => candidate.ratio >= 0.75)
        .sort((left, right) => right.ratio - left.ratio)[0];
      if (possibleDuplicate) {
        setOverlapWarning({ id: possibleDuplicate.label.id, index: possibleDuplicate.index, ratio: possibleDuplicate.ratio });
        return;
      }
    }
    setOverlapWarning(null);
    setBusy(true);
    try {
      if (existing) await updateAnnotationGraphEntity(source, sourceItemId, "label", existing.id, { geometry: draftQuad, status: "reviewed" }, token);
      else {
        const created = await createAnnotationGraphLabel(source, sourceItemId, activePackage.id, draftQuad, token);
        await onChanged();
        onCreated(created.id);
        return;
      }
      await onChanged();
      if (existing) onClose();
    } catch (error) { onError(error instanceof Error ? error.message : "Label graph save failed"); }
    finally { setBusy(false); }
  }

  if (!activePackage) return null;
  return <div className="space-y-3">
    <div><h3 className="text-sm font-semibold uppercase text-violet-800">{existing ? "Edit Label ROI" : "New Label ROI"}</h3><p className="mt-1 text-xs text-zinc-500">Source-image quad constrained to the selected Package scope.</p></div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="relative">
        <ImageWorkspace imageUrl={imageUrl} mode="roi-editor" draw={draw} cursor="crosshair" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { dragRef.current = null; }} onPointerLeave={() => { dragRef.current = null; setZoomLens(null); }} />
        {imageUrl && <FloatingZoomLens imageUrl={imageUrl} lens={zoomLens} />}
      </div>
      <div className="rounded border border-zinc-200 p-3 text-xs">
        <p className="font-semibold">{existing ? "Adjust the reviewed quad" : "Draw the Label quad"}</p>
        <p className="mt-1 text-zinc-500">Drag empty space to draw, inside to move, or any corner to reshape.</p>
        <p className="mt-3 font-mono text-[11px] text-zinc-600">{draftQuad ? `${Math.round(draftQuad.bbox.x)}, ${Math.round(draftQuad.bbox.y)} · ${Math.round(draftQuad.bbox.width)}×${Math.round(draftQuad.bbox.height)}` : "No geometry"}</p>
        {overlapWarning && <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-amber-950">
          <p className="font-semibold">Possible overlapping Label #{overlapWarning.index + 1}</p>
          <p className="mt-1 text-[11px]">The new ROI overlaps {Math.round(overlapWarning.ratio * 100)}% of the smaller region. Labels are not auto-merged.</p>
          <div className="mt-2 grid gap-2">
            <button type="button" onClick={() => void save(true)} className="h-8 rounded bg-amber-700 font-semibold text-white">Create anyway</button>
            <button type="button" onClick={() => { onCreated(overlapWarning.id); onClose(); }} className="h-8 rounded border border-amber-400 bg-white font-semibold">Edit existing</button>
          </div>
        </div>}
        <div className="mt-3"><CropPreview imageUrl={imageUrl} rect={draftQuad?.bbox ?? null} geometry={draftQuad} /></div>
        <div className="mt-4 grid gap-2"><button type="button" onClick={() => void save()} disabled={disabled || busy || !draftQuad} className="h-9 rounded bg-emerald-700 font-semibold text-white disabled:opacity-40">Save Label</button><button type="button" onClick={onClose} className="h-9 rounded border">Cancel</button></div>
      </div>
    </div>
  </div>;
}

export function AnnotationGraphManager({ graph, tracks, activeTrackId, selectedLabelId, activeStage, onSelectPackage, onAddPackage, onDeletePackage, onSelectLabel, onOpenPackage, onOpenLabelStage, onOpenLabel, disabled }: Props) {
  const activePackage = graph.packages.find((item) => item.legacyAnnotationTrackId === activeTrackId) ?? null;
  if (!activePackage) return null;
  const activePackageId = activePackage.id;
  const selectedLabel = activePackage.labels.find((label) => label.id === selectedLabelId)
    ?? activePackage.labels.find((label) => label.legacyManaged)
    ?? activePackage.labels[0]
    ?? null;

  function selectLabel(id: string) {
    onSelectLabel(id);
  }

  return (
      <div className="flex flex-wrap items-stretch gap-2">
        <div className={`flex min-w-[13rem] overflow-hidden rounded border ${activeStage === "package" ? "border-orange-500 ring-1 ring-orange-100" : "border-zinc-300"}`}>
          <button type="button" onClick={onOpenPackage} className={`h-9 shrink-0 px-3 text-xs font-semibold ${activeStage === "package" ? "bg-orange-600 text-white" : "bg-white text-zinc-800 hover:bg-zinc-50"}`}>1 Package</button>
          <select aria-label="Current Package" value={activeTrackId ?? ""} onChange={(event) => onSelectPackage(event.target.value)} disabled={disabled} className="h-9 min-w-0 flex-1 border-l border-zinc-200 bg-white px-2 text-xs font-semibold disabled:opacity-40">
            {tracks.map((track) => <option key={track.id} value={track.id}>Package #{track.ordinal}</option>)}
          </select>
          <button type="button" aria-label="Add Package" title="Add Package" onClick={onAddPackage} disabled={disabled} className="h-9 border-l border-zinc-200 bg-zinc-50 px-2.5 text-sm font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40">+</button>
          <button type="button" aria-label="Delete current Package" title="Delete current Package" onClick={() => onDeletePackage(activePackageId)} disabled={disabled} className="h-9 border-l border-zinc-200 bg-white px-2.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-40">×</button>
        </div>
        <div className={`flex overflow-hidden rounded border ${activeStage === "label" ? "min-w-[14rem] border-violet-500 ring-1 ring-violet-100" : activeStage === "package" ? "border-zinc-300" : "min-w-[14rem] border-zinc-300"}`}>
          <button type="button" onClick={onOpenLabelStage} className={`h-9 shrink-0 px-3 text-xs font-semibold ${activeStage === "label" ? "bg-violet-700 text-white" : "bg-white text-zinc-800 hover:bg-zinc-50"}`}>2 Label</button>
          {activeStage !== "package" && <select aria-label="Current Label" value={selectedLabel?.id ?? ""} onChange={(event) => event.target.value === "__add__" ? onOpenLabel({ mode: "new", packageId: activePackageId }) : selectLabel(event.target.value)} disabled={disabled} className="h-9 min-w-0 flex-1 border-l border-zinc-200 bg-white px-2 text-xs font-semibold disabled:opacity-40">
            {!selectedLabel && <option value="" disabled>No label selected</option>}
            {activePackage.labels.map((label, index) => <option key={label.id} value={label.id}>Label #{index + 1} · {label.geometryReviewStatus} · {labelProgressCount(label)}/8</option>)}
            <option value="__add__">+ Add Label</option>
          </select>}
        </div>
      </div>
  );
}

export function AnnotationGraphStageControls({ source, sourceItemId, token, graph, activeTrackId, selectedLabelId, activeStage, disabled, onChanged, onError }: Pick<Props, "source" | "sourceItemId" | "token" | "graph" | "activeTrackId" | "selectedLabelId" | "activeStage" | "disabled" | "onChanged" | "onError">) {
  const activePackage = graph.packages.find((item) => item.legacyAnnotationTrackId === activeTrackId) ?? null;
  const [metaNote, setMetaNote] = useState("");
  const [metaTags, setMetaTags] = useState("");
  const [busy, setBusy] = useState(false);
  if (!activePackage) return null;
  const activePackageId = activePackage.id;
  const selectedLabel = activePackage.labels.find((label) => label.id === selectedLabelId)
    ?? activePackage.labels.find((label) => label.legacyManaged)
    ?? activePackage.labels[0]
    ?? null;
  const metaOwner = activeStage === "label"
    ? selectedLabel ? { type: "label" as const, id: selectedLabel.id, name: "Label", items: selectedLabel.meta } : null
    : activeStage === "package" ? { type: "package" as const, id: activePackageId, name: "Package", items: activePackage.meta } : null;

  async function savePackageType(value: AnnotationGraph["packages"][number]["packageType"]["value"]) {
    if (!token) return;
    setBusy(true);
    try {
      await updateAnnotationGraphEntity(source, sourceItemId, "package", activePackageId, { packageType: { value, status: "reviewed", source: "human" } }, token);
      await onChanged();
    } catch (error) { onError(error instanceof Error ? error.message : "Package type save failed"); }
    finally { setBusy(false); }
  }

  async function removeLabel(id: string) {
    if (!token || !window.confirm("Delete this additional Label and its child OCR/Meta? Operation history will be retained.")) return;
    setBusy(true);
    try { await deleteAnnotationGraphEntity(source, sourceItemId, "label", id, token); await onChanged(); }
    catch (error) { onError(error instanceof Error ? error.message : "Label delete failed"); }
    finally { setBusy(false); }
  }

  async function addMeta() {
    if (!token || !metaOwner || !metaNote.trim()) return;
    setBusy(true);
    try {
      await createAnnotationGraphMeta(source, sourceItemId, { targetType: metaOwner.type, targetId: metaOwner.id, note: metaNote.trim(), tags: metaTags.split(",").map((tag) => tag.trim()).filter(Boolean) }, token);
      await onChanged(); setMetaNote(""); setMetaTags("");
    } catch (error) { onError(error instanceof Error ? error.message : "Meta save failed"); }
    finally { setBusy(false); }
  }

  async function removeMeta(id: string) {
    if (!token) return;
    setBusy(true);
    try { await deleteAnnotationGraphEntity(source, sourceItemId, "meta", id, token); await onChanged(); }
    catch (error) { onError(error instanceof Error ? error.message : "Meta delete failed"); }
    finally { setBusy(false); }
  }

  async function toggleRecognitionTag(tag: string, label: string) {
    if (!token) return;
    const existing = graph.meta.find((meta) => meta.tags.includes(RECOGNITION_LIST_TAG_MARKER) && meta.tags.includes(tag));
    setBusy(true);
    try {
      if (existing) await deleteAnnotationGraphEntity(source, sourceItemId, "meta", existing.id, token);
      else await createAnnotationGraphMeta(source, sourceItemId, {
        targetType: "item",
        targetId: null,
        note: `Recognition list tag: ${label}`,
        tags: [RECOGNITION_LIST_TAG_MARKER, tag],
      }, token);
      await onChanged();
    } catch (error) { onError(error instanceof Error ? error.message : "Recognition tag save failed"); }
    finally { setBusy(false); }
  }

  return <section className="space-y-2">

      {activeStage === "summary" && <section className="rounded border border-violet-200 bg-violet-50 p-3">
        <div className="text-[10px] font-semibold uppercase text-violet-800">Recognition tags</div>
        <p className="mt-1 text-xs text-violet-900">These item tags are shown and filterable in the Recognition list. Workflow progress and provenance remain derived.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {RECOGNITION_LIST_TAGS.map((tag) => {
            const checked = graph.meta.some((meta) => meta.tags.includes(RECOGNITION_LIST_TAG_MARKER) && meta.tags.includes(tag.value));
            return <label key={tag.value} className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-xs font-medium ${checked ? "border-violet-600 bg-white text-violet-900" : "border-violet-200 bg-violet-100/50 text-violet-700"}`}>
              <input type="checkbox" checked={checked} disabled={disabled || busy} onChange={() => void toggleRecognitionTag(tag.value, tag.label)} />
              {tag.label}
            </label>;
          })}
          {graph.meta.some((meta) => meta.tags.includes("multipackage")) && <span className="rounded border border-orange-300 bg-orange-50 px-3 py-2 text-xs font-medium text-orange-800">Multipackage · automatic</span>}
        </div>
      </section>}

      {activeStage === "package" && <section className="rounded border border-orange-200 bg-orange-50 p-3">
        <label className="grid gap-1 text-[10px] font-semibold uppercase text-orange-800">Package type
          <select value={activePackage.packageType.value} onChange={(event) => void savePackageType(event.target.value as AnnotationGraph["packages"][number]["packageType"]["value"])} disabled={disabled || busy} className="h-9 rounded border border-orange-300 bg-white px-2 text-sm normal-case text-zinc-950"><option value="unknown">Unknown</option><option value="bottle">Bottle</option><option value="tube">Tube</option><option value="box">Box</option><option value="other">Other</option></select>
        </label>
      </section>}

      {activeStage === "label" && selectedLabel && !selectedLabel.legacyManaged && <div className="flex justify-end"><button type="button" onClick={() => removeLabel(selectedLabel.id)} className="h-8 rounded border border-red-200 bg-white px-3 text-xs text-red-700">Delete selected Label</button></div>}

      {(activeStage === "package" || activeStage === "label") && metaOwner && <details className="rounded border border-zinc-200 bg-white px-3 py-2">
        <summary className="cursor-pointer text-xs font-semibold">{metaOwner.name} Meta · {metaOwner.items.length}</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto]"><input value={metaNote} onChange={(event) => setMetaNote(event.target.value)} placeholder={`${metaOwner.name} note`} className="h-8 rounded border px-2 text-xs" /><input value={metaTags} onChange={(event) => setMetaTags(event.target.value)} placeholder="tags" className="h-8 rounded border px-2 text-xs" /><button type="button" onClick={addMeta} disabled={!metaNote.trim() || busy} className="h-8 rounded bg-zinc-900 px-3 text-xs font-semibold text-white disabled:opacity-40">Add</button></div>
        {metaOwner.items.map((meta) => <div key={meta.id} className="mt-2 flex justify-between gap-2 rounded bg-zinc-50 p-2 text-xs"><span>{meta.note}{meta.tags.length ? ` · ${meta.tags.join(", ")}` : ""}</span><button type="button" onClick={() => removeMeta(meta.id)} className="text-red-700">Del</button></div>)}
      </details>}
    </section>;
}

export function AnnotationGraphOcrWorkspace({ source, sourceItemId, token, imageUrl, graph, activeTrackId, target, labelCrop, disabled, onClose, onContinue, onChanged, onError }: {
  source: string; sourceItemId: string; token: string | null; imageUrl: string | null; graph: AnnotationGraph; activeTrackId: string | null;
  target: { type: "label"; id: string };
  labelCrop?: { imageUrl: string; revision: number; width: number; height: number } | null;
  disabled?: boolean; onClose: () => void; onContinue?: () => void; onChanged: () => Promise<unknown>; onError: (message: string) => void;
}) {
  const activePackage = graph.packages.find((item) => item.legacyAnnotationTrackId === activeTrackId) ?? null;
  if (!activePackage) return null;
  const targetLabel = activePackage.labels.find((label) => label.id === target.id) ?? null;
  if (!targetLabel || targetLabel.geometry.type !== "quad") return null;
  const crop = targetLabel?.legacyManaged ? labelCrop ?? null : null;
  return <GraphOcrEditor
    key={`${target.type}:${target.id}`}
    source={source} sourceItemId={sourceItemId} token={token} target={target}
    imageUrl={targetLabel.legacyManaged ? crop?.imageUrl ?? null : null}
    sourceImageUrl={imageUrl}
    label={{ ...targetLabel, geometry: targetLabel.geometry as QuadGeometry }}
    crop={crop}
    packageGeometry={activePackage.scope.geometry}
    labels={activePackage.labels.flatMap((label, index) => label.geometry.type === "quad" ? [{ id: label.id, name: `Label ${index + 1}`, geometry: label.geometry }] : [])}
    initialRun={latestAutoOcrRun(graph.operations, target, targetLabel.revision, targetLabel.rectification)}
    initialViewer={latestAutoOcrViewer(graph.operations, target, targetLabel.revision, targetLabel.rectification)}
    initialRectificationRun={latestLabelRectificationRun(graph.operations, target, targetLabel.revision)}
    items={targetLabel?.ocr ?? []}
    operations={graph.operations}
    compositions={targetLabel?.ocrCompositions ?? []}
    disabled={disabled} onClose={onClose} onContinue={onContinue} onChanged={onChanged} onError={onError}
  />;
}

function GraphOcrEditor({ source, sourceItemId, token, target, imageUrl, sourceImageUrl, label, crop, packageGeometry, labels, initialRun, initialViewer, initialRectificationRun, items, operations, compositions, disabled, onClose, onContinue, onChanged, onError }: {
  source: string; sourceItemId: string; token: string | null;
  target: { type: "label"; id: string };
  imageUrl: string | null;
  sourceImageUrl: string | null;
  label: AnnotationGraph["packages"][number]["labels"][number] & { geometry: QuadGeometry };
  crop: { imageUrl: string; revision: number; width: number; height: number } | null;
  packageGeometry: AnnotationRegionGeometry | null;
  labels: Array<{ id: string; name: string; geometry: QuadGeometry }>;
  initialRun: AutoOcrRun | null;
  initialViewer: AutoOcrRun["viewer"] | null;
  initialRectificationRun: LabelRectificationRun | null;
  items: AnnotationGraphOcr[]; disabled?: boolean;
  operations: AnnotationGraph["operations"];
  compositions: NonNullable<AnnotationGraph["packages"][number]["labels"][number]["ocrCompositions"]>;
  onClose: () => void; onContinue?: () => void; onChanged: () => Promise<unknown>; onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<QuadGeometry | null>(null);
  const [phase, setPhase] = useState<"normalization" | "regions">("normalization");
  const [labelGeometryDraft, setLabelGeometryDraft] = useState<QuadGeometry>(label.geometry);
  const [labelRectificationDraft, setLabelRectificationDraft] = useState<LabelRectification | null>(() => label.rectification ?? null);
  const [normalizationZoomLens, setNormalizationZoomLens] = useState<ZoomLensState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [transcriptionStatus, setTranscriptionStatus] = useState<AnnotationGraphOcr["transcription"]["status"]>("verified");
  const [layout, setLayout] = useState<AnnotationGraphOcr["layout"]>(() => defaultOcrLayout());
  const [rectification, setRectification] = useState<AnnotationGraphOcr["rectification"]>(null);
  const [transcription, setTranscription] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoRun, setAutoRun] = useState<AutoOcrRun | null>(initialRun);
  const [rectificationRun, setRectificationRun] = useState<LabelRectificationRun | null>(initialRectificationRun);
  const [selectedRectificationCandidateId, setSelectedRectificationCandidateId] = useState<string | null>(() => initialRectificationRun?.candidates.find((candidate) => candidate.payload.diagnostics.recommended)?.id ?? null);
  const [autoReviews, setAutoReviews] = useState<Record<string, AutoOcrReviewDraft>>(() => initialAutoReviews(initialRun));
  const [selectedAutoCandidateIds, setSelectedAutoCandidateIds] = useState<string[]>([]);
  const [editingAutoCandidateId, setEditingAutoCandidateId] = useState<string | null>(null);
  const [showRejectedCandidates, setShowRejectedCandidates] = useState(false);
  const [autoCompositions, setAutoCompositions] = useState<Array<{ sourceOperationId: string; memberSourceOperationIds: string[]; text: string | null; transcriptionStatus: "verified" | "partial" | "unreadable"; sortOrder: number }>>([]);
  const [decomposeCompositionIds, setDecomposeCompositionIds] = useState<string[]>([]);
  const [manualConflict, setManualConflict] = useState<ManualDedupeConflict | null>(null);
  const [reparentTargets, setReparentTargets] = useState<Record<string, string>>({});
  const dragRef = useRef<DragState | null>(null);
  const normalizationDragRef = useRef<({ kind: "guide"; handle: CylindricalGuideHandle } | { kind: "corner"; index: number } | { kind: "move"; start: RecognitionPoint; initial: QuadGeometry }) | null>(null);
  const viewer = autoRun?.viewer ?? initialViewer;
  const editorCrop = useMemo(() => ({
    width: viewer?.width ?? crop?.width ?? 1,
    height: viewer?.height ?? crop?.height ?? 1,
  }), [crop, viewer]);
  const viewerImageUrl = viewer?.assetPath ? annotationAssetUrl(viewer.assetPath) : imageUrl;
  const normalizationDirty = JSON.stringify(labelGeometryDraft) !== JSON.stringify(label.geometry)
    || JSON.stringify(labelRectificationDraft) !== JSON.stringify(label.rectification);
  const currentItems = useMemo(() => items.filter((item) => item.coordinateSpace.type !== "label-rectified"
    || item.coordinateSpace.cropRevision === label.revision
    || (item.coordinateSpace.cropRevision === null && label.rectification === null)), [items, label.rectification, label.revision]);
  const staleItemCount = items.length - currentItems.length;
  const selectedRectificationCandidate = rectificationRun?.candidates.find((candidate) => candidate.id === selectedRectificationCandidateId) ?? null;
  const rejectedAutoCandidateCount = autoRun?.candidates.filter((candidate) => autoReviews[candidate.id]?.state === "rejected").length ?? 0;

  const drawNormalization = useCallback(({ canvas, image }: { canvas: HTMLCanvasElement; image: HTMLImageElement; size: WorkspaceCanvasSize }) => {
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (packageGeometry) drawScopeShade(context, canvas, image, packageGeometry);
    if (rectificationRun) drawQuad(context, canvas, image, label.geometry, "#71717a", "Original");
    const normalizationLabel = labelRectificationDraft?.type === "guided-cylindrical"
      ? "Label · cylindrical"
      : labelRectificationDraft?.type === "perspective"
        ? "Label · perspective"
        : "Label · original";
    drawQuad(context, canvas, image, labelGeometryDraft, "#7c3aed", normalizationLabel);
    if (labelRectificationDraft?.type === "guided-cylindrical") drawCylindricalGuideOverlay(context, canvas, image, labelGeometryDraft, labelRectificationDraft);
  }, [label.geometry, labelGeometryDraft, labelRectificationDraft, packageGeometry, rectificationRun]);

  function chooseRectificationCandidate(candidateId: string) {
    const candidate = rectificationRun?.candidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    setSelectedRectificationCandidateId(candidate.id);
    setLabelGeometryDraft(candidate.payload.geometry);
    setLabelRectificationDraft(candidate.payload.rectification);
  }

  async function runRectification() {
    if (!token) return;
    setBusy(true);
    try {
      const result = await runAnnotationGraphLabelRectification(source, sourceItemId, target, token);
      setRectificationRun(result);
      const candidate = result.candidates.find((item) => item.payload.diagnostics.recommended) ?? result.candidates[0] ?? null;
      if (candidate) {
        setSelectedRectificationCandidateId(candidate.id);
        setLabelGeometryDraft(candidate.payload.geometry);
        setLabelRectificationDraft(candidate.payload.rectification);
      }
    } catch (error) { onError(error instanceof Error ? error.message : "Label correction helper failed"); }
    finally { setBusy(false); }
  }

  function normalizationPointerDown(point: WorkspacePoint, _event: unknown, context: { canvas: HTMLCanvasElement; image: HTMLImageElement }) {
    if (labelRectificationDraft?.type === "guided-cylindrical") {
      const handle = hitCylindricalGuide(point, context.canvas, context.image, labelGeometryDraft, labelRectificationDraft);
      if (handle) normalizationDragRef.current = { kind: "guide", handle };
      return;
    }
    const corner = hitCorner(point, labelGeometryDraft, context.canvas, context.image);
    if (corner >= 0) { normalizationDragRef.current = { kind: "corner", index: corner }; return; }
    const natural = toNatural(point, context.canvas, context.image);
    if (pointInQuad(natural, labelGeometryDraft)) normalizationDragRef.current = { kind: "move", start: natural, initial: labelGeometryDraft };
  }

  function normalizationPointerMove(point: WorkspacePoint, event: ReactPointerEvent<HTMLCanvasElement>, context: { canvas: HTMLCanvasElement; image: HTMLImageElement }) {
    setNormalizationZoomLens(readZoomLensState(point, event, context.canvas, context.image));
    const drag = normalizationDragRef.current;
    if (!drag) return;
    const natural = toNatural(point, context.canvas, context.image);
    if (drag.kind === "guide" && labelRectificationDraft?.type === "guided-cylindrical") {
      setLabelRectificationDraft(updateCylindricalGuide(labelRectificationDraft, drag.handle, inverseQuadUnitPoint(labelGeometryDraft.points, natural)));
      return;
    }
    if (labelRectificationDraft === null) setLabelRectificationDraft(perspectiveRectification());
    const scope = packageGeometry?.bbox;
    const bounds = scope
      ? { minX: scope.x, minY: scope.y, maxX: scope.x + scope.width, maxY: scope.y + scope.height }
      : { minX: 0, minY: 0, maxX: context.image.naturalWidth, maxY: context.image.naturalHeight };
    if (drag.kind === "move") setLabelGeometryDraft(moveQuad(drag.initial, natural.x - drag.start.x, natural.y - drag.start.y, bounds));
    else if (drag.kind === "corner") setLabelGeometryDraft((current) => moveQuadCorner(current, drag.index, natural, bounds) ?? current);
  }

  async function saveNormalization() {
    if (!token) return;
    if (!normalizationDirty) { setPhase("regions"); return; }
    setBusy(true);
    try {
      const candidateUnchanged = selectedRectificationCandidate
        && JSON.stringify(labelGeometryDraft) === JSON.stringify(selectedRectificationCandidate.payload.geometry)
        && JSON.stringify(labelRectificationDraft) === JSON.stringify(selectedRectificationCandidate.payload.rectification);
      const operation = rectificationRun && selectedRectificationCandidate ? {
        helperId: rectificationRun.helper.id,
        helperVersion: rectificationRun.helper.version,
        initialConfig: rectificationRun.config,
        finalConfig: {
          ...rectificationRun.config,
          ...(labelRectificationDraft?.type === "guided-cylindrical" ? { reviewedCylindricalControls: labelRectificationDraft.controls } : {}),
        },
        candidates: rectificationRun.candidates.map((candidate) => ({ id: candidate.id, payload: candidate.payload as unknown as Record<string, unknown>, score: candidate.score })),
        selectedCandidateId: selectedRectificationCandidate.id,
        reviewMode: candidateUnchanged ? "accepted" as const : "edited" as const,
      } : undefined;
      await updateAnnotationGraphEntity(source, sourceItemId, "label", label.id, {
        geometry: labelGeometryDraft,
        rectification: labelRectificationDraft,
        status: "reviewed",
      }, token, operation);
      await onChanged();
      setAutoRun(null); setAutoReviews({}); setAutoCompositions([]); setDecomposeCompositionIds([]); clearDraft();
      setPhase("regions");
    } catch (error) { onError(error instanceof Error ? error.message : "Label normalization save failed"); }
    finally { setBusy(false); }
  }

  function setLinearAngle(angle: number) {
    const normalized = normalizeDegrees(angle);
    setLayout((current) => ({ ...current, flow: "linear", baselineAngleDeg: normalized, baseline: null,
      characterOrientation: current.characterOrientation === "tangent-aligned" ? "aligned" : current.characterOrientation }));
    setRectification(Math.abs(normalized) < 0.05 ? null : { type: "rotation", angleDeg: -normalized });
  }

  const draw = useCallback(({ canvas, image }: { canvas: HTMLCanvasElement; image: HTMLImageElement; size: WorkspaceCanvasSize }) => {
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    autoRun?.candidates.forEach((candidate, index) => {
      const review = autoReviews[candidate.id];
      if (review?.state === "rejected") return;
      if (review?.splitOutputs?.length) {
        review.splitOutputs.forEach((output, outputIndex) => drawQuad(context, canvas, image, scaleQuad(output.geometry, editorCrop.width, editorCrop.height), "#0284c7", `C${index + 1}.${outputIndex + 1}`));
        return;
      }
      const geometry = scaleQuad(review?.geometry ?? candidate.payload.geometry, editorCrop.width, editorCrop.height);
      drawQuad(context, canvas, image, geometry, review?.state === "edited" ? "#d97706" : "#7c3aed", `C${index + 1}`);
    });
    currentItems.forEach((item, index) => drawQuad(context, canvas, image, displayOcrGeometry(item, editorCrop), item.legacyManaged ? "#a16207" : item.id === editingId ? "#7c3aed" : "#0284c7", `T${index + 1}`));
    if (draft) { drawQuad(context, canvas, image, draft, "#16a34a", editingAutoCandidateId ? "Candidate edit" : editingId ? "Edit" : "New"); drawBaselineHandle(context, canvas, image, draft, layout.baselineAngleDeg); }
  }, [autoReviews, autoRun, currentItems, draft, editingAutoCandidateId, editingId, editorCrop, layout.baselineAngleDeg]);

  function pointerDown(point: WorkspacePoint, _event: unknown, context: { canvas: HTMLCanvasElement; image: HTMLImageElement }) {
    const natural = toNatural(point, context.canvas, context.image);
    if (draft) {
      if (hitBaselineHandle(point, draft, layout.baselineAngleDeg, context.canvas, context.image)) { dragRef.current = { kind: "baseline", center: quadCenter(draft) }; return; }
      const corner = hitCorner(point, draft, context.canvas, context.image);
      if (corner >= 0) { dragRef.current = { kind: "corner", index: corner }; return; }
      if (pointInQuad(natural, draft)) { dragRef.current = { kind: "move", start: natural, initial: draft }; return; }
    }
    dragRef.current = { kind: "draw", start: natural };
    setEditingId(null); setDraft(rectangleQuad({ x: natural.x, y: natural.y, width: 1, height: 1 }));
  }

  function pointerMove(point: WorkspacePoint, _event: unknown, context: { canvas: HTMLCanvasElement; image: HTMLImageElement }) {
    const drag = dragRef.current;
    if (!drag) return;
    const natural = toNatural(point, context.canvas, context.image);
    const bounds = { minX: 0, minY: 0, maxX: context.image.naturalWidth, maxY: context.image.naturalHeight };
    if (drag.kind === "baseline") setLinearAngle(Math.atan2(natural.y - drag.center.y, natural.x - drag.center.x) * 180 / Math.PI);
    else if (drag.kind === "draw") setDraft(rectangleQuad(clampRectToWorkspace({ x: drag.start.x, y: drag.start.y, width: natural.x - drag.start.x, height: natural.y - drag.start.y }, bounds)));
    else if (drag.kind === "move") setDraft(moveQuad(drag.initial, natural.x - drag.start.x, natural.y - drag.start.y, bounds));
    else if (drag.kind === "corner" && draft) setDraft(moveQuadCorner(draft, drag.index, natural, bounds) ?? draft);
  }

  function edit(item: AnnotationGraphOcr) {
    if (item.legacyManaged) return;
    setEditingId(item.id); setDraft(displayOcrGeometry(item, editorCrop)); setTranscriptionStatus(item.transcription.status); setTranscription(item.transcription.text ?? ""); setLayout(item.layout); setRectification(item.rectification);
  }

  function clearDraft() { setEditingId(null); setEditingAutoCandidateId(null); setDraft(null); setTranscriptionStatus("verified"); setTranscription(""); setLayout(defaultOcrLayout()); setRectification(null); setManualConflict(null); }

  async function runAuto() {
    if (!token) return;
    setBusy(true);
    try {
      const result = await runAnnotationGraphAutoOcr(source, sourceItemId, target, token);
      const initial = initialAutoReviews(result);
      setAutoRun(result); setAutoReviews(initial); setSelectedAutoCandidateIds([]); setAutoCompositions([]); setDecomposeCompositionIds([]); clearDraft();
    } catch (error) { onError(error instanceof Error ? error.message : "Auto OCR failed"); }
    finally { setBusy(false); }
  }

  function editAutoCandidate(candidateId: string) {
    const candidate = autoRun?.candidates.find((item) => item.id === candidateId);
    const review = autoReviews[candidateId];
    if (!candidate || !review || review.state === "rejected") return;
    setEditingId(null); setEditingAutoCandidateId(candidateId);
    setDraft(scaleQuad(review.geometry ?? candidate.payload.geometry, editorCrop.width, editorCrop.height));
    setTranscription(review.transcription ?? ""); setTranscriptionStatus(review.transcriptionStatus); setLayout(review.layout); setRectification(review.rectification);
  }

  function rejectAutoCandidate(candidateId: string) {
    setAutoReviews((current) => ({ ...current, [candidateId]: { ...current[candidateId]!, state: "rejected", mergeGroupId: undefined, split: undefined, splitOutputs: undefined, editedFields: undefined, resultEntityId: null, finalParent: null } }));
    setSelectedAutoCandidateIds((current) => current.filter((id) => id !== candidateId));
    setAutoCompositions((current) => current.filter((composition) => !composition.memberSourceOperationIds.includes(candidateId)));
    if (editingAutoCandidateId === candidateId) clearDraft();
  }

  function splitSelectedAutoCandidate(axis: "horizontal" | "vertical") {
    if (!autoRun || selectedAutoCandidateIds.length !== 1) return;
    const candidateId = selectedAutoCandidateIds[0]!;
    const candidate = autoRun.candidates.find((item) => item.id === candidateId);
    const review = autoReviews[candidateId];
    if (!candidate || !review || review.state === "rejected") return;
    if (autoCompositions.some((composition) => composition.memberSourceOperationIds.includes(candidateId))) {
      onError("decompose_string before splitting a region that belongs to a semantic composition");
      return;
    }
    const sourceOperationId = `human-split-${crypto.randomUUID()}`;
    const geometries = splitQuadGeometry(review.geometry ?? candidate.payload.geometry, axis, 0.5);
    setAutoReviews((current) => ({ ...current, [candidateId]: {
      ...review, state: "edited", mergeGroupId: undefined, resultEntityId: null, finalParent: candidate.payload.suggestedParent,
      geometry: undefined, editedFields: undefined, split: { axis, fractions: [0.5] },
      splitOutputs: geometries.map((geometry, index) => ({
        geometry, regionStatus: "reviewed", transcription: { text: null, status: "unreadable" },
        layout: review.layout, rectification: review.rectification, confidence: null,
        sourceOperationId: `${sourceOperationId}:${index + 1}`,
      })),
    } }));
    setSelectedAutoCandidateIds([]);
  }

  function joinSelectedAutoCandidates() {
    if (!autoRun || selectedAutoCandidateIds.length < 2) return;
    if (autoCompositions.some((composition) => composition.memberSourceOperationIds.some((id) => selectedAutoCandidateIds.includes(id)))) {
      onError("Remove the semantic composition before merge_region");
      return;
    }
    const selectedIds = new Set(selectedAutoCandidateIds);
    const mergeGroupId = crypto.randomUUID();
    setAutoReviews((current) => Object.fromEntries(Object.entries(current).map(([candidateId, review]) => {
      if (!selectedIds.has(candidateId) || review.state === "rejected") return [candidateId, review];
      const candidate = autoRun.candidates.find((item) => item.id === candidateId)!;
      return [candidateId, { ...review, state: "edited", mergeGroupId, split: undefined, splitOutputs: undefined, editedFields: undefined, resultEntityId: null, finalParent: candidate.payload.suggestedParent }];
    })));
    setSelectedAutoCandidateIds([]);
  }

  function updateSplitOutputText(candidateId: string, outputIndex: number, text: string) {
    setAutoReviews((current) => {
      const review = current[candidateId];
      if (!review?.splitOutputs) return current;
      const splitOutputs = review.splitOutputs.map((output, index) => index === outputIndex ? {
        ...output,
        transcription: text.trim() ? { text, status: "verified" as const } : { text: null, status: "unreadable" as const },
      } : output);
      return { ...current, [candidateId]: { ...review, splitOutputs } };
    });
  }

  function updateSplitFraction(candidateId: string, fraction: number) {
    const candidate = autoRun?.candidates.find((item) => item.id === candidateId);
    const review = autoReviews[candidateId];
    if (!candidate || !review?.split || !review.splitOutputs) return;
    const bounded = Math.max(0.1, Math.min(0.9, fraction));
    const axis = review.split.axis;
    const currentOutputs = review.splitOutputs;
    const geometries = splitQuadGeometry(candidate.payload.geometry, axis, bounded);
    setAutoReviews((current) => ({ ...current, [candidateId]: {
      ...review,
      split: { axis, fractions: [bounded] },
      splitOutputs: currentOutputs.map((output, index) => ({ ...output, geometry: geometries[index]! })),
    } }));
  }

  function undoAutoCandidateSplit(candidateId: string) {
    const candidate = autoRun?.candidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    const canonicalMatch = candidate.payload.duplicateAnalysis?.matches?.find((match) => match.classification === "probable_duplicate" || match.classification === "possible_duplicate") ?? null;
    setAutoReviews((current) => ({ ...current, [candidateId]: {
      ...current[candidateId]!, state: canonicalMatch ? "merged" : "accepted", split: undefined, splitOutputs: undefined,
      resultEntityId: canonicalMatch?.existingOcrId ?? null, finalParent: canonicalMatch ? null : candidate.payload.suggestedParent,
    } }));
  }

  function composeSelectedAutoCandidates() {
    if (!autoRun || selectedAutoCandidateIds.length < 2) return;
    const candidates = selectedAutoCandidateIds.map((candidateId) => ({
      candidate: autoRun.candidates.find((item) => item.id === candidateId), review: autoReviews[candidateId],
    }));
    if (candidates.some(({ candidate, review }) => !candidate || !review || review.state === "rejected" || review.state === "merged" || review.splitOutputs || review.mergeGroupId)) {
      onError("compose_string accepts two or more unsplit physical OCR regions");
      return;
    }
    const text = candidates.map(({ candidate, review }) => (review!.transcription ?? candidate!.payload.transcription ?? "").trim()).filter(Boolean).join(" ");
    setAutoCompositions((current) => [...current, {
      sourceOperationId: `human-compose-${crypto.randomUUID()}`,
      memberSourceOperationIds: [...selectedAutoCandidateIds],
      text: text || null,
      transcriptionStatus: text ? "verified" : "unreadable",
      sortOrder: current.length,
    }]);
    setSelectedAutoCandidateIds([]);
  }

  function renderCandidateInlineEditor() {
    if (!editingAutoCandidateId || !draft) return null;
    return <div className="mt-3 space-y-2 rounded border border-emerald-200 bg-emerald-50 p-2">
      <p className="font-semibold text-emerald-900">Edit this candidate</p>
      <p className="text-[10px] text-emerald-800">Move or reshape the highlighted quad directly on the viewer.</p>
      <input value={transcription} onChange={(event) => setTranscription(event.target.value)} disabled={transcriptionStatus === "unreadable"} placeholder={transcriptionStatus === "unreadable" ? "No reliable transcription" : "Ground-truth transcription"} className="h-9 w-full rounded border border-emerald-300 bg-white px-2 disabled:bg-zinc-100" />
      <div className="grid gap-2">
        <label className="grid gap-1">Transcription<select value={transcriptionStatus} onChange={(event) => { const next = event.target.value as AnnotationGraphOcr["transcription"]["status"]; setTranscriptionStatus(next); if (next === "unreadable") setTranscription(""); }} className="h-8 rounded border bg-white px-1"><option value="verified">Verified</option><option value="partial">Partial</option><option value="unreadable">Unreadable</option></select></label>
        <label className="grid gap-1">Unit<select value={layout.type} onChange={(event) => setLayout((current) => ({ ...current, type: event.target.value as AnnotationGraphOcr["layout"]["type"] }))} className="h-8 rounded border bg-white px-1"><option value="word">Word</option><option value="string">String</option></select></label>
        <label className="grid gap-1">Characters<select value={layout.characterOrientation} onChange={(event) => setLayout((current) => ({ ...current, characterOrientation: event.target.value as AnnotationGraphOcr["layout"]["characterOrientation"] }))} className="h-8 rounded border bg-white px-1"><option value="upright">Upright</option><option value="aligned">Along baseline</option><option value="mixed">Mixed</option></select></label>
      </div>
      <div className="space-y-2 rounded border border-emerald-200 bg-white p-2">
        <div className="flex flex-wrap gap-1"><button type="button" onClick={() => setLinearAngle(0)} className="rounded border px-2 py-1">Horizontal</button><button type="button" onClick={() => setLinearAngle(90)} className="rounded border px-2 py-1">Vertical</button><button type="button" onClick={() => setLinearAngle(quadTopAngle(draft))} className="rounded border px-2 py-1">From quad</button></div>
        <label className="grid grid-cols-[1fr_3.5rem] items-center gap-2">Baseline<input type="range" min="-180" max="180" step="1" value={layout.baselineAngleDeg} onChange={(event) => setLinearAngle(Number(event.target.value))} /><input type="number" min="-180" max="180" step="1" value={Math.round(layout.baselineAngleDeg * 10) / 10} onChange={(event) => setLinearAngle(Number(event.target.value))} className="h-8 rounded border px-1" /></label>
      </div>
      <OcrNormalizedPreview imageUrl={viewerImageUrl} geometry={draft} rectification={rectification} />
      <div className="grid grid-cols-2 gap-2"><button type="button" onClick={applyAutoCandidateEdit} disabled={disabled || busy || (transcriptionStatus !== "unreadable" && !transcription.trim())} className="h-9 rounded bg-emerald-700 font-semibold text-white disabled:opacity-40">Apply edit</button><button type="button" onClick={clearDraft} className="h-9 rounded border bg-white">Cancel</button></div>
    </div>;
  }

  function applyAutoCandidateEdit() {
    if (!editingAutoCandidateId || !draft) return;
    const candidate = autoRun?.candidates.find((item) => item.id === editingAutoCandidateId);
    if (!candidate) return;
    const geometry = normalizeQuadToImage(draft, editorCrop);
    const nextText = transcriptionStatus === "unreadable" ? null : transcription.trim();
    const regionEdited = JSON.stringify(geometry) !== JSON.stringify(candidate.payload.geometry)
      || JSON.stringify(layout) !== JSON.stringify(candidate.payload.layout)
      || JSON.stringify(rectification) !== JSON.stringify(candidate.payload.rectification);
    const textEdited = nextText !== candidate.payload.transcription || transcriptionStatus !== candidate.payload.transcriptionStatus;
    const canonicalMatch = candidate.payload.duplicateAnalysis?.matches?.find((match) => match.classification === "probable_duplicate" || match.classification === "possible_duplicate") ?? null;
    setAutoReviews((current) => ({ ...current, [editingAutoCandidateId]: {
      ...current[editingAutoCandidateId]!, state: regionEdited || textEdited ? "edited" : canonicalMatch ? "merged" : "accepted",
      mergeGroupId: undefined, split: undefined, splitOutputs: undefined, editedFields: regionEdited || textEdited ? { region: regionEdited, text: textEdited } : undefined,
      resultEntityId: regionEdited || textEdited ? null : canonicalMatch?.existingOcrId ?? null,
      finalParent: regionEdited || textEdited || !canonicalMatch ? candidate.payload.suggestedParent : null,
      geometry: regionEdited ? geometry : undefined,
      transcription: nextText, transcriptionStatus, regionStatus: "reviewed", layout, rectification,
    } }));
    clearDraft();
  }

  async function reviewAuto(continueAfterSave = false) {
    if (!token || !autoRun) return;
    setBusy(true);
    try {
      const plan = buildHumanOcrEditPlan(autoRun, autoReviews, autoCompositions, decomposeCompositionIds);
      await reviewAnnotationGraphAutoOcrActions(source, sourceItemId, autoRun.operationId, plan.editOperations, plan.reuseExisting, token);
      await onChanged(); setAutoRun(null); setAutoReviews({}); setAutoCompositions([]); setDecomposeCompositionIds([]); clearDraft();
      if (continueAfterSave) onContinue?.();
    } catch (error) { onError(error instanceof Error ? error.message : "Auto OCR review failed"); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!token || !draft || draft.bbox.width < 2 || draft.bbox.height < 2) return;
    const text = transcription.trim();
    if (transcriptionStatus !== "unreadable" && !text) { onError(`${transcriptionStatus} OCR requires transcription`); return; }
    if (editingAutoCandidateId) { applyAutoCandidateEdit(); return; }
    setBusy(true);
    try {
      if (editingId) {
        await updateAnnotationGraphEntity(source, sourceItemId, "ocr", editingId, { geometry: normalizeQuadToImage(draft, editorCrop), regionStatus: "reviewed", transcription: { text: transcriptionStatus === "unreadable" ? null : text, status: transcriptionStatus }, layout, rectification }, token);
      } else {
        const finalGeometry = normalizeQuadToImage(draft, editorCrop);
        const coordinateSpace: AnnotationGraphOcr["coordinateSpace"] = { type: "label-rectified", units: "normalized", labelId: target.id, cropRevision: label.revision, width: editorCrop.width, height: editorCrop.height };
        const input = { geometry: finalGeometry, coordinateSpace, regionStatus: "reviewed" as const, transcription: { text: transcriptionStatus === "unreadable" ? null : text, status: transcriptionStatus }, layout, rectification };
        const preflight = await preflightManualAnnotationGraphOcr(source, sourceItemId, target, input, token);
        if (preflight.matches.length > 0) {
          setManualConflict({ ...preflight, selectedOcrId: preflight.matches[0]!.existingOcrId });
          return;
        }
        await reviewAnnotationGraphAutoOcr(source, sourceItemId, preflight.operationId, [{ candidateId: preflight.candidateId, state: "accepted", finalParent: preflight.parent }], token);
      }
      await onChanged(); clearDraft();
    } catch (error) { onError(error instanceof Error ? error.message : "OCR graph save failed"); }
    finally { setBusy(false); }
  }

  async function resolveManualConflict(action: "merged" | "accepted") {
    if (!token || !manualConflict) return;
    setBusy(true);
    try {
      await reviewAnnotationGraphAutoOcr(source, sourceItemId, manualConflict.operationId, [{
        candidateId: manualConflict.candidateId,
        state: action,
        ...(action === "merged" ? { resultEntityId: manualConflict.selectedOcrId } : { finalParent: manualConflict.parent }),
      }], token);
      await onChanged(); clearDraft();
    } catch (error) { onError(error instanceof Error ? error.message : "Manual OCR duplicate review failed"); }
    finally { setBusy(false); }
  }

  async function reparent(item: AnnotationGraphOcr) {
    if (!token) return;
    const value = reparentTargets[item.id] ?? item.parentRelation.suggestedLabelId ?? item.labelId;
    const next = { type: "label" as const, id: value };
    setBusy(true);
    try { await reparentAnnotationGraphOcr(source, sourceItemId, item.id, next, token); await onChanged(); }
    catch (error) { onError(error instanceof Error ? error.message : "OCR parent review failed"); }
    finally { setBusy(false); }
  }

  async function remove(item: AnnotationGraphOcr) {
    if (!token || item.legacyManaged || !window.confirm("Delete this manual OCR region? Operation history will be retained.")) return;
    setBusy(true);
    try { await deleteAnnotationGraphEntity(source, sourceItemId, "ocr", item.id, token); await onChanged(); if (editingId === item.id) clearDraft(); }
    catch (error) { onError(error instanceof Error ? error.message : "OCR delete failed"); }
    finally { setBusy(false); }
  }

  if (phase === "normalization") return (
    <div className="mt-5 border-t border-zinc-200 pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h4 className="text-xs font-semibold uppercase text-violet-800">OCR · 1/2 Label normalization</h4><p className="mt-1 max-w-2xl text-xs text-zinc-500">Correct the complete Label surface first. Auto OCR and every OCR box will be generated in this reviewed rectified coordinate space.</p></div>
        <button type="button" onClick={onClose} className="rounded border px-3 py-1 text-xs">Close</button>
      </div>
      <div className="mt-3 grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="relative">
          <ImageWorkspace imageUrl={sourceImageUrl} mode="roi-editor" draw={drawNormalization} cursor={labelRectificationDraft?.type === "guided-cylindrical" ? "grab" : "move"} allowPointerOverflow={labelRectificationDraft?.type === "guided-cylindrical"}
            onPointerDown={normalizationPointerDown} onPointerMove={normalizationPointerMove}
            onPointerUp={() => { normalizationDragRef.current = null; }} onPointerLeave={() => { normalizationDragRef.current = null; setNormalizationZoomLens(null); }} />
          {sourceImageUrl && <FloatingZoomLens imageUrl={sourceImageUrl} lens={normalizationZoomLens} />}
        </div>
        <aside className="space-y-3 rounded border border-violet-200 bg-violet-50 p-3 text-xs">
          <div><strong className="uppercase text-violet-900">Surface correction</strong><p className="mt-1 leading-5 text-violet-800">Perspective uses the four reviewed Label corners. Cylindrical adds a guided dewarp after that perspective crop.</p></div>
          <button type="button" onClick={() => void runRectification()} disabled={disabled || busy || !sourceImageUrl} className="h-9 w-full rounded bg-sky-700 font-semibold text-white disabled:opacity-40">{busy ? "Analyzing…" : "Auto-align Label"}</button>
          {rectificationRun && <div className="space-y-2 rounded border border-violet-200 bg-white p-2">
            <div className="flex justify-between"><strong>Correction candidates</strong><span>{rectificationRun.candidates.length}</span></div>
            {rectificationRun.candidates.map((candidate) => <button type="button" key={candidate.id} onClick={() => chooseRectificationCandidate(candidate.id)} className={`w-full rounded border p-2 text-left ${selectedRectificationCandidateId === candidate.id ? "border-violet-700 bg-violet-50" : "border-zinc-200"}`}>
              <span className="flex justify-between gap-2"><strong>{candidate.payload.mode === "none" ? "Original" : candidate.payload.mode === "perspective" ? "Perspective" : "Cylindrical"}</strong><span>{Math.round(candidate.score * 100)}%</span></span>
              <span className="mt-1 block text-[10px] text-zinc-600">confidence {Math.round(candidate.payload.diagnostics.confidence * 100)}% · retained {Math.round(candidate.payload.diagnostics.retainedArea * 100)}%{candidate.payload.diagnostics.recommended ? " · recommended" : ""}</span>
              {candidate.payload.diagnostics.evidenceRows != null && <span className="mt-1 block text-[10px] text-zinc-600">curve evidence {candidate.payload.diagnostics.evidenceRows} rows · signed curvature {(candidate.payload.diagnostics.signedCurvature ?? 0).toFixed(4)}</span>}
              {candidate.payload.diagnostics.warnings.length > 0 && <span className="mt-1 block text-[10px] text-amber-700">{candidate.payload.diagnostics.warnings.join(" · ")}</span>}
            </button>)}
            <details><summary className="cursor-pointer text-[10px] font-semibold text-zinc-600">Helper config</summary><RawJsonBlock value={rectificationRun.config} containerClassName="mt-1" className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950 p-2 pr-20 font-mono text-[9px] leading-4 text-zinc-100" /></details>
          </div>}
          <div className="grid grid-cols-3 gap-2">
            <button type="button" onClick={() => setLabelRectificationDraft(null)} className={`h-9 rounded border font-semibold ${labelRectificationDraft === null ? "border-violet-800 bg-violet-800 text-white" : "border-violet-300 bg-white text-violet-900"}`}>Original</button>
            <button type="button" onClick={() => setLabelRectificationDraft(perspectiveRectification())} className={`h-9 rounded border font-semibold ${labelRectificationDraft?.type === "perspective" ? "border-violet-800 bg-violet-800 text-white" : "border-violet-300 bg-white text-violet-900"}`}>Perspective</button>
            <button type="button" onClick={() => setLabelRectificationDraft((current) => current?.type === "guided-cylindrical" ? current : cylindricalRectification())} className={`h-9 rounded border font-semibold ${labelRectificationDraft?.type === "guided-cylindrical" ? "border-violet-800 bg-violet-800 text-white" : "border-violet-300 bg-white text-violet-900"}`}>Cylindrical</button>
          </div>
          {labelRectificationDraft?.type === "guided-cylindrical" && <div className="grid gap-2">
            <CylindricalSlider label="Cylinder bend" value={labelRectificationDraft.controls.signedCurvature * 100} min={-20} max={20} step={0.25} display={`${(labelRectificationDraft.controls.signedCurvature * 100).toFixed(2)}%`} onChange={(value) => setLabelRectificationDraft(setCylindricalCurvature(labelRectificationDraft, value / 100))} />
            <CylindricalSlider label="Horizontal surface span" value={labelRectificationDraft.controls.horizontalScale * 100} min={50} max={125} step={0.5} display={`${(labelRectificationDraft.controls.horizontalScale * 100).toFixed(1)}%`} onChange={(value) => setLabelRectificationDraft(setCylindricalHorizontalScale(labelRectificationDraft, value / 100))} />
            <p className="text-[10px] leading-4 text-violet-700">Sliders move all guides proportionally; handles can extend 25% outside the Label quad.</p>
            <p className="text-violet-800">Drag guide points on the source viewer. The Label quad stays fixed while guides are active.</p>
            <div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => setLabelRectificationDraft(addHorizontalGuide(labelRectificationDraft))} className="h-8 rounded border border-violet-300 bg-white">Add guide</button><button type="button" disabled={labelRectificationDraft.guides.horizontalGuides.length <= 2} onClick={() => setLabelRectificationDraft(removeHorizontalGuide(labelRectificationDraft))} className="h-8 rounded border border-violet-300 bg-white disabled:opacity-40">Remove guide</button></div>
            <button type="button" onClick={() => setLabelRectificationDraft(cylindricalRectification(defaultCylindricalGuides()))} className="h-8 rounded border border-violet-300 bg-white">Reset auto guides</button>
            <p className="text-[10px] text-violet-700">Curvature {labelRectificationDraft.transform.curvature.toFixed(4)} · surface width {labelRectificationDraft.transform.surfaceWidth.toFixed(3)}</p>
          </div>}
          <CropPreview imageUrl={sourceImageUrl} rect={labelGeometryDraft.bbox} geometry={labelGeometryDraft} rectification={labelRectificationDraft} />
          {items.length > 0 && normalizationDirty && <p className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900">Changing Label normalization creates a new Label revision. {items.length} existing OCR region{items.length === 1 ? "" : "s"} will remain in history but will not be overlaid on the new crop.</p>}
          <button type="button" onClick={() => void saveNormalization()} disabled={disabled || busy} className="h-10 w-full rounded bg-violet-800 font-semibold text-white disabled:opacity-40">{normalizationDirty ? "Save normalization & continue" : "Continue to OCR regions"}</button>
        </aside>
      </div>
    </div>
  );

  return (
    <div className="mt-5 border-t border-zinc-200 pt-4">
      <div className="flex items-center justify-between gap-3"><div><h4 className="text-xs font-semibold uppercase text-zinc-600">OCR · 2/2 Regions</h4><p className="mt-1 text-xs text-zinc-500">{`Regions belong to the current Label and are normalized inside ${crop?.revision ? `crop revision ${crop.revision}` : `Label revision ${label.revision}`} (${editorCrop.width}×${editorCrop.height}).`}</p></div><div className="flex gap-2"><button type="button" onClick={() => setPhase("normalization")} className="rounded border px-3 py-2 text-xs">Label correction</button><button type="button" onClick={runAuto} disabled={disabled || busy} className="rounded bg-violet-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">Auto OCR</button><button type="button" onClick={onClose} className="rounded border px-3 py-1 text-xs">Close</button></div></div>
      {staleItemCount > 0 && <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">{staleItemCount} OCR region{staleItemCount === 1 ? " is" : "s are"} from an older Label normalization revision and are intentionally hidden. Run Auto OCR on the current corrected Label.</p>}
      {!viewerImageUrl ? <p className="mt-3 rounded bg-amber-50 p-3 text-xs text-amber-900">Run Auto OCR once to generate the rectified Label review crop.</p> : (
        <div className="mt-3 grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <ImageWorkspace imageUrl={viewerImageUrl} mode="roi-editor" draw={draw} cursor="crosshair" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { dragRef.current = null; }} />
          <div className="space-y-3 rounded border border-zinc-200 p-3 text-xs">
            {autoRun && <div className="space-y-2 rounded border border-violet-200 bg-violet-50 p-2"><div className="flex items-center justify-between gap-2"><strong>Auto OCR candidates · {autoRun.candidates.length - rejectedAutoCandidateCount}</strong><span className="font-mono text-[10px]">{autoRun.operationId.slice(0, 8)}</span></div><p className="text-[10px] leading-4 text-violet-800">Actions match the OCR Edit Engine contract: split consumes one region, merge consumes two or more, compose preserves physical regions, × rejects, and Save approves final outputs.</p><div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => splitSelectedAutoCandidate("vertical")} disabled={selectedAutoCandidateIds.length !== 1} className="h-8 rounded border border-sky-300 bg-white font-semibold text-sky-800 disabled:opacity-40">split_region · left/right</button><button type="button" onClick={() => splitSelectedAutoCandidate("horizontal")} disabled={selectedAutoCandidateIds.length !== 1} className="h-8 rounded border border-sky-300 bg-white font-semibold text-sky-800 disabled:opacity-40">split_region · top/bottom</button><button type="button" onClick={joinSelectedAutoCandidates} disabled={selectedAutoCandidateIds.length < 2} className="h-8 rounded border border-orange-300 bg-white font-semibold text-orange-800 disabled:opacity-40">merge_region ({selectedAutoCandidateIds.length})</button><button type="button" onClick={composeSelectedAutoCandidates} disabled={selectedAutoCandidateIds.length < 2} className="h-8 rounded border border-violet-300 bg-white font-semibold text-violet-800 disabled:opacity-40">compose_string ({selectedAutoCandidateIds.length})</button></div>{rejectedAutoCandidateCount > 0 && <button type="button" onClick={() => setShowRejectedCandidates((current) => !current)} className="w-full rounded border border-red-200 bg-white px-2 py-1 text-left text-[10px] font-medium text-red-700">{showRejectedCandidates ? "Hide" : "Show"} rejected · {rejectedAutoCandidateCount}</button>}{autoRun.candidates.map((candidate, index) => {
              const review = autoReviews[candidate.id]!;
              if (review.state === "rejected" && !showRejectedCandidates) return null;
              return <div key={candidate.id} className="rounded border border-violet-200 bg-white p-2">
                <div className="flex items-start gap-2"><input type="checkbox" aria-label={`Select OCR candidate ${index + 1}`} checked={selectedAutoCandidateIds.includes(candidate.id)} disabled={review.state === "rejected"} onChange={(event) => setSelectedAutoCandidateIds((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} className="mt-1" /><strong className="min-w-0 flex-1 break-words">C{index + 1} · {candidate.payload.transcription ?? "text ROI"}</strong><span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-bold uppercase ${review.mergeGroupId ? "bg-orange-100 text-orange-800" : review.splitOutputs ? "bg-sky-100 text-sky-800" : review.state === "edited" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>{ocrReviewActionLabel(review)}</span><span className="shrink-0">{formatOcrConfidence(candidate.payload.recognitionConfidence)}</span><button type="button" onClick={() => rejectAutoCandidate(candidate.id)} disabled={review.state === "rejected"} className="grid size-6 shrink-0 place-items-center rounded border border-red-200 text-sm font-bold leading-none text-red-700 hover:bg-red-50 disabled:opacity-30" aria-label={`Reject and hide OCR candidate ${index + 1}`} title="Reject and hide">×</button></div>
                {review.splitOutputs && <div className="mt-2 space-y-2 rounded border border-sky-200 bg-sky-50 p-2"><div className="flex items-center justify-between gap-2"><strong className="text-sky-900">split_region · {review.split?.axis}</strong><button type="button" onClick={() => undoAutoCandidateSplit(candidate.id)} className="rounded border border-sky-300 bg-white px-2 py-1 text-[10px] font-semibold text-sky-800">Undo split</button></div><label className="grid grid-cols-[1fr_3rem] items-center gap-2"><input type="range" min="0.1" max="0.9" step="0.01" value={review.split?.fractions[0] ?? 0.5} onChange={(event) => updateSplitFraction(candidate.id, Number(event.target.value))} /><span>{Math.round((review.split?.fractions[0] ?? 0.5) * 100)}%</span></label>{review.splitOutputs.map((output, outputIndex) => <label key={output.sourceOperationId} className="grid gap-1"><span className="text-[10px] font-semibold text-sky-800">Output {outputIndex + 1} · edit_text after split</span><input value={output.transcription.text ?? ""} onChange={(event) => updateSplitOutputText(candidate.id, outputIndex, event.target.value)} placeholder="Leave empty if unreadable" className="h-8 rounded border border-sky-200 bg-white px-2" /></label>)}</div>}
                {editingAutoCandidateId === candidate.id ? renderCandidateInlineEditor() : <div className="mt-2 grid gap-2">
                  {review.state === "merged" && <p className="text-[10px] text-zinc-500">Matches an already saved OCR region; Save will reuse it without creating a duplicate.</p>}
                  {!review.splitOutputs && <button type="button" onClick={() => editAutoCandidate(candidate.id)} disabled={review.state === "rejected"} className="h-8 rounded border border-violet-300 disabled:opacity-40">Edit quad / text</button>}
                </div>}
              </div>;
            })}{autoCompositions.map((composition, index) => <div key={composition.sourceOperationId} className="space-y-1 rounded border border-violet-300 bg-white p-2"><div className="flex items-center justify-between"><strong>compose_string #{index + 1} · {composition.memberSourceOperationIds.length} regions</strong><button type="button" onClick={() => setAutoCompositions((current) => current.filter((item) => item.sourceOperationId !== composition.sourceOperationId))} className="grid size-6 place-items-center rounded border border-red-200 font-bold text-red-700" title="Remove composition">×</button></div><input value={composition.text ?? ""} onChange={(event) => setAutoCompositions((current) => current.map((item) => item.sourceOperationId === composition.sourceOperationId ? { ...item, text: event.target.value || null, transcriptionStatus: event.target.value.trim() ? "verified" : "unreadable" } : item))} placeholder="Composed string" className="h-8 w-full rounded border border-violet-200 px-2" /></div>)}{compositions.filter((composition) => !decomposeCompositionIds.includes(composition.id)).map((composition) => <div key={composition.id} className="flex items-center justify-between gap-2 rounded border border-zinc-200 bg-white p-2"><span><strong>Existing composition</strong> · {composition.text ?? "unreadable"}</span><button type="button" onClick={() => setDecomposeCompositionIds((current) => [...current, composition.id])} className="rounded border px-2 py-1">decompose_string</button></div>)}<div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => void reviewAuto()} disabled={busy || autoRun.candidates.length === 0} className="h-9 rounded border border-violet-400 bg-white font-semibold text-violet-900 disabled:opacity-40">Save</button><button type="button" onClick={() => void reviewAuto(true)} disabled={busy || autoRun.candidates.length === 0} className="h-9 rounded bg-violet-800 font-semibold text-white disabled:opacity-40">Save &amp; continue</button></div></div>}
            {!autoRun && onContinue && <button type="button" onClick={onContinue} disabled={busy} className="h-9 w-full rounded bg-violet-800 font-semibold text-white disabled:opacity-40">Continue to Mask</button>}
            {manualConflict && <div className="space-y-2 rounded border border-amber-300 bg-amber-50 p-2">
              <strong className="text-amber-900">Possible duplicate · canonical OCR not created yet</strong>
              <div className="rounded border border-amber-200 bg-white p-2">
                <strong>{manualConflict.matches[0]?.existing.transcription ?? "text ROI only"}</strong>
                {manualConflict.matches[0] && <span className="mt-1 block text-zinc-600">{manualConflict.matches[0].classification} · geometry {Math.round(manualConflict.matches[0].geometryScore * 100)}% · text {manualConflict.matches[0].textScore == null ? "n/a" : `${Math.round(manualConflict.matches[0].textScore * 100)}%`} · total {Math.round(manualConflict.matches[0].totalScore * 100)}%</span>}
              </div>
              <div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => void resolveManualConflict("merged")} disabled={busy} className="h-8 rounded bg-emerald-700 font-semibold text-white">Reuse saved OCR</button><button type="button" onClick={() => void resolveManualConflict("accepted")} disabled={busy} className="h-8 rounded border border-amber-400 bg-white font-semibold">Create separate</button></div>
            </div>}
            {!editingAutoCandidateId && <>
            <p className="font-semibold">{editingId ? "Edit OCR quad" : "Draw OCR quad manually"}</p>
            <p className="text-zinc-500">Draw a rectangle, then move it or drag any corner into a free convex quad.</p>
            <label className="grid gap-1">Transcription<select value={transcriptionStatus} onChange={(event) => { const next=event.target.value as AnnotationGraphOcr["transcription"]["status"]; setTranscriptionStatus(next); if(next==="unreadable")setTranscription(""); }} className="h-9 rounded border border-zinc-300 bg-white px-2"><option value="verified">Verified</option><option value="partial">Partial · exclude from recognition GT</option><option value="unreadable">Unreadable · ROI only</option></select></label>
            <div className="grid grid-cols-2 gap-2">
              <select value={layout.type} onChange={(event) => setLayout((current) => ({ ...current, type: event.target.value as AnnotationGraphOcr["layout"]["type"] }))} className="h-8 rounded border bg-white px-1"><option value="word">Word</option><option value="string">String</option></select>
              <select value={layout.characterOrientation} onChange={(event) => setLayout((current) => ({ ...current, characterOrientation: event.target.value as AnnotationGraphOcr["layout"]["characterOrientation"] }))} className="h-8 rounded border bg-white px-1"><option value="upright">A upright</option><option value="aligned">A follows baseline</option><option value="mixed">A mixed</option></select>
            </div>
            <div className="space-y-2 rounded border border-zinc-200 bg-zinc-50 p-2">
              <div className="flex flex-wrap gap-1"><button type="button" onClick={() => setLinearAngle(0)} className="rounded border bg-white px-2 py-1">Horizontal</button><button type="button" onClick={() => setLinearAngle(90)} className="rounded border bg-white px-2 py-1">Vertical</button><button type="button" onClick={() => draft && setLinearAngle(quadTopAngle(draft))} disabled={!draft} className="rounded border bg-white px-2 py-1 disabled:opacity-40">Angled from quad</button><button type="button" disabled title="Curved baseline editor is a later runtime phase" className="rounded border bg-white px-2 py-1 opacity-40">Curved · planned</button></div>
              <label className="grid grid-cols-[1fr_4rem] items-center gap-2">Baseline angle<input type="range" min="-180" max="180" step="1" value={layout.baselineAngleDeg} onChange={(event) => setLinearAngle(Number(event.target.value))} /><input type="number" min="-180" max="180" step="1" value={Math.round(layout.baselineAngleDeg * 10) / 10} onChange={(event) => setLinearAngle(Number(event.target.value))} className="h-8 rounded border bg-white px-1" /></label>
              <p className="text-[10px] text-zinc-500">The blue handle changes reading baseline and local OCR rotation only. Detection quad stays unchanged.</p>
            </div>
            <OcrNormalizedPreview imageUrl={viewerImageUrl} geometry={draft} rectification={rectification} />
            {!editingId && !editingAutoCandidateId && <p className="rounded border border-zinc-200 bg-zinc-50 px-2 py-2 text-zinc-600">Parent: <strong>{labels.find((label) => label.id === target.id)?.name ?? "current Label / VisualRegion"}</strong>. Move to another Label through relation review if the ownership is wrong.</p>}
            <input value={transcription} onChange={(event) => setTranscription(event.target.value)} disabled={transcriptionStatus === "unreadable"} placeholder={transcriptionStatus === "unreadable" ? "No reliable transcription" : "Ground-truth transcription"} className="h-9 w-full rounded border border-zinc-300 px-2 disabled:bg-zinc-100" />
            <div className="grid grid-cols-2 gap-2"><button type="button" onClick={save} disabled={disabled || busy || !draft || (transcriptionStatus !== "unreadable" && !transcription.trim())} className="h-9 rounded bg-emerald-700 font-semibold text-white disabled:opacity-40">Save OCR</button><button type="button" onClick={clearDraft} className="h-9 rounded border">Clear</button></div>
            </>}
            <div className="max-h-72 space-y-2 overflow-auto border-t pt-3">{currentItems.map((item, index) => { const parentValue = reparentTargets[item.id] ?? item.parentRelation.suggestedLabelId ?? item.labelId; return <div key={item.id} className="rounded border border-zinc-200 p-2"><div className="flex justify-between gap-2"><strong>T{index + 1} · {item.regionStatus} / {item.transcription.status}</strong></div><OcrStatusBadges status={ocrStatusForEntity(item, operations)} /><p className="mt-1 break-words text-zinc-600">{item.transcription.text ?? "—"}</p><p className="mt-1 text-[10px] text-zinc-500">{item.layout.type} · {item.layout.flow} · {formatAngle(item.layout.baselineAngleDeg)} · glyphs {item.layout.characterOrientation}</p><p className="mt-1 font-mono text-[10px] text-zinc-500">{coordinateSpaceLabel(item.coordinateSpace)}</p><p className="mt-1 text-[10px] text-zinc-500">Parent relation: {item.parentRelation.source} · {item.parentRelation.status}{item.parentRelation.suggestedLabelId ? " · Label suggested" : ""}</p><OcrMetaEditor source={source} sourceItemId={sourceItemId} token={token} item={item} busy={busy} onChanged={onChanged} onError={onError} /><div className="mt-2 grid grid-cols-[1fr_auto] gap-2"><select value={parentValue} onChange={(event) => setReparentTargets((current) => ({ ...current, [item.id]: event.target.value }))} className="h-7 rounded border bg-white px-1">{labels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select><button type="button" onClick={() => void reparent(item)} disabled={busy || (item.parentRelation.status === "reviewed" && parentValue === item.labelId)} className="rounded border px-2 disabled:opacity-40">{item.parentRelation.status === "suggested" ? "Review" : "Move"}</button></div><div className="mt-2 flex gap-2">{item.legacyManaged ? <span className="text-zinc-500">Content: edit in OCR stage</span> : <><button type="button" onClick={() => edit(item)} className="rounded border px-2 py-1">Edit</button><button type="button" onClick={() => remove(item)} className="rounded border border-red-200 px-2 py-1 text-red-700">Del</button></>}</div></div>; })}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function coordinateSpaceLabel(value: AnnotationGraphOcr["coordinateSpace"]) {
  if (value.type === "unavailable") return `unavailable: ${value.reason}`;
  return `label-rectified · rev ${value.cropRevision ?? "?"} · ${value.width ?? "?"}×${value.height ?? "?"}`;
}

function OcrStatusBadges({ status }: { status: OcrStatus }) {
  const badges = [
    { label: status.origin === "auto-helper" ? "Auto Helper" : status.origin === "manual" ? "Manual input" : "Origin unknown", color: "bg-violet-50 text-violet-800", title: "Where the OCR region originated" },
    { label: status.reviewer === "llm" ? "LLM" : status.reviewer === "human" ? "Annotator" : "Reviewer unknown", color: "bg-sky-50 text-sky-800", title: "Who made the last review decision" },
    { label: status.change === "unchanged" ? "Unchanged" : status.change === "edited" ? "Changed" : status.change === "not-applicable" ? "Change n/a" : "Change unknown", color: "bg-amber-50 text-amber-800", title: "Changes relative to the Auto Helper candidate" },
  ];
  return <div className="mt-1 flex flex-wrap gap-1">{badges.map((badge) => <span key={badge.title} title={badge.title} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.color}`}>{badge.label}</span>)}</div>;
}

const OCR_META_TAGS = ["logo", "brand", "vintage", "technical-text", "curved", "low-contrast", "decorative", "lettering"];

function OcrMetaEditor({ source, sourceItemId, token, item, busy, onChanged, onError }: {
  source: string; sourceItemId: string; token: string | null; item: AnnotationGraphOcr; busy: boolean;
  onChanged: () => Promise<unknown>; onError: (message: string) => void;
}) {
  const [note, setNote] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  async function add() {
    if (!token || (!note.trim() && tags.length === 0)) return;
    try {
      await createAnnotationGraphMeta(source, sourceItemId, { targetType: "ocr", targetId: item.id, note: note.trim(), tags, source: "human" }, token);
      setNote(""); setTags([]); await onChanged();
    } catch (error) { onError(error instanceof Error ? error.message : "OCR Meta save failed"); }
  }
  async function remove(id: string) {
    if (!token) return;
    try { await deleteAnnotationGraphEntity(source, sourceItemId, "meta", id, token); await onChanged(); }
    catch (error) { onError(error instanceof Error ? error.message : "OCR Meta delete failed"); }
  }
  return <details className="mt-2 rounded border border-zinc-200 bg-zinc-50 p-2"><summary className="cursor-pointer font-medium">Semantic Meta · {item.meta.length}</summary>
    {item.meta.map((meta) => <div key={meta.id} className="mt-2 flex items-start justify-between gap-2 rounded bg-white p-2"><span>{meta.tags.join(", ") || "note"}{meta.note ? ` · ${meta.note}` : ""} · {meta.source}</span><button type="button" onClick={() => void remove(meta.id)} className="text-red-700">Del</button></div>)}
    <div className="mt-2 flex flex-wrap gap-1">{OCR_META_TAGS.map((tag) => <button key={tag} type="button" onClick={() => setTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag])} className={`rounded border px-2 py-1 ${tags.includes(tag) ? "border-violet-600 bg-violet-100" : "bg-white"}`}>{tag}</button>)}</div>
    <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional semantic note" className="mt-2 h-8 w-full rounded border bg-white px-2" />
    <button type="button" onClick={() => void add()} disabled={busy || (!note.trim() && tags.length === 0)} className="mt-2 h-8 w-full rounded bg-zinc-900 font-semibold text-white disabled:opacity-40">Add OCR Meta</button>
  </details>;
}

function latestAutoOcrRun(operations: AnnotationGraph["operations"], target: { type: "label"; id: string }, labelRevision: number, labelRectification: LabelRectification | null): AutoOcrRun | null {
  const operation = [...operations].reverse().find((item) => item.operationType === "run_ocr" && item.scope?.type === target.type && item.scope.id === target.id && (item.status === "draft" || item.status === "failed") && autoOcrViewerMatchesLabelRevision(item.helperOutput?.viewer, labelRevision, labelRectification));
  if (!operation) return null;
  const viewer = operation.helperOutput?.viewer as AutoOcrRun["viewer"] | undefined;
  if (!viewer?.assetPath || !viewer.width || !viewer.height) return null;
  const status: "draft" | "failed" = operation.status === "draft" ? "draft" : "failed";
  return { operationId: operation.id, helper: { id: "auto-ocr", version: operation.helper.version ?? "unknown" }, scope: target,
    config: operation.finalConfig ?? {}, candidates: operation.candidates ?? [], viewer, status };
}

function latestLabelRectificationRun(operations: AnnotationGraph["operations"], target: { type: "label"; id: string }, labelRevision: number): LabelRectificationRun | null {
  const operation = [...operations].reverse().find((item) => item.operationType === "run_label_rectification"
    && item.scope?.type === target.type && item.scope.id === target.id
    && item.status === "draft" && Number(item.helperOutput?.labelRevision) === labelRevision);
  if (!operation) return null;
  return {
    operationId: operation.id,
    helper: { id: "label-rectification", version: "cv-label-rectification-v1" },
    scope: target,
    labelRevision,
    config: operation.finalConfig,
    candidates: operation.candidates as unknown as LabelRectificationRun["candidates"],
    status: "draft",
  };
}

function latestAutoOcrViewer(operations: AnnotationGraph["operations"], target: { type: "label"; id: string }, labelRevision: number, labelRectification: LabelRectification | null): AutoOcrRun["viewer"] | null {
  const operation = [...operations].reverse().find((item) => item.operationType === "run_ocr" && item.scope?.type === target.type && item.scope.id === target.id && autoOcrViewerMatchesLabelRevision(item.helperOutput?.viewer, labelRevision, labelRectification));
  const viewer = operation?.helperOutput?.viewer as AutoOcrRun["viewer"] | undefined;
  return viewer?.assetPath && viewer.width && viewer.height ? viewer : null;
}

function autoOcrViewerMatchesLabelRevision(value: unknown, labelRevision: number, labelRectification: LabelRectification | null) {
  if (!value || typeof value !== "object") return false;
  const viewer = value as Partial<AutoOcrRun["viewer"]>;
  return viewer.labelRevision === labelRevision || (viewer.labelRevision == null && labelRectification === null);
}

function initialAutoReviews(run: AutoOcrRun | null): Record<string, AutoOcrReviewDraft> {
  if (!run || run.status !== "draft") return {};
  return Object.fromEntries(run.candidates.map((candidate) => {
    const canonicalMatch = candidate.payload.duplicateAnalysis?.matches?.find((match) => match.classification === "probable_duplicate" || match.classification === "possible_duplicate") ?? null;
    return [candidate.id, {
    state: canonicalMatch ? "merged" : "accepted",
    resultEntityId: canonicalMatch?.existingOcrId ?? null,
    finalParent: canonicalMatch ? null : candidate.payload.suggestedParent,
    transcription: candidate.payload.transcription,
    transcriptionStatus: candidate.payload.transcriptionStatus,
    regionStatus: candidate.payload.regionStatus,
    layout: coerceOcrLayout(candidate.payload.layout),
    rectification: candidate.payload.rectification ?? null,
  } satisfies AutoOcrReviewDraft];
  }));
}

function ocrReviewActionLabel(review: AutoOcrReviewDraft) {
  if (review.mergeGroupId) return "merge_region";
  if (review.splitOutputs) return "split_region";
  if (review.editedFields?.region && review.editedFields.text) return "edit_region + edit_text";
  if (review.editedFields?.region) return "edit_region";
  if (review.editedFields?.text) return "edit_text";
  if (review.state === "merged") return "reuse existing";
  return "no change";
}

function buildHumanOcrEditPlan(
  run: AutoOcrRun,
  reviews: Record<string, AutoOcrReviewDraft>,
  compositions: Array<{ sourceOperationId: string; memberSourceOperationIds: string[]; text: string | null; transcriptionStatus: "verified" | "partial" | "unreadable"; sortOrder: number }>,
  decomposeCompositionIds: string[],
) {
  let sequence = 0;
  const editOperations: HumanOcrEditOperation[] = [];
  const finalNodeByCandidate = new Map<string, string>();
  const reuseExisting: Array<{ candidateId: string; resultEntityId: string }> = [];
  const operation = (type: HumanOcrEditOperation["type"], inputIds: string[], patch: Partial<HumanOcrEditOperation> = {}) => {
    const result: HumanOcrEditOperation = {
      operationId: `human-op-${++sequence}`, type, inputIds,
      adjustment: null, geometry: null, layout: null, rectification: null, text: null, transcriptionStatus: null, split: null, composition: null,
      ...patch,
    };
    editOperations.push(result);
    return result.operationId;
  };

  for (const candidate of run.candidates) {
    const review = reviews[candidate.id]!;
    if (review.state === "merged" && review.resultEntityId) {
      reuseExisting.push({ candidateId: candidate.id, resultEntityId: review.resultEntityId });
      continue;
    }
    if (review.state === "rejected") {
      operation("reject", [candidate.id]);
      continue;
    }
    if (review.mergeGroupId) continue;
    if (review.split && review.splitOutputs?.length) {
      const splitId = operation("split_region", [candidate.id], { split: review.split });
      review.splitOutputs.forEach((output, index) => {
        let nodeId = `${splitId}:${index + 1}`;
        if (output.transcription.status !== "unreadable" || output.transcription.text !== null) nodeId = operation("edit_text", [nodeId], {
          text: output.transcription.status === "unreadable" ? null : output.transcription.text,
          transcriptionStatus: output.transcription.status,
        });
        operation("approve_region", [nodeId]);
      });
      continue;
    }
    let nodeId = candidate.id;
    if (review.editedFields?.region && review.geometry) nodeId = operation("edit_region", [nodeId], { geometry: review.geometry, layout: review.layout, rectification: review.rectification });
    if (review.editedFields?.text) nodeId = operation("edit_text", [nodeId], { text: review.transcriptionStatus === "unreadable" ? null : review.transcription, transcriptionStatus: review.transcriptionStatus });
    finalNodeByCandidate.set(candidate.id, nodeId);
  }

  const mergeGroups = [...new Set(Object.values(reviews).flatMap((review) => review.mergeGroupId ? [review.mergeGroupId] : []))];
  for (const mergeGroupId of mergeGroups) {
    const memberIds = run.candidates.filter((candidate) => reviews[candidate.id]?.mergeGroupId === mergeGroupId).map((candidate) => candidate.id);
    const mergedNodeId = operation("merge_region", memberIds);
    memberIds.forEach((candidateId) => finalNodeByCandidate.set(candidateId, mergedNodeId));
  }

  for (const nodeId of new Set(finalNodeByCandidate.values())) operation("approve_region", [nodeId]);
  for (const composition of compositions) {
    const memberNodeIds = composition.memberSourceOperationIds.map((candidateId) => finalNodeByCandidate.get(candidateId)).filter((id): id is string => Boolean(id));
    if (memberNodeIds.length !== composition.memberSourceOperationIds.length || new Set(memberNodeIds).size !== memberNodeIds.length) throw new Error("compose_string members must resolve to distinct final physical regions");
    operation("compose_string", memberNodeIds, { composition: { text: composition.text, transcriptionStatus: composition.transcriptionStatus, sortOrder: composition.sortOrder } });
  }
  for (const compositionId of decomposeCompositionIds) operation("decompose_string", [compositionId]);
  return { editOperations, reuseExisting };
}

function defaultOcrLayout(): AnnotationGraphOcr["layout"] {
  return { type: "string", flow: "linear", baselineAngleDeg: 0, baseline: null, characterOrientation: "upright" };
}

function coerceOcrLayout(value: unknown): AnnotationGraphOcr["layout"] {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.flow === "linear" || record.flow === "curved") return value as AnnotationGraphOcr["layout"];
    const direction = record.direction;
    return {
      type: record.type === "word" ? "word" : "string", flow: "linear",
      baselineAngleDeg: direction === "down" ? 90 : direction === "left" ? 180 : direction === "up" ? -90 : 0,
      baseline: null,
      characterOrientation: record.orientation === "mixed" ? "mixed" : record.orientation === "upright" ? "upright" : "aligned",
    };
  }
  return defaultOcrLayout();
}

function annotationAssetUrl(assetPath: string) {
  return `/api/admin/assets/${assetPath.split("/").map(encodeURIComponent).join("/")}`;
}

function displayOcrGeometry(item: AnnotationGraphOcr, crop: { width: number; height: number } | null): QuadGeometry {
  if (item.coordinateSpace.type !== "label-rectified") return item.geometry;
  const width = crop?.width ?? item.coordinateSpace.width ?? 1, height = crop?.height ?? item.coordinateSpace.height ?? 1;
  return scaleQuad(item.geometry, width, height);
}

function normalizeQuadToImage(geometry: QuadGeometry, crop: { width: number; height: number } | null): QuadGeometry {
  return scaleQuad(geometry, 1 / Math.max(1, crop?.width ?? 1), 1 / Math.max(1, crop?.height ?? 1));
}

function scaleQuad(geometry: QuadGeometry, scaleX: number, scaleY: number): QuadGeometry {
  const points = geometry.points.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY })) as QuadGeometry["points"];
  return { type: "quad", points, bbox: { x: geometry.bbox.x * scaleX, y: geometry.bbox.y * scaleY, width: geometry.bbox.width * scaleX, height: geometry.bbox.height * scaleY } };
}

function splitQuadGeometry(geometry: QuadGeometry, axis: "horizontal" | "vertical", fraction: number): [QuadGeometry, QuadGeometry] {
  const [topLeft, topRight, bottomRight, bottomLeft] = geometry.points;
  const mix = (left: RecognitionPoint, right: RecognitionPoint) => ({
    x: left.x + (right.x - left.x) * fraction,
    y: left.y + (right.y - left.y) * fraction,
  });
  const fromPoints = (points: QuadGeometry["points"]): QuadGeometry => {
    const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
    return { type: "quad", points, bbox: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } };
  };
  if (axis === "vertical") {
    const top = mix(topLeft, topRight), bottom = mix(bottomLeft, bottomRight);
    return [fromPoints([topLeft, top, bottom, bottomLeft]), fromPoints([top, topRight, bottomRight, bottom])];
  }
  const left = mix(topLeft, bottomLeft), right = mix(topRight, bottomRight);
  return [fromPoints([topLeft, topRight, right, left]), fromPoints([left, right, bottomRight, bottomLeft])];
}

function toNatural(point: WorkspacePoint, canvas: HTMLCanvasElement, image: HTMLImageElement) {
  return { x: point.x * image.naturalWidth / canvas.width, y: point.y * image.naturalHeight / canvas.height };
}

function hitCorner(point: WorkspacePoint, geometry: QuadGeometry, canvas: HTMLCanvasElement, image: HTMLImageElement) {
  const points = geometry.points.map((candidate) => ({ x: candidate.x * canvas.width / image.naturalWidth, y: candidate.y * canvas.height / image.naturalHeight }));
  return points.findIndex((candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y) <= 12);
}

function drawQuad(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, image: HTMLImageElement, geometry: QuadGeometry, color: string, label: string) {
  const points = geometry.points.map((point) => ({ x: point.x * canvas.width / image.naturalWidth, y: point.y * canvas.height / image.naturalHeight }));
  context.save(); context.strokeStyle = color; context.fillStyle = color; context.lineWidth = 2; context.setLineDash([6, 4]);
  context.beginPath(); context.moveTo(points[0]!.x, points[0]!.y); points.slice(1).forEach((point) => context.lineTo(point.x, point.y)); context.closePath(); context.stroke();
  context.setLineDash([]); for (const point of points) { context.beginPath(); context.arc(point.x, point.y, 5, 0, Math.PI * 2); context.fill(); }
  context.font = "bold 12px sans-serif"; context.fillText(label, points[0]!.x + 7, Math.max(14, points[0]!.y - 7)); context.restore();
}

function drawScopeShade(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, image: HTMLImageElement, geometry: AnnotationRegionGeometry) {
  const points = geometry.points.map((point) => ({ x: point.x * canvas.width / image.naturalWidth, y: point.y * canvas.height / image.naturalHeight }));
  if (points.length < 3) return;
  context.save(); context.fillStyle = "rgba(15, 23, 42, 0.3)"; context.beginPath(); context.rect(0, 0, canvas.width, canvas.height);
  context.moveTo(points[0]!.x, points[0]!.y); points.slice(1).forEach((point) => context.lineTo(point.x, point.y)); context.closePath(); context.fill("evenodd");
  context.strokeStyle = "#f97316"; context.lineWidth = 2; context.setLineDash([8, 5]); context.beginPath(); context.moveTo(points[0]!.x, points[0]!.y); points.slice(1).forEach((point) => context.lineTo(point.x, point.y)); context.closePath(); context.stroke(); context.restore();
}

function CylindricalSlider({ label, value, min, max, step, display, onChange }: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (value: number) => void }) {
  return <label className="grid gap-1 text-xs font-medium text-violet-900"><span className="flex justify-between gap-2"><span>{label}</span><span>{display}</span></span><input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function drawCylindricalGuideOverlay(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, image: HTMLImageElement, geometry: QuadGeometry, rectification: Extract<LabelRectification, { type: "guided-cylindrical" }>) {
  const project = (point: RecognitionPoint) => ({ x: point.x * canvas.width / image.naturalWidth, y: point.y * canvas.height / image.naturalHeight });
  const drawGuide = (points: Array<{ x: number; y: number }>, color: string) => {
    const projected = points.map((point) => project(mapQuadUnitPoint(geometry.points, point.x, point.y)));
    if (projected.length < 2) return;
    context.save(); context.strokeStyle = color; context.fillStyle = color; context.lineWidth = 1.5; context.setLineDash([4, 3]);
    context.beginPath(); context.moveTo(projected[0]!.x, projected[0]!.y); projected.slice(1).forEach((point) => context.lineTo(point.x, point.y)); context.stroke();
    context.setLineDash([]); projected.forEach((point) => { context.beginPath(); context.arc(point.x, point.y, 4, 0, Math.PI * 2); context.fill(); }); context.restore();
  };
  rectification.guides.horizontalGuides.forEach((guide) => drawGuide(guide, "#0ea5e9"));
  drawGuide(rectification.guides.leftBoundary, "#f59e0b");
  drawGuide(rectification.guides.centerLine, "#22c55e");
  drawGuide(rectification.guides.rightBoundary, "#f59e0b");
}

function hitCylindricalGuide(point: WorkspacePoint, canvas: HTMLCanvasElement, image: HTMLImageElement, geometry: QuadGeometry, rectification: Extract<LabelRectification, { type: "guided-cylindrical" }>): CylindricalGuideHandle | null {
  const candidates: Array<{ handle: CylindricalGuideHandle; distance: number }> = [];
  const collect = (guide: CylindricalGuideHandle["guide"], rows: Array<Array<{ x: number; y: number }>>) => rows.forEach((row, rowIndex) => row.forEach((value, pointIndex) => {
    const source = mapQuadUnitPoint(geometry.points, value.x, value.y);
    const projected = { x: source.x * canvas.width / image.naturalWidth, y: source.y * canvas.height / image.naturalHeight };
    candidates.push({ handle: { guide, rowIndex, pointIndex }, distance: Math.hypot(projected.x - point.x, projected.y - point.y) });
  }));
  collect("horizontalGuides", rectification.guides.horizontalGuides);
  collect("leftBoundary", [rectification.guides.leftBoundary]);
  collect("centerLine", [rectification.guides.centerLine]);
  collect("rightBoundary", [rectification.guides.rightBoundary]);
  const nearest = candidates.sort((left, right) => left.distance - right.distance)[0];
  return nearest && nearest.distance <= 12 ? nearest.handle : null;
}

function clampRectToWorkspace(rect: { x: number; y: number; width: number; height: number }, bounds: { minX: number; minY: number; maxX: number; maxY: number }) {
  const left = Math.max(bounds.minX, Math.min(rect.x, rect.x + rect.width));
  const top = Math.max(bounds.minY, Math.min(rect.y, rect.y + rect.height));
  const right = Math.min(bounds.maxX, Math.max(rect.x, rect.x + rect.width));
  const bottom = Math.min(bounds.maxY, Math.max(rect.y, rect.y + rect.height));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function quadCenter(geometry: QuadGeometry): RecognitionPoint {
  return {
    x: geometry.points.reduce((sum, point) => sum + point.x, 0) / geometry.points.length,
    y: geometry.points.reduce((sum, point) => sum + point.y, 0) / geometry.points.length,
  };
}

function baselineHandlePoint(geometry: QuadGeometry, angleDeg: number): RecognitionPoint {
  const center = quadCenter(geometry);
  const length = Math.max(24, Math.max(geometry.bbox.width, geometry.bbox.height) * 0.65);
  const angle = angleDeg * Math.PI / 180;
  return { x: center.x + Math.cos(angle) * length, y: center.y + Math.sin(angle) * length };
}

function drawBaselineHandle(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, image: HTMLImageElement, geometry: QuadGeometry, angleDeg: number) {
  const center = quadCenter(geometry);
  const handle = baselineHandlePoint(geometry, angleDeg);
  const scale = (point: RecognitionPoint) => ({ x: point.x * canvas.width / image.naturalWidth, y: point.y * canvas.height / image.naturalHeight });
  const start = scale(center), end = scale(handle);
  context.save(); context.strokeStyle = "#2563eb"; context.fillStyle = "#2563eb"; context.lineWidth = 2; context.setLineDash([]);
  context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(end.x, end.y); context.stroke();
  context.beginPath(); context.arc(end.x, end.y, 7, 0, Math.PI * 2); context.fill(); context.restore();
}

function hitBaselineHandle(point: WorkspacePoint, geometry: QuadGeometry, angleDeg: number, canvas: HTMLCanvasElement, image: HTMLImageElement) {
  const handle = baselineHandlePoint(geometry, angleDeg);
  const x = handle.x * canvas.width / image.naturalWidth, y = handle.y * canvas.height / image.naturalHeight;
  return Math.hypot(point.x - x, point.y - y) <= 12;
}

function quadTopAngle(geometry: QuadGeometry) {
  const [left, right] = geometry.points;
  return normalizeDegrees(Math.atan2(right.y - left.y, right.x - left.x) * 180 / Math.PI);
}

function normalizeDegrees(angle: number) {
  if (!Number.isFinite(angle)) return 0;
  const normalized = ((angle + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 ? 180 : normalized;
}

function formatAngle(angle: number) {
  return `${Math.round(angle * 10) / 10}°`;
}

function formatOcrConfidence(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const unit = Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
  return `${Math.round(unit * 1000) / 10}%`;
}

function labelProgressCount(label: AnnotationGraph["packages"][number]["labels"][number]) {
  let count = label.geometryReviewStatus === "reviewed" ? 1 : 0;
  if (label.ocr.some((region) => region.regionStatus === "reviewed")) count += 1;
  const workflow = label.cv.job?.workflow;
  const checkpoints = workflow && typeof workflow === "object" && !Array.isArray(workflow)
    ? (workflow as Record<string, unknown>).checkpoints
    : null;
  if (checkpoints && typeof checkpoints === "object" && !Array.isArray(checkpoints)) {
    for (const stage of ["mask", "morphology", "components", "elements", "contours", "palette"]) {
      if ((checkpoints as Record<string, unknown>)[stage]) count += 1;
    }
  }
  return count;
}
