import sharp from "sharp";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveLocalAssetPath } from "../recognize-node/assets.js";
import { summarize, type Validation } from "./autodetect.validation.js";
import { atomicWrite, atomicJson } from "./autodetect.files.js";
const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const svg = (w: number, h: number, body: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`,
  );
const text = (lines: string[], x = 16, y = 26) =>
  lines
    .map(
      (s, i) =>
        `<text x="${x}" y="${y + i * 23}" font-family="DejaVu Sans" font-size="17" fill="#152238">${escape(s)}</text>`,
    )
    .join("");
const wrap = (s: string) => s.match(/.{1,50}/g) ?? [""];
export async function renderPreview(r: Validation): Promise<Buffer> {
  const t = r.target,
    file = resolveLocalAssetPath(t.referencePath);
  if (!file) throw new Error("Missing official image: " + t.catalogItemId);
  const bytes = await readFile(file);
  if (createHash("sha256").update(bytes).digest("hex") !== t.referenceSha256)
    throw new Error("Reference bytes changed: " + t.catalogItemId);
  const metadata = await sharp(bytes).metadata();
  if (metadata.width !== t.width || metadata.height !== t.height)
    throw new Error("Reference dimensions changed: " + t.catalogItemId);
  const scale = Math.min(568 / t.width, 570 / t.height),
    w = Math.round(t.width * scale),
    h = Math.round(t.height * scale);
  let overlay = "";
  if (r.bbox) {
    const b = r.bbox;
    overlay += `<rect x="${b.x * scale}" y="${b.y * scale}" width="${b.width * scale}" height="${b.height * scale}" fill="none" stroke="#ff2851" stroke-width="4"/>`;
  }
  if (r.points)
    overlay += `<polygon points="${r.points.map((p) => `${p.x * scale},${p.y * scale}`).join(" ")}" fill="none" stroke="#00baca" stroke-width="2"/>`;
  const image = await sharp(bytes)
    .resize(w, h, { fit: "fill" })
    .composite([{ input: svg(w, h, overlay) }])
    .png()
    .toBuffer();
  const lines = [
    `Catalog ${r.catalogItemId} | ${r.status}`,
    ...wrap(t.officialSlug),
    `Link: ${t.method}`,
    `Image resolution: ${r.resolutionMethod ?? "unknown"}`,
    `Confidence: ${r.confidence ?? "missing"} | ROI: ${r.areaRatio === null ? "missing" : (r.areaRatio * 100).toFixed(2) + "%"}`,
    ...wrap(
      r.issues.length
        ? "Issues: " + r.issues.join(", ")
        : "Structural checks passed; visual review required",
    ),
  ];
  const height = 620 + lines.length * 23;
  return sharp({
    create: { width: 600, height, channels: 3, background: "#f4f7fb" },
  })
    .composite([
      { input: image, left: Math.round((600 - w) / 2), top: 14 },
      { input: svg(600, height - 600, text(lines)), left: 0, top: 600 },
    ])
    .png()
    .toBuffer();
}
export async function writeReview(
  root: string,
  batchId: string,
  results: Validation[],
) {
  if (!/^[a-zA-Z0-9-]+$/.test(batchId))
    throw new Error("Invalid batch artifact name");
  const summary = summarize(batchId, results),
    base = path.join(root, "review", batchId);
  const tiles = new Map<string, Buffer>();
  for (const r of summary.results) {
    const image = await renderPreview(r);
    tiles.set(r.catalogItemId, image);
    await atomicWrite(
      path.join(base, "previews", r.catalogItemId + ".png"),
      image,
    );
  }
  const sheets: Record<string, string[]> = {};
  for (const [name, ids] of Object.entries(summary.groups)) {
    sheets[name] = [];
    // Six readable cards per sheet. Empty groups get an explicit zero-item sheet.
    for (let offset = 0; offset < Math.max(ids.length, 1); offset += 6) {
      const chunk = ids.slice(offset, offset + 6),
        cards: Buffer[] = [];
      for (const id of chunk) cards.push(tiles.get(id)!);
      const sizes = await Promise.all(cards.map((b) => sharp(b).metadata()));
      const cardHeight = Math.max(830, ...sizes.map((m) => m.height!));
      const height = chunk.length
        ? 80 + Math.ceil(chunk.length / 3) * cardHeight
        : 180;
      const buffer = await sharp({
        create: { width: 1800, height, channels: 3, background: "white" },
      })
        .composite([
          {
            input: svg(
              1800,
              70,
              text(
                [
                  `${batchId} / ${name} / ${ids.length} assignments`,
                  chunk.length
                    ? "Pink = bbox; cyan = quad. Confidence is not an identity or quality verdict."
                    : "No assignments in this group.",
                ],
                16,
                25,
              ),
            ),
            left: 0,
            top: 0,
          },
          ...cards.map((input, i) => ({
            input,
            left: (i % 3) * 600,
            top: 80 + Math.floor(i / 3) * cardHeight,
          })),
        ])
        .png()
        .toBuffer();
      const relative = `review/${batchId}/${name}-${String(Math.floor(offset / 6) + 1).padStart(3, "0")}.png`;
      await atomicWrite(path.join(root, relative), buffer);
      sheets[name]!.push(relative);
    }
  }
  const report = { ...summary, contactSheets: sheets };
  await atomicJson(path.join(root, "reports", batchId + ".json"), report);
  const md = [
    `# ${batchId}`,
    "",
    `Requested: ${report.requested}; completed and valid: ${report.completed}; failed: ${report.failed}; inconsistent: ${report.inconsistent}; missing proposals: ${report.missingProposals}.`,
    "",
    report.sampling,
    "",
    "Confidence distribution: `" + JSON.stringify(report.confidence) + "`.",
    "",
    "ROI area distribution: `" + JSON.stringify(report.areaRatio) + "`.",
    "",
    "Structural anomalies: `" +
      JSON.stringify(report.structuralAnomalies) +
      "`. Border-touch: " +
      report.borderTouch +
      ".",
    "",
    ...Object.entries(sheets).flatMap(([name, files]) =>
      files.map((file) => `- [${name}](../${file})`),
    ),
    "",
    "| Catalog ID | Official slug | Status | Confidence | ROI % | Issues |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.results.map(
      (r) =>
        `| [${r.catalogItemId}](../review/${batchId}/previews/${r.catalogItemId}.png) | ${r.target.officialSlug} | ${r.status} | ${r.confidence ?? ""} | ${r.areaRatio === null ? "" : (r.areaRatio * 100).toFixed(2)} | ${r.issues.join(", ")} |`,
    ),
    "",
  ].join("\n");
  await atomicWrite(path.join(root, "reports", batchId + ".md"), md);
  return report;
}
