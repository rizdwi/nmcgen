"use client";
import React, { useMemo, useState } from "react";
import type { AspectRatio, ProviderProfile, StoryboardData, StorySegment } from "@/lib/types";
import { matchVisualStylePreset, uid, VISUAL_STYLE_PRESETS } from "@/lib/presets";
import { callAi } from "@/lib/storage";
import {
  auditStoryCoherence,
  buildGenerateScriptPrompt,
  buildReviseScriptPrompt,
  clampTargetPanels,
  extractStorySpineFromScript,
  formatSegmentsToScript,
  parseScriptIntoSegments,
} from "@/lib/storyboard";
import { ArrowRightIcon, CheckIcon, PlusIcon, SparklesIcon, TrashIcon } from "./Icons";

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

const PANEL_COUNT_OPTIONS = [4, 5, 6, 7] as const;

const STRENGTHEN_SPINE_INSTRUCTION =
  "Perkuat benang merah cerita agar menjadi 1 kesatuan cerita utuh 4 babak (Setup & tujuan tokoh jelas → Hambatan/petunjuk → Titik balik bermakna → Resolusi/jawaban akhir yang memuaskan). Hilangkan daftar instruksi kamera teknis ('Wide shot/Close-up') dan tambahkan dialog lisan atau monolog batin singkat yang natural di setiap segmen agar penonton langsung paham alurnya.";

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
  const segments = useMemo<StorySegment[]>(() => {
    if (sb.segments && sb.segments.length > 0) {
      return sb.segments.map((s, idx) => ({
        ...s,
        index: idx + 1,
        targetPanels: clampTargetPanels(s.targetPanels),
      }));
    }
    return parseScriptIntoSegments(sb.scriptText, [], 5);
  }, [sb.segments, sb.scriptText]);

  const [editorMode, setEditorMode] = useState<"segments" | "raw">(() =>
    segments.length > 0 ? "segments" : "raw",
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reviseNote, setReviseNote] = useState("");

  const isBusy = Boolean(busy || externalBusy);
  const selectedPresetId = matchVisualStylePreset(sb.visualStyle);
  const selectedPreset = VISUAL_STYLE_PRESETS.find((p) => p.id === selectedPresetId);
  const wordCount = sb.scriptText.trim() ? sb.scriptText.trim().split(/\s+/).length : 0;
  const totalTargetPanels = segments.reduce((sum, s) => sum + clampTargetPanels(s.targetPanels), 0);
  const coherence = useMemo(
    () => auditStoryCoherence({ scriptText: sb.scriptText, segments, storySpine: sb.storySpine, frames: sb.frames }),
    [sb.scriptText, segments, sb.storySpine, sb.frames],
  );

  const commitSegments = (nextList: StorySegment[]) => {
    const normalized = nextList.map((s, idx) => ({
      ...s,
      index: idx + 1,
      targetPanels: clampTargetPanels(s.targetPanels),
    }));
    onPatchSb({
      segments: normalized,
      scriptText: formatSegmentsToScript(normalized),
      scriptApproved: false,
    });
  };

  const handleUpdateSegment = (segId: string, patch: Partial<StorySegment>) => {
    const next = segments.map((s) => (s.id === segId ? { ...s, ...patch } : s));
    commitSegments(next);
  };

  const handleAddSegment = () => {
    const nextIdx = segments.length + 1;
    const fresh: StorySegment = {
      id: uid(),
      index: nextIdx,
      title: `Segmen ${nextIdx}`,
      locationHint: "",
      scriptContent: "",
      targetPanels: 5,
    };
    commitSegments([...segments, fresh]);
    setEditorMode("segments");
  };

  const handleDeleteSegment = (segId: string) => {
    if (segments.length <= 1) return;
    commitSegments(segments.filter((s) => s.id !== segId));
  };

  const handleRawScriptChange = (value: string) => {
    const { storySpine: parsedSpine, cleanScript } = extractStorySpineFromScript(value);
    const parsed = parseScriptIntoSegments(cleanScript, segments, 5);
    onPatchSb({
      scriptText: value,
      ...(parsedSpine ? { storySpine: parsedSpine } : {}),
      segments: parsed,
      scriptApproved: false,
    });
  };

  const handleGenerateScript = async () => {
    const idea = sb.idea.trim() || projectName.trim();
    if (!idea) {
      setError("Tulis ide cerita terlebih dahulu sebelum generate naskah.");
      return;
    }
    setBusy("Menyusun benang merah & naskah 4 babak sebab–akibat dari ide cerita...");
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
      const { storySpine: extractedSpine, cleanScript } = extractStorySpineFromScript(res.text.trim());
      const parsedSegs = parseScriptIntoSegments(cleanScript, [], 5);
      onPatchSb({
        storySpine: extractedSpine || sb.storySpine || "",
        scriptText: cleanScript,
        segments: parsedSegs,
        scriptApproved: false,
      });
      if (parsedSegs.length > 0) setEditorMode("segments");
      setNotice(
        `Naskah utuh selesai (${parsedSegs.length || 1} segmen${extractedSpine ? " + Benang Merah terkunci" : ""}${res.usedModel ? ` · ${res.usedModel.split("/").pop()}` : ""}). Periksa alur & dialognya, lalu klik ACC Naskah.`,
      );
    } catch (err) {
      setError(`Gagal generate naskah: ${(err as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const handleReviseScript = async (instructionOverride?: string) => {
    if (!sb.scriptText.trim()) {
      setError("Belum ada naskah untuk direvisi.");
      return;
    }
    const instruction = (instructionOverride ?? reviseNote).trim();
    if (!instruction) {
      setError("Tulis instruksi revisi terlebih dahulu (misal: tambah 1 segmen penutup yang hangat).");
      return;
    }
    setBusy(
      instructionOverride
        ? "Memperkuat benang merah, alur sebab–akibat, dan dialog naskah..."
        : "Merevisi naskah per segmen sesuai catatan Anda...",
    );
    setError("");
    setNotice("");
    try {
      const built = buildReviseScriptPrompt({
        projectName: projectName.trim() || "Proyek Storyboard",
        idea: sb.idea,
        storySpine: sb.storySpine,
        currentScript: sb.scriptText,
        instruction,
      });
      const res = await callAi(textProfile, "text", built);
      if (res.discovered) onSyncDiscoveredModels(textProfile.id, res.discovered);
      if (!res.ok || !res.text?.trim()) {
        setError(res.error || "AI gagal merevisi naskah.");
        return;
      }
      const { storySpine: extractedSpine, cleanScript } = extractStorySpineFromScript(res.text.trim());
      const parsedSegs = parseScriptIntoSegments(cleanScript, segments, 5);
      onPatchSb({
        storySpine: extractedSpine || sb.storySpine || "",
        scriptText: cleanScript,
        segments: parsedSegs,
        scriptApproved: false,
      });
      if (parsedSegs.length > 0) setEditorMode("segments");
      if (!instructionOverride) setReviseNote("");
      setNotice(
        `Naskah diperbarui (${parsedSegs.length || 1} segmen${extractedSpine ? " · Benang Merah diperbarui" : ""}).`,
      );
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
          <span className="stepKicker mono">TAHAP 1 DARI 4 · NASKAH PER-SEGMEN</span>
          <h2 className="stepTitle">Ide Cerita &amp; Naskah Per-Segmen</h2>
          <p className="stepSubtitle">
            Naskah dibagi menjadi beberapa <strong>Segmen</strong>, dan tiap segmen akan dipecah menjadi{" "}
            <strong>4–7 panel storyboard berurutan</strong> di Tahap 3 agar alur visual mengalir halus tanpa
            lompat-lompat.
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
              placeholder="Contoh: Subuh di Kampung Asing"
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
              placeholder="Ceritakan ide bebas Anda: genre/suasana, tokoh utama, lokasi, dan perjalanan dari awal sampai akhir..."
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

          {selectedPreset ? <p className="fieldHint">{selectedPreset.summary}</p> : null}

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
            <span>{sb.scriptText.trim() ? "Generate Ulang Naskah Per-Segmen (AI)" : "Generate Naskah Per-Segmen (AI)"}</span>
          </button>
        </section>

        {/* Right column: Segmented Script Editor & ACC Gate */}
        <section className="panelCard scriptEditorCard" aria-label="Editor naskah per segmen">
          <div className="panelHead">
            <div className="metaInline">
              <h3>2. Naskah Per-Segmen</h3>
              {segments.length > 0 ? (
                <span className="metaTag mono">
                  {segments.length} segmen · ~{totalTargetPanels} panel
                </span>
              ) : null}
              <span className="metaTag mono">{wordCount} kata</span>
            </div>

            <div className="segToggle" role="tablist" aria-label="Tampilan editor naskah">
              <button
                type="button"
                role="tab"
                className="segBtn"
                aria-selected={editorMode === "segments"}
                onClick={() => setEditorMode("segments")}
              >
                Per Segmen ({segments.length})
              </button>
              <button
                type="button"
                role="tab"
                className="segBtn"
                aria-selected={editorMode === "raw"}
                onClick={() => setEditorMode("raw")}
              >
                Teks Utuh
              </button>
            </div>
          </div>

          {/* Unified Story Spine (Benang Merah) carried cleanly into every Segment & Storyboard Panel */}
          {sb.scriptText.trim() || sb.storySpine?.trim() ? (
            <div className="fieldGroup" style={{ marginBottom: 4 }}>
              <label className="fieldLabel" htmlFor="sb-story-spine">
                Benang Merah Cerita (1 Kesatuan Alur: Tokoh &amp; Tujuan → Konflik → Titik Balik → Resolusi)
              </label>
              <input
                id="sb-story-spine"
                className="input inputSm"
                value={sb.storySpine || ""}
                disabled={isBusy}
                onChange={(e) => onPatchSb({ storySpine: e.target.value })}
                placeholder="Ringkasan 1 kalimat utuh agar seluruh segmen & panel tidak melenceng atau lompat-lompat..."
              />
            </div>
          ) : null}

          {sb.scriptText.trim() && !coherence.ok ? (
            <div
              className="alertBox"
              role="status"
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <div style={{ flex: "1 1 240px" }}>
                <strong>Cek Benang Merah:</strong> {coherence.warnings[0]}
                {coherence.warnings.length > 1 ? ` (+${coherence.warnings.length - 1} catatan lain)` : ""}
              </div>
              <button
                type="button"
                className="btn btnSm"
                disabled={isBusy}
                onClick={() => void handleReviseScript(STRENGTHEN_SPINE_INSTRUCTION)}
                title="Revisi naskah otomatis agar punya benang merah 4 babak sebab–akibat, dialog bermakna, dan bebas shot-list hampa"
              >
                <SparklesIcon size={13} />
                <span>Perkuat Benang Merah &amp; Alur (AI)</span>
              </button>
            </div>
          ) : null}

          {editorMode === "segments" ? (
            segments.length === 0 ? (
              <div className="segmentEmptyBox">
                <p>
                  Belum ada segmen naskah. Klik <strong>Generate Naskah Per-Segmen (AI)</strong> di sebelah kiri, atau
                  buat segmen manual untuk mulai menulis.
                </p>
                <div className="actionGroup" style={{ justifyContent: "center" }}>
                  <button
                    type="button"
                    className="btn btnSm"
                    disabled={isBusy}
                    onClick={handleAddSegment}
                  >
                    <PlusIcon size={14} />
                    <span>Buat Segmen 1 Manual</span>
                  </button>
                  <button
                    type="button"
                    className="btn btnGhost btnSm"
                    disabled={isBusy}
                    onClick={() => setEditorMode("raw")}
                  >
                    Tempel Teks Utuh
                  </button>
                </div>
              </div>
            ) : (
              <div className="scriptSegmentList">
                {segments.map((seg) => (
                  <article key={seg.id} className="scriptSegmentCard">
                    <div className="scriptSegmentHead">
                      <span className="frameIndexPill mono">
                        SEGMEN {String(seg.index).padStart(2, "0")}
                      </span>

                      <div className="panelCountPicker" role="group" aria-label={`Target panel Segmen ${seg.index}`}>
                        <span className="panelCountLabel">Target Panel:</span>
                        {PANEL_COUNT_OPTIONS.map((cnt) => (
                          <button
                            key={cnt}
                            type="button"
                            className="panelCountBtn mono"
                            data-active={seg.targetPanels === cnt}
                            disabled={isBusy}
                            onClick={() => handleUpdateSegment(seg.id, { targetPanels: cnt })}
                            title={`Pecah Segmen ${seg.index} menjadi ${cnt} panel storyboard berurutan`}
                          >
                            {cnt}
                          </button>
                        ))}
                      </div>

                      {segments.length > 1 ? (
                        <button
                          type="button"
                          className="btn btnDanger btnSm btnIcon"
                          disabled={isBusy}
                          title={`Hapus Segmen ${seg.index}`}
                          aria-label={`Hapus Segmen ${seg.index}`}
                          onClick={() => handleDeleteSegment(seg.id)}
                        >
                          <TrashIcon size={13} />
                        </button>
                      ) : null}
                    </div>

                    <div className="fieldRow">
                      <input
                        aria-label={`Judul Segmen ${seg.index}`}
                        className="input inputSm"
                        value={seg.title}
                        disabled={isBusy}
                        onChange={(e) => handleUpdateSegment(seg.id, { title: e.target.value })}
                        placeholder={`Judul Segmen ${seg.index} (mis. Tiba di Pelabuhan)`}
                      />
                      <input
                        aria-label={`Lokasi dan waktu Segmen ${seg.index}`}
                        className="input inputSm"
                        value={seg.locationHint}
                        disabled={isBusy}
                        onChange={(e) => handleUpdateSegment(seg.id, { locationHint: e.target.value })}
                        placeholder="Lokasi / Waktu (mis. EXT. DERMAGA KAMPUNG - SUBUH)"
                      />
                    </div>

                    <textarea
                      aria-label={`Isi naskah Segmen ${seg.index}`}
                      className="textarea scriptSegTextarea"
                      value={seg.scriptContent}
                      disabled={isBusy}
                      onChange={(e) => handleUpdateSegment(seg.id, { scriptContent: e.target.value })}
                      placeholder="Tulis rentetan aksi halus dalam segmen ini (4–6 momen berurutan agar mulus saat dijadikan panel storyboard)..."
                    />
                  </article>
                ))}

                <button
                  type="button"
                  className="btn btnSm addSegmentBtn"
                  disabled={isBusy}
                  onClick={handleAddSegment}
                >
                  <PlusIcon size={14} />
                  <span>Tambah Segmen {segments.length + 1}</span>
                </button>
              </div>
            )
          ) : (
            <>
              <p className="fieldHint">
                Gunakan header <code className="mono">SEGMEN 1 — Judul | EXT. LOKASI - WAKTU</code> (atau pisahkan
                dengan baris kosong) agar otomatis terbagi menjadi segmen.
              </p>
              <textarea
                id="sb-script-text"
                aria-label="Isi naskah cerita utuh"
                className="textarea scriptTextarea"
                value={sb.scriptText}
                disabled={isBusy}
                onChange={(e) => handleRawScriptChange(e.target.value)}
                placeholder="Klik 'Generate Naskah Per-Segmen (AI)' di sebelah kiri, atau tempel/tulis langsung naskah cerita Anda di sini..."
              />
            </>
          )}

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
                placeholder="Revisi cepat via AI (mis. perjelas urutan gerak di Segmen 2, tambah detail pakaian)..."
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
              Setiap segmen siap dipecah menjadi 4–7 panel storyboard berurutan setelah Aset &amp; Karakter di-ACC.
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
                    Ekstrak Ulang Aset
                  </button>
                  <button
                    type="button"
                    className="btn btnPrimary"
                    disabled={isBusy || !sb.scriptText.trim()}
                    onClick={() => {
                      onPatchSb({
                        segments,
                        scriptText: sb.scriptText.trim() || formatSegmentsToScript(segments),
                        scriptApproved: true,
                        step: "assets",
                      });
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
