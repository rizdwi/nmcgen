"use client";
import React, { useState } from "react";
import type { AspectRatio, ProviderProfile, StoryboardData } from "@/lib/types";
import { matchVisualStylePreset, VISUAL_STYLE_PRESETS } from "@/lib/presets";
import { callAi } from "@/lib/storage";
import { buildGenerateScriptPrompt, buildReviseScriptPrompt } from "@/lib/storyboard";
import { ArrowRightIcon, CheckIcon, SparklesIcon } from "./Icons";

interface ScriptStepProps {
  projectName: string;
  sb: StoryboardData;
  textProfile: ProviderProfile;
  onRenameProject: (name: string) => void;
  onPatchSb: (patch: Partial<StoryboardData>) => void;
  onSyncDiscoveredModels: (
    profileId: string,
    discovered: { textModels: string[]; imageModels: string[]; fetchedAt: number },
  ) => void;
  onApproveAndExtractAssets: () => Promise<void>;
  onGoToAssets: () => void;
  onOpenSettings: () => void;
  externalBusy: string;
}

export default function ScriptStep({
  projectName,
  sb,
  textProfile,
  onRenameProject,
  onPatchSb,
  onSyncDiscoveredModels,
  onApproveAndExtractAssets,
  onGoToAssets,
  onOpenSettings,
  externalBusy,
}: ScriptStepProps) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reviseNote, setReviseNote] = useState("");

  const isBusy = Boolean(busy || externalBusy);
  const selectedPresetId = matchVisualStylePreset(sb.visualStyle);
  const selectedPreset = VISUAL_STYLE_PRESETS.find((p) => p.id === selectedPresetId);
  const wordCount = sb.scriptText.trim() ? sb.scriptText.trim().split(/\s+/).length : 0;
  const sceneCount = (sb.scriptText.match(/(?:^|\n)\s*ADEGAN\s+\d+/gi) ?? []).length;

  const handleGenerateScript = async () => {
    const idea = sb.idea.trim() || projectName.trim();
    if (!idea) {
      setError("Tulis ide cerita terlebih dahulu sebelum generate naskah.");
      return;
    }
    setBusy("Menyusun naskah lengkap dari ide cerita...");
    setError("");
    setNotice("");
    try {
      const built = buildGenerateScriptPrompt({
        projectName: projectName.trim() || "Proyek Storyboard",
        idea,
        visualStyle: sb.visualStyle,
        aspectRatio: sb.aspectRatio,
      });
      const res = await callAi(textProfile, "text", built);
      if (res.discovered) onSyncDiscoveredModels(textProfile.id, res.discovered);
      if (!res.ok || !res.text?.trim()) {
        setError(res.error || "AI gagal membuat naskah. Periksa koneksi Cloudflare Workers AI / Pengaturan.");
        return;
      }
      onPatchSb({
        scriptText: res.text.trim(),
        scriptApproved: false,
      });
      setNotice(
        `Naskah selesai disusun${res.usedModel ? ` (${res.usedModel.split("/").pop()})` : ""}. Silakan baca & edit jika perlu, lalu klik ACC Naskah.`,
      );
    } catch (err) {
      setError(`Gagal generate naskah: ${(err as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const handleReviseScript = async () => {
    if (!sb.scriptText.trim()) {
      setError("Belum ada naskah untuk direvisi.");
      return;
    }
    if (!reviseNote.trim()) {
      setError("Tulis instruksi revisi terlebih dahulu (misal: ganti endingnya jadi lebih hangat).");
      return;
    }
    setBusy("Merevisi naskah sesuai catatan Anda...");
    setError("");
    setNotice("");
    try {
      const built = buildReviseScriptPrompt({
        projectName: projectName.trim() || "Proyek Storyboard",
        idea: sb.idea,
        currentScript: sb.scriptText,
        instruction: reviseNote,
      });
      const res = await callAi(textProfile, "text", built);
      if (res.discovered) onSyncDiscoveredModels(textProfile.id, res.discovered);
      if (!res.ok || !res.text?.trim()) {
        setError(res.error || "AI gagal merevisi naskah.");
        return;
      }
      onPatchSb({
        scriptText: res.text.trim(),
        scriptApproved: false,
      });
      setReviseNote("");
      setNotice("Naskah berhasil diperbarui sesuai revisi Anda.");
    } catch (err) {
      setError(`Gagal merevisi naskah: ${(err as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="stepContainer">
      <div className="stepIntroRow">
        <div>
          <span className="stepKicker mono">TAHAP 1 DARI 3</span>
          <h2 className="stepTitle">Ide Cerita &amp; Naskah</h2>
          <p className="stepSubtitle">
            Tulis ide singkat, generate naskah lengkapnya, lalu periksa sampai alurnya pas. Semua karakter dan lokasi di
            tahap berikutnya akan diambil ketat dari naskah ini.
          </p>
        </div>
        {sb.scriptApproved ? (
          <span className="statusBadge" data-tone="ok">
            <CheckIcon size={13} />
            <span>Naskah ACC</span>
          </span>
        ) : null}
      </div>

      {busy || externalBusy ? (
        <div className="alertBox" role="status">
          {busy || externalBusy}
        </div>
      ) : null}
      {error ? (
        <div className="alertBox" data-tone="error" role="alert">
          <span>{error}</span>{" "}
          <button type="button" className="btn btnSm" style={{ marginLeft: 8 }} onClick={onOpenSettings}>
            Pengaturan AI
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="alertBox" data-tone="ok" role="status">
          {notice}
        </div>
      ) : null}

      <div className="scriptLayout">
        {/* Left column: Story Setup */}
        <section className="panelCard" aria-label="Pengaturan ide dan gaya visual">
          <div className="panelHead">
            <h3>1. Bahan Cerita &amp; Gaya</h3>
          </div>

          <div className="fieldGroup">
            <label className="fieldLabel" htmlFor="sb-project-name">
              Judul Proyek
            </label>
            <input
              id="sb-project-name"
              className="input"
              value={projectName}
              disabled={isBusy}
              onChange={(e) => onRenameProject(e.target.value)}
              placeholder="Contoh: Kopi Terakhir di Stasiun"
            />
          </div>

          <div className="fieldGroup">
            <label className="fieldLabel" htmlFor="sb-idea">
              Ide Cerita / Premis
            </label>
            <textarea
              id="sb-idea"
              className="textarea"
              style={{ minHeight: 118 }}
              value={sb.idea}
              disabled={isBusy}
              onChange={(e) => onPatchSb({ idea: e.target.value })}
              placeholder="Ceritakan ide bebas Anda: siapa tokohnya, di mana kejadiannya, dan apa yang terjadi dari awal sampai akhir..."
            />
          </div>

          <div className="fieldRow">
            <div className="fieldGroup">
              <label className="fieldLabel" htmlFor="sb-ratio">
                Rasio Frame
              </label>
              <select
                id="sb-ratio"
                className="select"
                value={sb.aspectRatio}
                disabled={isBusy}
                onChange={(e) => onPatchSb({ aspectRatio: e.target.value as AspectRatio })}
              >
                <option value="16:9">16:9 Landscape</option>
                <option value="9:16">9:16 Vertikal</option>
              </select>
            </div>

            <div className="fieldGroup">
              <label className="fieldLabel" htmlFor="sb-style-preset">
                Gaya Visual
              </label>
              <select
                id="sb-style-preset"
                className="select"
                value={selectedPresetId}
                disabled={isBusy}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "custom") return;
                  const preset = VISUAL_STYLE_PRESETS.find((p) => p.id === val);
                  if (preset) onPatchSb({ visualStyle: preset.prompt });
                }}
              >
                {VISUAL_STYLE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
                <option value="custom">Kustom (Tulis Sendiri)</option>
              </select>
            </div>
          </div>

          {selectedPreset ? (
            <p className="fieldHint">{selectedPreset.summary}</p>
          ) : null}

          <details className="subtleDetails">
            <summary>Detail Prompt Gaya Visual (EN)</summary>
            <div className="subtleDetailsBody">
              <input
                aria-label="Detail Prompt Gaya Visual"
                className="input"
                value={sb.visualStyle}
                disabled={isBusy}
                onChange={(e) => onPatchSb({ visualStyle: e.target.value })}
                placeholder="Gaya visual dalam bahasa Inggris..."
              />
            </div>
          </details>

          <button
            type="button"
            className="btn btnPrimary btnLg"
            disabled={isBusy}
            onClick={() => void handleGenerateScript()}
          >
            <SparklesIcon size={15} />
            <span>{sb.scriptText.trim() ? "Generate Ulang Naskah (AI)" : "Generate Naskah dari Ide (AI)"}</span>
          </button>
        </section>

        {/* Right column: Editable Script & ACC Gate */}
        <section className="panelCard scriptEditorCard" aria-label="Editor naskah lengkap">
          <div className="panelHead">
            <h3>2. Naskah Lengkap (Bisa Diedit Langsung)</h3>
            <div className="metaInline">
              {sceneCount > 0 ? <span className="metaTag mono">{sceneCount} adegan</span> : null}
              <span className="metaTag mono">{wordCount} kata</span>
            </div>
          </div>

          <textarea
            id="sb-script-text"
            aria-label="Isi naskah cerita"
            className="textarea scriptTextarea"
            value={sb.scriptText}
            disabled={isBusy}
            onChange={(e) => onPatchSb({ scriptText: e.target.value, scriptApproved: false })}
            placeholder="Klik 'Generate Naskah dari Ide (AI)' di sebelah kiri, atau tempel/tulis langsung naskah cerita Anda di sini..."
          />

          {sb.scriptText.trim() ? (
            <div className="quickReviseRow">
              <input
                aria-label="Instruksi revisi naskah"
                className="input"
                value={reviseNote}
                disabled={isBusy}
                onChange={(e) => setReviseNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleReviseScript();
                  }
                }}
                placeholder="Revisi cepat via AI (mis. perjelas baju tokoh, ubah lokasi jadi kafe sore)..."
              />
              <button
                type="button"
                className="btn"
                disabled={isBusy || !reviseNote.trim()}
                onClick={() => void handleReviseScript()}
              >
                Revisi
              </button>
            </div>
          ) : null}

          <div className="stepFooterBar">
            <p className="fieldHint" style={{ margin: 0 }}>
              Pastikan tokoh, pakaian, dan tempat di naskah sudah sesuai sebelum mengekstrak aset.
            </p>
            <div className="actionGroup">
              {sb.assets.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="btn"
                    disabled={isBusy || !sb.scriptText.trim()}
                    onClick={() => void onApproveAndExtractAssets()}
                  >
                    Ekstrak Ulang Aset dari Naskah
                  </button>
                  <button
                    type="button"
                    className="btn btnPrimary"
                    disabled={isBusy || !sb.scriptText.trim()}
                    onClick={() => {
                      onPatchSb({ scriptApproved: true, step: "assets" });
                      onGoToAssets();
                    }}
                  >
                    <span>Lanjut ke Aset ({sb.assets.length})</span>
                    <ArrowRightIcon size={15} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btnPrimary btnLg"
                  disabled={isBusy || !sb.scriptText.trim()}
                  onClick={() => void onApproveAndExtractAssets()}
                >
                  <CheckIcon size={15} />
                  <span>ACC Naskah &amp; Ekstrak Aset</span>
                  <ArrowRightIcon size={15} />
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
