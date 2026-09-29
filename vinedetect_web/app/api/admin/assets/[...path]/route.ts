import { resolveManagedContestAsset } from "@/lib/admin/contestAsset";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest } from "next/server";

type Props = {
  params: Promise<{
    path: string[];
  }>;
};

const WORKSPACE_ROOT_CANDIDATES = [
  path.resolve(/* turbopackIgnore: true */ process.cwd(), ".."),
  path.resolve(/* turbopackIgnore: true */ process.cwd()),
];
const DEFAULT_ASSET_ROOTS = WORKSPACE_ROOT_CANDIDATES.flatMap((root) => [
  path.resolve(root, "asset-store"),
  path.resolve(root, "vinedetect_api", "storage", "images"),
]);
const ASSET_ROOTS = uniquePaths([
  ...(process.env.NEXT_ADMIN_ASSET_ROOT
    ? [path.resolve(/* turbopackIgnore: true */ process.env.NEXT_ADMIN_ASSET_ROOT)]
    : []),
  ...DEFAULT_ASSET_ROOTS,
]);

export async function GET(_request: NextRequest, { params }: Props) {
  const { path: pathParts } = await params;
  const resolved = await findAssetPath(pathParts);

  if (resolved) {
    const stream = Readable.toWeb(createReadStream(resolved.fullPath));
    return new Response(stream as ReadableStream, {
      headers: {
        "Content-Type": contentTypeFor(resolved.fullPath),
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  return new Response("Not found", { status: 404 });
}

async function findAssetPath(pathParts: string[]) {
  if(pathParts[0]==="contest") {
    for(const root of ASSET_ROOTS) {
      const resolved=await resolveManagedContestAsset(root,pathParts);
      if(resolved && (await stat(resolved.fullPath)).isFile()) return resolved;
    }
    return null;
  }
  const relativeCandidates = resolveRelativeCandidates(pathParts);

  for (const root of ASSET_ROOTS) {
    for (const relativeParts of relativeCandidates) {
      const resolved = resolveWithin(root, relativeParts);
      if (!resolved) continue;

      try {
        const fileStat = await stat(resolved.fullPath);
        if (fileStat.isFile()) return resolved;
      } catch {
        // Compatibility roots are optional; continue with the next known layout.
      }
    }
  }

  return null;
}

function resolveRelativeCandidates(pathParts: string[]) {
  if (pathParts.length === 0) return [];

  const normalizedParts = pathParts.filter(Boolean);
  const [firstPart, secondPart] = normalizedParts;

  if (firstPart === "data") {
    const legacyRemainder = normalizedParts.slice(1);
    const storageRemainder = secondPart === "images" ? normalizedParts.slice(2) : legacyRemainder;
    return [
      ["svoe-vino", ...legacyRemainder],
      ["svoe_vino", ...legacyRemainder],
      ["svoe-vino", ...storageRemainder],
      ["svoe_vino", ...storageRemainder],
      normalizedParts,
    ];
  }

  if (firstPart === "storage") {
    const legacyRemainder = normalizedParts.slice(1);
    const storageRemainder = secondPart === "images" ? normalizedParts.slice(2) : legacyRemainder;
    return [legacyRemainder, storageRemainder, normalizedParts];
  }

  if (firstPart === "roskachestvo") {
    return [normalizedParts, ["storage", ...normalizedParts]];
  }

  if (firstPart === "svoe_vino" || firstPart === "svoe-vino") {
    const remainder = normalizedParts.slice(1);
    return [
      ["svoe-vino", ...remainder],
      ["svoe_vino", ...remainder],
    ];
  }

  if (firstPart === "label-analysis") {
    return [normalizedParts];
  }

  return [];
}

function resolveWithin(root: string, relativeParts: string[]) {
  const fullPath = path.resolve(root, ...relativeParts);
  if (fullPath !== root && fullPath.startsWith(`${root}${path.sep}`)) {
    return { fullPath };
  }
  return null;
}

function contentTypeFor(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "application/octet-stream";
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.map((item) => path.normalize(item)))];
}
