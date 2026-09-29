import assert from "node:assert/strict";
import test from "node:test";
import { decodeSavedVersionMask } from "./savedVersionMask.ts";

function runs(...values: Array<[number, number]>) {
  const bytes = Buffer.alloc(values.length * 8);
  values.forEach(([value, length], index) => {
    bytes.writeUInt32LE(value, index * 8);
    bytes.writeUInt32LE(length, index * 8 + 4);
  });
  return bytes.toString("base64");
}

test("saved mask RLE decodes foreground and background exactly", () => {
  const mask = decodeSavedVersionMask({ width: 2, height: 2, encoding: "rle-u8", data: runs([0, 1], [1, 2], [0, 1]) });
  assert.deepEqual(Array.from(mask?.values ?? []), [0, 1, 1, 0]);
});

test("incomplete, malformed and oversized mask layers are unavailable", () => {
  assert.equal(decodeSavedVersionMask({ width: 2, height: 2, encoding: "rle-u8", data: runs([1, 2]) }), null);
  assert.equal(decodeSavedVersionMask({ width: 2, height: 2, encoding: "rle-u8", data: "broken" }), null);
  assert.equal(decodeSavedVersionMask({ width: 1000, height: 1000, encoding: "rle-u8", data: runs([1, 1_000_000]) }), null);
});
