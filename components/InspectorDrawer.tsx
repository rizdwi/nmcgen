"use client";
import React, { useRef, useState } from "react";
import type {
  AspectRatio,
  AssemblyNodeData,
  AssetCategory,
  AssetNodeData,
  AudioNodeData,
  AudioRole,
  CameraAngle,
  CameraMotion,
  CanvasNode,
  ExportNodeData,
  NmcProject,
  PlatformPreset,
  ProviderProfile,
  RuntimeStatus,
  ScriptNodeData,
  SegmentNodeData,
  ShotSize,
} from "@/lib/types";
import { canConnect, NODE_META, uid } from "@/lib/presets";
import { callAi, fileToDataUrl } from "@/lib/storage";
import {
  buildSrt,
  composeSegmentPrompt,
  estimateDialogueSeconds,
  getBoundAssets,
  getOrderedSegments,
  getPrimaryScript,
} from "@/lib/validator";
import { CloseIcon } from "./Icons";

interface InspectorDrawerProps {
  project: NmcProject;
  node: CanvasNode;
  textProfile: ProviderProfile;
  imageProfile: ProviderProfile;
  runtime: RuntimeStatus | null;
  onUpdateNode: (nodeId: string, updater: (n: CanvasNode) => CanvasNode) => void;
  onDeleteNode: (nodeId: string) => void;
  onConnect: (sourceId: string, targetId: string) => void;
  onDeleteEdge: (edgeId: string) => void;
  onSyncBeatsToSegments: (scriptNodeId: string) => void;
  onSyncDiscoveredModels: (
    profileId: string,
    discovered: { textModels: string[]; imageModels: string[]; fetchedAt: number },
  ) => void;
  onOpenPipeline: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

const SHOT_SIZES: ShotSize[] = ["WS", "MS", "MCU", "CU", "ECU"];
const ANGLES: CameraAngle[] = ["Front", "Side 90", "Rear 3/4", "High", "Low"];
const MOTIONS: CameraMotion[] = ["Push-In", "Pull-Out", "Static", "Pan Right", "Pan Left"];

export default function InspectorDrawer({
  project,
  node,
  textProfile,
  imageProfile,
  runtime,
  onUpdateNode,
  onDeleteNode,
  onConnect,
  onDeleteEdge,
  onSyncBeatsToSegments,
  onSyncDiscoveredModels,
  onOpenPipeline,
  onOpenSettings,
  onClose,
}: InspectorDrawerProps) {
  const [busyMsg, setBusyMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [connectTargetId, setConnectTargetId] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const meta = NODE_META[node.kind];
  const incomingEdges = project.edges.filter((e) => e.target === node.id);
  const outgoingEdges = project.edges.filter((e) => e.source === node.id);
  const nodeMap = new Map(project.nodes.map((n) => [n.id, n]));

  const validTargets = project.nodes.filter(
    (candidate) =>
      candidate.id !== node.id &&
      canConnect(node.kind, candidate.kind) &&
      !outgoingEdges.some((e) => e.target === candidate.id),
  );

  const patchData = <T extends CanvasNode["data"]>(patch: Partial<T>) => {
    onUpdateNode(node.id, (n) => ({ ...n, data: { ...n.data, ...patch } as CanvasNode["data"] }));
  };

  const handleAiBreakdownBeats = async (d: ScriptNodeData) => {
    if (!d.premise.trim() && !d.scriptText.trim()) {
      setErrMsg("Isi premis atau naskah terlebih dahulu sebelum memecah beat.");
      return;
    }
    setBusyMsg("Memecah naskah ke daftar beat via AI...");
    setErrMsg("");
    setOkMsg("");
    try {
      const prompt = [
        "Pecah premis/naskah berikut menjadi daftar beat berurutan dalam format JSON array murni (tanpa markdown codefence).",
        'Format tiap objek: {"code":"E01","durationSec":4,"summary":"aksi visual singkat","dialogue":"dialog atau string kosong"}.',
        `Rasio: ${d.aspectRatio}, batas durasi per segmen: ${d.maxSegmentSec} detik.`,
        `Premis: ${d.premise}`,
        `Naskah:\n${d.scriptText}`,
      ].join("\n");
      const res = await callAi(textProfile, "text", {
        system: "Kamu adalah sutradara drama pendek. Balas HANYA dengan JSON array valid.",
        prompt,
      });
      if (res.discovered) {
        onSyncDiscoveredModels(textProfile.id, res.discovered);
      }
      if (!res.ok || !res.text) {
        setErrMsg(res.error || "Provider AI tidak mengembalikan teks. Cek API key di Pengaturan.");
        return;
      }
      const match = res.text.match(/\[[\s\S]*\]/);
      if (!match) {
        setErrMsg("Respons AI tidak berbentuk JSON array beat. Coba ulang atau edit beat secara manual.");
        return;
      }
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        setErrMsg("Daftar beat dari AI kosong.");
        return;
      }
      const beats = parsed.map((item: Record<string, unknown>, idx: number) => ({
        id: uid(),
        code: String(item.code || `E${String(idx + 1).padStart(2, "0")}`),
        durationSec: Math.max(1, Math.min(30, Number(item.durationSec) || 4)),
        summary: String(item.summary || ""),
        dialogue: String(item.dialogue || ""),
      }));
      patchData<ScriptNodeData>({ beats });
      const modelNote = res.usedModel ? ` via ${res.usedModel}` : "";
      const fbNote = res.fallbackNotes?.length ? ` (fallback dari: ${res.fallbackNotes.join(", ")})` : "";
      setOkMsg(`${beats.length} beat berhasil disusun${modelNote}${fbNote}. Klik "Buat Segmen dari Beat" untuk menerapkannya.`);
    } catch (err) {
      setErrMsg(`Gagal memproses beat: ${(err as Error).message}`);
    } finally {
      setBusyMsg("");
    }
  };

  const handleGenerateAssetImage = async (d: AssetNodeData) => {
    if (!d.lockPrompt.trim()) {
      setErrMsg("Isi deskripsi Continuity Lock terlebih dahulu agar gambar aset akurat.");
      return;
    }
    const script = getPrimaryScript(project);
    setBusyMsg(`Membuat gambar referensi ${d.tag} via ${imageProfile.name}...`);
    setErrMsg("");
    setOkMsg("");
    try {
      const template =
        d.category === "character"
          ? `4-view character turnaround reference sheet on plain neutral studio background: head close-up, full-body front, 90-degree side profile, full-body back. No text, no watermark. Style: ${script?.visualStyle || "realistic film"}. Subject: ${d.lockPrompt}`
          : d.category === "location"
            ? `Master spatial view of an empty location with NO people and NO silhouettes. Clear foreground, midground, background, no text. Style: ${script?.visualStyle || "realistic film"}. Location: ${d.lockPrompt}`
            : `2x2 prop turnaround sheet (front, side, back, detail) on clean studio background, no hands, no people, no text. Style: ${script?.visualStyle || "realistic film"}. Prop: ${d.lockPrompt}`;

      const res = await callAi(imageProfile, "image", {
        prompt: template,
        aspectRatio: "16:9",
      });
      if (res.discovered) {
        onSyncDiscoveredModels(imageProfile.id, res.discovered);
      }
      if (!res.ok || !res.image) {
        setErrMsg(res.error || "Gagal membuat gambar aset. Periksa API key gambar di Pengaturan.");
        return;
      }
      patchData<AssetNodeData>({
        imageDataUrl: res.image,
        imageName: `${d.tag.replace(/[^a-zA-Z0-9_-]/g, "") || "asset"}.png`,
      });
      const modelNote = res.usedModel ? ` via ${res.usedModel}` : "";
      const fbNote = res.fallbackNotes?.length ? ` (otomatis beralih dari: ${res.fallbackNotes.join(", ")})` : "";
      setOkMsg(`Gambar referensi aset berhasil dibuat${modelNote}${fbNote} dan dikunci di node ini.`);
    } catch (err) {
      setErrMsg(`Gagal membuat gambar aset: ${(err as Error).message}`);
    } finally {
      setBusyMsg("");
    }
  };

  const handleGenerateSegmentFrame = async (d: SegmentNodeData) => {
    const prompt = composeSegmentPrompt(project, node);
    const script = getPrimaryScript(project);
    const boundAssets = getBoundAssets(project, node.id);
    const refImages = boundAssets
      .map((a) => (a.data as AssetNodeData).imageDataUrl)
      .filter((x): x is string => Boolean(x));

    setBusyMsg(`Membuat frame kandidat ${d.code} via ${imageProfile.name}...`);
    setErrMsg("");
    setOkMsg("");
    try {
      const res = await callAi(imageProfile, "image", {
        prompt,
        aspectRatio: script?.aspectRatio ?? "16:9",
        referenceImages: refImages,
      });
      if (res.discovered) {
        onSyncDiscoveredModels(imageProfile.id, res.discovered);
      }
      if (!res.ok || !res.image) {
        setErrMsg(res.error || "Gagal membuat frame segmen. Periksa API key di Pengaturan.");
        return;
      }
      const candId = uid();
      patchData<SegmentNodeData>({
        candidates: [
          ...d.candidates,
          {
            id: candId,
            kind: "image",
            label: res.usedModel ? `#${d.candidates.length + 1} (${res.usedModel.slice(0, 18)})` : `Kandidat #${d.candidates.length + 1}`,
            dataUrl: res.image,
            createdAt: Date.now(),
          },
        ],
        adoptedId: d.adoptedId || candId,
      });
      const modelNote = res.usedModel ? ` via ${res.usedModel}` : "";
      const fbNote = res.fallbackNotes?.length ? ` (otomatis beralih dari: ${res.fallbackNotes.join(", ")})` : "";
      setOkMsg(`Frame kandidat ditambahkan${modelNote}${fbNote}.`);
    } catch (err) {
      setErrMsg(`Gagal membuat frame: ${(err as Error).message}`);
    } finally {
      setBusyMsg("");
    }
  };

  const handleUploadAssetFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      patchData<AssetNodeData>({ imageDataUrl: dataUrl, imageName: file.name });
      setOkMsg(`Gambar "${file.name}" dipasang sebagai referensi aset.`);
      setErrMsg("");
    } catch (err) {
      setErrMsg((err as Error).message);
    } finally {
      e.target.value = "";
    }
  };

  const handleUploadSegmentMedia = async (
    e: React.ChangeEvent<HTMLInputElement>,
    d: SegmentNodeData,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      const kind: "image" | "video" = file.type.startsWith("video/") ? "video" : "image";
      const candId = uid();
      patchData<SegmentNodeData>({
        candidates: [
          ...d.candidates,
          {
            id: candId,
            kind,
            label: file.name.slice(0, 24),
            dataUrl,
            createdAt: Date.now(),
          },
        ],
        adoptedId: candId,
      });
      setOkMsg(`Media "${file.name}" diunggah dan langsung diadopsi.`);
      setErrMsg("");
    } catch (err) {
      setErrMsg((err as Error).message);
    } finally {
      e.target.value = "";
    }
  };

  const handleUploadAudioFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      patchData<AudioNodeData>({
        sourceMode: "upload",
        audioDataUrl: dataUrl,
        fileName: file.name,
      });
      setOkMsg(`Audio "${file.name}" berhasil dipasang.`);
      setErrMsg("");
    } catch (err) {
      setErrMsg((err as Error).message);
    } finally {
      e.target.value = "";
    }
  };

  return (
    <aside className="inspectorPanel" aria-label={`Inspector ${node.title}`}>
      <div className="inspectorHead">
        <div style={{ minWidth: 0 }}>
          <div className="nodeStageTag">{meta.stage}</div>
          <h2>{meta.label}</h2>
        </div>
        <button type="button" className="btn btnGhost btnIcon" aria-label="Tutup inspector" onClick={onClose}>
          <CloseIcon size={16} />
        </button>
      </div>

      <div className="inspectorScroll">
        <div className="fieldGroup">
          <label className="fieldLabel" htmlFor="node-title-inp">
            Judul Node
          </label>
          <input
            id="node-title-inp"
            className="input"
            value={node.title}
            onChange={(e) => onUpdateNode(node.id, (n) => ({ ...n, title: e.target.value }))}
          />
        </div>

        {busyMsg ? (
          <div className="alertBox" role="status">
            {busyMsg}
          </div>
        ) : null}
        {errMsg ? (
          <div className="alertBox" data-tone="error" role="alert">
            {errMsg}{" "}
            <button
              type="button"
              className="btn btnSm"
              style={{ marginTop: 6 }}
              onClick={onOpenSettings}
            >
              Buka Pengaturan AI
            </button>
          </div>
        ) : null}
        {okMsg ? (
          <div className="alertBox" data-tone="ok" role="status">
            {okMsg}
          </div>
        ) : null}

        {/* SCRIPT NODE */}
        {node.data.kind === "script" ? (() => {
          const d = node.data as ScriptNodeData;
          return (
            <>
              <div className="fieldRow">
                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="scr-aspect">
                    Rasio Video
                  </label>
                  <select
                    id="scr-aspect"
                    className="select"
                    value={d.aspectRatio}
                    onChange={(e) => patchData<ScriptNodeData>({ aspectRatio: e.target.value as AspectRatio })}
                  >
                    <option value="16:9">16:9 Landscape (1280×720)</option>
                    <option value="9:16">9:16 Vertikal (1080×1920)</option>
                  </select>
                </div>
                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="scr-maxseg">
                    Batas Segmen (dtk)
                  </label>
                  <select
                    id="scr-maxseg"
                    className="select"
                    value={d.maxSegmentSec}
                    onChange={(e) => patchData<ScriptNodeData>({ maxSegmentSec: Number(e.target.value) })}
                  >
                    <option value={15}>15 detik (Seedance 2.0 / Omni)</option>
                    <option value={30}>30 detik (Seedance 2.5)</option>
                  </select>
                </div>
              </div>

              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="scr-style">
                  Gaya Visual Proyek
                </label>
                <input
                  id="scr-style"
                  className="input"
                  value={d.visualStyle}
                  onChange={(e) => patchData<ScriptNodeData>({ visualStyle: e.target.value })}
                  placeholder="Contoh: Film drama realistis, pencahayaan hangat"
                />
              </div>

              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="scr-premise">
                  Ide Singkat / Premis
                </label>
                <textarea
                  id="scr-premise"
                  className="textarea"
                  value={d.premise}
                  onChange={(e) => patchData<ScriptNodeData>({ premise: e.target.value })}
                  placeholder="Tulis premis cerita dalam 1-2 kalimat..."
                />
              </div>

              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="scr-text">
                  Naskah Adegan
                </label>
                <textarea
                  id="scr-text"
                  className="textarea"
                  style={{ minHeight: 120 }}
                  value={d.scriptText}
                  onChange={(e) => patchData<ScriptNodeData>({ scriptText: e.target.value })}
                  placeholder="Tulis kejadian visual & dialog..."
                />
              </div>

              <div className="sectionBox">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                  <h3>Daftar Beat ({d.beats.length})</h3>
                  <button
                    type="button"
                    className="btn btnSm"
                    onClick={() =>
                      patchData<ScriptNodeData>({
                        beats: [
                          ...d.beats,
                          {
                            id: uid(),
                            code: `E${String(d.beats.length + 1).padStart(2, "0")}`,
                            durationSec: 4,
                            summary: "",
                            dialogue: "",
                          },
                        ],
                      })
                    }
                  >
                    + Beat
                  </button>
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <button
                    type="button"
                    className="btn btnSm"
                    disabled={Boolean(busyMsg)}
                    onClick={() => handleAiBreakdownBeats(d)}
                  >
                    Pecah Beat via AI
                  </button>
                  <button
                    type="button"
                    className="btn btnPrimary btnSm"
                    disabled={d.beats.length === 0}
                    onClick={() => {
                      onSyncBeatsToSegments(node.id);
                      setOkMsg("Segmen baru dibuat di kanvas dari daftar beat.");
                    }}
                  >
                    Buat Segmen dari Beat
                  </button>
                </div>

                {d.beats.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                    Belum ada beat. Tambah manual atau pakai Pecah Beat via AI.
                  </p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {d.beats.map((b, idx) => (
                      <div
                        key={b.id}
                        style={{
                          padding: 8,
                          borderRadius: "var(--radius-sm)",
                          background: "var(--bg)",
                          border: "1px solid var(--border)",
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span className="metaTag mono">{b.code}</span>
                          <input
                            type="number"
                            min={1}
                            max={30}
                            aria-label={`Durasi ${b.code}`}
                            className="input mono"
                            style={{ width: 70, minHeight: 30, padding: "4px 6px" }}
                            value={b.durationSec}
                            onChange={(e) => {
                              const next = [...d.beats];
                              next[idx] = { ...b, durationSec: Math.max(1, Number(e.target.value) || 1) };
                              patchData<ScriptNodeData>({ beats: next });
                            }}
                          />
                          <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>dtk</span>
                          <button
                            type="button"
                            className="btn btnGhost btnSm"
                            style={{ marginLeft: "auto" }}
                            onClick={() =>
                              patchData<ScriptNodeData>({ beats: d.beats.filter((x) => x.id !== b.id) })
                            }
                          >
                            Hapus
                          </button>
                        </div>
                        <input
                          className="input"
                          style={{ minHeight: 32, padding: "4px 8px" }}
                          aria-label={`Ringkasan ${b.code}`}
                          value={b.summary}
                          placeholder="Aksi visual..."
                          onChange={(e) => {
                            const next = [...d.beats];
                            next[idx] = { ...b, summary: e.target.value };
                            patchData<ScriptNodeData>({ beats: next });
                          }}
                        />
                        <input
                          className="input"
                          style={{ minHeight: 32, padding: "4px 8px" }}
                          aria-label={`Dialog ${b.code}`}
                          value={b.dialogue}
                          placeholder="Dialog (kosongkan jika tanpa suara)"
                          onChange={(e) => {
                            const next = [...d.beats];
                            next[idx] = { ...b, dialogue: e.target.value };
                            patchData<ScriptNodeData>({ beats: next });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          );
        })() : null}

        {/* ASSET NODE */}
        {node.data.kind === "asset" ? (() => {
          const d = node.data as AssetNodeData;
          return (
            <>
              <div className="fieldRow">
                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="ast-tag">
                    Tag Referensi
                  </label>
                  <input
                    id="ast-tag"
                    className="input mono"
                    value={d.tag}
                    onChange={(e) => patchData<AssetNodeData>({ tag: e.target.value })}
                    placeholder="@NamaAset"
                  />
                </div>
                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="ast-cat">
                    Kategori
                  </label>
                  <select
                    id="ast-cat"
                    className="select"
                    value={d.category}
                    onChange={(e) => patchData<AssetNodeData>({ category: e.target.value as AssetCategory })}
                  >
                    <option value="character">Karakter (4-View)</option>
                    <option value="location">Lokasi (Master Kosong)</option>
                    <option value="prop">Properti (2×2)</option>
                  </select>
                </div>
              </div>

              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="ast-lock">
                  Continuity Lock (Deskripsi Tetap)
                </label>
                <textarea
                  id="ast-lock"
                  className="textarea"
                  value={d.lockPrompt}
                  onChange={(e) => patchData<AssetNodeData>({ lockPrompt: e.target.value })}
                  placeholder="Ciri fisik, kostum, warna, atau tata ruang yang wajib konsisten di semua segmen..."
                />
              </div>

              <div className="sectionBox">
                <h3>Gambar Referensi</h3>
                {d.imageDataUrl ? (
                  <img
                    src={d.imageDataUrl}
                    alt={`Referensi ${d.tag}`}
                    width={340}
                    height={192}
                    className="nodeThumb"
                  />
                ) : (
                  <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                    Belum ada gambar. Unggah dari komputer atau generate lembar referensi via AI.
                  </p>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="srOnly"
                  onChange={handleUploadAssetFile}
                />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button
                    type="button"
                    className="btn btnSm"
                    onClick={() => fileRef.current?.click()}
                  >
                    Unggah Gambar
                  </button>
                  <button
                    type="button"
                    className="btn btnPrimary btnSm"
                    disabled={Boolean(busyMsg)}
                    onClick={() => handleGenerateAssetImage(d)}
                  >
                    Generate Aset (AI)
                  </button>
                  {d.imageDataUrl ? (
                    <button
                      type="button"
                      className="btn btnGhost btnSm"
                      onClick={() => patchData<AssetNodeData>({ imageDataUrl: undefined, imageName: undefined })}
                    >
                      Hapus Gambar
                    </button>
                  ) : null}
                </div>
              </div>
            </>
          );
        })() : null}

        {/* SEGMENT NODE */}
        {node.data.kind === "segment" ? (() => {
          const d = node.data as SegmentNodeData;
          const boundAssets = getBoundAssets(project, node.id);
          const spokenEst = estimateDialogueSeconds(d.dialogue);
          const composed = composeSegmentPrompt(project, node);

          return (
            <>
              <div className="fieldRow">
                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="seg-code">
                    Kode Segmen
                  </label>
                  <input
                    id="seg-code"
                    className="input mono"
                    value={d.code}
                    onChange={(e) => patchData<SegmentNodeData>({ code: e.target.value })}
                  />
                </div>
                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="seg-dur">
                    Durasi (detik)
                  </label>
                  <input
                    id="seg-dur"
                    type="number"
                    min={1}
                    max={30}
                    className="input mono"
                    value={d.durationSec}
                    onChange={(e) =>
                      patchData<SegmentNodeData>({ durationSec: Math.max(1, Number(e.target.value) || 1) })
                    }
                  />
                </div>
              </div>

              <div className="fieldRow">
                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="seg-shot">
                    Ukuran Shot
                  </label>
                  <select
                    id="seg-shot"
                    className="select"
                    value={d.shotSize}
                    onChange={(e) => patchData<SegmentNodeData>({ shotSize: e.target.value as ShotSize })}
                  >
                    {SHOT_SIZES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="seg-angle">
                    Sudut Kamera
                  </label>
                  <select
                    id="seg-angle"
                    className="select"
                    value={d.cameraAngle}
                    onChange={(e) => patchData<SegmentNodeData>({ cameraAngle: e.target.value as CameraAngle })}
                  >
                    {ANGLES.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="seg-motion">
                  Gerak Kamera (FFmpeg / Video)
                </label>
                <select
                  id="seg-motion"
                  className="select"
                  value={d.cameraMotion}
                  onChange={(e) => patchData<SegmentNodeData>({ cameraMotion: e.target.value as CameraMotion })}
                >
                  {MOTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="seg-timeline">
                  Timeline Aksi per Detik
                </label>
                <textarea
                  id="seg-timeline"
                  className="textarea"
                  value={d.timelineText}
                  onChange={(e) => patchData<SegmentNodeData>({ timelineText: e.target.value })}
                  placeholder="[0:00-0:04] Deskripsi visual adegan..."
                />
              </div>

              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="seg-dialogue">
                  Dialog / Subtitle {spokenEst > 0 ? `(estimasi baca ~${spokenEst} dtk)` : ""}
                </label>
                <input
                  id="seg-dialogue"
                  className="input"
                  value={d.dialogue}
                  onChange={(e) => patchData<SegmentNodeData>({ dialogue: e.target.value })}
                  placeholder="Kosongkan jika adegan hening"
                />
              </div>

              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="seg-lock">
                  Kunci Kondisi Awal (Mandiri)
                </label>
                <textarea
                  id="seg-lock"
                  className="textarea"
                  style={{ minHeight: 62 }}
                  value={d.continuityLock}
                  onChange={(e) => patchData<SegmentNodeData>({ continuityLock: e.target.value })}
                  placeholder="Posisi kiri/kanan, cahaya, barang di tangan..."
                />
              </div>

              <div className="sectionBox">
                <h3>Aset Terikat ({boundAssets.length})</h3>
                {boundAssets.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                    Tarik kabel dari node Aset ke node ini agar Continuity Lock &amp; gambar referensi otomatis terikat.
                  </p>
                ) : (
                  <div className="nodeMetaRow">
                    {boundAssets.map((a) => (
                      <span key={a.id} className="metaTag mono">
                        {(a.data as AssetNodeData).tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="sectionBox">
                <h3>Media Kandidat &amp; Adopsi ({d.candidates.length})</h3>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,video/mp4,video/webm"
                  className="srOnly"
                  onChange={(e) => handleUploadSegmentMedia(e, d)}
                />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button type="button" className="btn btnSm" onClick={() => fileRef.current?.click()}>
                    Unggah Gambar / MP4
                  </button>
                  <button
                    type="button"
                    className="btn btnPrimary btnSm"
                    disabled={Boolean(busyMsg)}
                    onClick={() => handleGenerateSegmentFrame(d)}
                  >
                    Generate Frame (AI)
                  </button>
                </div>

                {d.candidates.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                    Belum ada media. Jika langsung dirender tanpa media, FFmpeg akan memakai papan slate waktu otomatis.
                  </p>
                ) : (
                  <div className="candidateGrid">
                    {d.candidates.map((cand) => {
                      const isAdopted = cand.id === d.adoptedId;
                      return (
                        <div key={cand.id} className="candidateCard" data-adopted={isAdopted}>
                          {cand.kind === "image" ? (
                            <img
                              src={cand.dataUrl}
                              alt={cand.label}
                              width={160}
                              height={90}
                              style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover" }}
                            />
                          ) : (
                            <video
                              src={cand.dataUrl}
                              width={160}
                              height={90}
                              style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover" }}
                              muted
                              playsInline
                            />
                          )}
                          <div className="candidateFoot">
                            <button
                              type="button"
                              className={`btn btnSm ${isAdopted ? "btnPrimary" : ""}`}
                              style={{ minHeight: 26, padding: "0 8px", fontSize: 11 }}
                              onClick={() => patchData<SegmentNodeData>({ adoptedId: cand.id })}
                            >
                              {isAdopted ? "Diadopsi" : "Adopsi"}
                            </button>
                            <button
                              type="button"
                              className="btn btnGhost btnSm"
                              style={{ minHeight: 26, padding: "0 6px", fontSize: 11 }}
                              onClick={() => {
                                const next = d.candidates.filter((c) => c.id !== cand.id);
                                patchData<SegmentNodeData>({
                                  candidates: next,
                                  adoptedId: d.adoptedId === cand.id ? next[0]?.id : d.adoptedId,
                                });
                              }}
                            >
                              Hapus
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <details>
                  <summary style={{ fontSize: 12, color: "var(--accent-text)", fontWeight: 600 }}>
                    Lihat Prompt Gabungan (Siap Salin)
                  </summary>
                  <pre
                    className="mono"
                    style={{
                      margin: "8px 0 0",
                      padding: 10,
                      borderRadius: "var(--radius-sm)",
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      fontSize: 11,
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {composed}
                  </pre>
                </details>
              </div>
            </>
          );
        })() : null}

        {/* AUDIO NODE */}
        {node.data.kind === "audio" ? (() => {
          const d = node.data as AudioNodeData;
          return (
            <>
              <div className="fieldRow">
                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="aud-role">
                    Peran Audio
                  </label>
                  <select
                    id="aud-role"
                    className="select"
                    value={d.role}
                    onChange={(e) => patchData<AudioNodeData>({ role: e.target.value as AudioRole })}
                  >
                    <option value="ambient">Ambient</option>
                    <option value="bgm">Musik Latar (BGM)</option>
                    <option value="vo">Suara / VO</option>
                    <option value="sfx">Efek Suara (SFX)</option>
                  </select>
                </div>
                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="aud-mode">
                    Sumber Audio
                  </label>
                  <select
                    id="aud-mode"
                    className="select"
                    value={d.sourceMode}
                    onChange={(e) =>
                      patchData<AudioNodeData>({ sourceMode: e.target.value as AudioNodeData["sourceMode"] })
                    }
                  >
                    <option value="ambient-rain">Ambient Hujan Sintetis (Gratis)</option>
                    <option value="upload">Unggah Berkas MP3 / WAV</option>
                  </select>
                </div>
              </div>

              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="aud-vol">
                  Volume ({Math.round(d.volume * 100)}%)
                </label>
                <input
                  id="aud-vol"
                  type="range"
                  min={0.04}
                  max={1}
                  step={0.02}
                  value={d.volume}
                  onChange={(e) => patchData<AudioNodeData>({ volume: Number(e.target.value) })}
                />
              </div>

              {d.sourceMode === "upload" ? (
                <div className="sectionBox">
                  <h3>Berkas Audio Lokal</h3>
                  <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                    {d.fileName || "Belum ada berkas audio diunggah."}
                  </p>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="audio/*"
                    className="srOnly"
                    onChange={handleUploadAudioFile}
                  />
                  <button type="button" className="btn btnSm" onClick={() => fileRef.current?.click()}>
                    Pilih Berkas Audio
                  </button>
                </div>
              ) : null}
            </>
          );
        })() : null}

        {/* ASSEMBLY NODE */}
        {node.data.kind === "assembly" ? (() => {
          const d = node.data as AssemblyNodeData;
          const ordered = getOrderedSegments(project);
          const srt = buildSrt(project);
          return (
            <>
              <div className="fieldRow">
                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="asm-fps">
                    Frame Rate
                  </label>
                  <select
                    id="asm-fps"
                    className="select"
                    value={d.fps}
                    onChange={(e) => patchData<AssemblyNodeData>({ fps: Number(e.target.value) as 24 | 30 })}
                  >
                    <option value={24}>24 fps (Film)</option>
                    <option value={30}>30 fps (Sosial Media)</option>
                  </select>
                </div>
                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="asm-lufs">
                    Target Loudness (LUFS)
                  </label>
                  <input
                    id="asm-lufs"
                    type="number"
                    min={-24}
                    max={-8}
                    className="input mono"
                    value={d.targetLufs}
                    onChange={(e) => patchData<AssemblyNodeData>({ targetLufs: Number(e.target.value) || -14 })}
                  />
                </div>
              </div>

              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={d.burnSubtitles}
                  onChange={(e) => patchData<AssemblyNodeData>({ burnSubtitles: e.target.checked })}
                />
                <span>Tempelkan subtitle otomatis dari dialog segmen</span>
              </label>

              <div className="sectionBox">
                <h3>Urutan Segmen Terhubung ({ordered.length})</h3>
                {ordered.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                    Belum ada node Segmen yang tersambung ke Timeline ini.
                  </p>
                ) : (
                  <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                    {ordered.map((s) => (
                      <li key={s.id}>
                        <span className="mono">{(s.data as SegmentNodeData).code}</span> · {s.title} (
                        {(s.data as SegmentNodeData).durationSec} dtk)
                      </li>
                    ))}
                  </ol>
                )}
                <button type="button" className="btn btnPrimary btnSm" onClick={onOpenPipeline}>
                  Buka Validasi &amp; Render
                </button>
              </div>

              {srt ? (
                <div className="sectionBox">
                  <h3>Pratinjau SRT</h3>
                  <pre className="mono" style={{ margin: 0, fontSize: 11, whiteSpace: "pre-wrap" }}>
                    {srt}
                  </pre>
                </div>
              ) : null}
            </>
          );
        })() : null}

        {/* EXPORT NODE */}
        {node.data.kind === "export" ? (() => {
          const d = node.data as ExportNodeData;
          return (
            <>
              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="exp-platform">
                  Preset Platform
                </label>
                <select
                  id="exp-platform"
                  className="select"
                  value={d.platform}
                  onChange={(e) => patchData<ExportNodeData>({ platform: e.target.value as PlatformPreset })}
                >
                  <option value="youtube">YouTube (16:9 · -14 LUFS)</option>
                  <option value="tiktok">TikTok (9:16 · -14 LUFS)</option>
                  <option value="reels">Instagram Reels (9:16 · -14 LUFS)</option>
                  <option value="custom">Kustom</option>
                </select>
              </div>

              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="exp-ccdir">
                  Folder CapCut Drafts Lokal (Opsional)
                </label>
                <input
                  id="exp-ccdir"
                  className="input mono"
                  value={d.capcutDraftsDir}
                  onChange={(e) => patchData<ExportNodeData>({ capcutDraftsDir: e.target.value })}
                  placeholder={runtime?.defaultCapCutDir || "Contoh: C:\\Users\\...\\CapCut Drafts"}
                />
              </div>

              <div className="sectionBox">
                <h3>Eksekusi Hybrid</h3>
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                  {runtime?.mode === "local-hybrid"
                    ? "Server lokal siap menjalankan FFmpeg secara langsung serta membuat draft CapCut."
                    : "Mode Web aktif: gunakan Render WebM Browser atau Unduh Bundle ZIP untuk FFmpeg & pyCapCut lokal."}
                </p>
                <button type="button" className="btn btnPrimary" onClick={onOpenPipeline}>
                  Buka Panel Render &amp; Ekspor
                </button>
              </div>

              {d.lastRender?.fileUrl ? (
                <div className="sectionBox">
                  <h3>Hasil Render Terakhir</h3>
                  <video src={d.lastRender.fileUrl} controls className="videoPlayer" />
                  <div className="nodeMetaRow">
                    <span className="metaTag mono">{d.lastRender.engine}</span>
                    {d.lastRender.durationSec ? (
                      <span className="metaTag mono">{d.lastRender.durationSec} dtk</span>
                    ) : null}
                    {d.lastRender.resolution ? (
                      <span className="metaTag mono">{d.lastRender.resolution}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </>
          );
        })() : null}

        {/* Keyboard-accessible Wire Connections */}
        <div className="sectionBox">
          <h3>Koneksi Kabel</h3>
          {incomingEdges.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>Masuk dari:</span>
              {incomingEdges.map((edge) => {
                const src = nodeMap.get(edge.source);
                return (
                  <div key={edge.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                    <span style={{ fontSize: 12 }}>{src?.title ?? edge.source}</span>
                    <button
                      type="button"
                      className="btn btnGhost btnSm"
                      onClick={() => onDeleteEdge(edge.id)}
                    >
                      Putus
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          {outgoingEdges.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>Keluar ke:</span>
              {outgoingEdges.map((edge) => {
                const dst = nodeMap.get(edge.target);
                return (
                  <div key={edge.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                    <span style={{ fontSize: 12 }}>{dst?.title ?? edge.target}</span>
                    <button
                      type="button"
                      className="btn btnGhost btnSm"
                      onClick={() => onDeleteEdge(edge.id)}
                    >
                      Putus
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          {meta.hasOutput && validTargets.length > 0 ? (
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <select
                aria-label="Sambungkan ke node tujuan"
                className="select"
                style={{ minHeight: 34, padding: "4px 8px", fontSize: 12 }}
                value={connectTargetId}
                onChange={(e) => setConnectTargetId(e.target.value)}
              >
                <option value="">Sambungkan ke node...</option>
                {validTargets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btnSm"
                disabled={!connectTargetId}
                onClick={() => {
                  if (connectTargetId) {
                    onConnect(node.id, connectTargetId);
                    setConnectTargetId("");
                  }
                }}
              >
                Hubungkan
              </button>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="btn btnDanger"
          onClick={() => onDeleteNode(node.id)}
        >
          Hapus Node Ini
        </button>
      </div>
    </aside>
  );
}
