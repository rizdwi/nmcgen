"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  CameraAngle,
  NmcProject,
  ProviderProfile,
  ShotSize,
  StoryboardData,
  StoryFrame,
  StorySegment,
} from "@/lib/types";
import { uid } from "@/lib/presets";
import { callAi, downloadBlob, fileToDataUrl } from "@/lib/storage";
import {
  compressImageForStorage,
  downscaleImageForFlux2,
  prepareFlux2References,
  renderSegmentStripImageBlob,
} from "@/lib/imageUtils";
import {
  ASSET_CATEGORY_LABEL,
  buildNextFramePrompt,
  buildQuickEditPrompt,
  buildStoryboardZip,
  buildSyncFrameVisualPrompt,
  CAMERA_ANGLE_META,
  clampTargetPanels,
  composeStoryboardFramePrompt,
  getSegmentFrames,
  getSelectedAssetImage,
  getSelectedFrameImage,
  getStoryboardSegments,
  parseNextFrameResponse,
  parseQuickEditResponse,
  reindexStoryboardFrames,
  SHOT_SIZE_META,
  trimCandidates,
  VALID_CAMERA_ANGLES,
  VALID_SHOT_SIZES,
} from "@/lib/storyboard";
import { ANIMATION_APP_LINKS } from "@/lib/omniAnimation";
import {
  buildFlowImageFolderSlug,
  buildFlowStoryboardImagePackZip,
  FLOW_IMAGE_MODELS,
  matchDownloadedImageToSlot,
  type FlowConnectorImageModel,
} from "@/lib/flowImageConnector";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FilmIcon,
  GridIcon,
  PlusIcon,
  RefreshIcon,
  SparklesIcon,
  TrashIcon,
  UploadIcon,
} from "./Icons";

interface FsFileHandleLike {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
}

interface FsDirHandleLike {
  kind?: "directory";
  name: string;
  values: () => AsyncIterable<FsFileHandleLike | FsDirHandleLike | { kind: string; name: string }>;
}

type WindowWithDirPicker = Window & {
  showDirectoryPicker?: (opts?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: string;
  }) => Promise<FsDirHandleLike>;
};

const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;
const FLOW_IMAGE_MODEL_STORAGE_KEY = "nmcgen.flowImageModel";
const FLOW_CLI_INSTALL_CMD = "npm install -g flow-connector-cli";

function loadPreferredFlowImageModel(): FlowConnectorImageModel {
  if (typeof window === "undefined") return "nano-banana-2-lite";
  try {
    const saved = window.localStorage.getItem(FLOW_IMAGE_MODEL_STORAGE_KEY);
    if (saved === "nano-banana-2-lite" || saved === "nano-banana-2" || saved === "nano-banana-pro") return saved;
  } catch {
    // ignore storage errors
  }
  return "nano-banana-2-lite";
}

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
  onGoToAnimate?: () => void;
  onAnimateSegment?: (segmentId: string) => void;
  onOpenSettings: () => void;
}

const PANEL_COUNT_OPTIONS = [4, 5, 6, 7] as const;

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isAuthOrConfigError = (msg: string) =>
  /401|403|api key|unauthorized|invalid.*key|tidak memiliki|belum dikonfigurasi/i.test(msg);

export default function StoryboardStep({
  project,
  sb,
  textProfile,
  imageProfile,
  onPatchSb,
  onSyncDiscoveredModels,
  onGoToAnimate,
  onAnimateSegment,
  onOpenSettings,
}: StoryboardStepProps) {
  const segments = useMemo(() => getStoryboardSegments(sb), [sb]);
  const orderedFrames = useMemo(() => reindexStoryboardFrames(sb.frames, segments), [sb.frames, segments]);

  const [viewMode, setViewMode] = useState<"editor" | "cards">("editor");
  const [previewLayout, setPreviewLayout] = useState<"strip" | "detail">("strip");
  const [activeSegmentId, setActiveSegmentId] = useState<string>(() => segments[0]?.id ?? "");
  const [activeFrameId, setActiveFrameId] = useState<string | null>(() => {
    const firstSeg = segments[0];
    if (!firstSeg) return null;
    const list = getSegmentFrames(sb, firstSeg.id, 0);
    return list[list.length - 1]?.id ?? null;
  });
  const [busy, setBusy] = useState("");
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoProgress, setAutoProgress] = useState<{
    done: number;
    total: number;
    segIndex: number;
    totalSegs: number;
    panelNum: number;
    segTarget: number;
    phase: "planning" | "drawing" | "retrying";
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copyFeedback, setCopyFeedback] = useState("");
  const [continueNote, setContinueNote] = useState("");
  const [autoGenOnContinue, setAutoGenOnContinue] = useState(true);
  const [quickEditText, setQuickEditText] = useState("");
  const [showScriptDrawer, setShowScriptDrawer] = useState(false);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [flowImageModel, setFlowImageModel] = useState<FlowConnectorImageModel>(() => loadPreferredFlowImageModel());
  const [includeExistingFlow, setIncludeExistingFlow] = useState(false);
  const [watchFolderName, setWatchFolderName] = useState("");
  const [folderWatchSupported, setFolderWatchSupported] = useState(false);

  const dirtyPromptIdsRef = useRef<Set<string>>(new Set());
  const autoStopRef = useRef(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const batchPanelInputRef = useRef<HTMLInputElement>(null);
  const watchDirHandleRef = useRef<FsDirHandleLike | null>(null);
  const seenFilesRef = useRef<Set<string>>(new Set());
  const pendingFileSizesRef = useRef<Map<string, number>>(new Map());
  const watchStartedAtRef = useRef<number>(0);

  const latestSbRef = useRef<StoryboardData>(sb);
  latestSbRef.current = sb;

  const flowFolderSlug = useMemo(() => buildFlowImageFolderSlug(project.name, "panels"), [project.name]);

  useEffect(() => {
    setFolderWatchSupported(typeof window !== "undefined" && "showDirectoryPicker" in window);
  }, []);

  const selectFlowImageModel = (nextModel: FlowConnectorImageModel) => {
    setFlowImageModel(nextModel);
    try {
      window.localStorage.setItem(FLOW_IMAGE_MODEL_STORAGE_KEY, nextModel);
    } catch {
      // ignore storage errors
    }
  };

  // Approved assets only (fallback to all assets if user bypassed with manual edits)
  const approvedAssets = useMemo(() => {
    const acc = sb.assets.filter((a) => a.approved);
    return acc.length > 0 ? acc : sb.assets;
  }, [sb.assets]);

  // Keep activeSegmentId valid when segments list changes
  useEffect(() => {
    if (segments.length > 0 && !segments.some((s) => s.id === activeSegmentId)) {
      setActiveSegmentId(segments[0].id);
    }
  }, [segments, activeSegmentId]);

  const activeSegmentIdx = Math.max(
    0,
    segments.findIndex((s) => s.id === activeSegmentId),
  );
  const activeSegment = segments[activeSegmentIdx] ?? segments[0];
  const nextSegment = activeSegmentIdx + 1 < segments.length ? segments[activeSegmentIdx + 1] : null;

  const activeSegmentFrames = useMemo(() => {
    if (!activeSegment) return [];
    return orderedFrames.filter((f) => f.segmentId === activeSegment.id);
  }, [orderedFrames, activeSegment]);

  const activeFrame = useMemo(() => {
    if (!activeSegmentFrames.length) return null;
    return (
      activeSegmentFrames.find((f) => f.id === activeFrameId) ??
      activeSegmentFrames[activeSegmentFrames.length - 1]
    );
  }, [activeSegmentFrames, activeFrameId]);

  const activeSegPos = activeFrame ? activeSegmentFrames.findIndex((f) => f.id === activeFrame.id) : -1;
  const activePanelNum = activeFrame ? activeFrame.panelNumber ?? activeSegPos + 1 : 0;
  const activeGlobalIdx = activeFrame ? orderedFrames.findIndex((f) => f.id === activeFrame.id) : -1;
  const previousFrame = activeGlobalIdx > 0 ? orderedFrames[activeGlobalIdx - 1] : null;

  // Keep activeFrameId synced to active segment's frames
  useEffect(() => {
    if (activeSegmentFrames.length === 0) {
      if (activeFrameId !== null) setActiveFrameId(null);
    } else if (!activeFrameId || !activeSegmentFrames.some((f) => f.id === activeFrameId)) {
      setActiveFrameId(activeSegmentFrames[activeSegmentFrames.length - 1].id);
    }
  }, [activeSegmentFrames, activeFrameId]);

  // Lightbox keyboard navigation (Left / Right / Escape) across ALL panels
  useEffect(() => {
    if (lightboxIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxIdx(null);
      if (e.key === "ArrowLeft") setLightboxIdx((i) => (i !== null && i > 0 ? i - 1 : i));
      if (e.key === "ArrowRight") {
        setLightboxIdx((i) => (i !== null && i < orderedFrames.length - 1 ? i + 1 : i));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIdx, orderedFrames.length]);

  const commitFrames = (
    nextFrames: StoryFrame[],
    extra?: Partial<StoryboardData>,
    segmentsOverride?: StorySegment[],
  ) => {
    const segs = segmentsOverride ?? getStoryboardSegments(latestSbRef.current);
    const clean = reindexStoryboardFrames(nextFrames, segs);
    const nextSb: StoryboardData = {
      ...latestSbRef.current,
      segments: segs,
      frames: clean,
      ...extra,
    };
    latestSbRef.current = nextSb;
    onPatchSb({ segments: segs, frames: clean, ...extra });
    return clean;
  };

  const updateFrame = (frameId: string, patch: Partial<StoryFrame>) => {
    const next = latestSbRef.current.frames.map((f) => (f.id === frameId ? { ...f, ...patch } : f));
    commitFrames(next);
  };

  const handleSelectSegment = (segId: string) => {
    setActiveSegmentId(segId);
    const targetIdx = segments.findIndex((s) => s.id === segId);
    const segFrames = getSegmentFrames(latestSbRef.current, segId, Math.max(0, targetIdx));
    setActiveFrameId(segFrames[segFrames.length - 1]?.id ?? null);
    setQuickEditText("");
    setError("");
  };

  const handleChangeSegmentTargetPanels = (segId: string, targetPanels: number) => {
    const segs = getStoryboardSegments(latestSbRef.current).map((s) =>
      s.id === segId ? { ...s, targetPanels: clampTargetPanels(targetPanels) } : s,
    );
    latestSbRef.current = { ...latestSbRef.current, segments: segs };
    onPatchSb({ segments: segs });
  };

  const toggleFrameAsset = (frame: StoryFrame, assetId: string) => {
    const has = frame.assetIds.includes(assetId);
    const nextIds = has ? frame.assetIds.filter((id) => id !== assetId) : [...frame.assetIds, assetId];
    updateFrame(frame.id, { assetIds: nextIds });
  };

  // Generate artwork for a single panel using FLUX.2 Klein 4B + <512x512 resized ACC references
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

    const segs = getStoryboardSegments(curSb);
    const ordered = reindexStoryboardFrames(curSb.frames, segs);
    const idx = ordered.findIndex((f) => f.id === workingFrame.id);
    const prev = idx > 0 ? ordered[idx - 1] : null;
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
      throw new Error(res.error || `Gagal generate gambar Panel ${targetFrame.panelNumber ?? targetFrame.index}.`);
    }

    const optimizedImg = await compressImageForStorage(res.image, { maxSide: 1280, quality: 0.84 });
    const candId = uid();
    const updatedFrames = latestSbRef.current.frames.map((f) => {
      if (f.id !== targetFrame.id) return f;
      const merged = [
        ...f.candidates,
        {
          id: candId,
          dataUrl: optimizedImg,
          model: res.usedModel ? res.usedModel.split("/").pop() : "flux-2-klein-4b",
          promptUsed: composed.prompt,
          createdAt: Date.now(),
        },
      ];
      return {
        ...f,
        candidates: trimCandidates(merged, candId, 3),
        selectedCandidateId: candId,
      };
    });
    commitFrames(updatedFrames);
    return { model: res.usedModel, refCount: resizedRefs.length };
  };

  const handleGenerateActiveImage = async () => {
    if (!activeFrame || !activeSegment) return;
    setBusy(
      `Menggambar Segmen ${activeSegment.index} · Panel ${activePanelNum} dengan FLUX.2 Klein 4B...`,
    );
    setError("");
    setNotice("");
    try {
      const out = await runGenerateFrameImage(activeFrame, latestSbRef.current);
      setNotice(
        `Gambar Segmen ${activeSegment.index} · Panel ${activePanelNum} selesai${out.model ? ` (${out.model.split("/").pop()})` : ""}${out.refCount ? ` · ${out.refCount} acuan aset ACC aktif` : ""}.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  // CORE FLOW: Continue -> Build Panel 1..K (4-7 panels) sequentially for the active Segment
  const handleContinueNextFrame = async (targetSegmentOverride?: StorySegment) => {
    const curSb = latestSbRef.current;
    const segs = getStoryboardSegments(curSb);
    const seg =
      targetSegmentOverride ??
      segs.find((s) => s.id === activeSegmentId) ??
      segs[0];
    if (!seg) return;

    const segIdx = Math.max(0, segs.findIndex((s) => s.id === seg.id));
    if (!curSb.scriptText.trim() && !seg.scriptContent.trim()) {
      setError("Naskah kosong. Kembali ke Tahap 1 untuk mengisi naskah terlebih dahulu.");
      return;
    }

    const orderedBefore = reindexStoryboardFrames(curSb.frames, segs);
    const segFramesBefore = orderedBefore.filter((f) => f.segmentId === seg.id);
    const nextPanelNum = segFramesBefore.length + 1;
    const targetPanels = clampTargetPanels(seg.targetPanels);

    setBusy(
      `Menyusun Panel ${nextPanelNum}/${targetPanels} untuk Segmen ${seg.index} ("${seg.title}")...`,
    );
    setError("");
    setNotice("");
    try {
      const built = buildNextFramePrompt({
        projectName: project.name,
        scriptText: curSb.scriptText,
        visualStyle: curSb.visualStyle,
        aspectRatio: curSb.aspectRatio,
        approvedAssets,
        previousFrames: orderedBefore,
        activeSegment: seg,
        segmentFrames: segFramesBefore,
        totalSegments: segs.length,
        userDirection: targetSegmentOverride ? "" : continueNote,
      });
      const res = await callAi(textProfile, "text", built);
      if (res.discovered) onSyncDiscoveredModels(textProfile.id, res.discovered);
      if (!res.ok || !res.text) {
        throw new Error(res.error || `Gagal menyusun Panel ${nextPanelNum} dari AI.`);
      }

      const { frame, segmentFinished, storyFinished } = parseNextFrameResponse(
        res.text,
        approvedAssets,
        orderedBefore,
        { activeSegment: seg, segmentFrames: segFramesBefore },
      );

      const cleanFrames = commitFrames([...orderedBefore, frame], { storyFinished }, segs);
      const indexedNewFrame = cleanFrames.find((f) => f.id === frame.id) ?? frame;
      const nextSb: StoryboardData = {
        ...latestSbRef.current,
        segments: segs,
        frames: cleanFrames,
        storyFinished,
      };
      setActiveSegmentId(seg.id);
      setActiveFrameId(indexedNewFrame.id);
      setContinueNote("");
      setViewMode("editor");

      const followingSeg = segIdx + 1 < segs.length ? segs[segIdx + 1] : null;

      if (autoGenOnContinue) {
        setBusy(
          `Panel ${nextPanelNum}/${targetPanels} (Segmen ${seg.index}) tersusun — menggambar dengan FLUX.2 Klein 4B...`,
        );
        try {
          await runGenerateFrameImage(indexedNewFrame, nextSb);
        } catch (firstErr) {
          const msg = (firstErr as Error).message || "";
          if (isAuthOrConfigError(msg)) throw firstErr;
          setBusy(`Mengulang gambar Segmen ${seg.index} · Panel ${nextPanelNum} (FLUX.2 Klein 4B)...`);
          await sleepMs(1500);
          await runGenerateFrameImage(indexedNewFrame, latestSbRef.current);
        }
        if (storyFinished) {
          setNotice(
            `Panel ${nextPanelNum}/${targetPanels} (penutup cerita) selesai digambar! Buka tab Preview Strip untuk melihat papan storyboard lengkap.`,
          );
        } else if (segmentFinished && followingSeg) {
          setNotice(
            `Segmen ${seg.index} selesai (${nextPanelNum}/${targetPanels} panel)! Klik "Generate Semua Sisa" untuk menyelesaikan seluruh segmen otomatis.`,
          );
        } else {
          setNotice(
            `Segmen ${seg.index} · Panel ${nextPanelNum}/${targetPanels} berhasil dibuat & digambar.`,
          );
        }
      } else {
        if (storyFinished) {
          setNotice(
            `Draft Panel ${nextPanelNum}/${targetPanels} (penutup cerita) siap. Periksa aset ACC lalu klik Generate Gambar (4B).`,
          );
        } else if (segmentFinished && followingSeg) {
          setNotice(
            `Draft Panel ${nextPanelNum}/${targetPanels} (penutup Segmen ${seg.index}) siap. Generate gambarnya, lalu lanjut ke Segmen ${followingSeg.index}.`,
          );
        } else {
          setNotice(
            `Draft Segmen ${seg.index} · Panel ${nextPanelNum}/${targetPanels} siap. Cek aksi & aset ACC, lalu klik Generate Gambar (4B).`,
          );
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const handleQuickEditFrame = async () => {
    if (!activeFrame || !activeSegment) return;
    const instruction = quickEditText.trim();
    const currentImg = getSelectedFrameImage(activeFrame);
    if (!instruction) {
      setError("Tulis instruksi revisi singkat terlebih dahulu.");
      return;
    }
    if (!currentImg) {
      setError("Generate gambar panel terlebih dahulu sebelum revisi gambar.");
      return;
    }

    setBusy(`Merevisi gambar Segmen ${activeSegment.index} · Panel ${activePanelNum} dengan FLUX.2 Klein 4B...`);
    setError("");
    setNotice("");
    try {
      const built = buildQuickEditPrompt({
        mode: "frame",
        label: `Segmen ${activeSegment.index} Panel ${activePanelNum}: ${activeFrame.title}`,
        currentVisualDesc: activeFrame.visualPrompt || activeFrame.sceneSummary,
        instruction,
        visualStyle: sb.visualStyle,
      });
      const textRes = await callAi(textProfile, "text", built);
      if (textRes.discovered) onSyncDiscoveredModels(textProfile.id, textRes.discovered);
      const parsed = parseQuickEditResponse(textRes.text || "", sb.visualStyle, instruction);

      // image 0 = current panel (resized < 512x512), plus primary character ACC asset as image 1 if available
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
        throw new Error(imgRes.error || `Gagal merevisi Panel ${activePanelNum}.`);
      }

      const optimizedImg = await compressImageForStorage(imgRes.image, { maxSide: 1280, quality: 0.84 });
      const candId = uid();
      const updated = latestSbRef.current.frames.map((f) => {
        if (f.id !== activeFrame.id) return f;
        const merged = [
          ...f.candidates,
          {
            id: candId,
            dataUrl: optimizedImg,
            model: imgRes.usedModel ? `${imgRes.usedModel.split("/").pop()} (edit)` : "edit",
            promptUsed: parsed.editPrompt,
            createdAt: Date.now(),
          },
        ];
        return {
          ...f,
          visualPrompt: parsed.updatedVisualDesc || f.visualPrompt,
          approved: false,
          candidates: trimCandidates(merged, candId, 3),
          selectedCandidateId: candId,
        };
      });
      commitFrames(updated);
      setQuickEditText("");
      setNotice(`Revisi Segmen ${activeSegment.index} · Panel ${activePanelNum} selesai.`);
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
      const rawDataUrl = await fileToDataUrl(file);
      const optimizedImg = await compressImageForStorage(rawDataUrl, { maxSide: 1280, quality: 0.84 });
      const candId = uid();
      const updated = latestSbRef.current.frames.map((f) =>
        f.id === activeFrame.id
          ? {
              ...f,
              candidates: trimCandidates(
                [...f.candidates, { id: candId, dataUrl: optimizedImg, model: "upload", createdAt: Date.now() }],
                candId,
                3,
              ),
              selectedCandidateId: candId,
            }
          : f,
      );
      commitFrames(updated);
      setNotice(`Gambar "${file.name}" dipasang ke Panel ${activePanelNum}.`);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      e.target.value = "";
    }
  };

  const handleAddBlankFrame = () => {
    if (!activeSegment) return;
    const panelNum = activeSegmentFrames.length + 1;
    const blank: StoryFrame = {
      id: uid(),
      segmentId: activeSegment.id,
      panelNumber: panelNum,
      index: orderedFrames.length + 1,
      title: `Panel ${panelNum}`,
      scriptExcerpt: "",
      sceneSummary: "",
      dialogue: "",
      shotSize: "MS",
      cameraAngle: "Front",
      assetIds: [],
      sameLocationAsPrev: panelNum > 1,
      visualPrompt: "",
      approved: false,
      candidates: [],
    };
    commitFrames([...orderedFrames, blank]);
    setActiveFrameId(blank.id);
    setViewMode("editor");
  };

  const handleMoveFrame = (frameId: string, delta: -1 | 1) => {
    if (!activeSegment) return;
    const segList = [...activeSegmentFrames];
    const idx = segList.findIndex((f) => f.id === frameId);
    const target = idx + delta;
    if (idx === -1 || target < 0 || target >= segList.length) return;
    const [moved] = segList.splice(idx, 1);
    segList.splice(target, 0, moved);

    // Rebuild combined list keeping other segments untouched
    const otherFrames = orderedFrames.filter((f) => f.segmentId !== activeSegment.id);
    commitFrames([...otherFrames, ...segList]);
  };

  const handleDeleteFrame = (frameId: string) => {
    const idxInSeg = activeSegmentFrames.findIndex((f) => f.id === frameId);
    const remainingAll = orderedFrames.filter((f) => f.id !== frameId);
    const remainingSeg = activeSegmentFrames.filter((f) => f.id !== frameId);
    commitFrames(remainingAll, { storyFinished: false });
    if (remainingSeg.length === 0) {
      setActiveFrameId(null);
    } else {
      setActiveFrameId(remainingSeg[Math.min(idxInSeg, remainingSeg.length - 1)].id);
    }
  };

  const handleOptionalDownloadZip = () => {
    const bytes = buildStoryboardZip({
      ...project,
      storyboard: { ...sb, segments, frames: orderedFrames },
    });
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const safeName =
      (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") +
      "-storyboard.zip";
    downloadBlob(new Blob([copy], { type: "application/zip" }), safeName);
  };

  // True 1-Tap Automation: plan + draw FLUX.2 4B panels continuously across ALL segments (or a single segment)
  // Supports `planOnly: true` (text AI only, zero image quota!) for seamless Flow Connector Nano Banana 2 Lite workflow.
  const handleAutoGenerateAllSegments = async (options?: {
    onlySingleSegment?: boolean;
    targetSegment?: StorySegment;
    initialDirection?: string;
    planOnly?: boolean;
  }) => {
    const onlySingle = Boolean(options?.onlySingleSegment);
    const planOnly = Boolean(options?.planOnly);
    const curSb0 = latestSbRef.current;
    const allSegs0 = getStoryboardSegments(curSb0);
    const targetSegments = onlySingle
      ? [options?.targetSegment ?? activeSegment ?? allSegs0[0]].filter((s): s is StorySegment => Boolean(s))
      : allSegs0;

    if (targetSegments.length === 0) return;
    if (!curSb0.scriptText.trim() && targetSegments.every((s) => !s.scriptContent.trim())) {
      setError("Naskah kosong. Kembali ke Tahap 1 untuk mengisi naskah terlebih dahulu.");
      return;
    }

    // Calculate total panels we expect to draft/draw across the chosen scope
    const ordered0 = reindexStoryboardFrames(curSb0.frames, allSegs0);
    let totalWork = 0;
    for (const seg of targetSegments) {
      const segFrames = ordered0.filter((f) => f.segmentId === seg.id);
      const target = clampTargetPanels(seg.targetPanels);
      const undrawn = planOnly ? 0 : segFrames.filter((f) => !getSelectedFrameImage(f)).length;
      const missing = Math.max(0, target - segFrames.length);
      totalWork += undrawn + missing;
    }

    if (totalWork === 0) {
      setNotice(
        planOnly
          ? `Semua draft panel di seluruh ${allSegs0.length} segmen sudah tersusun! Unduh Paket Gambar Panel (.zip) untuk menggambar lewat Flow Connector.`
          : onlySingle
            ? `Segmen ${targetSegments[0].index} sudah lengkap semua panel & gambarnya.`
            : `Seluruh ${allSegs0.length} segmen sudah lengkap semua panel & gambarnya!`,
      );
      return;
    }

    autoStopRef.current = false;
    setAutoRunning(true);
    setError("");
    setNotice("");

    let doneCount = 0;
    let firstDirection = (options?.initialDirection ?? "").trim();
    if (firstDirection) setContinueNote("");

    let lastSegIndex = targetSegments[0].index;
    let lastPanelNum = 1;

    try {
      for (const seg of targetSegments) {
        if (autoStopRef.current) break;
        const targetPanels = clampTargetPanels(seg.targetPanels);
        lastSegIndex = seg.index;

        while (!autoStopRef.current) {
          const curSb = latestSbRef.current;
          const segs = getStoryboardSegments(curSb);
          const orderedNow = reindexStoryboardFrames(curSb.frames, segs);
          const segFramesNow = orderedNow.filter((f) => f.segmentId === seg.id);

          // 1. Unless planOnly is set, render any existing panel in this segment that still has no image
          if (!planOnly) {
            const undrawn = segFramesNow.find((f) => !getSelectedFrameImage(f));
            if (undrawn) {
              const pNum = undrawn.panelNumber ?? 1;
              lastPanelNum = pNum;
              setActiveSegmentId(seg.id);
              setActiveFrameId(undrawn.id);
              setAutoProgress({
                done: doneCount,
                total: totalWork,
                segIndex: seg.index,
                totalSegs: segs.length,
                panelNum: pNum,
                segTarget: targetPanels,
                phase: "drawing",
              });
              setBusy(
                `Auto (${doneCount + 1}/${totalWork}) · Segmen ${seg.index}/${segs.length} · Menggambar Panel ${pNum}/${targetPanels} (FLUX.2 4B)...`,
              );

              try {
                await runGenerateFrameImage(undrawn, curSb);
              } catch (firstErr) {
                const msg = (firstErr as Error).message || "";
                if (autoStopRef.current || isAuthOrConfigError(msg)) throw firstErr;
                setAutoProgress({
                  done: doneCount,
                  total: totalWork,
                  segIndex: seg.index,
                  totalSegs: segs.length,
                  panelNum: pNum,
                  segTarget: targetPanels,
                  phase: "retrying",
                });
                setBusy(`Koneksi sempat terputus — mengulang gambar Segmen ${seg.index} · Panel ${pNum}...`);
                await sleepMs(1500);
                if (autoStopRef.current) break;
                await runGenerateFrameImage(undrawn, latestSbRef.current);
              }

              doneCount += 1;
              continue;
            }
          }

          // 2. Segment already has all target panels -> automatically advance to next segment!
          if (segFramesNow.length >= targetPanels) break;

          // 3. Plan next panel (and draw its FLUX.2 4B image unless planOnly)
          const nextPanelNum = segFramesNow.length + 1;
          lastPanelNum = nextPanelNum;
          setActiveSegmentId(seg.id);
          setAutoProgress({
            done: doneCount,
            total: totalWork,
            segIndex: seg.index,
            totalSegs: segs.length,
            panelNum: nextPanelNum,
            segTarget: targetPanels,
            phase: "planning",
          });
          setBusy(
            `${planOnly ? "Draft Teks" : "Auto"} (${doneCount + 1}/${totalWork}) · Segmen ${seg.index}/${segs.length} · Menyusun Panel ${nextPanelNum}/${targetPanels}...`,
          );

          const built = buildNextFramePrompt({
            projectName: project.name,
            scriptText: curSb.scriptText,
            visualStyle: curSb.visualStyle,
            aspectRatio: curSb.aspectRatio,
            approvedAssets,
            previousFrames: orderedNow,
            activeSegment: seg,
            segmentFrames: segFramesNow,
            totalSegments: segs.length,
            userDirection: firstDirection,
          });
          firstDirection = "";

          let res = await callAi(textProfile, "text", built);
          if (res.discovered) onSyncDiscoveredModels(textProfile.id, res.discovered);
          if ((!res.ok || !res.text) && !autoStopRef.current && !isAuthOrConfigError(res.error || "")) {
            setBusy(`Mengulang penyusunan Segmen ${seg.index} · Panel ${nextPanelNum}...`);
            await sleepMs(1500);
            if (!autoStopRef.current) {
              res = await callAi(textProfile, "text", built);
              if (res.discovered) onSyncDiscoveredModels(textProfile.id, res.discovered);
            }
          }
          if (!res.ok || !res.text) {
            throw new Error(res.error || `Gagal menyusun Segmen ${seg.index} · Panel ${nextPanelNum}.`);
          }

          const { frame, storyFinished } = parseNextFrameResponse(res.text, approvedAssets, orderedNow, {
            activeSegment: seg,
            segmentFrames: segFramesNow,
          });

          const cleanFrames = commitFrames([...orderedNow, frame], { storyFinished }, segs);
          const indexedFrame = cleanFrames.find((f) => f.id === frame.id) ?? frame;
          const nextSb: StoryboardData = {
            ...latestSbRef.current,
            segments: segs,
            frames: cleanFrames,
            storyFinished,
          };
          setActiveSegmentId(seg.id);
          setActiveFrameId(indexedFrame.id);

          if (autoStopRef.current) break;

          if (planOnly) {
            doneCount += 1;
            continue;
          }

          setAutoProgress({
            done: doneCount,
            total: totalWork,
            segIndex: seg.index,
            totalSegs: segs.length,
            panelNum: nextPanelNum,
            segTarget: targetPanels,
            phase: "drawing",
          });
          setBusy(
            `Auto (${doneCount + 1}/${totalWork}) · Segmen ${seg.index}/${segs.length} · Menggambar Panel ${nextPanelNum}/${targetPanels} (FLUX.2 4B)...`,
          );

          try {
            await runGenerateFrameImage(indexedFrame, nextSb);
          } catch (firstErr) {
            const msg = (firstErr as Error).message || "";
            if (autoStopRef.current || isAuthOrConfigError(msg)) throw firstErr;
            setAutoProgress({
              done: doneCount,
              total: totalWork,
              segIndex: seg.index,
              totalSegs: segs.length,
              panelNum: nextPanelNum,
              segTarget: targetPanels,
              phase: "retrying",
            });
            setBusy(`Koneksi sempat terputus — mengulang gambar Segmen ${seg.index} · Panel ${nextPanelNum}...`);
            await sleepMs(1500);
            if (autoStopRef.current) break;
            await runGenerateFrameImage(indexedFrame, latestSbRef.current);
          }

          doneCount += 1;
        }
      }

      if (autoStopRef.current) {
        setNotice(
          `${planOnly ? "Penyusunan draft" : "Auto-generate"} dijeda (${doneCount}/${totalWork} panel selesai & tersimpan).`,
        );
      } else if (planOnly) {
        setNotice(
          `Selesai menyusun draft ${doneCount} panel baru (Teks saja · bebas kuota gambar)! Unduh Paket Gambar Panel (.zip) di kotak Flow Connector untuk menggambar semua panel pakai Nano Banana 2 Lite (0 kredit Flow).`,
        );
      } else if (onlySingle) {
        setNotice(
          `Segmen ${targetSegments[0].index} selesai lengkap (${clampTargetPanels(targetSegments[0].targetPanels)} panel tergambar)!`,
        );
      } else {
        onPatchSb({ storyFinished: true });
        setNotice(
          `Selesai! Seluruh ${allSegs0.length} segmen (${doneCount} panel baru) berhasil disusun & digambar otomatis. Cek Preview Strip atau lanjut ke Tahap 4 Animasi!`,
        );
      }
    } catch (err) {
      setError(
        `Terhenti di Segmen ${lastSegIndex} · Panel ${lastPanelNum}: ${(err as Error).message}. Progress sebelumnya aman tersimpan.`,
      );
    } finally {
      setAutoRunning(false);
      setAutoProgress(null);
      setBusy("");
    }
  };

  const handleAutoGenerateSegment = async (targetSegOverride?: StorySegment) => {
    await handleAutoGenerateAllSegments({
      onlySingleSegment: true,
      targetSegment: targetSegOverride ?? activeSegment,
    });
  };

  const handleStopAutoSegment = () => {
    autoStopRef.current = true;
    setNotice("Menghentikan setelah panel yang sedang diproses selesai...");
  };

  // =========================================================================
  // FLOW CONNECTOR (NANO BANANA 2 LITE · 0 KREDIT) + AUTO-WATCH DOWNLOADS
  // =========================================================================
  const attachImageFileToFrame = async (
    frame: StoryFrame,
    file: File,
    modelLabel: string,
    customNotice?: string,
  ) => {
    const rawDataUrl = await fileToDataUrl(file);
    const optimizedImg = await compressImageForStorage(rawDataUrl, { maxSide: 1280, quality: 0.84 });
    const candId = uid();
    const updated = latestSbRef.current.frames.map((f) =>
      f.id === frame.id
        ? {
            ...f,
            candidates: trimCandidates(
              [...f.candidates, { id: candId, dataUrl: optimizedImg, model: modelLabel, createdAt: Date.now() }],
              candId,
              3,
            ),
            selectedCandidateId: candId,
          }
        : f,
    );
    commitFrames(updated);
    setNotice(customNotice || `Gambar "${file.name}" dipasang ke Panel ${frame.panelNumber ?? frame.index}.`);
    setError("");
  };

  const handleBatchPanelImagesChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
      .filter((f) => f.type.startsWith("image/") || IMAGE_EXT_RE.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    e.target.value = "";
    if (files.length === 0) return;

    const segs = getStoryboardSegments(latestSbRef.current);
    const curOrdered = reindexStoryboardFrames(latestSbRef.current.frames, segs);
    if (curOrdered.length === 0) {
      setError("Susun draft panel terlebih dahulu sebelum memasang gambar panel.");
      return;
    }

    const attachedIds = new Set(curOrdered.filter((f) => Boolean(getSelectedFrameImage(f))).map((f) => f.id));
    const batchUsedIds = new Set<string>();
    let assigned = 0;

    try {
      for (const file of files) {
        const target =
          matchDownloadedImageToSlot(file.name, curOrdered, attachedIds, { allowOverwriteIndexed: true }) ??
          curOrdered.find((f) => !batchUsedIds.has(f.id)) ??
          null;
        if (!target || batchUsedIds.has(target.id)) continue;
        batchUsedIds.add(target.id);
        attachedIds.add(target.id);
        await attachImageFileToFrame(target, file, flowImageModel);
        assigned += 1;
      }
      if (assigned > 0) {
        setNotice(`${assigned} gambar panel berhasil dipasang otomatis sesuai nomor urut!`);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCopyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(key);
      setTimeout(() => setCopyFeedback(""), 2200);
    } catch {
      setError("Gagal menyalin ke clipboard.");
    }
  };

  const collectImageEntries = async (
    rootDir: FsDirHandleLike,
  ): Promise<Array<{ file: File; folderLabel: string; sigKey: string }>> => {
    const out: Array<{ file: File; folderLabel: string; sigKey: string }> = [];
    const scanOneDir = async (dir: FsDirHandleLike, prefix: string) => {
      for await (const entry of dir.values()) {
        if (entry.kind === "file") {
          const name = entry.name || "";
          if (!IMAGE_EXT_RE.test(name) || name.startsWith(".") || name.endsWith(".crdownload")) continue;
          const file = await (entry as FsFileHandleLike).getFile().catch(() => null);
          if (!file || file.size === 0) continue;
          const folderLabel = prefix ? `${rootDir.name}/${prefix}` : rootDir.name;
          out.push({ file, folderLabel, sigKey: `${prefix}/${file.name}` });
        } else if (entry.kind === "directory" && !prefix) {
          const subName = entry.name || "";
          if (!subName || subName.startsWith(".")) continue;
          try {
            await scanOneDir(entry as FsDirHandleLike, subName);
          } catch {
            // Skip unreadable subfolder
          }
        }
      }
    };
    await scanOneDir(rootDir, "");
    return out;
  };

  const scanWatchedFolder = async () => {
    const dir = watchDirHandleRef.current;
    if (!dir) return;
    try {
      const entries = await collectImageEntries(dir);
      const freshItems: Array<{ file: File; folderLabel: string }> = [];

      for (const { file, folderLabel, sigKey } of entries) {
        const sig = `${sigKey}:${file.lastModified}:${file.size}`;
        if (seenFilesRef.current.has(sig)) continue;
        if (file.lastModified < watchStartedAtRef.current - 5000) {
          seenFilesRef.current.add(sig);
          continue;
        }
        const prevSize = pendingFileSizesRef.current.get(sigKey);
        if (prevSize !== file.size && Date.now() - file.lastModified < 1500) {
          pendingFileSizesRef.current.set(sigKey, file.size);
          continue;
        }
        pendingFileSizesRef.current.delete(sigKey);
        seenFilesRef.current.add(sig);
        freshItems.push({ file, folderLabel });
      }

      if (freshItems.length === 0) return;
      freshItems.sort((a, b) => a.file.lastModified - b.file.lastModified);

      const segs = getStoryboardSegments(latestSbRef.current);
      const curOrdered = reindexStoryboardFrames(latestSbRef.current.frames, segs);
      const attachedIds = new Set(curOrdered.filter((f) => Boolean(getSelectedFrameImage(f))).map((f) => f.id));
      const scanMatchedIds = new Set<string>();

      for (const { file, folderLabel } of freshItems) {
        const target = matchDownloadedImageToSlot(file.name, curOrdered, attachedIds, {
          allowOverwriteIndexed: true,
        });
        if (!target || scanMatchedIds.has(target.id)) continue;
        scanMatchedIds.add(target.id);
        attachedIds.add(target.id);
        const seg = segs.find((s) => s.id === target.segmentId);
        await attachImageFileToFrame(
          target,
          file,
          flowImageModel,
          `Otomatis terpasang dari "${folderLabel}": "${file.name}" → Segmen ${seg?.index ?? 1} · Panel ${target.panelNumber ?? target.index}!`,
        );
      }
    } catch {
      // Permission revoked or folder unavailable
    }
  };

  const handleEnableFolderWatch = async () => {
    const picker = (window as WindowWithDirPicker).showDirectoryPicker;
    if (!picker) {
      setError("Browser ini belum mendukung pantau folder otomatis (tersedia di Chrome/Edge Desktop).");
      return;
    }
    try {
      const dir = await picker({
        id: "nmcgen-flow-panels",
        mode: "read",
        startIn: "downloads",
      });
      const existing = await collectImageEntries(dir);
      const snapshot = new Set<string>();
      for (const item of existing) {
        snapshot.add(`${item.sigKey}:${item.file.lastModified}:${item.file.size}`);
      }
      seenFilesRef.current = snapshot;
      pendingFileSizesRef.current.clear();
      watchStartedAtRef.current = Date.now();
      watchDirHandleRef.current = dir;
      setWatchFolderName(dir.name || "Downloads");
      setError("");
      setNotice(
        `Pantau otomatis "${dir.name || "Downloads"}" (+ subfolder "${flowFolderSlug}") aktif! Gambar panel baru dari Flow Connector langsung menempel sesuai nomor urut.`,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(`Gagal mengaktifkan pantau folder: ${(err as Error).message}`);
      }
    }
  };

  const handleStopFolderWatch = () => {
    watchDirHandleRef.current = null;
    setWatchFolderName("");
    setNotice("Pantau folder Downloads panel dimatikan.");
  };

  useEffect(() => {
    if (!watchFolderName) return;
    const timer = window.setInterval(() => {
      void scanWatchedFolder();
    }, 2500);
    const onReturn = () => {
      if (document.visibilityState !== "hidden") void scanWatchedFolder();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchFolderName, flowImageModel]);

  const handleExportSegmentStrip = async (seg: StorySegment) => {
    const segFrames = orderedFrames.filter((f) => f.segmentId === seg.id);
    if (segFrames.length === 0) {
      setError(`Belum ada panel di Segmen ${seg.index} untuk diunduh.`);
      return;
    }
    setBusy(`Merender gambar Papan Strip Segmen ${seg.index}...`);
    setError("");
    try {
      const blob = await renderSegmentStripImageBlob({
        segmentIndex: seg.index,
        segmentTitle: seg.title,
        locationHint: seg.locationHint,
        aspectRatio: sb.aspectRatio,
        panels: segFrames.map((f, idx) => ({
          panelNumber: f.panelNumber ?? idx + 1,
          title: f.title,
          imageDataUrl: getSelectedFrameImage(f),
        })),
      });
      const slug =
        (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") +
        `-segmen-${String(seg.index).padStart(2, "0")}-strip.jpg`;
      downloadBlob(blob, slug);
      setNotice(`Papan Strip Segmen ${seg.index} (${segFrames.length} panel) berhasil diunduh!`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const handleExportAllStrips = async () => {
    const populated = segments.filter((s) => orderedFrames.some((f) => f.segmentId === s.id));
    if (populated.length === 0) return;
    for (const seg of populated) {
      await handleExportSegmentStrip(seg);
    }
  };

  const handleApproveSegment = (seg: StorySegment) => {
    const curSb = latestSbRef.current;
    const segs = getStoryboardSegments(curSb);
    const ordered = reindexStoryboardFrames(curSb.frames, segs);
    const segFrames = ordered.filter((f) => f.segmentId === seg.id && Boolean(getSelectedFrameImage(f)));
    if (segFrames.length === 0) {
      setError(`Belum ada gambar panel di Segmen ${seg.index} untuk di-ACC.`);
      return;
    }
    const updated = ordered.map((f) =>
      f.segmentId === seg.id && getSelectedFrameImage(f) ? { ...f, approved: true } : f,
    );
    commitFrames(updated, undefined, segs);
    setError("");
    setNotice(
      `Semua ${segFrames.length} panel di Segmen ${seg.index} sudah ACC! Klik "Animasikan Segmen ${seg.index} (Omni 1.2)" untuk langsung render video tanpa upload manual.`,
    );
  };

  const handleApproveAndAnimateSegment = (seg: StorySegment) => {
    const curSb = latestSbRef.current;
    const segs = getStoryboardSegments(curSb);
    const ordered = reindexStoryboardFrames(curSb.frames, segs);
    const segDrawn = ordered.filter((f) => f.segmentId === seg.id && Boolean(getSelectedFrameImage(f)));
    if (segDrawn.length === 0) {
      setError(`Generate minimal 1 gambar panel di Segmen ${seg.index} dulu sebelum menganimasikan ke Omni 1.2.`);
      return;
    }
    const updated = ordered.map((f) =>
      f.segmentId === seg.id && getSelectedFrameImage(f) ? { ...f, approved: true } : f,
    );
    commitFrames(updated, undefined, segs);
    setError("");
    if (onAnimateSegment) {
      onAnimateSegment(seg.id);
    } else if (onGoToAnimate) {
      onGoToAnimate();
    }
  };

  const activeImg = activeFrame ? getSelectedFrameImage(activeFrame) : null;
  const activeComposed = useMemo(
    () => (activeFrame ? composeStoryboardFramePrompt(activeFrame, sb, previousFrame) : null),
    [activeFrame, sb, previousFrame],
  );
  const approvedFrameCount = orderedFrames.filter((f) => f.approved).length;
  const totalTargetPanels = segments.reduce((sum, s) => sum + clampTargetPanels(s.targetPanels), 0);
  const activeSegTarget = activeSegment ? clampTargetPanels(activeSegment.targetPanels) : 5;
  const activeSegUndrawn = activeSegmentFrames.filter((f) => !getSelectedFrameImage(f)).length;
  const activeSegNeed = Math.max(0, activeSegTarget - activeSegmentFrames.length) + activeSegUndrawn;
  const activeSegCompleted = activeSegmentFrames.length >= activeSegTarget && activeSegUndrawn === 0;
  const activeSegAllApproved =
    activeSegCompleted && activeSegmentFrames.length > 0 && activeSegmentFrames.every((f) => f.approved);
  const segmentVideoStatusMap = useMemo(() => {
    const map = new Map<string, StoryboardData["animationClips"] extends Array<infer T> | undefined ? T : never>();
    for (const c of sb.animationClips ?? []) {
      if (c.segmentId && c.mode === "segment") map.set(c.segmentId, c);
    }
    return map;
  }, [sb.animationClips]);

  const remainingStats = useMemo(() => {
    let remainingPanels = 0;
    let remainingSegments = 0;
    let drawnPanels = 0;
    let totalPanels = 0;
    let unplannedPanels = 0;
    let undrawnPanels = 0;

    for (const seg of segments) {
      const segFrames = orderedFrames.filter((f) => f.segmentId === seg.id);
      const target = clampTargetPanels(seg.targetPanels);
      const drawn = segFrames.filter((f) => Boolean(getSelectedFrameImage(f))).length;
      const undrawn = segFrames.length - drawn;
      const missing = Math.max(0, target - segFrames.length);
      const need = undrawn + missing;
      drawnPanels += drawn;
      undrawnPanels += undrawn;
      unplannedPanels += missing;
      totalPanels += Math.max(target, segFrames.length);
      remainingPanels += need;
      if (need > 0) remainingSegments += 1;
    }

    return { remainingPanels, remainingSegments, drawnPanels, totalPanels, unplannedPanels, undrawnPanels };
  }, [segments, orderedFrames]);

  const effectiveOnlyMissingPanels = !includeExistingFlow && remainingStats.undrawnPanels > 0;

  const handleDownloadFlowPanelsZip = () => {
    if (orderedFrames.length === 0) {
      setError("Susun minimal 1 draft panel terlebih dahulu (klik Susun Draft Semua Panel — Teks Saja).");
      return;
    }
    const pack = buildFlowStoryboardImagePackZip(
      project.name,
      { ...sb, segments, frames: orderedFrames },
      { model: flowImageModel, onlyMissing: effectiveOnlyMissingPanels },
    );
    if (pack.jobCount === 0) {
      setNotice("Semua panel sudah bergambar. Centang opsi sertakan panel lama jika ingin render ulang.");
      return;
    }
    const copy = new Uint8Array(pack.zipBytes.byteLength);
    copy.set(pack.zipBytes);
    const safeSlug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen";
    downloadBlob(new Blob([copy], { type: "application/zip" }), `${safeSlug}-flow-panels-${flowImageModel}.zip`);
    setError("");
    setNotice(
      `Paket Flow Connector (${pack.jobCount} panel + referensi aset ACC · ${flowImageModel} · 0 kredit Flow) diunduh! Ekstrak lalu jalankan run_flow_images saat tab flow.google.com terbuka.`,
    );
  };

  const handleCopyFlowPanelsAgentPrompt = async () => {
    if (orderedFrames.length === 0) {
      setError("Susun minimal 1 draft panel terlebih dahulu.");
      return;
    }
    const pack = buildFlowStoryboardImagePackZip(
      project.name,
      { ...sb, segments, frames: orderedFrames },
      { model: flowImageModel, onlyMissing: effectiveOnlyMissingPanels },
    );
    await handleCopyText(pack.agentPrompt, "flow-panels-agent");
  };

  const lightboxFrame = lightboxIdx !== null ? orderedFrames[lightboxIdx] ?? null : null;
  const lightboxSegment = lightboxFrame
    ? segments.find((s) => s.id === lightboxFrame.segmentId) ?? segments[0]
    : null;
  const lightboxSegFrames = lightboxSegment
    ? orderedFrames.filter((f) => f.segmentId === lightboxSegment.id)
    : [];

  return (
    <div className="stepContainer">
      <input
        ref={batchPanelInputRef}
        type="file"
        accept="image/*"
        multiple
        className="srOnly"
        onChange={(e) => void handleBatchPanelImagesChange(e)}
      />

      {/* Step header with instant Editor vs Storyboard Strip Preview switcher */}
      <div className="stepIntroRow">
        <div>
          <span className="stepKicker mono">TAHAP 3 DARI 4 · STORYBOARD PER-SEGMEN (4–7 PANEL)</span>
          <h2 className="stepTitle">Storyboard Per-Segmen</h2>
          <p className="stepSubtitle">
            Klik <strong>Generate Semua</strong> untuk menyusun &amp; menggambar otomatis seluruh{" "}
            <strong>{segments.length} segmen ({totalTargetPanels} panel)</strong> dengan{" "}
            <strong>{approvedAssets.length} aset ACC</strong>, atau pakai{" "}
            <strong>Flow Connector (Nano Banana 2 Lite · 0 Kredit)</strong> jika kuota API gambar habis.
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
              <span>Editor Per-Panel</span>
            </button>
            <button
              type="button"
              role="tab"
              className="segBtn"
              aria-selected={viewMode === "cards"}
              onClick={() => setViewMode("cards")}
            >
              <GridIcon size={14} />
              <span>Preview Strip ({orderedFrames.length})</span>
            </button>
          </div>

          {autoRunning ? (
            <button type="button" className="btn btnDanger btnSm" onClick={handleStopAutoSegment}>
              Hentikan Auto
            </button>
          ) : remainingStats.remainingPanels > 0 ? (
            <button
              type="button"
              className="btn btnPrimary btnSm"
              disabled={Boolean(busy)}
              onClick={() => void handleAutoGenerateAllSegments({ onlySingleSegment: false })}
              title="Susun & gambar otomatis seluruh sisa panel di semua segmen"
            >
              <SparklesIcon size={13} />
              <span>Generate Semua ({remainingStats.remainingPanels} Panel)</span>
            </button>
          ) : null}

          <button type="button" className="btn btnSm" onClick={() => setShowScriptDrawer((v) => !v)}>
            {showScriptDrawer ? "Tutup Naskah" : "Lihat Naskah"}
          </button>

          {orderedFrames.length > 0 ? (
            <button
              type="button"
              className="btn btnGhost btnSm"
              onClick={handleOptionalDownloadZip}
              title="Opsional: unduh semua gambar & naskah sebagai ZIP"
            >
              Unduh ZIP
            </button>
          ) : null}

          {orderedFrames.length > 0 && onGoToAnimate ? (
            <button
              type="button"
              className="btn btnOk btnSm"
              onClick={onGoToAnimate}
              title="Animasikan seluruh storyboard lewat Google Flow, Gemini Omni 1.2, atau Animatic Browser"
            >
              <SparklesIcon size={13} />
              <span>Animasikan (Flow / Animatic)</span>
              <ArrowRightIcon size={13} />
            </button>
          ) : null}
        </div>
      </div>

      {/* Collapsible Zero-API-Quota Flow Connector Panel Image Runner (Nano Banana 2 Lite · 0 Flow Credits) */}
      <details className="subtleDetails animateCompactDetails">
        <summary className="animateDetailsSummary">
          <span>Bebas Kuota API: Gambar Semua Panel via Flow Connector (Nano Banana 2 Lite · 0 Kredit)</span>
          <span className="statusBadge mono" data-tone={watchFolderName ? "ok" : undefined}>
            {watchFolderName ? `Pantau Aktif: ${watchFolderName}` : "0 Kredit · ACC ≤10 Ref"}
          </span>
        </summary>

        <div className="subtleDetailsBody animateAdvancedBody">
          <div className="flowConnectorCard">
            <div className="panelHead">
              <div>
                <strong>Susun Draft Teks Lalu Gambar Semua Panel di Google Flow (Tanpa Kuota API Gambar)</strong>
                <p className="fieldHint" style={{ margin: "2px 0 0" }}>
                  Nano Banana 2 Lite di Google Flow memakai <strong>0 kredit Flow</strong> (hingga 400 gambar/hari
                  gratis) dan mendukung <strong>hingga 10 gambar acuan aset ACC</strong> per panel secara otomatis.
                </p>
              </div>
              <a
                href={ANIMATION_APP_LINKS.googleFlow}
                target="_blank"
                rel="noreferrer"
                className="btn btnSm"
              >
                <ExternalLinkIcon size={13} />
                <span>Buka Google Flow</span>
              </a>
            </div>

            <label className="inlineControl" style={{ width: "100%", justifyContent: "space-between" }}>
              <span className="fieldLabel">Model Gambar Google Flow:</span>
              <select
                className="select inputSm"
                value={flowImageModel}
                onChange={(e) => selectFlowImageModel(e.target.value as FlowConnectorImageModel)}
                aria-label="Model gambar panel Google Flow Connector"
              >
                {FLOW_IMAGE_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>

            {remainingStats.drawnPanels > 0 && remainingStats.undrawnPanels > 0 ? (
              <label className="inlineControl" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={includeExistingFlow}
                  onChange={(e) => setIncludeExistingFlow(e.target.checked)}
                />
                <span className="fieldHint">
                  Sertakan panel yang sudah bergambar (total semua {orderedFrames.length} panel sebagai versi baru)
                </span>
              </label>
            ) : null}

            <ol className="flowConnectorSteps">
              <li>
                <strong>Susun draft teks semua panel (gratis, tanpa kuota gambar):</strong>{" "}
                {remainingStats.unplannedPanels > 0 ? (
                  <span>
                    Masih ada <strong>{remainingStats.unplannedPanels} slot panel</strong> yang belum disusun draft
                    adegannya. Klik tombol <strong>Susun Draft Semua Panel (Teks Saja)</strong> di bawah.
                  </span>
                ) : (
                  <span>
                    Semua <strong>{orderedFrames.length} draft panel</strong> sudah siap digambar!
                  </span>
                )}
              </li>
              <li>
                <strong>Unduh &amp; jalankan skrip Flow Connector:</strong> Unduh paket ZIP (berisi semua gambar acuan
                aset ACC di folder <code className="mono">refs/</code> + <code className="mono">run_flow_images</code>
                ), ekstrak, lalu jalankan <code className="mono">run_flow_images.bat</code> /{" "}
                <code className="mono">.command</code> / <code className="mono">node run_flow_images.mjs</code> saat
                tab <strong>flow.google.com</strong> terbuka.
                <div className="flowCodeChip">
                  <code className="mono">{FLOW_CLI_INSTALL_CMD}</code>
                  <button
                    type="button"
                    className="btn btnGhost btnSm"
                    onClick={() => void handleCopyText(FLOW_CLI_INSTALL_CMD, "flow-cli-panels")}
                  >
                    {copyFeedback === "flow-cli-panels" ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                    <span>{copyFeedback === "flow-cli-panels" ? "Tersalin" : "Salin"}</span>
                  </button>
                </div>
              </li>
              <li>
                <strong>Pasang gambar otomatis:</strong> Aktifkan <strong>Pantau Downloads</strong> di bawah (memantau{" "}
                <code className="mono">Downloads/{flowFolderSlug}/</code>) atau klik{" "}
                <strong>Unggah Banyak Gambar Panel</strong> sekaligus.
              </li>
            </ol>

            <div className="actionGroup">
              {remainingStats.unplannedPanels > 0 ? (
                <button
                  type="button"
                  className="btn btnOk btnSm"
                  disabled={Boolean(busy) || autoRunning}
                  onClick={() => void handleAutoGenerateAllSegments({ onlySingleSegment: false, planOnly: true })}
                  title="Susun seluruh draft teks panel (shot, dialog, prompt, aset ACC) tanpa memakai kuota gambar API"
                >
                  <SparklesIcon size={13} />
                  <span>Susun Draft Semua Panel — Teks Saja ({remainingStats.unplannedPanels})</span>
                </button>
              ) : null}

              <button
                type="button"
                className="btn btnPrimary btnSm"
                disabled={orderedFrames.length === 0 || Boolean(busy) || autoRunning}
                onClick={handleDownloadFlowPanelsZip}
              >
                <DownloadIcon size={13} />
                <span>
                  Unduh Paket Gambar Panel (
                  {effectiveOnlyMissingPanels
                    ? `${remainingStats.undrawnPanels} kosong`
                    : `Semua ${orderedFrames.length}`}{" "}
                  · .zip)
                </span>
              </button>

              <button
                type="button"
                className="btn btnSm"
                disabled={orderedFrames.length === 0 || Boolean(busy)}
                onClick={() => batchPanelInputRef.current?.click()}
                title="Pilih banyak gambar panel sekaligus untuk dipasang sesuai nomor urut"
              >
                <UploadIcon size={13} />
                <span>Unggah Banyak Gambar Panel</span>
              </button>

              <button
                type="button"
                className="btn btnGhost btnSm"
                disabled={orderedFrames.length === 0}
                onClick={() => void handleCopyFlowPanelsAgentPrompt()}
              >
                {copyFeedback === "flow-panels-agent" ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                <span>{copyFeedback === "flow-panels-agent" ? "Tersalin" : "Salin Prompt Agent"}</span>
              </button>
            </div>
          </div>

          <div className="flowWatchBox" data-active={Boolean(watchFolderName)}>
            <div style={{ flex: "1 1 220px" }}>
              <strong>
                {watchFolderName
                  ? `Pantau Otomatis Aktif: "${watchFolderName}" (+ ${flowFolderSlug})`
                  : "Pantau Folder Downloads Otomatis (Chrome/Edge Desktop)"}
              </strong>
              <p className="fieldHint" style={{ margin: "3px 0 0" }}>
                {watchFolderName
                  ? `Memantau "${watchFolderName}/" dan "${watchFolderName}/${flowFolderSlug}/" tiap 2,5 detik. Gambar panel bernomor 1–${Math.max(1, orderedFrames.length)} otomatis masuk.`
                  : folderWatchSupported
                    ? `Pilih folder Downloads sekali saja agar hasil Nano Banana 2 Lite di Downloads/${flowFolderSlug}/ otomatis masuk ke tiap panel storyboard.`
                    : "Browser HP tidak mendukung pantau folder otomatis. Gunakan tombol Unggah Banyak Gambar Panel."}
              </p>
            </div>
            <div className="actionGroup">
              {watchFolderName ? (
                <>
                  <button type="button" className="btn btnSm" onClick={() => void scanWatchedFolder()}>
                    <RefreshIcon size={13} />
                    <span>Pindai Sekarang</span>
                  </button>
                  <button type="button" className="btn btnGhost btnSm" onClick={handleStopFolderWatch}>
                    Matikan
                  </button>
                </>
              ) : folderWatchSupported ? (
                <button
                  type="button"
                  className="btn btnOk btnSm"
                  onClick={() => void handleEnableFolderWatch()}
                >
                  <RefreshIcon size={13} />
                  <span>Aktifkan Pantau Downloads</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </details>

      {autoRunning && autoProgress ? (
        <div className="autoProgressCard" role="status" aria-live="polite">
          <div className="autoProgressHead">
            <div>
              <strong>
                Segmen {autoProgress.segIndex}/{autoProgress.totalSegs} · Panel {autoProgress.panelNum}/
                {autoProgress.segTarget}
              </strong>{" "}
              <span className="fieldHint">
                (
                {autoProgress.phase === "planning"
                  ? "Menyusun adegan..."
                  : autoProgress.phase === "retrying"
                    ? "Mengulang koneksi otomatis..."
                    : "Menggambar FLUX.2 Klein 4B..."}
                )
              </span>
            </div>
            <div className="actionGroup">
              <span className="metaTag mono">
                {autoProgress.done}/{autoProgress.total} selesai
              </span>
              <button type="button" className="btn btnDanger btnSm" onClick={handleStopAutoSegment}>
                Hentikan
              </button>
            </div>
          </div>
          <div className="autoProgressTrack">
            <div
              className="autoProgressFill"
              style={{
                width: `${Math.min(100, Math.max(4, Math.round(((autoProgress.done + 0.35) / Math.max(1, autoProgress.total)) * 100)))}%`,
              }}
            />
          </div>
        </div>
      ) : busy ? (
        <div className="alertBox" role="status" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span>{busy}</span>
          {autoRunning ? (
            <button type="button" className="btn btnDanger btnSm" onClick={handleStopAutoSegment}>
              Hentikan
            </button>
          ) : null}
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
            <h3>Naskah Acuan ({segments.length} Segmen)</h3>
            <button type="button" className="btn btnGhost btnSm" onClick={() => onPatchSb({ step: "assets" })}>
              Cek Aset ACC ({approvedAssets.length})
            </button>
          </div>
          <pre className="scriptPeekPre">{sb.scriptText || "(Naskah kosong)"}</pre>
        </section>
      ) : null}

      {/* =================================================================== */}
      {/* VIEW MODE B: PER-SEGMENT STORYBOARD STRIP PREVIEW (NO DOWNLOAD!)    */}
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

          <div className="cardsPreviewMeta">
            <span className="mono">
              {segments.length} Segmen · {remainingStats.drawnPanels}/{remainingStats.totalPanels} Panel Tergambar ·{" "}
              {approvedFrameCount} ACC · Rasio {sb.aspectRatio}
            </span>

            <div className="actionGroup">
              {autoRunning ? (
                <button type="button" className="btn btnDanger btnSm" onClick={handleStopAutoSegment}>
                  Hentikan Auto
                </button>
              ) : remainingStats.remainingPanels > 0 ? (
                <button
                  type="button"
                  className="btn btnPrimary btnSm"
                  disabled={Boolean(busy)}
                  onClick={() => void handleAutoGenerateAllSegments({ onlySingleSegment: false })}
                >
                  <SparklesIcon size={13} />
                  <span>Generate Semua Sisa ({remainingStats.remainingPanels} Panel)</span>
                </button>
              ) : null}
              {orderedFrames.length > 0 ? (
                <button
                  type="button"
                  className="btn btnSm"
                  disabled={Boolean(busy)}
                  onClick={() => void handleExportAllStrips()}
                  title="Unduh semua papan strip horizontal sebagai gambar JPG"
                >
                  <DownloadIcon size={13} />
                  <span>Unduh Semua Papan (.jpg)</span>
                </button>
              ) : null}
              <div className="segToggle" role="tablist" aria-label="Format preview storyboard">
                <button
                  type="button"
                  role="tab"
                  className="segBtn"
                  aria-selected={previewLayout === "strip"}
                  onClick={() => setPreviewLayout("strip")}
                >
                  Strip Papan
                </button>
                <button
                  type="button"
                  role="tab"
                  className="segBtn"
                  aria-selected={previewLayout === "detail"}
                  onClick={() => setPreviewLayout("detail")}
                >
                  Kartu Detail
                </button>
              </div>
            </div>
          </div>

          {previewLayout === "strip" ? (
            <div className="segmentStripStack">
              {segments.map((seg) => {
                const segFrames = orderedFrames.filter((f) => f.segmentId === seg.id);
                const segDrawn = segFrames.filter((f) => Boolean(getSelectedFrameImage(f))).length;
                const targetCount = clampTargetPanels(seg.targetPanels);
                const segNeed = Math.max(0, targetCount - segFrames.length) + (segFrames.length - segDrawn);
                const slotCount = Math.max(targetCount, segFrames.length);
                const isDone = segFrames.length >= targetCount && segDrawn >= targetCount;
                const segAllApproved = isDone && segFrames.length > 0 && segFrames.every((f) => f.approved);
                const segClip = segmentVideoStatusMap.get(seg.id);

                return (
                  <section key={seg.id} className="segmentStripBoard" aria-label={`Storyboard Segmen ${seg.index}`}>
                    <div className="segmentStripHeader">
                      <div className="metaInline">
                        <span className="frameIndexPill mono">
                          SEGMEN {String(seg.index).padStart(2, "0")}
                        </span>
                        <h3 className="segmentStripTitle">{seg.title}</h3>
                        {seg.locationHint ? <span className="metaTag">{seg.locationHint}</span> : null}
                      </div>

                      <div className="actionGroup">
                        <span className="statusBadge mono" data-tone={isDone ? "ok" : "warn"}>
                          {isDone ? <CheckIcon size={11} /> : null}
                          <span>
                            {segDrawn}/{targetCount} Panel{segAllApproved ? " · ACC" : ""}
                          </span>
                        </span>
                        {isDone && (onAnimateSegment || onGoToAnimate) ? (
                          <button
                            type="button"
                            className="btn btnOk btnSm"
                            disabled={Boolean(busy)}
                            onClick={() => handleApproveAndAnimateSegment(seg)}
                            title={`Kirim langsung semua panel Segmen ${seg.index} ke Gemini Omni 1.2 Flash tanpa upload manual`}
                          >
                            <SparklesIcon size={13} />
                            <span>
                              {segClip?.status === "ready"
                                ? `Video Segmen ${seg.index} (Omni 1.2)`
                                : segAllApproved
                                  ? `Animasikan Segmen ${seg.index} (Omni 1.2)`
                                  : `ACC & Animasikan (Omni 1.2)`}
                            </span>
                            <ArrowRightIcon size={13} />
                          </button>
                        ) : null}
                        {segFrames.length > 0 ? (
                          <button
                            type="button"
                            className="btn btnSm"
                            disabled={Boolean(busy)}
                            onClick={() => void handleExportSegmentStrip(seg)}
                            title={`Simpan papan strip Segmen ${seg.index} sebagai gambar JPG`}
                          >
                            <DownloadIcon size={13} />
                            <span>Unduh Papan (.jpg)</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btnGhost btnSm"
                          onClick={() => {
                            handleSelectSegment(seg.id);
                            setViewMode("editor");
                          }}
                        >
                          Buka Editor
                        </button>
                        {segNeed > 0 ? (
                          <button
                            type="button"
                            className="btn btnPrimary btnSm"
                            disabled={Boolean(busy)}
                            onClick={() => void handleAutoGenerateSegment(seg)}
                            title={`Susun & gambar otomatis semua sisa panel Segmen ${seg.index}`}
                          >
                            <SparklesIcon size={13} />
                            <span>Auto Lengkapi ({segNeed})</span>
                          </button>
                        ) : segFrames.length < 7 ? (
                          <button
                            type="button"
                            className="btn btnSm"
                            disabled={Boolean(busy)}
                            onClick={() => void handleContinueNextFrame(seg)}
                          >
                            <PlusIcon size={13} />
                            <span>Panel {segFrames.length + 1}</span>
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {/* Signature horizontal Storyboard Sheet matching reference comic/film strip */}
                    <div className="segmentStripSheetWrap">
                      <div className="segmentStripSheet">
                        <div
                          className="segmentStripRow"
                          data-ratio={sb.aspectRatio}
                          style={{ ["--strip-cols" as string]: slotCount }}
                        >
                          {Array.from({ length: slotCount }, (_, slotIdx) => {
                            const frame = segFrames[slotIdx];
                            const pNum = slotIdx + 1;
                            const isNextSlot = slotIdx === segFrames.length;

                            if (!frame) {
                              return (
                                <div key={`ghost-${seg.id}-${pNum}`} className="stripPanelCell isGhost">
                                  <button
                                    type="button"
                                    className="stripPanelGhostBtn"
                                    data-ratio={sb.aspectRatio}
                                    disabled={Boolean(busy) || !isNextSlot}
                                    onClick={() => isNextSlot && void handleContinueNextFrame(seg)}
                                    title={
                                      isNextSlot
                                        ? `Klik untuk membuat Panel ${pNum} Segmen ${seg.index}`
                                        : `Buat Panel ${segFrames.length + 1} dulu`
                                    }
                                  >
                                    {isNextSlot ? (
                                      <>
                                        <PlusIcon size={18} />
                                        <span>Continue Panel {pNum}</span>
                                      </>
                                    ) : (
                                      <span className="mono">Slot {pNum}</span>
                                    )}
                                  </button>
                                  <div className="stripPanelCaption isMuted">PANEL {pNum}: —</div>
                                </div>
                              );
                            }

                            const img = getSelectedFrameImage(frame);
                            const globalIdx = orderedFrames.findIndex((f) => f.id === frame.id);
                            const captionTitle = (frame.title || `Panel ${pNum}`).toUpperCase();

                            return (
                              <div key={frame.id} className="stripPanelCell">
                                <button
                                  type="button"
                                  className="stripPanelFrameBtn"
                                  data-ratio={sb.aspectRatio}
                                  onClick={() => setLightboxIdx(globalIdx)}
                                  aria-label={`Perbesar Segmen ${seg.index} Panel ${pNum}: ${frame.title}`}
                                >
                                  {img ? (
                                    <img
                                      src={img}
                                      alt={`Panel ${pNum}: ${frame.title}`}
                                      className="stripPanelImg"
                                    />
                                  ) : (
                                    <div className="stripPanelEmpty">
                                      <span className="mono">Panel {pNum}</span>
                                      <small>Belum digambar</small>
                                    </div>
                                  )}
                                  <span className="stripPanelHoverTag mono">
                                    {frame.shotSize} · {frame.cameraAngle}
                                  </span>
                                  {frame.approved ? (
                                    <span className="stripPanelAccDot" title="Panel ACC">
                                      <CheckIcon size={10} />
                                    </span>
                                  ) : null}
                                </button>

                                <div className="stripPanelCaption" title={frame.sceneSummary}>
                                  PANEL {pNum}: {captionTitle}
                                </div>

                                {frame.dialogue.trim() ? (
                                  <div className="stripPanelDialogue" title={frame.dialogue.trim()}>
                                    &ldquo;{frame.dialogue.trim()}&rdquo;
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            /* Detailed Cards View grouped by Segment */
            <div className="segmentStripStack">
              {segments.map((seg) => {
                const segFrames = orderedFrames.filter((f) => f.segmentId === seg.id);
                const targetCount = clampTargetPanels(seg.targetPanels);
                return (
                  <section key={seg.id} className="segmentDetailGroup">
                    <div className="segmentStripHeader" style={{ borderRadius: "var(--radius-md)", border: "1px solid var(--border)" }}>
                      <div className="metaInline">
                        <span className="frameIndexPill mono">SEGMEN {String(seg.index).padStart(2, "0")}</span>
                        <h3 className="segmentStripTitle">{seg.title}</h3>
                        {seg.locationHint ? <span className="metaTag">{seg.locationHint}</span> : null}
                      </div>
                      <span className="metaTag mono">
                        {segFrames.length}/{targetCount} Panel
                      </span>
                    </div>

                    {segFrames.length === 0 ? (
                      <div className="emptyPanel" style={{ padding: "22px 16px" }}>
                        <p>Belum ada panel di Segmen {seg.index}.</p>
                        <button
                          type="button"
                          className="btn btnPrimary btnSm"
                          disabled={Boolean(busy)}
                          onClick={() => void handleAutoGenerateSegment(seg)}
                        >
                          <SparklesIcon size={14} />
                          <span>Auto-Buat Segmen {seg.index} ({targetCount} Panel)</span>
                        </button>
                      </div>
                    ) : (
                      <div className="storyboardCardGrid" data-ratio={sb.aspectRatio}>
                        {segFrames.map((frame, pIdx) => {
                          const pNum = frame.panelNumber ?? pIdx + 1;
                          const img = getSelectedFrameImage(frame);
                          const globalIdx = orderedFrames.findIndex((f) => f.id === frame.id);
                          const cast = frame.assetIds
                            .map((id) => sb.assets.find((a) => a.id === id))
                            .filter((a): a is NonNullable<typeof a> => Boolean(a));

                          return (
                            <article key={frame.id} className="sbPreviewCard" data-approved={frame.approved}>
                              <button
                                type="button"
                                className="sbPreviewMediaBtn"
                                data-ratio={sb.aspectRatio}
                                onClick={() => setLightboxIdx(globalIdx)}
                                aria-label={`Perbesar Segmen ${seg.index} Panel ${pNum}: ${frame.title}`}
                              >
                                {img ? (
                                  <img
                                    src={img}
                                    alt={`Panel ${pNum}: ${frame.title}`}
                                    className="sbPreviewImg"
                                  />
                                ) : (
                                  <div className="sbPreviewEmpty">
                                    <span>Belum digambar</span>
                                  </div>
                                )}
                                <span className="sbFrameNumBadge mono">
                                  S{seg.index} · PANEL {pNum}
                                </span>
                                {frame.approved ? (
                                  <span className="sbAccBadge">
                                    <CheckIcon size={12} /> ACC
                                  </span>
                                ) : null}
                              </button>

                              <div className="sbPreviewBody">
                                <div className="sbPreviewTitleRow">
                                  <h3>{frame.title || `Panel ${pNum}`}</h3>
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
                                    onClick={() => setLightboxIdx(globalIdx)}
                                  >
                                    Perbesar
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btnGhost btnSm"
                                    onClick={() => {
                                      setActiveSegmentId(seg.id);
                                      setActiveFrameId(frame.id);
                                      setViewMode("editor");
                                    }}
                                  >
                                    Edit Panel
                                  </button>
                                </div>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* =================================================================== */
        /* VIEW MODE A: PER-SEGMENT, PER-PANEL EDITOR + CONTINUE               */
        /* =================================================================== */
        <>
          {/* Segment Switcher Tabs Bar */}
          <div className="segmentTabBar" role="tablist" aria-label="Pilih segmen naskah">
            {segments.map((seg) => {
              const segFrames = orderedFrames.filter((f) => f.segmentId === seg.id);
              const segCount = segFrames.length;
              const segDrawn = segFrames.filter((f) => Boolean(getSelectedFrameImage(f))).length;
              const target = clampTargetPanels(seg.targetPanels);
              const done = segCount >= target && segDrawn >= target;
              const selected = activeSegment?.id === seg.id;
              return (
                <button
                  key={seg.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="segmentTabBtn"
                  data-active={selected}
                  data-done={done}
                  onClick={() => handleSelectSegment(seg.id)}
                >
                  <div className="segmentTabTop">
                    <span className="mono segmentTabNum">SEGMEN {String(seg.index).padStart(2, "0")}</span>
                    <span className="mono segmentTabCount" data-done={done}>
                      {done ? <CheckIcon size={10} /> : null}
                      {segDrawn}/{target}
                    </span>
                  </div>
                  <span className="segmentTabTitle">{seg.title}</span>
                </button>
              );
            })}
          </div>

          {/* Active Segment Script Focus Banner + Target Panel Control */}
          {activeSegment ? (
            <div className="activeSegmentBanner">
              <div className="activeSegmentInfo">
                <div className="metaInline">
                  <strong className="activeSegmentName">
                    Segmen {activeSegment.index}: {activeSegment.title}
                  </strong>
                  {activeSegment.locationHint ? (
                    <span className="metaTag">{activeSegment.locationHint}</span>
                  ) : null}
                </div>
                {activeSegment.scriptContent.trim() ? (
                  <p className="activeSegmentExcerpt">{activeSegment.scriptContent.trim()}</p>
                ) : null}
              </div>

              <div className="actionGroup">
                <div className="panelCountPicker" role="group" aria-label="Target jumlah panel segmen aktif">
                  <span className="panelCountLabel">Target Panel:</span>
                  {PANEL_COUNT_OPTIONS.map((cnt) => (
                    <button
                      key={cnt}
                      type="button"
                      className="panelCountBtn mono"
                      data-active={activeSegTarget === cnt}
                      disabled={Boolean(busy)}
                      onClick={() => handleChangeSegmentTargetPanels(activeSegment.id, cnt)}
                    >
                      {cnt}
                    </button>
                  ))}
                </div>

                {autoRunning ? (
                  <button type="button" className="btn btnDanger btnSm" onClick={handleStopAutoSegment}>
                    Hentikan Auto
                  </button>
                ) : (
                  <>
                    {activeSegCompleted && (onAnimateSegment || onGoToAnimate) ? (
                      <>
                        {!activeSegAllApproved ? (
                          <button
                            type="button"
                            className="btn btnSm"
                            disabled={Boolean(busy)}
                            onClick={() => handleApproveSegment(activeSegment)}
                            title={`Tandai ACC semua ${activeSegmentFrames.length} panel di Segmen ${activeSegment.index}`}
                          >
                            <CheckIcon size={13} />
                            <span>ACC Semua Segmen {activeSegment.index}</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btnOk btnSm"
                          disabled={Boolean(busy)}
                          onClick={() => handleApproveAndAnimateSegment(activeSegment)}
                          title={`Kirim langsung semua panel Segmen ${activeSegment.index} ke Gemini Omni 1.2 Flash tanpa upload manual`}
                        >
                          <SparklesIcon size={13} />
                          <span>
                            {segmentVideoStatusMap.get(activeSegment.id)?.status === "ready"
                              ? `Video Segmen ${activeSegment.index} (Omni 1.2)`
                              : activeSegAllApproved
                                ? `Animasikan Segmen ${activeSegment.index} (Omni 1.2)`
                                : `ACC & Animasikan Omni 1.2`}
                          </span>
                          <ArrowRightIcon size={13} />
                        </button>
                      </>
                    ) : null}
                    {remainingStats.remainingPanels > 0 ? (
                      <>
                        <button
                          type="button"
                          className="btn btnPrimary btnSm"
                          disabled={Boolean(busy)}
                          onClick={() => void handleAutoGenerateAllSegments({ onlySingleSegment: false })}
                          title="Susun & gambar otomatis seluruh panel di semua segmen sekaligus tanpa perlu klik ulang"
                        >
                          <SparklesIcon size={13} />
                          <span>
                            Generate Semua Segmen ({remainingStats.remainingPanels} Panel)
                          </span>
                        </button>
                        {segments.length > 1 && activeSegNeed > 0 ? (
                          <button
                            type="button"
                            className="btn btnSm"
                            disabled={Boolean(busy)}
                            onClick={() => void handleAutoGenerateSegment(activeSegment)}
                            title={`Susun & gambar otomatis sisa panel Segmen ${activeSegment.index} saja`}
                          >
                            <span>Segmen {activeSegment.index} Saja ({activeSegNeed})</span>
                          </button>
                        ) : null}
                      </>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ) : null}

          {/* Filmstrip Bar for Active Segment Panels */}
          <div className="filmstripBar" role="region" aria-label={`Panel Segmen ${activeSegment?.index ?? 1}`}>
            {activeSegmentFrames.map((frame, idx) => {
              const pNum = frame.panelNumber ?? idx + 1;
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
                      <img src={thumb} alt={`Panel ${pNum}`} />
                    ) : (
                      <span className="mono">P{pNum}</span>
                    )}
                    {frame.approved ? (
                      <span className="filmstripAccDot" aria-label="ACC">
                        <CheckIcon size={10} />
                      </span>
                    ) : null}
                  </div>
                  <div className="filmstripMeta">
                    <strong className="mono">P{pNum}</strong>
                    <span>{frame.title || `Panel ${pNum}`}</span>
                  </div>
                </button>
              );
            })}

            {activeSegmentFrames.length < 7 ? (
              <button
                type="button"
                className="filmstripContinueCard"
                disabled={Boolean(busy)}
                onClick={() => void handleContinueNextFrame()}
                title={`Susun & gambar Panel ${activeSegmentFrames.length + 1} di Segmen ${activeSegment?.index ?? 1}`}
              >
                <PlusIcon size={16} />
                <span>
                  {activeSegmentFrames.length === 0
                    ? `Panel 1/${activeSegTarget}`
                    : `Panel ${activeSegmentFrames.length + 1}/${Math.max(activeSegTarget, activeSegmentFrames.length + 1)}`}
                </span>
              </button>
            ) : null}

            {activeSegCompleted && nextSegment ? (
              <button
                type="button"
                className="filmstripNextSegCard"
                disabled={Boolean(busy)}
                onClick={() => {
                  const nextFrames = orderedFrames.filter((f) => f.segmentId === nextSegment.id);
                  if (nextFrames.length === 0) {
                    void handleContinueNextFrame(nextSegment);
                  } else {
                    handleSelectSegment(nextSegment.id);
                  }
                }}
                title={`Lanjut ke Segmen ${nextSegment.index}: ${nextSegment.title}`}
              >
                <ArrowRightIcon size={16} />
                <span>Segmen {nextSegment.index}</span>
              </button>
            ) : null}
          </div>

          {!activeFrame ? (
            <div className="emptyPanel">
              <h3>
                Segmen {activeSegment?.index ?? 1}: {activeSegment?.title || "Siap Membuat Storyboard"}
              </h3>
              <p>
                Tekan tombol di bawah sekali saja untuk menyusun &amp; menggambar otomatis{" "}
                <strong>
                  seluruh {remainingStats.remainingSegments} segmen ({remainingStats.remainingPanels} panel)
                </strong>{" "}
                dengan FLUX.2 Klein 4B mengacu pada <strong>{approvedAssets.length} aset ACC</strong> — tanpa perlu
                klik Continue atau Generate satu per satu.
              </p>

              <div className="continueEmptyControls">
                <input
                  aria-label="Arahan opsional untuk panel awal"
                  className="input"
                  value={continueNote}
                  disabled={Boolean(busy)}
                  onChange={(e) => setContinueNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleAutoGenerateAllSegments({
                        onlySingleSegment: false,
                        initialDirection: continueNote,
                      });
                    }
                  }}
                  placeholder={`Arahan opsional (kosongkan agar AI langsung menggambar seluruh segmen sesuai naskah)...`}
                />
                <div className="actionGroup" style={{ justifyContent: "center" }}>
                  <button
                    type="button"
                    className="btn btnPrimary btnLg"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void handleAutoGenerateAllSegments({
                        onlySingleSegment: false,
                        initialDirection: continueNote,
                      })
                    }
                  >
                    <SparklesIcon size={15} />
                    <span>
                      Generate Seluruh Segmen ({remainingStats.remainingPanels} Panel · {remainingStats.remainingSegments}{" "}
                      Segmen)
                    </span>
                    <ArrowRightIcon size={15} />
                  </button>
                  {segments.length > 1 && activeSegment ? (
                    <button
                      type="button"
                      className="btn btnOk btnLg"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void handleAutoGenerateAllSegments({
                          onlySingleSegment: true,
                          targetSegment: activeSegment,
                          initialDirection: continueNote,
                        })
                      }
                    >
                      <SparklesIcon size={15} />
                      <span>
                        Segmen {activeSegment.index} Saja ({activeSegNeed} Panel)
                      </span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn"
                    disabled={Boolean(busy)}
                    onClick={() => void handleContinueNextFrame()}
                  >
                    Buat 1 Panel Dulu
                  </button>
                  <button
                    type="button"
                    className="btn btnGhost"
                    disabled={Boolean(busy)}
                    onClick={handleAddBlankFrame}
                  >
                    Panel Kosong Manual
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="frameEditorGrid">
              {/* LEFT COLUMN: Active Panel Visual Stage + Continue Bar */}
              <div className="frameStageCol">
                <section className="panelCard">
                  <div className="panelHead">
                    <div className="metaInline">
                      <span className="frameIndexPill mono">
                        SEGMEN {String(activeSegment?.index ?? 1).padStart(2, "0")} · PANEL {activePanelNum}/
                        {Math.max(activeSegTarget, activeSegmentFrames.length)}
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
                          setError("Generate atau unggah gambar panel dulu sebelum memberi ACC.");
                          return;
                        }
                        setError("");
                        updateFrame(activeFrame.id, { approved: !activeFrame.approved });
                      }}
                    >
                      <CheckIcon size={13} />
                      <span>{activeFrame.approved ? "Panel ACC" : "ACC Panel"}</span>
                    </button>
                  </div>

                  {/* Active visual canvas */}
                  <div className="frameStageBox" data-ratio={sb.aspectRatio}>
                    {activeImg ? (
                      <img
                        src={activeImg}
                        alt={`Panel ${activePanelNum}: ${activeFrame.title}`}
                        className="frameStageImg"
                        onClick={() => setLightboxIdx(activeGlobalIdx)}
                      />
                    ) : (
                      <div className="frameStageEmpty">
                        <p>
                          Draft <strong>Panel {activePanelNum}</strong> (Segmen {activeSegment?.index ?? 1}) siap
                          digambar.
                        </p>
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
                    <div className="candStrip" aria-label={`Versi gambar Panel ${activePanelNum}`}>
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
                        onClick={() => setLightboxIdx(activeGlobalIdx)}
                      >
                        Perbesar
                      </button>
                    ) : null}
                  </div>

                  {/* Quick FLUX.2 image-to-image revision */}
                  {activeImg ? (
                    <div className="quickReviseRow">
                      <input
                        aria-label={`Revisi cepat gambar Panel ${activePanelNum}`}
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
                        placeholder="Revisi gambar ini (mis. kamera lebih dekat, tambah senyum hangat, cahaya lebih fajar)..."
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

                {/* DIRECT 1-TAP SEGMENT -> OMNI 1.2 ANIMATION CARD WHEN ACTIVE SEGMENT IS COMPLETE */}
                {activeSegment && activeSegCompleted && (onAnimateSegment || onGoToAnimate) ? (
                  <section className="panelCard" aria-label={`Animasikan Segmen ${activeSegment.index} ke Omni 1.2`}>
                    <div className="panelHead">
                      <h3>
                        Segmen {activeSegment.index} Lengkap ({activeSegmentFrames.length} Panel)
                      </h3>
                      <span className="statusBadge" data-tone="ok">
                        <CheckIcon size={12} /> {activeSegAllApproved ? "Semua ACC · Siap Omni 1.2" : "Siap ACC & Animasi"}
                      </span>
                    </div>
                    <p className="fieldHint" style={{ margin: 0 }}>
                      {activeSegAllApproved
                        ? `Semua panel Segmen ${activeSegment.index} sudah ACC. Cukup klik tombol di bawah — Frame Awal & Frame Akhir otomatis dikirim ke Gemini Omni 1.2 Flash tanpa upload manual.`
                        : `Semua gambar Segmen ${activeSegment.index} sudah jadi. ACC sekaligus lalu kirim Frame Awal & Akhir langsung ke Gemini Omni 1.2 Flash tanpa upload manual.`}
                    </p>
                    <div className="actionGroup">
                      {!activeSegAllApproved ? (
                        <button
                          type="button"
                          className="btn"
                          disabled={Boolean(busy)}
                          onClick={() => handleApproveSegment(activeSegment)}
                        >
                          <CheckIcon size={14} />
                          <span>ACC Semua Segmen {activeSegment.index}</span>
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btnOk"
                        disabled={Boolean(busy)}
                        onClick={() => handleApproveAndAnimateSegment(activeSegment)}
                      >
                        <SparklesIcon size={14} />
                        <span>
                          {segmentVideoStatusMap.get(activeSegment.id)?.status === "ready"
                            ? `Lihat Video Segmen ${activeSegment.index} (Omni 1.2)`
                            : activeSegAllApproved
                              ? `Animasikan Segmen ${activeSegment.index} (Omni 1.2)`
                              : `ACC & Langsung Animasikan Segmen ${activeSegment.index} (Omni 1.2)`}
                        </span>
                        <ArrowRightIcon size={14} />
                      </button>
                    </div>
                  </section>
                ) : null}

                {/* DEDICATED 1-TAP AUTO-GENERATE ALL SEGMENTS / CONTINUE BAR */}
                <section className="panelCard continueCard" aria-label="Generate otomatis seluruh segmen">
                  <div className="panelHead">
                    <h3>
                      {remainingStats.remainingPanels === 0
                        ? `Semua Segmen Lengkap (${remainingStats.drawnPanels}/${remainingStats.totalPanels} Panel)`
                        : "Generate Otomatis Seluruh Segmen"}
                    </h3>
                    {remainingStats.remainingPanels === 0 ? (
                      <span className="statusBadge" data-tone="ok">
                        <CheckIcon size={12} /> Storyboard Lengkap
                      </span>
                    ) : (
                      <span className="metaTag mono">
                        Sisa {remainingStats.remainingPanels} panel · {remainingStats.remainingSegments} segmen
                      </span>
                    )}
                  </div>

                  {remainingStats.remainingPanels > 0 ? (
                    <div className="continueRow">
                      <input
                        aria-label="Arahan opsional panel berikutnya"
                        className="input"
                        value={continueNote}
                        disabled={Boolean(busy)}
                        onChange={(e) => setContinueNote(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleAutoGenerateAllSegments({
                              onlySingleSegment: false,
                              initialDirection: continueNote,
                            });
                          }
                        }}
                        placeholder="Arahan opsional untuk panel berikutnya (kosongkan untuk langsung jalan sesuai naskah)..."
                      />

                      {autoRunning ? (
                        <button type="button" className="btn btnDanger" onClick={handleStopAutoSegment}>
                          Hentikan ({autoProgress ? `${autoProgress.done}/${autoProgress.total}` : "..."})
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btnPrimary"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void handleAutoGenerateAllSegments({
                              onlySingleSegment: false,
                              initialDirection: continueNote,
                            })
                          }
                        >
                          <SparklesIcon size={15} />
                          <span>
                            Generate Semua Sisa ({remainingStats.remainingPanels} Panel ·{" "}
                            {remainingStats.remainingSegments} Segmen)
                          </span>
                          <ArrowRightIcon size={15} />
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="actionGroup">
                      <button type="button" className="btn btnPrimary" onClick={() => setViewMode("cards")}>
                        <GridIcon size={14} />
                        <span>Lihat Preview Strip Lengkap ({orderedFrames.length} Panel)</span>
                      </button>
                      {onGoToAnimate ? (
                        <button type="button" className="btn btnOk" onClick={onGoToAnimate}>
                          <SparklesIcon size={14} />
                          <span>Lanjut Animasi (Tahap 4)</span>
                          <ArrowRightIcon size={14} />
                        </button>
                      ) : null}
                    </div>
                  )}

                  <div className="continueSubRow">
                    <div className="actionGroup">
                      {segments.length > 1 && activeSegment && activeSegNeed > 0 ? (
                        <button
                          type="button"
                          className="btn btnSm"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void handleAutoGenerateAllSegments({
                              onlySingleSegment: true,
                              targetSegment: activeSegment,
                              initialDirection: continueNote,
                            })
                          }
                        >
                          <span>
                            Auto Segmen {activeSegment.index} Saja ({activeSegNeed})
                          </span>
                        </button>
                      ) : null}

                      {activeSegCompleted && nextSegment ? (
                        <button
                          type="button"
                          className="btn btnSm"
                          disabled={Boolean(busy)}
                          onClick={() => void handleContinueNextFrame(nextSegment)}
                          title={`Langsung susun & gambar panel pertama Segmen ${nextSegment.index}`}
                        >
                          <span>+1 Panel (Segmen {nextSegment.index})</span>
                          <ArrowRightIcon size={13} />
                        </button>
                      ) : activeSegmentFrames.length < 7 ? (
                        <button
                          type="button"
                          className="btn btnSm"
                          disabled={Boolean(busy)}
                          onClick={() => void handleContinueNextFrame()}
                          title="Buat & gambar 1 panel berikutnya saja"
                        >
                          <span>
                            +1 Panel Saja (P{activeSegmentFrames.length + 1})
                          </span>
                        </button>
                      ) : null}

                      <button
                        type="button"
                        className="btn btnGhost btnSm"
                        onClick={() => setViewMode("cards")}
                      >
                        <GridIcon size={13} />
                        <span>Preview Strip ({orderedFrames.length})</span>
                      </button>
                    </div>

                    <label className="checkRow">
                      <input
                        type="checkbox"
                        checked={autoGenOnContinue}
                        disabled={Boolean(busy)}
                        onChange={(e) => setAutoGenOnContinue(e.target.checked)}
                      />
                      <span>Auto-gambar FLUX.2 4B (+1 Panel)</span>
                    </label>
                  </div>
                </section>
              </div>

              {/* RIGHT COLUMN: Active Panel Details & ACC Asset Binding */}
              <section className="panelCard frameDetailsCol" aria-label="Detail panel aktif">
                <div className="panelHead">
                  <h3>
                    Detail Panel {activePanelNum} (Segmen {activeSegment?.index ?? 1})
                  </h3>
                  <div className="actionGroup">
                    <button
                      type="button"
                      className="btn btnGhost btnSm btnIcon"
                      disabled={Boolean(busy) || activeSegPos <= 0}
                      title="Geser panel ke kiri"
                      aria-label="Geser panel ke kiri"
                      onClick={() => handleMoveFrame(activeFrame.id, -1)}
                    >
                      <ChevronLeftIcon size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btnGhost btnSm btnIcon"
                      disabled={Boolean(busy) || activeSegPos >= activeSegmentFrames.length - 1}
                      title="Geser panel ke kanan"
                      aria-label="Geser panel ke kanan"
                      onClick={() => handleMoveFrame(activeFrame.id, 1)}
                    >
                      <ChevronRightIcon size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btnDanger btnSm btnIcon"
                      disabled={Boolean(busy)}
                      title="Hapus panel ini"
                      aria-label="Hapus panel ini"
                      onClick={() => handleDeleteFrame(activeFrame.id)}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>
                </div>

                {activeFrame.scriptExcerpt ? (
                  <div className="scriptExcerptBox">
                    <span className="fieldLabel">Cuplikan Naskah Segmen</span>
                    <p>{activeFrame.scriptExcerpt}</p>
                  </div>
                ) : null}

                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="fr-title">
                    Judul Singkat Panel (Caption Strip)
                  </label>
                  <input
                    id="fr-title"
                    className="input"
                    value={activeFrame.title}
                    disabled={Boolean(busy)}
                    onChange={(e) => updateFrame(activeFrame.id, { title: e.target.value })}
                    placeholder="Contoh: Tiba di Pelabuhan"
                  />
                  <span className="fieldHint mono">
                    Tampil di papan: PANEL {activePanelNum}: {(activeFrame.title || `Panel ${activePanelNum}`).toUpperCase()}
                  </span>
                </div>

                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="fr-summary">
                    Aksi Micro-Momen Panel Ini
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
                    placeholder="Satu langkah gerakan kecil yang nyambung langsung dari panel sebelumnya..."
                  />
                </div>

                {/* Clickable ACC Assets chips */}
                <div className="fieldGroup">
                  <span className="fieldLabel">
                    Aset ACC yang Tampil di Panel Ini (klik untuk pilih/lepas)
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

                {activeGlobalIdx > 0 ? (
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
                      Lokasi &amp; cahaya nyambung dengan{" "}
                      {activePanelNum > 1
                        ? `Panel ${activePanelNum - 1}`
                        : `panel terakhir Segmen ${(activeSegment?.index ?? 2) - 1}`}{" "}
                      (bawa sebagai acuan warna FLUX.2)
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
                    placeholder="Kosongkan jika panel visual murni tanpa dialog"
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
      {/* FULL-SCREEN PANEL LIGHTBOX READER (NO DOWNLOAD NEEDED!)             */}
      {/* =================================================================== */}
      {lightboxFrame && lightboxIdx !== null ? (
        <div
          className="modalBackdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Preview Panel ${lightboxFrame.panelNumber ?? lightboxFrame.index}`}
          onClick={() => setLightboxIdx(null)}
        >
          <div className="lightboxDialog" onClick={(e) => e.stopPropagation()}>
            <div className="lightboxHeader">
              <div className="metaInline">
                <span className="frameIndexPill mono">
                  SEGMEN {String(lightboxSegment?.index ?? 1).padStart(2, "0")} · PANEL{" "}
                  {lightboxFrame.panelNumber ?? 1}/{Math.max(lightboxSegment?.targetPanels ?? 5, lightboxSegFrames.length)}
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
                aria-label="Panel sebelumnya"
                onClick={() => setLightboxIdx((i) => (i !== null && i > 0 ? i - 1 : i))}
              >
                <ChevronLeftIcon size={18} />
              </button>

              <div className="lightboxStage">
                {getSelectedFrameImage(lightboxFrame) ? (
                  <img
                    src={getSelectedFrameImage(lightboxFrame)!}
                    alt={`Panel ${lightboxFrame.panelNumber ?? lightboxFrame.index}: ${lightboxFrame.title}`}
                    className="lightboxImg"
                  />
                ) : (
                  <div className="lightboxEmpty">
                    Panel {lightboxFrame.panelNumber ?? lightboxFrame.index} belum digambar.
                  </div>
                )}
              </div>

              <button
                type="button"
                className="btn btnIcon lightboxNavBtn"
                disabled={lightboxIdx >= orderedFrames.length - 1}
                aria-label="Panel berikutnya"
                onClick={() =>
                  setLightboxIdx((i) => (i !== null && i < orderedFrames.length - 1 ? i + 1 : i))
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
                <span className="fieldHint">
                  Panel {lightboxIdx + 1} dari {orderedFrames.length} total · Gunakan ← → di keyboard untuk berpindah.
                </span>
                <button
                  type="button"
                  className="btn btnSm"
                  onClick={() => {
                    if (lightboxFrame.segmentId) setActiveSegmentId(lightboxFrame.segmentId);
                    setActiveFrameId(lightboxFrame.id);
                    setLightboxIdx(null);
                    setViewMode("editor");
                  }}
                >
                  Edit Panel Ini
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
