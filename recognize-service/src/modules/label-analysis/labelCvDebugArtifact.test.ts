import assert from "node:assert/strict";
import test from "node:test";
import { attachInlineDebugLayers, separateInlineDebugLayers } from "./labelCvDebugArtifact.js";

test("heavy CV debug layers detach from persisted metadata and hydrate for the viewer", () => {
  const layers = [{ id: "raw-mask", encoding: "rle-u8", data: [1, 200, 0, 40] }];
  const source = { preview: { cvDebug: { source: { width: 192, height: 192 }, label: { debug: { layers } } } } };
  const separated = separateInlineDebugLayers(source);

  assert.deepEqual(separated.layers, layers);
  assert.deepEqual((((separated.cvJob.preview as Record<string, unknown>).cvDebug as Record<string, unknown>).source), { width: 192, height: 192 });
  assert.deepEqual(((((separated.cvJob.preview as Record<string, unknown>).cvDebug as Record<string, unknown>).label as Record<string, unknown>).debug as Record<string, unknown>).layers, []);
  assert.deepEqual(attachInlineDebugLayers(separated.cvJob, separated.layers), source);
});
