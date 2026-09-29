"use client";

import { FormEvent, useState } from "react";
import { clearStoredToken, storeToken } from "@/lib/admin/auth";
import { loginAdmin } from "@/lib/admin/api";

type Props = {
  token: string | null;
  onTokenChange: (token: string | null) => void;
};

export function AdminAuthPanel({ token, onTokenChange }: Props) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const principal = token ? tokenPrincipal(token) : null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await loginAdmin(username, password);
      storeToken(response.access_token);
      onTokenChange(response.access_token);
      setPassword("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    clearStoredToken();
    onTokenChange(null);
  }

  return (
    <section className="border-b border-zinc-200 bg-white px-5 py-4">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-950">VineDetect Admin</h1>
          <p className="text-sm text-zinc-500">
            {principal ? `${principal.username} · ${principal.role}` : token ? "Authenticated session." : "Log in to view admin content."}
          </p>
        </div>

        {token ? (
          <div className="flex items-center gap-3">
            <span className="rounded bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
              {principal?.role ?? "JWT active"}
            </span>
            <button
              type="button"
              onClick={logout}
              className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
            >
              Log out
            </button>
          </div>
        ) : (
          <form className="grid gap-2 sm:grid-cols-[150px_180px_96px]" onSubmit={handleSubmit}>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="h-10 rounded border border-zinc-300 px-3 text-sm text-zinc-950 outline-none focus:border-zinc-600"
              placeholder="Username"
            />
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-10 rounded border border-zinc-300 px-3 text-sm text-zinc-950 outline-none focus:border-zinc-600"
              placeholder="Password"
              type="password"
            />
            <button
              type="submit"
              disabled={loading}
              className="h-10 rounded bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              {loading ? "..." : "Log in"}
            </button>
            {error && <div className="text-xs text-red-600 sm:col-span-3">{error}</div>}
          </form>
        )}
      </div>
    </section>
  );
}

function tokenPrincipal(token: string): { username: string; role: string } | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: unknown; role?: unknown };
    return typeof payload.sub === "string" && typeof payload.role === "string"
      ? { username: payload.sub, role: payload.role }
      : null;
  } catch {
    return null;
  }
}
