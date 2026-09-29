"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getWine, type WineDetail } from "@/lib/admin/api";
import { getStoredToken } from "@/lib/admin/auth";
import { AdminAuthPanel } from "./AdminAuthPanel";

type Props = {
  wineId: number;
};

export function AdminWineDetailPage({ wineId }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [wine, setWine] = useState<WineDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setToken(getStoredToken());
      setAuthChecked(true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!authChecked || !token) {
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const response = await getWine(wineId, token);
        if (!cancelled) setWine(response);
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load wine");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [authChecked, token, wineId]);

  function handleTokenChange(nextToken: string | null) {
    setToken(nextToken);
    if (!nextToken) {
      setWine(null);
      setError(null);
      setLoading(false);
    }
  }

  return (
    <main className="min-h-dvh bg-zinc-100 text-zinc-950">
      <AdminAuthPanel token={token} onTokenChange={handleTokenChange} />

      <div className="mx-auto max-w-7xl px-5 py-5">
        <Link href="/admin" className="text-sm font-medium text-zinc-600 hover:text-zinc-950">
          Back to catalog
        </Link>

        {!authChecked && <div className="mt-4 rounded-lg bg-white p-5 text-sm text-zinc-600">Checking admin session...</div>}
        {authChecked && !token && (
          <div className="mt-4 rounded-lg bg-white p-5">
            <div className="text-sm font-semibold text-zinc-950">Not logged in</div>
            <div className="mt-1 text-sm text-zinc-500">Log in to view wine details.</div>
          </div>
        )}

        {loading && <div className="mt-4 rounded-lg bg-white p-5 text-sm text-zinc-600">Loading...</div>}
        {error && <div className="mt-4 rounded-lg bg-white p-5 text-sm text-red-600">{error}</div>}

        {wine && (
          <article className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <section className="rounded-lg border border-zinc-200 bg-white p-5">
              <div className="text-sm text-zinc-500">#{wine.id} / {wine.source ?? "unknown"} / {wine.external_id ?? "-"}</div>
              <h1 className="mt-2 text-2xl font-semibold leading-tight">{wine.title}</h1>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <Field label="Producer" value={wine.manufacturer_name} />
                <Field label="Region" value={wine.region_name} />
                <Field label="Category" value={wine.category_name} />
                <Field label="Color" value={wine.color} />
                <Field label="Rating" value={formatValue(wine.public_rating)} />
                <Field label="Alcohol" value={formatValue(wine.alcohol)} />
                <Field label="Temperature" value={wine.temperature} />
                <Field label="Slug" value={wine.slug} />
              </div>

              {wine.description && (
                <div className="mt-5 border-t border-zinc-200 pt-5">
                  <h2 className="text-sm font-semibold uppercase text-zinc-500">Description</h2>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-800">{wine.description}</p>
                </div>
              )}

              <ChipSection title="Grapes" values={wine.grapes} />
              <DishSection items={wine.dish_items} fallbackValues={wine.dishes} />
              <ChipSection title="Barcodes" values={wine.barcodes} />
            </section>

            <aside className="space-y-4">
              <section className="rounded-lg border border-zinc-200 bg-white p-4">
                <h2 className="text-sm font-semibold uppercase text-zinc-500">Images</h2>
                {wine.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={wine.image_url}
                    alt={wine.image_alt ?? wine.title}
                    className="mt-3 max-h-80 w-full rounded object-contain"
                  />
                )}
                <div className="mt-3 space-y-2 text-xs text-zinc-600">
                  {wine.images.map((image) => (
                    <div key={image.id} className="rounded border border-zinc-200 p-2">
                      <div>{image.kind} / {image.download_status ?? "-"}</div>
                      <div className="break-words">{image.local_path ?? image.url}</div>
                    </div>
                  ))}
                </div>
              </section>
            </aside>
          </article>
        )}
      </div>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="rounded border border-zinc-200 p-3">
      <div className="text-xs uppercase text-zinc-500">{label}</div>
      <div className="mt-1 text-sm font-medium">{value || "-"}</div>
    </div>
  );
}

function ChipSection({ title, values }: { title: string; values: string[] }) {
  if (values.length === 0) return null;

  return (
    <div className="mt-5 border-t border-zinc-200 pt-5">
      <h2 className="text-sm font-semibold uppercase text-zinc-500">{title}</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        {values.map((value) => (
          <span key={value} className="rounded bg-zinc-100 px-2 py-1 text-sm text-zinc-700">
            {value}
          </span>
        ))}
      </div>
    </div>
  );
}

function DishSection({
  items,
  fallbackValues,
}: {
  items?: WineDetail["dish_items"];
  fallbackValues: string[];
}) {
  if (!items?.length) return <ChipSection title="Dishes" values={fallbackValues} />;

  return (
    <div className="mt-5 border-t border-zinc-200 pt-5">
      <h2 className="text-sm font-semibold uppercase text-zinc-500">Dishes</h2>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <div key={item.name} className="flex items-center gap-3 rounded border border-zinc-200 p-2">
            {item.image?.url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={localDishAssetUrl(item.image.url)}
                alt={item.image.altText || item.name}
                className="h-10 w-10 shrink-0 rounded object-cover"
              />
            )}
            <span className="text-sm text-zinc-700">{item.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function localDishAssetUrl(sourceUrl: string) {
  try {
    const parsed = new URL(sourceUrl, "http://local");
    const isKnownSource =
      parsed.pathname.startsWith("/uploads/") &&
      (parsed.hostname === "local" ||
        parsed.hostname === "vino-svoe.ru" ||
        parsed.hostname === "www.vino-svoe.ru");
    const fileName = decodeURIComponent(parsed.pathname.split("/").pop() ?? "");

    if (isKnownSource && /^[a-zA-Z0-9._-]+$/.test(fileName)) {
      return `/assets/dishes/${fileName}`;
    }
  } catch {
    // Preserve an unknown URL instead of breaking the entire dish section.
  }

  return sourceUrl;
}

function formatValue(value: string | number | null) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}
