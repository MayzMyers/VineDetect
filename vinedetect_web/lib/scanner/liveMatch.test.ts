import assert from "node:assert/strict";
import test from "node:test";
import { extractOcrKeywords, normalizeMatchText } from "./liveMatch.ts";

test("extractOcrKeywords keeps distinctive OCR terms and removes generic wine words", () => {
  assert.deepEqual(
    extractOcrKeywords("Абрау Дюрсо вино белое брют 2021 12"),
    ["абрау", "дюрсо", "2021"]
  );
});

test("extractOcrKeywords normalizes yo and removes duplicates", () => {
  assert.deepEqual(extractOcrKeywords("Моё моё Шато Chateau"), ["chateau", "шато", "мое"]);
});

test("normalizeMatchText makes catalog and OCR text comparable", () => {
  assert.equal(normalizeMatchText("  Ласточкино-Гнездо, 2020  "), "ласточкино гнездо 2020");
});
