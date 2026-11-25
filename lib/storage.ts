"use client";
import { DEFAULT_CLOUDFLARE_ID, defaultProfiles } from "./presets";
import type { NmcProject, NmcSettings, ProviderProfile } from "./types";

const DB_NAME = "nmcgen-db";
const STORE_NAME = "projects";
const SETTINGS_KEY = "nmcgen.settings";
const KEYS_KEY = "nmcgen.keys";

const openDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function runTx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const projectDb = {
  list: () => runTx<NmcProject[]>("readonly", (s) => s.getAll()),
  get: (id: string) => runTx<NmcProject | undefined>("readonly", (s) => s.get(id)),
  put: (project: NmcProject) => runTx("readwrite", (s) => s.put(project)),
  del: (id: string) => runTx("readwrite", (s) => s.delete(id)),
};

export function loadSettings(): NmcSettings {
  const fallback: NmcSettings = {
    profiles: defaultProfiles(),
    textProfileId: DEFAULT_CLOUDFLARE_ID,
    imageProfileId: DEFAULT_CLOUDFLARE_ID,
    lastProjectId: "",
  };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const merged: NmcSettings = { ...fallback, ...raw };
    const existingIds = new Set(merged.profiles.map((p) => p.id));
    const missing = defaultProfiles().filter((def) => !existingIds.has(def.id));
    if (missing.length > 0) {
      merged.profiles = [...missing, ...merged.profiles];
    }
    if (!merged.textProfileId) merged.textProfileId = DEFAULT_CLOUDFLARE_ID;
    if (!merged.imageProfileId) merged.imageProfileId = DEFAULT_CLOUDFLARE_ID;
    return merged;
  } catch {
    return fallback;
  }
}

export function saveSettings(settings: NmcSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadKeys(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEYS_KEY) || "{}");
  } catch {
    return {};
  }
}

export function getApiKey(profileId: string): string {
  return loadKeys()[profileId] ?? "";
}

export function setApiKey(profileId: string, key: string) {
  const map = loadKeys();
  if (key.trim()) map[profileId] = key.trim();
  else delete map[profileId];
  localStorage.setItem(KEYS_KEY, JSON.stringify(map));
}

export function getKeyHint(profileId: string): string {
  const k = getApiKey(profileId);
  return k ? `••••${k.slice(-4)}` : "";
}

export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Gagal membaca berkas lokal."));
    reader.readAsDataURL(file);
  });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export interface AiCallResponse {
  ok: boolean;
  text?: string;
  image?: string;
  error?: string;
  usedModel?: string;
  fallbackNotes?: string[];
  discovered?: {
    textModels: string[];
    imageModels: string[];
    totalCount: number;
    fetchedAt: number;
  };
}

export async function callAi(
  profile: ProviderProfile,
  op: "test" | "discover" | "text" | "image",
  payload: {
    key?: string;
    system?: string;
    prompt?: string;
    aspectRatio?: "9:16" | "16:9" | "3:4" | "1:1";
    referenceImages?: string[];
  } = {},
): Promise<AiCallResponse> {
  const key = payload.key !== undefined ? payload.key : getApiKey(profile.id);
  // Generate tidak boleh menggantung selamanya: batasi 240 detik agar
  // kegagalan tampil sebagai pesan error, bukan spinner tanpa akhir.
  const timeoutSignal =
    typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(240_000) : undefined;
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: timeoutSignal,
    body: JSON.stringify({
      profile,
      key: key || undefined,
      op,
      system: payload.system,
      prompt: payload.prompt,
      aspectRatio: payload.aspectRatio,
      referenceImages: payload.referenceImages,
    }),
  });
  return res.json();
}
