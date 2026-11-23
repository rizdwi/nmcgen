"use client";
import { DEFAULT_GEMINI_ID, defaultProfiles } from "./presets";
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
    textProfileId: DEFAULT_GEMINI_ID,
    imageProfileId: DEFAULT_GEMINI_ID,
    lastProjectId: "",
  };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const merged: NmcSettings = { ...fallback, ...raw };
    for (const def of defaultProfiles()) {
      if (!merged.profiles.some((p) => p.id === def.id)) merged.profiles.push(def);
    }
    if (!merged.textProfileId) merged.textProfileId = DEFAULT_GEMINI_ID;
    if (!merged.imageProfileId) merged.imageProfileId = DEFAULT_GEMINI_ID;
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

export async function callAi(
  profile: ProviderProfile,
  op: "test" | "text" | "image",
  payload: { system?: string; prompt?: string; aspectRatio?: "9:16" | "16:9"; referenceImages?: string[] } = {},
): Promise<{ ok: boolean; text?: string; image?: string; error?: string }> {
  const key = getApiKey(profile.id);
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profile,
      key: key || undefined,
      op,
      ...payload,
    }),
  });
  return res.json();
}
