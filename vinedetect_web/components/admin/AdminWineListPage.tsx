"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { API_BASE_URL, listCatalog, type CatalogItem } from "@/lib/admin/api";
import { getStoredToken } from "@/lib/admin/auth";
import { AdminAuthPanel } from "./AdminAuthPanel";
import { AdminNavLinks } from "./AdminNavLinks";

type SortKey = "source" | "title" | "manufacturer" | "region" | "category" | "rating";
type SortDirection = "asc" | "desc";
type CatalogSource = "all" | "svoe_vino" | "roskachestvo";

const PAGE_SIZE = 50;

export function AdminWineListPage() {
  const [token, setToken] = useState<string | null>(null);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [source, setSource] = useState<CatalogSource>("all");
  const [lastCount, setLastCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("source");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        const response = await listCatalog(
          {
            q: query,
            source,
            limit: PAGE_SIZE,
            offset,
          },
          token
        );

        if (cancelled) return;
        setItems(response.items);
        setLastCount(response.count);
      } catch (nextError) {
        if (cancelled) return;
        setItems([]);
        setLastCount(0);
        setError(nextError instanceof Error ? nextError.message : "Failed to load catalog");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [authChecked, offset, query, source, token]);

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => compareCatalogItem(a, b, sortKey, sortDirection));
  }, [items, sortDirection, sortKey]);

  function updateSort(nextKey: SortKey) {
    if (nextKey === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortKey(nextKey);
    setSortDirection("asc");
  }

  function resetFilters() {
    setQuery("");
    setSource("all");
    setOffset(0);
  }

  function handleTokenChange(nextToken: string | null) {
    setToken(nextToken);
    if (!nextToken) {
      setItems([]);
      setLastCount(0);
      setError(null);
      setLoading(false);
    }
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const hasNextPage = lastCount === PAGE_SIZE;
  const isLoggedIn = Boolean(token);

  return (
    <main className="min-h-dvh bg-zinc-100 text-zinc-950">
      <AdminAuthPanel token={token} onTokenChange={handleTokenChange} />

      <div className="mx-auto max-w-7xl px-5 py-5">
        <div className="mb-4 flex justify-end">
          <AdminNavLinks active="catalog" />
        </div>

        <section className="mb-4 rounded-lg border border-zinc-200 bg-white p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-semibold">
                {isLoggedIn ? "Logged in with JWT" : "Not logged in"}
              </div>
              <div className="mt-1 text-sm text-zinc-500">Catalog content is hidden until login.</div>
            </div>
            <div className="rounded bg-zinc-100 px-3 py-2 text-xs text-zinc-600">
              API: {API_BASE_URL}
            </div>
          </div>
        </section>

        {!authChecked && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
            Checking admin session...
          </section>
        )}

        {authChecked && !token && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6">
            <div className="text-sm font-semibold text-zinc-950">Not logged in</div>
            <div className="mt-1 text-sm text-zinc-500">
              Enter admin credentials above to load catalog cards and recognition editor tools.
            </div>
          </section>
        )}

        {authChecked && token && (
          <>
        <section className="mb-4 rounded-lg border border-zinc-200 bg-white p-4">
          <div className="grid gap-3 md:grid-cols-[1.4fr_220px_auto]">
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
              className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
              placeholder="Search title, producer, category, barcode"
            />
            <select
              value={source}
              onChange={(event) => {
                setSource(event.target.value as CatalogSource);
                setOffset(0);
              }}
              className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
            >
              <option value="all">All sources</option>
              <option value="svoe_vino">Svoe Vino</option>
              <option value="roskachestvo">Roskachestvo</option>
            </select>
            <button
              type="button"
              onClick={resetFilters}
              className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50"
            >
              Reset
            </button>
          </div>
        </section>

        <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <div className="flex flex-col gap-2 border-b border-zinc-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-zinc-600">
              {loading ? "Loading..." : `${lastCount.toLocaleString()} catalog cards`} / page {page}
            </div>
            {error && <div className="text-sm text-red-600">Request error</div>}
          </div>

          {error && (
            <div className="border-b border-red-100 bg-red-50 px-4 py-4 text-sm text-red-700">
              Catalog request failed: {error}
            </div>
          )}

          {!loading && !error && sortedItems.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-zinc-500">
              No content returned. Check backend health, source, search query, and API base URL.
            </div>
          )}

          {sortedItems.length > 0 && (
            <div className="overflow-auto">
              <table className="w-full min-w-[1080px] border-collapse text-left text-sm">
                <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
                  <tr>
                    <SortableHeader label="Source" sortKey="source" activeKey={sortKey} direction={sortDirection} onSort={updateSort} />
                    <SortableHeader label="Title" sortKey="title" activeKey={sortKey} direction={sortDirection} onSort={updateSort} />
                    <SortableHeader label="Producer" sortKey="manufacturer" activeKey={sortKey} direction={sortDirection} onSort={updateSort} />
                    <SortableHeader label="Region" sortKey="region" activeKey={sortKey} direction={sortDirection} onSort={updateSort} />
                    <SortableHeader label="Category" sortKey="category" activeKey={sortKey} direction={sortDirection} onSort={updateSort} />
                    <SortableHeader label="Rating" sortKey="rating" activeKey={sortKey} direction={sortDirection} onSort={updateSort} />
                    <th className="px-4 py-3">Barcode</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedItems.map((item) => (
                    <tr key={item.recognitionKey} className="border-t border-zinc-100 hover:bg-zinc-50">
                      <td className="whitespace-nowrap px-4 py-3 text-zinc-500">{formatSource(item.source)}</td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/recognition/${encodeURIComponent(item.source)}/${encodeURIComponent(item.external_id)}?section=catalog`}
                          className="font-medium text-zinc-950 hover:underline"
                        >
                          {item.title ?? "Untitled"}
                        </Link>
                        <div className="mt-1 text-xs text-zinc-500">{item.recognitionKey}</div>
                      </td>
                      <td className="px-4 py-3">{item.manufacturer ?? "-"}</td>
                      <td className="px-4 py-3">{item.region ?? "-"}</td>
                      <td className="px-4 py-3">{item.category ?? "-"}</td>
                      <td className="whitespace-nowrap px-4 py-3">{formatValue(item.rating)}</td>
                      <td className="whitespace-nowrap px-4 py-3">{item.barcode ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-3">
            <button
              type="button"
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!hasNextPage || loading}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </section>
          </>
        )}
      </div>
    </main>
  );
}

function SortableHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === activeKey;

  return (
    <th className="px-4 py-3">
      <button type="button" onClick={() => onSort(sortKey)} className="font-semibold">
        {label} {active ? (direction === "asc" ? "asc" : "desc") : ""}
      </button>
    </th>
  );
}

function compareCatalogItem(a: CatalogItem, b: CatalogItem, key: SortKey, direction: SortDirection) {
  const aValue = a[key];
  const bValue = b[key];
  const modifier = direction === "asc" ? 1 : -1;

  if (key === "rating") {
    return (Number(aValue ?? 0) - Number(bValue ?? 0)) * modifier;
  }

  return String(aValue ?? "").localeCompare(String(bValue ?? ""), "ru") * modifier;
}

function formatValue(value: string | number | null) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function formatSource(source: string) {
  if (source === "svoe_vino") return "Svoe Vino";
  if (source === "roskachestvo") return "Roskachestvo";
  return source;
}
