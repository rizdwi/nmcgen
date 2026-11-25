"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  CameraAngle,
  NmcProject,
  ProviderProfile,
  ShotSize,
  StoryboardData,
  StoryFrame,
} from "@/lib/types";
import { uid } from "@/lib/presets";
import { callAi, downloadBlob, fileToDataUrl } from "@/lib/storage";
import { downscaleImageForFlux2, prepareFlux2References } from "@/lib/imageUtils";
import {
  ASSET_CATEGORY_LABEL,
  buildNextFramePrompt,
  buildQuickEditPrompt,
  buildStoryboardZip,
  buildSyncFrameVisualPrompt,
  CAMERA_ANGLE_META,
  composeStoryboardFramePrompt,
  getSelectedAssetImage,
  getSelectedFrameImage,
  parseNextFrameResponse,
  parseQuickEditResponse,
  SHOT_SIZE_META,
  VALID_CAMERA_ANGLES,
  VALID_SHOT_SIZES,
} from "@/lib/storyboard";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  FilmIcon,
  GridIcon,
  PlusIcon,
  RefreshIcon,
  SparklesIcon,
  TrashIcon,
  UploadIcon,
} from "./Icons";

interface StoryboardStepProps {
  project: NmcProject;
  sb: StoryboardData;
  textProfile: ProviderProfile;
  imageProfile: ProviderProfile;
  onPatchSb: (patch: Partial<StoryboardData>) => void;
  onSyncDiscoveredModels: (
    profileId: string,
    discovered: { textModels: string[]; imageModels: string[]; fetchedAt: number },
  ) => void;
  onOpenSettings: () => void;
}

export default function StoryboardStep({
  project,
  sb,
  textProfile,
  imageProfile,
  onPatchSb,
  onSyncDiscoveredModels,
  onOpenSettings,
}: StoryboardStepProps) {
  const [viewMode, setViewMode] = useState<"editor" | "cards">("editor");
  const [activeFrameId, setActiveFrameId] = useState<string | null>(
    sb.frames[sb.frames.length - 1]?.id ?? null,
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [continueNote, setContinueNote] = useState("");
  const [autoGenOnContinue, setAutoGenOnContinue] = useState(false);
  const [quickEditText, setQuickEditText] = useState("");
  const [showScriptDrawer, setShowScriptDrawer] = useState(false);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const dirtyPromptIdsRef = useRef<Set<string>>(new Set());
  const uploadRef = useRef<HTMLInputElement>(null);

  const latestSbRef = useRef<StoryboardData>(sb);
  latestSbRef.current = sb;

  // Approved assets only (fallback to all assets if user bypassed with manual edits)
  const approvedAssets = useMemo(() => {
    const acc = sb.assets.filter((a) => a.approved);
    return acc.length > 0 ? acc : sb.assets;
  }, [sb.assets]);

  const activeFrame = useMemo(() => {
    if (!sb.frames.length) return null;
    return sb.frames.find((f) => f.id === activeFrameId) ?? sb.frames[sb.frames.length - 1];
  }, [sb.frames, activeFrameId]);

  const activeIdx = activeFrame ? sb.frames.findIndex((f) => f.id === activeFrame.id) : -1;
  const previousFrame = activeIdx > 0 ? sb.frames[activeIdx - 1] : null;

  useEffect(() => {
    if (sb.frames.length === 0) {
      setActiveFrameId(null);
    } else if (!activeFrameId || !sb.frames.some((f) => f.id === activeFrameId)) {
      setActiveFrameId(sb.frames[sb.frames.length - 1].id);
    }
  }, [sb.frames, activeFrameId]);

  // Lightbox keyboard navigation (Left / Right / Escape)
  useEffect(() => {
    if (lightboxIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxIdx(null);
      if (e.key === "ArrowLeft") setLightboxIdx((i) => (i !== null && i > 0 ? i - 1 : i));
      if (e.key === "ArrowRight") {
        setLightboxIdx((i) => (i !== null && i < sb.frames.length - 1 ? i + 1 : i));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIdx, sb.frames.length]);

  const reindexFrames = (list: StoryFrame[]): StoryFrame[] =>
    list.map((f, idx) => ({
      ...f,
      index: idx + 1,
      sameLocationAsPrev: idx === 0 ? false : f.sameLocationAsPrev,
    }));

  const commitFrames = (nextFrames: StoryFrame[], extra?: Partial<StoryboardData>) => {
    const clean = reindexFrames(nextFrames);
    latestSbRef.current = { ...latestSbRef.current, frames: clean, ...extra };
    onPatchSb({ frames: clean, ...extra });
  };

  const updateFrame = (frameId: string, patch: Partial<StoryFrame>) => {
    const next = latestSbRef.current.frames.map((f) => (f.id === frameId ? { ...f, ...patch } : f));
    commitFrames(next);
  };

  const toggleFrameAsset = (frame: StoryFrame, assetId: string) => {
    const has = frame.assetIds.includes(assetId);
    const nextIds = has ? frame.assetIds.filter((id) => id !== assetId) : [...frame.assetIds, assetId];
    updateFrame(frame.id, { assetIds: nextIds });
  };

  // Generate artwork for a single frame using FLUX.2 Klein 4B + <512x512 resized ACC references
  const runGenerateFrameImage = async (targetFrame: StoryFrame, curSb: StoryboardData) => {
    let workingFrame = targetFrame;
    if (
      workingFrame.sceneSummary.trim() &&
      (!workingFrame.visualPrompt.trim() || dirtyPromptIdsRef.current.has(workingFrame.id))
    ) {
      const selectedAssets = workingFrame.assetIds
        .map((id) => curSb.assets.find((a) => a.id === id))
        .filter((a): a is NonNullable<typeof a> => Boolean(a));
      const syncBuilt = buildSyncFrameVisualPrompt({
        sceneSummary: workingFrame.sceneSummary,
        shotSize: workingFrame.shotSize,
        cameraAngle: workingFrame.cameraAngle,
        selectedAssets,
      });
      const tr = await callAi(textProfile, "text", syncBuilt);
      if (tr.discovered) onSyncDiscoveredModels(textProfile.id, tr.discovered);
      if (tr.ok && tr.text?.trim()) {
        workingFrame = { ...workingFrame, visualPrompt: tr.text.trim() };
        dirtyPromptIdsRef.current.delete(workingFrame.id);
        updateFrame(workingFrame.id, { visualPrompt: workingFrame.visualPrompt });
      }
    }

    const idx = curSb.frames.findIndex((f) => f.id === workingFrame.id);
    const prev = idx > 0 ? curSb.frames[idx - 1] : null;
    const composed = composeStoryboardFramePrompt(workingFrame, curSb, prev);

    // Crucial Cloudflare FLUX.2 rule: all input_image_0..3 MUST be strictly < 512x512!
    const rawRefUrls = composed.refs.map((r) => r.dataUrl);
    const resizedRefs = rawRefUrls.length > 0 ? await prepareFlux2References(rawRefUrls, 3) : [];

    const res = await callAi(imageProfile, "image", {
      prompt: composed.prompt,
      aspectRatio: curSb.aspectRatio,
      referenceImages: resizedRefs,
    });
    if (res.discovered) onSyncDiscoveredModels(imageProfile.id, res.discovered);
    if (!res.ok || !res.image) {
      throw new Error(res.error || `Gagal generate gambar Frame ${targetFrame.index}.`);
    }

    const candId = uid();
    const updatedFrames = latestSbRef.current.frames.map((f) => {
      if (f.id !== targetFrame.id) return f;
      return {
        ...f,
        candidates: [
          ...f.candidates,
          {
            id: candId,
            dataUrl: res.image!,
            model: res.usedModel ? res.usedModel.split("/").pop() : "flux-2-klein-4b",
            promptUsed: composed.prompt,
            createdAt: Date.now(),
          },
        ],
        selectedCandidateId: candId,
      };
    });
    commitFrames(updatedFrames);
    return { model: res.usedModel, refCount: resizedRefs.length };
  };

  const handleGenerateActiveImage = async () => {
    if (!activeFrame) return;
    setBusy(`Menggambar Frame ${activeFrame.index} dengan FLUX.2 Klein 4B...`);
    setError("");
    setNotice("");
    try {
      const out = await runGenerateFrameImage(activeFrame, latestSbRef.current);
      setNotice(
        `Gambar Frame ${activeFrame.index} selesai${out.model ? ` (${out.model.split("/").pop()})` : ""}${out.refCount ? ` · ${out.refCount} acuan aset ACC aktif` : ""}.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  // CORE FLOW: Continue -> Build Frame 1 or Frame N+1 sequentially from Script + ACC Assets + Previous Frames
  const handleContinueNextFrame = async () => {
    const curSb = latestSbRef.current;
    if (!curSb.scriptText.trim()) {
      setError("Naskah kosong. Kembali ke Tahap 1 untuk mengisi naskah terlebih dahulu.");
      return;
    }
    const nextNum = curSb.frames.length + 1;
    setBusy(`Menyusun rencana Frame ${nextNum} sesuai naskah & aset ACC...`);
    setError("");
    setNotice("");
    try {
      const built = buildNextFramePrompt({
        projectName: project.name,
        scriptText: curSb.scriptText,
        visualStyle: curSb.visualStyle,
        aspectRatio: curSb.aspectRatio,
        approvedAssets,
        previousFrames: curSb.frames,
        userDirection: continueNote,
      });
      const res = await callAi(textProfile, "text", built);
      if (res.discovered) onSyncDiscoveredModels(textProfile.id, res.discovered);
      if (!res.ok || !res.text) {
        throw new Error(res.error || `Gagal menyusun Frame ${nextNum} dari AI.`);
      }

      const { frame, storyFinished } = parseNextFrameResponse(res.text, approvedAssets, curSb.frames);
      const nextFrames = [...curSb.frames, frame];
      const nextSb: StoryboardData = { ...curSb, frames: nextFrames, storyFinished };
      commitFrames(nextFrames, { storyFinished });
      setActiveFrameId(frame.id);
      setContinueNote("");
      setViewMode("editor");

      if (autoGenOnContinue) {
        setBusy(`Frame ${frame.index} tersusun — sedang menggambar dengan FLUX.2 Klein 4B...`);
        await runGenerateFrameImage(frame, nextSb);
        setNotice(
          storyFinished
            ? `Frame ${frame.index} (akhir cerita di naskah) berhasil digambar! Buka tab Preview Kartu untuk melihat seluruh storyboard.`
            : `Frame ${frame.index} berhasil dibuat & digambar. Cek hasilnya lalu klik Continue untuk Frame ${frame.index + 1}.`,
        );
      } else {
        setNotice(
          storyFinished
            ? `Draft Frame ${frame.index} (penutup naskah) siap. Periksa aset & aksinya, lalu klik Generate Gambar.`
            : `Draft Frame ${frame.index} siap. Cek aksi & aset ACC yang terpilih, lalu klik Generate Gambar (4B).`,
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const handleQuickEditFrame = async () => {
    if (!activeFrame) return;
    const instruction = quickEditText.trim();
    const currentImg = getSelectedFrameImage(activeFrame);
    if (!instruction) {
      setError("Tulis instruksi revisi singkat terlebih dahulu.");
      return;
    }
    if (!currentImg) {
      setError("Generate gambar frame terlebih dahulu sebelum revisi gambar.");
      return;
    }

    setBusy(`Merevisi gambar Frame ${activeFrame.index} dengan FLUX.2 Klein 4B...`);
    setError("");
    setNotice("");
    try {
      const built = buildQuickEditPrompt({
        mode: "frame",
        label: `Frame ${activeFrame.index}: ${activeFrame.title}`,
        currentVisualDesc: activeFrame.visualPrompt || activeFrame.sceneSummary,
        instruction,
        visualStyle: sb.visualStyle,
      });
      const textRes = await callAi(textProfile, "text", built);
      if (textRes.discovered) onSyncDiscoveredModels(textProfile.id, textRes.discovered);
      const parsed = parseQuickEditResponse(textRes.text || "", sb.visualStyle, instruction);

      // image 0 = current frame (resized < 512x512), plus primary character ACC asset as image 1 if available
      const refsToResize = [currentImg];
      const primaryChar = activeFrame.assetIds
        .map((id) => sb.assets.find((a) => a.id === id))
        .find((a) => a?.category === "character" && Boolean(getSelectedAssetImage(a)));
      const charImg = primaryChar ? getSelectedAssetImage(primaryChar) : null;
      if (charImg) refsToResize.push(charImg);

      const resizedRefs = await Promise.all(refsToResize.map((u) => downscaleImageForFlux2(u, 480)));
      const imgRes = await callAi(imageProfile, "image", {
        prompt: parsed.editPrompt,
        aspectRatio: sb.aspectRatio,
        referenceImages: resizedRefs,
      });
      if (imgRes.discovered) onSyncDiscoveredModels(imageProfile.id, imgRes.discovered);
      if (!imgRes.ok || !imgRes.image) {
        throw new Error(imgRes.error || `Gagal merevisi Frame ${activeFrame.index}.`);
      }

      const candId = uid();
      const updated = latestSbRef.current.frames.map((f) => {
        if (f.id !== activeFrame.id) return f;
        return {
          ...f,
          visualPrompt: parsed.updatedVisualDesc || f.visualPrompt,
          approved: false,
          candidates: [
            ...f.candidates,
            {
              id: candId,
              dataUrl: imgRes.image!,
              model: imgRes.usedModel ? `${imgRes.usedModel.split("/").pop()} (edit)` : "edit",
              promptUsed: parsed.editPrompt,
              createdAt: Date.now(),
            },
          ],
          selectedCandidateId: candId,
        };
      });
      commitFrames(updated);
      setQuickEditText("");
      setNotice(`Revisi Frame ${activeFrame.index} selesai.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const handleUploadFrameImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeFrame) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      const candId = uid();
      const updated = latestSbRef.current.frames.map((f) =>
        f.id === activeFrame.id
          ? {
              ...f,
              candidates: [
                ...f.candidates,
                { id: candId, dataUrl, model: "upload", createdAt: Date.now() },
              ],
              selectedCandidateId: candId,
            }
          : f,
      );
      commitFrames(updated);
      setNotice(`Gambar "${file.name}" dipasang ke Frame ${activeFrame.index}.`);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      e.target.value = "";
    }
  };

  const handleAddBlankFrame = () => {
    const idx = sb.frames.length + 1;
    const blank: StoryFrame = {
      id: uid(),
      index: idx,
      title: `Frame ${idx}`,
      scriptExcerpt: "",
      sceneSummary: "",
      dialogue: "",
      shotSize: "MS",
      cameraAngle: "Front",
      assetIds: [],
      sameLocationAsPrev: idx > 1,
      visualPrompt: "",
      approved: false,
      candidates: [],
    };
    commitFrames([...sb.frames, blank]);
    setActiveFrameId(blank.id);
    setViewMode("editor");
  };

  const handleMoveFrame = (frameId: string, delta: -1 | 1) => {
    const idx = sb.frames.findIndex((f) => f.id === frameId);
    const target = idx + delta;
    if (idx === -1 || target < 0 || target >= sb.frames.length) return;
    const copy = [...sb.frames];
    const [moved] = copy.splice(idx, 1);
    copy.splice(target, 0, moved);
    commitFrames(copy);
  };

  const handleDeleteFrame = (frameId: string) => {
    const idx = sb.frames.findIndex((f) => f.id === frameId);
    const remaining = sb.frames.filter((f) => f.id !== frameId);
    commitFrames(remaining, { storyFinished: false });
    if (remaining.length === 0) {
      setActiveFrameId(null);
    } else {
      setActiveFrameId(remaining[Math.min(idx, remaining.length - 1)].id);
    }
  };

  const handleOptionalDownloadZip = () => {
    const bytes = buildStoryboardZip({ ...project, storyboard: sb });
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const safeName =
      (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") +
      "-storyboard.zip";
    downloadBlob(new Blob([copy], { type: "application/zip" }), safeName);
  };

  const activeImg = activeFrame ? getSelectedFrameImage(activeFrame) : null;
  const activeComposed = useMemo(
    () => (activeFrame ? composeStoryboardFramePrompt(activeFrame, sb, previousFrame) : null),
    [activeFrame, sb, previousFrame],
  );
  const approvedFrameCount = sb.frames.filter((f) => f.approved).length;
  const lightboxFrame = lightboxIdx !== null ? sb.frames[lightboxIdx] ?? null : null;

  return (
    <div className="stepContainer">
      {/* Step header with instant Editor vs Card Preview switcher */}
      <div className="stepIntroRow">
        <div>
          <span className="stepKicker mono">TAHAP 3 DARI 3 · PER-FRAME + CONTINUE</span>
          <h2 className="stepTitle">Storyboard Per-Frame</h2>
          <p className="stepSubtitle">
            Bangun cerita satu frame demi satu frame dengan tombol <strong>Continue</strong> mengacu pada{" "}
            <strong>{approvedAssets.length} aset ACC</strong>. Beralih ke <strong>Preview Kartu</strong> kapan saja
            untuk melihat seluruh papan storyboard tanpa perlu unduh.
          </p>
        </div>

        <div className="actionGroup">
          <div className="segToggle" role="tablist" aria-label="Mode tampilan storyboard">
            <button
              type="button"
              role="tab"
              className="segBtn"
              aria-selected={viewMode === "editor"}
              onClick={() => setViewMode("editor")}
            >
              <FilmIcon size={14} />
              <span>Editor Per-Frame</span>
            </button>
            <button
              type="button"
              role="tab"
              className="segBtn"
              aria-selected={viewMode === "cards"}
              onClick={() => setViewMode("cards")}
            >
              <GridIcon size={14} />
              <span>Preview Kartu ({sb.frames.length})</span>
            </button>
          </div>

          <button type="button" className="btn btnSm" onClick={() => setShowScriptDrawer((v) => !v)}>
            {showScriptDrawer ? "Tutup Naskah" : "Lihat Naskah"}
          </button>

          {sb.frames.length > 0 ? (
            <button
              type="button"
              className="btn btnGhost btnSm"
              onClick={handleOptionalDownloadZip}
              title="Opsional: unduh semua gambar & naskah sebagai ZIP"
            >
              Unduh ZIP
            </button>
          ) : null}
        </div>
      </div>

      {busy ? (
        <div className="alertBox" role="status">
          {busy}
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

      {showScriptDrawer ? (
        <section className="scriptPeekBox" aria-label="Naskah acuan">
          <div className="panelHead">
            <h3>Naskah Acuan</h3>
            <button type="button" className="btn btnGhost btnSm" onClick={() => onPatchSb({ step: "assets" })}>
              Cek Aset ACC ({approvedAssets.length})
            </button>
          </div>
          <pre className="scriptPeekPre">{sb.scriptText || "(Naskah kosong)"}</pre>
        </section>
      ) : null}

      {/* =================================================================== */}
      {/* VIEW MODE B: INSTANT PER-FRAME CARD PREVIEW (NO DOWNLOAD NEEDED!)   */}
      {/* =================================================================== */}
      {viewMode === "cards" ? (
        <div className="cardsPreviewWrap">
          {/* Compact ACC Assets strip for reference */}
          {approvedAssets.length > 0 ? (
            <details className="panelCard compactAssetsStrip">
              <summary className="compactAssetsSummary">
                <span>Aset &amp; Karakter ACC ({approvedAssets.length})</span>
                <span className="fieldHint">Klik untuk lihat acuan visual</span>
              </summary>
              <div className="miniAssetRow">
                {approvedAssets.map((a) => {
                  const thumb = getSelectedAssetImage(a);
                  return (
                    <div key={a.id} className="miniAssetPill">
                      {thumb ? <img src={thumb} alt={a.name} className="miniAssetAvatar" /> : null}
                      <div>
                        <strong>{a.name}</strong>
                        <span>{ASSET_CATEGORY_LABEL[a.category]}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          ) : null}

          {sb.frames.length === 0 ? (
            <div className="emptyPanel">
              <h3>Belum ada kartu frame</h3>
              <p>Mulai buat Frame 1 dari naskah dan aset ACC Anda, lalu lanjutkan dengan tombol Continue.</p>
              <button
                type="button"
                className="btn btnPrimary btnLg"
                disabled={Boolean(busy)}
                onClick={() => void handleContinueNextFrame()}
              >
                <SparklesIcon size={15} />
                <span>Buat Frame 1 dari Naskah</span>
              </button>
            </div>
          ) : (
            <>
              <div className="cardsPreviewMeta">
                <span className="mono">
                  {sb.frames.length} Frame · {approvedFrameCount} ACC · Rasio {sb.aspectRatio}
                </span>
                <button
                  type="button"
                  className="btn btnPrimary btnSm"
                  disabled={Boolean(busy)}
                  onClick={() => void handleContinueNextFrame()}
                >
                  <PlusIcon size={14} />
                  <span>Continue → Frame {sb.frames.length + 1}</span>
                </button>
              </div>

              <div className="storyboardCardGrid" data-ratio={sb.aspectRatio}>
                {sb.frames.map((frame, idx) => {
                  const img = getSelectedFrameImage(frame);
                  const cast = frame.assetIds
                    .map((id) => sb.assets.find((a) => a.id === id))
                    .filter((a): a is NonNullable<typeof a> => Boolean(a));

                  return (
                    <article key={frame.id} className="sbPreviewCard" data-approved={frame.approved}>
                      <button
                        type="button"
                        className="sbPreviewMediaBtn"
                        data-ratio={sb.aspectRatio}
                        onClick={() => setLightboxIdx(idx)}
                        aria-label={`Perbesar Frame ${frame.index}: ${frame.title}`}
                      >
                        {img ? (
                          <img src={img} alt={`Frame ${frame.index}: ${frame.title}`} className="sbPreviewImg" />
                        ) : (
                          <div className="sbPreviewEmpty">
                            <span>Belum digambar</span>
                          </div>
                        )}
                        <span className="sbFrameNumBadge mono">
                          FRAME {String(frame.index).padStart(2, "0")}
                        </span>
                        {frame.approved ? (
                          <span className="sbAccBadge">
                            <CheckIcon size={12} /> ACC
                          </span>
                        ) : null}
                      </button>

                      <div className="sbPreviewBody">
                        <div className="sbPreviewTitleRow">
                          <h3>{frame.title || `Frame ${frame.index}`}</h3>
                          <span className="metaTag mono">
                            {frame.shotSize} · {frame.cameraAngle}
                          </span>
                        </div>

                        {cast.length > 0 ? (
                          <div className="sbCastMiniRow">
                            {cast.map((a) => (
                              <span key={a.id} className="sbCastMiniChip">
                                {a.name}
                              </span>
                            ))}
                          </div>
                        ) : null}

                        <p className="sbPreviewSummary">
                          {frame.sceneSummary || "Belum ada ringkasan aksi."}
                        </p>

                        {frame.dialogue.trim() ? (
                          <blockquote className="sbPreviewDialogue">
                            &ldquo;{frame.dialogue.trim()}&rdquo;
                          </blockquote>
                        ) : null}

                        <div className="sbPreviewFooter">
                          <button
                            type="button"
                            className="btn btnSm"
                            onClick={() => setLightboxIdx(idx)}
                          >
                            Perbesar
                          </button>
                          <button
                            type="button"
                            className="btn btnGhost btnSm"
                            onClick={() => {
                              setActiveFrameId(frame.id);
                              setViewMode("editor");
                            }}
                          >
                            Edit Frame
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </div>
      ) : (
        /* =================================================================== */
        /* VIEW MODE A: PER-FRAME EDITOR + CONTINUE                            */
        /* =================================================================== */
        <>
          {/* Filmstrip Bar */}
          <div className="filmstripBar" role="region" aria-label="Urutan frame storyboard">
            {sb.frames.map((frame) => {
              const thumb = getSelectedFrameImage(frame);
              const isSelected = activeFrame?.id === frame.id;
              return (
                <button
                  key={frame.id}
                  type="button"
                  className="filmstripItem"
                  data-active={isSelected}
                  data-approved={frame.approved}
                  onClick={() => {
                    setActiveFrameId(frame.id);
                    setQuickEditText("");
                  }}
                >
                  <div className="filmstripThumb" data-ratio={sb.aspectRatio}>
                    {thumb ? (
                      <img src={thumb} alt={`Frame ${frame.index}`} />
                    ) : (
                      <span className="mono">{String(frame.index).padStart(2, "0")}</span>
                    )}
                    {frame.approved ? (
                      <span className="filmstripAccDot" aria-label="ACC">
                        <CheckIcon size={10} />
                      </span>
                    ) : null}
                  </div>
                  <div className="filmstripMeta">
                    <strong className="mono">F{String(frame.index).padStart(2, "0")}</strong>
                    <span>{frame.title || `Frame ${frame.index}`}</span>
                  </div>
                </button>
              );
            })}

            <button
              type="button"
              className="filmstripContinueCard"
              disabled={Boolean(busy)}
              onClick={() => void handleContinueNextFrame()}
              title="Lanjutkan ke frame berikutnya sesuai naskah"
            >
              <PlusIcon size={16} />
              <span>{sb.frames.length === 0 ? "Frame 1" : "Continue"}</span>
            </button>
          </div>

          {!activeFrame ? (
            <div className="emptyPanel">
              <h3>Siap Membuat Frame 1</h3>
              <p>
                Aset &amp; karakter sudah ACC ({approvedAssets.length} aset siap jadi acuan visual). Mulai dari{" "}
                <strong>Frame 1</strong>, periksa hasilnya, lalu tekan <strong>Continue</strong> untuk Frame 2, 3, dan
                seterusnya sampai cerita di naskah selesai.
              </p>

              <div className="continueEmptyControls">
                <input
                  aria-label="Arahan opsional untuk Frame 1"
                  className="input"
                  value={continueNote}
                  disabled={Boolean(busy)}
                  onChange={(e) => setContinueNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleContinueNextFrame();
                    }
                  }}
                  placeholder="Arahan opsional untuk Frame 1 (kosongkan agar AI mulai tepat dari awal naskah)..."
                />
                <label className="checkRow">
                  <input
                    type="checkbox"
                    checked={autoGenOnContinue}
                    onChange={(e) => setAutoGenOnContinue(e.target.checked)}
                  />
                  <span>Langsung generate gambar (FLUX.2 Klein 4B)</span>
                </label>
                <div className="actionGroup" style={{ justifyContent: "center" }}>
                  <button
                    type="button"
                    className="btn btnPrimary btnLg"
                    disabled={Boolean(busy)}
                    onClick={() => void handleContinueNextFrame()}
                  >
                    <SparklesIcon size={15} />
                    <span>Buat Frame 1 dari Naskah</span>
                    <ArrowRightIcon size={15} />
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={Boolean(busy)}
                    onClick={handleAddBlankFrame}
                  >
                    Tambah Frame Kosong Manual
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="frameEditorGrid">
              {/* LEFT COLUMN: Active Frame Visual Stage + Continue Bar */}
              <div className="frameStageCol">
                <section className="panelCard">
                  <div className="panelHead">
                    <div className="metaInline">
                      <span className="frameIndexPill mono">
                        FRAME {String(activeFrame.index).padStart(2, "0")}
                      </span>
                      <span className="metaTag">
                        {SHOT_SIZE_META[activeFrame.shotSize].label} · {CAMERA_ANGLE_META[activeFrame.cameraAngle].label}
                      </span>
                    </div>

                    <button
                      type="button"
                      className={`accToggleBtn ${activeFrame.approved ? "isApproved" : ""}`}
                      disabled={Boolean(busy)}
                      onClick={() => {
                        if (!activeFrame.approved && !activeImg) {
                          setError("Generate atau unggah gambar frame dulu sebelum memberi ACC.");
                          return;
                        }
                        setError("");
                        updateFrame(activeFrame.id, { approved: !activeFrame.approved });
                      }}
                    >
                      <CheckIcon size={13} />
                      <span>{activeFrame.approved ? "Frame ACC" : "ACC Frame"}</span>
                    </button>
                  </div>

                  {/* Active visual canvas */}
                  <div className="frameStageBox" data-ratio={sb.aspectRatio}>
                    {activeImg ? (
                      <img
                        src={activeImg}
                        alt={`Frame ${activeFrame.index}: ${activeFrame.title}`}
                        className="frameStageImg"
                        onClick={() => setLightboxIdx(activeIdx)}
                      />
                    ) : (
                      <div className="frameStageEmpty">
                        <p>Draft Frame {activeFrame.index} siap digambar.</p>
                        <p className="fieldHint">
                          Cek pilihan Aset ACC di sebelah kanan, lalu klik <strong>Generate Gambar (4B)</strong>.
                        </p>
                      </div>
                    )}
                    {busy && activeImg ? <div className="mediaBusyOverlay">{busy}</div> : null}
                  </div>

                  {/* FLUX.2 Reference Transparency Bar */}
                  <div className="refTransparencyRow">
                    <span className="mono refLabel">Acuan FLUX.2 4B:</span>
                    {activeComposed && activeComposed.refs.length > 0 ? (
                      activeComposed.refs.map((r, i) => (
                        <span key={`${r.label}-${i}`} className="refChip mono">
                          image {i}: {r.label}
                        </span>
                      ))
                    ) : (
                      <span className="fieldHint">
                        Tanpa gambar acuan (pilih Aset ACC yang sudah punya gambar di panel kanan)
                      </span>
                    )}
                  </div>

                  {/* Version candidates strip */}
                  {activeFrame.candidates.length > 1 ? (
                    <div className="candStrip" aria-label={`Versi gambar Frame ${activeFrame.index}`}>
                      {activeFrame.candidates.map((cand, idx) => (
                        <button
                          key={cand.id}
                          type="button"
                          className="candThumbBtn"
                          data-active={
                            cand.id ===
                            (activeFrame.selectedCandidateId ??
                              activeFrame.candidates[activeFrame.candidates.length - 1].id)
                          }
                          onClick={() => updateFrame(activeFrame.id, { selectedCandidateId: cand.id })}
                          title={`Versi #${idx + 1}${cand.model ? ` (${cand.model})` : ""}`}
                        >
                          <img src={cand.dataUrl} alt={`Versi ${idx + 1}`} />
                          <span className="mono">#{idx + 1}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {/* Primary image generation & upload buttons */}
                  <div className="frameStageActions">
                    <button
                      type="button"
                      className="btn btnPrimary"
                      disabled={Boolean(busy)}
                      onClick={() => void handleGenerateActiveImage()}
                    >
                      {activeImg ? <RefreshIcon size={14} /> : <SparklesIcon size={14} />}
                      <span>{activeImg ? "Regenerate (4B)" : "Generate Gambar (4B)"}</span>
                    </button>

                    <button
                      type="button"
                      className="btn"
                      disabled={Boolean(busy)}
                      onClick={() => uploadRef.current?.click()}
                    >
                      <UploadIcon size={14} />
                      <span>Upload</span>
                    </button>
                    <input
                      ref={uploadRef}
                      type="file"
                      accept="image/*"
                      className="srOnly"
                      onChange={(e) => void handleUploadFrameImage(e)}
                    />

                    {activeImg ? (
                      <button
                        type="button"
                        className="btn btnGhost"
                        style={{ marginLeft: "auto" }}
                        onClick={() => setLightboxIdx(activeIdx)}
                      >
                        Perbesar
                      </button>
                    ) : null}
                  </div>

                  {/* Quick FLUX.2 image-to-image revision */}
                  {activeImg ? (
                    <div className="quickReviseRow">
                      <input
                        aria-label={`Revisi cepat gambar Frame ${activeFrame.index}`}
                        className="input"
                        value={quickEditText}
                        disabled={Boolean(busy)}
                        onChange={(e) => setQuickEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleQuickEditFrame();
                          }
                        }}
                        placeholder="Revisi gambar ini (mis. wajah lebih kaget, kamera lebih dekat, tambah hujan)..."
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={Boolean(busy) || !quickEditText.trim()}
                        onClick={() => void handleQuickEditFrame()}
                      >
                        Revisi Gambar
                      </button>
                    </div>
                  ) : null}
                </section>

                {/* DEDICATED CONTINUE NEXT FRAME BAR */}
                <section className="panelCard continueCard" aria-label="Lanjutkan ke frame berikutnya">
                  <div className="panelHead">
                    <h3>Lanjutkan Storyboard (Continue)</h3>
                    {sb.storyFinished ? (
                      <span className="statusBadge" data-tone="ok">
                        <CheckIcon size={12} /> Akhir Naskah Tercapai
                      </span>
                    ) : null}
                  </div>

                  <div className="continueRow">
                    <input
                      aria-label="Arahan opsional frame berikutnya"
                      className="input"
                      value={continueNote}
                      disabled={Boolean(busy)}
                      onChange={(e) => setContinueNote(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleContinueNextFrame();
                        }
                      }}
                      placeholder={`Arahan untuk Frame ${sb.frames.length + 1} (opsional, kosongkan agar AI lanjutkan otomatis sesuai naskah)...`}
                    />
                    <button
                      type="button"
                      className="btn btnPrimary"
                      disabled={Boolean(busy)}
                      onClick={() => void handleContinueNextFrame()}
                    >
                      <span>Continue → Frame {sb.frames.length + 1}</span>
                      <ArrowRightIcon size={15} />
                    </button>
                  </div>

                  <div className="continueSubRow">
                    <label className="checkRow">
                      <input
                        type="checkbox"
                        checked={autoGenOnContinue}
                        disabled={Boolean(busy)}
                        onChange={(e) => setAutoGenOnContinue(e.target.checked)}
                      />
                      <span>Langsung generate gambar otomatis saat klik Continue</span>
                    </label>

                    <button
                      type="button"
                      className="btn btnGhost btnSm"
                      onClick={() => setViewMode("cards")}
                    >
                      <GridIcon size={13} />
                      <span>Lihat Preview Kartu ({sb.frames.length})</span>
                    </button>
                  </div>
                </section>
              </div>

              {/* RIGHT COLUMN: Active Frame Details & ACC Asset Binding */}
              <section className="panelCard frameDetailsCol" aria-label="Detail frame aktif">
                <div className="panelHead">
                  <h3>Detail Frame {String(activeFrame.index).padStart(2, "0")}</h3>
                  <div className="actionGroup">
                    <button
                      type="button"
                      className="btn btnGhost btnSm btnIcon"
                      disabled={Boolean(busy) || activeIdx <= 0}
                      title="Geser frame ke kiri"
                      aria-label="Geser frame ke kiri"
                      onClick={() => handleMoveFrame(activeFrame.id, -1)}
                    >
                      <ChevronLeftIcon size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btnGhost btnSm btnIcon"
                      disabled={Boolean(busy) || activeIdx >= sb.frames.length - 1}
                      title="Geser frame ke kanan"
                      aria-label="Geser frame ke kanan"
                      onClick={() => handleMoveFrame(activeFrame.id, 1)}
                    >
                      <ChevronRightIcon size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btnDanger btnSm btnIcon"
                      disabled={Boolean(busy)}
                      title="Hapus frame ini"
                      aria-label="Hapus frame ini"
                      onClick={() => handleDeleteFrame(activeFrame.id)}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>
                </div>

                {activeFrame.scriptExcerpt ? (
                  <div className="scriptExcerptBox">
                    <span className="fieldLabel">Bagian Naskah</span>
                    <p>{activeFrame.scriptExcerpt}</p>
                  </div>
                ) : null}

                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="fr-title">
                    Judul Singkat Frame
                  </label>
                  <input
                    id="fr-title"
                    className="input"
                    value={activeFrame.title}
                    disabled={Boolean(busy)}
                    onChange={(e) => updateFrame(activeFrame.id, { title: e.target.value })}
                  />
                </div>

                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="fr-summary">
                    Aksi Visual di Frame Ini (1 Momen Jelas)
                  </label>
                  <textarea
                    id="fr-summary"
                    className="textarea"
                    style={{ minHeight: 74 }}
                    value={activeFrame.sceneSummary}
                    disabled={Boolean(busy)}
                    onChange={(e) => {
                      dirtyPromptIdsRef.current.add(activeFrame.id);
                      updateFrame(activeFrame.id, { sceneSummary: e.target.value });
                    }}
                    placeholder="Apa yang sedang terjadi secara visual di frame ini..."
                  />
                </div>

                {/* Clickable ACC Assets chips */}
                <div className="fieldGroup">
                  <span className="fieldLabel">
                    Aset ACC yang Tampil di Frame Ini (klik untuk pilih/lepas)
                  </span>
                  <div className="assetChipGrid">
                    {approvedAssets.map((asset) => {
                      const active = activeFrame.assetIds.includes(asset.id);
                      const thumb = getSelectedAssetImage(asset);
                      return (
                        <button
                          key={asset.id}
                          type="button"
                          className="assetSelectChip"
                          data-selected={active}
                          disabled={Boolean(busy)}
                          onClick={() => toggleFrameAsset(activeFrame, asset.id)}
                        >
                          {thumb ? (
                            <img src={thumb} alt="" className="assetChipThumb" />
                          ) : (
                            <span className="assetChipDot" />
                          )}
                          <span className="assetChipText">
                            <strong>{asset.name}</strong>
                            <small>{ASSET_CATEGORY_LABEL[asset.category]}</small>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {activeFrame.index > 1 ? (
                  <label className="checkRow continuityCheck">
                    <input
                      type="checkbox"
                      checked={activeFrame.sameLocationAsPrev}
                      disabled={Boolean(busy)}
                      onChange={(e) =>
                        updateFrame(activeFrame.id, { sameLocationAsPrev: e.target.checked })
                      }
                    />
                    <span>
                      Lokasi sama dengan Frame {activeFrame.index - 1} (bawa warna &amp; cahaya Frame{" "}
                      {activeFrame.index - 1} sebagai acuan)
                    </span>
                  </label>
                ) : null}

                <div className="fieldRow">
                  <div className="fieldGroup">
                    <label className="fieldLabel" htmlFor="fr-shot">
                      Ukuran Shot
                    </label>
                    <select
                      id="fr-shot"
                      className="select"
                      value={activeFrame.shotSize}
                      disabled={Boolean(busy)}
                      onChange={(e) => updateFrame(activeFrame.id, { shotSize: e.target.value as ShotSize })}
                    >
                      {VALID_SHOT_SIZES.map((s) => (
                        <option key={s} value={s}>
                          {SHOT_SIZE_META[s].label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="fieldGroup">
                    <label className="fieldLabel" htmlFor="fr-angle">
                      Sudut Kamera
                    </label>
                    <select
                      id="fr-angle"
                      className="select"
                      value={activeFrame.cameraAngle}
                      disabled={Boolean(busy)}
                      onChange={(e) =>
                        updateFrame(activeFrame.id, { cameraAngle: e.target.value as CameraAngle })
                      }
                    >
                      {VALID_CAMERA_ANGLES.map((a) => (
                        <option key={a} value={a}>
                          {CAMERA_ANGLE_META[a].label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="fr-dialogue">
                    Dialog / Narasi (Opsional)
                  </label>
                  <input
                    id="fr-dialogue"
                    className="input"
                    value={activeFrame.dialogue}
                    disabled={Boolean(busy)}
                    onChange={(e) => updateFrame(activeFrame.id, { dialogue: e.target.value })}
                    placeholder="Kosongkan jika frame tanpa dialog"
                  />
                </div>

                <details className="subtleDetails">
                  <summary>Prompt Visual AI (EN) — FLUX.2 Klein 4B</summary>
                  <div className="subtleDetailsBody">
                    <textarea
                      aria-label="Prompt visual bahasa Inggris"
                      className="textarea"
                      style={{ minHeight: 84, fontSize: 12 }}
                      value={activeFrame.visualPrompt}
                      disabled={Boolean(busy)}
                      onChange={(e) => {
                        dirtyPromptIdsRef.current.delete(activeFrame.id);
                        updateFrame(activeFrame.id, { visualPrompt: e.target.value });
                      }}
                      placeholder="Pure English visual scene description..."
                    />
                    {activeComposed ? (
                      <div className="promptReadout mono">{activeComposed.prompt}</div>
                    ) : null}
                  </div>
                </details>
              </section>
            </div>
          )}
        </>
      )}

      {/* =================================================================== */}
      {/* FULL-SCREEN CARD LIGHTBOX READER (NO DOWNLOAD NEEDED!)              */}
      {/* =================================================================== */}
      {lightboxFrame && lightboxIdx !== null ? (
        <div
          className="modalBackdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Preview Frame ${lightboxFrame.index}`}
          onClick={() => setLightboxIdx(null)}
        >
          <div className="lightboxDialog" onClick={(e) => e.stopPropagation()}>
            <div className="lightboxHeader">
              <div className="metaInline">
                <span className="frameIndexPill mono">
                  FRAME {String(lightboxFrame.index).padStart(2, "0")} / {String(sb.frames.length).padStart(2, "0")}
                </span>
                <h3>{lightboxFrame.title}</h3>
                <span className="metaTag">
                  {SHOT_SIZE_META[lightboxFrame.shotSize].label} · {CAMERA_ANGLE_META[lightboxFrame.cameraAngle].label}
                </span>
              </div>
              <button
                type="button"
                className="btn btnGhost btnIcon"
                aria-label="Tutup preview"
                onClick={() => setLightboxIdx(null)}
              >
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="lightboxBody">
              <button
                type="button"
                className="btn btnIcon lightboxNavBtn"
                disabled={lightboxIdx <= 0}
                aria-label="Frame sebelumnya"
                onClick={() => setLightboxIdx((i) => (i !== null && i > 0 ? i - 1 : i))}
              >
                <ChevronLeftIcon size={18} />
              </button>

              <div className="lightboxStage">
                {getSelectedFrameImage(lightboxFrame) ? (
                  <img
                    src={getSelectedFrameImage(lightboxFrame)!}
                    alt={`Frame ${lightboxFrame.index}: ${lightboxFrame.title}`}
                    className="lightboxImg"
                  />
                ) : (
                  <div className="lightboxEmpty">Frame {lightboxFrame.index} belum digambar.</div>
                )}
              </div>

              <button
                type="button"
                className="btn btnIcon lightboxNavBtn"
                disabled={lightboxIdx >= sb.frames.length - 1}
                aria-label="Frame berikutnya"
                onClick={() =>
                  setLightboxIdx((i) => (i !== null && i < sb.frames.length - 1 ? i + 1 : i))
                }
              >
                <ChevronRightIcon size={18} />
              </button>
            </div>

            <div className="lightboxCaption">
              <p>{lightboxFrame.sceneSummary}</p>
              {lightboxFrame.dialogue.trim() ? (
                <blockquote className="sbPreviewDialogue">
                  &ldquo;{lightboxFrame.dialogue.trim()}&rdquo;
                </blockquote>
              ) : null}
              <div className="lightboxFooterRow">
                <span className="fieldHint">Gunakan tombol panah ← → di keyboard untuk pindah frame.</span>
                <button
                  type="button"
                  className="btn btnSm"
                  onClick={() => {
                    setActiveFrameId(lightboxFrame.id);
                    setLightboxIdx(null);
                    setViewMode("editor");
                  }}
                >
                  Edit Frame Ini
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
