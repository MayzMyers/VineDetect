import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecognitionBootstrapIndex,
  buildRecognitionKeywordIndex,
  matchRecognitionBootstrap,
  matchRecognitionBootstrapTokens,
  matchRecognitionKeywordTokens,
  selectRecognitionHypothesis,
  suggestRecognitionBootstrap,
  type RecognitionBootstrap,
} from "./recognitionBootstrap.ts";

const bootstrap: RecognitionBootstrap = {
  schemaVersion: 1,
  version: "test-v1",
  generatedAt: "2026-09-27T00:00:00Z",
  items: [
    {
      catalogKey: "wine:adagum",
      displayTitle: "Adagum Valley Riesling",
      producer: "Olymp Winery",
      metadata: { producer: "Olymp Winery", grapes: ["Рислинг"], color: "белое" },
      tags: [
        { value: "ADAGUM VALLEY", weight: 1, source: "verified_ocr" },
        { value: "100 ОТТЕНКОВ КРАСНОГО", weight: 1, source: "verified_ocr" },
        { value: "Рислинг", weight: 0.8, source: "alias" },
      ],
    },
    {
      catalogKey: "wine:abrau",
      displayTitle: "Abrau Estates",
      producer: "Абрау-Дюрсо",
      metadata: { producer: "Абрау-Дюрсо", grapes: ["Шардоне"], color: "белое" },
      tags: [
        { value: "ABRAU ESTATES", weight: 1, source: "verified_ocr" },
        { value: "DOC", weight: 0.5, source: "metadata" },
        { value: "Абрау Эстейтс", weight: 0.95, source: "alias" },
      ],
    },
    {
      catalogKey: "wine:abrau-reserve",
      displayTitle: "Abrau Reserve Brut",
      producer: "Абрау-Дюрсо",
      metadata: { producer: "Абрау-Дюрсо", grapes: ["Шардоне"], color: "белое" },
      tags: [
        { value: "ABRAU DURSO", weight: 1, source: "verified_ocr" },
        { value: "RESERVE BRUT", weight: 0.9, source: "verified_ocr" },
      ],
    },
  ],
};

const index = buildRecognitionBootstrapIndex(bootstrap);

test("matches verified visual text without a server request", () => {
  const [candidate] = matchRecognitionBootstrap(index, "ADAGUM VALLEY RIESLING");
  assert.equal(candidate.wineId, "wine:adagum");
  assert.equal(candidate.source, "bootstrap_tags");
  assert.ok(candidate.score > 0.7);
});

test("matches Cyrillic aliases even when catalog title is Latin", () => {
  const [candidate] = matchRecognitionBootstrap(index, "АБРАУ ЭСТЕЙТС");
  assert.equal(candidate.wineId, "wine:abrau");
  assert.deepEqual(candidate.matchedTags, ["Абрау Эстейтс"]);
});

test("tolerates a small OCR typo", () => {
  const [candidate] = matchRecognitionBootstrap(index, "ADAGVM VALLEY");
  assert.equal(candidate.wineId, "wine:adagum");
});

test("early OCR returns canonical metadata tokens and rejects unmatched noise", () => {
  const signals = matchRecognitionBootstrapTokens(index, "ADAGVM dfg DOC ADAGVM VALLEY unknown утенков");
  assert.deepEqual([...signals].sort(), ["adagum", "doc", "valley", "оттенков"]);
});

test("compact keyword index resolves fuzzy OCR to its canonical token", () => {
  const keywordIndex = buildRecognitionKeywordIndex({
    schemaVersion: 1,
    version: "keywords-test-v1",
    generatedAt: "2026-09-29T00:00:00Z",
    source: { name: "references.json", sha256: "test", itemCount: 1 },
    keywords: ["оттенков", "фанагория", "doc"],
  });
  assert.deepEqual(matchRecognitionKeywordTokens(keywordIndex, "утенков dfg DOC"), ["оттенков", "doc"]);
});

test("an exact hypothesis waits while a single tag ties multiple products", () => {
  const tied = matchRecognitionBootstrap(index, "ABRAU");
  assert.equal(selectRecognitionHypothesis(tied), null);
  const exact = matchRecognitionBootstrap(index, "ABRAU ESTATES");
  assert.equal(selectRecognitionHypothesis(exact)?.wineId, "wine:abrau");
});

test("suggests by OCR when the catalog has no exact result", () => {
  const [suggestion] = suggestRecognitionBootstrap(index, { ocrText: "ADAGVM VALLEY" });
  assert.equal(suggestion.wineId, "wine:adagum");
  assert.equal(suggestion.source, "bootstrap_suggestion");
  assert.equal(suggestion.suggestionReason, "ocr_similarity");
});

test("suggests alternatives from recognized item metadata", () => {
  const [suggestion] = suggestRecognitionBootstrap(index, {
    seedCatalogKey: "wine:abrau",
  });
  assert.equal(suggestion.wineId, "wine:abrau-reserve");
  assert.equal(suggestion.suggestionReason, "metadata_similarity");
  assert.ok(suggestion.matchedMetadata?.includes("producer"));
  assert.ok(suggestion.matchedMetadata?.includes("grapes"));
});
