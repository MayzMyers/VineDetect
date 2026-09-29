export type SavedVersionMask = { width: number; height: number; values: Uint8Array };

export function decodeSavedVersionMask(value: unknown): SavedVersionMask | null {
  const layer = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const width = Number(layer?.width);
  const height = Number(layer?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 512 * 512 || layer?.encoding !== "rle-u8" || typeof layer.data !== "string") return null;
  try {
    const bytes = Uint8Array.from(atob(layer.data), (char) => char.charCodeAt(0));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = new Uint8Array(width * height);
    let offset = 0;
    for (let index = 0; index + 7 < bytes.byteLength && offset < values.length; index += 8) {
      const foreground = view.getUint32(index, true) ? 1 : 0;
      const runLength = view.getUint32(index + 4, true);
      if (!runLength) return null;
      values.fill(foreground, offset, Math.min(values.length, offset + runLength));
      offset += runLength;
    }
    return offset === values.length ? { width, height, values } : null;
  } catch { return null; }
}
