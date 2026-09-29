"use client";
import { useEffect, useState } from "react";
import { getStoredToken } from "@/lib/admin/auth";
import { AdminAuthPanel } from "./AdminAuthPanel";
import { AdminNavLinks } from "./AdminNavLinks";
import { AdminRecognitionJobsPanel } from "./AdminRecognitionJobsPanel";

export function AdminRecognitionJobsPage() {
  const [token, setToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setToken(getStoredToken());
      setAuthChecked(true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  function handleTokenChange(nextToken: string | null) {
    setToken(nextToken);
  }

  return (
    <main className="min-h-dvh bg-zinc-100 text-zinc-950">
      <AdminAuthPanel token={token} onTokenChange={handleTokenChange} />

      <div className="mx-auto max-w-7xl px-5 py-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Recognition jobs</h2>
            <p className="text-sm text-zinc-500">Meta generation jobs, worker progress, child items and retries.</p>
          </div>
          <AdminNavLinks active="jobs" />
        </div>

        {!authChecked && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
            Checking admin session...
          </section>
        )}

        {authChecked && !token && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6">
            <div className="text-sm font-semibold">Not logged in</div>
            <div className="mt-1 text-sm text-zinc-500">
              Log in to view recognition jobs.
            </div>
          </section>
        )}

        {authChecked && token && <AdminRecognitionJobsPanel token={token} />}
      </div>
    </main>
  );
}
