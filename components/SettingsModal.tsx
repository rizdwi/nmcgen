"use client";
import React, { useEffect, useState } from "react";
import type { NmcSettings, ProviderProfile, RuntimeStatus } from "@/lib/types";
import { callAi, getKeyHint, setApiKey } from "@/lib/storage";
import { CloseIcon } from "./Icons";

interface SettingsModalProps {
  open: boolean;
  settings: NmcSettings;
  runtime: RuntimeStatus | null;
  onUpdateSettings: (fn: (prev: NmcSettings) => NmcSettings) => void;
  onRefreshRuntime: () => void;
  onClose: () => void;
}

export default function SettingsModal({
  open,
  settings,
  runtime,
  onUpdateSettings,
  onRefreshRuntime,
  onClose,
}: SettingsModalProps) {
  const [activeId, setActiveId] = useState(settings.textProfileId);
  const [keyDraft, setKeyDraft] = useState("");
  const [testMsg, setTestMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKeyDraft("");
    setTestMsg(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const activeProfile =
    settings.profiles.find((p) => p.id === activeId) ?? settings.profiles[0];

  const patchProfile = (patch: Partial<ProviderProfile>) => {
    onUpdateSettings((prev) => ({
      ...prev,
      profiles: prev.profiles.map((p) => (p.id === activeProfile.id ? { ...p, ...patch } : p)),
    }));
  };

  const handleSaveKey = () => {
    setApiKey(activeProfile.id, keyDraft);
    setKeyDraft("");
    setTestMsg({ tone: "ok", text: "API key disimpan di localStorage browser (tidak ikut diekspor ke proyek)." });
  };

  const handleTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await callAi(activeProfile, "test");
      if (res.ok) {
        setTestMsg({ tone: "ok", text: res.text || "Koneksi provider berhasil." });
      } else {
        setTestMsg({ tone: "error", text: res.error || "Gagal terhubung ke provider." });
      }
    } catch (err) {
      setTestMsg({ tone: "error", text: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const savedHint = getKeyHint(activeProfile.id);

  return (
    <div
      className="modalBackdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onClick={onClose}
    >
      <div className="modalDialog" onClick={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <h2 id="settings-title">Pengaturan AI &amp; Runtime Hybrid</h2>
          <button type="button" className="btn btnGhost btnIcon" aria-label="Tutup pengaturan" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="modalBody">
          {/* Local vs Web Runtime Detection */}
          <div className="sectionBox">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <h3>Status Runtime Server</h3>
              <button type="button" className="btn btnSm" onClick={onRefreshRuntime}>
                Cek Ulang
              </button>
            </div>
            {!runtime ? (
              <p style={{ margin: 0, color: "var(--ink-muted)" }}>Memeriksa FFmpeg, Python, dan pyCapCut...</p>
            ) : (
              <>
                <div className="nodeMetaRow">
                  <span className="metaTag" data-tone={runtime.mode === "local-hybrid" ? "ok" : "warn"}>
                    {runtime.mode === "local-hybrid" ? "Mode Lokal Penuh" : "Mode Web / Serverless"}
                  </span>
                  <span className="metaTag" data-tone={runtime.localFfmpeg ? "ok" : "warn"}>
                    FFmpeg: {runtime.localFfmpeg ? "Siap" : "Tidak tersedia"}
                  </span>
                  <span className="metaTag" data-tone={runtime.localPython ? "ok" : "warn"}>
                    Python: {runtime.localPython ? "Siap" : "Tidak tersedia"}
                  </span>
                  <span className="metaTag" data-tone={runtime.localPyCapCut ? "ok" : "warn"}>
                    pyCapCut: {runtime.localPyCapCut ? "Terpasang" : "Belum terpasang"}
                  </span>
                </div>
                {runtime.ffmpegVersion ? (
                  <p className="mono" style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>
                    {runtime.ffmpegVersion}
                  </p>
                ) : null}
                {!runtime.localPyCapCut && runtime.localPython ? (
                  <div className="alertBox" data-tone="warn">
                    Untuk ekspor langsung ke folder CapCut Drafts di PC ini, jalankan sekali di terminal:{" "}
                    <code className="mono">pip install pycapcut==0.0.4</code>
                  </div>
                ) : null}
              </>
            )}
          </div>

          {/* Active Provider Selectors */}
          <div className="sectionBox">
            <h3>Provider Aktif untuk Kanvas</h3>
            <div className="fieldRow">
              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="sel-text-provider">
                  Provider Naskah &amp; Beat (Teks)
                </label>
                <select
                  id="sel-text-provider"
                  className="select"
                  value={settings.textProfileId}
                  onChange={(e) =>
                    onUpdateSettings((prev) => ({ ...prev, textProfileId: e.target.value }))
                  }
                >
                  {settings.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.textModel || "model belum diisi"})
                    </option>
                  ))}
                </select>
              </div>
              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="sel-img-provider">
                  Provider Referensi &amp; Keyframe (Gambar)
                </label>
                <select
                  id="sel-img-provider"
                  className="select"
                  value={settings.imageProfileId}
                  onChange={(e) =>
                    onUpdateSettings((prev) => ({ ...prev, imageProfileId: e.target.value }))
                  }
                >
                  {settings.profiles
                    .filter((p) => p.kind !== "Anthropic")
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.imageModel || "tanpa model gambar"})
                      </option>
                    ))}
                </select>
              </div>
            </div>
          </div>

          {/* Per-Profile Config */}
          <div className="sectionBox">
            <div className="fieldGroup">
              <label className="fieldLabel" htmlFor="sel-edit-profile">
                Edit Konfigurasi Profil
              </label>
              <select
                id="sel-edit-profile"
                className="select"
                value={activeProfile.id}
                onChange={(e) => {
                  setActiveId(e.target.value);
                  setKeyDraft("");
                  setTestMsg(null);
                }}
              >
                {settings.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.kind})
                  </option>
                ))}
              </select>
            </div>

            <div className="fieldRow">
              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="inp-text-model">
                  Model Teks
                </label>
                <input
                  id="inp-text-model"
                  className="input mono"
                  value={activeProfile.textModel}
                  onChange={(e) => patchProfile({ textModel: e.target.value })}
                  placeholder="gemini-4-hydrogen"
                />
              </div>
              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="inp-img-model">
                  Model Gambar
                </label>
                <input
                  id="inp-img-model"
                  className="input mono"
                  value={activeProfile.imageModel}
                  onChange={(e) => patchProfile({ imageModel: e.target.value })}
                  placeholder="gemini-nano-banana-2.1"
                />
              </div>
            </div>

            <div className="fieldGroup">
              <label className="fieldLabel" htmlFor="inp-base-url">
                Base URL Endpoint
              </label>
              <input
                id="inp-base-url"
                className="input mono"
                value={activeProfile.baseUrl}
                onChange={(e) => patchProfile({ baseUrl: e.target.value })}
              />
            </div>

            <div className="fieldGroup">
              <label className="fieldLabel" htmlFor="inp-api-key">
                API Key {savedHint ? `(tersimpan: ${savedHint})` : "(opsional jika env server sudah diisi)"}
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  id="inp-api-key"
                  type="password"
                  className="input mono"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder="Masukkan API key baru untuk disimpan lokal..."
                />
                <button type="button" className="btn" onClick={handleSaveKey}>
                  Simpan Key
                </button>
              </div>
            </div>

            {testMsg ? (
              <div className="alertBox" data-tone={testMsg.tone}>
                {testMsg.text}
              </div>
            ) : null}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="btn" disabled={testing} onClick={handleTest}>
                {testing ? "Menguji koneksi..." : "Uji Koneksi Provider"}
              </button>
            </div>
          </div>
        </div>

        <div className="modalFooter">
          <button type="button" className="btn btnPrimary" onClick={onClose}>
            Selesai
          </button>
        </div>
      </div>
    </div>
  );
}
