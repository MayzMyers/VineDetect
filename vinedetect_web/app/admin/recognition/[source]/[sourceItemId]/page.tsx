import { AdminRecognitionDetailPage } from "@/components/admin/AdminRecognitionDetailPage";

type Props = {
  params: Promise<{
    source: string;
    sourceItemId: string;
  }>;
  searchParams: Promise<{
    section?: string;
    next?: string;
    prev?: string;
    pos?: string;
    total?: string;
    queue?: string;
    returnTo?: string;
    track?: string;
  }>;
};

export const metadata = {
  title: "Recognition Item | VineDetect",
};

export default async function RecognitionItemPage({ params, searchParams }: Props) {
  const { source, sourceItemId } = await params;
  const { section, next, prev, pos, total, queue, returnTo, track } = await searchParams;

  return (
    <AdminRecognitionDetailPage
      source={decodeURIComponent(source)}
      sourceItemId={decodeURIComponent(sourceItemId)}
      initialSection={normalizeSection(section)}
      initialTrackId={normalizeTrackId(track)}
      queueNav={normalizeQueueNav({ next, prev, pos, total, queue })}
      returnHref={normalizeReturnHref(returnTo)}
    />
  );
}

function normalizeSection(section?: string): "catalog" | "text" | "annotation" | "cv" | "saved" | "history" {
  if (section === "text") return "text";
  if (section === "annotation" || section === "label" || section === "label-annotation") return "annotation";
  if (section === "saved" || section === "metadata") return "saved";
  if (section === "cv" || section === "cv-lab" || section === "playground" || section === "meta") return "cv";
  if (section === "history" || section === "jobs") return "history";
  if (section === "catalog") return "catalog";
  return "annotation";
}

function normalizeQueueNav(input: { next?: string; prev?: string; pos?: string; total?: string; queue?: string }) {
  return {
    nextHref: normalizeRecognitionHref(input.next),
    prevHref: normalizeRecognitionHref(input.prev),
    position: normalizePositiveInt(input.pos),
    total: normalizePositiveInt(input.total),
    queue: input.queue ?? null,
  };
}

function normalizeRecognitionHref(value?: string) {
  if (!value) return null;
  const decoded = decodeURIComponent(value);
  return decoded.startsWith("/admin/recognition/") ? decoded : null;
}

function normalizeTrackId(value?: string) {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function normalizeReturnHref(value?: string) {
  if (!value) return null;
  if (value === "/admin/recognition" || value.startsWith("/admin/recognition?")) return value;
  try {
    const decoded = decodeURIComponent(value);
    return decoded === "/admin/recognition" || decoded.startsWith("/admin/recognition?") ? decoded : null;
  } catch {
    return null;
  }
}

function normalizePositiveInt(value?: string) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
