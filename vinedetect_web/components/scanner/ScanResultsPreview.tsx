import type { WineCandidate } from "@/lib/catalog/types";
import type { OcrResult } from "@/lib/ocr/tesseract";
import type { RecognitionProduct } from "@/lib/scanner/recognitionFlow";
import type { ScannerState } from "@/lib/scanner/types";

type Props = {
  state: ScannerState;
  ocr: OcrResult | null;
  candidates: WineCandidate[];
  suggestions: WineCandidate[];
  product: RecognitionProduct | null;
  recognitionConfidence: number | null;
  outcome: "match" | "no_match" | null;
  isLoadingSuggestions: boolean;
  onRequestSuggestions: () => void;
  onConfirmCandidate: () => void;
};

export function ScanResultsPreview(props: Props) {
  const { state, ocr, candidates, suggestions, product, recognitionConfidence, outcome, isLoadingSuggestions, onRequestSuggestions, onConfirmCandidate } = props;
  if (!ocr && candidates.length === 0 && suggestions.length === 0 && !product) return null;

  return (
    <section className="max-h-[44dvh] overflow-auto rounded-lg bg-white p-4 text-black shadow-2xl">
      {product && <ProductCard product={product} confidence={recognitionConfidence} />}
      {outcome === "no_match" && state === "resolved" && (
        <div className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">No catalog match. Keep scanning or open suggested variants.</div>
      )}
      {ocr && (
        <div className="mb-3">
          <div className="text-xs uppercase text-black/50">Live OCR</div>
          <div className="mt-1 line-clamp-2 text-sm">{ocr.normalizedText || "No text found"}</div>
          <div className="mt-1 text-xs text-black/50">confidence: {Math.round(ocr.confidence)}%</div>
        </div>
      )}

      {candidates.length > 0 && !product && (
        <div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs uppercase text-black/50">Provisional match</div>
            <button type="button" className="rounded-full border border-black/15 px-3 py-1 text-xs font-medium disabled:opacity-45" disabled={isLoadingSuggestions} onClick={onRequestSuggestions}>
              {isLoadingSuggestions ? "Finding…" : "More variants"}
            </button>
          </div>
          <div className="mt-2 space-y-2">{candidates.slice(0, 3).map((candidate) => <CandidateCard key={candidate.wineId} candidate={candidate} />)}</div>
          {state === "hypothesis" && (
            <button type="button" onClick={onConfirmCandidate} className="mt-3 w-full rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white">Open this candidate</button>
          )}
        </div>
      )}

      {suggestions.length > 0 && (
        <div className={candidates.length > 0 || product ? "mt-4 border-t border-black/10 pt-4" : ""}>
          <div className="text-xs uppercase text-violet-700">Additional variants</div>
          <div className="mt-1 text-xs text-black/50">Based on OCR and metadata from the recognition bootstrap.</div>
          <div className="mt-2 space-y-2">{suggestions.slice(0, 5).map((candidate) => <CandidateCard key={candidate.wineId} candidate={candidate} />)}</div>
        </div>
      )}

      {ocr && candidates.length === 0 && suggestions.length === 0 && !product && !["hypothesis", "stabilizing", "processing"].includes(state) && (
        <div className="text-sm text-black/55">No catalog match yet. Keep the label in the frame.</div>
      )}
    </section>
  );
}

function ProductCard({ product, confidence }: { product: RecognitionProduct; confidence: number | null }) {
  return (
    <div className="mb-4 flex gap-4 rounded-xl bg-emerald-50 p-3">
      {product.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={product.image} alt="" className="h-24 w-16 shrink-0 rounded object-contain" />
      )}
      <div className="min-w-0">
        <div className="text-xs font-semibold uppercase text-emerald-700">Recognized</div>
        <div className="mt-1 font-semibold">{product.title}</div>
        {product.producer && <div className="text-sm text-black/55">{product.producer}</div>}
        {(product.region || product.vintage) && <div className="mt-1 text-xs text-black/45">{[product.region, product.vintage].filter(Boolean).join(" · ")}</div>}
        {confidence !== null && <div className="mt-1 text-xs text-black/45">confidence: {Math.round(confidence * 100)}%</div>}
      </div>
    </div>
  );
}

function CandidateCard({ candidate }: { candidate: WineCandidate }) {
  return (
    <div className="flex gap-3 rounded-lg border border-black/10 p-3">
      {candidate.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={candidate.imageUrl} alt="" className="h-16 w-12 shrink-0 rounded object-contain" />
      )}
      <div className="min-w-0">
        <div className={["mb-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase", candidate.source === "bootstrap_suggestion" ? "bg-violet-100 text-violet-800" : candidate.source === "bootstrap_tags" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"].join(" ")}>
          {candidate.source === "bootstrap_suggestion" ? "Suggested" : candidate.source === "bootstrap_tags" ? "Local guess" : "Server match"}
        </div>
        <div className="text-sm font-semibold">{candidate.title}</div>
        {candidate.producer && <div className="text-xs text-black/50">{candidate.producer}</div>}
        <div className="mt-1 text-xs text-black/50">relevance: {Math.round(candidate.score * 100)}%</div>
        {candidate.matchedTags?.length ? <div className="mt-1 line-clamp-1 text-xs text-black/45">tags: {candidate.matchedTags.join(", ")}</div> : null}
      </div>
    </div>
  );
}
