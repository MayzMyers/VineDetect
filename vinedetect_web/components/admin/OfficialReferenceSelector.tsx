"use client";
import { useEffect, useState } from "react";
import {
  listOfficialReferences,
  createOfficialDraft,
  type OfficialReference,
} from "@/lib/admin/api";
export function OfficialReferenceSelector({
  sourceItemId,
  token,
  onSelected,
}: {
  sourceItemId: string;
  token: string;
  onSelected: (trackId: string) => void;
}) {
  const [items, setItems] = useState<OfficialReference[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listOfficialReferences(sourceItemId, token)
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sourceItemId, token]);
  const reference = items.find((x) => x.catalogItemId === selected);
  async function open() {
    if (!reference) return;
    setBusy(true);
    setError(null);
    try {
      const draft = await createOfficialDraft(reference, token);
      onSelected(draft.annotationTrackId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!items.length && !error) return null;
  return (
    <div className="mt-4 rounded border border-zinc-200 p-3">
      <label className="text-sm font-medium">
        Official contest reference{" "}
        <select
          aria-label="Official contest reference"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="ml-2 max-w-full rounded border p-1"
        >
          <option value="">Select official assignment</option>
          {items.map((x) => (
            <option key={x.catalogItemId} value={x.catalogItemId}>
              {x.officialSlug} · #{x.catalogItemId}
            </option>
          ))}
        </select>
      </label>
      {reference && (
        <div className="mt-2 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/admin/assets/${reference.referencePath}`}
            alt={reference.officialSlug}
            className="h-36 w-28 object-contain"
          />
          <div>
            <div className="text-xs text-zinc-500">
              Reference #{reference.referenceAssetId} · {reference.width} ×{" "}
              {reference.height}
            </div>
            <button
              disabled={busy}
              onClick={() => void open()}
              className="mt-2 rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              {busy ? "Opening…" : "Open separate official draft"}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
