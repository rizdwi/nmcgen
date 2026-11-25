// Pure Supabase PostgREST sync helper (zero external SDK dependency).
import type { NmcProject } from "./types.ts";
import { getCloudflareEnvVar } from "./cfEnv.ts";
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

export async function getServerSupabaseConfigAsync(): Promise<SupabaseConfig | null> {
  const sync = getServerSupabaseConfig();
  if (sync) return sync;
  const url = (
    (await getCloudflareEnvVar("SUPABASE_URL")) ||
    (await getCloudflareEnvVar("NEXT_PUBLIC_SUPABASE_URL"))
  ).replace(/\/+$/, "");
  const key =
    (await getCloudflareEnvVar("SUPABASE_PUBLISHABLE_KEY")) ||
    (await getCloudflareEnvVar("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")) ||
    (await getCloudflareEnvVar("NEXT_PUBLIC_SUPABASE_ANON_KEY"));
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
    data: packProjectForCloud(project),
  };
}

// Gambar disimpan sebagai data URL base64 di dalam proyek. Satu gambar yang
// sama sering muncul berkali-kali (node lama + aset + frame storyboard),
// dan payload 12 MB yang tidak terkompres membuat upsert Supabase kena
// statement timeout (Postgres 57014). Karena itu, saat menulis ke cloud,
// data URL yang muncul lebih dari sekali hanya disimpan satu kali di map
// `blobs` dan kemunculan lainnya diganti referensi. Saat membaca, referensi
// dipulihkan lagi sehingga proyek yang diterima sama persis dengan aslinya.
// Bila tidak ada duplikat, data dikirim apa adanya (format lama tetap bisa dibaca).
const BLOB_REF_KEY = "$nmcgenBlob";
const BLOB_PACK_KEY = "__nmcgenBlobPack";

function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.length > 4096 && value.startsWith("data:image/");
}

function countDataUrls(value: unknown, counts: Map<string, number>): void {
  if (isImageDataUrl(value)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) countDataUrls(item, counts);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) countDataUrls(item, counts);
  }
}

function replaceDuplicateDataUrls(
  value: unknown,
  duplicates: Set<string>,
  blobs: Record<string, string>,
): unknown {
  if (isImageDataUrl(value) && duplicates.has(value)) {
    const hash = fnv1aHex(value);
    blobs[hash] = value;
    return { [BLOB_REF_KEY]: hash };
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceDuplicateDataUrls(item, duplicates, blobs));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = replaceDuplicateDataUrls(item, duplicates, blobs);
    }
    return out;
  }
  return value;
}

export function packProjectForCloud(project: NmcProject): unknown {
  const counts = new Map<string, number>();
  countDataUrls(project, counts);
  const duplicates = new Set([...counts.entries()].filter(([, n]) => n > 1).map(([s]) => s));
  if (duplicates.size === 0) return project;
  const blobs: Record<string, string> = {};
  const packed = replaceDuplicateDataUrls(project, duplicates, blobs) as NmcProject;
  return { [BLOB_PACK_KEY]: 1, blobs, project: packed };
}

function restoreDataUrls(value: unknown, blobs: Record<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => restoreDataUrls(item, blobs));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && typeof obj[BLOB_REF_KEY] === "string") {
      return blobs[obj[BLOB_REF_KEY] as string] ?? value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj)) {
      out[key] = restoreDataUrls(item, blobs);
    }
    return out;
  }
  return value;
}

export function unpackProjectFromCloud(data: unknown): NmcProject | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (
    obj[BLOB_PACK_KEY] === 1 &&
    obj.blobs &&
    typeof obj.blobs === "object" &&
    obj.project &&
    typeof obj.project === "object"
  ) {
    const restored = restoreDataUrls(obj.project, obj.blobs as Record<string, string>);
    return restored as NmcProject;
  }
  return data as NmcProject;
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
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`Supabase list gagal (${res.status}): ${raw.slice(0, 200)}`);
  }
  const rows = (await res.json()) as Array<{ data?: unknown }>;
  return rows
    .map((r) => unpackProjectFromCloud(r?.data))
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
    // Upsert baris besar (gambar base64) butuh waktu lebih lama di Postgres;
    // batas statement timeout Supabase harus dinaikkan dari dashboard agar
    // upsert di atas ~8 MB tidak dibatalkan (Postgres 57014).
    signal: AbortSignal.timeout(60000),
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
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`Supabase delete gagal (${res.status}): ${raw.slice(0, 200)}`);
  }
}

// Client-side wrappers calling /api/projects (so keys stay server-side)
function clientTimeout(ms: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

export const cloudDb = {
  async list(): Promise<{ connected: boolean; projects: NmcProject[]; error?: string }> {
    try {
      const res = await fetch("/api/projects", { cache: "no-store", signal: clientTimeout(35000) });
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
        signal: clientTimeout(70000),
      });
      const data = await res.json();
      return { ok: Boolean(data?.ok), connected: Boolean(data?.connected), error: data?.error };
    } catch (err) {
      return { ok: false, connected: false, error: (err as Error).message };
    }
  },
  async del(id: string): Promise<{ ok: boolean; connected: boolean; error?: string }> {
    try {
      const res = await fetch(`/api/projects?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal: clientTimeout(35000),
      });
      const data = await res.json();
      return { ok: Boolean(data?.ok), connected: Boolean(data?.connected), error: data?.error };
    } catch (err) {
      return { ok: false, connected: false, error: (err as Error).message };
    }
  },
};
