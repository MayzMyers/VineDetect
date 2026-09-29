// Existing scanner BFF: one unchanged photo -> frozen Core -> exact catalog card.
export const runtime = "nodejs";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const responseHeaders = { "Cache-Control": "no-store" };

function failure(error: string, status: number) {
  return Response.json({ error }, { status, headers: responseHeaders });
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return failure("Expected multipart image", 400);
  }
  const image = form.get("image");
  if (!(image instanceof Blob) || image.size === 0 || !image.type.startsWith("image/")) {
    return failure("A non-empty image is required", 400);
  }
  if (image.size > MAX_IMAGE_BYTES) return failure("Image exceeds 12 MiB", 413);

  const timeoutMs = Number(process.env.VINEDETECT_CORE_TIMEOUT_MS ?? "60000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return failure("Invalid recognition service timeout configuration", 503);
  }
  const coreBase = (process.env.VINEDETECT_CORE_URL ?? "http://127.0.0.1:8765").replace(/\/+$/, "");
  const apiBase = (process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
  const forwarded = new FormData();
  // Reuse the original Blob, without decoding, recompression or crop transforms.
  forwarded.set("image", image, image instanceof File ? image.name : "image");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let slug: string;
  try {
    const core = await fetch(`${coreBase}/v1/eval/predict`, {
      method: "POST", body: forwarded, cache: "no-store", signal: controller.signal,
    });
    if (!core.ok) return failure("Recognition service unavailable", 502);
    const result: unknown = await core.json();
    if (!result || typeof result !== "object" || !("slug" in result)) {
      return failure("Invalid recognition service response", 502);
    }
    if (result.slug === null) return failure("Wine could not be recognized", 422);
    if (typeof result.slug !== "string" || !result.slug.trim() || result.slug !== result.slug.trim()) {
      return failure("Invalid recognition service response", 502);
    }
    slug = result.slug;
  } catch {
    return failure(controller.signal.aborted ? "Recognition timed out" : "Recognition service unavailable", controller.signal.aborted ? 504 : 502);
  } finally {
    clearTimeout(timer);
  }

  try {
    const catalog = await fetch(`${apiBase}/api/v1/wines/by-official-slug/${encodeURIComponent(slug)}`, {
      headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    if (catalog.status === 404) return failure("Recognized wine is not linked to a catalog card", 404);
    if (!catalog.ok) return failure("Catalog service unavailable", 502);
    const wine = await catalog.json();
    if (!wine || wine.official_slug !== slug || !Number.isInteger(wine.id) || typeof wine.title !== "string" || !wine.title.trim()) {
      return failure("Invalid exact catalog response", 502);
    }
    const referencePath = optionalText(wine.official_reference?.local_path);
    const referenceImage = referencePath
      ? `/api/catalog/image?path=${encodeURIComponent(referencePath)}`
      : optionalText(wine.official_reference?.url);
    return Response.json({
      slug,
      product: {
        id: wine.id,
        catalogKey: `svoe_vino:${slug}`,
        slug,
        title: wine.title,
        producer: optionalText(wine.manufacturer_name),
        image: referenceImage ?? optionalText(wine.image_url),
        category: optionalText(wine.category_name),
        region: optionalText(wine.region_name),
        vintage: null,
        description: optionalText(wine.description),
        dishes: Array.isArray(wine.dishes)
          ? wine.dishes.filter((name: unknown) => typeof name === "string").map((name: string) => ({ name, image: null, alt: null }))
          : [],
      },
    }, { headers: responseHeaders });
  } catch {
    return failure("Catalog service unavailable", 502);
  }
}
