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
import {
  ANIMATIC_ATMOSPHERES,
  ANIMATIC_SCORES,
  drawAnimaticAtmosphere,
  startBuiltInAnimaticScore,
  type AnimaticAtmosphere,
  type AnimaticScorePreset,
  type BuiltInScoreController,
} from "@/lib/animaticAudio";
import { getSelectedFrameImage, getStoryboardSegments, reindexStoryboardFrames } from "@/lib/storyboard";
import {
  buildLocalCdpStoryboardSpec,
  buildLocalMotionRenderPackZip,
  buildMotionTimeline,
  drawMotionFrame,
  MOTION_PRESET_OPTIONS,
  pickBrowserVideoMime,
  sampleMotionTimeline,
  TRANSITION_PRESET_OPTIONS,
  type MotionFitMode,
  type MotionPreset,
  type TransitionPreset,
} from "@/lib/motionEngine";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FilmIcon,
  PlayIcon,
  RefreshIcon,
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
  if (typeof window === "undefined") return "animatic";
  try {
    const saved = window.localStorage.getItem(ANIM_ENGINE_STORAGE_KEY);
    if (saved === "handoff" || saved === "omni-api" || saved === "animatic") return saved;
  } catch {
    // ignore storage errors
  }
  return "animatic";
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

  // Browser Cinema Animatic + Local Motion MP4 state
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offFromRef = useRef<HTMLCanvasElement | null>(null);
  const offToRef = useRef<HTMLCanvasElement | null>(null);
  const bgmInputRef = useRef<HTMLInputElement>(null);
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const bgmFileRef = useRef<File | null>(null);
  const scoreCtrlRef = useRef<BuiltInScoreController | null>(null);
  const animAudioCtxRef = useRef<AudioContext | null>(null);
  const lastSpokenPanelIdxRef = useRef<number>(-1);
  const [animPlaying, setAnimPlaying] = useState(false);
  const [animRecording, setAnimRecording] = useState(false);
  const [motionSegmentId, setMotionSegmentId] = useState<string>("all");
  const [secPerPanel, setSecPerPanel] = useState(3.5);
  const [motionPreset, setMotionPreset] = useState<MotionPreset>("auto");
  const [transitionPreset, setTransitionPreset] = useState<TransitionPreset>("auto");
  const [fitMode, setFitMode] = useState<MotionFitMode>("cover");
  const [animElapsedSec, setAnimElapsedSec] = useState(0);
  const [animProgress, setAnimProgress] = useState(0);
  const [localMp4Busy, setLocalMp4Busy] = useState(false);
  const [localMp4Url, setLocalMp4Url] = useState("");
  const [localMp4Blob, setLocalMp4Blob] = useState<Blob | null>(null);
  const [localMp4Meta, setLocalMp4Meta] = useState("");
  const [localPackBusy, setLocalPackBusy] = useState(false);
  const [animAtmosphere, setAnimAtmosphere] = useState<AnimaticAtmosphere>(() => {
    const text = `${project.name} ${sb.scriptText || ""}`.toLowerCase();
    if (/\b(hujan|gerimis|badai|rain|drizzle)\b/.test(text)) return "rain";
    if (/\b(salju|snow|winter)\b/.test(text)) return "snow";
    if (/\b(kabut|subuh|embun|mist|fog)\b/.test(text)) return "mist";
    if (/\b(senja|pagi|matahari|fajar|sore|golden|sunset|sunrise)\b/.test(text)) return "golden";
    return "none";
  });
  const [animScore, setAnimScore] = useState<AnimaticScorePreset>(() => {
    const text = `${project.name} ${sb.scriptText || ""}`.toLowerCase();
    if (/\b(hujan|gerimis|badai|rain|drizzle)\b/.test(text)) return "rain_piano";
    if (/\b(pagi|subuh|fajar|senja|kopi|morning|sunrise)\b/.test(text)) return "morning_warm";
    return "cinematic_pad";
  });
  const [showTitleCard, setShowTitleCard] = useState(true);
  const [showPanelBadge, setShowPanelBadge] = useState(false);
  const [speakDialogue, setSpeakDialogue] = useState(false);
  const [bgmUrl, setBgmUrl] = useState("");
  const [bgmName, setBgmName] = useState("");
  const [bgmVolume, setBgmVolume] = useState(0.55);
  const animRafRef = useRef<number | null>(null);
  const animImageMapRef = useRef<Map<string, HTMLImageElement | null>>(new Map());

  const animAtmosphereRef = useRef<AnimaticAtmosphere>(animAtmosphere);
  animAtmosphereRef.current = animAtmosphere;
  const showTitleCardRef = useRef<boolean>(showTitleCard);
  showTitleCardRef.current = showTitleCard;
  const showPanelBadgeRef = useRef<boolean>(showPanelBadge);
  showPanelBadgeRef.current = showPanelBadge;
  const speakDialogueRef = useRef<boolean>(speakDialogue);
  speakDialogueRef.current = speakDialogue;

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

  // Revoke object URLs and clean up Cinema Animatic audio on unmount
  useEffect(() => {
    return () => {
      cancelRef.current = true;
      for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
      if (animRafRef.current) cancelAnimationFrame(animRafRef.current);
      if (scoreCtrlRef.current) {
        scoreCtrlRef.current.stop();
        scoreCtrlRef.current = null;
      }
      if (animAudioCtxRef.current) {
        void animAudioCtxRef.current.close().catch(() => {});
        animAudioCtxRef.current = null;
      }
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // ignore
        }
      }
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
      setGlobalError("Gagal menyalin ke clipboard. Salin manual dari kotak teks.");
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

  // Focus target segment across active tab (Local Motion Engine, Google Flow, or Omni API)
  useEffect(() => {
    if (!pendingSegmentId) return;

    if (engineTab === "animatic") {
      setMotionSegmentId(pendingSegmentId);
      setPendingSegmentId(null);
      const segObj = segments.find((s) => s.id === pendingSegmentId);
      setGlobalNotice(
        segObj
          ? `Segmen ${String(segObj.index).padStart(2, "0")} (${segObj.title}) dipilih di Mesin Render Lokal. Klik Putar atau Render MP4 1080p.`
          : "Segmen dipilih di Mesin Render Lokal.",
      );
      return;
    }

    if (mode !== "segment") return;
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
        `${targetPlan.label} siap. Klik "Buka Google Flow" untuk mulai membuat video, lalu pasang MP4 hasilnya.`,
      );
      return;
    }

    if (!omniKeyAvailable) {
      setGlobalNotice(
        `Siap menganimasikan "${targetPlan.label}" lewat Gemini API. Tempel Gemini API Key sekali di bawah untuk mulai render otomatis.`,
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
  // CINEMA ANIMATIC + LOCAL CHROME CDP/FFMPEG MP4 ENGINE (ZERO VEO / FLOW)
  // =========================================================================
  const motionOptions = useMemo(
    () => ({
      segmentId: motionSegmentId === "all" ? null : motionSegmentId,
      secPerPanel,
      transitionSec: Math.min(0.55, secPerPanel * 0.22),
      motionPreset,
      motionAmount: 0.11,
      transitionPreset,
      fitMode,
      showBadge: showPanelBadge,
      showSubtitles: true,
      showProgress: true,
      fps: 30,
      audioMode: bgmName ? ("bgm" as const) : animScore === "none" ? ("none" as const) : ("synth" as const),
      audioVolume: bgmVolume,
    }),
    [motionSegmentId, secPerPanel, motionPreset, transitionPreset, fitMode, showPanelBadge, bgmName, animScore, bgmVolume],
  );

  const motionTimeline = useMemo(
    () =>
      buildMotionTimeline(
        { ...project, storyboard: { ...sb, segments, frames: orderedFrames } },
        motionOptions,
      ),
    [project, sb, segments, orderedFrames, motionOptions],
  );

  const localCdpReady = Boolean(runtime?.mode === "local-hybrid" && runtime?.localChrome);

  const ensureOffscreenCanvases = () => {
    if (!offFromRef.current) offFromRef.current = document.createElement("canvas");
    if (!offToRef.current) offToRef.current = document.createElement("canvas");
    return { offFrom: offFromRef.current, offTo: offToRef.current };
  };

  const handleUploadBgm = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (bgmUrl) URL.revokeObjectURL(bgmUrl);
    const url = URL.createObjectURL(file);
    blobUrlsRef.current.push(url);
    bgmFileRef.current = file;
    setBgmUrl(url);
    setBgmName(file.name);
    setGlobalNotice(`Musik latar "${file.name}" dipasang untuk Mesin Render Lokal.`);
    e.target.value = "";
  };

  const handleClearBgm = () => {
    if (bgmAudioRef.current) {
      bgmAudioRef.current.pause();
      bgmAudioRef.current = null;
    }
    bgmFileRef.current = null;
    setBgmUrl("");
    setBgmName("");
  };

  const loadAnimaticImages = async () => {
    const entries = await Promise.all(
      motionTimeline.slides.map(
        (slide) =>
          new Promise<[string, HTMLImageElement | null]>((resolve) => {
            if (!slide.imageUrl) return resolve([slide.frameId, null]);
            const img = new Image();
            img.onload = () => resolve([slide.frameId, img]);
            img.onerror = () => resolve([slide.frameId, null]);
            img.src = slide.imageUrl;
          }),
      ),
    );
    const map = new Map<string, HTMLImageElement | null>(entries);
    animImageMapRef.current = map;
    return map;
  };

  const drawAnimaticFrame = (
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    elapsedSec: number,
    imgMap: Map<string, HTMLImageElement | null>,
  ) => {
    if (motionTimeline.slides.length === 0) {
      ctx.fillStyle = "#080a0f";
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const { offFrom, offTo } = ensureOffscreenCanvases();
    drawMotionFrame({
      ctx,
      offFrom,
      offTo,
      imageMap: imgMap,
      timeline: motionTimeline,
      elapsedSec,
      showBadge: showPanelBadgeRef.current,
      showSubtitles: true,
      showProgress: true,
    });

    const totalDur = motionTimeline.totalDuration;
    const t = Math.max(0, Math.min(elapsedSec, Math.max(0, totalDur - 0.001)));
    const smoothStep = (p: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, p)));

    // Live animated atmosphere particles (rain / golden bokeh / twilight mist / snow)
    drawAnimaticAtmosphere(ctx, w, h, t, animAtmosphereRef.current);

    // Optional Cinema Opening Title Card (first 3.2s)
    if (showTitleCardRef.current && totalDur >= 3.2 && t < 3.2) {
      let cardAlpha = 1;
      if (t < 0.8) cardAlpha = smoothStep(Math.max(0, (t - 0.12) / 0.68));
      else if (t > 2.4) cardAlpha = 1 - smoothStep((t - 2.4) / 0.8);
      if (cardAlpha > 0.01) {
        ctx.save();
        ctx.globalAlpha = cardAlpha;
        const bandGrad = ctx.createLinearGradient(0, h * 0.28, 0, h * 0.68);
        bandGrad.addColorStop(0, "rgba(7, 10, 18, 0)");
        bandGrad.addColorStop(0.5, "rgba(7, 10, 18, 0.65)");
        bandGrad.addColorStop(1, "rgba(7, 10, 18, 0)");
        ctx.fillStyle = bandGrad;
        ctx.fillRect(0, h * 0.28, w, h * 0.4);

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const kickerSize = Math.max(14, Math.round(Math.min(w, h) * 0.022));
        ctx.font = `700 ${kickerSize}px "Bahnschrift", "Segoe UI", sans-serif`;
        ctx.fillStyle = "#f2be6b";
        ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
        ctx.shadowBlur = 12;
        ctx.fillText("NMCGEN CINEMA STORYBOARD", w / 2, h * 0.43);

        const titleSize = Math.max(28, Math.round(Math.min(w, h) * 0.064));
        ctx.font = `700 ${titleSize}px Georgia, "Times New Roman", serif`;
        ctx.fillStyle = "#ffffff";
        const titleWords = (project.name || "Proyek nmcGen").trim().split(/\s+/);
        const titleLines: string[] = [];
        let tLine = "";
        for (const wd of titleWords) {
          const cand = tLine ? `${tLine} ${wd}` : wd;
          if (ctx.measureText(cand).width > w * 0.82 && tLine) {
            titleLines.push(tLine);
            tLine = wd;
          } else {
            tLine = cand;
          }
        }
        if (tLine) titleLines.push(tLine);
        const lineStep = Math.round(titleSize * 1.18);
        titleLines.slice(0, 2).forEach((ln, li) => {
          ctx.fillText(ln, w / 2, h * 0.51 + li * lineStep);
        });
        ctx.restore();
      }
    }

    // Smooth film fade-in / fade-out
    const fadeInDur = Math.min(0.6, totalDur * 0.14);
    const fadeOutDur = Math.min(0.85, totalDur * 0.18);
    let blackAlpha = 0;
    if (t < fadeInDur) blackAlpha = 1 - t / fadeInDur;
    else if (totalDur - t < fadeOutDur) blackAlpha = 1 - (totalDur - t) / fadeOutDur;
    if (blackAlpha > 0.005) {
      ctx.fillStyle = `rgba(4, 6, 10, ${Math.max(0, Math.min(1, blackAlpha)).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }
  };

  // Draw static preview whenever entering tab or tweaking settings
  useEffect(() => {
    if (engineTab !== "animatic" || motionTimeline.slides.length === 0 || animPlaying || animRecording) return;
    let active = true;
    void loadAnimaticImages().then((imgMap) => {
      if (!active || !canvasRef.current) return;
      const ctx = canvasRef.current.getContext("2d");
      if (!ctx) return;
      const previewSec =
        animElapsedSec > 0
          ? Math.min(animElapsedSec, Math.max(0, motionTimeline.totalDuration - 0.01))
          : Math.min(motionTimeline.totalDuration * 0.35, showTitleCard ? 1.45 : 1.0);
      drawAnimaticFrame(ctx, canvasRef.current.width, canvasRef.current.height, previewSec, imgMap);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineTab, motionTimeline, sb.aspectRatio, animAtmosphere, showTitleCard, showPanelBadge]);

  const stopAnimatic = () => {
    if (animRafRef.current) {
      cancelAnimationFrame(animRafRef.current);
      animRafRef.current = null;
    }
    if (bgmAudioRef.current) {
      bgmAudioRef.current.pause();
      bgmAudioRef.current.currentTime = 0;
    }
    if (scoreCtrlRef.current) {
      scoreCtrlRef.current.stop();
      scoreCtrlRef.current = null;
    }
    if (animAudioCtxRef.current) {
      void animAudioCtxRef.current.close().catch(() => {});
      animAudioCtxRef.current = null;
    }
    lastSpokenPanelIdxRef.current = -1;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    setAnimPlaying(false);
  };

  const handleScrubPreview = (nextSec: number) => {
    if (animPlaying || animRecording) stopAnimatic();
    setAnimElapsedSec(nextSec);
    setAnimProgress(motionTimeline.totalDuration > 0 ? (nextSec / motionTimeline.totalDuration) * 100 : 0);
    if (!canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;
    drawAnimaticFrame(ctx, canvasRef.current.width, canvasRef.current.height, nextSec, animImageMapRef.current);
  };

  const runAnimaticPlayback = async (recordVideo: boolean) => {
    if (!canvasRef.current || motionTimeline.slides.length === 0) return;
    stopAnimatic();
    setGlobalError("");
    const imgMap = await loadAnimaticImages();
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const totalDur = motionTimeline.totalDuration;
    let recorder: MediaRecorder | null = null;
    let audioCtx: AudioContext | null = null;
    const chunks: BlobPart[] = [];
    const { mimeType, ext } = pickBrowserVideoMime();

    let audioEl: HTMLAudioElement | null = null;
    if (bgmUrl) {
      audioEl = new Audio(bgmUrl);
      audioEl.loop = true;
      audioEl.volume = bgmVolume;
      bgmAudioRef.current = audioEl;
    }

    const useBuiltInScore = !audioEl && animScore !== "none";
    let mediaAudioDest: MediaStreamAudioDestinationNode | null = null;

    if (recordVideo) {
      if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") {
        setGlobalError("Browser ini tidak mendukung perekaman video langsung.");
        return;
      }
      const videoStream = canvas.captureStream(30);
      let combinedStream: MediaStream = videoStream;

      if (audioEl || useBuiltInScore) {
        audioCtx = new AudioContext();
        await audioCtx.resume().catch(() => {});
        animAudioCtxRef.current = audioCtx;
        mediaAudioDest = audioCtx.createMediaStreamDestination();

        if (audioEl) {
          const src = audioCtx.createMediaElementSource(audioEl);
          const gain = audioCtx.createGain();
          gain.gain.value = bgmVolume;
          src.connect(gain);
          gain.connect(mediaAudioDest);
          gain.connect(audioCtx.destination);
        } else if (useBuiltInScore) {
          scoreCtrlRef.current = startBuiltInAnimaticScore(
            audioCtx,
            [mediaAudioDest, audioCtx.destination],
            animScore,
            totalDur,
            bgmVolume,
          );
        }

        combinedStream = new MediaStream([
          ...videoStream.getVideoTracks(),
          ...mediaAudioDest.stream.getAudioTracks(),
        ]);
      }

      recorder = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: 8_000_000 });
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      const scoreMeta = ANIMATIC_SCORES.find((s) => s.value === animScore);
      const audioLabel = bgmName ? " + Musik" : useBuiltInScore ? ` + ${scoreMeta?.label.split(" (")[0] || "Musik"}` : "";
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: ext === "mp4" ? "video/mp4" : "video/webm" });
        const safeName =
          (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") +
          `-cinema-1080p.${ext}`;
        downloadBlob(blob, safeName);
        setAnimRecording(false);
        if (scoreCtrlRef.current) {
          scoreCtrlRef.current.stop();
          scoreCtrlRef.current = null;
        }
        if (audioCtx) {
          void audioCtx.close().catch(() => {});
          if (animAudioCtxRef.current === audioCtx) animAudioCtxRef.current = null;
        }
        setGlobalNotice(
          `Video 1080p (${ext.toUpperCase()}, ${totalDur.toFixed(1)} dtk${audioLabel}) berhasil diunduh tanpa Veo/Flow!`,
        );
      };
      setAnimRecording(true);
      recorder.start();
    } else if (useBuiltInScore) {
      audioCtx = new AudioContext();
      await audioCtx.resume().catch(() => {});
      animAudioCtxRef.current = audioCtx;
      scoreCtrlRef.current = startBuiltInAnimaticScore(
        audioCtx,
        [audioCtx.destination],
        animScore,
        totalDur,
        bgmVolume,
      );
    }

    if (audioEl) {
      void audioEl.play().catch(() => {});
    }

    lastSpokenPanelIdxRef.current = -1;
    setAnimPlaying(true);
    const startTs = performance.now();

    const tick = (now: number) => {
      const elapsed = (now - startTs) / 1000;
      const clamped = Math.min(totalDur, elapsed);
      setAnimElapsedSec(clamped);
      setAnimProgress(totalDur > 0 ? Math.min(100, (clamped / totalDur) * 100) : 0);
      drawAnimaticFrame(ctx, canvas.width, canvas.height, clamped, imgMap);

      if (!recordVideo && speakDialogueRef.current && typeof window !== "undefined" && "speechSynthesis" in window) {
        const sampled = sampleMotionTimeline(motionTimeline, clamped);
        const curIdx = sampled?.primary.index ?? 0;
        if (curIdx !== lastSpokenPanelIdxRef.current) {
          lastSpokenPanelIdxRef.current = curIdx;
          const dlg = sampled?.primary.caption || "";
          try {
            window.speechSynthesis.cancel();
            if (dlg) {
              const utter = new SpeechSynthesisUtterance(dlg);
              utter.lang = "id-ID";
              utter.rate = 0.96;
              window.speechSynthesis.speak(utter);
            }
          } catch {
            // ignore SpeechSynthesis errors
          }
        }
      }

      if (elapsed >= totalDur) {
        setAnimPlaying(false);
        animRafRef.current = null;
        if (audioEl) {
          audioEl.pause();
          audioEl.currentTime = 0;
        }
        if (recorder && recorder.state !== "inactive") {
          recorder.stop();
        } else {
          if (scoreCtrlRef.current) {
            scoreCtrlRef.current.stop();
            scoreCtrlRef.current = null;
          }
          if (audioCtx) {
            void audioCtx.close().catch(() => {});
            if (animAudioCtxRef.current === audioCtx) animAudioCtxRef.current = null;
          }
        }
        return;
      }
      animRafRef.current = requestAnimationFrame(tick);
    };
    animRafRef.current = requestAnimationFrame(tick);
  };

  // Render deterministic 1080p H.264/AAC MP4 via local Chrome Headless CDP + FFmpeg API route
  const handleRenderLocalCdpMp4 = async () => {
    if (motionTimeline.slides.length === 0) return;
    stopAnimatic();
    setLocalMp4Busy(true);
    setGlobalError("");
    setGlobalNotice(
      `Merender ${motionTimeline.slides.length} panel (${motionTimeline.totalDuration.toFixed(1)} dtk @ 30fps, ${motionTimeline.width}x${motionTimeline.height}) memakai Chrome D3D11 + FFmpeg lokal...`,
    );

    try {
      let audioDataUrl: string | undefined;
      let audioExt: string | undefined;
      if (bgmFileRef.current) {
        const f = bgmFileRef.current;
        audioExt = f.name.split(".").pop() || "mp3";
        audioDataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(new Error("Gagal membaca file audio kustom."));
          reader.readAsDataURL(f);
        });
      }

      const spec = buildLocalCdpStoryboardSpec(
        project,
        motionTimeline,
        motionOptions,
        audioDataUrl ? `bgm.${audioExt || "mp3"}` : null,
      );

      const res = await fetch("/api/render/local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spec,
          images: motionTimeline.slides.map((s) => ({ fileName: s.fileName, dataUrl: s.imageUrl })),
          audioDataUrl,
          audioExt,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errJson.error || `Render MP4 lokal gagal (${res.status}).`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      blobUrlsRef.current.push(url);
      setLocalMp4Blob(blob);
      setLocalMp4Url(url);

      const metaHeader = res.headers.get("X-Nmcgen-Render-Meta");
      let metaText = `${motionTimeline.width}x${motionTimeline.height} · ${motionTimeline.totalDuration.toFixed(1)} dtk`;
      if (metaHeader) {
        try {
          const m = JSON.parse(metaHeader) as {
            width?: number;
            height?: number;
            fps?: number;
            durationSec?: number;
            renderSec?: number;
          };
          metaText = `${m.width || motionTimeline.width}x${m.height || motionTimeline.height} @ ${m.fps || 30}fps · ${m.durationSec ?? motionTimeline.totalDuration.toFixed(1)} dtk (selesai ${m.renderSec ?? "?"} dtk)`;
        } catch {
          // ignore
        }
      }
      setLocalMp4Meta(metaText);
      setGlobalNotice(`Render MP4 1080p lokal selesai! (${metaText}).`);
    } catch (err) {
      setGlobalError(`Render MP4 lokal gagal: ${(err as Error).message}`);
    } finally {
      setLocalMp4Busy(false);
    }
  };

  // Download self-contained local Chrome CDP + FFmpeg render pack (.zip) usable even from Cloudflare Web deploy
  const handleDownloadLocalRenderPackZip = async () => {
    if (motionTimeline.slides.length === 0) return;
    setLocalPackBusy(true);
    setGlobalError("");
    try {
      const scriptRes = await fetch("/scripts/render_motion_cdp.py");
      if (!scriptRes.ok) {
        throw new Error("Gagal mengambil skrip render_motion_cdp.py.");
      }
      const renderScriptText = await scriptRes.text();
      const bytes = buildLocalMotionRenderPackZip({
        project,
        timeline: motionTimeline,
        options: motionOptions,
        renderScriptText,
      });
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const slug =
        (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") +
        "-render-mp4-pack.zip";
      downloadBlob(new Blob([copy], { type: "application/zip" }), slug);
      setGlobalNotice(
        `Paket Render MP4 Lokal (${motionTimeline.slides.length} panel + render_motion_cdp.py + render_mp4.bat) berhasil diunduh.`,
      );
    } catch (err) {
      setGlobalError(`Gagal membuat paket ZIP render lokal: ${(err as Error).message}`);
    } finally {
      setLocalPackBusy(false);
    }
  };

  const canvasW = motionTimeline.width;
  const canvasH = motionTimeline.height;

  return (
    <div className="stepContainer">
      <div className="stepIntroRow">
        <div>
          <span className="stepKicker mono">TAHAP 4 DARI 4</span>
          <h2 className="stepTitle">Buat Video</h2>
          <p className="stepSubtitle">
            Pilih cara paling nyaman untuk mengubah <strong>{plans.length} klip</strong> ({renderedFrames.length} panel
            bergambar) menjadi video.
          </p>
        </div>

        <div className="actionGroup">
          <button type="button" className="btn btnSm" onClick={onBackToStoryboard}>
            Kembali ke Storyboard
          </button>
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
          <h3>Belum ada panel storyboard untuk dibuat video</h3>
          <p>Buat minimal 1 panel di Tahap 3 (Storyboard) terlebih dahulu.</p>
          <button type="button" className="btn btnPrimary btnLg" onClick={onBackToStoryboard}>
            Buka Tahap 3: Storyboard
          </button>
        </div>
      ) : (
        <>
          {/* Engine Mode Tabs: Local Cinema Motion Renderer first (zero Veo/Flow) */}
          <div className="animateEngineBar" role="tablist" aria-label="Pilih cara pembuatan video">
            <button
              type="button"
              role="tab"
              aria-selected={engineTab === "animatic"}
              className="animateEngineTab"
              data-active={engineTab === "animatic"}
              onClick={() => selectEngineTab("animatic")}
            >
              <div className="animateEngineTop">
                <strong>Mesin Render Lokal (0 Kredit)</strong>
                <span className="metaTag mono" data-tone="ok">
                  {localCdpReady ? "MP4 1080p Siap" : "Tanpa Veo/Flow"}
                </span>
              </div>
              <span>Render langsung dari panel gambar dengan gerak kamera, transisi, efek atmosfer &amp; audio.</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={engineTab === "handoff"}
              className="animateEngineTab"
              data-active={engineTab === "handoff"}
              onClick={() => selectEngineTab("handoff")}
            >
              <div className="animateEngineTop">
                <strong>Google Flow</strong>
                <span className="metaTag mono" data-tone={watchFolderName ? "ok" : undefined}>
                  {watchFolderName ? "Pantau Aktif" : `${readyClips.length}/${plans.length} video`}
                </span>
              </div>
              <span>Opsional: buat video AI di flow.google.com, lalu pasang MP4 ke sini.</span>
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
                <strong>Render Langsung (API)</strong>
                <span className="metaTag mono" data-tone={omniKeyAvailable ? "ok" : undefined}>
                  {omniKeyAvailable ? "Siap" : "Butuh API Key"}
                </span>
              </div>
              <span>Opsional: render video AI lewat Gemini Omni 1.2 Flash API.</span>
            </button>
          </div>

          {/* Collapsible Video Settings (hidden by default to reduce clutter) */}
          {engineTab !== "animatic" ? (
            <details className="subtleDetails animateCompactDetails">
              <summary className="animateDetailsSummary">
                <span>
                  Pengaturan video ({mode === "segment" ? "Per Segmen" : "Transisi Panel"}, {safeDuration} detik,{" "}
                  {resolution})
                </span>
              </summary>
              <div className="subtleDetailsBody animateConfigBar">
                <div className="animateConfigGroup">
                  <span className="fieldLabel">Pola Klip:</span>
                  <div className="segToggle" role="group" aria-label="Pola klip video">
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
                      Per Segmen ({segments.length})
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
                      Transisi Panel ke Panel
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
              </div>
            </details>
          ) : null}

          {/* Shared Combined Movie Player when >= 1 clip video is attached or rendered */}
          {engineTab !== "animatic" && readyClips.length > 0 ? (
            <section className="panelCard omniReelCard">
              <div className="panelHead">
                <div className="metaInline">
                  <FilmIcon size={16} />
                  <h3>
                    Film Gabungan ({readyClips.length}/{plans.length} Klip Siap)
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

          {/* =============================================================== */}
          {/* TAB 1: GOOGLE FLOW (SIMPLE MAIN VIEW + COLLAPSIBLE ADVANCED)    */}
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
                  aria-label="Pasang video hasil Google Flow"
                >
                  <div>
                    <strong>Kembali dari Google Flow: Pasang MP4 untuk {waitingFlowPlan.label}</strong>
                    <p className="fieldHint" style={{ margin: "3px 0 0" }}>
                      Klik tombol di kanan untuk memilih MP4 hasil unduhan (atau seret file / tekan Ctrl+V).
                    </p>
                  </div>
                  <div className="actionGroup">
                    <button
                      type="button"
                      className="btn btnOk"
                      onClick={() => triggerSingleVideoPicker(waitingFlowPlan.id)}
                    >
                      <UploadIcon size={14} />
                      <span>Pasang MP4 {waitingFlowPlan.label.split(":")[0]}</span>
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

              {/* Simple 1-line guide + batch MP4 attach */}
              <div className="toolbarCard animateGuideBar">
                <p className="fieldHint" style={{ margin: 0 }}>
                  <strong>Alur cepat:</strong> Klik <strong>Buka Google Flow</strong> pada klip (prompt tersalin &amp;
                  frame terunduh), buat videonya di Flow, lalu klik <strong>Pasang MP4</strong> atau seret berkas ke
                  kartu.
                </p>
                <button
                  type="button"
                  className="btn btnSm"
                  onClick={() => batchVideoInputRef.current?.click()}
                  title="Pilih beberapa berkas MP4 hasil Google Flow sekaligus untuk dipasang berurutan"
                >
                  <UploadIcon size={13} />
                  <span>Unggah Banyak MP4</span>
                </button>
              </div>

              {/* Clean Per-Clip Cards (2 primary buttons per card) */}
              <div className="omniClipGrid">
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
                      className="panelCard omniClipCard"
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
                            ? "Terpasang"
                            : isWaiting
                              ? "Menunggu MP4..."
                              : `${plan.durationSec} dtk`}
                        </span>
                      </div>

                      {plan.images.length > 0 ? (
                        <div className="omniThumbRow">
                          {plan.images.map((im, i) => (
                            <div key={`${plan.id}-im-${i}`} className="omniThumbItem" title={im.label}>
                              <img src={im.dataUrl} alt={im.label} width={78} height={48} />
                              <span className="mono">
                                {plan.images.length === 2 ? (i === 0 ? "AWAL" : "AKHIR") : `#${i + 1}`}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="fieldHint" style={{ margin: 0 }}>
                          Belum ada gambar panel di klip ini. Buat gambar di Tahap 3 terlebih dahulu.
                        </p>
                      )}

                      {/* 2 Core Actions Only */}
                      <div className="actionGroup">
                        <button
                          type="button"
                          className={st?.blobUrl ? "btn btnSm" : "btn btnPrimary btnSm"}
                          onClick={() => void handleLaunchFlowForClip(plan)}
                          title="Salin prompt, unduh Frame Awal & Akhir, lalu buka Google Flow"
                        >
                          <ExternalLinkIcon size={13} />
                          <span>Buka Google Flow</span>
                        </button>

                        <button
                          type="button"
                          className={isWaiting ? "btn btnOk btnSm" : "btn btnSm"}
                          onClick={() => triggerSingleVideoPicker(plan.id)}
                          title="Pilih berkas MP4 hasil unduhan untuk ditempel ke klip ini"
                        >
                          <UploadIcon size={13} />
                          <span>{st?.blobUrl ? "Ganti MP4" : "Pasang MP4"}</span>
                        </button>
                      </div>

                      {/* Embedded Video Player when MP4 is attached */}
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
                                aria-label={`Lepas video ${plan.label}`}
                                onClick={() => void handleRemoveClipVideo(plan)}
                                title="Lepas video dari klip ini"
                              >
                                <TrashIcon size={13} />
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {/* Collapsible Secondary Tools per Clip */}
                      <details className="subtleDetails">
                        <summary>Lainnya (Prompt, Frame, CLI)</summary>
                        <div className="subtleDetailsBody">
                          <div className="actionGroup">
                            {plan.images.length > 0 ? (
                              <button
                                type="button"
                                className="btn btnSm"
                                onClick={() => void handleSaveFramesForPlan(plan)}
                              >
                                <DownloadIcon size={13} />
                                <span>Unduh Frame</span>
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn btnSm"
                              onClick={() => void handleCopyText(plan.prompt, plan.id)}
                            >
                              {copyFeedback === plan.id ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                              <span>{copyFeedback === plan.id ? "Tersalin" : "Salin Prompt"}</span>
                            </button>
                            <button
                              type="button"
                              className="btn btnGhost btnSm"
                              onClick={() => void handleCopyText(cliCmd, cliCopyKey)}
                              title={`Salin perintah Flow Connector CLI untuk Klip ${idx + 1}`}
                            >
                              {copyFeedback === cliCopyKey ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                              <span>{copyFeedback === cliCopyKey ? "CLI Tersalin" : "Salin CLI Flow"}</span>
                            </button>
                          </div>

                          <textarea
                            aria-label={`Prompt video untuk ${plan.label}`}
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

              {/* Collapsed Advanced Automation & Power Tools (100% preserved, hidden by default) */}
              <details className="subtleDetails animateAdvancedDetails">
                <summary className="animateDetailsSummary">
                  <span>Opsi Lanjutan: Otomatisasi Flow Connector, Pantau Downloads &amp; Tautan</span>
                  {watchFolderName ? (
                    <span className="statusBadge mono" data-tone="ok">
                      Pantau Aktif: {watchFolderName}
                    </span>
                  ) : null}
                </summary>

                <div className="subtleDetailsBody animateAdvancedBody">
                  {/* Flow Connector Chrome Extension + CLI Automation */}
                  <div className="flowConnectorCard">
                    <div className="panelHead">
                      <div>
                        <strong>Otomatisasi via Flow Connector (Chrome/Edge Desktop)</strong>
                        <p className="fieldHint" style={{ margin: "2px 0 0" }}>
                          Ekstensi Flow Connector dapat mengirim Frame Awal + Akhir, menekan Generate, dan mengunduh
                          semua MP4 otomatis di PC/Laptop.
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
                        <strong>Jalankan otomatis semua segmen:</strong> Unduh paket ZIP, ekstrak, lalu jalankan{" "}
                        <code className="mono">run_flow_connector.bat</code> (Windows),{" "}
                        <code className="mono">run_flow_connector.command</code> (Mac), atau{" "}
                        <code className="mono">node run_flow_connector.mjs</code> saat tab{" "}
                        <strong>flow.google.com</strong> terbuka.
                      </li>
                      <li>
                        <strong>Pasang MP4 otomatis:</strong> Aktifkan Pantau Downloads di bawah. Skrip menyimpan hasil
                        ke <code className="mono">Downloads/{flowFolderSlug}/</code> dan nmcGen otomatis memasangnya ke
                        Klip 01 sampai {String(plans.length).padStart(2, "0")}.
                      </li>
                    </ol>

                    <div className="actionGroup">
                      <button type="button" className="btn btnPrimary btnSm" onClick={handleDownloadOmniPackZip}>
                        <DownloadIcon size={13} />
                        <span>Unduh Paket Flow Connector (.zip)</span>
                      </button>
                      <button
                        type="button"
                        className="btn btnSm"
                        onClick={() => void handleCopyText(flowConnectorAgentPrompt, "flow-agent")}
                        title="Tempel ke Antigravity Desktop, Claude Code, atau Cursor yang terhubung MCP flow-auto-mcp"
                      >
                        {copyFeedback === "flow-agent" ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                        <span>{copyFeedback === "flow-agent" ? "Tersalin" : "Salin Prompt Agent"}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btnGhost btnSm"
                        onClick={() => void handleCopyText(masterHandoffPrompt, "master")}
                      >
                        {copyFeedback === "master" ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                        <span>{copyFeedback === "master" ? "Tersalin" : "Salin Prompt Master"}</span>
                      </button>
                    </div>
                  </div>

                  {/* Background Downloads Auto-Watcher */}
                  <div className="flowWatchBox" data-active={Boolean(watchFolderName)}>
                    <div style={{ flex: "1 1 220px" }}>
                      <strong>
                        {watchFolderName
                          ? `Pantau Otomatis Aktif: "${watchFolderName}" (+ ${flowFolderSlug})`
                          : "Pantau Folder Downloads Otomatis (Chrome/Edge Desktop)"}
                      </strong>
                      <p className="fieldHint" style={{ margin: "3px 0 0" }}>
                        {watchFolderName
                          ? `Memantau "${watchFolderName}/" dan "${watchFolderName}/${flowFolderSlug}/" tiap 2,5 detik. MP4 bernomor 1 sampai ${plans.length} otomatis terpasang.`
                          : folderWatchSupported
                            ? `Pilih folder Downloads sekali saja agar setiap MP4 baru di Downloads/${flowFolderSlug}/ langsung terpasang otomatis.`
                            : "Browser HP tidak mendukung pantau folder otomatis. Gunakan tombol Pasang MP4 atau Unggah Banyak MP4."}
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
                          <RefreshIcon size={13} />
                          <span>Aktifkan Pantau Downloads</span>
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {/* External App Links */}
                  <div className="handoffAppRow">
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
                    <a
                      href={ANIMATION_APP_LINKS.flowConnectorExtension}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btnSm"
                    >
                      <ExternalLinkIcon size={13} />
                      <span>Ekstensi Flow Connector</span>
                    </a>
                  </div>

                  <details className="subtleDetails">
                    <summary>Pratinjau Prompt Agent Flow ({plans.length} Klip)</summary>
                    <div className="subtleDetailsBody">
                      <pre className="scriptPeekPre">{flowConnectorAgentPrompt}</pre>
                    </div>
                  </details>

                  <details className="subtleDetails">
                    <summary>Pratinjau Prompt Master</summary>
                    <div className="subtleDetailsBody">
                      <pre className="scriptPeekPre">{masterHandoffPrompt}</pre>
                    </div>
                  </details>
                </div>
              </details>
            </div>
          ) : null}

          {/* =============================================================== */}
          {/* TAB 2: DIRECT GEMINI OMNI 1.2 FLASH INTERACTIONS API            */}
          {/* =============================================================== */}
          {engineTab === "omni-api" ? (
            <div className="omniApiWrap">
              {/* Compact Gemini API Key + Primary Action Card */}
              <section className="panelCard omniKeyCard">
                <div className="panelHead">
                  <div className="metaInline">
                    <h3>{omniKeyAvailable ? "Render Langsung (Gemini API)" : "Hubungkan Gemini API Key"}</h3>
                    <span className="statusBadge" data-tone={omniKeyAvailable ? "ok" : "warn"}>
                      {omniKeyAvailable ? (
                        <>
                          <CheckIcon size={12} />
                          <span>
                            {localGeminiKey ? `Key Lokal (${geminiKeyHint})` : "Key Server Aktif"}
                          </span>
                        </>
                      ) : (
                        <span>Belum Ada API Key</span>
                      )}
                    </span>
                  </div>

                  <div className="actionGroup">
                    {omniKeyAvailable && recoverableClips.length > 0 ? (
                      <button
                        type="button"
                        className="btn btnOk btnSm"
                        disabled={queueRunning}
                        onClick={() => void handleRecoverAllSavedClips()}
                        title="Muat ulang klip yang pernah dirender tanpa biaya render ulang"
                      >
                        <RefreshIcon size={13} />
                        <span>Muat Ulang Tersimpan ({recoverableClips.length})</span>
                      </button>
                    ) : null}

                    {omniKeyAvailable ? (
                      queueRunning ? (
                        <button type="button" className="btn btnDanger btnSm" onClick={handleCancelQueue}>
                          Hentikan Antrean
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btnPrimary btnSm"
                          disabled={plans.length === 0}
                          onClick={() => void handleAnimateAll()}
                        >
                          <PlayIcon size={13} />
                          <span>Render Semua Klip ({plans.length})</span>
                        </button>
                      )
                    ) : (
                      <a
                        href={ANIMATION_APP_LINKS.aiStudio}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btnSm"
                      >
                        <ExternalLinkIcon size={13} />
                        <span>Ambil Key di AI Studio</span>
                      </a>
                    )}
                  </div>
                </div>

                {omniKeyAvailable ? (
                  <details className="subtleDetails">
                    <summary>Kelola API Key &amp; Info Biaya</summary>
                    <div className="subtleDetailsBody">
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
                          placeholder="Tempel Gemini API Key baru untuk mengganti..."
                        />
                        <button
                          type="button"
                          className="btn"
                          disabled={!geminiKeyDraft.trim()}
                          onClick={handleSaveGeminiKey}
                        >
                          Simpan Key
                        </button>
                        {localGeminiKey ? (
                          <button type="button" className="btn btnGhost" onClick={handleClearGeminiKey}>
                            Hapus Key
                          </button>
                        ) : null}
                      </div>
                      <p className="fieldHint" style={{ margin: 0 }}>
                        Model: <code className="mono">{OMNI_MODEL_ID}</code>. Estimasi biaya Google AI Studio sekitar
                        $0.07/detik (720p, termasuk audio). Kunci free tier tanpa billing aktif akan ditolak Google;
                        untuk opsi gratis, gunakan tab Google Flow atau Preview di Browser.
                      </p>
                    </div>
                  </details>
                ) : (
                  <>
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
                        placeholder="Tempel Gemini API Key (AIza...) dengan billing aktif..."
                      />
                      <button
                        type="button"
                        className="btn btnPrimary"
                        disabled={!geminiKeyDraft.trim()}
                        onClick={handleSaveGeminiKey}
                      >
                        Simpan Key
                      </button>
                    </div>
                    <p className="fieldHint" style={{ margin: 0 }}>
                      Memerlukan Gemini API Key dengan billing aktif (~$0.07/detik 720p). Jika belum punya, gunakan
                      tab <strong>Google Flow</strong> atau <strong>Preview di Browser</strong>.
                    </p>
                  </>
                )}
              </section>

              {/* Per-Clip API Cards (1-2 core buttons each) */}
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
                              : st.status === "processing"
                                ? "warn"
                                : undefined
                          }
                        >
                          {st.status === "ready"
                            ? st.blobUrl
                              ? "Selesai"
                              : "Tersimpan"
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
                              <img src={im.dataUrl} alt={im.label} width={78} height={48} />
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

                      {/* 1-2 Core Actions Only */}
                      <div className="actionGroup">
                        {canRecoverSaved ? (
                          <button
                            type="button"
                            className="btn btnOk btnSm"
                            disabled={!omniKeyAvailable || isBusyClip}
                            onClick={() => void handleRecoverSavedClip(plan)}
                          >
                            <RefreshIcon size={13} />
                            <span>Muat Ulang (Gratis)</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={canRecoverSaved || st.blobUrl ? "btn btnSm" : "btn btnPrimary btnSm"}
                          disabled={!omniKeyAvailable || isBusyClip}
                          onClick={() => void runOmniClipJob(plan, "create")}
                        >
                          {st.blobUrl || canRecoverSaved ? <RefreshIcon size={13} /> : <PlayIcon size={13} />}
                          <span>{st.blobUrl || canRecoverSaved ? "Render Ulang" : "Buat Video"}</span>
                        </button>
                      </div>

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
                                placeholder="Minta revisi video (mis. buat gerakan lebih halus)..."
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
                        <summary>Edit Prompt Video</summary>
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
                          <div className="actionGroup">
                            <button
                              type="button"
                              className="btn btnGhost btnSm"
                              onClick={() => void handleCopyText(plan.prompt, plan.id)}
                            >
                              {copyFeedback === plan.id ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                              <span>{copyFeedback === plan.id ? "Tersalin" : "Salin Prompt"}</span>
                            </button>
                          </div>
                        </div>
                      </details>
                    </article>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* =============================================================== */}
          {/* TAB 1: CINEMA ANIMATIC + LOCAL CHROME CDP/FFMPEG MP4 ENGINE     */}
          {/* =============================================================== */}
          {engineTab === "animatic" ? (
            <section className="panelCard animaticCard">
              <div className="panelHead">
                <div>
                  <h3>
                    Mesin Render Lokal &amp; Cinema Animatic ({motionTimeline.slides.length} Panel ·{" "}
                    {motionTimeline.totalDuration.toFixed(1)} dtk · {canvasW}×{canvasH})
                  </h3>
                  <p className="fieldHint">
                    Render langsung dari panel gambar storyboard dengan gerak kamera Ken Burns, transisi halus, efek
                    atmosfer, musik bawaan, dan ekspor 1080p tanpa Veo atau Google Flow.
                  </p>
                </div>

                <div className="actionGroup">
                  <label className="inlineControl">
                    <span className="fieldLabel">Musik Bawaan:</span>
                    <select
                      className="select inputSm"
                      value={bgmName ? "none" : animScore}
                      disabled={animPlaying || animRecording || localMp4Busy || Boolean(bgmName)}
                      onChange={(e) => setAnimScore(e.target.value as AnimaticScorePreset)}
                      aria-label="Pilih musik latar bawaan 0 kredit"
                    >
                      {ANIMATIC_SCORES.map((sc) => (
                        <option key={sc.value} value={sc.value}>
                          {sc.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="inlineControl">
                    <span className="fieldLabel">Durasi/Panel:</span>
                    <select
                      className="select inputSm"
                      value={secPerPanel}
                      disabled={animPlaying || animRecording || localMp4Busy}
                      onChange={(e) => setSecPerPanel(Number(e.target.value))}
                    >
                      <option value={2.5}>2,5 dtk (Cepat)</option>
                      <option value={3.5}>3,5 dtk (Standar)</option>
                      <option value={4.5}>4,5 dtk (Sinematik)</option>
                      <option value={6}>6,0 dtk (Santai)</option>
                    </select>
                  </label>
                </div>
              </div>

              <div className="animaticControlGrid">
                <label className="inlineControl">
                  <span className="fieldLabel">Cakupan:</span>
                  <select
                    className="select inputSm"
                    value={motionSegmentId}
                    disabled={animPlaying || animRecording || localMp4Busy}
                    onChange={(e) => {
                      setMotionSegmentId(e.target.value);
                      setAnimElapsedSec(0);
                      setAnimProgress(0);
                    }}
                  >
                    <option value="all">Semua Segmen ({renderedFrames.length} panel)</option>
                    {segments.map((seg) => (
                      <option key={seg.id} value={seg.id}>
                        Segmen {String(seg.index).padStart(2, "0")}: {seg.title}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="inlineControl">
                  <span className="fieldLabel">Gerak Kamera:</span>
                  <select
                    className="select inputSm"
                    value={motionPreset}
                    disabled={animPlaying || animRecording || localMp4Busy}
                    onChange={(e) => setMotionPreset(e.target.value as MotionPreset)}
                  >
                    {MOTION_PRESET_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="inlineControl">
                  <span className="fieldLabel">Transisi:</span>
                  <select
                    className="select inputSm"
                    value={transitionPreset}
                    disabled={animPlaying || animRecording || localMp4Busy}
                    onChange={(e) => setTransitionPreset(e.target.value as TransitionPreset)}
                  >
                    {TRANSITION_PRESET_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="inlineControl">
                  <span className="fieldLabel">Bingkai:</span>
                  <select
                    className="select inputSm"
                    value={fitMode}
                    disabled={animPlaying || animRecording || localMp4Busy}
                    onChange={(e) => setFitMode(e.target.value as MotionFitMode)}
                  >
                    <option value="cover">Penuh (Cover)</option>
                    <option value="contain-blur">Utuh + Blur Latar</option>
                  </select>
                </label>
              </div>

              {/* Atmosphere quick pills */}
              <div className="animaticOptionRow">
                <span className="fieldLabel">Atmosfer:</span>
                <div className="segToggle" role="group" aria-label="Pilih efek atmosfer animatic">
                  {ANIMATIC_ATMOSPHERES.map((atm) => (
                    <button
                      key={atm.value}
                      type="button"
                      className="segBtn"
                      aria-selected={animAtmosphere === atm.value}
                      disabled={animRecording || localMp4Busy}
                      onClick={() => setAnimAtmosphere(atm.value)}
                    >
                      {atm.label}
                    </button>
                  ))}
                </div>
              </div>

              <input
                ref={bgmInputRef}
                type="file"
                accept="audio/*"
                className="srOnly"
                onChange={handleUploadBgm}
              />

              {bgmName ? (
                <div className="toolbarCard" style={{ padding: "8px 12px" }}>
                  <div className="metaInline">
                    <span className="metaTag mono" data-tone="ok">Audio Kustom</span>
                    <strong style={{ fontSize: 12.5 }}>{bgmName}</strong>
                  </div>
                  <div className="actionGroup">
                    <button
                      type="button"
                      className="btn btnGhost btnSm"
                      disabled={animPlaying || animRecording || localMp4Busy}
                      onClick={handleClearBgm}
                    >
                      Pakai Musik Bawaan
                    </button>
                  </div>
                </div>
              ) : null}

              {motionTimeline.slides.length === 0 ? (
                <div className="emptyPanel">
                  <p>Buat minimal 1 gambar panel di Tahap 3 untuk memutar dan merender video lokal.</p>
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

                  <div className="animaticScrubRow">
                    <span className="fieldHint mono">{animElapsedSec.toFixed(1)}s</span>
                    <input
                      type="range"
                      aria-label="Geser posisi waktu preview video"
                      className="animaticScrubber"
                      min={0}
                      max={Math.max(0.1, motionTimeline.totalDuration)}
                      step={0.05}
                      value={Math.min(animElapsedSec, motionTimeline.totalDuration)}
                      disabled={animRecording || localMp4Busy}
                      onChange={(e) => handleScrubPreview(Number(e.target.value))}
                    />
                    <span className="fieldHint mono">{motionTimeline.totalDuration.toFixed(1)}s</span>
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
                        className="btn"
                        disabled={animRecording || localMp4Busy}
                        onClick={() => void runAnimaticPlayback(false)}
                      >
                        <PlayIcon size={14} />
                        <span>Putar Preview ({motionTimeline.totalDuration.toFixed(1)} dtk)</span>
                      </button>
                    )}

                    {localCdpReady ? (
                      <button
                        type="button"
                        className="btn btnPrimary"
                        disabled={animPlaying || animRecording || localMp4Busy}
                        onClick={() => void handleRenderLocalCdpMp4()}
                        title="Render MP4 1080p deterministik (0 drop frame) memakai Chrome D3D11 + FFmpeg di komputer ini"
                      >
                        <FilmIcon size={14} />
                        <span>
                          {localMp4Busy
                            ? "Merender MP4 1080p..."
                            : "Render MP4 1080p (Chrome + FFmpeg)"}
                        </span>
                      </button>
                    ) : null}

                    <button
                      type="button"
                      className={localCdpReady ? "btn" : "btn btnPrimary"}
                      disabled={animPlaying || animRecording || localMp4Busy}
                      onClick={() => void runAnimaticPlayback(true)}
                    >
                      <DownloadIcon size={14} />
                      <span>
                        {animRecording
                          ? "Merekam 1080p..."
                          : `Rekam & Unduh 1080p${bgmName || animScore !== "none" ? " + Audio" : ""}`}
                      </span>
                    </button>

                    <button
                      type="button"
                      className="btn btnGhost"
                      disabled={animPlaying || animRecording || localMp4Busy || localPackBusy}
                      onClick={() => void handleDownloadLocalRenderPackZip()}
                      title="Unduh paket ZIP berisi gambar, storyboard.json, render_motion_cdp.py, dan render_mp4.bat"
                    >
                      <DownloadIcon size={14} />
                      <span>{localPackBusy ? "Menyiapkan ZIP..." : "Unduh Paket Render MP4 (.zip)"}</span>
                    </button>
                  </div>

                  {localMp4Url ? (
                    <div className="panelCard omniReelCard" style={{ marginTop: 4 }}>
                      <div className="panelHead">
                        <div className="metaInline">
                          <FilmIcon size={15} />
                          <strong>Hasil Render MP4 Lokal</strong>
                          {localMp4Meta ? <span className="metaTag mono">{localMp4Meta}</span> : null}
                        </div>
                        <button
                          type="button"
                          className="btn btnPrimary btnSm"
                          onClick={() => {
                            if (!localMp4Blob) return;
                            const slug =
                              project.name
                                .toLowerCase()
                                .replace(/[^a-z0-9]+/g, "-")
                                .replace(/^-|-$/g, "") || "nmcgen";
                            downloadBlob(localMp4Blob, `${slug}-1080p.mp4`);
                          }}
                        >
                          <DownloadIcon size={13} />
                          <span>Unduh MP4</span>
                        </button>
                      </div>
                      <div className="omniReelStage">
                        <video src={localMp4Url} controls playsInline className="omniVideoPlayer" />
                      </div>
                    </div>
                  ) : null}

                  {/* Collapsible Cinema details: Title card, panel badge, volume, voiceover & custom MP3 */}
                  <details className="subtleDetails animateCompactDetails">
                    <summary className="animateDetailsSummary">
                      <span>Opsi Cinema: Judul Pembuka, Volume Audio, Suara Dialog &amp; MP3 Kustom</span>
                      <span className="metaTag mono">Volume {Math.round(bgmVolume * 100)}%</span>
                    </summary>

                    <div className="subtleDetailsBody animaticAdvancedBody">
                      <div className="animaticToggleRow">
                        <label className="inlineControl" style={{ cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={showTitleCard}
                            disabled={animRecording || localMp4Busy}
                            onChange={(e) => setShowTitleCard(e.target.checked)}
                          />
                          <span>Kartu Judul Pembuka</span>
                        </label>

                        <label className="inlineControl" style={{ cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={showPanelBadge}
                            disabled={animRecording || localMp4Busy}
                            onChange={(e) => setShowPanelBadge(e.target.checked)}
                          />
                          <span>Label Nomor Panel</span>
                        </label>

                        <label
                          className="inlineControl"
                          style={{ cursor: "pointer" }}
                          title="Bacakan dialog Indonesia lewat suara browser saat Putar Preview"
                        >
                          <input
                            type="checkbox"
                            checked={speakDialogue}
                            onChange={(e) => setSpeakDialogue(e.target.checked)}
                          />
                          <span>Suara Dialog ID (Pratinjau Live)</span>
                        </label>
                      </div>

                      <div className="animaticOptionRow">
                        <label className="inlineControl">
                          <span className="fieldLabel">Volume Musik ({Math.round(bgmVolume * 100)}%):</span>
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
                              if (scoreCtrlRef.current) scoreCtrlRef.current.setVolume(v);
                            }}
                          />
                        </label>

                        <button
                          type="button"
                          className="btn btnSm"
                          disabled={animPlaying || animRecording || localMp4Busy}
                          onClick={() => bgmInputRef.current?.click()}
                        >
                          <UploadIcon size={13} />
                          <span>{bgmName ? "Ganti MP3/WAV Kustom" : "+ Unggah MP3/WAV Sendiri"}</span>
                        </button>
                      </div>
                    </div>
                  </details>
                </>
              )}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
