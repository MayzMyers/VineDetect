import { realpathSync } from "node:fs";
import { isManagedContestPath } from "../../shared/officialReference.js";
import path from "node:path";
import { env } from "../../config/env.js";

const ASSET_ROOT = path.resolve(process.cwd(), env.ASSET_ROOT);

export function resolveLocalAssetPath(dbPath: string) {
  if (dbPath.startsWith("contest/")) {
    if (!isManagedContestPath(dbPath)) return null;
    const full = resolveWithin(ASSET_ROOT, dbPath.split("/"));
    if (!full) return null;
    try { const real = realpathSync(full); return real.startsWith(`${realpathSync(ASSET_ROOT)}${path.sep}`) ? real : null; } catch { return null; }
  }
  const normalized = dbPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  const [firstPart, ...restParts] = parts;

  if (firstPart === "svoe_vino" || firstPart === "data") {
    return resolveWithin(ASSET_ROOT, ["svoe-vino", ...restParts]);
  }

  if (firstPart === "roskachestvo") {
    return resolveWithin(ASSET_ROOT, parts);
  }

  if (firstPart === "storage") {
    return resolveWithin(ASSET_ROOT, restParts);
  }

  return null;
}

export function resolveGeneratedAssetPath(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts[0] !== "label-analysis") return null;
  return resolveWithin(ASSET_ROOT, parts);
}

function resolveWithin(root: string, relativeParts: string[]) {
  const fullPath = path.resolve(root, ...relativeParts);
  if (fullPath !== root && fullPath.startsWith(`${root}${path.sep}`)) {
    return fullPath;
  }
  return null;
}
