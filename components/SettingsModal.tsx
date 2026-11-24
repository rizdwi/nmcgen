"use client";
import React, { useEffect, useState } from "react";
import type { NmcSettings, ProviderProfile, RuntimeStatus } from "@/lib/types";
import { detectProviderKindFromKey } from "@/lib/modelRouter";
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

function profileModelBadge(p: ProviderProfile): string {
  const auto = p.autoModel !== false;
  const tCount = p.discoveredTextModels?.length ?? 0;
  const iCount = p.discoveredImageModels?.length ?? 0;
  if (tCount > 0 || iCount > 0) {
    return `${tCount} teks, ${iCount} gambar`;
  }
  if (!auto && (p.textModel || p.imageModel)) {
    return [p.textModel, p.imageModel].filter(Boolean).join(" / ");
  }
  return "otomatis dari API key";
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
  const [autoSwitchedHint, setAutoSwitchedHint] = useState("");
  const [statusMsg, setStatusMsg] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKeyDraft("");
    setAutoSwitchedHint("");
    setStatusMsg(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const activeProfile =
    settings.profiles.find((p) => p.id === activeId) ?? settings.profiles[0];

  const patchProfileById = (profileId: string, patch: Partial<ProviderProfile>) => {
    onUpdateSettings((prev) => ({
      ...prev,
      profiles: prev.profiles.map((p) => (p.id === profileId ? { ...p, ...patch } : p)),
    }));
  };

  const runDiscover = async (target: ProviderProfile, overrideKey?: string) => {
    setDetecting(true);
    setStatusMsg(null);
    try {
      const res = await callAi(target, "discover", overrideKey !== undefined ? { key: overrideKey } : {});
      if (!res.ok) {
        setStatusMsg({
          tone: "error",
          text: res.error || "Gagal mengenali model dari API key ini.",
        });
        return;
      }

      const discovered = res.discovered;
      const textModels = discovered?.textModels ?? [];
      const imageModels = discovered?.imageModels ?? [];

      onUpdateSettings((prev) => ({
        ...prev,
        textProfileId: textModels.length > 0 ? target.id : prev.textProfileId,
        imageProfileId: imageModels.length > 0 ? target.id : prev.imageProfileId,
        profiles: prev.profiles.map((p) =>
          p.id === target.id
            ? {
                ...p,
                autoModel: p.autoModel !== false,
                discoveredTextModels: textModels,
                discoveredImageModels: imageModels,
                modelsSyncedAt: discovered?.fetchedAt ?? Date.now(),
              }
            : p,
        ),
      }));

      setStatusMsg({
        tone: textModels.length > 0 || imageModels.length > 0 ? "ok" : "warn",
        text:
          res.text ||
          `Terhubung: ${textModels.length} model teks dan ${imageModels.length} model gambar terdeteksi.`,
      });
    } catch (err) {
      setStatusMsg({ tone: "error", text: (err as Error).message });
    } finally {
      setDetecting(false);
    }
  };

  const handleKeyInputChange = (val: string) => {
    setKeyDraft(val);
    const detectedKind = detectProviderKindFromKey(val);
    if (detectedKind && detectedKind !== activeProfile.kind) {
      const matched = settings.profiles.find((p) => p.kind === detectedKind);
      if (matched) {
        setActiveId(matched.id);
        setAutoSwitchedHint(`Format API key dikenali sebagai ${matched.name}.`);
        return;
      }
    }
    setAutoSwitchedHint("");
  };

  const handleSaveAndDetect = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = keyDraft.trim();
    const detectedKind = detectProviderKindFromKey(trimmed);
    const target =
      (detectedKind ? settings.profiles.find((p) => p.kind === detectedKind) : null) ?? activeProfile;

    if (trimmed) {
      setApiKey(target.id, trimmed);
      setActiveId(target.id);
      setKeyDraft("");
      setAutoSwitchedHint("");
      await runDiscover(target, trimmed);
      return;
    }

    await runDiscover(target);
  };

  const handleClearKey = () => {
    setApiKey(activeProfile.id, "");
    setKeyDraft("");
    patchProfileById(activeProfile.id, {
      discoveredTextModels: [],
      discoveredImageModels: [],
      modelsSyncedAt: undefined,
    });
    setStatusMsg({ tone: "warn", text: `API key lokal untuk ${activeProfile.name} dihapus.` });
  };

  const savedHint = getKeyHint(activeProfile.id);
  const textModels = activeProfile.discoveredTextModels ?? [];
  const imageModels = activeProfile.discoveredImageModels ?? [];
  const isAuto = activeProfile.autoModel !== false;

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
          {/* API Key & Auto Model Discovery */}
          <form className="sectionBox" onSubmit={handleSaveAndDetect}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <h3>Koneksi API Key &amp; Deteksi Model Otomatis</h3>
              <span className="metaTag" data-tone={isAuto ? "ok" : undefined}>
                {isAuto ? "Fallback Otomatis Aktif" : "Mode Manual"}
              </span>
            </div>

            <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
              Masukkan API key lalu klik Simpan &amp; Deteksi. Sistem langsung mengenali seluruh model teks dan
              gambar yang didukung akun Anda, lalu otomatis berpindah ke model gambar lain bila terkena limit.
            </p>

            <div className="fieldRow">
              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="sel-edit-profile">
                  Provider
                </label>
                <select
                  id="sel-edit-profile"
                  className="select"
                  value={activeProfile.id}
                  onChange={(e) => {
                    setActiveId(e.target.value);
                    setKeyDraft("");
                    setAutoSwitchedHint("");
                    setStatusMsg(null);
                  }}
                >
                  {settings.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({profileModelBadge(p)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="inp-api-key">
                  API Key {savedHint ? `(tersimpan: ${savedHint})` : "(disimpan lokal di browser)"}
                </label>
                <input
                  id="inp-api-key"
                  type="password"
                  className="input mono"
                  value={keyDraft}
                  onChange={(e) => handleKeyInputChange(e.target.value)}
                  placeholder="Tempel API key Gemini, OpenAI, atau Anthropic..."
                />
              </div>
            </div>

            {autoSwitchedHint ? (
              <p style={{ margin: 0, fontSize: 12, color: "var(--accent-text)" }}>{autoSwitchedHint}</p>
            ) : null}

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button type="submit" className="btn btnPrimary btnSm" disabled={detecting}>
                {detecting
                  ? "Mendeteksi model tersedia..."
                  : keyDraft.trim()
                    ? "Simpan & Deteksi Model"
                    : "Segarkan Daftar Model"}
              </button>
              {savedHint ? (
                <button
                  type="button"
                  className="btn btnDanger btnSm"
                  disabled={detecting}
                  onClick={handleClearKey}
                >
                  Hapus Key
                </button>
              ) : null}
            </div>

            {statusMsg ? (
              <div className="alertBox" data-tone={statusMsg.tone} role="status">
                {statusMsg.text}
              </div>
            ) : null}

            {textModels.length > 0 || imageModels.length > 0 ? (
              <div className="discoveredBox">
                <div className="discoveredGroup">
                  <div className="discoveredHead">
                    <span className="fieldLabel">Model Gambar ({imageModels.length})</span>
                    {imageModels.length > 1 ? (
                      <span className="mono" style={{ fontSize: 11, color: "var(--ok)" }}>
                        Urutan fallback otomatis saat limit
                      </span>
                    ) : null}
                  </div>
                  {imageModels.length > 0 ? (
                    <div className="modelChipList">
                      {imageModels.slice(0, 8).map((m, idx) => (
                        <span key={m} className="modelChip mono" data-primary={idx === 0}>
                          <span className="modelChipRank">#{idx + 1}</span> {m}
                        </span>
                      ))}
                      {imageModels.length > 8 ? (
                        <span className="modelChip mono">+{imageModels.length - 8} lainnya</span>
                      ) : null}
                    </div>
                  ) : (
                    <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                      Tidak ada model generate gambar pada API key ini.
                    </p>
                  )}
                </div>

                <div className="discoveredGroup">
                  <div className="discoveredHead">
                    <span className="fieldLabel">Model Teks ({textModels.length})</span>
                    {textModels.length > 1 ? (
                      <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                        Urutan prioritas otomatis
                      </span>
                    ) : null}
                  </div>
                  {textModels.length > 0 ? (
                    <div className="modelChipList">
                      {textModels.slice(0, 8).map((m, idx) => (
                        <span key={m} className="modelChip mono" data-primary={idx === 0}>
                          <span className="modelChipRank">#{idx + 1}</span> {m}
                        </span>
                      ))}
                      {textModels.length > 8 ? (
                        <span className="modelChip mono">+{textModels.length - 8} lainnya</span>
                      ) : null}
                    </div>
                  ) : (
                    <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                      Tidak ada model teks pada API key ini.
                    </p>
                  )}
                </div>
              </div>
            ) : null}

            <details className="advancedDetails">
              <summary className="advancedSummary">Pengaturan Lanjutan (Opsional)</summary>
              <div className="advancedBody">
                <label className="checkRow" htmlFor="chk-auto-model">
                  <input
                    id="chk-auto-model"
                    type="checkbox"
                    checked={isAuto}
                    onChange={(e) => patchProfileById(activeProfile.id, { autoModel: e.target.checked })}
                  />
                  <span>Pilih model terbaik &amp; fallback otomatis dari API key (disarankan)</span>
                </label>

                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="inp-base-url">
                    Base URL Endpoint
                  </label>
                  <input
                    id="inp-base-url"
                    className="input mono"
                    value={activeProfile.baseUrl}
                    onChange={(e) => patchProfileById(activeProfile.id, { baseUrl: e.target.value })}
                  />
                </div>

                {!isAuto ? (
                  <div className="fieldRow">
                    <div className="fieldGroup">
                      <label className="fieldLabel" htmlFor="inp-text-model">
                        Prioritas Model Teks (Opsional)
                      </label>
                      <input
                        id="inp-text-model"
                        className="input mono"
                        value={activeProfile.textModel}
                        onChange={(e) => patchProfileById(activeProfile.id, { textModel: e.target.value })}
                        placeholder="Kosongkan untuk otomatis"
                      />
                    </div>
                    <div className="fieldGroup">
                      <label className="fieldLabel" htmlFor="inp-img-model">
                        Prioritas Model Gambar (Opsional)
                      </label>
                      <input
                        id="inp-img-model"
                        className="input mono"
                        value={activeProfile.imageModel}
                        onChange={(e) => patchProfileById(activeProfile.id, { imageModel: e.target.value })}
                        placeholder="Kosongkan untuk otomatis"
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </details>
          </form>

          {/* Active Provider Selectors */}
          <div className="sectionBox">
            <h3>Provider Aktif di Kanvas</h3>
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
                      {p.name} ({profileModelBadge(p)})
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
                        {p.name} ({profileModelBadge(p)})
                      </option>
                    ))}
                </select>
              </div>
            </div>
          </div>

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
                  <span className="metaTag" data-tone={runtime.supabaseConnected ? "ok" : "warn"}>
                    Supabase: {runtime.supabaseConnected ? "Terhubung" : "Mode Lokal"}
                  </span>
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
