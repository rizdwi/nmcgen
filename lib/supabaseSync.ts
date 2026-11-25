// Pure Supabase PostgREST sync helper (zero external SDK dependency).
import type { NmcProject } from "./types.ts";
import { getPrimaryScript } from "./validator.ts";

export interface SupabaseConfig {
  url: string;
  key: string;
}

export function getServerSupabaseConfig(): SupabaseConfig | null {
  const url = (process?.env?.SUPABASE_URL || process?.env?.NEXT_PUBLIC_SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = (
    process?.env?.SUPABASE_PUBLISHABLE_KEY ||
    process?.env?.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process?.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ""
  ).trim();
  if (!url || !key) return null;
  return { url, key };
}

export function projectToSupabaseRow(project: NmcProject) {
  const sb = project.storyboard;
  const script = getPrimaryScript(project);
  return {
    id: project.id,
    name: project.name || "Proyek Baru",
    aspect_ratio: sb?.aspectRatio ?? script?.aspectRatio ?? "16:9",
    visual_style: sb?.visualStyle ?? script?.visualStyle ?? "",
    premise: sb?.idea ?? script?.premise ?? "",
    updated_at: project.updatedAt,
    data: project,
  };
}

export function mergeProjects(local: NmcProject[], remote: NmcProject[]): NmcProject[] {
  const map = new Map<string, NmcProject>();
  for (const p of local) {
    if (p?.id && Array.isArray(p.nodes)) map.set(p.id, p);
  }
  for (const r of remote) {
    if (!r?.id || !Array.isArray(r.nodes)) continue;
    const cur = map.get(r.id);
    if (!cur || r.updatedAt >= cur.updatedAt) {
      map.set(r.id, r);
    }
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function sbListProjects(cfg: SupabaseConfig): Promise<NmcProject[]> {
  const res = await fetch(`${cfg.url}/rest/v1/nmcgen_projects?select=data&order=updated_at.desc`, {
    headers: {
      apikey: cfg.key,
      authorization: `Bearer ${cfg.key}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`Supabase list gagal (${res.status}): ${raw.slice(0, 200)}`);
  }
  const rows = (await res.json()) as Array<{ data?: NmcProject }>;
  return rows
    .map((r) => r?.data)
    .filter((p): p is NmcProject => Boolean(p && p.id && Array.isArray(p.nodes)));
}

export async function sbUpsertProject(cfg: SupabaseConfig, project: NmcProject): Promise<void> {
  const row = projectToSupabaseRow(project);
  const res = await fetch(`${cfg.url}/rest/v1/nmcgen_projects?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: cfg.key,
      authorization: `Bearer ${cfg.key}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`Supabase upsert gagal (${res.status}): ${raw.slice(0, 200)}`);
  }
}

export async function sbDeleteProject(cfg: SupabaseConfig, id: string): Promise<void> {
  const res = await fetch(
    `${cfg.url}/rest/v1/nmcgen_projects?id=eq.${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: {
        apikey: cfg.key,
        authorization: `Bearer ${cfg.key}`,
        prefer: "return=minimal",
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`Supabase delete gagal (${res.status}): ${raw.slice(0, 200)}`);
  }
}

// Client-side wrappers calling /api/projects (so keys stay server-side)
export const cloudDb = {
  async list(): Promise<{ connected: boolean; projects: NmcProject[]; error?: string }> {
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      const data = await res.json();
      if (!data?.connected) return { connected: false, projects: [] };
      if (!res.ok || !data.ok) return { connected: true, projects: [], error: data.error };
      return { connected: true, projects: Array.isArray(data.projects) ? data.projects : [] };
    } catch (err) {
      return { connected: false, projects: [], error: (err as Error).message };
    }
  },
  async put(project: NmcProject): Promise<{ ok: boolean; connected: boolean; error?: string }> {
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project }),
      });
      const data = await res.json();
      return { ok: Boolean(data?.ok), connected: Boolean(data?.connected), error: data?.error };
    } catch (err) {
      return { ok: false, connected: false, error: (err as Error).message };
    }
  },
  async del(id: string): Promise<{ ok: boolean; connected: boolean; error?: string }> {
    try {
      const res = await fetch(`/api/projects?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      return { ok: Boolean(data?.ok), connected: Boolean(data?.connected), error: data?.error };
    } catch (err) {
      return { ok: false, connected: false, error: (err as Error).message };
    }
  },
};
