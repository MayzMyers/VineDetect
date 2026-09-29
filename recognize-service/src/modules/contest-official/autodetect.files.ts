import { open, rename, mkdir } from "node:fs/promises";
import path from "node:path";
// fsync both the file and containing directory: a checkpoint is durable before POST.
export async function atomicWrite(file: string, content: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
  const dir = await open(path.dirname(file), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export const jsonText = (value: unknown) =>
  JSON.stringify(value, null, 2) + "\n";
export const atomicJson = (file: string, value: unknown) =>
  atomicWrite(file, jsonText(value));
