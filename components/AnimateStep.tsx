"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  NmcProject,
  OmniAnimationMode,
  OmniResolution,
  ProviderProfile,
  RuntimeStatus,
  StoryAnimationClip,
  StoryboardData,
} from "@/lib/types";
import { DEFAULT_GEMINI_ID } from "@/lib/presets";
import { compressImageForStorage } from "@/lib/imageUtils";
import { clipVideoDb, downloadBlob, getApiKey, getKeyHint, setApiKey } from "@/lib/storage";
import {
  ANIMATION_APP_LINKS,
  buildAntigravityGeminiHandoff,
  buildFlowConnectorAgentPrompt,
  buildFlowConnectorCliCommand,
  buildFlowConnectorFolderSlug,
  buildOmniAnimationPackZip,
  buildOmniClipPlans,
  clampOmniDuration,
  FLOW_CONNECTOR_MODELS,
  matchDownloadedVideoToPlan,
  OMNI_MODEL_ID,
  OMNI_RESOLUTIONS,
  type FlowConnectorVideoModel,
  type OmniClipPlan,
} from "@/lib/omniAnimation";
import { getSelectedFrameImage, getStoryboardSegments, reindexStoryboardFrames } from "@/lib/storyboard";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FilmIcon,
  PlayIcon,
  RefreshIcon,
  SparklesIcon,
  TrashIcon,
  UploadIcon,
} from "./Icons";

interface AnimateStepProps {
  project: NmcProject;
  sb: StoryboardData;
  runtime: RuntimeStatus | null;
  profiles?: ProviderProfile[];
  autoAnimateSegmentId?: string | null;
  onConsumeAutoAnimate?: () => void;
  onPatchSb: (patch: Partial<StoryboardData>) => void;
  onBackToStoryboard: () => void;
}

type EngineTab = "handoff" | "omni-api" | "animatic";

interface RuntimeClipState {
  status: StoryAnimationClip["status"];
  interactionId?: string;
  fileUri?: string;
  blobUrl?: string;
  blob?: Blob;
  filename?: string;
  source?: "flow-upload" | "omni-api";
  error?: string;
  progressText?: string;
}

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

const ANIM_ENGINE_STORAGE_KEY = "nmcgen.animEngine";
const FLOW_CONNECTOR_MODEL_STORAGE_KEY = "nmcgen.flowConnectorModel";
const FLOW_CLI_INSTALL_CMD = "npm install -g flow-connector-cli";
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)$/i;
const DURATION_OPTIONS_FULL = [4, 5, 6, 8, 10, 12, 15];
const DURATION_OPTIONS_TRANSITION = [4, 5, 6, 8, 10];

function base64DataUrlToBlob(dataUrl: string): Blob {
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) return new Blob([], { type: "video/mp4" });
  const mime = m[1] || "video/mp4";
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function findSavedGeminiProfileKey(profiles?: ProviderProfile[]): { key: string; hint: string } {
  const defaultKey = getApiKey(DEFAULT_GEMINI_ID);
  if (defaultKey) return { key: defaultKey, hint: getKeyHint(DEFAULT_GEMINI_ID) };
  for (const p of profiles ?? []) {
    if (p.kind !== "Gemini") continue;
    const k = getApiKey(p.id);
    if (k) return { key: k, hint: getKeyHint(p.id) };
  }
  return { key: "", hint: "" };
}

function loadPreferredEngineTab(): EngineTab {
  if (typeof window === "undefined") return "handoff";
  try {
    const saved = window.localStorage.getItem(ANIM_ENGINE_STORAGE_KEY);
    if (saved === "handoff" || saved === "omni-api" || saved === "animatic") return saved;
  } catch {
    // ignore storage errors
  }
  return "handoff";
}

function loadPreferredFlowModel(): FlowConnectorVideoModel {
  if (typeof window === "undefined") return "omni-flash";
  try {
    const saved = window.localStorage.getItem(FLOW_CONNECTOR_MODEL_STORAGE_KEY);
    if (saved === "omni-flash" || saved === "veo-3.1-lite" || saved === "veo-3.1-fast") return saved;
  } catch {
    // ignore storage errors
  }
  return "omni-flash";
}

export default function AnimateStep({
  project,
  sb,
  runtime,
  profiles,
  autoAnimateSegmentId,
  onConsumeAutoAnimate,
  onPatchSb,
  onBackToStoryboard,
}: AnimateStepProps) {
  const [engineTab, setEngineTab] = useState<EngineTab>(() => loadPreferredEngineTab());
  const [flowModel, setFlowModel] = useState<FlowConnectorVideoModel>(() => loadPreferredFlowModel());
  const [mode, setMode] = useState<OmniAnimationMode>("segment");
  const [durationSec, setDurationSec] = useState<number>(8);
  const [resolution, setResolution] = useState<OmniResolution>("720p");

  const [geminiKeyDraft, setGeminiKeyDraft] = useState("");
  const [keyVersion, setKeyVersion] = useState(0);
  const [promptOverrides, setPromptOverrides] = useState<Record<string, string>>({});
  const [editInputs, setEditInputs] = useState<Record<string, string>>({});
  const [clipStates, setClipStates] = useState<Record<string, RuntimeClipState>>(() => {
    const initial: Record<string, RuntimeClipState> = {};
    for (const c of sb.animationClips ?? []) {
      initial[c.id] = {
        status: c.status === "processing" || c.status === "queued" ? "idle" : c.status,
        interactionId: c.interactionId,
        fileUri: c.fileUri,
        error: c.error,
      };
    }
    return initial;
  });

  const [queueRunning, setQueueRunning] = useState(false);
  const [mergingClips, setMergingClips] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState("");
  const [globalError, setGlobalError] = useState("");
  const [globalNotice, setGlobalNotice] = useState("");
  const [playlistIdx, setPlaylistIdx] = useState(0);
  const [pendingSegmentId, setPendingSegmentId] = useState<string | null>(null);

  // Google Flow Express automation state (Auto-Watch Downloads + Auto-Return + Drag/Drop/Paste)
  const [waitingFlowPlanId, setWaitingFlowPlanId] = useState<string | null>(null);
  const [returnedFromFlow, setReturnedFromFlow] = useState(false);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [watchFolderName, setWatchFolderName] = useState<string>("");
  const [folderWatchSupported, setFolderWatchSupported] = useState(false);
  const watchDirHandleRef = useRef<FsDirHandleLike | null>(null);
  const seenFilesRef = useRef<Set<string>>(new Set());
  const pendingFileSizesRef = useRef<Map<string, number>>(new Map());
  const watchStartedAtRef = useRef<number>(0);
  const waitingFlowPlanIdRef = useRef<string | null>(null);
  waitingFlowPlanIdRef.current = waitingFlowPlanId;
  const uploadTargetPlanIdRef = useRef<string | null>(null);
  const singleVideoInputRef = useRef<HTMLInputElement>(null);
  const batchVideoInputRef = useRef<HTMLInputElement>(null);

  const cancelRef = useRef(false);
  const blobUrlsRef = useRef<string[]>([]);
  const latestSbRef = useRef<StoryboardData>(sb);
  latestSbRef.current = sb;
  const clipStatesRef = useRef<Record<string, RuntimeClipState>>(clipStates);
  clipStatesRef.current = clipStates;

  // Browser Animatic state + optional BGM track
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgmInputRef = useRef<HTMLInputElement>(null);
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const [animPlaying, setAnimPlaying] = useState(false);
  const [animRecording, setAnimRecording] = useState(false);
  const [secPerPanel, setSecPerPanel] = useState(3.5);
  const [animProgress, setAnimProgress] = useState(0);
  const [bgmUrl, setBgmUrl] = useState("");
  const [bgmName, setBgmName] = useState("");
  const [bgmVolume, setBgmVolume] = useState(0.55);
  const animRafRef = useRef<number | null>(null);
  const animImagesRef = useRef<Array<{ frame: ReturnType<typeof reindexStoryboardFrames>[number]; segIdx: number; img: HTMLImageElement | null }>>([]);

  const segments = useMemo(() => getStoryboardSegments(sb), [sb]);
  const orderedFrames = useMemo(() => reindexStoryboardFrames(sb.frames, segments), [sb.frames, segments]);
  const renderedFrames = useMemo(
    () => orderedFrames.filter((f) => Boolean(getSelectedFrameImage(f))),
    [orderedFrames],
  );

  const safeDuration = clampOmniDuration(durationSec, mode);
  const plans = useMemo<OmniClipPlan[]>(() => {
    const raw = buildOmniClipPlans(
      { ...project, storyboard: { ...sb, segments, frames: orderedFrames } },
      { mode, durationSec: safeDuration, resolution },
    );
    return raw.map((p) => ({
      ...p,
      prompt: promptOverrides[p.id] ?? p.prompt,
    }));
  }, [project, sb, segments, orderedFrames, mode, safeDuration, resolution, promptOverrides]);

  const flowFolderSlug = useMemo(() => buildFlowConnectorFolderSlug(project.name), [project.name]);

  const flowConnectorAgentPrompt = useMemo(
    () =>
      buildFlowConnectorAgentPrompt(
        { ...project, storyboard: { ...sb, segments, frames: orderedFrames } },
        plans,
        { model: flowModel },
      ),
    [project, sb, segments, orderedFrames, plans, flowModel],
  );

  const masterHandoffPrompt = useMemo(
    () => buildAntigravityGeminiHandoff({ ...project, storyboard: { ...sb, segments, frames: orderedFrames } }, plans),
    [project, sb, segments, orderedFrames, plans],
  );

  const selectFlowModel = (nextModel: FlowConnectorVideoModel) => {
    setFlowModel(nextModel);
    try {
      window.localStorage.setItem(FLOW_CONNECTOR_MODEL_STORAGE_KEY, nextModel);
    } catch {
      // ignore storage errors
    }
  };

  // Saved Gemini key indicator (checks DEFAULT_GEMINI_ID + any Gemini profile saved in Settings)
  const resolvedGemini = useMemo(() => {
    void keyVersion;
    return findSavedGeminiProfileKey(profiles);
  }, [keyVersion, profiles]);
  const localGeminiKey = resolvedGemini.key;
  const geminiKeyHint = resolvedGemini.hint;
  const omniKeyAvailable = Boolean(localGeminiKey || runtime?.serverKeys?.gemini);

  // Revoke object URLs on unmount
  useEffect(() => {
    return () => {
      cancelRef.current = true;
      for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
      if (animRafRef.current) cancelAnimationFrame(animRafRef.current);
    };
  }, []);

  const persistClipRecord = (plan: OmniClipPlan, state: RuntimeClipState) => {
    const existing = latestSbRef.current.animationClips ?? [];
    const nextRecord: StoryAnimationClip = {
      id: plan.id,
      label: plan.label,
      mode: plan.mode,
      segmentId: plan.segmentId,
      frameIds: plan.frameIds,
      durationSec: plan.durationSec,
      resolution: plan.resolution,
      prompt: plan.prompt,
      status: state.status,
      interactionId: state.interactionId,
      fileUri: state.fileUri,
      error: state.error,
      updatedAt: Date.now(),
    };
    const idx = existing.findIndex((c) => c.id === plan.id);
    const updated =
      idx === -1 ? [...existing, nextRecord] : existing.map((c, i) => (i === idx ? nextRecord : c));
    latestSbRef.current = { ...latestSbRef.current, animationClips: updated };
    onPatchSb({ animationClips: updated });
  };

  const setClipState = (planId: string, patch: Partial<RuntimeClipState>) => {
    setClipStates((prev) => ({
      ...prev,
      [planId]: { ...(prev[planId] ?? { status: "idle" }), ...patch },
    }));
  };

  const handleSaveGeminiKey = () => {
    const clean = geminiKeyDraft.trim();
    if (!clean) return;
    setApiKey(DEFAULT_GEMINI_ID, clean);
    setGeminiKeyDraft("");
    setKeyVersion((v) => v + 1);
    setGlobalError("");
    setGlobalNotice("Gemini API Key tersimpan lokal di browser. Siap memanggil Gemini Omni 1.2 Flash!");
  };

  const handleClearGeminiKey = () => {
    setApiKey(DEFAULT_GEMINI_ID, "");
    setKeyVersion((v) => v + 1);
    setGlobalNotice("Gemini API Key lokal dihapus.");
  };

  const handleCopyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(label);
      setTimeout(() => setCopyFeedback(""), 2200);
    } catch {
      setGlobalError("Gagal menyalin ke clipboard — salin manual dari kotak teks.");
    }
  };

  const handleDownloadOmniPackZip = () => {
    const bytes = buildOmniAnimationPackZip(
      { ...project, storyboard: { ...sb, segments, frames: orderedFrames } },
      plans,
      { flowModel },
    );
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const safeName =
      (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") +
      "-flow-connector-pack.zip";
    downloadBlob(new Blob([copy], { type: "application/zip" }), safeName);
    setGlobalNotice(
      `Paket Flow Connector (${plans.length} klip + keyframe Awal/Akhir + run_flow_connector.mjs/.bat/.command) berhasil diunduh! Ekstrak lalu jalankan skripnya saat tab Google Flow terbuka.`,
    );
  };

  // Download an active Google Files API video via our SSRF-safe server proxy
  const fetchPlayableBlobFromFileUri = async (fileUri: string): Promise<{ blob: Blob; blobUrl: string }> => {
    const res = await fetch("/api/video/omni", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "download",
        apiKey: localGeminiKey || undefined,
        fileUri,
      }),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(errJson.error || `Gagal mengunduh MP4 (${res.status}).`);
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    blobUrlsRef.current.push(blobUrl);
    return { blob, blobUrl };
  };

  // Run 1 Omni 1.2 Flash job (create, conversational edit, or extend) + poll until MP4 is playable
  const runOmniClipJob = async (
    plan: OmniClipPlan,
    op: "create" | "edit" | "extend" = "create",
    customPrompt?: string,
    previousInteractionId?: string,
  ) => {
    if (!omniKeyAvailable) {
      setGlobalError(
        "Gemini API Key belum aktif. Tempel Gemini API Key di atas atau gunakan tab Antigravity / Gemini Web (Gratis).",
      );
      return;
    }

    setGlobalError("");
    setClipState(plan.id, {
      status: "processing",
      error: undefined,
      progressText:
        op === "edit"
          ? "Mengirim instruksi revisi ke Omni 1.2 Flash..."
          : op === "extend"
            ? "Memperpanjang klip (+5 dtk) di Omni 1.2 Flash..."
            : `Mengirim ${plan.images.length} gambar ke Gemini Omni 1.2 Flash...`,
    });

    try {
      const preparedImages =
        op === "create"
          ? await Promise.all(
              plan.images
                .slice(0, 6)
                .map((im) => compressImageForStorage(im.dataUrl, { maxSide: 1024, quality: 0.84 })),
            )
          : undefined;

      const createRes = await fetch("/api/video/omni", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op,
          apiKey: localGeminiKey || undefined,
          prompt: customPrompt || plan.prompt,
          images: preparedImages,
          previousInteractionId,
          mode: plan.mode,
          durationSec: op === "extend" ? 5 : plan.durationSec,
          resolution: plan.resolution,
          aspectRatio: plan.aspectRatio,
        }),
      });
      const created = await createRes.json();
      if (!createRes.ok || !created.ok) {
        throw new Error(created.error || `Gagal memulai render Omni 1.2 (${createRes.status}).`);
      }

      const interactionId: string | undefined = created.interactionId;
      let fileUri: string | undefined = created.fileUri;
      let videoDataUrl: string | undefined = created.videoDataUrl;

      setClipState(plan.id, {
        status: "processing",
        interactionId,
        fileUri,
        progressText: "Merender video + audio di Gemini Omni 1.2 Flash...",
      });

      // Poll interaction completion (up to ~8 minutes at 4s intervals)
      for (let attempt = 0; attempt < 120 && !videoDataUrl; attempt++) {
        if (cancelRef.current) throw new Error("Antrean dibatalkan oleh pengguna.");
        if (fileUri) break;
        if (!interactionId) break;

        await new Promise((r) => setTimeout(r, 4000));
        const pRes = await fetch("/api/video/omni", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            op: "poll",
            apiKey: localGeminiKey || undefined,
            interactionId,
          }),
        });
        const pData = await pRes.json();
        if (!pRes.ok || !pData.ok) {
          throw new Error(pData.error || "Polling status Omni 1.2 gagal.");
        }
        if (pData.videoDataUrl) {
          videoDataUrl = pData.videoDataUrl;
          break;
        }
        if (pData.fileUri) {
          fileUri = pData.fileUri;
          break;
        }
        setClipState(plan.id, {
          status: "processing",
          interactionId,
          progressText: `Merender di Omni 1.2 Flash... (${(attempt + 1) * 4} dtk)`,
        });
      }

      let finalBlob: Blob;
      let finalBlobUrl: string;

      if (videoDataUrl) {
        finalBlob = base64DataUrlToBlob(videoDataUrl);
        finalBlobUrl = URL.createObjectURL(finalBlob);
        blobUrlsRef.current.push(finalBlobUrl);
      } else if (fileUri) {
        // Poll Google Files API until file state === ACTIVE
        for (let fTry = 0; fTry < 45; fTry++) {
          if (cancelRef.current) throw new Error("Antrean dibatalkan oleh pengguna.");
          setClipState(plan.id, {
            status: "processing",
            interactionId,
            fileUri,
            progressText: "Menyiapkan berkas MP4 di Google Files API...",
          });
          const fRes = await fetch("/api/video/omni", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              op: "poll",
              apiKey: localGeminiKey || undefined,
              fileUri,
            }),
          });
          const fData = await fRes.json();
          if (!fRes.ok || !fData.ok) {
            throw new Error(fData.error || "Gagal mengecek kesiapan berkas MP4.");
          }
          if (fData.status === "ready") break;
          await new Promise((r) => setTimeout(r, 3000));
        }

        setClipState(plan.id, {
          status: "processing",
          interactionId,
          fileUri,
          progressText: "Mengunduh hasil MP4 untuk diputar...",
        });
        const dl = await fetchPlayableBlobFromFileUri(fileUri);
        finalBlob = dl.blob;
        finalBlobUrl = dl.blobUrl;
      } else {
        throw new Error("Omni 1.2 selesai tanpa mengembalikan berkas video. Coba ulangi dengan prompt lebih sederhana.");
      }

      const readyState: RuntimeClipState = {
        status: "ready",
        interactionId,
        fileUri,
        blob: finalBlob,
        blobUrl: finalBlobUrl,
        filename: `${plan.id}.mp4`,
        source: "omni-api",
        error: undefined,
        progressText: undefined,
      };
      setClipState(plan.id, readyState);
      persistClipRecord(plan, readyState);
      void clipVideoDb
        .put({
          id: clipVideoDb.key(project.id, plan.id),
          projectId: project.id,
          clipId: plan.id,
          blob: finalBlob,
          filename: `${plan.id}.mp4`,
          source: "omni-api",
          updatedAt: Date.now(),
        })
        .catch(() => {});
      if (op === "edit") {
        setEditInputs((prev) => ({ ...prev, [plan.id]: "" }));
      }
    } catch (err) {
      const errState: RuntimeClipState = {
        status: "error",
        error: (err as Error).message,
        progressText: undefined,
      };
      setClipState(plan.id, errState);
      persistClipRecord(plan, errState);
    }
  };

  const handleAnimateAll = async () => {
    if (!omniKeyAvailable) {
      setGlobalError("Masukkan Gemini API Key terlebih dahulu untuk menjalankan antrean Omni 1.2 Flash.");
      return;
    }
    if (plans.length === 0) return;
    cancelRef.current = false;
    setQueueRunning(true);
    setGlobalError("");
    setGlobalNotice(`Memulai animasi berurutan untuk ${plans.length} klip menggunakan ${OMNI_MODEL_ID}...`);

    for (const plan of plans) {
      if (cancelRef.current) break;
      setClipState(plan.id, { status: "queued", error: undefined });
    }
    for (const plan of plans) {
      if (cancelRef.current) break;
      await runOmniClipJob(plan, "create");
    }
    setQueueRunning(false);
    if (!cancelRef.current) {
      setGlobalNotice("Antrean animasi Gemini Omni 1.2 Flash selesai.");
    }
  };

  const handleCancelQueue = () => {
    cancelRef.current = true;
    setQueueRunning(false);
    setGlobalNotice("Antrean animasi dihentikan.");
  };

  // Recover a previously generated Omni 1.2 video without re-rendering (zero extra API cost!)
  const handleRecoverSavedClip = async (plan: OmniClipPlan) => {
    const st = clipStates[plan.id];
    if (!st?.fileUri && !st?.interactionId) return;
    if (!omniKeyAvailable) {
      setGlobalError("Masukkan Gemini API Key dulu untuk memuat ulang video tersimpan dari Google.");
      return;
    }

    setGlobalError("");
    setClipState(plan.id, {
      status: "processing",
      error: undefined,
      progressText: "Memuat ulang video tersimpan dari Omni 1.2 (tanpa render ulang)...",
    });

    try {
      let blob: Blob | null = null;
      let blobUrl = "";

      if (st.fileUri) {
        try {
          const dl = await fetchPlayableBlobFromFileUri(st.fileUri);
          blob = dl.blob;
          blobUrl = dl.blobUrl;
        } catch {
          // Fallback to polling interactionId (GET returns inline base64 even if file URI expired)
          blob = null;
        }
      }

      if (!blob && st.interactionId) {
        const pRes = await fetch("/api/video/omni", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            op: "poll",
            apiKey: localGeminiKey || undefined,
            interactionId: st.interactionId,
          }),
        });
        const pData = await pRes.json();
        if (!pRes.ok || !pData.ok) {
          throw new Error(pData.error || "Video tersimpan sudah kedaluwarsa di server Google.");
        }
        if (pData.videoDataUrl) {
          blob = base64DataUrlToBlob(pData.videoDataUrl);
          blobUrl = URL.createObjectURL(blob);
          blobUrlsRef.current.push(blobUrl);
        } else if (pData.fileUri) {
          const dl = await fetchPlayableBlobFromFileUri(pData.fileUri);
          blob = dl.blob;
          blobUrl = dl.blobUrl;
        }
      }

      if (!blob || !blobUrl) {
        throw new Error("Berkas video belum siap atau sudah kedaluwarsa (>48 jam). Silakan render ulang klip ini.");
      }

      const recovered: RuntimeClipState = {
        status: "ready",
        interactionId: st.interactionId,
        fileUri: st.fileUri,
        blob,
        blobUrl,
        filename: `${plan.id}.mp4`,
        source: "omni-api",
        error: undefined,
        progressText: undefined,
      };
      setClipState(plan.id, recovered);
      persistClipRecord(plan, recovered);
      void clipVideoDb
        .put({
          id: clipVideoDb.key(project.id, plan.id),
          projectId: project.id,
          clipId: plan.id,
          blob,
          filename: `${plan.id}.mp4`,
          source: "omni-api",
          updatedAt: Date.now(),
        })
        .catch(() => {});
      setGlobalNotice(`Video "${plan.label}" berhasil dimuat ulang tanpa render ulang.`);
    } catch (err) {
      setClipState(plan.id, {
        status: "error",
        error: (err as Error).message,
        progressText: undefined,
      });
    }
  };

  const recoverableClips = useMemo(
    () =>
      plans.filter((plan) => {
        const st = clipStates[plan.id];
        return Boolean((st?.fileUri || st?.interactionId) && !st?.blobUrl && st?.status !== "processing");
      }),
    [plans, clipStates],
  );

  const handleRecoverAllSavedClips = async () => {
    for (const plan of recoverableClips) {
      await handleRecoverSavedClip(plan);
    }
  };

  // =========================================================================
  // GOOGLE FLOW EXPRESS: PERSISTENT MP4 CACHE + AUTO-WATCH DOWNLOADS + RETURN
  // =========================================================================
  const selectEngineTab = (tab: EngineTab) => {
    setEngineTab(tab);
    try {
      window.localStorage.setItem(ANIM_ENGINE_STORAGE_KEY, tab);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    setFolderWatchSupported(typeof window !== "undefined" && "showDirectoryPicker" in window);
  }, []);

  // Automatically restore all previously attached Flow MP4s & Omni renders from IndexedDB
  useEffect(() => {
    let active = true;
    void clipVideoDb
      .listByProject(project.id)
      .then((items) => {
        if (!active || items.length === 0) return;
        setClipStates((prev) => {
          const next = { ...prev };
          for (const item of items) {
            if (next[item.clipId]?.blobUrl) continue;
            const blobUrl = URL.createObjectURL(item.blob);
            blobUrlsRef.current.push(blobUrl);
            next[item.clipId] = {
              ...(next[item.clipId] ?? { status: "ready" }),
              status: "ready",
              blob: item.blob,
              blobUrl,
              filename: item.filename,
              source: item.source,
              error: undefined,
              progressText: undefined,
            };
          }
          return next;
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [project.id]);

  const plansRef = useRef<OmniClipPlan[]>(plans);
  plansRef.current = plans;

  const attachVideoBlobToPlan = async (
    plan: OmniClipPlan,
    blob: Blob,
    filename: string,
    source: "flow-upload" | "omni-api" = "flow-upload",
    autoMessage?: string,
  ) => {
    const blobUrl = URL.createObjectURL(blob);
    blobUrlsRef.current.push(blobUrl);
    const nextState: RuntimeClipState = {
      ...(clipStatesRef.current[plan.id] ?? { status: "ready" }),
      status: "ready",
      blob,
      blobUrl,
      filename,
      source,
      error: undefined,
      progressText: undefined,
    };
    setClipState(plan.id, nextState);
    persistClipRecord(plan, nextState);
    await clipVideoDb
      .put({
        id: clipVideoDb.key(project.id, plan.id),
        projectId: project.id,
        clipId: plan.id,
        blob,
        filename,
        source,
        updatedAt: Date.now(),
      })
      .catch(() => {});

    // Automatically advance waitingFlowPlanId to the next unfinished clip
    if (waitingFlowPlanIdRef.current === plan.id) {
      const nextUnfinished = plansRef.current.find(
        (p) => p.id !== plan.id && !clipStatesRef.current[p.id]?.blobUrl,
      );
      setWaitingFlowPlanId(nextUnfinished ? nextUnfinished.id : null);
      setReturnedFromFlow(false);
    }

    setGlobalError("");
    setGlobalNotice(
      autoMessage ||
        `Video "${filename}" otomatis menempel di ${plan.label} dan tersimpan lokal di browser!`,
    );
  };

  const handleRemoveClipVideo = async (plan: OmniClipPlan) => {
    setClipState(plan.id, {
      status: "idle",
      blob: undefined,
      blobUrl: undefined,
      filename: undefined,
      source: undefined,
      error: undefined,
      progressText: undefined,
    });
    persistClipRecord(plan, { status: "idle" });
    await clipVideoDb.del(project.id, plan.id).catch(() => {});
    setGlobalNotice(`Video pada ${plan.label} dilepas.`);
  };

  // Download Start & End frames cleanly for 1 segment without requiring a ZIP unzip
  const downloadFramesForPlan = (plan: OmniClipPlan) => {
    const segTag = `S${String(plan.segmentIndex).padStart(2, "0")}`;
    plan.images.forEach((im, idx) => {
      const blob = base64DataUrlToBlob(im.dataUrl);
      const role = plan.images.length === 2 ? (idx === 0 ? "AWAL" : "AKHIR") : `P${idx + 1}`;
      const ext = im.fileName.split(".").pop() || "jpg";
      setTimeout(() => {
        downloadBlob(blob, `${segTag}_${role}.${ext}`);
      }, idx * 280);
    });
  };

  // Mobile/iOS-safe 2-frame save (uses native Share Sheet when supported so both Start & End frames save to Photos)
  const handleSaveFramesForPlan = async (plan: OmniClipPlan) => {
    if (plan.images.length === 0) return;
    const segTag = `S${String(plan.segmentIndex).padStart(2, "0")}`;
    const files = plan.images.map((im, idx) => {
      const blob = base64DataUrlToBlob(im.dataUrl);
      const role = plan.images.length === 2 ? (idx === 0 ? "AWAL" : "AKHIR") : `P${idx + 1}`;
      const ext = im.fileName.split(".").pop() || "jpg";
      return new File([blob], `${segTag}_${role}.${ext}`, { type: blob.type || "image/jpeg" });
    });

    const nav = typeof navigator !== "undefined" ? navigator : null;
    if (nav && typeof nav.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files })) {
      try {
        await nav.share({ files, title: `Frame ${plan.label}` });
        setGlobalNotice(`Frame ${plan.label} siap disimpan ke Galeri/Foto.`);
        return;
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
      }
    }
    downloadFramesForPlan(plan);
    setGlobalNotice(`Mengunduh ${files.length} frame (${files.map((f) => f.name).join(" & ")}).`);
  };

  // 1-Tap Flow Express Launch: copy prompt + save Start & End frames + arm return watcher + open Google Flow!
  const handleLaunchFlowForClip = async (plan: OmniClipPlan) => {
    setGlobalError("");
    let copied = false;
    try {
      await navigator.clipboard.writeText(plan.prompt);
      copied = true;
      setCopyFeedback(plan.id);
      setTimeout(() => setCopyFeedback(""), 2400);
    } catch {
      copied = false;
    }

    if (plan.images.length > 0) {
      downloadFramesForPlan(plan);
    }

    setWaitingFlowPlanId(plan.id);
    setReturnedFromFlow(false);
    watchStartedAtRef.current = Math.min(watchStartedAtRef.current || Date.now(), Date.now());

    window.open(ANIMATION_APP_LINKS.googleFlow, "_blank", "noopener,noreferrer");

    const frameHint =
      plan.images.length >= 2
        ? "Frame AWAL & AKHIR sudah diunduh"
        : plan.images.length === 1
          ? "Frame AWAL sudah diunduh"
          : "Tanpa gambar";

    setGlobalNotice(
      watchDirHandleRef.current
        ? `Google Flow dibuka untuk ${plan.label}! ${copied ? "Prompt tersalin + " : ""}${frameHint}. Setelah render selesai & diunduh Flow, nmcGen otomatis menempelkan MP4-nya di belakang layar!`
        : `Google Flow dibuka untuk ${plan.label}! ${copied ? "Prompt tersalin + " : ""}${frameHint}. Setelah download MP4 dari Flow, kembali ke tab ini untuk 1-klik tempel otomatis.`,
    );
  };

  // Collect video files at root + 1-level subfolders (catches Flow Connector's Downloads/<folderSlug>/1 - *.mp4!)
  const collectVideoEntries = async (
    rootDir: FsDirHandleLike,
  ): Promise<Array<{ file: File; folderLabel: string; sigKey: string }>> => {
    const out: Array<{ file: File; folderLabel: string; sigKey: string }> = [];
    const scanOneDir = async (dir: FsDirHandleLike, prefix: string) => {
      for await (const entry of dir.values()) {
        if (entry.kind === "file") {
          const name = entry.name || "";
          if (!VIDEO_EXT_RE.test(name) || name.startsWith(".") || name.endsWith(".crdownload")) continue;
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

  // Background Downloads folder scanner (File System Access API on Desktop Chrome / Edge / Opera / Brave)
  const scanWatchedFolder = async () => {
    const dir = watchDirHandleRef.current;
    if (!dir) return;
    try {
      const entries = await collectVideoEntries(dir);
      const freshItems: Array<{ file: File; folderLabel: string }> = [];

      for (const { file, folderLabel, sigKey } of entries) {
        const sig = `${sigKey}:${file.lastModified}:${file.size}`;
        if (seenFilesRef.current.has(sig)) continue;
        if (file.lastModified < watchStartedAtRef.current - 5000) {
          seenFilesRef.current.add(sig);
          continue;
        }

        // Wait until file size is stable across two scans (download fully flushed to disk)
        const prevSize = pendingFileSizesRef.current.get(sigKey);
        if (prevSize !== file.size && Date.now() - file.lastModified < 2000) {
          pendingFileSizesRef.current.set(sigKey, file.size);
          continue;
        }
        pendingFileSizesRef.current.delete(sigKey);
        seenFilesRef.current.add(sig);
        freshItems.push({ file, folderLabel });
      }

      freshItems.sort((a, b) => a.file.lastModified - b.file.lastModified);
      const curPlans = plansRef.current;
      const attachedIds = new Set(
        Object.entries(clipStatesRef.current)
          .filter(([, st]) => Boolean(st?.blobUrl))
          .map(([id]) => id),
      );

      for (const { file, folderLabel } of freshItems) {
        const target = matchDownloadedVideoToPlan(
          file.name,
          curPlans,
          attachedIds,
          waitingFlowPlanIdRef.current,
        );
        if (!target) break;
        attachedIds.add(target.id);
        await attachVideoBlobToPlan(
          target,
          file,
          file.name,
          "flow-upload",
          `Otomatis terpasang dari "${folderLabel}": "${file.name}" → ${target.label}!`,
        );
      }
    } catch {
      // Permission revoked or folder unavailable
    }
  };

  const handleEnableFolderWatch = async () => {
    const picker = (window as WindowWithDirPicker).showDirectoryPicker;
    if (!picker) {
      setGlobalError("Browser ini belum mendukung pantau folder otomatis (tersedia di Chrome/Edge Desktop).");
      return;
    }
    try {
      const dir = await picker({
        id: "nmcgen-flow-downloads",
        mode: "read",
        startIn: "downloads",
      });
      // Snapshot existing videos in root + 1-level subfolders so old downloads are ignored
      const existing = await collectVideoEntries(dir);
      const snapshot = new Set<string>();
      for (const item of existing) {
        snapshot.add(`${item.sigKey}:${item.file.lastModified}:${item.file.size}`);
      }
      seenFilesRef.current = snapshot;
      pendingFileSizesRef.current.clear();
      watchStartedAtRef.current = Date.now();
      watchDirHandleRef.current = dir;
      setWatchFolderName(dir.name || "Downloads");
      setGlobalError("");
      setGlobalNotice(
        `Pantau otomatis folder "${dir.name || "Downloads"}" (+ subfolder "${flowFolderSlug}") aktif! Setiap MP4 baru dari Flow Connector otomatis langsung menempel sesuai nomor segmen.`,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setGlobalError(`Gagal mengaktifkan pantau folder: ${(err as Error).message}`);
      }
    }
  };

  const handleStopFolderWatch = () => {
    watchDirHandleRef.current = null;
    setWatchFolderName("");
    setGlobalNotice("Pantau folder Downloads otomatis dimatikan.");
  };

  // Run background polling interval while folder watch is active
  useEffect(() => {
    if (!watchFolderName) return;
    const timer = window.setInterval(() => {
      void scanWatchedFolder();
    }, 2500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchFolderName]);

  // Detect user returning from Google Flow tab -> trigger immediate folder scan OR surface 1-tap attach banner
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      if (watchDirHandleRef.current) {
        void scanWatchedFolder();
      }
      if (waitingFlowPlanIdRef.current && !clipStatesRef.current[waitingFlowPlanIdRef.current]?.blobUrl) {
        setReturnedFromFlow(true);
      }
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Support Ctrl+V / Cmd+V pasting a video file straight into the active Flow clip
  useEffect(() => {
    if (engineTab !== "handoff") return;
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const vidItem = items.find((it) => it.kind === "file" && it.type.startsWith("video/"));
      if (!vidItem) return;
      const file = vidItem.getAsFile();
      if (!file) return;
      const target =
        plansRef.current.find((p) => p.id === waitingFlowPlanIdRef.current) ??
        plansRef.current.find((p) => !clipStatesRef.current[p.id]?.blobUrl) ??
        plansRef.current[0];
      if (!target) return;
      e.preventDefault();
      void attachVideoBlobToPlan(target, file, file.name || `${target.id}.mp4`, "flow-upload");
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineTab]);

  const triggerSingleVideoPicker = (planId: string) => {
    uploadTargetPlanIdRef.current = planId;
    singleVideoInputRef.current?.click();
  };

  const handleSingleVideoInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const targetId = uploadTargetPlanIdRef.current ?? waitingFlowPlanIdRef.current;
    const target =
      plans.find((p) => p.id === targetId) ??
      plans.find((p) => !clipStates[p.id]?.blobUrl) ??
      plans[0];
    if (!target) return;
    await attachVideoBlobToPlan(target, file, file.name, "flow-upload");
  };

  const handleBatchVideoInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
      .filter((f) => f.type.startsWith("video/") || VIDEO_EXT_RE.test(f.name))
      .sort((a, b) => a.lastModified - b.lastModified);
    e.target.value = "";
    if (files.length === 0) return;

    let assigned = 0;
    const availablePlans = plans.filter((p) => !clipStatesRef.current[p.id]?.blobUrl);
    const pool = availablePlans.length >= files.length ? availablePlans : plans;
    for (let i = 0; i < Math.min(files.length, pool.length); i++) {
      await attachVideoBlobToPlan(pool[i], files[i], files[i].name, "flow-upload");
      assigned += 1;
    }
    if (assigned > 0) {
      setGlobalNotice(`${assigned} video MP4 hasil Google Flow otomatis terpasang berurutan ke segmen!`);
    }
  };

  const handleDropVideoOnPlan = async (e: React.DragEvent, plan: OmniClipPlan) => {
    e.preventDefault();
    setDragOverTarget(null);
    const file = Array.from(e.dataTransfer.files).find(
      (f) => f.type.startsWith("video/") || VIDEO_EXT_RE.test(f.name),
    );
    if (!file) {
      setGlobalError("Seret berkas video (.mp4 / .webm / .mov) hasil unduhan dari Google Flow.");
      return;
    }
    await attachVideoBlobToPlan(plan, file, file.name, "flow-upload");
  };

  // Capture 1-tap "Animasikan Segmen X" handoff coming from Step 3 Storyboard
  useEffect(() => {
    if (!autoAnimateSegmentId) return;
    setMode("segment");
    setPendingSegmentId(autoAnimateSegmentId);
    onConsumeAutoAnimate?.();
  }, [autoAnimateSegmentId, onConsumeAutoAnimate]);

  // Focus target segment (auto-launch Omni API if user is on Omni API tab, OR arm Flow Express card on Flow tab!)
  useEffect(() => {
    if (!pendingSegmentId || mode !== "segment") return;
    const targetPlan = plans.find((p) => p.segmentId === pendingSegmentId);
    if (!targetPlan) return;

    // Scroll target segment card smoothly into view on mobile & desktop
    setTimeout(() => {
      const el = document.querySelector(`[data-segment-id="${pendingSegmentId}"]`);
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 120);

    if (engineTab !== "omni-api") {
      setPendingSegmentId(null);
      setWaitingFlowPlanId(targetPlan.id);
      setGlobalNotice(
        `${targetPlan.label} siap! Unduh Paket Flow Connector (.zip) untuk render otomatis via Chrome Extension, atau klik "Salin CLI Flow" / "Buka Flow".`,
      );
      return;
    }

    if (!omniKeyAvailable) {
      setGlobalNotice(
        `Siap menganimasikan "${targetPlan.label}" (Frame Awal → Akhir) ke Gemini Omni 1.2 Flash. Tempel Gemini API Key sekali di bawah — otomatis langsung mulai render tanpa upload manual!`,
      );
      return;
    }

    setPendingSegmentId(null);
    const curState = clipStatesRef.current[targetPlan.id];
    if (curState?.status === "processing" || curState?.status === "queued") {
      return;
    }
    if (curState?.blobUrl) {
      setGlobalNotice(`Video "${targetPlan.label}" sudah siap diputar & diunduh di bawah.`);
      return;
    }
    if (curState?.fileUri || curState?.interactionId) {
      setGlobalNotice(`Memuat ulang video tersimpan untuk "${targetPlan.label}" (Gratis)...`);
      void handleRecoverSavedClip(targetPlan);
      return;
    }

    setGlobalNotice(
      `Mengirim langsung Frame Awal → Akhir dari "${targetPlan.label}" ke Gemini Omni 1.2 Flash (tanpa upload manual)...`,
    );
    void runOmniClipJob(targetPlan, "create");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSegmentId, mode, engineTab, omniKeyAvailable, plans]);

  const waitingFlowPlan = useMemo(
    () => plans.find((p) => p.id === waitingFlowPlanId) ?? null,
    [plans, waitingFlowPlanId],
  );

  const readyClips = useMemo(
    () =>
      plans
        .map((plan) => ({ plan, state: clipStates[plan.id] }))
        .filter((x) => x.state?.status === "ready" && Boolean(x.state.blobUrl)),
    [plans, clipStates],
  );

  // Merge all ready Omni 1.2 clips sequentially into 1 unified WebM video (with original audio!)
  const handleMergeReadyClips = async () => {
    if (readyClips.length < 2) return;
    if (typeof MediaRecorder === "undefined") {
      setGlobalError("Browser ini tidak mendukung penggabungan video (MediaRecorder tidak tersedia).");
      return;
    }

    setMergingClips(true);
    setGlobalError("");
    setGlobalNotice(`Menggabungkan ${readyClips.length} klip video menjadi 1 film utuh...`);

    const mergeW = sb.aspectRatio === "9:16" ? 720 : 1280;
    const mergeH = sb.aspectRatio === "9:16" ? 1280 : 720;
    const canvas = document.createElement("canvas");
    canvas.width = mergeW;
    canvas.height = mergeH;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setMergingClips(false);
      setGlobalError("Canvas 2D tidak tersedia untuk penggabungan.");
      return;
    }

    const audioCtx = new AudioContext();
    const audioDest = audioCtx.createMediaStreamDestination();
    const videoStream = canvas.captureStream(30);
    const combinedStream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioDest.stream.getAudioTracks(),
    ]);

    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : "video/webm";
    const recorder = new MediaRecorder(combinedStream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };

    const donePromise = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
    });

    recorder.start();

    try {
      for (let i = 0; i < readyClips.length; i++) {
        const clipUrl = readyClips[i].state.blobUrl!;
        setGlobalNotice(`Menggabungkan klip ${i + 1}/${readyClips.length}...`);

        await new Promise<void>((resolve, reject) => {
          const video = document.createElement("video");
          video.src = clipUrl;
          video.playsInline = true;
          video.crossOrigin = "anonymous";
          const source = audioCtx.createMediaElementSource(video);
          source.connect(audioDest);

          let raf = 0;
          const drawLoop = () => {
            if (video.paused || video.ended) return;
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, mergeW, mergeH);
            const vw = video.videoWidth || mergeW;
            const vh = video.videoHeight || mergeH;
            const scale = Math.min(mergeW / vw, mergeH / vh);
            const dw = vw * scale;
            const dh = vh * scale;
            ctx.drawImage(video, (mergeW - dw) / 2, (mergeH - dh) / 2, dw, dh);
            raf = requestAnimationFrame(drawLoop);
          };

          video.onended = () => {
            cancelAnimationFrame(raf);
            source.disconnect();
            resolve();
          };
          video.onerror = () => {
            cancelAnimationFrame(raf);
            source.disconnect();
            reject(new Error(`Gagal membaca Klip ${i + 1} saat penggabungan.`));
          };
          video.onplay = () => {
            raf = requestAnimationFrame(drawLoop);
          };
          void video.play().catch(reject);
        });
      }

      if (recorder.state !== "inactive") recorder.stop();
      const mergedBlob = await donePromise;
      const slug =
        (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") +
        "-omni-1.2-lengkap.webm";
      downloadBlob(mergedBlob, slug);
      setGlobalNotice(`Video gabungan (${readyClips.length} klip) berhasil diunduh!`);
    } catch (err) {
      if (recorder.state !== "inactive") recorder.stop();
      setGlobalError(`Penggabungan klip gagal: ${(err as Error).message}`);
    } finally {
      void audioCtx.close().catch(() => {});
      setMergingClips(false);
    }
  };

  // =========================================================================
  // BROWSER ANIMATIC ENGINE (100% Free Client-Side Cinema Reel + BGM + WebM)
  // =========================================================================
  const handleUploadBgm = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (bgmUrl) URL.revokeObjectURL(bgmUrl);
    const url = URL.createObjectURL(file);
    blobUrlsRef.current.push(url);
    setBgmUrl(url);
    setBgmName(file.name);
    setGlobalNotice(`Musik latar "${file.name}" dipasang untuk Animatic.`);
    e.target.value = "";
  };

  const handleClearBgm = () => {
    if (bgmAudioRef.current) {
      bgmAudioRef.current.pause();
      bgmAudioRef.current = null;
    }
    setBgmUrl("");
    setBgmName("");
  };

  const loadAnimaticImages = async () => {
    const loaded = await Promise.all(
      renderedFrames.map(
        (frame) =>
          new Promise<{ frame: typeof frame; segIdx: number; img: HTMLImageElement | null }>((resolve) => {
            const url = getSelectedFrameImage(frame);
            const segIdx = Math.max(1, segments.findIndex((s) => s.id === frame.segmentId) + 1);
            if (!url) return resolve({ frame, segIdx, img: null });
            const img = new Image();
            img.onload = () => resolve({ frame, segIdx, img });
            img.onerror = () => resolve({ frame, segIdx, img: null });
            img.src = url;
          }),
      ),
    );
    animImagesRef.current = loaded;
    return loaded;
  };

  const drawAnimaticFrame = (
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    elapsedSec: number,
    items: typeof animImagesRef.current,
    panelDur: number,
  ) => {
    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(0, 0, w, h);
    if (items.length === 0) return;

    const totalDur = items.length * panelDur;
    const t = Math.max(0, Math.min(elapsedSec, totalDur - 0.001));
    const idx = Math.min(items.length - 1, Math.floor(t / panelDur));
    const localT = (t - idx * panelDur) / panelDur; // 0..1
    const fadeSec = Math.min(0.55, panelDur * 0.22);

    const renderCover = (im: HTMLImageElement, progress: number, modeIdx: number, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      const zoom = modeIdx % 2 === 0 ? 1.0 + progress * 0.075 : 1.075 - progress * 0.075;
      const panX = ((modeIdx % 3) - 1) * (progress - 0.5) * 28;
      const baseScale = Math.max(w / im.naturalWidth, h / im.naturalHeight) * zoom;
      const dw = im.naturalWidth * baseScale;
      const dh = im.naturalHeight * baseScale;
      const dx = (w - dw) / 2 + panX;
      const dy = (h - dh) / 2;
      ctx.drawImage(im, dx, dy, dw, dh);
      ctx.restore();
    };

    const cur = items[idx];
    if (cur.img) {
      renderCover(cur.img, localT, idx, 1);
    }

    // Crossfade transition into next panel near the end of each panel
    const remainingInPanel = (idx + 1) * panelDur - t;
    if (remainingInPanel < fadeSec && idx + 1 < items.length) {
      const next = items[idx + 1];
      const mix = 1 - remainingInPanel / fadeSec;
      if (next.img) {
        renderCover(next.img, 0, idx + 1, Math.max(0, Math.min(1, mix)));
      }
    }

    // Subtle top-left badge: SEGMEN 01 · PANEL 2
    const pNum = cur.frame.panelNumber ?? idx + 1;
    const badge = `SEGMEN ${String(cur.segIdx).padStart(2, "0")} · PANEL ${pNum}: ${(cur.frame.title || "").toUpperCase()}`;
    ctx.save();
    ctx.font = `700 ${Math.round(h * 0.025)}px system-ui, -apple-system, sans-serif`;
    const bw = ctx.measureText(badge).width + 26;
    const bh = Math.round(h * 0.052);
    ctx.fillStyle = "rgba(11, 13, 18, 0.72)";
    ctx.fillRect(20, 18, bw, bh);
    ctx.fillStyle = "#f4ece0";
    ctx.textBaseline = "middle";
    ctx.fillText(badge, 33, 18 + bh / 2);

    // Dialogue subtitle bar at bottom
    const dlg = cur.frame.dialogue.trim();
    if (dlg) {
      const fontSize = Math.round(h * 0.032);
      ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
      const maxWidth = w * 0.84;
      const words = dlg.split(/\s+/);
      const wrapped: string[] = [];
      let line = "";
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && line) {
          wrapped.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      if (line) wrapped.push(line);

      const lineH = Math.round(fontSize * 1.38);
      const boxH = wrapped.length * lineH + 22;
      const boxY = h - boxH - 28;
      ctx.fillStyle = "rgba(10, 12, 16, 0.78)";
      ctx.fillRect(w * 0.06, boxY, w * 0.88, boxH);
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      wrapped.forEach((ln, li) => {
        ctx.fillText(ln, w / 2, boxY + 14 + li * lineH + lineH * 0.45);
      });
    }
    ctx.restore();
  };

  // Draw initial static preview when entering Animatic tab
  useEffect(() => {
    if (engineTab !== "animatic" || renderedFrames.length === 0) return;
    let active = true;
    void loadAnimaticImages().then((items) => {
      if (!active || !canvasRef.current) return;
      const ctx = canvasRef.current.getContext("2d");
      if (!ctx) return;
      drawAnimaticFrame(ctx, canvasRef.current.width, canvasRef.current.height, 0, items, secPerPanel);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineTab, renderedFrames.length, sb.aspectRatio]);

  const stopAnimatic = () => {
    if (animRafRef.current) {
      cancelAnimationFrame(animRafRef.current);
      animRafRef.current = null;
    }
    if (bgmAudioRef.current) {
      bgmAudioRef.current.pause();
      bgmAudioRef.current.currentTime = 0;
    }
    setAnimPlaying(false);
  };

  const runAnimaticPlayback = async (recordWebm: boolean) => {
    if (!canvasRef.current || renderedFrames.length === 0) return;
    stopAnimatic();
    const items = await loadAnimaticImages();
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const totalDur = items.length * secPerPanel;
    let recorder: MediaRecorder | null = null;
    let audioCtx: AudioContext | null = null;
    const chunks: BlobPart[] = [];

    // Prepare optional BGM playback / mixing
    let audioEl: HTMLAudioElement | null = null;
    if (bgmUrl) {
      audioEl = new Audio(bgmUrl);
      audioEl.loop = true;
      audioEl.volume = bgmVolume;
      bgmAudioRef.current = audioEl;
    }

    if (recordWebm) {
      if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") {
        setGlobalError("Browser ini tidak mendukung perekaman WebM langsung.");
        return;
      }
      const videoStream = canvas.captureStream(30);
      let combinedStream: MediaStream = videoStream;

      if (audioEl) {
        audioCtx = new AudioContext();
        const src = audioCtx.createMediaElementSource(audioEl);
        const gain = audioCtx.createGain();
        gain.gain.value = bgmVolume;
        const dest = audioCtx.createMediaStreamDestination();
        src.connect(gain);
        gain.connect(dest);
        gain.connect(audioCtx.destination);
        combinedStream = new MediaStream([
          ...videoStream.getVideoTracks(),
          ...dest.stream.getAudioTracks(),
        ]);
      }

      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
          ? "video/webm;codecs=vp9"
          : "video/webm";
      recorder = new MediaRecorder(combinedStream, { mimeType: mime, videoBitsPerSecond: 4_500_000 });
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        const safeName =
          (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") +
          "-animatic.webm";
        downloadBlob(blob, safeName);
        setAnimRecording(false);
        if (audioCtx) void audioCtx.close().catch(() => {});
        setGlobalNotice(
          `Animatic WebM (${totalDur.toFixed(1)} dtk${bgmName ? " + BGM" : ""}) berhasil diunduh.`,
        );
      };
      setAnimRecording(true);
      recorder.start();
    }

    if (audioEl) {
      void audioEl.play().catch(() => {});
    }

    setAnimPlaying(true);
    const startTs = performance.now();

    const tick = (now: number) => {
      const elapsed = (now - startTs) / 1000;
      const pct = Math.min(100, (elapsed / totalDur) * 100);
      setAnimProgress(pct);
      drawAnimaticFrame(ctx, canvas.width, canvas.height, elapsed, items, secPerPanel);
      if (elapsed >= totalDur) {
        setAnimPlaying(false);
        animRafRef.current = null;
        if (audioEl) {
          audioEl.pause();
          audioEl.currentTime = 0;
        }
        if (recorder && recorder.state !== "inactive") recorder.stop();
        return;
      }
      animRafRef.current = requestAnimationFrame(tick);
    };
    animRafRef.current = requestAnimationFrame(tick);
  };

  const canvasW = sb.aspectRatio === "9:16" ? 540 : 960;
  const canvasH = sb.aspectRatio === "9:16" ? 960 : 540;

  return (
    <div className="stepContainer">
      <div className="stepIntroRow">
        <div>
          <span className="stepKicker mono">TAHAP 4 DARI 4 · ANIMASIKAN STORYBOARD</span>
          <h2 className="stepTitle">Animasi Video (Antigravity / Gemini / Omni 1.2)</h2>
          <p className="stepSubtitle">
            Hidupkan seluruh <strong>{orderedFrames.length} panel</strong> ({segments.length} segmen) langsung lewat{" "}
            <strong>Gemini Omni 1.2 Flash</strong>, kirim 1-klik ke <strong>Antigravity / Gemini / Google Vids</strong>,
            atau putar <strong>Preview Animatic Instan</strong> langsung di browser.
          </p>
        </div>

        <div className="actionGroup">
          <button type="button" className="btn btnSm" onClick={onBackToStoryboard}>
            ← Kembali ke Storyboard
          </button>
          {orderedFrames.length > 0 ? (
            <button type="button" className="btn btnPrimary btnSm" onClick={handleDownloadOmniPackZip}>
              <DownloadIcon size={14} />
              <span>Unduh Paket Flow Connector (.zip)</span>
            </button>
          ) : null}
        </div>
      </div>

      {globalError ? (
        <div className="alertBox" data-tone="error" role="alert">
          {globalError}
        </div>
      ) : null}
      {globalNotice ? (
        <div className="alertBox" data-tone="ok" role="status">
          {globalNotice}
        </div>
      ) : null}

      <input
        ref={singleVideoInputRef}
        type="file"
        accept="video/*"
        className="srOnly"
        onChange={(e) => void handleSingleVideoInputChange(e)}
      />
      <input
        ref={batchVideoInputRef}
        type="file"
        accept="video/*"
        multiple
        className="srOnly"
        onChange={(e) => void handleBatchVideoInputChange(e)}
      />

      {orderedFrames.length === 0 ? (
        <div className="emptyPanel">
          <h3>Belum ada panel storyboard untuk dianimasikan</h3>
          <p>Buat minimal 1 panel di Tahap 3 (Storyboard Per-Segmen) terlebih dahulu.</p>
          <button type="button" className="btn btnPrimary btnLg" onClick={onBackToStoryboard}>
            Buka Tahap 3: Storyboard
          </button>
        </div>
      ) : (
        <>
          {/* Engine Mode Tabs */}
          <div className="animateEngineBar" role="tablist" aria-label="Pilih jalur animasi storyboard">
            <button
              type="button"
              role="tab"
              aria-selected={engineTab === "handoff"}
              className="animateEngineTab"
              data-active={engineTab === "handoff"}
              onClick={() => selectEngineTab("handoff")}
            >
              <div className="animateEngineTop">
                <strong>Google Flow + Flow Connector</strong>
                <span className="metaTag mono" data-tone={watchFolderName ? "ok" : undefined}>
                  {watchFolderName ? "Auto-Watch Aktif" : "Otomatis via Ekstensi"}
                </span>
              </div>
              <span>Auto-upload Frame Awal → Akhir via Flow Connector, tangkap MP4 otomatis &amp; gabung jadi 1 film</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={engineTab === "omni-api"}
              className="animateEngineTab"
              data-active={engineTab === "omni-api"}
              onClick={() => selectEngineTab("omni-api")}
            >
              <div className="animateEngineTop">
                <strong>Gemini Omni 1.2 Flash (API)</strong>
                <span className="metaTag mono" data-tone={omniKeyAvailable ? "ok" : undefined}>
                  {omniKeyAvailable ? "Siap" : "Butuh Billing Key"}
                </span>
              </div>
              <span>Render langsung MP4 + suara dari Frame Awal → Akhir (3–10 dtk, edit multi-turn)</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={engineTab === "animatic"}
              className="animateEngineTab"
              data-active={engineTab === "animatic"}
              onClick={() => selectEngineTab("animatic")}
            >
              <div className="animateEngineTop">
                <strong>Preview Animatic Instan</strong>
                <span className="metaTag mono">Gratis · Browser</span>
              </div>
              <span>Putar animasi kamera Ken Burns + subtitle &amp; ekspor WebM langsung tanpa kuota AI</span>
            </button>
          </div>

          {/* Shared Strategy Controls for Handoff & Omni 1.2 API */}
          {engineTab !== "animatic" ? (
            <section className="toolbarCard animateConfigBar" aria-label="Pengaturan strategi animasi">
              <div className="animateConfigGroup">
                <span className="fieldLabel">Strategi Animasi:</span>
                <div className="segToggle" role="group" aria-label="Strategi klip animasi">
                  <button
                    type="button"
                    className="segBtn"
                    aria-selected={mode === "segment"}
                    disabled={queueRunning}
                    onClick={() => {
                      setMode("segment");
                      setDurationSec((d) => clampOmniDuration(d, "segment"));
                    }}
                  >
                    Awal → Akhir Segmen ({segments.length})
                  </button>
                  <button
                    type="button"
                    className="segBtn"
                    aria-selected={mode === "transition"}
                    disabled={queueRunning}
                    onClick={() => {
                      setMode("transition");
                      setDurationSec((d) => clampOmniDuration(d, "transition"));
                    }}
                  >
                    Transisi Panel→Panel (Detail)
                  </button>
                </div>
              </div>

              <div className="actionGroup">
                <label className="inlineControl">
                  <span className="fieldLabel">Durasi/Klip:</span>
                  <select
                    className="select inputSm"
                    value={safeDuration}
                    disabled={queueRunning}
                    onChange={(e) => setDurationSec(Number(e.target.value))}
                  >
                    {(mode === "panel" ? DURATION_OPTIONS_FULL : DURATION_OPTIONS_TRANSITION).map((sec) => (
                      <option key={sec} value={sec}>
                        {sec} detik
                      </option>
                    ))}
                  </select>
                </label>

                <label className="inlineControl">
                  <span className="fieldLabel">Resolusi:</span>
                  <select
                    className="select inputSm"
                    value={resolution}
                    disabled={queueRunning}
                    onChange={(e) => setResolution(e.target.value as OmniResolution)}
                  >
                    {OMNI_RESOLUTIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>
          ) : null}

          {/* =============================================================== */}
          {/* TAB 1: GOOGLE FLOW + FLOW CONNECTOR AUTOMATION                  */}
          {/* =============================================================== */}
          {engineTab === "handoff" ? (
            <div className="omniApiWrap">
              {/* Auto-Return Sticky Banner when user comes back from Google Flow */}
              {returnedFromFlow && waitingFlowPlan && !clipStates[waitingFlowPlan.id]?.blobUrl ? (
                <section
                  className="flowReturnBanner"
                  data-drag-over={dragOverTarget === "banner"}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverTarget("banner");
                  }}
                  onDragLeave={() => setDragOverTarget(null)}
                  onDrop={(e) => void handleDropVideoOnPlan(e, waitingFlowPlan)}
                  aria-label="Tempel video hasil Google Flow"
                >
                  <div>
                    <strong>Kembali dari Google Flow — Tempel MP4 untuk {waitingFlowPlan.label}</strong>
                    <p className="fieldHint" style={{ margin: "3px 0 0" }}>
                      Klik tombol di kanan untuk pilih MP4 hasil unduhan Flow (atau seret file / tekan Ctrl+V). Video
                      otomatis tersimpan lokal &amp; siap digabung jadi 1 film.
                    </p>
                  </div>
                  <div className="actionGroup">
                    <button
                      type="button"
                      className="btn btnOk"
                      onClick={() => triggerSingleVideoPicker(waitingFlowPlan.id)}
                    >
                      <UploadIcon size={14} />
                      <span>Tempel MP4 {waitingFlowPlan.label.split(":")[0]}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btnGhost btnSm"
                      onClick={() => setReturnedFromFlow(false)}
                    >
                      Tutup
                    </button>
                  </div>
                </section>
              ) : null}

              {/* Combined Sequential Movie Player + 1-Click Merge (shared with Flow uploads!) */}
              {readyClips.length > 0 ? (
                <section className="panelCard omniReelCard">
                  <div className="panelHead">
                    <div className="metaInline">
                      <FilmIcon size={16} />
                      <h3>
                        Film Gabungan ({readyClips.length}/{plans.length} Klip Terpasang)
                      </h3>
                    </div>
                    <div className="actionGroup">
                      <span className="metaTag mono">
                        Klip {Math.min(playlistIdx + 1, readyClips.length)} / {readyClips.length}
                      </span>
                      {readyClips.length >= 2 ? (
                        <button
                          type="button"
                          className="btn btnPrimary btnSm"
                          disabled={mergingClips}
                          onClick={() => void handleMergeReadyClips()}
                          title="Gabungkan semua video segmen beserta suaranya jadi 1 berkas video WebM"
                        >
                          <DownloadIcon size={13} />
                          <span>
                            {mergingClips ? "Menggabungkan..." : `Gabung & Unduh 1 Video (${readyClips.length} Klip)`}
                          </span>
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="omniReelStage">
                    <video
                      key={readyClips[Math.min(playlistIdx, readyClips.length - 1)]?.state.blobUrl}
                      src={readyClips[Math.min(playlistIdx, readyClips.length - 1)]?.state.blobUrl}
                      controls
                      playsInline
                      className="omniVideoPlayer"
                      onEnded={() => {
                        if (playlistIdx + 1 < readyClips.length) {
                          setPlaylistIdx(playlistIdx + 1);
                        }
                      }}
                    />
                  </div>

                  <div className="actionGroup">
                    {readyClips.map((item, i) => (
                      <button
                        key={item.plan.id}
                        type="button"
                        className={i === Math.min(playlistIdx, readyClips.length - 1) ? "btn btnPrimary btnSm" : "btn btnSm"}
                        onClick={() => setPlaylistIdx(i)}
                      >
                        Klip {i + 1}: {item.plan.label.slice(0, 28)}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              <div className="animateHandoffGrid">
                {/* Left: Flow Connector Full Automation + Background Downloads Auto-Watcher */}
                <section className="panelCard">
                  <div className="panelHead">
                    <h3>1. Otomatis via Flow Connector</h3>
                    <span className="metaTag mono">
                      {readyClips.length}/{plans.length} video terpasang
                    </span>
                  </div>

                  {/* Flow Connector Chrome Extension + CLI Bridge Card */}
                  <div className="flowConnectorCard">
                    <div className="panelHead">
                      <div>
                        <strong>Auto-Upload &amp; Render Google Flow (Chrome Desktop)</strong>
                        <p className="fieldHint" style={{ margin: "2px 0 0" }}>
                          Tidak perlu upload gambar &amp; tempel prompt manual — ekstensi <strong>Flow Connector</strong>{" "}
                          mengirim Frame Awal + Akhir, menekan Generate, dan mengunduh semua MP4 otomatis.
                        </p>
                      </div>
                      <span className="statusBadge mono" data-tone="ok">
                        Gratis 30 Video/Hari
                      </span>
                    </div>

                    <label className="inlineControl" style={{ width: "100%", justifyContent: "space-between" }}>
                      <span className="fieldLabel">Model Google Flow:</span>
                      <select
                        className="select inputSm"
                        value={flowModel}
                        onChange={(e) => selectFlowModel(e.target.value as FlowConnectorVideoModel)}
                        aria-label="Model video Google Flow Connector"
                      >
                        {FLOW_CONNECTOR_MODELS.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <ol className="flowConnectorSteps">
                      <li>
                        <strong>Pasang sekali di Chrome/Edge Desktop:</strong>{" "}
                        <a
                          href={ANIMATION_APP_LINKS.flowConnectorExtension}
                          target="_blank"
                          rel="noreferrer"
                          className="flowInlineLink"
                        >
                          Ekstensi Flow Connector (Chrome Web Store)
                        </a>{" "}
                        lalu pasang CLI lokal:
                        <div className="flowCodeChip">
                          <code className="mono">{FLOW_CLI_INSTALL_CMD}</code>
                          <button
                            type="button"
                            className="btn btnGhost btnSm"
                            onClick={() => void handleCopyText(FLOW_CLI_INSTALL_CMD, "flow-cli-install")}
                          >
                            {copyFeedback === "flow-cli-install" ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                            <span>{copyFeedback === "flow-cli-install" ? "Tersalin" : "Salin"}</span>
                          </button>
                        </div>
                      </li>
                      <li>
                        <strong>Jalankan otomatis semua segmen:</strong> Unduh paket ZIP di bawah → ekstrak → klik 2×{" "}
                        <code className="mono">run_flow_connector.bat</code> (Windows) /{" "}
                        <code className="mono">run_flow_connector.command</code> (Mac) atau{" "}
                        <code className="mono">node run_flow_connector.mjs</code> sambil tab{" "}
                        <strong>flow.google.com</strong> terbuka &amp; terlihat.
                      </li>
                      <li>
                        <strong>Hasil MP4 otomatis masuk kembali ke nmcGen:</strong> Aktifkan{" "}
                        <strong>Pantau Downloads</strong> di bawah — skrip menyimpan hasil ke{" "}
                        <code className="mono">Downloads/{flowFolderSlug}/</code> dan nmcGen otomatis menempelkannya ke
                        Klip 01..{String(plans.length).padStart(2, "0")}.
                      </li>
                    </ol>

                    <div className="actionGroup">
                      <button type="button" className="btn btnPrimary" onClick={handleDownloadOmniPackZip}>
                        <DownloadIcon size={14} />
                        <span>Unduh Paket Flow Connector (.zip)</span>
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void handleCopyText(flowConnectorAgentPrompt, "flow-agent")}
                        title="Tempel ke Antigravity Desktop / Claude Code / Cursor yang terhubung MCP flow-auto-mcp"
                      >
                        {copyFeedback === "flow-agent" ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                        <span>
                          {copyFeedback === "flow-agent" ? "Tersalin!" : "Salin Prompt Agent Flow"}
                        </span>
                      </button>
                    </div>

                    <p className="fieldHint" style={{ margin: 0 }}>
                      Catatan: Ekstensi Chrome hanya berjalan di <strong>Laptop/PC (Chrome/Edge Desktop)</strong> — iPhone
                      tidak bisa memasang ekstensi Chrome. Pastikan memasang ekstensi{" "}
                      <strong>Flow Connector — connect your coding agent to Google Flow image &amp; video</strong> dari
                      tautan di atas.
                    </p>
                  </div>

                  {/* Desktop Background Downloads Auto-Watcher (Official File System Access API) */}
                  <div className="flowWatchBox" data-active={Boolean(watchFolderName)}>
                    <div style={{ flex: "1 1 220px" }}>
                      <strong>
                        {watchFolderName
                          ? `Pantau Otomatis Aktif: "${watchFolderName}" (+ ${flowFolderSlug})`
                          : "Auto-Tempel MP4 dari Downloads (Chrome/Edge Desktop)"}
                      </strong>
                      <p className="fieldHint" style={{ margin: "3px 0 0" }}>
                        {watchFolderName
                          ? `Memantau "${watchFolderName}/" & "${watchFolderName}/${flowFolderSlug}/" tiap 2,5 detik. MP4 bernomor 1..${plans.length} otomatis menempel ke segmen tepat!`
                          : folderWatchSupported
                            ? `Pilih folder Downloads sekali saja — saat Flow Connector mengunduh MP4 ke Downloads/${flowFolderSlug}/, nmcGen otomatis menangkap & menempelkannya ke segmen sesuai nomor.`
                            : "Di browser HP (iPhone/Safari), folder otomatis dibatasi OS. Gunakan 'Simpan Frame' → buka Google Flow → lalu 'Tempel MP4' atau 'Unggah Banyak MP4 Sekaligus'."}
                      </p>
                    </div>
                    <div className="actionGroup">
                      {watchFolderName ? (
                        <>
                          <button
                            type="button"
                            className="btn btnSm"
                            onClick={() => void scanWatchedFolder()}
                          >
                            <RefreshIcon size={13} />
                            <span>Pindai Sekarang</span>
                          </button>
                          <button
                            type="button"
                            className="btn btnGhost btnSm"
                            onClick={handleStopFolderWatch}
                          >
                            Matikan
                          </button>
                        </>
                      ) : folderWatchSupported ? (
                        <button
                          type="button"
                          className="btn btnOk btnSm"
                          onClick={() => void handleEnableFolderWatch()}
                        >
                          <SparklesIcon size={13} />
                          <span>Aktifkan Pantau Downloads</span>
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="actionGroup">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => batchVideoInputRef.current?.click()}
                      title="Pilih beberapa berkas MP4 hasil Google Flow sekaligus untuk dipasang otomatis berurutan ke Segmen 1..N"
                    >
                      <UploadIcon size={14} />
                      <span>Unggah Banyak MP4 Sekaligus</span>
                    </button>
                    <button
                      type="button"
                      className="btn btnGhost"
                      onClick={() => void handleCopyText(masterHandoffPrompt, "master")}
                    >
                      {copyFeedback === "master" ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                      <span>
                        {copyFeedback === "master" ? "Tersalin!" : "Prompt Master"}
                      </span>
                    </button>
                  </div>

                  <div className="handoffAppRow">
                    <a
                      href={ANIMATION_APP_LINKS.flowConnectorExtension}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btnSm"
                    >
                      <ExternalLinkIcon size={13} />
                      <span>Pasang Flow Connector</span>
                    </a>
                    <a
                      href={ANIMATION_APP_LINKS.googleFlow}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btnSm"
                    >
                      <ExternalLinkIcon size={13} />
                      <span>Google Flow</span>
                    </a>
                    <a
                      href={ANIMATION_APP_LINKS.googleVids}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btnSm"
                    >
                      <ExternalLinkIcon size={13} />
                      <span>Google Vids</span>
                    </a>
                    <a
                      href={ANIMATION_APP_LINKS.gemini}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btnSm"
                    >
                      <ExternalLinkIcon size={13} />
                      <span>Gemini App</span>
                    </a>
                  </div>

                  <details className="subtleDetails">
                    <summary>Pratinjau Prompt Agent Flow Connector ({plans.length} Klip)</summary>
                    <div className="subtleDetailsBody">
                      <pre className="scriptPeekPre">{flowConnectorAgentPrompt}</pre>
                    </div>
                  </details>

                  <details className="subtleDetails">
                    <summary>Pratinjau Prompt Master Antigravity / Gemini</summary>
                    <div className="subtleDetailsBody">
                      <pre className="scriptPeekPre">{masterHandoffPrompt}</pre>
                    </div>
                  </details>
                </section>

                {/* Right: Per-Segment Google Flow Express Cards (CLI Copy + Manual Launch + Attach MP4) */}
                <section className="panelCard">
                  <div className="panelHead">
                    <h3>2. Jalur Per-Segmen (Frame Awal → Akhir)</h3>
                    <span className="fieldHint">Auto-Watch / Salin CLI Flow / Tempel MP4</span>
                  </div>

                  <div className="omniClipList">
                    {plans.map((plan, idx) => {
                      const st = clipStates[plan.id];
                      const isWaiting = waitingFlowPlanId === plan.id && !st?.blobUrl;
                      const cliCmd = buildFlowConnectorCliCommand(plan, {
                        index: idx + 1,
                        folderSlug: flowFolderSlug,
                        model: flowModel,
                        wait: true,
                      });
                      const cliCopyKey = `cli-${plan.id}`;

                      return (
                        <article
                          key={plan.id}
                          data-segment-id={plan.segmentId}
                          data-status={st?.blobUrl ? "ready" : isWaiting ? "processing" : "idle"}
                          data-drag-over={dragOverTarget === plan.id}
                          className="omniClipCard"
                          onDragOver={(e) => {
                            e.preventDefault();
                            setDragOverTarget(plan.id);
                          }}
                          onDragLeave={() => setDragOverTarget(null)}
                          onDrop={(e) => void handleDropVideoOnPlan(e, plan)}
                        >
                          <div className="omniClipHead">
                            <div className="metaInline">
                              <span className="frameIndexPill mono">KLIP {String(idx + 1).padStart(2, "0")}</span>
                              <strong>{plan.label}</strong>
                            </div>
                            <span
                              className="statusBadge mono"
                              data-tone={st?.blobUrl ? "ok" : isWaiting ? "warn" : undefined}
                            >
                              {st?.blobUrl
                                ? "Video Terpasang ✓"
                                : isWaiting
                                  ? "Menunggu Hasil Flow..."
                                  : `${plan.durationSec} dtk · ${plan.summary}`}
                            </span>
                          </div>

                          {plan.images.length > 0 ? (
                            <div className="omniThumbRow">
                              {plan.images.map((im, i) => (
                                <div key={`${plan.id}-im-${i}`} className="omniThumbItem" title={im.label}>
                                  <img src={im.dataUrl} alt={im.label} />
                                  <span className="mono">
                                    {plan.images.length === 2 ? (i === 0 ? "AWAL" : "AKHIR") : `#${i + 1}`}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="fieldHint">Belum ada gambar panel tergenerate di klip ini.</p>
                          )}

                          {/* Flow Connector CLI + Manual Flow + Direct Attach MP4 Controls */}
                          <div className="actionGroup">
                            <button
                              type="button"
                              className={st?.blobUrl ? "btn btnSm" : "btn btnPrimary btnSm"}
                              onClick={() => void handleCopyText(cliCmd, cliCopyKey)}
                              title={`Salin perintah flow-auto untuk Klip ${idx + 1} (jalankan di dalam folder ekstrak ZIP)`}
                            >
                              {copyFeedback === cliCopyKey ? <CheckIcon size={13} /> : <SparklesIcon size={13} />}
                              <span>{copyFeedback === cliCopyKey ? "CLI Tersalin!" : "Salin CLI Flow"}</span>
                            </button>

                            <button
                              type="button"
                              className={isWaiting ? "btn btnOk btnSm" : "btn btnSm"}
                              onClick={() => triggerSingleVideoPicker(plan.id)}
                              title="Pilih berkas MP4 hasil unduhan Google Flow untuk ditempel ke segmen ini"
                            >
                              <UploadIcon size={13} />
                              <span>{st?.blobUrl ? "Ganti MP4" : "Tempel MP4"}</span>
                            </button>

                            {plan.images.length > 0 ? (
                              <button
                                type="button"
                                className="btn btnGhost btnSm"
                                onClick={() => void handleSaveFramesForPlan(plan)}
                                title="Simpan Frame Awal & Akhir ke Galeri/Downloads"
                              >
                                <DownloadIcon size={13} />
                                <span>Frame</span>
                              </button>
                            ) : null}

                            <button
                              type="button"
                              className="btn btnGhost btnSm"
                              onClick={() => void handleLaunchFlowForClip(plan)}
                              title="Buka Google Flow manual + salin prompt + unduh Frame Awal & Akhir"
                            >
                              <ExternalLinkIcon size={13} />
                              <span>Buka Flow</span>
                            </button>

                            <button
                              type="button"
                              className="btn btnGhost btnSm"
                              onClick={() => void handleCopyText(plan.prompt, plan.id)}
                            >
                              {copyFeedback === plan.id ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                              <span>{copyFeedback === plan.id ? "Tersalin" : "Prompt"}</span>
                            </button>
                          </div>

                          {/* Embedded Video Player when Flow/Omni MP4 is attached */}
                          {st?.blobUrl ? (
                            <div className="omniClipVideoBox">
                              <video src={st.blobUrl} controls playsInline className="omniVideoPlayer" />
                              <div className="actionGroup" style={{ justifyContent: "space-between" }}>
                                <span className="fieldHint mono">
                                  {st.filename || `${plan.id}.mp4`} · Tersimpan lokal
                                </span>
                                <div className="actionGroup">
                                  <button
                                    type="button"
                                    className="btn btnSm"
                                    onClick={() => {
                                      if (!st.blob) return;
                                      const slug =
                                        project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
                                        "nmcgen";
                                      downloadBlob(st.blob, `${slug}-klip-${String(idx + 1).padStart(2, "0")}.mp4`);
                                    }}
                                  >
                                    <DownloadIcon size={13} />
                                    <span>Unduh</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btnGhost btnSm"
                                    onClick={() => void handleRemoveClipVideo(plan)}
                                    title="Lepas video dari segmen ini"
                                  >
                                    <TrashIcon size={13} />
                                  </button>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="flowDropHint">
                              <span>
                                {watchFolderName
                                  ? `Auto-Watch aktif: MP4 di Downloads/${flowFolderSlug}/${idx + 1} - *.mp4 otomatis menempel ke sini.`
                                  : `Jalankan run_flow_connector.mjs / seret MP4 ke kartu ini / tekan Ctrl+V.`}
                              </span>
                            </div>
                          )}

                          <details className="subtleDetails">
                            <summary>Lihat / Edit Prompt Omni 1.2</summary>
                            <div className="subtleDetailsBody">
                              <textarea
                                aria-label={`Prompt Omni 1.2 untuk ${plan.label}`}
                                className="textarea omniPromptBox"
                                value={plan.prompt}
                                onChange={(e) =>
                                  setPromptOverrides((prev) => ({ ...prev, [plan.id]: e.target.value }))
                                }
                              />
                            </div>
                          </details>
                        </article>
                      );
                    })}
                  </div>
                </section>
              </div>
            </div>
          ) : null}

          {/* =============================================================== */}
          {/* TAB 2: DIRECT GEMINI OMNI 1.2 FLASH INTERACTIONS API            */}
          {/* =============================================================== */}
          {engineTab === "omni-api" ? (
            <div className="omniApiWrap">
              {/* Gemini API Key Connection Card */}
              <section className="panelCard omniKeyCard">
                <div className="panelHead">
                  <div className="metaInline">
                    <h3>Koneksi Gemini Omni 1.2 Flash ({OMNI_MODEL_ID})</h3>
                    <span className="statusBadge" data-tone={omniKeyAvailable ? "ok" : "warn"}>
                      {omniKeyAvailable ? (
                        <>
                          <CheckIcon size={12} />
                          <span>
                            {localGeminiKey
                              ? `API Key Lokal (${geminiKeyHint})`
                              : "API Key Server Aktif"}
                          </span>
                        </>
                      ) : (
                        <span>Belum Ada Gemini API Key</span>
                      )}
                    </span>
                  </div>

                  <div className="actionGroup">
                    {recoverableClips.length > 0 ? (
                      <button
                        type="button"
                        className="btn btnOk btnSm"
                        disabled={!omniKeyAvailable || queueRunning}
                        onClick={() => void handleRecoverAllSavedClips()}
                        title="Muat ulang klip yang pernah dirender tanpa biaya render ulang"
                      >
                        <RefreshIcon size={13} />
                        <span>Muat Ulang Video Tersimpan ({recoverableClips.length})</span>
                      </button>
                    ) : null}
                    <a
                      href={ANIMATION_APP_LINKS.aiStudio}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btnGhost btnSm"
                    >
                      <ExternalLinkIcon size={13} />
                      <span>Ambil Key di AI Studio</span>
                    </a>
                    {localGeminiKey ? (
                      <button type="button" className="btn btnGhost btnSm" onClick={handleClearGeminiKey}>
                        Hapus Key
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="quickReviseRow">
                  <input
                    type="password"
                    aria-label="Gemini API Key untuk Omni 1.2 Flash"
                    className="input"
                    value={geminiKeyDraft}
                    onChange={(e) => setGeminiKeyDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleSaveGeminiKey();
                      }
                    }}
                    placeholder={
                      omniKeyAvailable
                        ? "Tempel Gemini API Key baru jika ingin mengganti..."
                        : "Tempel Gemini API Key (AIza...) untuk render langsung via Gemini Omni 1.2 Flash..."
                    }
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={!geminiKeyDraft.trim()}
                    onClick={handleSaveGeminiKey}
                  >
                    Simpan Key
                  </button>
                  {queueRunning ? (
                    <button type="button" className="btn btnDanger" onClick={handleCancelQueue}>
                      Hentikan Antrean
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btnPrimary"
                      disabled={!omniKeyAvailable || plans.length === 0}
                      onClick={() => void handleAnimateAll()}
                    >
                      <SparklesIcon size={14} />
                      <span>Animasikan Semua ({plans.length} Klip)</span>
                    </button>
                  )}
                </div>

                <p className="fieldHint">
                  Mengirim Frame Awal &amp; Akhir langsung ke endpoint resmi{" "}
                  <code className="mono">/v1beta/interactions</code> ({OMNI_MODEL_ID}) —{" "}
                  <strong>tidak perlu upload manual lagi ke Google Flow</strong>. Estimasi biaya Google AI Studio
                  ~$0.07/detik (720p) sudah termasuk audio &amp; lip-sync.{" "}
                  <strong>Kunci free tier (tanpa billing aktif di proyek Google) akan ditolak Google saat generate</strong>{" "}
                  — untuk opsi tanpa API key berbayar, gunakan tab <strong>Antigravity / Gemini / Omni Web</strong>.
                </p>
              </section>

              {/* Combined Sequential Reel Player when >= 1 clip is ready */}
              {readyClips.length > 0 ? (
                <section className="panelCard omniReelCard">
                  <div className="panelHead">
                    <div className="metaInline">
                      <FilmIcon size={16} />
                      <h3>
                        Putar Gabungan Hasil Animasi ({readyClips.length}/{plans.length} Klip Siap)
                      </h3>
                    </div>
                    <div className="actionGroup">
                      <span className="metaTag mono">
                        Klip {Math.min(playlistIdx + 1, readyClips.length)} / {readyClips.length}
                      </span>
                      {readyClips.length >= 2 ? (
                        <button
                          type="button"
                          className="btn btnPrimary btnSm"
                          disabled={mergingClips}
                          onClick={() => void handleMergeReadyClips()}
                          title="Gabungkan semua klip siap beserta suaranya jadi 1 berkas video WebM"
                        >
                          <DownloadIcon size={13} />
                          <span>
                            {mergingClips ? "Menggabungkan..." : `Gabung & Unduh 1 Video (${readyClips.length} Klip)`}
                          </span>
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="omniReelStage">
                    <video
                      key={readyClips[Math.min(playlistIdx, readyClips.length - 1)]?.state.blobUrl}
                      src={readyClips[Math.min(playlistIdx, readyClips.length - 1)]?.state.blobUrl}
                      controls
                      playsInline
                      className="omniVideoPlayer"
                      onEnded={() => {
                        if (playlistIdx + 1 < readyClips.length) {
                          setPlaylistIdx(playlistIdx + 1);
                        }
                      }}
                    />
                  </div>

                  <div className="actionGroup">
                    {readyClips.map((item, i) => (
                      <button
                        key={item.plan.id}
                        type="button"
                        className={i === Math.min(playlistIdx, readyClips.length - 1) ? "btn btnPrimary btnSm" : "btn btnSm"}
                        onClick={() => setPlaylistIdx(i)}
                      >
                        Klip {i + 1}: {item.plan.label.slice(0, 28)}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {/* Per-Clip Omni 1.2 Queue Cards */}
              <div className="omniClipGrid">
                {plans.map((plan, idx) => {
                  const st = clipStates[plan.id] ?? { status: "idle" };
                  const isBusyClip = st.status === "processing" || st.status === "queued";
                  const editText = editInputs[plan.id] ?? "";
                  const canRecoverSaved = Boolean((st.fileUri || st.interactionId) && !st.blobUrl);

                  return (
                    <article
                      key={plan.id}
                      data-segment-id={plan.segmentId}
                      className="panelCard omniClipCard"
                      data-status={st.status}
                    >
                      <div className="omniClipHead">
                        <div className="metaInline">
                          <span className="frameIndexPill mono">KLIP {String(idx + 1).padStart(2, "0")}</span>
                          <strong>{plan.label}</strong>
                        </div>
                        <span
                          className="statusBadge mono"
                          data-tone={
                            st.status === "ready"
                              ? "ok"
                              : st.status === "error"
                                ? undefined
                                : st.status === "processing"
                                  ? "warn"
                                  : undefined
                          }
                        >
                          {st.status === "ready"
                            ? st.blobUrl
                              ? "Selesai ✓"
                              : "Tersimpan di Omni"
                            : st.status === "processing"
                              ? "Merender..."
                              : st.status === "queued"
                                ? "Mengantre"
                                : st.status === "error"
                                  ? "Gagal"
                                  : `${plan.durationSec} dtk · ${plan.resolution}`}
                        </span>
                      </div>

                      {plan.images.length > 0 ? (
                        <div className="omniThumbRow">
                          {plan.images.map((im, i) => (
                            <div key={`${plan.id}-t-${i}`} className="omniThumbItem" title={im.label}>
                              <img src={im.dataUrl} alt={im.label} />
                              <span className="mono">
                                {plan.images.length === 2 ? (i === 0 ? "AWAL" : "AKHIR") : `#${i + 1}`}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {st.progressText ? (
                        <div className="alertBox" role="status">
                          {st.progressText}
                        </div>
                      ) : null}

                      {st.error ? (
                        <div className="alertBox" data-tone="error" role="alert">
                          {st.error}
                        </div>
                      ) : null}

                      {st.blobUrl ? (
                        <div className="omniClipVideoBox">
                          <video src={st.blobUrl} controls playsInline className="omniVideoPlayer" />
                          <div className="actionGroup">
                            <button
                              type="button"
                              className="btn btnSm"
                              onClick={() => {
                                if (!st.blob) return;
                                const slug =
                                  project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
                                  "nmcgen";
                                downloadBlob(st.blob, `${slug}-klip-${String(idx + 1).padStart(2, "0")}.mp4`);
                              }}
                            >
                              <DownloadIcon size={13} />
                              <span>Unduh MP4</span>
                            </button>

                            {st.interactionId ? (
                              <button
                                type="button"
                                className="btn btnSm"
                                disabled={isBusyClip}
                                onClick={() =>
                                  void runOmniClipJob(
                                    plan,
                                    "extend",
                                    "Continue the scene smoothly with natural motion and matching audio.",
                                    st.interactionId,
                                  )
                                }
                              >
                                <span>+ Perpanjang 5 dtk</span>
                              </button>
                            ) : null}
                          </div>

                          {/* Multi-turn conversational video edit using previous_interaction_id */}
                          {st.interactionId ? (
                            <div className="inlineEditRow">
                              <input
                                aria-label={`Revisi video Klip ${idx + 1}`}
                                className="input inputSm"
                                value={editText}
                                disabled={isBusyClip}
                                onChange={(e) =>
                                  setEditInputs((prev) => ({ ...prev, [plan.id]: e.target.value }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && editText.trim()) {
                                    e.preventDefault();
                                    void runOmniClipJob(plan, "edit", editText.trim(), st.interactionId);
                                  }
                                }}
                                placeholder="Edit klip via chat (mis. buat gerakan lebih halus, pertahankan sisanya)..."
                              />
                              <button
                                type="button"
                                className="btn btnSm"
                                disabled={isBusyClip || !editText.trim()}
                                onClick={() =>
                                  void runOmniClipJob(plan, "edit", editText.trim(), st.interactionId)
                                }
                              >
                                Revisi
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      <details className="subtleDetails">
                        <summary>Edit Prompt Omni 1.2 Flash ({plan.summary})</summary>
                        <div className="subtleDetailsBody">
                          <textarea
                            aria-label={`Prompt untuk ${plan.label}`}
                            className="textarea omniPromptBox"
                            value={plan.prompt}
                            disabled={isBusyClip}
                            onChange={(e) =>
                              setPromptOverrides((prev) => ({ ...prev, [plan.id]: e.target.value }))
                            }
                          />
                        </div>
                      </details>

                      <div className="actionGroup">
                        {canRecoverSaved ? (
                          <button
                            type="button"
                            className="btn btnOk btnSm"
                            disabled={!omniKeyAvailable || isBusyClip}
                            onClick={() => void handleRecoverSavedClip(plan)}
                          >
                            <RefreshIcon size={13} />
                            <span>Muat Ulang Video (Gratis)</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={canRecoverSaved ? "btn btnSm" : "btn btnPrimary btnSm"}
                          disabled={!omniKeyAvailable || isBusyClip}
                          onClick={() => void runOmniClipJob(plan, "create")}
                        >
                          {st.blobUrl || canRecoverSaved ? <RefreshIcon size={13} /> : <SparklesIcon size={13} />}
                          <span>{st.blobUrl || canRecoverSaved ? "Render Ulang (Omni 1.2)" : "Animasikan Klip (Omni 1.2)"}</span>
                        </button>
                        <button
                          type="button"
                          className="btn btnGhost btnSm"
                          onClick={() => void handleCopyText(plan.prompt, plan.id)}
                        >
                          <CopyIcon size={13} />
                          <span>{copyFeedback === plan.id ? "Tersalin" : "Salin Prompt"}</span>
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* =============================================================== */}
          {/* TAB 3: FREE IN-BROWSER ANIMATIC REEL + BGM + WEBM EXPORT        */}
          {/* =============================================================== */}
          {engineTab === "animatic" ? (
            <section className="panelCard animaticCard">
              <div className="panelHead">
                <div>
                  <h3>Preview Animatic Instan ({renderedFrames.length} Panel Bergambar)</h3>
                  <p className="fieldHint">
                    Cek alur gerak, tempo, musik latar, dan dialog seluruh storyboard langsung di browser (Ken Burns +
                    crossfade + subtitle) tanpa API key dan tanpa biaya.
                  </p>
                </div>

                <div className="actionGroup">
                  <label className="inlineControl">
                    <span className="fieldLabel">Durasi/Panel:</span>
                    <select
                      className="select inputSm"
                      value={secPerPanel}
                      disabled={animPlaying || animRecording}
                      onChange={(e) => setSecPerPanel(Number(e.target.value))}
                    >
                      <option value={2.5}>2,5 detik (Cepat)</option>
                      <option value={3.5}>3,5 detik (Standar)</option>
                      <option value={5}>5,0 detik (Santai)</option>
                    </select>
                  </label>

                  <button
                    type="button"
                    className="btn btnSm"
                    disabled={animPlaying || animRecording}
                    onClick={() => bgmInputRef.current?.click()}
                  >
                    <UploadIcon size={13} />
                    <span>{bgmName ? "Ganti BGM" : "+ Musik Latar (MP3/WAV)"}</span>
                  </button>
                  <input
                    ref={bgmInputRef}
                    type="file"
                    accept="audio/*"
                    className="srOnly"
                    onChange={handleUploadBgm}
                  />
                </div>
              </div>

              {bgmName ? (
                <div className="toolbarCard" style={{ padding: "8px 12px" }}>
                  <div className="metaInline">
                    <span className="metaTag mono">BGM Aktif</span>
                    <strong style={{ fontSize: 12.5 }}>{bgmName}</strong>
                  </div>
                  <div className="actionGroup">
                    <label className="inlineControl">
                      <span className="fieldHint">Volume ({Math.round(bgmVolume * 100)}%)</span>
                      <input
                        type="range"
                        min={0.05}
                        max={1}
                        step={0.05}
                        value={bgmVolume}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setBgmVolume(v);
                          if (bgmAudioRef.current) bgmAudioRef.current.volume = v;
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn btnGhost btnSm"
                      disabled={animPlaying || animRecording}
                      onClick={handleClearBgm}
                    >
                      Hapus BGM
                    </button>
                  </div>
                </div>
              ) : null}

              {renderedFrames.length === 0 ? (
                <div className="emptyPanel">
                  <p>Generate minimal 1 gambar panel di Tahap 3 untuk memutar Animatic Preview.</p>
                </div>
              ) : (
                <>
                  <div className="animaticStageWrap" data-ratio={sb.aspectRatio}>
                    <canvas
                      ref={canvasRef}
                      width={canvasW}
                      height={canvasH}
                      className="animaticCanvas"
                    />
                  </div>

                  <div className="animaticProgressTrack" aria-label="Progres animatic">
                    <div className="animaticProgressFill" style={{ width: `${animProgress}%` }} />
                  </div>

                  <div className="actionGroup">
                    {animPlaying ? (
                      <button type="button" className="btn btnDanger" onClick={stopAnimatic}>
                        Berhenti
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btnPrimary"
                        disabled={animRecording}
                        onClick={() => void runAnimaticPlayback(false)}
                      >
                        <PlayIcon size={14} />
                        <span>Putar Animatic ({(renderedFrames.length * secPerPanel).toFixed(1)} dtk)</span>
                      </button>
                    )}

                    <button
                      type="button"
                      className="btn"
                      disabled={animPlaying || animRecording}
                      onClick={() => void runAnimaticPlayback(true)}
                    >
                      <DownloadIcon size={14} />
                      <span>
                        {animRecording
                          ? "Merekam WebM..."
                          : `Rekam & Unduh Animatic (.webm${bgmName ? " + BGM" : ""})`}
                      </span>
                    </button>
                  </div>
                </>
              )}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
