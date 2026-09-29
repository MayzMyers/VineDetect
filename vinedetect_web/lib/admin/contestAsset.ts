import { realpath } from "node:fs/promises";
import path from "node:path";
export function isManagedContestPath(value: string) {
  const match =
    /^contest\/lct-rshb-2026-09-15\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})\.(webp|png|jpg|jpeg)$/.exec(
      value,
    );
  return Boolean(match && match[2]!.startsWith(match[1]!));
}
export async function resolveManagedContestAsset(
  root: string,
  parts: string[],
) {
  if (
    parts.some((p) => p.includes("/") || p.includes("\\")) ||
    !isManagedContestPath(parts.join("/"))
  )
    return null;
  try {
    const base = await realpath(root);
    const fullPath = await realpath(path.join(root, ...parts));
    return fullPath.startsWith(base + path.sep) ? { fullPath } : null;
  } catch {
    return null;
  }
}
