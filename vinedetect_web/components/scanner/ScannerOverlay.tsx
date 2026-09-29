import type { FrameAnalysis, Rect, ScannerState } from "@/lib/scanner/types";

type Props = { state: ScannerState; analysis: FrameAnalysis | null; displayRoi: Rect | null };

export function ScannerOverlay({ state, analysis, displayRoi }: Props) {
  const stroke = state === "error"
    ? "border-rose-300"
    : ["stabilizing", "processing", "resolved"].includes(state)
      ? "border-[#f3eadb]"
      : "border-white/90";

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <div
        className="absolute transition-all duration-300"
        style={displayRoi ? {
          left: displayRoi.x, top: displayRoi.y, width: displayRoi.width, height: displayRoi.height,
        } : { left: "16%", top: "28%", width: "68%", height: "38%" }}
      >
        <span className={`absolute left-0 top-0 h-11 w-11 rounded-tl-[1.4rem] border-l-2 border-t-2 ${stroke}`} />
        <span className={`absolute right-0 top-0 h-11 w-11 rounded-tr-[1.4rem] border-r-2 border-t-2 ${stroke}`} />
        <span className={`absolute bottom-0 left-0 h-11 w-11 rounded-bl-[1.4rem] border-b-2 border-l-2 ${stroke}`} />
        <span className={`absolute bottom-0 right-0 h-11 w-11 rounded-br-[1.4rem] border-b-2 border-r-2 ${stroke}`} />
        {analysis && (
          <div className="absolute -bottom-5 left-1/2 h-1 w-24 -translate-x-1/2 overflow-hidden rounded-full bg-white/20">
            <div className="h-full rounded-full bg-[#f3eadb] transition-all" style={{ width: `${Math.round(analysis.captureReadiness * 100)}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
