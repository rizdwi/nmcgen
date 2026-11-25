"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  NmcProject,
  OmniAnimationMode,
  OmniResolution,
  RuntimeStatus,
  StoryAnimationClip,
  StoryboardData,
} from "@/lib/types";
import { DEFAULT_GEMINI_ID } from "@/lib/presets";
import { downloadBlob, getApiKey, getKeyHint, setApiKey } from "@/lib/storage";
import {
  ANIMATION_APP_LINKS,
  buildAntigravityGeminiHandoff,
  buildOmniAnimationPackZip,
  buildOmniClipPlans,
  clampOmniDuration,
  OMNI_MODEL_ID,
  OMNI_RESOLUTIONS,
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
  UploadIcon,
} from "./Icons";

interface AnimateStepProps {
  project: NmcProject;
  sb: StoryboardData;
  runtime: RuntimeStatus | null;
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
  error?: string;
  progressText?: string;
}

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

export default function AnimateStep({
  project,
  sb,
  runtime,
  onPatchSb,
  onBackToStoryboard,
}: AnimateStepProps) {
  const hasSavedGeminiKey = Boolean(getApiKey(DEFAULT_GEMINI_ID) || runtime?.serverKeys?.gemini);
  const [engineTab, setEngineTab] = useState<EngineTab>(() =>
    hasSavedGeminiKey ? "omni-api" : "handoff",
  );
  const [mode, setMode] = useState<OmniAnimationMode>("segment");
  const [durationSec, setDurationSec] = useState<number>(10);
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
  const cancelRef = useRef(false);
  const blobUrlsRef = useRef<string[]>([]);

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

  const masterHandoffPrompt = useMemo(
    () => buildAntigravityGeminiHandoff({ ...project, storyboard: { ...sb, segments, frames: orderedFrames } }, plans),
    [project, sb, segments, orderedFrames, plans],
  );

  // Saved Gemini key indicator (re-evaluated when keyVersion bumps)
  const localGeminiKey = useMemo(() => {
    void keyVersion;
    return getApiKey(DEFAULT_GEMINI_ID);
  }, [keyVersion]);
  const geminiKeyHint = useMemo(() => {
    void keyVersion;
    return getKeyHint(DEFAULT_GEMINI_ID);
  }, [keyVersion]);
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
    const existing = sb.animationClips ?? [];
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
    );
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const safeName =
      (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") +
      "-omni-1.2-pack.zip";
    downloadBlob(new Blob([copy], { type: "application/zip" }), safeName);
    setGlobalNotice(
      `Paket ZIP animasi (${plans.length} klip + keyframe + prompt Antigravity/Gemini/Omni 1.2) berhasil diunduh.`,
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
      const createRes = await fetch("/api/video/omni", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op,
          apiKey: localGeminiKey || undefined,
          prompt: customPrompt || plan.prompt,
          images: op === "create" ? plan.images.map((im) => im.dataUrl) : undefined,
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
        error: undefined,
        progressText: undefined,
      };
      setClipState(plan.id, readyState);
      persistClipRecord(plan, readyState);
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
        error: undefined,
        progressText: undefined,
      };
      setClipState(plan.id, recovered);
      persistClipRecord(plan, recovered);
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
    setGlobalNotice(`Menggabungkan ${readyClips.length} klip Omni 1.2 menjadi 1 video utuh...`);

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
              <span>Unduh Paket Animasi ZIP</span>
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
              onClick={() => setEngineTab("handoff")}
            >
              <div className="animateEngineTop">
                <strong>Antigravity / Gemini / Omni Web</strong>
                <span className="metaTag mono">Tanpa API Key</span>
              </div>
              <span>Paket prompt + keyframe ZIP siap kirim ke Antigravity, Gemini, Google Vids &amp; Flow</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={engineTab === "omni-api"}
              className="animateEngineTab"
              data-active={engineTab === "omni-api"}
              onClick={() => setEngineTab("omni-api")}
            >
              <div className="animateEngineTop">
                <strong>Gemini Omni 1.2 Flash (API)</strong>
                <span className="metaTag mono" data-tone={omniKeyAvailable ? "ok" : undefined}>
                  {omniKeyAvailable ? "Siap" : "Butuh Gemini Key"}
                </span>
              </div>
              <span>Render langsung MP4 + suara (3–15 dtk, interpolasi First→Last, edit multi-turn)</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={engineTab === "animatic"}
              className="animateEngineTab"
              data-active={engineTab === "animatic"}
              onClick={() => setEngineTab("animatic")}
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
                    Transisi Panel→Panel
                  </button>
                  <button
                    type="button"
                    className="segBtn"
                    aria-selected={mode === "panel"}
                    disabled={queueRunning}
                    onClick={() => {
                      setMode("panel");
                      setDurationSec((d) => clampOmniDuration(d, "panel"));
                    }}
                  >
                    Per Panel ({orderedFrames.length})
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
                    {(mode === "transition" ? DURATION_OPTIONS_TRANSITION : DURATION_OPTIONS_FULL).map((sec) => (
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
          {/* TAB 1: ANTIGRAVITY / GEMINI / GOOGLE VIDS & FLOW HANDOFF        */}
          {/* =============================================================== */}
          {engineTab === "handoff" ? (
            <div className="animateHandoffGrid">
              {/* Left: Master Handoff Card for Antigravity / Gemini */}
              <section className="panelCard">
                <div className="panelHead">
                  <h3>1. Kirim ke Antigravity / Gemini</h3>
                  <span className="metaTag mono">{plans.length} klip siap jalan</span>
                </div>
                <p className="fieldHint">
                  Unduh <strong>Paket Animasi ZIP</strong> (berisi semua gambar keyframe <code className="mono">S01_P01.jpg</code>,
                  aset ACC, prompt Omni 1.2, dan <code className="mono">omni_batch_jobs.json</code>), lalu salin Prompt Master di
                  bawah dan tempel ke <strong>Antigravity</strong> atau <strong>Gemini</strong>.
                </p>

                <div className="actionGroup">
                  <button
                    type="button"
                    className="btn btnPrimary"
                    onClick={() => void handleCopyText(masterHandoffPrompt, "master")}
                  >
                    {copyFeedback === "master" ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                    <span>
                      {copyFeedback === "master"
                        ? "Prompt Master Tersalin!"
                        : "Salin Prompt Master Antigravity / Gemini"}
                    </span>
                  </button>
                  <button type="button" className="btn" onClick={handleDownloadOmniPackZip}>
                    <DownloadIcon size={14} />
                    <span>Unduh Paket ZIP</span>
                  </button>
                </div>

                <div className="handoffAppRow">
                  <a
                    href={ANIMATION_APP_LINKS.googleVids}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btnSm"
                  >
                    <ExternalLinkIcon size={13} />
                    <span>Google Vids (Omni 1.2 Gratis 15 dtk)</span>
                  </a>
                  <a
                    href={ANIMATION_APP_LINKS.googleFlow}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btnSm"
                  >
                    <ExternalLinkIcon size={13} />
                    <span>Google Flow (Omni 1.2)</span>
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

                <details className="subtleDetails" open>
                  <summary>Pratinjau Prompt Master Antigravity / Gemini</summary>
                  <div className="subtleDetailsBody">
                    <pre className="scriptPeekPre">{masterHandoffPrompt}</pre>
                  </div>
                </details>
              </section>

              {/* Right: Per-Clip Copy-Paste Omni 1.2 Prompt Cards */}
              <section className="panelCard">
                <div className="panelHead">
                  <h3>2. Prompt Siap Tempel Per-Klip (Omni 1.2 Flash)</h3>
                  <span className="fieldHint">Format natural-language resmi tanpa tag usang</span>
                </div>

                <div className="omniClipList">
                  {plans.map((plan, idx) => (
                    <article key={plan.id} className="omniClipCard">
                      <div className="omniClipHead">
                        <div className="metaInline">
                          <span className="frameIndexPill mono">KLIP {String(idx + 1).padStart(2, "0")}</span>
                          <strong>{plan.label}</strong>
                        </div>
                        <div className="actionGroup">
                          <span className="metaTag mono">
                            {plan.durationSec} dtk · {plan.images.length} gambar
                          </span>
                          <button
                            type="button"
                            className="btn btnSm"
                            onClick={() => void handleCopyText(plan.prompt, plan.id)}
                          >
                            {copyFeedback === plan.id ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                            <span>{copyFeedback === plan.id ? "Tersalin" : "Salin Prompt"}</span>
                          </button>
                        </div>
                      </div>

                      {plan.images.length > 0 ? (
                        <div className="omniThumbRow">
                          {plan.images.map((im, i) => (
                            <div key={`${plan.id}-im-${i}`} className="omniThumbItem" title={im.label}>
                              <img src={im.dataUrl} alt={im.label} />
                              <span className="mono">#{i + 1}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="fieldHint">Belum ada gambar panel tergenerate di klip ini (akan jalan sebagai text-to-video).</p>
                      )}

                      <textarea
                        aria-label={`Prompt Omni 1.2 untuk ${plan.label}`}
                        className="textarea omniPromptBox"
                        value={plan.prompt}
                        onChange={(e) =>
                          setPromptOverrides((prev) => ({ ...prev, [plan.id]: e.target.value }))
                        }
                      />
                    </article>
                  ))}
                </div>
              </section>
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
                  Memakai endpoint resmi <code className="mono">/v1beta/interactions</code> ({OMNI_MODEL_ID}). Estimasi
                  biaya Google AI Studio ~\$0.07/detik (720p) sudah termasuk audio &amp; lip-sync. Untuk opsi tanpa API
                  key berbayar, gunakan tab <strong>Antigravity / Gemini / Omni Web</strong>.
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
                    <article key={plan.id} className="panelCard omniClipCard" data-status={st.status}>
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
                              <span className="mono">#{i + 1}</span>
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
