"use client";

import Link from "next/link";
import { officialWizardAsset, officialWizardVersionEditable } from "./officialWizardAsset";
import { OfficialReferenceSelector } from "./OfficialReferenceSelector";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createPipelinePreset,
  createAnnotationTrack,
  createPipelinePresetRevision,
  createRecognitionJob,
  cancelRecognitionJob,
  deleteRecognitionJob,
  runCvPlayground,
  runCvPlaygroundSweep,
  getRecognitionMetadata,
  getAnnotationGraph,
  listAnnotationVersions,
  getAnnotationVersion,
  createAnnotationVersion,
  bootstrapAnnotationVersion,
  deleteAnnotationVersion,
  editAnnotationVersion,
  makeAnnotationVersionDefault,
  deleteAnnotationGraphEntity,
  updateAnnotationGraphEntity,
  getRecognitionJob,
  getLlmWizardSession,
  getCurrentLlmWizardSession,
  listPipelinePresets,
  listAnnotationTracks,
  getLabelAnnotation,
  getLabelAnalysisWorkspace,
  getCanonicalLabelCvWorkspace,
  getOcrSourceAssociationWorkspace,
  patchRecognitionMetadata,
  previewLabelCvJob,
  putLabelCvCheckpoint,
  putDetectionProposal,
  putLabelAnnotation,
  putLabelAnalysisReview,
  putCatalogIdentityReview,
  putLabelCvJob,
  putLabelAnnotationOcrRegionReview,
  putOcrSourceAssociationReview,
  putManualCvAnnotations,
  runLabelAnalysis,
  runLabelSourceAnalysis,
  runAnnotationGraphPackageDetection,
  putLabelSourceAnalysis,
  type LabelAnnotationState,
  type LabelSourceAnalysisRun,
  type AutoLabelConfigV1,
  type BottleDetectionConfig,
  type LabelAnalysisReview,
  type LabelAnalysisWorkspace as LabelAnalysisWorkspaceState,
  type LabelAnalysisCvConfig,
  type LabelCvStage,
  type LabelCvReviewState,
  type PutCatalogIdentityReview,
  type LabelCvJob,
  type LabelPaletteColor,
  type LabelAnnotationOcrRegionReview,
  type PutLabelAnnotationOcrRegionReview,
  type OcrSourceAssociationWorkspace,
  type PutOcrSourceAssociationReview,
  type ManualCvAnnotationPayload,
  type RecognitionDetailResponse,
  type CvPlaygroundRunResponse,
  type CvPlaygroundSweepResponse,
  type RecognitionItemJob,
  type RecognitionMetaItem,
  type RecognitionRoi,
  type AnnotationTrack,
  type AnnotationGraph,
  type AnnotationVersion,
  type LlmSession,
  type QuadGeometry,
  type AnnotationGraphHelperOperation,
  type PackageDetectionRun,
  type SiglipLabelMode,
  type DinoLabelMode,
  type VisionEvidenceRunOptions,
} from "@/lib/admin/api";
import { getStoredToken } from "@/lib/admin/auth";
import {
  DEFAULT_PIPELINE_CONFIG,
  hashPipelineConfig,
  type PipelineConfig,
  type PipelinePreset,
} from "@/lib/admin/cvPresets";
import { AdminAuthPanel } from "./AdminAuthPanel";
import { AdminNavLinks } from "./AdminNavLinks";
import { AdminRecognitionEditor } from "./AdminRecognitionEditor";
import { AnnotationGraphLabelCollectionWorkspace, AnnotationGraphManager, AnnotationGraphOcrWorkspace, AnnotationGraphStageControls, type AnnotationGraphLabelTarget } from "./AnnotationGraphManager";
import { CvStageDebugger } from "./CvStageDebugger";
import { LabelAnnotationPanel, type AnnotationNavigationStep } from "./LabelAnnotationPanel";
import { WizardLlmReviewPanel } from "./WizardLlmReviewPanel";
import { mergeCvPreviewJob } from "./labelWorkflowState";
import { SavedCvImageWorkspace } from "./SavedCvImageWorkspace";
import { SavedAnnotationVersionViewer } from "./SavedAnnotationVersionViewer";
import { selectDisplayedAnnotationVersionId } from "./annotationVersionSelection";
import { RawJsonBlock } from "./RawJsonBlock";
import { extractLabelTopCandidates } from "./image-workspace/cvOverlays";
import { recognitionDetailSectionHref } from "./recognitionListRouteState";

type Props = {
  source: string;
  sourceItemId: string;
  initialSection?: DetailSection;
  initialTrackId?: string | null;
  queueNav?: QueueNav | null;
  returnHref?: string | null;
};

type DetailSection = "catalog" | "text" | "annotation" | "cv" | "saved" | "history";
type QueueNav = {
  nextHref: string | null;
  prevHref: string | null;
  position: number | null;
  total: number | null;
  queue: string | null;
};
type PreviewState = CvPlaygroundRunResponse & {
  requestId: string;
  configHash: string;
};

const CV_PIPELINE_ENGINE_VERSION = "cv-meta-v2-debug-layers";

export function AdminRecognitionDetailPage({
  source,
  sourceItemId,
  initialSection = "annotation",
  initialTrackId = null,
  queueNav = null,
  returnHref = null,
}: Props) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [detail, setDetail] = useState<RecognitionDetailResponse | null>(null);
  const [annotationTracks, setAnnotationTracks] = useState<AnnotationTrack[]>([]);
  const [annotationGraph, setAnnotationGraph] = useState<AnnotationGraph | null>(null);
  const [annotationVersions, setAnnotationVersions] = useState<AnnotationVersion[]>([]);
  const [activeAnnotationVersionId, setActiveAnnotationVersionId] = useState<string | null>(null);
  const [defaultAnnotationVersionId, setDefaultAnnotationVersionId] = useState<string | null>(null);
  const [selectedAnnotationVersionId, setSelectedAnnotationVersionId] = useState<string | null>(null);
  const [historicalAnnotationGraph, setHistoricalAnnotationGraph] = useState<AnnotationGraph | null>(null);
  const [activeTrackId, setActiveTrackId] = useState<string | null>(initialTrackId);
  const [selectedGraphLabelId, setSelectedGraphLabelId] = useState<string | null>(null);
  const selectedLabelByTrackRef = useRef<Record<string, string | null>>({});
  const [selectedGraphLabelTarget, setSelectedGraphLabelTarget] = useState<AnnotationGraphLabelTarget | null>(null);
  const [selectedGraphOcrTarget, setSelectedGraphOcrTarget] = useState<{ type: "label"; id: string } | null>(null);
  const [wizardNavigationRequest, setWizardNavigationRequest] = useState<{ id: number; step: AnnotationNavigationStep } | null>(null);
  const wizardNavigationRequestId = useRef(0);
  const annotationVersionRequestId = useRef(0);
  const [wizardActiveStep, setWizardActiveStep] = useState<AnnotationNavigationStep>("package");
  const [labelAnnotation, setLabelAnnotation] = useState<LabelAnnotationState | null>(null);
  const [labelSourceAnalysis, setLabelSourceAnalysis] = useState<LabelSourceAnalysisRun | null>(null);
  const [labelAnalysisReview, setLabelAnalysisReview] = useState<LabelAnalysisReview | null>(null);
  const [labelAnalysisWorkspace, setLabelAnalysisWorkspace] = useState<LabelAnalysisWorkspaceState | null>(null);
  const [canonicalLabelCvWorkspace, setCanonicalLabelCvWorkspace] = useState<LabelAnalysisWorkspaceState | null>(null);
  const [ocrRegionReview, setOcrRegionReview] = useState<LabelAnnotationOcrRegionReview | null>(null);
  const [sourceAssociationWorkspace, setSourceAssociationWorkspace] = useState<OcrSourceAssociationWorkspace | null>(null);
  const [draft, setDraft] = useState<FormDraft>(emptyDraft());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cvPreviewing, setCvPreviewing] = useState(false);
  const cvPreviewRequestId = useRef(0);
  const sourceAnalysisRequestId = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [presets, setPresets] = useState<PipelinePreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [draftPipelineConfig, setDraftPipelineConfig] = useState<PipelineConfig>(DEFAULT_PIPELINE_CONFIG);
  const [playgroundRun, setPlaygroundRun] = useState<PreviewState | null>(null);
  const [sweepResult, setSweepResult] = useState<CvPlaygroundSweepResponse | null>(null);
  const [sweepBaselineHash, setSweepBaselineHash] = useState<string | null>(null);
  const [playgroundRunning, setPlaygroundRunning] = useState(false);
  const [llmJobStarting, setLlmJobStarting] = useState(false);
  const [llmSiglipLabelMode, setLlmSiglipLabelMode] = useState<SiglipLabelMode>("off");
  const [llmDinoLabelMode, setLlmDinoLabelMode] = useState<DinoLabelMode>("off");
  const activeAnnotationPackage = annotationGraph?.packages.find((item) => item.legacyAnnotationTrackId === activeTrackId) ?? null;
  const activePackageScope = activeAnnotationPackage?.scope.geometry?.bbox;
  const editorTargetLabelId = selectedGraphLabelTarget?.mode === "existing" ? selectedGraphLabelTarget.id : null;
  const selectedGraphLabel = activeAnnotationPackage?.labels.find((item) => item.id === editorTargetLabelId)
    ?? activeAnnotationPackage?.labels.find((item) => item.id === selectedGraphLabelId)
    ?? activeAnnotationPackage?.labels.find((item) => item.legacyManaged)
    ?? activeAnnotationPackage?.labels[0]
    ?? null;
  const canonicalCvLabelId = selectedGraphLabel && !selectedGraphLabel.legacyManaged ? selectedGraphLabel.id : null;
  const activeCvWorkspace = canonicalCvLabelId ? canonicalLabelCvWorkspace : labelAnalysisWorkspace;
  const selectedAnnotationVersion = annotationVersions.find((version) => version.id === selectedAnnotationVersionId) ?? null;
  const inspectedAnnotationGraph = selectedAnnotationVersionId === activeAnnotationVersionId
    ? annotationGraph
    : historicalAnnotationGraph;
  const inspectedAnnotationJobs = useMemo(() => {
    if (!selectedAnnotationVersion) return [];
    return (detail?.jobs ?? []).filter((job) =>
      job.annotationVersionId === selectedAnnotationVersion.id
      || job.jobId === selectedAnnotationVersion.sourceJobId,
    );
  }, [detail?.jobs, selectedAnnotationVersion]);
  const selectedAnnotationVersionEditable = officialWizardVersionEditable(selectedAnnotationVersion,activeAnnotationVersionId,activeTrackId,annotationTracks.find(t=>t.id===activeTrackId)?.sourceAssetRef);
  const hasActiveItemJobs = Boolean(detail?.jobs.some((job) => job.status === "queued" || job.status === "running"));
  const annotationVersionDeleteBlockedReason = !selectedAnnotationVersion ? "Select a version"
    : annotationVersions.length <= 1 ? "The only version cannot be deleted"
    : selectedAnnotationVersion.isActive ? "Create or edit another version before deleting the active one"
    : selectedAnnotationVersion.status === "processing" ? "Cancel the running job before deleting this version"
    : null;
  const effectiveGraphLabelTarget = selectedGraphLabelTarget?.mode === "new"
    ? selectedGraphLabelTarget.packageId === activeAnnotationPackage?.id ? selectedGraphLabelTarget : null
    : selectedGraphLabelTarget?.mode === "existing" && activeAnnotationPackage?.labels.some((item) => item.id === selectedGraphLabelTarget.id)
      ? selectedGraphLabelTarget
      : null;
  const graphLabelTargetEntity = effectiveGraphLabelTarget?.mode === "existing" ? activeAnnotationPackage?.labels.find((item) => item.id === effectiveGraphLabelTarget.id) ?? null : null;
  const graphLabelUsesLegacyEditor = Boolean(graphLabelTargetEntity?.legacyManaged);
  const effectiveGraphOcrTarget = selectedGraphOcrTarget?.type === "label" && activeAnnotationPackage?.labels.some((item) => item.id === selectedGraphOcrTarget.id)
      ? selectedGraphOcrTarget
      : selectedGraphLabel
        ? { type: "label" as const, id: selectedGraphLabel.id }
        : null;

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setToken(getStoredToken());
      setAuthChecked(true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!authChecked || !token) return;
    let cancelled = false;

    async function loadPresets() {
      try {
        const response = await listPipelinePresets<PipelineConfig>(token, "label-roi");
        if (cancelled) return;
        setPresets(response.items);
        const first = response.items[0] ?? null;
        setSelectedPresetId(first?.id ?? "");
        setDraftPipelineConfig(clonePipelineConfig(first?.config ?? DEFAULT_PIPELINE_CONFIG));
      } catch (nextError) {
        if (!cancelled) {
          setPresets([]);
          setSelectedPresetId("");
          setError(nextError instanceof Error ? nextError.message : "Failed to load pipeline presets");
        }
      }
    }

    loadPresets();
    return () => {
      cancelled = true;
    };
  }, [authChecked, token]);

  useEffect(() => {
    if (!authChecked || !token) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      setMessage(null);

      try {
        const response = await getRecognitionMetadata(source, sourceItemId, token);
        let tracks = (await listAnnotationTracks(source, sourceItemId, token)).items;
        if (!tracks.length) tracks = [await createAnnotationTrack(source, sourceItemId, token)];
        if(initialTrackId && !tracks.some(track=>track.id===initialTrackId)) throw new Error("Selected annotation track is unavailable; select a reference explicitly.");
        const selectedTrack = tracks.find((track) => track.id === initialTrackId) ?? tracks[0];
        const trackId = selectedTrack.id;
        if (initialTrackId !== trackId) router.replace(sectionHref(source, sourceItemId, initialSection, trackId, returnHref), { scroll: false });
        const analysisWorkspace = await getLabelAnalysisWorkspace(source, sourceItemId, trackId, token);
        const annotation = analysisWorkspace?.annotation ?? await getLabelAnnotation(source, sourceItemId, trackId, token);
        const analysisReview = analysisWorkspace.review;
        const regionReview = analysisWorkspace.ocrRegionReview;
        const associationWorkspace = await optionalAdminLayer(() => getOcrSourceAssociationWorkspace(source, sourceItemId, trackId, token));
        const graph = await getAnnotationGraph(source, sourceItemId, token);
        const annotationVersionResponse = await listAnnotationVersions(source, sourceItemId, token);
        const initiallySelectedAnnotationVersionId = selectDisplayedAnnotationVersionId(
          annotationVersionResponse.items,
          annotationVersionResponse.activeVersionId,
          { officialTrackId: selectedTrack.sourceAssetRef?.startsWith("contest/") ? trackId : null },
        );
        const initiallySelectedAnnotationSnapshot = initiallySelectedAnnotationVersionId && initiallySelectedAnnotationVersionId !== annotationVersionResponse.activeVersionId
          ? (await getAnnotationVersion(source, sourceItemId, initiallySelectedAnnotationVersionId, token)).snapshot ?? null
          : null;
        if (cancelled) return;
        setDetail(response);
        setAnnotationTracks(tracks);
        setAnnotationGraph(graph);
        setAnnotationVersions(annotationVersionResponse.items);
        setActiveAnnotationVersionId(annotationVersionResponse.activeVersionId);
        setDefaultAnnotationVersionId(annotationVersionResponse.defaultVersionId);
        setSelectedAnnotationVersionId(initiallySelectedAnnotationVersionId);
        setHistoricalAnnotationGraph(initiallySelectedAnnotationSnapshot);
        setActiveTrackId(trackId);
        setSelectedGraphLabelId(selectedLabelByTrackRef.current[trackId] ?? null);
        setLabelAnnotation(annotation);
        const savedSourceAnalysis = analysisWorkspace?.sourceAnalysis;
        setLabelSourceAnalysis(
          savedSourceAnalysis
          && typeof savedSourceAnalysis === "object"
          && Object.keys(savedSourceAnalysis).length > 0
            ? savedSourceAnalysis as LabelSourceAnalysisRun
            : null,
        );
        setLabelAnalysisReview(analysisReview);
        setLabelAnalysisWorkspace(analysisWorkspace);
        setOcrRegionReview(regionReview);
        setSourceAssociationWorkspace(associationWorkspace);
        setDraft(toDraft(response.metadata));
      } catch (nextError) {
        if (cancelled) return;
        setDetail(null);
        setAnnotationGraph(null);
        setLabelAnnotation(null);
        setLabelSourceAnalysis(null);
        setLabelAnalysisReview(null);
        setLabelAnalysisWorkspace(null);
        setOcrRegionReview(null);
        setSourceAssociationWorkspace(null);
        setError(nextError instanceof Error ? nextError.message : "Failed to load metadata");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [authChecked, initialSection, initialTrackId, returnHref, router, source, sourceItemId, token]);

  useEffect(() => {
    if (!token || !hasActiveItemJobs) return;
    let cancelled = false;
    const refreshJobs = async () => {
      try {
        const response = await getRecognitionMetadata(source, sourceItemId, token);
        if (cancelled) return;
        if (!response.jobs.some((job) => job.status === "queued" || job.status === "running")) {
          const [versions, graph] = await Promise.all([
            listAnnotationVersions(source, sourceItemId, token),
            getAnnotationGraph(source, sourceItemId, token),
          ]);
          const completedSelectionId = selectDisplayedAnnotationVersionId(versions.items, versions.activeVersionId);
          const completedSnapshot = completedSelectionId && completedSelectionId !== versions.activeVersionId
            ? (await getAnnotationVersion(source, sourceItemId, completedSelectionId, token)).snapshot ?? null
            : null;
          if (cancelled) return;
          setAnnotationVersions(versions.items);
          setActiveAnnotationVersionId(versions.activeVersionId);
          setDefaultAnnotationVersionId(versions.defaultVersionId);
          setSelectedAnnotationVersionId(completedSelectionId);
          setHistoricalAnnotationGraph(completedSnapshot);
          setAnnotationGraph(graph);
        }
        if (!cancelled) setDetail(response);
      } catch (nextError) {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : "Failed to refresh running jobs");
      }
    };
    const interval = window.setInterval(() => { void refreshJobs(); }, 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [hasActiveItemJobs, initialSection, source, sourceItemId, token]);

  useEffect(() => {
    if (!token || !activeTrackId || !canonicalCvLabelId) {
      queueMicrotask(() => setCanonicalLabelCvWorkspace(null));
      return;
    }
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) setCanonicalLabelCvWorkspace(null); });
    void getCanonicalLabelCvWorkspace(source, sourceItemId, activeTrackId, canonicalCvLabelId, token)
      .then((workspace) => { if (!cancelled) setCanonicalLabelCvWorkspace(workspace); })
      .catch((nextError) => { if (!cancelled) setError(nextError instanceof Error ? nextError.message : "Canonical Label CV workspace failed"); });
    return () => { cancelled = true; };
  }, [activeTrackId, canonicalCvLabelId, source, sourceItemId, token]);

  const selectedSourceAsset = officialWizardAsset(activeAnnotationPackage?.sourceAssetRef,annotationTracks.find(t=>t.id===activeTrackId)?.sourceAssetRef,detail?.sourceItem.imageUrls[0]);
  const officialTrack = Boolean(selectedSourceAsset?.startsWith("contest/"));
  const imageUrl = useMemo(() => {
    const first = selectedSourceAsset;
    if (!first) return null;
    if (/^https?:\/\//.test(first) || first.startsWith("/")) return first;
    return `/api/admin/assets/${first.replace(/\\/g, "/")}`;
  }, [selectedSourceAsset]);


  const editorItem = useMemo(() => {
    if (!detail) return null;
    return {
      source: detail.sourceItem.source,
      external_id: detail.sourceItem.sourceItemId,
      recognitionKey: `${detail.sourceItem.source}:${detail.sourceItem.sourceItemId}`,
      local_id: null,
      title: detail.sourceItem.title,
      manufacturer: detail.sourceItem.producer,
      category: detail.sourceItem.category,
      region: detail.sourceItem.region,
      year: detail.sourceItem.year,
      rating: null,
      barcode: detail.sourceItem.barcode,
      description: detail.sourceItem.description,
      source_url: null,
      image: {
        url: imageUrl,
        local_path: selectedSourceAsset,
        content_type: null,
        size_bytes: null,
      },
    };
  }, [detail, imageUrl, selectedSourceAsset]);

  function handleTokenChange(nextToken: string | null) {
    setToken(nextToken);
    if (!nextToken) {
      setDetail(null);
      setAnnotationGraph(null);
      setLabelAnnotation(null);
      setOcrRegionReview(null);
      setSourceAssociationWorkspace(null);
      setError(null);
      setMessage(null);
    }
  }

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) ?? presets[0] ?? null,
    [presets, selectedPresetId]
  );

  function handlePresetChange(presetId: string) {
    setSelectedPresetId(presetId);
    const preset = presets.find((item) => item.id === presetId);
    if (preset) handleDraftPipelineConfigChange(clonePipelineConfig(preset.config));
  }

  function handleDraftPipelineConfigChange(config: PipelineConfig) {
    setDraftPipelineConfig(config);
  }

  async function handleGenerate(
    type: "GENERATE_ALIASES" | "GENERATE_DETECTION_PROPOSAL" | "GENERATE_CV_META" | "REGENERATE_ALL_META",
    preset: PipelinePreset | null = null
  ) {
    if (!token) return;
    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const presetOptions = preset
        ? {
            presetId: preset.id,
            presetRevision: preset.revision,
          }
        : {};
      const job = await createRecognitionJob(source, sourceItemId, token, true, type, {...presetOptions,annotationTrackId:activeTrackId ?? undefined});
      setMessage(`${formatJobType(type)} job accepted: ${job.jobId}. Status is refreshed by polling.`);
      let jobStatus = await getRecognitionJob(job.jobId, token);
      for (let attempt = 0; attempt < 10 && !["completed", "failed"].includes(jobStatus.status); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        jobStatus = await getRecognitionJob(job.jobId, token);
      }
      const nextDetail = await getRecognitionMetadata(source, sourceItemId, token);
      const nextAnnotation = await getLabelAnnotation(source, sourceItemId, activeTrackId!, token);
      setDetail(nextDetail);
      setLabelAnnotation(nextAnnotation);
      setDraft(toDraft(nextDetail.metadata));

      if (!["completed", "failed"].includes(jobStatus.status)) {
        setMessage(`${formatJobType(type)} job is ${jobStatus.status}: ${job.jobId}. Check Item job history.`);
        return;
      }

      if (jobStatus.status === "failed") {
        throw new Error(jobStatus.error ?? `Recognition job ${jobStatus.status}`);
      }
      setMessage(`${formatJobType(type)} job completed after status refresh: ${job.jobId}.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Generation failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveCurrentPreset() {
    if (!token) return;
    const name = window.prompt("Preset name", detail?.sourceItem.title ? `${detail.sourceItem.title} preset` : "Local detection preset");
    if (!name?.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const preset = await createPipelinePreset<PipelineConfig>(
        {
          layer: "label-roi",
          name: name.trim(),
          status: "draft",
          engineKind: "opencv",
          engineVersion: CV_PIPELINE_ENGINE_VERSION,
          config: clonePipelineConfig(draftPipelineConfig),
          createdFrom: { source, sourceItemId },
        },
        token
      );
      setPresets((current) => [preset, ...current]);
      setSelectedPresetId(preset.id);
      setMessage(`Server preset created: ${preset.name} rev ${preset.revision}.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save pipeline preset");
    } finally {
      setSaving(false);
    }
  }

  async function handleSavePresetRevision() {
    if (!token || !selectedPreset) return;
    setSaving(true);
    setError(null);
    try {
      const preset = await createPipelinePresetRevision<PipelineConfig>(
        selectedPreset.id,
        {
          baseRevision: selectedPreset.revision,
          config: clonePipelineConfig(draftPipelineConfig),
          status: "draft",
          createdFrom: { source, sourceItemId },
        },
        token
      );
      setPresets((current) => current.map((item) => (item.id === preset.id ? preset : item)));
      setSelectedPresetId(preset.id);
      setMessage(`Server preset revision saved: ${preset.name} rev ${preset.revision}.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save preset revision");
    } finally {
      setSaving(false);
    }
  }

  async function handleRunPlaygroundPreview() {
    if (!token) return;
    const configSnapshot = clonePipelineConfig(draftPipelineConfig);
    const configHash = hashPipelineConfig(configSnapshot);
    setPlaygroundRunning(true);
    setError(null);
    setMessage(`HTTP preview started for draft ${shortHash(configHash)}. This is a direct request, not a queued job.`);
    try {
      const result = await runCvPlayground(
        {
          source,
          sourceItemId,
          annotationTrackId: activeTrackId ?? undefined,
          config: configSnapshot,
          mode: "preview",
        },
        token
      );
      setPlaygroundRun({ ...result, requestId: result.runId, configHash });
      setMessage(`Preview completed: ${result.metrics.runtimeMs} ms, ${result.metrics.candidateCount} candidates.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Playground preview failed");
    } finally {
      setPlaygroundRunning(false);
    }
  }

  async function handleRunSweep(sweeps: Array<{ parameterPath: string; values: number[] }>) {
    if (!token) return;
    const baseConfig = clonePipelineConfig(draftPipelineConfig);
    const baselineHash = hashPipelineConfig(baseConfig);
    setPlaygroundRunning(true);
    setError(null);
    setSweepBaselineHash(baselineHash);
    setMessage(`HTTP sweep started from baseline ${shortHash(baselineHash)}. This is not a queued job.`);
    try {
      const result = await runCvPlaygroundSweep(
        {
          source,
          sourceItemId,
          annotationTrackId: activeTrackId ?? undefined,
          baseConfig,
          sweeps,
          mode: "preview",
        },
        token
      );
      setSweepResult(result);
      setMessage(`Sweep completed: ${result.totalVariants} variants, ${result.runtimeMs} ms.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Playground sweep failed");
    } finally {
      setPlaygroundRunning(false);
    }
  }

  async function handleSave() {
    if (!token) return;
    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const payload = parseDraft(draft);
      const updated = await patchRecognitionMetadata(source, sourceItemId, payload, token);
      setDraft(toDraft(updated));
      setDetail((current) => (current ? { ...current, metadata: updated } : current));
      setMessage("Metadata saved.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveManualAnnotations(payload: ManualCvAnnotationPayload) {
    if (!token || !detail) return;
    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      await putManualCvAnnotations(detail.sourceItem.source, detail.sourceItem.sourceItemId, payload, token);
      const nextDetail = await getRecognitionMetadata(source, sourceItemId, token);
      setDetail(nextDetail);
      setDraft(toDraft(nextDetail.metadata));
      setMessage("Manual image annotations saved.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Manual annotations save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveLabelAnnotation(annotation: LabelAnnotationState) {
    if (!token || !detail) return null;
    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const previousReviewedBbox = labelAnnotation?.annotation?.roi ?? null;
      const savedAnnotation = await putLabelAnnotation(source, sourceItemId, activeTrackId!, annotation, token);
      const reviewedBboxChanged = !sameRecognitionRoi(previousReviewedBbox, annotation.annotation?.roi ?? null);
      if (annotation.annotation?.roi && (!labelSourceAnalysis?.bottleDetection?.annotation || reviewedBboxChanged)) {
        const evaluatedSourceAnalysis = await runLabelSourceAnalysis(source, sourceItemId, activeTrackId!, token, annotation.annotation.roi, undefined, labelSourceAnalysis?.labelDetection?.config, activePackageScope, {
          labelMode: labelSourceAnalysis?.visionEvidenceConfig?.labelMode ?? "off",
          dinoMode: labelSourceAnalysis?.visionEvidenceConfig?.dinoMode ?? "off",
        });
        await putLabelSourceAnalysis(source, sourceItemId, activeTrackId!, withoutBottleRaster(evaluatedSourceAnalysis), token);
        setLabelSourceAnalysis(evaluatedSourceAnalysis);
      }
      const nextDetail = await getRecognitionMetadata(source, sourceItemId, token);
      setLabelAnnotation(savedAnnotation);
      await refreshAnnotationGraph();
      setLabelAnalysisWorkspace((current) => current ? { ...current, annotation: savedAnnotation, stale: Boolean(current.analysis) } : current);
      setDetail(nextDetail);
      setDraft(toDraft(nextDetail.metadata));
      setMessage("Label annotation saved.");
      return savedAnnotation;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Label annotation save failed");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveLabelAnnotationAndNext(annotation: LabelAnnotationState) {
    const saved = await handleSaveLabelAnnotation(annotation);
    if (!saved) return;
    if (saved?.status === "no-label" || saved?.status === "invalid-image") {
      if (queueNav?.nextHref) router.push(queueNav.nextHref);
      return;
    }
    // Own the transition above LabelAnnotationPanel: saving refreshes the graph and may
    // remount the child before its local setStep("bottle") can run.
    navigateWizard("bottle");
  }

  async function handleRunLabelSourceAnalysis(verifiedLabel?: { x: number; y: number; width: number; height: number }, outerConfig?: BottleDetectionConfig, labelConfig?: AutoLabelConfigV1, visionEvidence?: VisionEvidenceRunOptions) {
    if (!token) return null;
    const requestId = ++sourceAnalysisRequestId.current;
    const effectiveVerifiedLabel = verifiedLabel ?? (outerConfig
      ? selectedGraphLabel?.geometry.bbox ?? labelAnnotation?.annotation?.roi ?? undefined
      : undefined);
    setSaving(true); setError(null); setMessage(null);
    try {
      const result = await runLabelSourceAnalysis(source, sourceItemId, activeTrackId!, token, effectiveVerifiedLabel, outerConfig, labelConfig, activePackageScope, visionEvidence);
      if (requestId !== sourceAnalysisRequestId.current) return result;
      setLabelSourceAnalysis(result);
      setMessage(effectiveVerifiedLabel ? "Source context recalculated from reviewed ROI." : `${result.candidates.length} label candidate(s) generated.`);
      return result;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Source analysis failed");
      return null;
    } finally { if (requestId === sourceAnalysisRequestId.current) setSaving(false); }
  }

  async function handleSaveLabelSourceAnalysis(state: LabelSourceAnalysisRun) {
    if (!token) return null;
    setSaving(true); setError(null); setMessage(null);
    try {
      const persisted = withoutBottleRaster(state);
      const saved = await putLabelSourceAnalysis(source, sourceItemId, activeTrackId!, persisted, token);
      const hydrated = state.bottleDetection?.debug.raster && saved.bottleDetection
        ? { ...saved, bottleDetection: { ...saved.bottleDetection, debug: { ...saved.bottleDetection.debug, raster: state.bottleDetection.debug.raster } } }
        : saved;
      setLabelSourceAnalysis(hydrated);
      await refreshAnnotationGraph();
      setMessage("Object/source context saved.");
      return hydrated;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Object/source context save failed");
      return null;
    } finally { setSaving(false); }
  }

  async function handleAnalyzeLabel(config?: LabelAnalysisCvConfig) {
    if (!token) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const job = await runLabelAnalysis(source, sourceItemId, activeTrackId!, token, true, config);
      setMessage(`Label analysis queued: ${job.jobId}.`);
      let status = await getRecognitionJob(job.jobId, token);
      for (let attempt = 0; attempt < 30 && !["completed", "failed"].includes(status.status); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        status = await getRecognitionJob(job.jobId, token);
      }
      const nextDetail = await getRecognitionMetadata(source, sourceItemId, token);
      const nextWorkspace = await getLabelAnalysisWorkspace(source, sourceItemId, activeTrackId!, token);
      setDetail(nextDetail);
      setLabelAnnotation(nextWorkspace.annotation);
      setLabelAnalysisReview(nextWorkspace.review);
      setLabelAnalysisWorkspace(nextWorkspace);
      setDraft(toDraft(nextDetail.metadata));
      if (status.status === "failed") throw new Error(status.error ?? "Label analysis failed");
      setMessage(status.status === "completed" ? "Label analysis completed." : `Label analysis is ${status.status}; it will continue in the worker.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Label analysis failed");
    } finally {
      setSaving(false);
    }
  }

  async function handlePreviewLabelCvJob(stage: LabelCvStage, config: LabelAnalysisCvConfig, review?: LabelCvReviewState): Promise<LabelCvJob | null> {
    if (!token) return null;
    const requestId = ++cvPreviewRequestId.current;
    setCvPreviewing(true);
    setError(null);
    try {
      const cvJob = await previewLabelCvJob(source, sourceItemId, activeTrackId!, stage, config, token, review, canonicalCvLabelId);
      if (requestId !== cvPreviewRequestId.current) return null;
      const updateWorkspace = (current: LabelAnalysisWorkspaceState | null) => current ? { ...current, cvJob: mergeCvPreviewJob(current.cvJob, cvJob) } : current;
      if (canonicalCvLabelId) setCanonicalLabelCvWorkspace(updateWorkspace);
      else setLabelAnalysisWorkspace(updateWorkspace);
      return cvJob;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "CV preview failed");
      return null;
    } finally {
      if (requestId === cvPreviewRequestId.current) setCvPreviewing(false);
    }
  }

  async function refreshAnnotationGraph() {
    if (!token) return null;
    const graph = await getAnnotationGraph(source, sourceItemId, token);
    setAnnotationGraph(graph);
    return graph;
  }

  async function refreshAnnotationVersions(preferredVersionId?: string) {
    if (!token) return;
    const response = await listAnnotationVersions(source, sourceItemId, token);
    const selectedVersionId = selectDisplayedAnnotationVersionId(response.items, response.activeVersionId, { preferredVersionId });
    setAnnotationVersions(response.items);
    setActiveAnnotationVersionId(response.activeVersionId);
    setDefaultAnnotationVersionId(response.defaultVersionId);
    setSelectedAnnotationVersionId(selectedVersionId);
    return { ...response, selectedVersionId };
  }

  async function handleSelectAnnotationVersion(versionId: string) {
    if (!token) return;
    const requestId = ++annotationVersionRequestId.current;
    setSelectedAnnotationVersionId(versionId);
    setHistoricalAnnotationGraph(null);
    setError(null);
    if (versionId === activeAnnotationVersionId) {
      return;
    }
    try {
      const version = await getAnnotationVersion(source, sourceItemId, versionId, token);
      if (requestId !== annotationVersionRequestId.current) return;
      setHistoricalAnnotationGraph(version.snapshot ?? null);
    } catch (nextError) {
      if (requestId !== annotationVersionRequestId.current) return;
      setError(nextError instanceof Error ? nextError.message : "Failed to load annotation version");
    }
  }

  async function handleCreateAnnotationVersion() {
    if (officialTrack) { setError("Use the official reference selector to open a separate draft."); return; }
    if (!token || !window.confirm("Create a new empty annotation version? The current workspace will remain available as a read-only snapshot.")) return;
    setSaving(true);
    setError(null);
    try {
      const created = await createAnnotationVersion(source, sourceItemId, token);
      setHistoricalAnnotationGraph(null);
      const [graph, tracks] = await Promise.all([
        getAnnotationGraph(source, sourceItemId, token),
        listAnnotationTracks(source, sourceItemId, token),
      ]);
      setAnnotationGraph(graph);
      setAnnotationTracks(tracks.items);
      setActiveTrackId(created.annotationTrackId);
      await refreshAnnotationVersions(created.versionId);
      setMessage(`Annotation v${created.revision} created as the active draft.`);
      router.replace(sectionHref(source, sourceItemId, "annotation", created.annotationTrackId, returnHref), { scroll: false });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to create annotation version");
    } finally {
      setSaving(false);
    }
  }

  async function handleEditSelectedAnnotationVersion() {
    if (officialTrack) { setError("Use the official reference selector to open a separate draft."); return; }
    if (!token || !selectedAnnotationVersion || selectedAnnotationVersionEditable || selectedAnnotationVersion.status === "processing") return;
    if (!window.confirm(`Create an editable copy of annotation v${selectedAnnotationVersion.revision}? The selected version will remain immutable.`)) return;
    setSaving(true);
    setError(null);
    try {
      const created = await editAnnotationVersion(source, sourceItemId, selectedAnnotationVersion.id, token);
      setHistoricalAnnotationGraph(null);
      const [graph, tracks] = await Promise.all([
        getAnnotationGraph(source, sourceItemId, token),
        listAnnotationTracks(source, sourceItemId, token),
      ]);
      setAnnotationGraph(graph);
      setAnnotationTracks(tracks.items);
      setActiveTrackId(created.annotationTrackId);
      await refreshAnnotationVersions(created.versionId);
      setMessage(`Annotation v${created.revision} created from v${selectedAnnotationVersion.revision} and opened for editing.`);
      router.replace(sectionHref(source, sourceItemId, "annotation", created.annotationTrackId, returnHref), { scroll: false });
      router.refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to create an editable annotation version");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteSelectedAnnotationVersion() {
    if (!token || !selectedAnnotationVersion || selectedAnnotationVersion.isActive || selectedAnnotationVersion.status === "processing" || annotationVersions.length <= 1) return;
    const defaultWarning = selectedAnnotationVersion.isDefault
      ? "\n\nThis is the current recognition default. Deleting it will clear the default until another completed version is approved."
      : "";
    if (!window.confirm(`Permanently delete annotation v${selectedAnnotationVersion.revision}? Its snapshot cannot be recovered.${defaultWarning}`)) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const deletedRevision = selectedAnnotationVersion.revision;
      const deleted = await deleteAnnotationVersion(source, sourceItemId, selectedAnnotationVersion.id, token);
      annotationVersionRequestId.current += 1;
      setHistoricalAnnotationGraph(null);
      const refreshed = await refreshAnnotationVersions(deleted.activeVersionId);
      if (refreshed?.selectedVersionId && refreshed.selectedVersionId !== refreshed.activeVersionId) {
        const nextVersion = await getAnnotationVersion(source, sourceItemId, refreshed.selectedVersionId, token);
        setHistoricalAnnotationGraph(nextVersion.snapshot ?? null);
      }
      setMessage(`Annotation v${deletedRevision} deleted.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to delete annotation version");
    } finally {
      setSaving(false);
    }
  }

  async function handleRunVersionLlmJob(llmExecutionMode: "session-chain" | "one-shot-chain") {
    if (!token || !activeTrackId) return;
    const selected = selectedAnnotationVersionId
      ? annotationVersions.find((version) => version.id === selectedAnnotationVersionId) ?? null
      : null;
    if (selected && ((!officialTrack && selected.id !== activeAnnotationVersionId) || selected.status === "approved" || selected.status === "processing")) return;
    const modeLabel = llmExecutionMode === "session-chain" ? "dialog session" : "one-shot requests";
    const confirmation = officialTrack
      ? `Run the full LLM pipeline on the selected official reference using ${modeLabel}?\n\nLabel evidence: SigLIP ${llmSiglipLabelMode}; DINOv3 ${llmDinoLabelMode}.`
      : selected
      ? `Clear annotation v${selected.revision} and run the full LLM pipeline from Package using ${modeLabel}?\n\nLabel evidence: SigLIP ${llmSiglipLabelMode}; DINOv3 ${llmDinoLabelMode}.`
      : `Run the full LLM pipeline from Package using ${modeLabel}?\n\nLabel evidence: SigLIP ${llmSiglipLabelMode}; DINOv3 ${llmDinoLabelMode}. Annotation v1 will be created only if the Package gate is accepted as a single package.`;
    if (!window.confirm(confirmation)) return;
    setLlmJobStarting(true);
    setError(null);
    try {
      const job = await createRecognitionJob(source, sourceItemId, token, true, "ANNOTATION_LLM_PIPELINE", {
        ...(selected
          ? { annotationVersionId: selected.id, annotationVersionInitialization: "empty" as const }
          : { annotationVersionInitialization: "after-package" as const }),
        annotationTrackId: activeTrackId,
        annotationVersionPublishPolicy: "review",
        llmExecutionMode,
        visionEvidence: { labelMode: llmSiglipLabelMode, dinoMode: llmDinoLabelMode },
      });
      setDetail(await getRecognitionMetadata(source, sourceItemId, token));
      if (selected) await refreshAnnotationVersions(selected.id);
      setMessage(selected
        ? `LLM job ${job.jobId} queued for annotation v${selected.revision}. It will remain non-default until final approval.`
        : `LLM job ${job.jobId} queued. No version exists yet; an active draft will be created after the Package gate accepts a single package.`);
      if (job.annotationTrackId) {
        router.replace(sectionHref(source, sourceItemId, "annotation", job.annotationTrackId, returnHref), { scroll: false });
        router.refresh();
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to start the version LLM job");
    } finally {
      setLlmJobStarting(false);
    }
  }

  async function refreshWizardAfterLlm() {
    await refreshAnnotationGraph();
    if (!token || !activeTrackId) return;
    const workspace = canonicalCvLabelId
      ? await optionalAdminLayer(() => getCanonicalLabelCvWorkspace(source, sourceItemId, activeTrackId, canonicalCvLabelId, token))
      : await optionalAdminLayer(() => getLabelAnalysisWorkspace(source, sourceItemId, activeTrackId, token));
    if (workspace) {
      if (canonicalCvLabelId) setCanonicalLabelCvWorkspace(workspace);
      else setLabelAnalysisWorkspace(workspace);
    }
  }

  async function handleRunPackageHelper(): Promise<PackageDetectionRun | null> {
    if (!token || !activeAnnotationPackage) return null;
    setSaving(true); setError(null); setMessage(null);
    try {
      const result = await runAnnotationGraphPackageDetection(source, sourceItemId, { type: "package", id: activeAnnotationPackage.id }, token);
      setMessage(`${result.candidates.length} Package candidate(s) detected.`);
      return result;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Package Auto Helper failed");
      return null;
    } finally { setSaving(false); }
  }

  async function handleSavePackageScope(geometry: QuadGeometry | null, helper?: { packageType: "bottle" | "box"; operation: AnnotationGraphHelperOperation }) {
    if (!token || !annotationGraph || !activeTrackId) return false;
    const activePackage = annotationGraph.packages.find((item) => item.legacyAnnotationTrackId === activeTrackId);
    if (!activePackage) { setError("Active Package is not available"); return false; }
    setSaving(true); setError(null); setMessage(null);
    try {
      await updateAnnotationGraphEntity(
        source,
        sourceItemId,
        "package",
        activePackage.id,
        { geometry, status: "reviewed", ...(helper ? { packageType: { value: helper.packageType, status: "reviewed", source: helper.operation.reviewMode === "accepted" ? "auto" : "human" } } : {}) },
        token,
        helper?.operation,
      );
      // Package geometry is an input of Label detection. Never keep rendering
      // candidates calculated against the previous Package contour.
      setLabelSourceAnalysis(null);
      await refreshAnnotationGraph();
      setMessage(geometry ? "Package crop saved." : "Package scope reset to full image.");
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Package crop save failed");
      return false;
    } finally { setSaving(false); }
  }

  async function handleApprovePackageAndOpenLabel() {
    if (!token || !annotationGraph || !activeAnnotationPackage) return false;
    setSaving(true); setError(null); setMessage(null);
    try {
      await updateAnnotationGraphEntity(source, sourceItemId, "package", activeAnnotationPackage.id, { status: "reviewed" }, token);
      const officialVersion=officialTrack ? annotationVersions.find(v=>v.annotationTrackId===activeTrackId) : null;
      const version = officialVersion ? {versionId:officialVersion.id,revision:officialVersion.revision,created:false} : await bootstrapAnnotationVersion(source, sourceItemId, token);
      const graph = await getAnnotationGraph(source, sourceItemId, token);
      setAnnotationGraph(graph);
      await refreshAnnotationVersions(version.versionId);
      setSelectedGraphLabelTarget(null);
      if (selectedGraphLabel) setSelectedGraphOcrTarget({ type: "label", id: selectedGraphLabel.id });
      setMessage(version.created
        ? `Package approved. Annotation v${version.revision} created as the active draft.`
        : `Package approved in annotation v${version.revision}.`);
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Package approval failed");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveLabelCvJob(config: LabelAnalysisCvConfig, palette: LabelPaletteColor[], review?: LabelCvReviewState) {
    if (!token) return null;
    cvPreviewRequestId.current += 1;
    setCvPreviewing(false);
    setSaving(true); setError(null); setMessage(null);
    try {
      await putLabelCvJob(source, sourceItemId, activeTrackId!, config, palette, token, review, canonicalCvLabelId);
      const workspace = canonicalCvLabelId
        ? await getCanonicalLabelCvWorkspace(source, sourceItemId, activeTrackId!, canonicalCvLabelId, token)
        : await getLabelAnalysisWorkspace(source, sourceItemId, activeTrackId!, token);
      if (canonicalCvLabelId) { setCanonicalLabelCvWorkspace(workspace); await refreshAnnotationGraph(); }
      else setLabelAnalysisWorkspace(workspace);
      setMessage(`CVJOB config and reviewed palette saved to ${canonicalCvLabelId ? "Label" : "item Meta"}.`);
      return workspace.cvJob;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "CVJOB save failed");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveLabelCvCheckpoint(stage: LabelCvStage, config: LabelAnalysisCvConfig, review?: LabelCvReviewState, palette?: LabelPaletteColor[]) {
    if (!token) return null;
    cvPreviewRequestId.current += 1;
    setCvPreviewing(false);
    setSaving(true); setError(null); setMessage(null);
    try {
      const cvJob = await putLabelCvCheckpoint(source, sourceItemId, activeTrackId!, stage, config, token, review, palette, canonicalCvLabelId);
      const updateWorkspace = (current: LabelAnalysisWorkspaceState | null) => current ? { ...current, cvJob } : current;
      if (canonicalCvLabelId) { setCanonicalLabelCvWorkspace(updateWorkspace); await refreshAnnotationGraph(); }
      else setLabelAnalysisWorkspace(updateWorkspace);
      setMessage(`${stage} checkpoint saved to ${canonicalCvLabelId ? "Label" : "item Meta"}.`);
      return cvJob;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "CV stage checkpoint save failed");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handleReviewLabelAnalysis(status: LabelAnalysisReview["status"], notes: string) {
    const analysis = labelAnalysisWorkspace?.analysis;
    if (!token || !analysis) return false;
    const normalizedNotes = notes.trim();
    if (
      labelAnalysisReview?.annotationId === analysis.annotationId
      && labelAnalysisReview.annotationRevision === analysis.annotationRevision
      && labelAnalysisReview.jobId === analysis.jobId
      && labelAnalysisReview.configHash === analysis.provenance.configHash
      && labelAnalysisReview.status === status
      && labelAnalysisReview.notes === normalizedNotes
    ) {
      setMessage(`Label analysis review r${labelAnalysisReview.revision} is already saved.`);
      return true;
    }
    setSaving(true); setError(null); setMessage(null);
    try {
      const review = await putLabelAnalysisReview(source, sourceItemId, activeTrackId!, {
        baseRevision: labelAnalysisReview?.revision ?? 0,
        annotationId: analysis.annotationId,
        annotationRevision: analysis.annotationRevision,
        jobId: analysis.jobId,
        configHash: analysis.provenance.configHash,
        status,
        notes: normalizedNotes,
      }, token);
      setLabelAnalysisReview(review);
      const refreshedWorkspace = await optionalAdminLayer(() => getLabelAnalysisWorkspace(source, sourceItemId, activeTrackId!, token));
      setLabelAnalysisWorkspace((current) => refreshedWorkspace ?? (current ? { ...current, review } : current));
      setLabelAnalysisReview(refreshedWorkspace?.review ?? review);
      if (review.status === "accepted") await refreshAnnotationVersions(activeAnnotationVersionId ?? undefined);
      setMessage(`Label analysis review r${review.revision}: ${review.status}.`);
      return true;
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Label analysis review failed"); return false; }
    finally { setSaving(false); }
  }

  async function handleConfirmCanonicalSummary() {
    if (!token || !selectedAnnotationVersion || selectedAnnotationVersion.id !== activeAnnotationVersionId) {
      setError("Select the active annotation version before confirming the summary.");
      return false;
    }
    if (!annotationGraph?.validation.readyForCanonicalExport) {
      setError("Resolve the annotation graph warnings before confirming the summary.");
      return false;
    }
    setSaving(true); setError(null); setMessage(null);
    try {
      const approved = await makeAnnotationVersionDefault(source, sourceItemId, selectedAnnotationVersion.id, token);
      await refreshAnnotationVersions(approved.id);
      setMessage(`Annotation v${approved.revision} approved and set as default.`);
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Annotation version approval failed");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveOcrRegionReview(input: PutLabelAnnotationOcrRegionReview) {
    if (!token) return null;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const review = await putLabelAnnotationOcrRegionReview(source, sourceItemId, activeTrackId!, input, token);
      setOcrRegionReview(review);
      await refreshAnnotationGraph();
      const [associationWorkspace, analysisWorkspace] = await Promise.all([
        optionalAdminLayer(() => getOcrSourceAssociationWorkspace(source, sourceItemId, activeTrackId!, token)),
        optionalAdminLayer(() => getLabelAnalysisWorkspace(source, sourceItemId, activeTrackId!, token)),
      ]);
      setSourceAssociationWorkspace(associationWorkspace);
      setLabelAnalysisWorkspace(analysisWorkspace);
      setLabelAnalysisReview(analysisWorkspace?.review ?? null);
      setMessage(`OCR region review rev ${review.revision} saved; source and catalog matches recalculated.`);
      return review;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "OCR region review save failed");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveSourceAssociationReview(input: PutOcrSourceAssociationReview) {
    if (!token) return null;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const review = await putOcrSourceAssociationReview(source, sourceItemId, activeTrackId!, input, token);
      setSourceAssociationWorkspace(await getOcrSourceAssociationWorkspace(source, sourceItemId, activeTrackId!, token));
      setMessage(`Source association review rev ${review.revision} saved.`);
      return review;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Source association review save failed");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveCatalogIdentityReview(input: PutCatalogIdentityReview) {
    if (!token) return null;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const review = await putCatalogIdentityReview(source, sourceItemId, activeTrackId!, input, token);
      setLabelAnalysisWorkspace(await getLabelAnalysisWorkspace(source, sourceItemId, activeTrackId!, token));
      setMessage(`Catalog identity review rev ${review.revision} saved.`);
      return review;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Catalog identity review save failed");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handleUsePreviewCandidateAsProposal(preview: PreviewState) {
    if (!token) return;
    const candidate = extractLabelTopCandidates({ cvMeta: preview.cvMeta }).find((item) => item.rank === 1);
    if (!candidate) {
      setError("Preview has no selected label candidate to save as proposal");
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const savedAnnotation = await putDetectionProposal(
        source,
        sourceItemId,
        activeTrackId!,
        {
          roi: candidate.rect,
          algorithm: {
            id: "cv-lab-label-roi",
            version: "cv-lab-preview",
            params: { configHash: preview.configHash, candidateScore: candidate.score },
          },
          confidence: candidate.confidence,
          createdAt: new Date().toISOString(),
        },
        token
      );
      setLabelAnnotation(savedAnnotation);
      setMessage("Preview candidate saved as detection proposal.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Saving proposal failed");
    } finally {
      setSaving(false);
    }
  }

  function switchAnnotationTrack(trackId: string) {
    if (activeTrackId) selectedLabelByTrackRef.current[activeTrackId] = selectedGraphLabel?.id ?? null;
    setSelectedGraphLabelId(selectedLabelByTrackRef.current[trackId] ?? null);
    router.push(sectionHref(source, sourceItemId, initialSection, trackId, returnHref));
  }

  function selectGraphLabel(labelId: string) {
    setSelectedGraphLabelId(labelId);
    if (activeTrackId) selectedLabelByTrackRef.current[activeTrackId] = labelId;
  }

  function navigateWizard(step: AnnotationNavigationStep) {
    if (!activeAnnotationVersionId && step !== "package") {
      setError("Approve the Package stage before opening the rest of the pipeline.");
      return;
    }
    wizardNavigationRequestId.current += 1;
    setWizardNavigationRequest({ id: wizardNavigationRequestId.current, step });
  }

  async function handleAddAnnotationTrack() {
    if (!token) return;
    setSaving(true); setError(null);
    try {
      const created = await createAnnotationTrack(source, sourceItemId, token);
      setAnnotationTracks((current) => [...current, created]);
      await refreshAnnotationGraph();
      switchAnnotationTrack(created.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to create annotation track");
    } finally { setSaving(false); }
  }

  async function handleDeletePackage(packageId: string) {
    if (!token || !annotationGraph) return;
    const packageIndex = annotationGraph.packages.findIndex((item) => item.id === packageId);
    const packageItem = annotationGraph.packages[packageIndex];
    if (!packageItem) return;
    const labelCount = packageItem.labels.length;
    const ocrCount = packageItem.ocr.length + packageItem.labels.reduce((total, label) => total + label.ocr.length, 0);
    const confirmed = window.confirm(
      `Delete Package #${packageIndex + 1} and its related annotation data?\n\n${labelCount} Label(s), ${ocrCount} OCR region(s), CV checkpoints and Meta will be removed. Operation history is retained.`,
    );
    if (!confirmed) return;

    setSaving(true); setError(null); setMessage(null);
    try {
      await deleteAnnotationGraphEntity(source, sourceItemId, "package", packageId, token);
      let tracks = (await listAnnotationTracks(source, sourceItemId, token)).items;
      if (!tracks.length) tracks = [await createAnnotationTrack(source, sourceItemId, token)];
      const graph = await getAnnotationGraph(source, sourceItemId, token);
      const deletedTrackId = packageItem.legacyAnnotationTrackId;
      const currentTrackStillExists = activeTrackId !== deletedTrackId && tracks.some((track) => track.id === activeTrackId);
      const fallbackIndex = Math.min(Math.max(packageIndex, 0), tracks.length - 1);
      const nextTrackId = currentTrackStillExists ? activeTrackId! : tracks[fallbackIndex]!.id;

      if (deletedTrackId) delete selectedLabelByTrackRef.current[deletedTrackId];
      setAnnotationTracks(tracks);
      setAnnotationGraph(graph);
      setSelectedGraphLabelTarget(null);
      setSelectedGraphOcrTarget(null);
      setSelectedGraphLabelId(selectedLabelByTrackRef.current[nextTrackId] ?? null);
      setActiveTrackId(nextTrackId);
      router.replace(sectionHref(source, sourceItemId, initialSection, nextTrackId, returnHref), { scroll: false });
      setMessage("Package and its annotation branch deleted.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to delete Package");
    } finally { setSaving(false); }
  }

  return (
    <main className="min-h-dvh bg-zinc-100 text-zinc-950">
      <AdminAuthPanel token={token} onTokenChange={handleTokenChange} />

      <div className="mx-auto max-w-7xl px-5 py-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <Link href={returnHref ?? "/admin/recognition"} className="text-sm font-medium text-zinc-600 hover:text-zinc-950">
            Back to recognition
          </Link>
          <AdminNavLinks />
        </div>

        {!authChecked && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
            Checking admin session...
          </section>
        )}

        {authChecked && !token && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6">
            <div className="text-sm font-semibold">Not logged in</div>
            <div className="mt-1 text-sm text-zinc-500">
              Log in to view or edit recognition metadata.
            </div>
          </section>
        )}

        {loading && <section className="rounded-lg bg-white p-5 text-sm text-zinc-600">Loading...</section>}
        {error && <section className="rounded-lg bg-red-50 p-5 text-sm text-red-700">{error}</section>}
        {message && <section className="rounded-lg bg-emerald-50 p-5 text-sm text-emerald-700">{message}</section>}

        {authChecked && token && detail && (
          <div className="space-y-4">
            <section className="rounded-lg border border-zinc-200 bg-white p-5">
              <div className="text-sm text-zinc-500">
                {formatSource(detail.sourceItem.source)} / {detail.sourceItem.sourceItemId}
              </div>
              <h1 className="mt-2 text-2xl font-semibold leading-tight">
                {detail.sourceItem.title ?? "Untitled"}
              </h1>
              {source === "svoe_vino" && <OfficialReferenceSelector sourceItemId={detail.sourceItem.sourceItemId} token={token} onSelected={trackId=>router.push(sectionHref(source,sourceItemId,"annotation",trackId,returnHref))} />}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <SectionButton active={initialSection === "annotation"} label="Label Annotation" href={sectionHref(source, sourceItemId, "annotation", activeTrackId, returnHref)} />
                <SectionButton active={initialSection === "catalog"} label="Catalog" href={sectionHref(source, sourceItemId, "catalog", activeTrackId, returnHref)} />
                <span className="ml-0 w-full pt-2 text-xs font-semibold uppercase text-zinc-400 sm:ml-2 sm:w-auto sm:pt-0">
                  Developer tools
                </span>
                <SectionButton active={initialSection === "cv"} label="CV Lab" href={sectionHref(source, sourceItemId, "cv", activeTrackId, returnHref)} />
                <SectionButton active={initialSection === "saved"} label="Saved Metadata" href={sectionHref(source, sourceItemId, "saved", activeTrackId, returnHref)} />
                <SectionButton active={initialSection === "text"} label="Text Metadata" href={sectionHref(source, sourceItemId, "text", activeTrackId, returnHref)} />
                <SectionButton active={initialSection === "history"} label="Jobs" href={sectionHref(source, sourceItemId, "history", activeTrackId, returnHref)} />
              </div>
            </section>

            {initialSection === "catalog" && (
              <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
                <div className="rounded-lg border border-zinc-200 bg-white p-5">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Producer" value={detail.sourceItem.producer} />
                    <Field label="Region" value={detail.sourceItem.region} />
                    <Field label="Category" value={detail.sourceItem.category} />
                    <Field label="Year" value={detail.sourceItem.year} />
                    <Field label="Barcode" value={detail.sourceItem.barcode} />
                    <Field label="Source updated" value={detail.sourceItem.sourceUpdatedAt} />
                  </div>
                  <div className="mt-4">
                    <Field label="Description" value={detail.sourceItem.description} />
                  </div>
                </div>

                <SourceImagePanel imageUrl={imageUrl} title={detail.sourceItem.title ?? detail.sourceItem.sourceItemId} />
              </section>
            )}

            {initialSection === "text" && (
              <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
                <section className="rounded-lg border border-zinc-200 bg-white p-5">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold uppercase text-zinc-500">Text Metadata</h2>
                      <div className="mt-1 text-xs text-zinc-500">
                        Source-derived aliases and normalized tokens. No CV controls live here.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleGenerate("GENERATE_ALIASES")}
                      disabled={saving}
                      className="h-9 rounded border border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
                    >
                      Generate text
                    </button>
                  </div>
                  <div className="grid gap-4">
                    <FieldTextarea
                      label="Aliases"
                      value={draft.aliases}
                      onChange={(value) => setDraft((current) => ({ ...current, aliases: value }))}
                    />
                    <FieldTextarea
                      label="Normalized tokens"
                      value={draft.normalizedTokens}
                      onChange={(value) => setDraft((current) => ({ ...current, normalizedTokens: value }))}
                    />
                  </div>
                  <div className="mt-5">
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={saving}
                      className="h-10 rounded bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Save text metadata
                    </button>
                  </div>
                </section>
                <aside className="space-y-4">
                  <section className="rounded-lg border border-zinc-200 bg-white p-4">
                    <h2 className="text-sm font-semibold uppercase text-zinc-500">Saved text values</h2>
                    <div className="mt-4 grid gap-4">
                      <ReadonlyList title="Aliases" items={detail.metadata?.aliases ?? []} />
                      <ReadonlyList title="Normalized tokens" items={detail.metadata?.normalizedTokens ?? []} />
                    </div>
                  </section>
                  <MetadataStatusPanel metadata={detail.metadata} />
                </aside>
              </section>
            )}

            {initialSection === "annotation" && (
              <div className="space-y-4">
                <VersionSelectorBar
                  title="Annotation version"
                  versions={annotationVersions.map((version) => ({
                    id: version.id,
                    revision: version.revision,
                    label: version.status,
                    isActive: version.id === activeAnnotationVersionId,
                    isDefault: version.id === defaultAnnotationVersionId,
                    createdAt: version.createdAt,
                  }))}
                  selectedId={selectedAnnotationVersionId}
                  disabled={saving}
                  onSelect={(versionId) => void handleSelectAnnotationVersion(versionId)}
                  onCreate={() => void handleCreateAnnotationVersion()}
                  onDelete={() => void handleDeleteSelectedAnnotationVersion()}
                  deleteDisabledReason={annotationVersionDeleteBlockedReason}
                  extraActions={(
                    <>
                      {selectedAnnotationVersion && !selectedAnnotationVersionEditable && selectedAnnotationVersion.status !== "processing" && <button type="button" disabled={saving} onClick={() => void handleEditSelectedAnnotationVersion()} className="h-9 rounded border border-amber-400 bg-white px-3 text-xs font-semibold text-amber-900 disabled:opacity-50">Edit selected</button>}
                      {wizardActiveStep === "package" && (annotationVersions.length === 0 || selectedAnnotationVersionEditable) && <>
                        <select aria-label="Full pipeline SigLIP2 mode" value={llmSiglipLabelMode} onChange={(event) => setLlmSiglipLabelMode(event.target.value as SiglipLabelMode)} disabled={saving || llmJobStarting} className="h-9 rounded border border-violet-300 bg-white px-2 text-xs text-violet-950 disabled:opacity-50">
                          <option value="off">SigLIP off</option>
                          <option value="score-only">SigLIP score only</option>
                          <option value="rerank">SigLIP rerank</option>
                        </select>
                        <select aria-label="Full pipeline DINOv3 mode" value={llmDinoLabelMode} onChange={(event) => setLlmDinoLabelMode(event.target.value as DinoLabelMode)} disabled={saving || llmJobStarting} className="h-9 rounded border border-emerald-300 bg-white px-2 text-xs text-emerald-950 disabled:opacity-50">
                          <option value="off">DINO off</option>
                          <option value="observe">DINO observe</option>
                          <option value="refine">DINO refine ROI</option>
                        </select>
                        <button type="button" disabled={saving || llmJobStarting} onClick={() => void handleRunVersionLlmJob("session-chain")} className="h-9 rounded border border-indigo-400 bg-white px-3 text-xs font-semibold text-indigo-900 disabled:opacity-50">{llmJobStarting ? "Starting..." : "Run full - session"}</button>
                        <button type="button" disabled={saving || llmJobStarting} onClick={() => void handleRunVersionLlmJob("one-shot-chain")} className="h-9 rounded border border-indigo-400 bg-white px-3 text-xs font-semibold text-indigo-900 disabled:opacity-50">Run full - one-shot</button>
                      </>}
                    </>
                  )}
                />
                {selectedAnnotationVersion && !selectedAnnotationVersionEditable ? ((historicalAnnotationGraph ?? (selectedAnnotationVersionId === activeAnnotationVersionId ? annotationGraph : null)) ? (
                  <HistoricalAnnotationVersionPanel
                    graph={(historicalAnnotationGraph ?? annotationGraph)!}
                    version={selectedAnnotationVersion}
                  />
                ) : <section className="rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-500">Loading selected annotation version...</section>) : (
                <LabelAnnotationPanel
                  key={`${detail.sourceItem.source}:${detail.sourceItem.sourceItemId}:${activeTrackId ?? "loading"}:${selectedGraphLabel?.id ?? "primary"}`}
                  imageUrl={imageUrl}
                  metadata={detail.metadata}
                  annotation={labelAnnotation}
                  title={detail.sourceItem.title ?? detail.sourceItem.sourceItemId}
                  saving={saving}
                  onSave={async (annotation) => { await handleSaveLabelAnnotation(annotation); }}
                  sourceAnalysis={labelSourceAnalysis}
                  onRunSourceAnalysis={handleRunLabelSourceAnalysis}
                  onChangeSourceAnalysis={setLabelSourceAnalysis}
                  onSaveSourceAnalysis={handleSaveLabelSourceAnalysis}
                  onSaveAndNext={handleSaveLabelAnnotationAndNext}
                  analysisWorkspace={activeCvWorkspace}
                  onRunAnalysis={handleAnalyzeLabel}
                  onPreviewCvJob={handlePreviewLabelCvJob}
                  onSaveCvCheckpoint={handleSaveLabelCvCheckpoint}
                  onSaveCvJob={handleSaveLabelCvJob}
                  cvPreviewing={cvPreviewing}
                  onReviewAnalysis={canonicalCvLabelId ? async (status) => status === "accepted" ? handleConfirmCanonicalSummary() : false : handleReviewLabelAnalysis}
                  canonicalSummaryConfirmation={Boolean(canonicalCvLabelId)}
                  queueNav={queueNav}
                  ocrRegionReview={ocrRegionReview}
                  sourceAssociationWorkspace={sourceAssociationWorkspace}
                  onSaveOcrRegionReview={handleSaveOcrRegionReview}
                  onSaveSourceAssociationReview={handleSaveSourceAssociationReview}
                  onSaveCatalogIdentityReview={handleSaveCatalogIdentityReview}
                  annotationValidation={annotationGraph?.validation ?? null}
                  packageGeometry={annotationGraph?.packages.find((item) => item.legacyAnnotationTrackId === activeTrackId)?.scope.geometry ?? null}
                  onSavePackageScope={handleSavePackageScope}
                  onRunPackageHelper={handleRunPackageHelper}
                  onOpenLabelBranch={handleApprovePackageAndOpenLabel}
                  packageApprovalRequired={!activeAnnotationVersionId}
                  labelBranchCvEnabled={Boolean(selectedGraphLabel)}
                  navigationRequest={wizardNavigationRequest}
                  initialStep={wizardActiveStep}
                  onActiveStepChange={setWizardActiveStep}
                  onNavigationRequestHandled={(requestId) => {
                    setWizardNavigationRequest((current) => current?.id === requestId ? null : current);
                  }}
                  branchNavigation={({ activeStage, openPackageStage, openLabelStage }) => annotationGraph ? <AnnotationGraphManager
                    source={source}
                    sourceItemId={sourceItemId}
                    token={token}
                    graph={annotationGraph}
                    tracks={annotationTracks}
                    activeTrackId={activeTrackId}
                    selectedLabelId={selectedGraphLabel?.id ?? null}
                    activeStage={activeStage}
                    onSelectPackage={switchAnnotationTrack}
                    onAddPackage={() => void handleAddAnnotationTrack()}
                    onDeletePackage={(packageId) => void handleDeletePackage(packageId)}
                    onSelectLabel={(labelId) => {
                      selectGraphLabel(labelId);
                      setSelectedGraphLabelTarget(null);
                      setSelectedGraphOcrTarget({ type: "label", id: labelId });
                      navigateWizard(activeStage);
                    }}
                    onOpenPackage={openPackageStage}
                    onOpenLabelStage={() => {
                      if (!activeAnnotationVersionId) {
                        setError("Approve the Package stage before opening Label.");
                        return;
                      }
                      setSelectedGraphLabelTarget(null);
                      openLabelStage();
                    }}
                    onOpenLabel={(target) => {
                      if (target.mode === "existing") {
                        selectGraphLabel(target.id);
                        setSelectedGraphOcrTarget({ type: "label", id: target.id });
                      }
                      setSelectedGraphLabelTarget(target);
                      navigateWizard("label");
                    }}
                    disabled={saving}
                    onChanged={refreshAnnotationGraph}
                    onError={setError}
                  /> : null}
                  graphStageControls={(activeStage) => annotationGraph ? <AnnotationGraphStageControls
                    source={source}
                    sourceItemId={sourceItemId}
                    token={token}
                    graph={annotationGraph}
                    activeTrackId={activeTrackId}
                    selectedLabelId={selectedGraphLabel?.id ?? null}
                    activeStage={activeStage}
                    disabled={saving}
                    onChanged={refreshAnnotationGraph}
                    onError={setError}
                  /> : null}
                  graphLabelWorkspace={annotationGraph && !graphLabelUsesLegacyEditor ? <AnnotationGraphLabelCollectionWorkspace
                    key={`${activeTrackId ?? "none"}:${effectiveGraphLabelTarget?.mode ?? "collection"}:${effectiveGraphLabelTarget?.mode === "existing" ? effectiveGraphLabelTarget.id : "new"}`}
                    source={source}
                    sourceItemId={sourceItemId}
                    token={token}
                    imageUrl={imageUrl}
                    graph={annotationGraph}
                    activeTrackId={activeTrackId}
                    target={effectiveGraphLabelTarget}
                    sourceAnalysis={labelSourceAnalysis}
                    disabled={saving}
                    onRunAuto={(visionEvidence) => handleRunLabelSourceAnalysis(undefined, undefined, undefined, visionEvidence)}
                    onCreated={(labelId) => {
                      selectGraphLabel(labelId);
                      setSelectedGraphLabelTarget(null);
                      setSelectedGraphOcrTarget({ type: "label", id: labelId });
                      navigateWizard("label");
                    }}
                    onCommitted={(labelIds) => {
                      const labelId = labelIds[0];
                      if (labelId) {
                        selectGraphLabel(labelId);
                        setSelectedGraphOcrTarget({ type: "label", id: labelId });
                      }
                      setSelectedGraphLabelTarget(null);
                      navigateWizard("bottle");
                    }}
                    onEdit={(labelId) => {
                      selectGraphLabel(labelId);
                      setSelectedGraphLabelTarget({ mode: "existing", id: labelId });
                      navigateWizard("label");
                    }}
                    onManual={() => {
                      if (!activeAnnotationPackage) return;
                      setSelectedGraphLabelTarget({ mode: "new", packageId: activeAnnotationPackage.id });
                      navigateWizard("label");
                    }}
                    onChanged={refreshAnnotationGraph}
                    onCloseEditor={() => setSelectedGraphLabelTarget(null)}
                    onError={setError}
                  /> : null}
                  graphOcrWorkspace={annotationGraph && effectiveGraphOcrTarget ? <AnnotationGraphOcrWorkspace
                    source={source}
                    sourceItemId={sourceItemId}
                    token={token}
                    imageUrl={imageUrl}
                    graph={annotationGraph}
                    activeTrackId={activeTrackId}
                    target={effectiveGraphOcrTarget}
                    labelCrop={labelAnalysisWorkspace?.analysis?.crop.assetPath ? {
                      imageUrl: `/api/admin/assets/${labelAnalysisWorkspace.analysis.crop.assetPath.split("/").map(encodeURIComponent).join("/")}`,
                      revision: labelAnalysisWorkspace.analysis.annotationRevision,
                      width: labelAnalysisWorkspace.analysis.crop.width,
                      height: labelAnalysisWorkspace.analysis.crop.height,
                    } : null}
                    disabled={saving}
                    onClose={() => setSelectedGraphOcrTarget(null)}
                    onContinue={() => navigateWizard("mask")}
                    onChanged={refreshAnnotationGraph}
                    onError={setError}
                  /> : null}
                  packageComposition={annotationGraph ? <ItemCompositionSummary
                    graph={annotationGraph}
                    activeTrackId={activeTrackId}
                    selectedLabelId={selectedGraphLabel?.id ?? null}
                    onDeletePackage={(packageId) => void handleDeletePackage(packageId)}
                    onOpenPackageStage={(trackId, step) => { setSelectedGraphLabelTarget(null); navigateWizard(step); if (trackId !== activeTrackId) switchAnnotationTrack(trackId); }}
                    onOpenSummary={() => navigateWizard("summary")}
                    onOpenLabelStage={(trackId, labelId, step) => {
                      selectGraphLabel(labelId);
                      setSelectedGraphOcrTarget({ type: "label", id: labelId });
                      setSelectedGraphLabelTarget(step === "label" ? { mode: "existing", id: labelId } : null);
                      navigateWizard(step);
                      if (trackId !== activeTrackId) switchAnnotationTrack(trackId);
                    }}
                  /> : null}
                  assistantPanel={activeTrackId ? <WizardLlmReviewPanel
                    source={source}
                    sourceItemId={sourceItemId}
                    annotationId={activeTrackId}
                    selectedLabelId={selectedGraphLabel?.id ?? null}
                    currentStage={wizardActiveStep}
                    token={token}
                    disabled={saving}
                    onChanged={refreshWizardAfterLlm}
                    onError={(value) => { if (value) setError(value); }}
                  /> : null}
                />
                )}
              </div>
            )}

            {initialSection === "saved" && (
              <section className="space-y-4">
                <VersionSelectorBar
                  title="Annotation pipeline version"
                  versions={annotationVersions.map((version) => ({
                    id: version.id,
                    revision: version.revision,
                    label: version.status,
                    isActive: version.id === activeAnnotationVersionId,
                    isDefault: version.id === defaultAnnotationVersionId,
                    createdAt: version.createdAt,
                  }))}
                  selectedId={selectedAnnotationVersionId}
                  disabled={saving}
                  onSelect={(versionId) => void handleSelectAnnotationVersion(versionId)}
                  onDelete={() => void handleDeleteSelectedAnnotationVersion()}
                  deleteDisabledReason={annotationVersionDeleteBlockedReason}
                />
                {inspectedAnnotationGraph && <SavedAnnotationVersionViewer key={selectedAnnotationVersionId ?? "none"} graph={inspectedAnnotationGraph} imageUrl={imageUrl} source={source} sourceItemId={sourceItemId} token={token} />}
                <AnnotationVersionInspector
                  source={source}
                  sourceItemId={sourceItemId}
                  token={token}
                  version={selectedAnnotationVersion}
                  graph={inspectedAnnotationGraph}
                  jobs={inspectedAnnotationJobs}
                  loading={Boolean(selectedAnnotationVersion && !inspectedAnnotationGraph)}
                />

              </section>
            )}

            {initialSection === "cv" && (
              <section className="space-y-4">
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
                  <section className="rounded-lg border border-zinc-200 bg-white p-5">
                    <div className="grid gap-6">
                      <div>
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <h2 className="text-sm font-semibold uppercase text-zinc-500">CV Lab</h2>
                            <div className="mt-1 text-xs text-zinc-500">
                              Developer tools: draft config, direct preview, sweep and proposal candidates. Nothing here saves reviewed annotations.
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={handleSaveCurrentPreset}
                              disabled={saving}
                              className="h-9 rounded border border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-50"
                            >
                              Save as preset
                            </button>
                            <button
                              type="button"
                              onClick={handleSavePresetRevision}
                              disabled={saving || !selectedPreset}
                              className="h-9 rounded border border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
                            >
                              Save revision
                            </button>
                          </div>
                        </div>
                        <PresetInlineSelector
                          presets={presets}
                          selectedPresetId={selectedPresetId}
                          selectedPreset={selectedPreset}
                          draftConfig={draftPipelineConfig}
                          onPresetChange={handlePresetChange}
                        />
                        <PipelineExecutionPanel
                          previewRunning={playgroundRunning}
                          previewResult={playgroundRun}
                          onPreview={handleRunPlaygroundPreview}
                        />
                        <PipelineControls
                          config={draftPipelineConfig}
                          imageUrl={imageUrl}
                          sweepResult={sweepResult}
                          sweepBaselineHash={sweepBaselineHash}
                          sweepRunning={playgroundRunning}
                          onChange={handleDraftPipelineConfigChange}
                          onRunSweep={handleRunSweep}
                        />
                        {editorItem && (
                          <AdminRecognitionEditor
                            item={editorItem}
                            imageUrl={imageUrl}
                            cvMeta={detail?.metadata?.visualFeatures}
                            manualAnnotations={manualAnnotationsFromVisualFeatures(detail?.metadata?.visualFeatures)}
                            sourceHash={sourceHashFromVisualFeatures(detail?.metadata?.visualFeatures)}
                            pipelineVersion={pipelineVersionFromVisualFeatures(detail?.metadata?.visualFeatures)}
                            onSaveManualAnnotations={handleSaveManualAnnotations}
                          />
                        )}
                      </div>

                    </div>
                  </section>

                  <aside className="space-y-4">
                    <PreviewResultPanel
                      currentConfigHash={hashPipelineConfig(draftPipelineConfig)}
                      imageUrl={imageUrl}
                      previewResult={playgroundRun}
                      saving={saving}
                      onUseProposal={handleUsePreviewCandidateAsProposal}
                    />
                  </aside>
                </div>
              </section>
            )}

            {initialSection === "history" && (
              <ItemJobsPanel
                jobs={detail.jobs}
                token={token}
                onRefresh={async () => {
                  const refreshed = await getRecognitionMetadata(source, sourceItemId, token);
                  setDetail(refreshed);
                }}
              />
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function VersionSelectorBar({
  title,
  versions,
  selectedId,
  disabled,
  onSelect,
  onCreate,
  onMakeDefault,
  onDelete,
  deleteDisabledReason,
  extraActions,
}: {
  title: string;
  versions: Array<{ id: string; revision: number; label: string; isActive: boolean; isDefault: boolean; createdAt: string }>;
  selectedId: string | null;
  disabled: boolean;
  onSelect: (versionId: string) => void;
  onCreate?: () => void;
  onMakeDefault?: () => void;
  onDelete?: () => void;
  deleteDisabledReason?: string | null;
  extraActions?: React.ReactNode;
}) {
  const selected = versions.find((version) => version.id === selectedId) ?? null;
  return (
    <section className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="grid min-w-64 gap-1 text-xs font-semibold uppercase tracking-wide text-indigo-900">
          {title}
          <select
            value={selectedId ?? ""}
            disabled={disabled || versions.length === 0}
            onChange={(event) => onSelect(event.target.value)}
            className="h-10 rounded border border-indigo-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-zinc-900 disabled:opacity-50"
          >
            {versions.length === 0 && <option value="">No versions</option>}
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                v{version.revision} · {version.label}{version.isActive ? " · active" : ""}{version.isDefault ? " · default" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {selected && <span className="text-xs text-indigo-700">{formatDateTime(selected.createdAt)}</span>}
          {selected?.isDefault && <span className="rounded bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">Default</span>}
          {selected?.isActive && <span className="rounded bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-800">Active</span>}
          {onMakeDefault && <button type="button" disabled={disabled} onClick={onMakeDefault} className="h-9 rounded border border-emerald-300 bg-white px-3 text-xs font-semibold text-emerald-800 disabled:opacity-50">Make default</button>}
          {extraActions}
          {onDelete && <button type="button" disabled={disabled || Boolean(deleteDisabledReason)} title={deleteDisabledReason ?? "Delete selected version"} onClick={onDelete} className="h-9 rounded border border-red-300 bg-white px-3 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40">Delete version</button>}
          {onCreate && <button type="button" disabled={disabled} onClick={onCreate} className="h-9 rounded bg-indigo-700 px-3 text-xs font-semibold text-white disabled:opacity-50">New version</button>}
        </div>
      </div>
    </section>
  );
}

function HistoricalAnnotationVersionPanel({ graph, version }: { graph: AnnotationGraph; version: AnnotationVersion | null }) {
  const labels = graph.packages.flatMap((packageItem) => packageItem.labels);
  const ocrCount = labels.reduce((total, label) => total + label.ocr.length, 0);
  return (
    <section className="rounded-lg border border-amber-200 bg-white p-5">
      <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        Annotation v{version?.revision ?? "?"} is an immutable snapshot. Use <strong>Edit selected</strong> to create a draft copy and continue from this exact state.
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Field label="Packages" value={graph.packages.length} />
        <Field label="Labels" value={labels.length} />
        <Field label="OCR regions" value={ocrCount} />
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold text-zinc-700">Snapshot data</summary>
        <RawJsonBlock value={graph} className="max-h-[640px] overflow-auto rounded bg-zinc-950 p-3 pr-20 text-xs leading-5 text-zinc-100" />
      </details>
    </section>
  );
}

function ItemCompositionSummary({ graph, activeTrackId, selectedLabelId, onDeletePackage, onOpenPackageStage, onOpenLabelStage, onOpenSummary }: {
  graph: AnnotationGraph;
  activeTrackId: string | null;
  selectedLabelId: string | null;
  onDeletePackage: (packageId: string) => void;
  onOpenPackageStage: (trackId: string, step: "package" | "bottle") => void;
  onOpenLabelStage: (trackId: string, labelId: string, step: Exclude<AnnotationNavigationStep, "package" | "bottle" | "summary">) => void;
  onOpenSummary: () => void;
}) {
  const labels = graph.packages.flatMap((packageItem) => packageItem.labels);
  const labelOcrCount = labels.reduce((total, label) => total + label.ocr.length, 0);
  const unreviewedLabels = graph.packages.flatMap((packageItem) => packageItem.labels
    .filter((label) => label.geometryReviewStatus !== "reviewed" || label.visualRegionKind.status !== "reviewed")
    .map((label) => ({ packageItem, label })));
  const unreadableOcr = graph.packages.flatMap((packageItem) => packageItem.labels.flatMap((label) => label.ocr
    .filter((region) => region.transcription.status === "unreadable")
    .map((region) => ({ packageItem, label, region }))));
  const multiplicityMeta = graph.meta.find((item) => item.tags.includes("package-multiplicity"));
  const isMultipackage = Boolean(multiplicityMeta?.tags.includes("multipackage"));
  const hasWarnings = isMultipackage || graph.validation.unresolvedIdentityConflicts > 0 || graph.validation.suggestedParentRelations > 0 || unreviewedLabels.length > 0 || unreadableOcr.length > 0;
  const labelStages: Array<{ step: Exclude<AnnotationNavigationStep, "package" | "bottle" | "summary">; label: string }> = [
    { step: "label", label: "ROI" }, { step: "ocr", label: "OCR" }, { step: "mask", label: "Mask" },
    { step: "morphology", label: "Morph" }, { step: "components", label: "Components" }, { step: "elements", label: "Elements" },
    { step: "contours", label: "Contours" }, { step: "palette", label: "Palette" },
  ];

  return <section className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-xs text-violet-950">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><strong className="uppercase tracking-wide">Interactive item summary</strong><div className="mt-1 text-violet-700">Open any entity or stage without losing the selected branch.</div></div>
      <button type="button" onClick={onOpenSummary} className={`rounded px-2 py-1 font-semibold ${graph.validation.readyForCanonicalExport ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>{graph.validation.readyForCanonicalExport ? "Open final review" : "Open Summary · review required"}</button>
    </div>
    <div className="mt-3 grid grid-cols-3 gap-1 text-center">
      <span className={`rounded p-1.5 ${isMultipackage ? "bg-amber-100 text-amber-900" : "bg-white"}`}>Packages<br /><strong>{graph.packages.length}{isMultipackage ? " · multi" : ""}</strong></span>
      <span className="rounded bg-white p-1.5">Labels<br /><strong>{labels.length}</strong></span>
      <span className="rounded bg-white p-1.5">OCR<br /><strong>{labelOcrCount}</strong></span>
    </div>
    <div className="mt-3 space-y-2">
      {graph.packages.map((packageItem, packageIndex) => {
        const active = packageItem.legacyAnnotationTrackId === activeTrackId;
        const trackId = packageItem.legacyAnnotationTrackId;
        const openPackage = () => trackId && onOpenPackageStage(trackId, "package");
        return <details key={packageItem.id} open={active} className={`rounded border bg-white ${active ? "border-violet-400 ring-1 ring-violet-200" : "border-violet-100"}`}>
          <summary className="cursor-pointer list-none px-2 py-2">
            <div className="flex items-center justify-between gap-2"><strong>Package #{packageIndex + 1} · {packageItem.packageType.value}</strong><span className="flex items-center gap-2"><span className="text-[10px] text-violet-700">{active ? "current" : "open"}</span><button type="button" aria-label={`Delete Package #${packageIndex + 1}`} title={`Delete Package #${packageIndex + 1}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onDeletePackage(packageItem.id); }} className="rounded border border-red-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-red-700 hover:bg-red-50">Delete</button></span></div>
          </summary>
          <div className="space-y-2 border-t border-violet-100 p-2">
            <div className="flex flex-wrap gap-1">
              <button type="button" onClick={openPackage} className={summaryStageClass(active ? "saved" : "inactive")}>Scope</button>
              <button type="button" onClick={() => trackId && onOpenPackageStage(trackId, "bottle")} className={summaryStageClass(packageItem.objectContext.status === "reviewed" ? "saved" : active ? "missing" : "inactive")}>Object · {packageItem.objectContext.status}</button>
            </div>
            <div className="space-y-2">
              {packageItem.labels.map((label, labelIndex) => {
                const selected = active && label.id === selectedLabelId;
                return <div key={label.id} className={`rounded border p-2 ${selected ? "border-violet-400 bg-violet-50" : "border-zinc-200 bg-zinc-50"}`}>
                  <button type="button" onClick={() => trackId && onOpenLabelStage(trackId, label.id, "label")} className="flex w-full items-center justify-between gap-2 text-left font-semibold"><span>Label #{labelIndex + 1}{label.origin === "migrated_from_direct_ocr" ? " · synthetic" : ""}</span><span className="text-[10px] font-normal">{label.visualRegionKind.value} · {selected ? "selected" : label.geometryReviewStatus}</span></button>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {labelStages.map(({ step, label: stageLabel }) => <button key={step} type="button" onClick={() => trackId && onOpenLabelStage(trackId, label.id, step)} className={summaryStageClass(active ? labelProgressState(label, step) : "inactive")}>{stageLabel}</button>)}
                  </div>
                </div>;
              })}
              {packageItem.labels.length === 0 && <div className="rounded bg-zinc-50 p-2 text-zinc-500">No Labels.</div>}
            </div>
          </div>
        </details>;
      })}
    </div>
    {hasWarnings && <div className="mt-3 space-y-1 rounded border border-amber-300 bg-amber-50 p-2 text-amber-900">
      <div className="font-semibold">Warnings</div>
      {isMultipackage && <button type="button" onClick={onOpenSummary} className="block text-left underline decoration-amber-400 underline-offset-2">Multipackage item · automatic LLM pipeline is stopped</button>}
      {(graph.validation.unresolvedIdentityConflicts > 0 || graph.validation.suggestedParentRelations > 0) && <button type="button" onClick={onOpenSummary} className="block text-left underline decoration-amber-400 underline-offset-2">{graph.validation.unresolvedIdentityConflicts} identity conflict(s) · {graph.validation.suggestedParentRelations} parent suggestion(s)</button>}
      {unreviewedLabels[0]?.packageItem.legacyAnnotationTrackId && <button type="button" onClick={() => onOpenLabelStage(unreviewedLabels[0].packageItem.legacyAnnotationTrackId!, unreviewedLabels[0].label.id, "label")} className="block text-left underline decoration-amber-400 underline-offset-2">{unreviewedLabels.length} Label review/classification warning(s)</button>}
      {unreadableOcr[0]?.packageItem.legacyAnnotationTrackId && <button type="button" onClick={() => onOpenLabelStage(unreadableOcr[0].packageItem.legacyAnnotationTrackId!, unreadableOcr[0].label.id, "ocr")} className="block text-left underline decoration-amber-400 underline-offset-2">{unreadableOcr.length} unreadable OCR region(s)</button>}
    </div>}
  </section>;
}

function labelProgressState(label: AnnotationGraph["packages"][number]["labels"][number], step: Exclude<AnnotationNavigationStep, "package" | "bottle" | "summary">): "saved" | "missing" | "stale" {
  if (step === "label") return label.status === "reviewed" ? "saved" : "missing";
  if (step === "ocr") return label.ocr.some((region) => region.regionStatus === "reviewed") ? "saved" : "missing";
  const workflow = objectRecord(label.cv.job?.workflow);
  const checkpoint = objectRecord(objectRecord(workflow?.checkpoints)?.[step]);
  if (!checkpoint) return "missing";
  return checkpoint.stale === true || checkpoint.status === "stale" ? "stale" : "saved";
}

function summaryStageClass(state: "saved" | "missing" | "stale" | "inactive") {
  const color = state === "saved" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : state === "stale" ? "border-amber-300 bg-amber-50 text-amber-900" : state === "inactive" ? "border-zinc-200 bg-white text-zinc-400" : "border-zinc-300 bg-white text-zinc-700";
  return `rounded border px-2 py-1 text-[10px] font-medium hover:border-violet-400 hover:text-violet-900 ${color}`;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function SectionButton({ active, label, href }: { active: boolean; label: string; href: string }) {
  return (
    <Link
      href={href}
      scroll={false}
      className={`h-10 rounded border px-4 text-sm font-medium ${active ? "border-zinc-950 bg-zinc-950 text-white" : "border-zinc-300 bg-white hover:bg-zinc-50"}`}
    >
      {label}
    </Link>
  );
}

function SourceImagePanel({ imageUrl, title }: { imageUrl: string | null; title: string }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold uppercase text-zinc-500">Source image</h2>
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt={title} className="mt-3 max-h-96 w-full rounded object-contain" />
      ) : (
        <div className="mt-3 rounded border border-zinc-200 p-4 text-sm text-zinc-500">No image URL</div>
      )}
    </section>
  );
}

function PreviewResultPanel({
  currentConfigHash,
  imageUrl,
  previewResult,
  saving,
  onUseProposal,
}: {
  currentConfigHash: string;
  imageUrl: string | null;
  previewResult: PreviewState | null;
  saving: boolean;
  onUseProposal: (preview: PreviewState) => void;
}) {
  const stale = Boolean(previewResult && previewResult.configHash !== currentConfigHash);
  const topCandidate = previewResult ? extractLabelTopCandidates({ cvMeta: previewResult.cvMeta }).find((item) => item.rank === 1) : null;
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase text-zinc-500">Preview result</h2>
        {previewResult && (
          <span className={`rounded px-2 py-1 text-xs font-medium ${stale ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
            {stale ? "stale" : "current draft"}
          </span>
        )}
      </div>
      {!previewResult ? (
        <div className="mt-3 rounded border border-zinc-200 p-3 text-sm text-zinc-500">
          No preview has been run yet.
        </div>
      ) : (
        <>
          {stale && (
            <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
              Preview based on draft {shortHash(previewResult.configHash)}. Current draft {shortHash(currentConfigHash)}.
            </div>
          )}
          <div className="mt-3 grid gap-2 text-sm text-zinc-600">
            <Field label="Runtime" value={`${previewResult.metrics.runtimeMs} ms`} />
            <Field label="Candidates" value={previewResult.metrics.candidateCount} />
            <Field label="Selected score" value={previewResult.metrics.selectedScore ?? "-"} />
            <Field label="Confidence" value={previewResult.metrics.selectedConfidence ?? "-"} />
            <Field label="Quality" value={previewResult.metrics.qualityScore} />
            <Field label="Label found" value={previewResult.metrics.labelFound ? "yes" : "no"} />
            <Field label="Config" value={shortHash(previewResult.configHash)} />
          </div>
          <button
            type="button"
            onClick={() => onUseProposal(previewResult)}
            disabled={saving || !topCandidate}
            className="mt-3 h-9 rounded bg-zinc-950 px-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            Use top candidate as proposal
          </button>
          <div className="mt-3">
            <SavedCvImageWorkspace imageUrl={imageUrl} cvMeta={{ cvMeta: previewResult.cvMeta }} />
          </div>
          <div className="mt-3">
            <CvStageDebugger imageUrl={imageUrl} cvMeta={{ cvMeta: previewResult.cvMeta }} />
          </div>
        </>
      )}
    </section>
  );
}

function MetadataStatusPanel({ metadata }: { metadata: RecognitionMetaItem | null }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold uppercase text-zinc-500">Saved metadata state</h2>
      <div className="mt-3 grid gap-3">
        <Field label="Status" value={metadata?.status} />
        <Field label="Generation version" value={metadata?.generationVersion} />
        <Field label="Source hash" value={metadata?.sourceHash} />
        <Field label="Updated" value={metadata?.updatedAt} />
      </div>
    </section>
  );
}

function AnnotationVersionInspector({
  source,
  sourceItemId,
  token,
  version,
  graph,
  jobs,
  loading,
}: {
  source: string;
  sourceItemId: string;
  token: string | null;
  version: AnnotationVersion | null;
  graph: AnnotationGraph | null;
  jobs: RecognitionItemJob[];
  loading: boolean;
}) {
  const latestJob = [...jobs].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
  const result = objectRecord(latestJob?.result) ?? {};
  const failure = objectRecord(result.failure) ?? {};
  const transportFailure = objectRecord(failure.transport);
  const stages = Array.isArray(result.stages)
    ? result.stages.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const failedStage = typeof failure.stage === "string" ? failure.stage : null;
  const sessionId = typeof result.sessionId === "string"
    ? result.sessionId
    : typeof failure.sessionId === "string" ? failure.sessionId : null;
  const pipelineActive = latestJob?.status === "queued" || latestJob?.status === "running";
  const sessionRequestKey = version?.annotationTrackId && (sessionId || pipelineActive)
    ? `${version.annotationTrackId}:${sessionId ?? "current"}`
    : null;
  const [llmSessionState, setLlmSessionState] = useState<{ key: string; session: LlmSession | null; error: string | null } | null>(null);
  const llmSession = llmSessionState?.key === sessionRequestKey ? llmSessionState.session : null;
  const llmSessionError = llmSessionState?.key === sessionRequestKey ? llmSessionState.error : null;
  const llmSessionLoading = Boolean(sessionRequestKey && llmSessionState?.key !== sessionRequestKey);
  const packageCount = graph?.packages.length ?? 0;
  const labels = graph?.packages.flatMap((item) => item.labels) ?? [];
  const ocrCount = labels.reduce((total, label) => total + label.ocr.length, 0);

  useEffect(() => {
    if (!token || !version?.annotationTrackId || !sessionRequestKey) return;
    let cancelled = false;
    const loadSession = () => {
      const request = sessionId
        ? getLlmWizardSession(source, sourceItemId, version.annotationTrackId!, sessionId, token)
        : getCurrentLlmWizardSession(source, sourceItemId, version.annotationTrackId!, token);
      void request.then((session) => { if (!cancelled) setLlmSessionState({ key: sessionRequestKey, session, error: null }); })
        .catch((nextError) => {
        if (!cancelled) setLlmSessionState({
          key: sessionRequestKey,
          session: null,
          error: nextError instanceof Error ? nextError.message : "Failed to load LLM session records",
        });
      });
    };
    loadSession();
    const interval = pipelineActive ? window.setInterval(loadSession, 2_500) : null;
    return () => {
      cancelled = true;
      if (interval) window.clearInterval(interval);
    };
  }, [pipelineActive, sessionId, sessionRequestKey, source, sourceItemId, token, version?.annotationTrackId]);

  if (!version) {
    return <section className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-500">No annotation versions recorded.</section>;
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase text-zinc-500">Version status and pipeline diagnostics</h2>
          <div className="mt-1 font-mono text-xs text-zinc-400">{version.id}</div>
        </div>
        <span className={`rounded px-2 py-1 text-xs font-medium ${statusClassName(version.status)}`}>{version.status}</span>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Revision" value={`v${version.revision}`} />
        <Field label="Origin" value={version.origin} />
        <Field label="Created" value={formatDateTime(version.createdAt)} />
        <Field label="Approved" value={formatDateTime(version.approvedAt)} />
        <Field label="Recognition default" value={version.isDefault ? "yes" : "no"} />
      </div>

      {loading ? (
        <div className="mt-4 rounded border border-zinc-200 p-3 text-sm text-zinc-500">Loading version snapshot...</div>
      ) : graph ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <VersionMetric label="Packages" value={packageCount} />
          <VersionMetric label="Labels" value={labels.length} />
          <VersionMetric label="OCR regions" value={ocrCount} />
          <VersionMetric label="Operations" value={graph.operations.length} />
          <VersionMetric label="Export ready" value={graph.validation.readyForCanonicalExport ? "yes" : "no"} />
        </div>
      ) : (
        <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Version snapshot is unavailable.</div>
      )}

      <div className="mt-4 rounded border border-zinc-200 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase text-zinc-500">Pipeline run</h3>
          {latestJob && <span className={`rounded px-2 py-1 text-xs font-medium ${statusClassName(latestJob.status)}`}>{latestJob.status}</span>}
        </div>
        {!latestJob ? (
          <p className="mt-2 text-sm text-zinc-500">No job is linked to this version. It may have been created or reviewed manually.</p>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
              <span className="font-mono">job {latestJob.jobId}</span>
              {latestJob.pipelineVersion && <span>{latestJob.pipelineVersion}</span>}
              <span>{formatDateTime(latestJob.startedAt ?? latestJob.createdAt)}</span>
            </div>
            {(latestJob.error || typeof failure.message === "string") && (
              <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <div className="font-semibold">{failedStage ? `Failed at ${failedStage}` : "Pipeline failed"}</div>
                <div className="mt-1 break-words">{String(failure.message ?? latestJob.error)}</div>
                {typeof failure.labelId === "string" && <div className="mt-1 font-mono text-xs text-red-600">label {failure.labelId}</div>}
                {transportFailure && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {typeof transportFailure.kind === "string" && <span className="rounded bg-red-100 px-2 py-1">{transportFailure.kind}</span>}
                    {typeof transportFailure.controllerStatus === "number" && <span className="rounded bg-red-100 px-2 py-1">controller HTTP {transportFailure.controllerStatus}</span>}
                    {typeof transportFailure.providerStatus === "number" && <span className="rounded bg-red-100 px-2 py-1">provider HTTP {transportFailure.providerStatus}</span>}
                    {transportFailure.retryable === true && <span className="rounded bg-amber-100 px-2 py-1 text-amber-800">retryable</span>}
                  </div>
                )}
              </div>
            )}
            {stages.length > 0 || failedStage ? (
              <div className="mt-3 grid gap-2">
                {stages.map((stage, index) => <PipelineStageRow key={`${String(stage.stage)}:${String(stage.labelId)}:${index}`} stage={stage} />)}
                {failedStage && !stages.some((stage) => stage.stage === failedStage && stage.status === "failed") && (
                  <PipelineStageRow stage={{ stage: failedStage, labelId: failure.labelId ?? null, status: "failed", error: failure.message ?? latestJob.error }} />
                )}
              </div>
            ) : <p className="mt-3 text-xs text-zinc-500">This job did not persist a per-stage trace.</p>}
            <LlmRawRecords
              session={llmSession}
              jobStages={stages}
              loading={llmSessionLoading}
              error={llmSessionError}
              sessionId={sessionId}
            />
          </>
        )}
      </div>

      {graph && <JsonSnapshotDetails title="Annotation snapshot JSON" value={graph} />}
      {latestJob && Object.keys(result).length > 0 && <JsonSnapshotDetails title="Pipeline result JSON" value={result} />}
    </section>
  );
}

function VersionMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded bg-zinc-50 px-3 py-2">
      <div className="text-[11px] font-semibold uppercase text-zinc-400">{label}</div>
      <div className="mt-1 text-sm font-medium text-zinc-800">{value}</div>
    </div>
  );
}

function PipelineStageRow({ stage }: { stage: Record<string, unknown> }) {
  const status = typeof stage.status === "string" ? stage.status : "unknown";
  return (
    <div className={`rounded border px-3 py-2 text-sm ${status === "failed" ? "border-red-200 bg-red-50" : status === "human_required" ? "border-amber-200 bg-amber-50" : "border-zinc-200"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium text-zinc-900">
          {String(stage.stage ?? "unknown")}
          {typeof stage.labelId === "string" ? <span className="ml-2 font-mono text-xs font-normal text-zinc-400">{stage.labelId.slice(0, 8)}</span> : null}
        </div>
        <span className={`rounded px-2 py-0.5 text-xs ${statusClassName(status)}`}>{status}</span>
      </div>
      {typeof stage.helperId === "string" && <div className="mt-1 text-xs text-zinc-500">helper: {stage.helperId}</div>}
      {typeof stage.reason === "string" && <div className="mt-1 break-words text-xs text-amber-800">{stage.reason}</div>}
      {typeof stage.error === "string" && <div className="mt-1 break-words text-xs text-red-700">{stage.error}</div>}
    </div>
  );
}

function LlmRawRecords({
  session,
  jobStages,
  loading,
  error,
  sessionId,
}: {
  session: LlmSession | null;
  jobStages: Record<string, unknown>[];
  loading: boolean;
  error: string | null;
  sessionId: string | null;
}) {
  const jobRecords = jobStages.filter((stage) => Array.isArray(stage.decisions) || objectRecord(stage.providerEvidence));
  if (!sessionId && !session && jobRecords.length === 0) return null;
  return (
    <details className="mt-3 rounded border border-indigo-200 bg-indigo-50 p-3">
      <summary className="cursor-pointer text-xs font-semibold uppercase text-indigo-900">
        Raw LLM records · {session?.stageRuns.length ?? jobRecords.length}
      </summary>
      {loading && <div className="mt-2 text-xs text-indigo-700">Loading persisted session trace...</div>}
      {error && <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">{error}</div>}
      {session && (
        <div className="mt-3 grid gap-2">
          <JsonSnapshotDetails title="Session context" value={{
            id: session.id,
            provider: session.provider,
            model: session.model,
            status: session.status,
            currentStage: session.currentStage,
            providerConversationId: session.providerConversationId,
            contextEvents: session.contextEvents,
            globalContext: session.globalContext,
          }} />
          {session.stageRuns.map((run, index) => (
            <details key={run.id} className={`rounded border bg-white p-3 ${run.status === "human_required" ? "border-amber-300" : run.status === "failed" ? "border-red-300" : run.status === "cancelled" ? "border-zinc-300" : "border-indigo-100"}`} open={run.status === "human_required" || run.status === "failed"}>
              <summary className="cursor-pointer text-xs font-medium text-zinc-800">
                #{index + 1} {run.stage}{run.labelId ? ` · label ${run.labelId.slice(0, 8)}` : ""} · {run.status}
              </summary>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                {run.providerRequestId && <span>request {run.providerRequestId}</span>}
                {run.providerResponseId && <span>response {run.providerResponseId}</span>}
                {run.latencyMs !== null && <span>{run.latencyMs} ms</span>}
              </div>
              <RawJsonBlock containerClassName="mt-2" className="max-h-[420px] overflow-auto rounded bg-zinc-950 p-3 pr-20 text-xs leading-5 text-zinc-100" value={{
                inputContext: run.inputContextSnapshot,
                decisions: run.decisions,
                usage: run.usage,
                transportError: run.transportError,
                correctionPlanId: run.correctionPlanId,
                error: run.error,
              }} />
            </details>
          ))}
        </div>
      )}
      {!loading && !session && jobRecords.length > 0 && (
        <div className="mt-3 grid gap-2">
          {jobRecords.map((record, index) => <JsonSnapshotDetails key={`${String(record.stage)}:${index}`} title={`${String(record.stage ?? "stage")} provider response`} value={{
            status: record.status,
            reason: record.reason ?? null,
            decisions: record.decisions ?? [],
            providerEvidence: record.providerEvidence ?? {},
          }} />)}
        </div>
      )}
    </details>
  );
}

function JsonSnapshotDetails({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="mt-4 rounded border border-zinc-200 p-3">
      <summary className="cursor-pointer text-xs font-semibold uppercase text-zinc-500">{title}</summary>
      <RawJsonBlock value={value} className="max-h-[480px] overflow-auto rounded bg-zinc-950 p-3 pr-20 text-xs leading-5 text-zinc-100" />
    </details>
  );
}

function PresetInlineSelector({
  presets,
  selectedPresetId,
  selectedPreset,
  draftConfig,
  onPresetChange,
}: {
  presets: PipelinePreset[];
  selectedPresetId: string;
  selectedPreset: PipelinePreset | null;
  draftConfig?: PipelineConfig;
  onPresetChange: (presetId: string) => void;
}) {
  const presetHash = selectedPreset ? hashPipelineConfig(selectedPreset.config) : null;
  const draftHash = draftConfig ? hashPipelineConfig(draftConfig) : null;
  const draftModified = Boolean(presetHash && draftHash && presetHash !== draftHash);
  return (
    <div className="mt-3 grid gap-2 rounded border border-zinc-200 bg-zinc-50 p-3 text-sm">
      <label className="grid gap-1">
        <span className="text-xs font-semibold uppercase text-zinc-500">Preset</span>
        <select
          value={selectedPresetId}
          onChange={(event) => onPresetChange(event.target.value)}
          className="h-9 rounded border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-zinc-600"
        >
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name} rev {preset.revision}
            </option>
          ))}
        </select>
      </label>
      {selectedPreset && (
        <div className="grid gap-2 text-xs text-zinc-600 sm:grid-cols-2">
          <div>
            {selectedPreset.status} · {selectedPreset.layer} · rev {selectedPreset.revision}
          </div>
          <div className={draftModified ? "font-semibold text-amber-700" : "text-emerald-700"}>
            {draftConfig ? (draftModified ? "Draft modified" : "Draft clean") : "Saved preset"}
          </div>
          <div className="font-mono">preset {shortHash(presetHash)}</div>
          {draftHash && <div className="font-mono">draft {shortHash(draftHash)}</div>}
        </div>
      )}
    </div>
  );
}

function PipelineExecutionPanel({
  previewRunning,
  previewResult,
  onPreview,
}: {
  previewRunning: boolean;
  previewResult: PreviewState | null;
  onPreview: () => void;
}) {
  return (
    <section className="mt-3 rounded border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase text-zinc-500">Preview</h3>
          <div className="mt-1 max-w-2xl text-xs text-zinc-500">
            Direct HTTP image analysis. Temporary result, no job record and no DB write.
          </div>
        </div>
        <button
          type="button"
          onClick={onPreview}
          disabled={previewRunning}
          className="h-9 rounded bg-zinc-950 px-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {previewRunning ? "Preview running..." : "Run preview"}
        </button>
      </div>
      {previewRunning && (
        <div className="mt-3 flex items-center gap-3 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
          <span className="h-3 w-3 animate-pulse rounded-full bg-sky-500" />
          <span>Direct HTTP image analysis is running. No job record will be created.</span>
        </div>
      )}
      <div className="mt-3 text-xs text-zinc-500">
        {previewResult ? `${previewResult.metrics.runtimeMs} ms / ${previewResult.metrics.candidateCount} candidates` : "No preview has been run yet."}
      </div>
    </section>
  );
}

function PipelineControls({
  config,
  imageUrl,
  sweepResult,
  sweepBaselineHash,
  sweepRunning,
  onChange,
  onRunSweep,
  showSweep = true,
}: {
  config: PipelineConfig;
  imageUrl: string | null;
  sweepResult: CvPlaygroundSweepResponse | null;
  sweepBaselineHash: string | null;
  sweepRunning: boolean;
  onChange: (config: PipelineConfig) => void;
  onRunSweep: (sweeps: Array<{ parameterPath: string; values: number[] }>) => void;
  showSweep?: boolean;
}) {
  function patchConfig(patch: (current: PipelineConfig) => PipelineConfig) {
    onChange(patch(clonePipelineConfig(config)));
  }

  return (
    <section className="mt-3 rounded border border-zinc-200 bg-white p-3">
      <h3 className="text-xs font-semibold uppercase text-zinc-500">Pipeline parameters</h3>
      <div className="mt-1 text-xs text-zinc-500">
        These controls edit draft config only. Use full run or a future sweep to evaluate image output.
      </div>
      <div className="mt-3 grid gap-4 lg:grid-cols-3">
        <NumberControl
          label="Color distance"
          cost="stage rerun"
          invalidates="color mask -> selection"
          value={config.color.distanceThreshold}
          min={8}
          max={140}
          step={1}
          onChange={(value) =>
            patchConfig((current) => ({
              ...current,
              color: { ...current.color, distanceThreshold: value },
              threshold: { ...current.threshold, value },
            }))
          }
        />
        <NumberControl
          label="Min score"
          cost="cheap"
          invalidates="selection"
          value={config.selection.minScore}
          min={0}
          max={1}
          step={0.01}
          onChange={(value) =>
            patchConfig((current) => ({
              ...current,
              selection: { ...current.selection, minScore: value },
            }))
          }
        />
        <NumberControl
          label="Max candidates"
          cost="cheap"
          invalidates="selection"
          value={config.selection.maxCandidates}
          min={1}
          max={50}
          step={1}
          onChange={(value) =>
            patchConfig((current) => ({
              ...current,
              selection: { ...current.selection, maxCandidates: Math.round(value) },
            }))
          }
        />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-4">
        <label className="flex h-10 items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={config.morphology.enabled}
            onChange={(event) =>
              patchConfig((current) => ({
                ...current,
                morphology: { ...current.morphology, enabled: event.target.checked },
              }))
            }
          />
          Morphology
          <span className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">morphology to selection</span>
        </label>
        <NumberInput
          label="Kernel W"
          cost="stage rerun"
          value={config.morphology.kernelWidth}
          min={1}
          max={21}
          step={2}
          onChange={(value) =>
            patchConfig((current) => ({
              ...current,
              morphology: { ...current.morphology, kernelWidth: oddInt(value) },
            }))
          }
        />
        <NumberInput
          label="Kernel H"
          cost="stage rerun"
          value={config.morphology.kernelHeight}
          min={1}
          max={21}
          step={2}
          onChange={(value) =>
            patchConfig((current) => ({
              ...current,
              morphology: { ...current.morphology, kernelHeight: oddInt(value) },
            }))
          }
        />
        <NumberInput
          label="Iterations"
          cost="stage rerun"
          value={config.morphology.iterations}
          min={1}
          max={5}
          step={1}
          onChange={(value) =>
            patchConfig((current) => ({
              ...current,
              morphology: { ...current.morphology, iterations: Math.round(value) },
            }))
          }
        />
      </div>
      {showSweep && <ParameterSweepGallery
        config={config}
        imageUrl={imageUrl}
        result={sweepResult}
        baselineHash={sweepBaselineHash}
        running={sweepRunning}
        onApply={onChange}
        onRunSweep={onRunSweep}
      />}
      <div className="mt-3 font-mono text-xs text-zinc-500">draft config {hashPipelineConfig(config)}</div>
    </section>
  );
}

type SweepParameter = "color.distanceThreshold" | "selection.minScore" | "morphology.kernelWidth" | "morphology.iterations";
type SweepSort = "quality" | "runtime" | "value";
type SweepVariant = CvPlaygroundSweepResponse["groups"][number]["variants"][number];

const SWEEP_OPTIONS: Array<{
  path: SweepParameter;
  label: string;
  invalidates: string;
  values: number[];
}> = [
  { path: "color.distanceThreshold", label: "Color distance", invalidates: "color mask to selection", values: [24, 32, 40, 48, 56, 64, 72] },
  { path: "selection.minScore", label: "Min score", invalidates: "selection", values: [0.12, 0.18, 0.24, 0.3, 0.36, 0.42, 0.5] },
  { path: "morphology.kernelWidth", label: "Kernel width", invalidates: "morphology to selection", values: [1, 3, 5, 7, 9, 11, 13] },
  { path: "morphology.iterations", label: "Iterations", invalidates: "morphology to selection", values: [1, 2, 3, 4, 5] },
];

function ParameterSweepGallery({
  config,
  imageUrl,
  result,
  baselineHash,
  running,
  onApply,
  onRunSweep,
}: {
  config: PipelineConfig;
  imageUrl: string | null;
  result: CvPlaygroundSweepResponse | null;
  baselineHash: string | null;
  running: boolean;
  onApply: (config: PipelineConfig) => void;
  onRunSweep: (sweeps: Array<{ parameterPath: string; values: number[] }>) => void;
}) {
  const [parameter, setParameter] = useState<SweepParameter>("color.distanceThreshold");
  const [selectedParameters, setSelectedParameters] = useState<SweepParameter[]>(["color.distanceThreshold"]);
  const [sort, setSort] = useState<SweepSort>("quality");
  const [selectedVariantKey, setSelectedVariantKey] = useState<string | null>(null);
  const option = SWEEP_OPTIONS.find((item) => item.path === parameter) ?? SWEEP_OPTIONS[0];
  const variants = option.values.map((value) => ({
    value,
    config: setConfigValue(config, option.path, value),
  }));
  const selectedSweeps = SWEEP_OPTIONS.filter((item) => selectedParameters.includes(item.path)).map((item) => ({
    parameterPath: item.path,
    values: item.values,
  }));
  const sortedGroups = useMemo(
    () =>
      result?.groups.map((group) => ({
        ...group,
        variants: [...group.variants].sort((left, right) => compareSweepVariants(left, right, sort)),
      })) ?? [],
    [result, sort]
  );
  const allResultVariants = sortedGroups.flatMap((group) => group.variants);
  const selectedVariant =
    allResultVariants.find((variant) => sweepVariantKey(variant) === selectedVariantKey) ??
    allResultVariants.sort((left, right) => compareSweepVariants(left, right, "quality"))[0] ??
    null;
  const selectedResultKey = selectedVariant ? sweepVariantKey(selectedVariant) : null;

  return (
    <section className="mt-4 rounded border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold uppercase text-zinc-500">Explore parameter</h4>
          <div className="mt-1 text-xs text-zinc-500">
            Direct HTTP sweep. Each selected parameter is tested independently; no job record or DB write is created.
          </div>
        </div>
        <button
          type="button"
          onClick={() => onRunSweep(selectedSweeps)}
          disabled={running || selectedSweeps.length === 0}
          className="h-9 rounded bg-zinc-950 px-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {running ? "HTTP sweep running..." : "Run HTTP sweep"}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        {SWEEP_OPTIONS.map((item) => (
          <label key={item.path} className="flex h-8 items-center gap-2 text-xs font-medium text-zinc-700">
            <input
              type="checkbox"
              checked={selectedParameters.includes(item.path)}
              onChange={(event) =>
                setSelectedParameters((current) =>
                  event.target.checked ? Array.from(new Set([...current, item.path])) : current.filter((path) => path !== item.path)
                )
              }
            />
            {item.label}
          </label>
        ))}
      </div>
      <div className="mt-3">
        <select
          value={parameter}
          onChange={(event) => setParameter(event.target.value as SweepParameter)}
          className="h-9 rounded border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-zinc-600"
        >
          {SWEEP_OPTIONS.map((item) => (
            <option key={item.path} value={item.path}>
              Draft variants: {item.label}
            </option>
          ))}
        </select>
      </div>
      {result && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase text-zinc-500">Sort results</span>
          {(["quality", "runtime", "value"] as SweepSort[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setSort(item)}
              className={`h-8 rounded border px-3 text-xs font-medium ${sort === item ? "border-zinc-950 bg-zinc-950 text-white" : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"}`}
            >
              {item}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {variants.map((variant) => {
          const active = hashPipelineConfig(variant.config) === hashPipelineConfig(config);
          return (
            <button
              key={`${option.path}:${variant.value}`}
              type="button"
              onClick={() => onApply(variant.config)}
              className={`rounded border p-3 text-left hover:bg-white ${active ? "border-zinc-950 bg-white" : "border-zinc-200 bg-zinc-50"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-zinc-800">{variant.value}</div>
                <span className="rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-600">{active ? "draft" : "variant"}</span>
              </div>
              <div className="mt-2 text-xs text-zinc-500">Invalidates: {option.invalidates}</div>
              <div className="mt-2 font-mono text-xs text-zinc-500">{hashPipelineConfig(variant.config)}</div>
              <div className="mt-2 text-xs text-zinc-400">Metrics available after full run.</div>
            </button>
          );
        })}
      </div>
      {result && (
        <div className="mt-4 grid gap-4">
          <div className="text-xs font-semibold uppercase text-zinc-500">
            Sweep result / {result.totalVariants} variants / {result.runtimeMs} ms
          </div>
          {baselineHash && (
            <div className="rounded border border-zinc-200 bg-white p-3 text-xs text-zinc-600">
              Sweep baseline {shortHash(baselineHash)}. Current draft {shortHash(hashPipelineConfig(config))}.
            </div>
          )}
          {selectedVariant && (
            <div className="grid gap-3 rounded border border-zinc-200 bg-white p-3 lg:grid-cols-[minmax(0,1fr)_220px]">
              <div>
                <div className="text-sm font-semibold text-zinc-800">
                  Selected preview: {labelForSweepPath(selectedVariant.parameterPath)} = {selectedVariant.value}
                </div>
                <div className="mt-2 grid gap-1 text-xs text-zinc-600 sm:grid-cols-2">
                  <div>quality: {formatMetric(selectedVariant.metrics.qualityScore)}</div>
                  <div>candidates: {selectedVariant.metrics.candidateCount}</div>
                  <div>score: {formatMetric(selectedVariant.metrics.selectedScore)}</div>
                  <div>confidence: {formatMetric(selectedVariant.metrics.selectedConfidence)}</div>
                  <div>runtime: {selectedVariant.metrics.runtimeMs} ms</div>
                  <div>{selectedVariant.metrics.labelFound ? "label found" : "label missing"}</div>
                  {baselineHash && <div>baseline: {shortHash(baselineHash)}</div>}
                  <div>variant: {shortHash(selectedVariant.configHash)}</div>
                </div>
                <div className="mt-2 font-mono text-xs text-zinc-400">{selectedVariant.configHash}</div>
              </div>
              <div className="min-h-56">
                <SavedCvImageWorkspace imageUrl={imageUrl} cvMeta={{ cvMeta: selectedVariant.cvMeta }} />
              </div>
            </div>
          )}
          {sortedGroups.map((group) => (
            <div key={group.parameterPath} className="rounded border border-zinc-200 bg-white p-3">
              <div className="text-sm font-semibold text-zinc-800">{labelForSweepPath(group.parameterPath)}</div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {group.variants.map((variant) => (
                  <button
                    key={`${group.parameterPath}:${variant.value}:${variant.configHash}`}
                    type="button"
                    onClick={() => {
                      setSelectedVariantKey(sweepVariantKey(variant));
                      onApply(variant.config as PipelineConfig);
                    }}
                    className={`rounded border p-3 text-left hover:bg-zinc-50 ${sweepVariantKey(variant) === selectedResultKey ? "border-zinc-950 bg-zinc-50" : "border-zinc-200 bg-white"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-zinc-800">{variant.value}</div>
                      <span className={variant.metrics.labelFound ? "rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700" : "rounded bg-red-50 px-2 py-1 text-xs text-red-700"}>
                        {variant.metrics.labelFound ? "label" : "missing"}
                      </span>
                    </div>
                    <div className="mt-2 grid gap-1 text-xs text-zinc-600">
                      <div>quality: {formatMetric(variant.metrics.qualityScore)}</div>
                      <div>candidates: {variant.metrics.candidateCount}</div>
                      <div>score: {formatMetric(variant.metrics.selectedScore)}</div>
                      <div>confidence: {formatMetric(variant.metrics.selectedConfidence)}</div>
                      <div>runtime: {variant.metrics.runtimeMs} ms</div>
                      {baselineHash && <div>baseline: {shortHash(baselineHash)}</div>}
                      <div>variant: {shortHash(variant.configHash)}</div>
                    </div>
                    <div className="mt-2 font-mono text-xs text-zinc-400">{variant.configHash}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function NumberControl({
  label,
  cost,
  invalidates,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  cost: "cheap" | "stage rerun";
  invalidates: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-2 text-sm">
      <span className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase text-zinc-500">
        {label}
        <span className={cost === "cheap" ? "rounded bg-emerald-50 px-2 py-1 text-emerald-700" : "rounded bg-amber-50 px-2 py-1 text-amber-700"}>
          {cost}
        </span>
      </span>
      <span className="text-xs text-zinc-500">Invalidates: {invalidates}</span>
      <input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-9 rounded border border-zinc-300 px-2 text-sm"
      />
    </label>
  );
}

function NumberInput({
  label,
  cost,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  cost: "stage rerun";
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase text-zinc-500">
        {label}
        <span className="rounded bg-amber-50 px-2 py-1 text-amber-700">{cost}</span>
      </span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-9 rounded border border-zinc-300 px-2 text-sm"
      />
    </label>
  );
}

function ReadonlyList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded border border-zinc-200 p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase text-zinc-500">{title}</h3>
        <span className="text-xs text-zinc-500">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="mt-2 text-sm text-zinc-500">No saved values.</div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {items.map((item, index) => (
            <span key={`${item}:${index}`} className="rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-700">
              {item}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ItemJobsPanel({
  jobs,
  token,
  onRefresh,
}: {
  jobs: RecognitionItemJob[] | undefined;
  token: string | null;
  onRefresh: () => Promise<void>;
}) {
  const visibleJobs = jobs ?? [];
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  async function cancelJob(job: RecognitionItemJob) {
    setBusyJobId(job.jobId);
    setActionError(null);
    setActionMessage(null);
    try {
      await cancelRecognitionJob(job.jobId, token);
      await onRefresh();
      setActionMessage(job.status === "queued"
        ? `Job ${job.jobId.slice(0, 8)} cancelled.`
        : `Cancellation requested for ${job.jobId.slice(0, 8)}; the current operation may finish before the pipeline stops.`);
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : "Failed to cancel job");
    } finally {
      setBusyJobId(null);
    }
  }

  async function deleteJob(job: RecognitionItemJob) {
    if (!window.confirm(`Delete job ${job.jobId.slice(0, 8)} from history?`)) return;
    setBusyJobId(job.jobId);
    setActionError(null);
    setActionMessage(null);
    try {
      await deleteRecognitionJob(job.jobId, token);
      await onRefresh();
      setActionMessage(`Job ${job.jobId.slice(0, 8)} deleted from history.`);
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : "Failed to delete job");
    } finally {
      setBusyJobId(null);
    }
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase text-zinc-500">Item job history</h2>
        <span className="text-xs text-zinc-500">{visibleJobs.length} records</span>
      </div>
      {actionError && <div className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">{actionError}</div>}
      {actionMessage && <div className="mt-3 rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-700">{actionMessage}</div>}
      {visibleJobs.length === 0 ? (
        <div className="mt-3 rounded border border-zinc-200 p-3 text-sm text-zinc-500">
          No jobs recorded for this item yet.
        </div>
      ) : (
        <div className="mt-3 grid max-h-[640px] gap-2 overflow-auto pr-1">
          {visibleJobs.map((job) => (
            <div key={job.jobId} className="rounded border border-zinc-200 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-mono text-xs text-zinc-500">{job.jobId.slice(0, 8)}</div>
                  {job.parentJobId && <div className="mt-1 font-mono text-[11px] text-zinc-400">parent {job.parentJobId.slice(0, 8)}</div>}
                </div>
                <span className={`rounded px-2 py-1 text-xs font-medium ${statusClassName(job.status)}`}>
                  {job.status}
                </span>
              </div>
              <div className="mt-2 font-medium text-zinc-900">{formatJobType(job.type)}</div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-zinc-500">
                <span className="rounded bg-zinc-100 px-2 py-1">{formatJobScope(job.scope)}</span>
                {job.pipelineVersion && <span className="rounded bg-zinc-100 px-2 py-1">{job.pipelineVersion}</span>}
              </div>
              <div className="mt-2 text-xs text-zinc-500">Created {formatDateTime(job.createdAt)}</div>
              {job.finishedAt && <div className="mt-1 text-xs text-zinc-500">Finished {formatDateTime(job.finishedAt)}</div>}
              {job.sourceHash && <div className="mt-1 break-all font-mono text-[11px] text-zinc-400">sourceHash {job.sourceHash}</div>}
              {job.error && <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">{job.error}</div>}
              {job.cancelRequested && job.status === "running" && (
                <div className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-700">Cancellation requested. Waiting for the current operation to finish.</div>
              )}
              {Object.keys(job.result).length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-zinc-600">Result</summary>
                  <RawJsonBlock value={job.result} containerClassName="mt-2" className="max-h-40 overflow-auto rounded bg-zinc-950 p-2 pr-20 text-xs leading-5 text-zinc-100" />
                </details>
              )}
              <div className="mt-3 flex justify-end gap-2 border-t border-zinc-100 pt-3">
                {["queued", "running"].includes(job.status) ? (
                  <button
                    type="button"
                    disabled={busyJobId === job.jobId || job.cancelRequested}
                    onClick={() => void cancelJob(job)}
                    className="rounded border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {job.cancelRequested ? "Stopping…" : busyJobId === job.jobId ? "Cancelling…" : "Cancel"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busyJobId === job.jobId}
                    onClick={() => void deleteJob(job)}
                    className="rounded border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busyJobId === job.jobId ? "Deleting…" : "Delete"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

type FormDraft = {
  aliases: string;
  normalizedTokens: string;
  visualFeatures: string;
  annotations: string;
  status: string;
};

function emptyDraft(): FormDraft {
  return {
    aliases: "",
    normalizedTokens: "",
    visualFeatures: "{}",
    annotations: "{}",
    status: "generated",
  };
}

function toDraft(metadata: RecognitionMetaItem | null): FormDraft {
  if (!metadata) return emptyDraft();

  return {
    aliases: metadata.aliases.join("\n"),
    normalizedTokens: metadata.normalizedTokens.join("\n"),
    visualFeatures: JSON.stringify(metadata.visualFeatures, null, 2),
    annotations: JSON.stringify(metadata.annotations, null, 2),
    status: metadata.status,
  };
}

function parseDraft(draft: FormDraft) {
  return {
    aliases: lines(draft.aliases),
    normalizedTokens: lines(draft.normalizedTokens),
    visualFeatures: JSON.parse(draft.visualFeatures || "{}") as Record<string, unknown>,
    annotations: JSON.parse(draft.annotations || "{}") as Record<string, unknown>,
    status: draft.status,
  };
}

function lines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="rounded border border-zinc-200 p-3">
      <div className="text-xs uppercase text-zinc-500">{label}</div>
      <div className="mt-1 break-words text-sm font-medium">{value || "-"}</div>
    </div>
  );
}

function FieldTextarea({
  label,
  value,
  onChange,
  rows = 5,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  return (
    <label className="grid gap-2 text-sm">
      <span className="text-xs font-semibold uppercase text-zinc-500">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        className="w-full rounded border border-zinc-300 px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-zinc-600"
      />
    </label>
  );
}

function formatSource(source: string) {
  if (source === "svoe_vino") return "Svoe Vino";
  if (source === "roskachestvo") return "Roskachestvo";
  return source;
}

function sectionHref(source: string, sourceItemId: string, section: DetailSection, trackId?: string | null, returnTo?: string | null) {
  return recognitionDetailSectionHref(source, sourceItemId, section, trackId, returnTo);
}

async function optionalAdminLayer<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

function formatJobType(type: string) {
  if (type === "GENERATE_ALIASES") return "Source text metadata";
  if (type === "GENERATE_DETECTION_PROPOSAL") return "Detection proposal";
  if (type === "GENERATE_CV_META") return "Image metadata";
  if (type === "GENERATE_ALL_META") return "All metadata";
  if (type === "REGENERATE_ALL_META") return "Full metadata";
  return type;
}

function formatJobScope(scope: RecognitionItemJob["scope"]) {
  if (scope === "batch-parent") return "Batch parent";
  if (scope === "batch-child") return "Batch item";
  return "Item card";
}

function manualAnnotationsFromVisualFeatures(value: unknown): ManualCvAnnotationPayload | Record<string, never> | null {
  const visualFeatures = asRecord(value);
  const manualAnnotations = asRecord(visualFeatures?.manualAnnotations);
  if (!manualAnnotations) return null;
  return manualAnnotations as ManualCvAnnotationPayload | Record<string, never>;
}

function sourceHashFromVisualFeatures(value: unknown) {
  const cvMeta = cvMetaFromVisualFeatures(value);
  const checksum = asRecord(cvMeta?.sourceImage)?.checksum;
  return typeof checksum === "string" ? checksum : null;
}

function pipelineVersionFromVisualFeatures(value: unknown) {
  const cvMeta = cvMetaFromVisualFeatures(value);
  const diagnostics = asRecord(cvMeta?.diagnostics);
  if (typeof diagnostics?.pipelineVersion === "string") return diagnostics.pipelineVersion;
  if (typeof cvMeta?.extractorVersion === "string") return cvMeta.extractorVersion;
  return "cv-meta-v2";
}

function cvMetaFromVisualFeatures(value: unknown) {
  const visualFeatures = asRecord(value);
  const nested = asRecord(visualFeatures?.cvMeta);
  return nested ?? visualFeatures;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function clonePipelineConfig(config: PipelineConfig): PipelineConfig {
  return JSON.parse(JSON.stringify(config)) as PipelineConfig;
}

function oddInt(value: number) {
  const rounded = Math.max(1, Math.round(value));
  return rounded % 2 === 0 ? rounded + 1 : rounded;
}

function setConfigValue(config: PipelineConfig, path: SweepParameter, value: number): PipelineConfig {
  const next = clonePipelineConfig(config);
  if (path === "color.distanceThreshold") {
    next.color.distanceThreshold = value;
    next.threshold.value = value;
  } else if (path === "selection.minScore") {
    next.selection.minScore = value;
  } else if (path === "morphology.kernelWidth") {
    next.morphology.kernelWidth = oddInt(value);
  } else if (path === "morphology.iterations") {
    next.morphology.iterations = Math.round(value);
  }
  return next;
}

function sweepVariantKey(variant: SweepVariant) {
  return `${variant.parameterPath}:${variant.value}:${variant.configHash}`;
}

function compareSweepVariants(left: SweepVariant, right: SweepVariant, sort: SweepSort) {
  if (sort === "runtime") return left.metrics.runtimeMs - right.metrics.runtimeMs;
  if (sort === "value") return left.value - right.value;
  return (right.metrics.qualityScore ?? 0) - (left.metrics.qualityScore ?? 0);
}

function formatMetric(value: number | null | undefined) {
  if (typeof value !== "number") return "-";
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function shortHash(value: string | null | undefined) {
  if (!value) return "-";
  return value.replace(/^fnv1a-/, "").slice(0, 8);
}

function labelForSweepPath(path: string) {
  return SWEEP_OPTIONS.find((item) => item.path === path)?.label ?? path;
}

function statusClassName(status: string) {
  if (status === "completed" || status === "approved" || status === "reviewed") return "bg-emerald-50 text-emerald-700";
  if (status === "failed" || status === "completed_with_errors") return "bg-red-50 text-red-700";
  if (status === "running" || status === "processing") return "bg-sky-50 text-sky-700";
  if (status === "queued" || status === "review_required" || status === "human_required" || status === "blocked_by_review") return "bg-amber-50 text-amber-700";
  if (status === "cancelled" || status === "superseded") return "bg-zinc-100 text-zinc-600";
  return "bg-zinc-100 text-zinc-700";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function withoutBottleRaster(state: LabelSourceAnalysisRun): LabelSourceAnalysisRun {
  if (!state.bottleDetection?.debug.raster) return state;
  const debug = { ...state.bottleDetection.debug };
  delete debug.raster;
  return { ...state, bottleDetection: { ...state.bottleDetection, debug } };
}

function sameRecognitionRoi(left: RecognitionRoi | null, right: RecognitionRoi | null) {
  if (!left || !right) return left === right;
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
