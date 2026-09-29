"use client";

import { useMemo, useState } from "react";
import type {
  OcrSourceAssociationReview,
  OcrSourceAssociationWorkspace,
  PutOcrSourceAssociationReview,
} from "@/lib/admin/api";

type Choice = { sourceKey: string; status: "reviewed" | "rejected" };

export function SourceAssociationEditor({
  workspace,
  saving,
  onSave,
  onActiveRegionChange,
}: {
  workspace: OcrSourceAssociationWorkspace | null | undefined;
  saving: boolean;
  onSave?: (input: PutOcrSourceAssociationReview) => Promise<OcrSourceAssociationReview | null>;
  onActiveRegionChange?: (id: string | null) => void;
}) {
  const saved = useMemo(() => savedChoices(workspace), [workspace]);
  const initial = useMemo(() => initialChoices(workspace, saved), [saved, workspace]);
  const [choices, setChoices] = useState<Record<string, Choice>>(initial);
  const regionReview = workspace?.ocrRegionReview ?? null;
  const review = workspace?.review ?? null;
  const regions = regionReview?.regions.filter((region): region is typeof region & { text: string } => region.status === "reviewed" && region.transcriptionStatus === "verified" && Boolean(region.text?.trim())) ?? [];
  const dirty = JSON.stringify(choices) !== JSON.stringify(saved);
  const automaticCount = Object.keys(initial).filter((regionId) => !saved[regionId]).length;
  const olderRegionRevision = Boolean(review?.ocrRegionAnnotationSetId && regionReview?.id && review.ocrRegionAnnotationSetId !== regionReview.id);

  function choose(regionId: string, sourceKey: string) {
    setChoices((current) => sourceKey
      ? { ...current, [regionId]: { sourceKey, status: current[regionId]?.status ?? "reviewed" } }
      : Object.fromEntries(Object.entries(current).filter(([id]) => id !== regionId)));
  }

  function selectBest(regionId: string) {
    const candidate = workspace?.candidates
      .filter((item) => item.ocrRegionAnnotationId === regionId)
      .sort((left, right) => right.score - left.score)[0];
    if (candidate) choose(regionId, sourceKey(candidate.field, candidate.value));
  }

  async function save() {
    if (!workspace || !regionReview || !onSave) return;
    await onSave({
      baseRevision: review?.revision ?? 0,
      ocrRegionAnnotationSetId: regionReview.id,
      status: "reviewed",
      associations: regions.flatMap((region, index) => {
        const choice = choices[region.id];
        const sourceValue = choice ? workspace.sourceValues.find((value) => sourceKey(value.field, value.value) === choice.sourceKey) : null;
        if (!choice || !sourceValue) return [];
        const candidate = workspace.candidates.find((item) =>
          item.ocrRegionAnnotationId === region.id && item.field === sourceValue.field && item.value === sourceValue.value);
        const best = workspace.candidates
          .filter((item) => item.ocrRegionAnnotationId === region.id)
          .sort((left, right) => right.score - left.score)[0];
        return [{
          ocrRegionAnnotationId: region.id,
          regionTextSnapshot: region.text,
          sourceField: sourceValue.field,
          sourceValue: sourceValue.value,
          status: choice.status,
          sourceKind: candidate ? (best === candidate ? "accepted-suggested" as const : "corrected-suggested" as const) : "manual" as const,
          matchKind: candidate?.matchKind ?? "manual" as const,
          score: candidate?.score ?? null,
          sortOrder: index,
        }];
      }),
    });
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase text-zinc-500">OCR → source associations</h3>
          <div className="mt-1 text-xs text-zinc-500">
            {review ? `Saved revision ${review.revision}` : "No saved association review"} · {Object.keys(choices).length}/{regions.length} linked{automaticCount ? ` · ${automaticCount} exact token draft` : ""}
          </div>
        </div>
        <button type="button" onClick={() => void save()} disabled={saving || !onSave || !regionReview || !dirty} className="h-9 rounded bg-zinc-950 px-3 text-sm font-semibold text-white disabled:opacity-40">
          Save associations
        </button>
      </div>

      {olderRegionRevision && (
        <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Saved associations belong to an older OCR-region revision. Re-link the current regions before saving.
        </div>
      )}

      {!regionReview ? (
        <div className="mt-3 rounded border border-zinc-200 p-3 text-sm text-zinc-500">Save an OCR-region review first.</div>
      ) : regions.length === 0 ? (
        <div className="mt-3 rounded border border-zinc-200 p-3 text-sm text-zinc-500">No accepted OCR regions to link.</div>
      ) : (
        <div className="mt-3 grid max-h-[34rem] gap-2 overflow-auto">
          {regions.map((region) => {
            const choice = choices[region.id];
            const candidates = workspace?.candidates.filter((item) => item.ocrRegionAnnotationId === region.id) ?? [];
            return (
              <div key={region.id} onMouseEnter={() => onActiveRegionChange?.(region.id)} onMouseLeave={() => onActiveRegionChange?.(null)} className="rounded border border-zinc-200 bg-zinc-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium text-zinc-900">{region.text || "(empty region)"}</div>
                  <div className="text-xs text-zinc-400">{region.level} · {candidates.length} suggestion(s)</div>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                  <select value={choice?.sourceKey ?? ""} onChange={(event) => choose(region.id, event.target.value)} className="h-9 min-w-0 rounded border border-zinc-300 bg-white px-2 text-xs">
                    <option value="">Unlinked</option>
                    {(workspace?.sourceValues ?? []).map((sourceValue) => (
                      <option key={sourceKey(sourceValue.field, sourceValue.value)} value={sourceKey(sourceValue.field, sourceValue.value)}>
                        {sourceValue.field}{sourceValue.valueKind === "token" ? " token" : ""}: {sourceValue.value}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => selectBest(region.id)} disabled={!candidates.length} className="h-9 rounded border border-zinc-300 px-3 text-xs font-medium disabled:opacity-40">
                    Use best{candidates[0] ? ` ${Math.round(candidates[0].score * 100)}%` : ""}
                  </button>
                  <button
                    type="button"
                    onClick={() => choice && setChoices((current) => ({ ...current, [region.id]: { ...choice, status: choice.status === "reviewed" ? "rejected" : "reviewed" } }))}
                    disabled={!choice}
                    className="h-9 rounded border border-zinc-300 px-3 text-xs font-medium disabled:opacity-40"
                  >
                    {choice?.status === "rejected" ? "Rejected" : "Accepted"}
                  </button>
                </div>
                {candidates.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {candidates.slice(0, 4).map((candidate) => (
                      <button key={`${candidate.field}:${candidate.value}`} type="button" onClick={() => choose(region.id, sourceKey(candidate.field, candidate.value))} className={`rounded border px-2 py-1 text-left text-[11px] ${choice?.sourceKey === sourceKey(candidate.field, candidate.value) ? "border-sky-500 bg-sky-50 text-sky-800" : "border-zinc-200 bg-white text-zinc-600"}`}>
                        {candidate.field}{candidate.valueKind === "token" ? " token" : ""}: {candidate.value} · {Math.round(candidate.score * 100)}%
                      </button>
                    ))}
                  </div>
                )}
                {candidates[0] && (
                  <div className="mt-2 text-xs text-zinc-500">
                    Best: {candidates[0].field}: {candidates[0].value} · {candidates[0].matchKind} · {candidates[0].score.toFixed(2)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function savedChoices(workspace: OcrSourceAssociationWorkspace | null | undefined): Record<string, Choice> {
  const currentRegionSetId = workspace?.ocrRegionReview?.id;
  const review = workspace?.review;
  if (!review || !currentRegionSetId || review.ocrRegionAnnotationSetId !== currentRegionSetId) return {};
  return Object.fromEntries(review.associations.flatMap((association) => association.ocrRegionAnnotationId
    ? [[association.ocrRegionAnnotationId, { sourceKey: sourceKey(association.sourceField, association.sourceValue), status: association.status } satisfies Choice]]
    : []));
}

function initialChoices(workspace: OcrSourceAssociationWorkspace | null | undefined, saved: Record<string, Choice>) {
  const choices = { ...saved };
  for (const region of workspace?.ocrRegionReview?.regions ?? []) {
    if (region.status !== "reviewed" || region.level !== "word" || choices[region.id]) continue;
    const exactToken = workspace?.candidates.find((candidate) =>
      candidate.ocrRegionAnnotationId === region.id
      && candidate.valueKind === "token"
      && candidate.matchKind === "exact"
      && candidate.score === 1);
    if (exactToken) choices[region.id] = {
      sourceKey: sourceKey(exactToken.field, exactToken.value),
      status: "reviewed",
    };
  }
  return choices;
}

function sourceKey(field: string, value: string) {
  return `${field}\u0000${value}`;
}
