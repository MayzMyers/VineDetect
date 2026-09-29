"use client";

import { RawJsonBlock } from "./RawJsonBlock";

type Props = {
  title?: string;
  cvMeta: unknown;
  imageUrl?: string | null;
};

export function AdminCvMetaViewer({ title = "Raster metadata", cvMeta, imageUrl }: Props) {
  const parsed = parseCvMeta(cvMeta);

  if (!parsed) {
    return (
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase text-zinc-500">{title}</h2>
        <div className="mt-3 rounded border border-zinc-200 p-4 text-sm text-zinc-500">No cvMeta generated yet.</div>
      </section>
    );
  }

  const warnings = getWarnings(parsed);

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold uppercase text-zinc-500">{title}</h2>

      {imageUrl && (
        <div className="mt-3 overflow-hidden rounded border border-zinc-200 bg-zinc-50">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="" className="max-h-96 w-full object-contain" />
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Metric label="Schema" value={stringValue(parsed.schemaVersion)} />
        <Metric label="Extractor" value={stringValue(parsed.extractorVersion)} />
        <Metric label="Image size" value={formatSourceSize(parsed)} />
        <Metric label="Source score" value={formatPathNumber(parsed, ["quality", "sourceScore"])} />
        <Metric label="Sharpness" value={formatPathNumber(parsed, ["quality", "sharpness"])} />
        <Metric label="Background" value={formatBackground(parsed)} />
        <Metric label="Bottle" value={formatDetection(parsed, "bottle")} />
        <Metric label="Label" value={formatDetection(parsed, "label")} />
        <Metric label="dHash" value={stringValue(getPath(parsed, ["hashes", "sourceDHash"]) ?? getPath(parsed, ["hashes", "dHash"]))} />
        <Metric label="pHash" value={stringValue(getPath(parsed, ["hashes", "sourcePHash"]))} />
        <Metric label="OCR" value={formatOcr(parsed)} />
        <Metric label="Duration" value={`${formatPathNumber(parsed, ["diagnostics", "durationMs"])} ms`} />
      </div>

      <CvBlock title="Source Quality" value={pickObject(parsed, ["quality"])} />
      <CvBlock title="Background" value={pickObject(parsed, ["background"])} />
      <CvBlock title="Bottle Detection" value={pickObject(parsed, ["bottle", "detection"])} />
      <CvBlock title="Bottle Silhouette" value={pickObject(parsed, ["bottle", "silhouette"])} />
      <CvBlock title="Label Detection" value={pickObject(parsed, ["label", "detection"])} />
      <CvBlock title="Label Layout" value={pickObject(parsed, ["label", "layout"])} />
      <CvBlock title="Label Top Candidates" value={getPath(parsed, ["label", "layout", "topCandidates"])} />
      <CvBlock title="Hashes" value={pickObject(parsed, ["hashes"])} />
      <CvBlock title="OCR" value={pickObject(parsed, ["ocr"])} />

      {warnings.length > 0 && (
        <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {warnings.join("; ")}
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-zinc-200 p-3">
      <div className="text-xs uppercase text-zinc-500">{label}</div>
      <div className="mt-1 break-words font-mono text-xs text-zinc-800">{value || "-"}</div>
    </div>
  );
}

function CvBlock({ title, value }: { title: string; value: unknown }) {
  if (!value || typeof value !== "object") return null;
  return (
    <details className="mt-4 rounded border border-zinc-200 p-3">
      <summary className="cursor-pointer text-xs font-semibold uppercase text-zinc-500">{title}</summary>
      <RawJsonBlock value={value} />
    </details>
  );
}

function parseCvMeta(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const nested = candidate.cvMeta;
  const root = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : candidate;
  if (!root.schemaVersion && !root.quality && !root.hashes && !root.color) return null;
  return root;
}

function formatSourceSize(value: Record<string, unknown>) {
  const source = pickObject(value, ["source"]);
  const width = numberValue(source?.width);
  const height = numberValue(source?.height);
  if (!width || !height) return "-";
  return `${width} x ${height}`;
}

function formatBackground(value: Record<string, unknown>) {
  const type = getPath(value, ["background", "type"]);
  const confidence = formatPathNumber(value, ["background", "confidence"]);
  return type ? `${type} / ${confidence}` : "-";
}

function formatDetection(value: Record<string, unknown>, key: "bottle" | "label") {
  const found = getPath(value, [key, "detection", "found"]);
  const confidence = formatPathNumber(value, [key, "detection", "confidence"]);
  const origin = getPath(value, [key, "detection", "origin"]);
  if (typeof found !== "boolean") return "-";
  return `${found ? "found" : "missing"} / ${confidence} / ${stringValue(origin)}`;
}

function formatOcr(value: Record<string, unknown>) {
  const status = getPath(value, ["ocr", "status"]);
  const enabled = getPath(value, ["ocr", "enabled"]);
  return `${enabled === true ? "enabled" : "disabled"} / ${stringValue(status)}`;
}

function getWarnings(value: Record<string, unknown>) {
  const qualityWarnings = getPath(value, ["quality", "warnings"]);
  const ocrWarnings = getPath(value, ["ocr", "warnings"]);
  return [...arrayOfStrings(qualityWarnings), ...arrayOfStrings(ocrWarnings)];
}

function formatPathNumber(value: Record<string, unknown>, path: string[]) {
  return formatNumber(numberValue(getPath(value, path)));
}

function formatNumber(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : "-";
}

function getPath(value: Record<string, unknown>, path: string[]) {
  let current: unknown = value;
  for (const part of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function pickObject(value: Record<string, unknown>, path: string[]) {
  const next = getPath(value, path);
  return next && typeof next === "object" ? (next as Record<string, unknown>) : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "-";
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
