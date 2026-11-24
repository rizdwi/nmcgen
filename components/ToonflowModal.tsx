"use client";
import React, { useEffect, useRef, useState } from "react";
import type {
  AssetNodeData,
  NmcProject,
  ProviderProfile,
  RenderReceipt,
  ScriptNodeData,
  SegmentNodeData,
  ToonflowEventNode,
  ToonflowSceneBlock,
} from "@/lib/types";
import { renderBrowserWebm } from "@/lib/browserExport";
import { buildGoogleFlowGuide, buildOfflineBundleZip } from "@/lib/bundle";
import { createDefaultNode, uid } from "@/lib/presets";
import { callAi, downloadBlob } from "@/lib/storage";
import {
  applyExtractedAssetsToProject,
  buildAssetExtractionPrompt,
  buildAssetReferenceImagePrompt,
  buildEventGraphPrompt,
  buildScriptAgentPrompt,
  buildStoryboardAgentPrompt,
  buildSupervisionPrompt,
  cleanSourceText,
  formatScenesToScreenplay,
  parseEventGraphResponse,
  parseExtractedAssets,
  parseScriptAgentResponse,
  parseStoryboardBeats,
  parseSupervisionResponse,
  rebuildSegmentsFromBeats,
  splitIntoChapters,
} from "@/lib/toonflow";
import {
  composeSegmentImagePrompt,
  getAdoptedMedia,
  getBoundAssets,
  getOrderedSegments,
  selectSegmentReferenceImages,
} from "@/lib/validator";
import { CloseIcon } from "./Icons";

type StageTab =
  | "materi"
  | "events"
  | "assets"
  | "script"
  | "storyboard"
  | "supervision"
  | "autorun";

interface QueueTask {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
}

interface ToonflowModalProps {
  open: boolean;
  autoStart?: boolean;
  project: NmcProject;
  textProfile: ProviderProfile;
  imageProfile: ProviderProfile;
  onReplaceProject: (next: NmcProject) => void;
  onSaveReceipt?: (receipt: RenderReceipt) => void;
  onSyncDiscoveredModels: (
    profileId: string,
    discovered: { textModels: string[]; imageModels: string[]; fetchedAt: number },
  ) => void;
  onOpenSettings: () => void;
  onOpenPipeline: () => void;
  onClose: () => void;
}

function ensureScriptNode(project: NmcProject): { project: NmcProject; scriptId: string; data: ScriptNodeData } {
  const existing = project.nodes.find((n) => n.kind === "script" && n.data.kind === "script");
  if (existing && existing.data.kind === "script") {
    return { project, scriptId: existing.id, data: existing.data };
  }
  const created = createDefaultNode("script", 32, 120, 1);
  return {
    project: { ...project, nodes: [created, ...project.nodes] },
    scriptId: created.id,
    data: created.data as ScriptNodeData,
  };
}

function patchScriptInProject(project: NmcProject, patch: Partial<ScriptNodeData>): NmcProject {
  const ensured = ensureScriptNode(project);
  return {
    ...ensured.project,
    nodes: ensured.project.nodes.map((n) =>
      n.id === ensured.scriptId && n.data.kind === "script"
        ? { ...n, data: { ...n.data, ...patch } }
        : n,
    ),
  };
}

export default function ToonflowModal({
  open,
  autoStart,
  project,
  textProfile,
  imageProfile,
  onReplaceProject,
  onSaveReceipt,
  onSyncDiscoveredModels,
  onOpenSettings,
  onOpenPipeline,
  onClose,
}: ToonflowModalProps) {
  const [tab, setTab] = useState<StageTab>("autorun");
  const [busyMsg, setBusyMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [autoGenAssets, setAutoGenAssets] = useState(true);
  const [autoGenFrames, setAutoGenFrames] = useState(true);
  const [autoSupervise, setAutoSupervise] = useState(true);
  const [autoRenderVideo, setAutoRenderVideo] = useState(true);
  const [finalVideo, setFinalVideo] = useState<RenderReceipt | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef<NmcProject>(project);
  const abortRef = useRef(false);
  const autoStartedRef = useRef(false);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    setFinalVideo(null);
    setTasks([]);
    setOkMsg("");
    setErrMsg("");
  }, [project.id]);

  useEffect(() => {
    if (!open) {
      autoStartedRef.current = false;
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyMsg) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busyMsg, onClose]);

  useEffect(() => {
    if (open && autoStart && !autoStartedRef.current && !busyMsg) {
      autoStartedRef.current = true;
      void handleRunFullPipeline();
    }
  });

  if (!open) return null;

  const ensured = ensureScriptNode(project);
  const sd = ensured.data;
  const chapters = sd.chapters ?? [];
  const events = sd.eventGraph ?? [];
  const scenes = sd.structuredScenes ?? [];
  const supervision = sd.supervision;
  const assets = project.nodes.filter((n) => n.kind === "asset");
  const segments = getOrderedSegments(project);
  const targetSegments = Math.max(3, Math.min(12, sd.targetSegments || 5));

  const commit = (next: NmcProject) => {
    projectRef.current = next;
    onReplaceProject(next);
  };

  const patchScript = (patch: Partial<ScriptNodeData>) => {
    commit(patchScriptInProject(projectRef.current, patch));
  };

  const upsertTask = (id: string, patch: Partial<QueueTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const handleUploadTextFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const cleaned = cleanSourceText(raw);
      const split = splitIntoChapters(cleaned);
      patchScript({
        sourceText: cleaned,
        chapters: split,
        activeChapterId: split[0]?.id,
      });
      setOkMsg(`File "${file.name}" dibersihkan dan dipecah menjadi ${split.length} bab.`);
      setErrMsg("");
    } catch (err) {
      setErrMsg(`Gagal membaca file: ${(err as Error).message}`);
    } finally {
      e.target.value = "";
    }
  };

  const handleCleanAndSplit = () => {
    const raw = (sd.sourceText || sd.premise || "").trim();
    if (!raw) {
      setErrMsg("Tempel materi cerita atau isi premis terlebih dahulu.");
      return;
    }
    const cleaned = cleanSourceText(raw);
    const split = splitIntoChapters(cleaned);
    patchScript({
      sourceText: cleaned,
      chapters: split,
      activeChapterId: split[0]?.id,
    });
    setOkMsg(`Materi dibersihkan dan dibagi menjadi ${split.length} bab siap olah.`);
    setErrMsg("");
  };

  // Stage 2 executor
  const execEventGraph = async (curProj: NmcProject, feedbackNote?: string): Promise<{ next: NmcProject; model?: string }> => {
    const curScript = ensureScriptNode(curProj).data;
    const activeChap = (curScript.chapters ?? []).find((c) => c.id === curScript.activeChapterId) ?? curScript.chapters?.[0];
    const premise = curScript.premise.trim() || curProj.name.trim();
    if (!premise && !activeChap?.content) {
      throw new Error("Isi premis atau materi cerita terlebih dahulu di tahap 01.");
    }
    const count = Math.max(3, Math.min(12, curScript.targetSegments || 5));
    const built = buildEventGraphPrompt({
      projectName: curProj.name,
      premise: feedbackNote ? `${premise}\n\nCatatan perbaikan wajib dari Supervisor:\n${feedbackNote}` : premise,
      chapterText: activeChap?.content || curScript.sourceText,
      targetSegments: count,
      maxSegmentSec: curScript.maxSegmentSec || 8,
      visualStyle: curScript.visualStyle,
    });
    const res = await callAi(textProfile, "text", built);
    if (res.discovered) onSyncDiscoveredModels(textProfile.id, res.discovered);
    if (!res.ok || !res.text) {
      throw new Error(res.error || "Gagal menyusun Event Graph dari AI.");
    }
    const parsedEvents = parseEventGraphResponse(res.text, count, curScript.maxSegmentSec || 8);
    const next = patchScriptInProject(curProj, { eventGraph: parsedEvents });
    commit(next);
    return { next, model: res.usedModel };
  };

  // Stage 3A executor: extract assets from Event Graph
  const execExtractAssets = async (curProj: NmcProject): Promise<{ next: NmcProject; added: number; updated: number; model?: string }> => {
    const curScript = ensureScriptNode(curProj).data;
    const evs = curScript.eventGraph ?? [];
    if (!evs.length) throw new Error("Bangun Event Graph di tahap 02 terlebih dahulu sebelum ekstrak aset.");
    const built = buildAssetExtractionPrompt({
      projectName: curProj.name,
      premise: curScript.premise,
      visualStyle: curScript.visualStyle,
      events: evs,
    });
    const res = await callAi(textProfile, "text", built);
    if (res.discovered) onSyncDiscoveredModels(textProfile.id, res.discovered);
    if (!res.ok || !res.text) throw new Error(res.error || "Gagal mengekstrak aset dari Event Graph.");
    const specs = parseExtractedAssets(res.text);
    const applied = applyExtractedAssetsToProject(curProj, specs);
    commit(applied.project);
    return { next: applied.project, added: applied.addedCount, updated: applied.updatedCount, model: res.usedModel };
  };

  // Stage 3B executor: generate reference image for one asset
  const execGenerateOneAssetImage = async (curProj: NmcProject, assetId: string): Promise<{ next: NmcProject; model?: string }> => {
    const curScript = ensureScriptNode(curProj).data;
    const node = curProj.nodes.find((n) => n.id === assetId && n.data.kind === "asset");
    if (!node || node.data.kind !== "asset") return { next: curProj };
    const ad = node.data as AssetNodeData;
    const res = await callAi(imageProfile, "image", {
      prompt: buildAssetReferenceImagePrompt(ad, curScript.visualStyle),
      aspectRatio: "16:9",
    });
    if (res.discovered) onSyncDiscoveredModels(imageProfile.id, res.discovered);
    if (!res.ok || !res.image) throw new Error(res.error || `Gagal membuat gambar aset ${ad.tag}.`);
    const next: NmcProject = {
      ...curProj,
      nodes: curProj.nodes.map((n) =>
        n.id === assetId && n.data.kind === "asset"
          ? {
              ...n,
              data: {
                ...n.data,
                imageDataUrl: res.image,
                imageName: `${ad.tag.replace(/[^a-zA-Z0-9_-]/g, "") || "asset"}.png`,
              },
            }
          : n,
      ),
    };
    commit(next);
    return { next, model: res.usedModel };
  };

  // Stage 4 executor: ScriptAgent
  const execScriptAgent = async (curProj: NmcProject): Promise<{ next: NmcProject; model?: string }> => {
    const curScript = ensureScriptNode(curProj).data;
    const evs = curScript.eventGraph ?? [];
    if (!evs.length) throw new Error("Bangun Event Graph di tahap 02 terlebih dahulu sebelum ScriptAgent.");
    const curAssets = curProj.nodes
      .filter((n) => n.kind === "asset" && n.data.kind === "asset")
      .map((n) => {
        const d = n.data as AssetNodeData;
        return { tag: d.tag, category: d.category, lockPrompt: d.lockPrompt };
      });
    const built = buildScriptAgentPrompt({
      projectName: curProj.name,
      visualStyle: curScript.visualStyle,
      maxSegmentSec: curScript.maxSegmentSec || 8,
      events: evs,
      assets: curAssets,
    });
    const res = await callAi(textProfile, "text", built);
    if (res.discovered) onSyncDiscoveredModels(textProfile.id, res.discovered);
    if (!res.ok || !res.text) throw new Error(res.error || "ScriptAgent gagal mengadaptasi naskah.");
    const parsedScenes = parseScriptAgentResponse(res.text, evs);
    const formatted = formatScenesToScreenplay(parsedScenes);
    const next = patchScriptInProject(curProj, {
      structuredScenes: parsedScenes,
      scriptText: formatted,
    });
    commit(next);
    return { next, model: res.usedModel };
  };

  // Stage 5A executor: ProductionAgent Storyboard -> Beats + Canvas Segments
  const execStoryboardAndSegments = async (curProj: NmcProject): Promise<{ next: NmcProject; count: number; model?: string }> => {
    const curScript = ensureScriptNode(curProj).data;
    const evs = curScript.eventGraph ?? [];
    const scs = curScript.structuredScenes ?? [];
    if (!evs.length && !scs.length) {
      throw new Error("Jalankan tahap Event Graph atau ScriptAgent terlebih dahulu.");
    }
    const curAssets = curProj.nodes
      .filter((n) => n.kind === "asset" && n.data.kind === "asset")
      .map((n) => {
        const d = n.data as AssetNodeData;
        return { tag: d.tag, category: d.category, lockPrompt: d.lockPrompt };
      });
    const built = buildStoryboardAgentPrompt({
      projectName: curProj.name,
      aspectRatio: curScript.aspectRatio,
      maxSegmentSec: curScript.maxSegmentSec || 8,
      visualStyle: curScript.visualStyle,
      events: evs,
      scenes: scs,
      assets: curAssets,
    });
    const res = await callAi(textProfile, "text", built);
    if (res.discovered) onSyncDiscoveredModels(textProfile.id, res.discovered);
    if (!res.ok || !res.text) throw new Error(res.error || "ProductionAgent gagal menyusun storyboard.");
    const parsedBeats = parseStoryboardBeats(res.text, evs, scs, curScript.maxSegmentSec || 8);
    const withBeats = patchScriptInProject(curProj, { beats: parsedBeats });
    const rebuilt = rebuildSegmentsFromBeats(withBeats, parsedBeats, { replaceExisting: true });
    commit(rebuilt);
    return { next: rebuilt, count: parsedBeats.length, model: res.usedModel };
  };

  // Stage 5B executor: generate one segment keyframe
  const execGenerateOneSegmentFrame = async (curProj: NmcProject, segmentId: string): Promise<{ next: NmcProject; model?: string }> => {
    const curScript = ensureScriptNode(curProj).data;
    const segNode = curProj.nodes.find((n) => n.id === segmentId && n.data.kind === "segment");
    if (!segNode || segNode.data.kind !== "segment") return { next: curProj };
    const prompt = composeSegmentImagePrompt(curProj, segNode);
    const refImages = selectSegmentReferenceImages(curProj, segNode);
    const res = await callAi(imageProfile, "image", {
      prompt,
      aspectRatio: curScript.aspectRatio,
      referenceImages: refImages,
    });
    if (res.discovered) onSyncDiscoveredModels(imageProfile.id, res.discovered);
    if (!res.ok || !res.image) throw new Error(res.error || `Gagal membuat keyframe ${segNode.data.code}.`);

    const candId = uid();
    const next: NmcProject = {
      ...curProj,
      nodes: curProj.nodes.map((n) => {
        if (n.id !== segmentId || n.data.kind !== "segment") return n;
        const d = n.data as SegmentNodeData;
        return {
          ...n,
          data: {
            ...d,
            candidates: [
              ...d.candidates,
              {
                id: candId,
                kind: "image",
                label: res.usedModel
                  ? `#${d.candidates.length + 1} (${res.usedModel.slice(0, 18)})`
                  : `Kandidat #${d.candidates.length + 1}`,
                dataUrl: res.image!,
                createdAt: Date.now(),
              },
            ],
            adoptedId: candId,
          },
        };
      }),
    };
    commit(next);
    return { next, model: res.usedModel };
  };

  // Stage 6 executor: SupervisionAgent QC audit
  const execSupervisionAudit = async (curProj: NmcProject): Promise<{ next: NmcProject; score: number; model?: string }> => {
    const curScript = ensureScriptNode(curProj).data;
    const orderedSegs = getOrderedSegments(curProj);
    if (!orderedSegs.length) {
      throw new Error("Belum ada segmen storyboard untuk diaudit. Jalankan tahap 05 terlebih dahulu.");
    }
    const segSummaries = orderedSegs.map((n) => {
      const d = n.data as SegmentNodeData;
      return {
        code: d.code,
        storyStage: d.storyStage,
        durationSec: d.durationSec,
        shotSize: d.shotSize,
        cameraAngle: d.cameraAngle,
        timelineText: d.timelineText,
        dialogue: d.dialogue,
        continuityLock: d.continuityLock,
        visualPrompt: d.visualPrompt,
        boundAssets: getBoundAssets(curProj, n.id).map((a) => (a.data as AssetNodeData).tag),
      };
    });
    const built = buildSupervisionPrompt({
      projectName: curProj.name,
      premise: curScript.premise,
      events: curScript.eventGraph ?? [],
      segments: segSummaries,
    });
    const res = await callAi(textProfile, "text", built);
    if (res.discovered) onSyncDiscoveredModels(textProfile.id, res.discovered);
    if (!res.ok || !res.text) throw new Error(res.error || "SupervisionAgent gagal mengaudit episode.");
    const report = parseSupervisionResponse(res.text);
    const next = patchScriptInProject(curProj, { supervision: report });
    commit(next);
    return { next, score: report.score, model: res.usedModel };
  };

  // Single-stage button handlers
  const runAction = async (label: string, fn: () => Promise<string>) => {
    setBusyMsg(label);
    setErrMsg("");
    setOkMsg("");
    try {
      const doneMsg = await fn();
      setOkMsg(doneMsg);
    } catch (err) {
      setErrMsg((err as Error).message);
    } finally {
      setBusyMsg("");
    }
  };

  const handleBatchAssets = async (regenerateAll: boolean) => {
    const targets = projectRef.current.nodes.filter(
      (n) => n.kind === "asset" && n.data.kind === "asset" && (regenerateAll || !n.data.imageDataUrl),
    );
    if (!targets.length) {
      setOkMsg("Semua aset sudah memiliki gambar referensi.");
      return;
    }
    abortRef.current = false;
    setErrMsg("");
    setOkMsg("");
    let cur = projectRef.current;
    try {
      for (let i = 0; i < targets.length; i++) {
        if (abortRef.current) break;
        const t = targets[i];
        const tag = (t.data as AssetNodeData).tag;
        setBusyMsg(`Membuat gambar aset ${i + 1}/${targets.length}: ${tag}...`);
        const res = await execGenerateOneAssetImage(cur, t.id);
        cur = res.next;
      }
      setOkMsg(`Batch gambar aset selesai (${targets.length} aset diperbarui).`);
    } catch (err) {
      setErrMsg((err as Error).message);
    } finally {
      setBusyMsg("");
    }
  };

  const handleBatchKeyframes = async (regenerateAll: boolean) => {
    const ordered = getOrderedSegments(projectRef.current);
    const targets = ordered.filter(
      (n) => n.data.kind === "segment" && (regenerateAll || !getAdoptedMedia(n.data as SegmentNodeData)),
    );
    if (!targets.length) {
      setOkMsg("Semua segmen sudah memiliki keyframe teradopsi.");
      return;
    }
    abortRef.current = false;
    setErrMsg("");
    setOkMsg("");
    let cur = projectRef.current;
    try {
      for (let i = 0; i < targets.length; i++) {
        if (abortRef.current) break;
        const seg = targets[i];
        const code = (seg.data as SegmentNodeData).code;
        setBusyMsg(`Membuat keyframe segmen ${i + 1}/${targets.length}: ${code}...`);
        const res = await execGenerateOneSegmentFrame(cur, seg.id);
        cur = res.next;
      }
      setOkMsg(`Batch keyframe selesai (${targets.length} segmen diperbarui).`);
    } catch (err) {
      setErrMsg((err as Error).message);
    } finally {
      setBusyMsg("");
    }
  };

  // Stage 7: Full 1-Click Toonflow Pipeline Orchestrator with real-time Task Queue Monitor + Auto Video Render
  const handleRunFullPipeline = async (feedbackNote?: string) => {
    abortRef.current = false;
    setErrMsg("");
    setOkMsg("");
    setFinalVideo(null);
    setTab("autorun");

    const baseTasks: QueueTask[] = [
      { id: "t-events", label: "02. Decision Agent: Susun Event Graph (Alur Sebab-Akibat)", status: "pending" },
      { id: "t-assets-extract", label: "03. Asset Agent: Ekstrak Karakter, Lokasi & Prop", status: "pending" },
      ...(autoGenAssets
        ? [{ id: "t-assets-img", label: "03b. Batch Generate Gambar Referensi Aset", status: "pending" as const }]
        : []),
      { id: "t-script", label: "04. ScriptAgent: Adaptasi Naskah Terstruktur dari Event Graph", status: "pending" },
      { id: "t-storyboard", label: "05. ProductionAgent: Susun Storyboard, Audio & Segmen Kanvas", status: "pending" },
      ...(autoGenFrames
        ? [{ id: "t-frames", label: "05b. Batch Generate Keyframe Semua Segmen", status: "pending" as const }]
        : []),
      ...(autoSupervise
        ? [{ id: "t-supervise", label: "06. SupervisionAgent: Audit Alur Cerita & Kontinuitas", status: "pending" as const }]
        : []),
      ...(autoRenderVideo
        ? [{ id: "t-render", label: "07. Auto-Render Video WebM Siap Tonton (Subtitle + Audio)", status: "pending" as const }]
        : []),
    ];
    setTasks(baseTasks);

    let cur = projectRef.current;
    const runTask = async <T,>(id: string, busyLabel: string, fn: () => Promise<{ detail: string; value: T }>): Promise<T> => {
      if (abortRef.current) throw new Error("Pipeline dihentikan oleh pengguna.");
      setBusyMsg(busyLabel);
      upsertTask(id, { status: "running", detail: "Memproses..." });
      const t0 = Date.now();
      try {
        const out = await fn();
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        upsertTask(id, { status: "done", detail: `${out.detail} (${secs}d)` });
        return out.value;
      } catch (err) {
        upsertTask(id, { status: "error", detail: (err as Error).message });
        throw err;
      }
    };

    try {
      // 1. Event Graph
      cur = await runTask("t-events", "Menyusun Event Graph alur film pendek...", async () => {
        const res = await execEventGraph(cur, feedbackNote);
        const evCount = ensureScriptNode(res.next).data.eventGraph?.length ?? 0;
        return { value: res.next, detail: `${evCount} event kausal via ${res.model || textProfile.name}` };
      });

      // 2. Asset extraction
      cur = await runTask("t-assets-extract", "Mengekstrak karakter, lokasi, dan prop...", async () => {
        const res = await execExtractAssets(cur);
        return {
          value: res.next,
          detail: `+${res.added} baru, ${res.updated} diperbarui via ${res.model || textProfile.name}`,
        };
      });

      // 3. Batch asset images
      if (autoGenAssets) {
        cur = await runTask("t-assets-img", "Membuat gambar referensi semua aset...", async () => {
          const targets = cur.nodes.filter(
            (n) => n.kind === "asset" && n.data.kind === "asset" && !n.data.imageDataUrl,
          );
          let lastModel = imageProfile.name;
          for (let i = 0; i < targets.length; i++) {
            if (abortRef.current) throw new Error("Pipeline dihentikan oleh pengguna.");
            const tag = (targets[i].data as AssetNodeData).tag;
            upsertTask("t-assets-img", { detail: `Membuat aset ${i + 1}/${targets.length}: ${tag}` });
            const res = await execGenerateOneAssetImage(cur, targets[i].id);
            cur = res.next;
            if (res.model) lastModel = res.model;
          }
          return {
            value: cur,
            detail: targets.length ? `${targets.length} aset digambar via ${lastModel}` : "Semua aset sudah punya gambar",
          };
        });
      }

      // 4. ScriptAgent
      cur = await runTask("t-script", "ScriptAgent menyusun naskah terstruktur...", async () => {
        const res = await execScriptAgent(cur);
        const scCount = ensureScriptNode(res.next).data.structuredScenes?.length ?? 0;
        return { value: res.next, detail: `${scCount} adegan terstruktur via ${res.model || textProfile.name}` };
      });

      // 5. ProductionAgent Storyboard & Segments (+ ensure ambient audio wired to Timeline)
      cur = await runTask("t-storyboard", "ProductionAgent membangun segmen storyboard...", async () => {
        const res = await execStoryboardAndSegments(cur);
        let withAudio = res.next;
        const asm = withAudio.nodes.find((n) => n.kind === "assembly");
        const hasAudio = withAudio.nodes.some((n) => n.kind === "audio");
        if (asm && !hasAudio) {
          const audioNode = createDefaultNode("audio", 750, 36 + res.count * 248, 1);
          withAudio = {
            ...withAudio,
            nodes: [...withAudio.nodes, audioNode],
            edges: [...withAudio.edges, { id: uid(), source: audioNode.id, target: asm.id }],
          };
          commit(withAudio);
        }
        return { value: withAudio, detail: `${res.count} segmen + audio ambient terhubung via ${res.model || textProfile.name}` };
      });

      // 6. Batch keyframes
      if (autoGenFrames) {
        cur = await runTask("t-frames", "Membuat keyframe visual semua segmen...", async () => {
          const ordered = getOrderedSegments(cur);
          let lastModel = imageProfile.name;
          for (let i = 0; i < ordered.length; i++) {
            if (abortRef.current) throw new Error("Pipeline dihentikan oleh pengguna.");
            const code = (ordered[i].data as SegmentNodeData).code;
            upsertTask("t-frames", { detail: `Keyframe ${i + 1}/${ordered.length}: ${code}` });
            const res = await execGenerateOneSegmentFrame(cur, ordered[i].id);
            cur = res.next;
            if (res.model) lastModel = res.model;
          }
          return { value: cur, detail: `${ordered.length} keyframe dibuat via ${lastModel}` };
        });
      }

      // 7. SupervisionAgent
      if (autoSupervise) {
        cur = await runTask("t-supervise", "SupervisionAgent mengaudit kualitas cerita...", async () => {
          const res = await execSupervisionAudit(cur);
          return { value: res.next, detail: `Skor kualitas cerita: ${res.score}/100` };
        });
      }

      // 8. Auto-render final WebM video right in browser so user immediately receives playable result
      if (autoRenderVideo) {
        await runTask("t-render", "Merender video hasil jadi (.webm) di browser...", async () => {
          const out = await renderBrowserWebm(cur, (pct, label) => {
            setBusyMsg(`${label} (${pct}%)`);
            upsertTask("t-render", { detail: `${label} (${pct}%)` });
          });
          const url = URL.createObjectURL(out.blob);
          const safeName =
            (cur.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") + ".webm";
          const receipt: RenderReceipt = {
            engine: "browser-webm",
            fileUrl: url,
            fileName: safeName,
            durationSec: out.durationSec,
            sizeBytes: out.blob.size,
            resolution: out.resolution,
            verifiedAt: Date.now(),
            note: "Video WebM selesai dirender otomatis di browser dengan subtitle & audio ambient.",
          };
          setFinalVideo(receipt);
          onSaveReceipt?.(receipt);
          return {
            value: cur,
            detail: `${safeName} (${out.resolution}, ${out.durationSec} dtk, ${(out.blob.size / (1024 * 1024)).toFixed(2)} MB)`,
          };
        });
      }

      setOkMsg("Seluruh pipeline AI selesai. Video hasil jadi siap diputar dan diunduh di bawah ini.");
    } catch (err) {
      setErrMsg((err as Error).message);
    } finally {
      setBusyMsg("");
    }
  };

  const handleDownloadFullZip = async () => {
    setBusyMsg("Menyusun Paket Lengkap (.zip)...");
    setErrMsg("");
    try {
      const [renderRes, capcutRes] = await Promise.all([
        fetch("/scripts/render_ffmpeg.py"),
        fetch("/scripts/build_capcut_draft.py"),
      ]);
      const renderPy = renderRes.ok ? await renderRes.text() : "";
      const capcutPy = capcutRes.ok ? await capcutRes.text() : "";
      const zipBytes = buildOfflineBundleZip(projectRef.current, renderPy, capcutPy);
      const safeName =
        (projectRef.current.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") +
        "-bundle.zip";
      const copy = new Uint8Array(zipBytes.byteLength);
      copy.set(zipBytes);
      downloadBlob(new Blob([copy], { type: "application/zip" }), safeName);
      setOkMsg(`Paket lengkap ${safeName} berhasil diunduh.`);
    } catch (err) {
      setErrMsg(`Gagal membuat ZIP: ${(err as Error).message}`);
    } finally {
      setBusyMsg("");
    }
  };

  const handleDownloadFlowMd = () => {
    const guide = buildGoogleFlowGuide(projectRef.current);
    const safeName =
      (projectRef.current.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") +
      "-google-flow.md";
    downloadBlob(new Blob([guide], { type: "text/markdown;charset=utf-8" }), safeName);
    setOkMsg(`Panduan Google Flow (${safeName}) berhasil diunduh.`);
  };

  const moveEvent = (idx: number, delta: -1 | 1) => {
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= events.length) return;
    const copy = [...events];
    const [moved] = copy.splice(idx, 1);
    copy.splice(targetIdx, 0, moved);
    const reindexed = copy.map((ev, i) => ({ ...ev, code: `EV${String(i + 1).padStart(2, "0")}` }));
    patchScript({ eventGraph: reindexed });
  };

  const updateEvent = (idx: number, patch: Partial<ToonflowEventNode>) => {
    const next = events.map((ev, i) => (i === idx ? { ...ev, ...patch } : ev));
    patchScript({ eventGraph: next });
  };

  const updateScene = (idx: number, patch: Partial<ToonflowSceneBlock>) => {
    const next = scenes.map((sc, i) => (i === idx ? { ...sc, ...patch } : sc));
    patchScript({ structuredScenes: next, scriptText: formatScenesToScreenplay(next) });
  };

  const tabItems: Array<{ id: StageTab; label: string; count?: string; ready: boolean }> = [
    { id: "autorun", label: "Auto-Run", ready: segments.length > 0 && Boolean(supervision) },
    { id: "materi", label: "01 Materi", count: chapters.length ? `${chapters.length}` : undefined, ready: Boolean(sd.premise.trim() || sd.sourceText?.trim()) },
    { id: "events", label: "02 Event Graph", count: events.length ? `${events.length}` : undefined, ready: events.length > 0 },
    { id: "assets", label: "03 Aset", count: assets.length ? `${assets.length}` : undefined, ready: assets.length > 0 },
    { id: "script", label: "04 ScriptAgent", count: scenes.length ? `${scenes.length}` : undefined, ready: scenes.length > 0 },
    { id: "storyboard", label: "05 Storyboard", count: segments.length ? `${segments.length}` : undefined, ready: segments.length > 0 },
    {
      id: "supervision",
      label: "06 Supervisor",
      count: supervision ? `${supervision.score}` : undefined,
      ready: supervision?.verdict === "siap",
    },
  ];

  return (
    <div
      className="modalBackdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="toonflow-title"
      onClick={() => {
        if (!busyMsg) onClose();
      }}
    >
      <div className="modalDialog modalDialogWide" onClick={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <h2 id="toonflow-title">Pipeline Toonflow: {project.name}</h2>
            <span className="metaTag mono">{textProfile.name}</span>
          </div>
          <button
            type="button"
            className="btn btnGhost btnIcon"
            aria-label="Tutup Pipeline Toonflow"
            disabled={Boolean(busyMsg)}
            onClick={onClose}
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="toonflowTabs" role="tablist" aria-label="Tahapan Pipeline Toonflow">
          {tabItems.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className="toonflowTab"
              aria-selected={tab === item.id}
              data-ready={item.ready}
              onClick={() => setTab(item.id)}
            >
              <span>{item.label}</span>
              {item.count ? <span className="toonflowTabCount mono">{item.count}</span> : null}
            </button>
          ))}
        </div>

        <div className="modalBody">
          {busyMsg ? (
            <div className="alertBox" role="status" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span>{busyMsg}</span>
              <button
                type="button"
                className="btn btnDanger btnSm"
                onClick={() => {
                  abortRef.current = true;
                }}
              >
                Hentikan
              </button>
            </div>
          ) : null}

          {errMsg ? (
            <div className="alertBox" data-tone="error" role="alert">
              {errMsg}{" "}
              <button type="button" className="btn btnSm" style={{ marginLeft: 8 }} onClick={onOpenSettings}>
                Pengaturan AI
              </button>
            </div>
          ) : null}

          {okMsg ? (
            <div className="alertBox" data-tone="ok" role="status">
              {okMsg}
            </div>
          ) : null}

          {/* TAB 0: AUTO-RUN & TASK QUEUE MONITOR */}
          {tab === "autorun" ? (
            <>
              <div className="sectionBox">
                <h3>Orkestrasi Penuh Toonflow (Materi ke Episode Siap Render)</h3>
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                  Menjalankan seluruh tahapan Toonflow secara berurutan: Event Graph sebab-akibat (Intro, Masalah 1,
                  Masalah 2, Klimaks, Ending), Ekstraksi Aset + gambar referensi, ScriptAgent, Storyboard + keyframe
                  segmen, hingga Audit Supervisor.
                </p>

                <div className="fieldRow">
                  <div className="fieldGroup">
                    <label className="fieldLabel" htmlFor="tf-auto-target">
                      Jumlah Segmen / Babak Cerita
                    </label>
                    <select
                      id="tf-auto-target"
                      className="select"
                      value={targetSegments}
                      disabled={Boolean(busyMsg)}
                      onChange={(e) => patchScript({ targetSegments: Number(e.target.value) })}
                    >
                      <option value={3}>3 segmen (Intro - Konflik - Ending)</option>
                      <option value={4}>4 segmen (Intro - Masalah - Klimaks - Ending)</option>
                      <option value={5}>5 segmen (Intro - Masalah 1 - Masalah 2 - Klimaks - Ending)</option>
                      <option value={6}>6 segmen (Episode Panjang)</option>
                      <option value={8}>8 segmen (Film Pendek Lengkap)</option>
                    </select>
                  </div>
                  <div className="fieldGroup">
                    <label className="fieldLabel" htmlFor="tf-auto-maxdur">
                      Durasi Maks per Segmen
                    </label>
                    <select
                      id="tf-auto-maxdur"
                      className="select"
                      value={sd.maxSegmentSec}
                      disabled={Boolean(busyMsg)}
                      onChange={(e) => patchScript({ maxSegmentSec: Number(e.target.value) })}
                    >
                      <option value={8}>8 detik (Google Flow / Veo)</option>
                      <option value={15}>15 detik (Seedance 2.0)</option>
                      <option value={30}>30 detik (Seedance 2.5)</option>
                    </select>
                  </div>
                </div>

                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="tf-auto-premise">
                    Premis / Cerita Inti Episode
                  </label>
                  <textarea
                    id="tf-auto-premise"
                    className="textarea"
                    style={{ minHeight: 74 }}
                    value={sd.premise}
                    disabled={Boolean(busyMsg)}
                    onChange={(e) => patchScript({ premise: e.target.value })}
                    placeholder="Tuliskan tokoh utama, tujuan, konflik utama, dan latar cerita..."
                  />
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
                  <label className="checkRow">
                    <input
                      type="checkbox"
                      checked={autoGenAssets}
                      disabled={Boolean(busyMsg)}
                      onChange={(e) => setAutoGenAssets(e.target.checked)}
                    />
                    <span>Batch generate gambar referensi aset</span>
                  </label>
                  <label className="checkRow">
                    <input
                      type="checkbox"
                      checked={autoGenFrames}
                      disabled={Boolean(busyMsg)}
                      onChange={(e) => setAutoGenFrames(e.target.checked)}
                    />
                    <span>Batch generate keyframe semua segmen</span>
                  </label>
                  <label className="checkRow">
                    <input
                      type="checkbox"
                      checked={autoSupervise}
                      disabled={Boolean(busyMsg)}
                      onChange={(e) => setAutoSupervise(e.target.checked)}
                    />
                    <span>Jalankan SupervisionAgent di akhir</span>
                  </label>
                  <label className="checkRow">
                    <input
                      type="checkbox"
                      checked={autoRenderVideo}
                      disabled={Boolean(busyMsg)}
                      onChange={(e) => setAutoRenderVideo(e.target.checked)}
                    />
                    <span>Auto-render video WebM siap putar &amp; unduh (di browser)</span>
                  </label>
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button
                    type="button"
                    className="btn btnPrimary"
                    disabled={Boolean(busyMsg)}
                    onClick={() => handleRunFullPipeline()}
                  >
                    Generate Seluruh Pipeline AI (Terima Hasil Jadi)
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={Boolean(busyMsg)}
                    onClick={() => setTab("materi")}
                  >
                    Buka Tahap Manual (01-06)
                  </button>
                </div>
              </div>

              {finalVideo?.fileUrl ? (
                <div className="sectionBox">
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <h3>Hasil Jadi Siap Tonton &amp; Unduh</h3>
                    <span className="metaTag mono" data-tone="ok">
                      {finalVideo.resolution} · {finalVideo.durationSec} dtk
                    </span>
                  </div>
                  <video className="videoPlayer" controls src={finalVideo.fileUrl} />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <a
                      className="btn btnPrimary"
                      href={finalVideo.fileUrl}
                      download={finalVideo.fileName || "nmcgen-episode.webm"}
                      style={{ textDecoration: "none" }}
                    >
                      Unduh Video Jadi (.webm)
                    </a>
                    <button type="button" className="btn" disabled={Boolean(busyMsg)} onClick={() => void handleDownloadFullZip()}>
                      Unduh Paket Lengkap (.zip)
                    </button>
                    <button type="button" className="btn" disabled={Boolean(busyMsg)} onClick={handleDownloadFlowMd}>
                      Unduh Prompt Google Flow (.md)
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="sectionBox">
                <h3>Monitor Antrean Tugas (Task Queue)</h3>
                {tasks.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                    Belum ada antrean berjalan. Klik &quot;Jalankan Seluruh Pipeline Toonflow&quot; untuk memantau progres tiap agen secara langsung.
                  </p>
                ) : (
                  <ul className="issueList">
                    {tasks.map((t) => (
                      <li key={t.id} className="toonflowTaskRow" data-status={t.status}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <strong style={{ fontSize: 12 }}>{t.label}</strong>
                          <span
                            className="metaTag mono"
                            data-tone={
                              t.status === "done"
                                ? "ok"
                                : t.status === "error"
                                  ? "error"
                                  : t.status === "running"
                                    ? "warn"
                                    : undefined
                            }
                          >
                            {t.status === "done"
                              ? "Selesai"
                              : t.status === "running"
                                ? "Berjalan"
                                : t.status === "error"
                                  ? "Gagal"
                                  : "Menunggu"}
                          </span>
                        </div>
                        {t.detail ? (
                          <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>{t.detail}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : null}

          {/* TAB 1: INGESTION, TEXT CLEANSING & CHAPTER SPLITTING */}
          {tab === "materi" ? (
            <div className="sectionBox">
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <h3>01. Impor Novel / Materi Cerita &amp; Pemecahan Bab</h3>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    className="btn btnSm"
                    disabled={Boolean(busyMsg)}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Unggah .TXT / .MD
                  </button>
                  <button
                    type="button"
                    className="btn btnPrimary btnSm"
                    disabled={Boolean(busyMsg)}
                    onClick={handleCleanAndSplit}
                  >
                    Bersihkan &amp; Pecah Bab
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.md,text/plain,text/markdown"
                    className="srOnly"
                    onChange={handleUploadTextFile}
                  />
                </div>
              </div>

              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="tf-premise">
                  Premis Utama Episode
                </label>
                <textarea
                  id="tf-premise"
                  className="textarea"
                  style={{ minHeight: 68 }}
                  value={sd.premise}
                  onChange={(e) => patchScript({ premise: e.target.value })}
                  placeholder="Ringkas tokoh utama, masalah, dan tujuan episode..."
                />
              </div>

              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="tf-source-text">
                  Naskah Novel / Materi Panjang (Opsional)
                </label>
                <textarea
                  id="tf-source-text"
                  className="textarea"
                  style={{ minHeight: 160 }}
                  value={sd.sourceText ?? ""}
                  onChange={(e) => patchScript({ sourceText: e.target.value })}
                  placeholder="Tempel teks novel, cerpen, atau catatan bab (pisahkan dengan Bab 1, Bab 2, atau # Judul Bab)..."
                />
              </div>

              {chapters.length > 0 ? (
                <div className="fieldGroup">
                  <span className="fieldLabel">Bab Terdeteksi ({chapters.length})</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {chapters.map((ch) => (
                      <button
                        key={ch.id}
                        type="button"
                        className="listCardBtn"
                        data-selected={sd.activeChapterId === ch.id}
                        onClick={() => patchScript({ activeChapterId: ch.id })}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", width: "100%", gap: 8 }}>
                          <strong style={{ fontSize: 13 }}>{ch.title}</strong>
                          <span className="metaTag mono">{ch.wordCount} kata</span>
                        </div>
                        <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                          {ch.content.slice(0, 140)}
                          {ch.content.length > 140 ? "..." : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                  Jika hanya memakai premis singkat tanpa novel panjang, Anda bisa langsung lanjut ke tahap 02 Event Graph.
                </p>
              )}
            </div>
          ) : null}

          {/* TAB 2: EVENT GRAPH / CAUSAL STORY OUTLINE */}
          {tab === "events" ? (
            <div className="sectionBox">
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <h3>02. Event Graph Kausal ({events.length} babak)</h3>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <button
                    type="button"
                    className="btn btnSm"
                    disabled={Boolean(busyMsg)}
                    onClick={() =>
                      patchScript({
                        eventGraph: [
                          ...events,
                          {
                            id: uid(),
                            code: `EV${String(events.length + 1).padStart(2, "0")}`,
                            stage: `Babak ${events.length + 1}`,
                            title: "Event Baru",
                            summary: "",
                            cause: "",
                            effect: "",
                            conflict: "",
                            emotion: "",
                            location: "",
                            characters: [],
                            durationSec: Math.min(sd.maxSegmentSec || 8, 8),
                          },
                        ],
                      })
                    }
                  >
                    + Event
                  </button>
                  <button
                    type="button"
                    className="btn btnPrimary btnSm"
                    disabled={Boolean(busyMsg)}
                    onClick={() =>
                      runAction("Decision Agent menyusun Event Graph...", async () => {
                        const res = await execEventGraph(projectRef.current);
                        const cnt = ensureScriptNode(res.next).data.eventGraph?.length ?? 0;
                        return `Event Graph berisi ${cnt} babak sebab-akibat selesai disusun via ${res.model || textProfile.name}.`;
                      })
                    }
                  >
                    Bangun Event Graph (AI)
                  </button>
                </div>
              </div>

              {events.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                  Belum ada Event Graph. Klik &quot;Bangun Event Graph (AI)&quot; untuk menghasilkan struktur cerita film pendek lengkap (Intro, Masalah 1, Masalah 2, Klimaks, Ending) sebelum menulis naskah.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {events.map((ev, idx) => (
                    <div key={ev.id} className="toonflowCard">
                      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                        <span className="metaTag mono">{ev.code}</span>
                        <input
                          className="input"
                          style={{ flex: "1 1 160px", minHeight: 30, padding: "4px 8px" }}
                          aria-label={`Babak ${ev.code}`}
                          value={ev.stage}
                          onChange={(e) => updateEvent(idx, { stage: e.target.value })}
                        />
                        <input
                          type="number"
                          min={4}
                          max={30}
                          className="input mono"
                          style={{ width: 64, minHeight: 30, padding: "4px 6px" }}
                          aria-label={`Durasi ${ev.code}`}
                          value={ev.durationSec}
                          onChange={(e) => updateEvent(idx, { durationSec: Math.max(4, Number(e.target.value) || 8) })}
                        />
                        <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>dtk</span>
                        <button type="button" className="btn btnGhost btnSm" disabled={idx === 0} onClick={() => moveEvent(idx, -1)}>
                          Naik
                        </button>
                        <button
                          type="button"
                          className="btn btnGhost btnSm"
                          disabled={idx === events.length - 1}
                          onClick={() => moveEvent(idx, 1)}
                        >
                          Turun
                        </button>
                        <button
                          type="button"
                          className="btn btnGhost btnSm"
                          onClick={() => patchScript({ eventGraph: events.filter((x) => x.id !== ev.id) })}
                        >
                          Hapus
                        </button>
                      </div>

                      <div className="fieldRow">
                        <input
                          className="input"
                          style={{ minHeight: 32, padding: "4px 8px" }}
                          aria-label={`Judul ${ev.code}`}
                          value={ev.title}
                          placeholder="Judul singkat event"
                          onChange={(e) => updateEvent(idx, { title: e.target.value })}
                        />
                        <input
                          className="input"
                          style={{ minHeight: 32, padding: "4px 8px" }}
                          aria-label={`Lokasi ${ev.code}`}
                          value={ev.location}
                          placeholder="Lokasi spesifik"
                          onChange={(e) => updateEvent(idx, { location: e.target.value })}
                        />
                      </div>

                      <textarea
                        className="textarea"
                        style={{ minHeight: 54 }}
                        aria-label={`Ringkasan ${ev.code}`}
                        value={ev.summary}
                        placeholder="Kejadian inti pada babak ini..."
                        onChange={(e) => updateEvent(idx, { summary: e.target.value })}
                      />

                      <div className="fieldRow">
                        <input
                          className="input"
                          style={{ minHeight: 30, padding: "4px 8px", fontSize: 12 }}
                          aria-label={`Sebab ${ev.code}`}
                          value={ev.cause}
                          placeholder="Sebab (dari babak sebelumnya)"
                          onChange={(e) => updateEvent(idx, { cause: e.target.value })}
                        />
                        <input
                          className="input"
                          style={{ minHeight: 30, padding: "4px 8px", fontSize: 12 }}
                          aria-label={`Akibat ${ev.code}`}
                          value={ev.effect}
                          placeholder="Akibat (memicu babak berikutnya)"
                          onChange={(e) => updateEvent(idx, { effect: e.target.value })}
                        />
                      </div>

                      <div className="fieldRow">
                        <input
                          className="input"
                          style={{ minHeight: 30, padding: "4px 8px", fontSize: 12 }}
                          aria-label={`Konflik ${ev.code}`}
                          value={ev.conflict}
                          placeholder="Konflik / taruhan"
                          onChange={(e) => updateEvent(idx, { conflict: e.target.value })}
                        />
                        <input
                          className="input mono"
                          style={{ minHeight: 30, padding: "4px 8px", fontSize: 12 }}
                          aria-label={`Karakter ${ev.code}`}
                          value={ev.characters.join(", ")}
                          placeholder="@Tokoh1, @Tokoh2"
                          onChange={(e) =>
                            updateEvent(idx, {
                              characters: e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                            })
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {/* TAB 3: ASSET EXTRACTION & BATCH GENERATION */}
          {tab === "assets" ? (
            <div className="sectionBox">
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <h3>03. Pustaka Aset Karakter, Lokasi &amp; Prop ({assets.length})</h3>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <button
                    type="button"
                    className="btn btnPrimary btnSm"
                    disabled={Boolean(busyMsg) || events.length === 0}
                    onClick={() =>
                      runAction("Asset Agent mengekstrak entitas dari Event Graph...", async () => {
                        const res = await execExtractAssets(projectRef.current);
                        return `Ekstraksi aset selesai: ${res.added} aset baru, ${res.updated} diperbarui.`;
                      })
                    }
                  >
                    Ekstrak Aset dari Event Graph (AI)
                  </button>
                  <button
                    type="button"
                    className="btn btnSm"
                    disabled={Boolean(busyMsg) || assets.length === 0}
                    onClick={() => handleBatchAssets(false)}
                  >
                    Batch Generate Aset Kosong
                  </button>
                  <button
                    type="button"
                    className="btn btnGhost btnSm"
                    disabled={Boolean(busyMsg) || assets.length === 0}
                    onClick={() => handleBatchAssets(true)}
                  >
                    Regenerate Semua
                  </button>
                </div>
              </div>

              {assets.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                  Belum ada aset di kanvas. Jalankan &quot;Ekstrak Aset dari Event Graph (AI)&quot; agar tokoh manusia, antagonis, dan lokasi otomatis dibuatkan Continuity Lock.
                </p>
              ) : (
                <div className="toonflowGrid">
                  {assets.map((node) => {
                    const ad = node.data as AssetNodeData;
                    return (
                      <div key={node.id} className="toonflowCard">
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                          <strong style={{ fontSize: 13 }}>{node.title}</strong>
                          <span className="metaTag mono">{ad.tag}</span>
                        </div>
                        {ad.imageDataUrl ? (
                          <img
                            src={ad.imageDataUrl}
                            alt={`Referensi ${ad.tag}`}
                            style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 4 }}
                          />
                        ) : (
                          <div className="toonflowEmptyThumb">Belum ada gambar referensi</div>
                        )}
                        <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{ad.lockPrompt}</p>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                          <span className="metaTag">{ad.category}</span>
                          <button
                            type="button"
                            className="btn btnSm"
                            disabled={Boolean(busyMsg)}
                            onClick={() =>
                              runAction(`Membuat referensi ${ad.tag}...`, async () => {
                                const res = await execGenerateOneAssetImage(projectRef.current, node.id);
                                return `Gambar referensi ${ad.tag} selesai via ${res.model || imageProfile.name}.`;
                              })
                            }
                          >
                            {ad.imageDataUrl ? "Generate Ulang" : "Generate Gambar"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          {/* TAB 4: STRUCTURED SCRIPTAGENT */}
          {tab === "script" ? (
            <div className="sectionBox">
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <h3>04. Adaptasi Naskah Terstruktur (ScriptAgent)</h3>
                <button
                  type="button"
                  className="btn btnPrimary btnSm"
                  disabled={Boolean(busyMsg) || events.length === 0}
                  onClick={() =>
                    runAction("ScriptAgent mengadaptasi Event Graph menjadi skenario...", async () => {
                      const res = await execScriptAgent(projectRef.current);
                      const cnt = ensureScriptNode(res.next).data.structuredScenes?.length ?? 0;
                      return `ScriptAgent menyusun ${cnt} adegan terstruktur via ${res.model || textProfile.name}.`;
                    })
                  }
                >
                  Adaptasi Naskah (ScriptAgent)
                </button>
              </div>

              {scenes.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                  Belum ada skenario terstruktur. Jalankan ScriptAgent untuk mengubah Event Graph menjadi adegan lengkap dengan Heading, Aksi, Dialog, Monolog Batin, dan Arahan Sutradara.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {scenes.map((sc, idx) => (
                    <div key={sc.id} className="toonflowCard">
                      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                        <span className="metaTag mono">{sc.code}</span>
                        <span className="metaTag">{sc.stage}</span>
                        {sc.emotion ? <span className="metaTag">{sc.emotion}</span> : null}
                      </div>
                      <input
                        className="input mono"
                        style={{ minHeight: 30, padding: "4px 8px", fontSize: 12 }}
                        aria-label={`Heading ${sc.code}`}
                        value={sc.heading}
                        onChange={(e) => updateScene(idx, { heading: e.target.value })}
                      />
                      <textarea
                        className="textarea"
                        style={{ minHeight: 58 }}
                        aria-label={`Aksi ${sc.code}`}
                        value={sc.action}
                        onChange={(e) => updateScene(idx, { action: e.target.value })}
                      />
                      <input
                        className="input"
                        style={{ minHeight: 32, padding: "4px 8px" }}
                        aria-label={`Dialog ${sc.code}`}
                        value={sc.dialogue}
                        placeholder="Dialog lisan (maks 12 kata)"
                        onChange={(e) => updateScene(idx, { dialogue: e.target.value })}
                      />
                      <div className="fieldRow">
                        <input
                          className="input"
                          style={{ minHeight: 30, padding: "4px 8px", fontSize: 12 }}
                          aria-label={`Monolog batin ${sc.code}`}
                          value={sc.innerThought ?? ""}
                          placeholder="Monolog batin / subteks"
                          onChange={(e) => updateScene(idx, { innerThought: e.target.value })}
                        />
                        <input
                          className="input"
                          style={{ minHeight: 30, padding: "4px 8px", fontSize: 12 }}
                          aria-label={`Arahan sutradara ${sc.code}`}
                          value={sc.directorNote ?? ""}
                          placeholder="Catatan sutradara & audio"
                          onChange={(e) => updateScene(idx, { directorNote: e.target.value })}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {/* TAB 5: STORYBOARD & BATCH KEYFRAME GENERATION */}
          {tab === "storyboard" ? (
            <div className="sectionBox">
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <h3>05. Storyboard &amp; Keyframe Segmen ({segments.length})</h3>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <button
                    type="button"
                    className="btn btnPrimary btnSm"
                    disabled={Boolean(busyMsg) || (events.length === 0 && scenes.length === 0)}
                    onClick={() =>
                      runAction("ProductionAgent menyusun storyboard dan membangun segmen...", async () => {
                        const res = await execStoryboardAndSegments(projectRef.current);
                        return `${res.count} segmen storyboard baru disusun dan disambungkan di kanvas.`;
                      })
                    }
                  >
                    Bangun Storyboard &amp; Segmen
                  </button>
                  <button
                    type="button"
                    className="btn btnSm"
                    disabled={Boolean(busyMsg) || segments.length === 0}
                    onClick={() => handleBatchKeyframes(false)}
                  >
                    Batch Keyframe Kosong
                  </button>
                  <button
                    type="button"
                    className="btn btnGhost btnSm"
                    disabled={Boolean(busyMsg) || segments.length === 0}
                    onClick={() => handleBatchKeyframes(true)}
                  >
                    Regenerate Semua
                  </button>
                </div>
              </div>

              {segments.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                  Belum ada segmen storyboard. Klik &quot;Bangun Storyboard &amp; Segmen&quot; untuk menghasilkan segmen terstruktur dengan variasi shot kamera dan ikatan aset selektif.
                </p>
              ) : (
                <div className="toonflowGrid">
                  {segments.map((node) => {
                    const seg = node.data as SegmentNodeData;
                    const adopted = getAdoptedMedia(seg);
                    const bound = getBoundAssets(project, node.id).map((a) => (a.data as AssetNodeData).tag);
                    return (
                      <div key={node.id} className="toonflowCard">
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                          <strong style={{ fontSize: 13 }}>{node.title}</strong>
                          <span className="metaTag mono">
                            {seg.shotSize} / {seg.cameraAngle}
                          </span>
                        </div>
                        {adopted?.kind === "image" ? (
                          <img
                            src={adopted.dataUrl}
                            alt={`Keyframe ${seg.code}`}
                            style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 4 }}
                          />
                        ) : (
                          <div className="toonflowEmptyThumb">Belum ada keyframe</div>
                        )}
                        <p style={{ margin: 0, fontSize: 12 }}>{seg.timelineText}</p>
                        {seg.dialogue ? (
                          <p style={{ margin: 0, fontSize: 11, color: "var(--accent-text)" }}>
                            &quot;{seg.dialogue}&quot;
                          </p>
                        ) : null}
                        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                          <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                            {bound.length ? bound.join(" ") : "Tanpa aset terikat"}
                          </span>
                          <button
                            type="button"
                            className="btn btnSm"
                            disabled={Boolean(busyMsg)}
                            onClick={() =>
                              runAction(`Membuat keyframe ${seg.code}...`, async () => {
                                const res = await execGenerateOneSegmentFrame(projectRef.current, node.id);
                                return `Keyframe ${seg.code} selesai via ${res.model || imageProfile.name}.`;
                              })
                            }
                          >
                            {adopted ? "Generate Ulang" : "Generate Keyframe"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          {/* TAB 6: SUPERVISION AGENT QC */}
          {tab === "supervision" ? (
            <div className="sectionBox">
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <h3>06. Audit Cerita &amp; Kontinuitas (SupervisionAgent)</h3>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <button
                    type="button"
                    className="btn btnPrimary btnSm"
                    disabled={Boolean(busyMsg) || segments.length === 0}
                    onClick={() =>
                      runAction("SupervisionAgent mengaudit alur cerita dan kontinuitas...", async () => {
                        const res = await execSupervisionAudit(projectRef.current);
                        return `Audit selesai dengan skor ${res.score}/100.`;
                      })
                    }
                  >
                    Audit Episode (Supervisor)
                  </button>
                  {supervision && supervision.issues.length > 0 ? (
                    <button
                      type="button"
                      className="btn btnSm"
                      disabled={Boolean(busyMsg)}
                      onClick={() => {
                        const feedback = supervision.issues
                          .map((i) => `- [${i.category}${i.segmentCode ? ` ${i.segmentCode}` : ""}] ${i.problem} -> Perbaikan: ${i.fix}`)
                          .join("\n");
                        void handleRunFullPipeline(feedback);
                      }}
                    >
                      Auto-Perbaiki dari Audit
                    </button>
                  ) : null}
                </div>
              </div>

              {!supervision ? (
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                  Belum ada laporan supervisi. Jalankan &quot;Audit Episode (Supervisor)&quot; untuk memeriksa kekuatan alur (Intro, Masalah 1, Masalah 2, Klimaks, Ending), konsistensi karakter, dan transisi visual.
                </p>
              ) : (
                <>
                  <div className="alertBox" data-tone={supervision.verdict === "siap" ? "ok" : "warn"}>
                    <strong>
                      Skor {supervision.score}/100 ({supervision.verdict === "siap" ? "Siap Produksi" : "Perlu Revisi"})
                    </strong>
                    : {supervision.summary}
                  </div>

                  {supervision.strengths.length > 0 ? (
                    <div className="fieldGroup">
                      <span className="fieldLabel">Kekuatan Cerita</span>
                      <ul className="issueList">
                        {supervision.strengths.map((s, i) => (
                          <li key={i} className="issueItem">
                            <span style={{ fontSize: 12 }}>{s}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {supervision.issues.length > 0 ? (
                    <div className="fieldGroup">
                      <span className="fieldLabel">Temuan Perbaikan ({supervision.issues.length})</span>
                      <ul className="issueList">
                        {supervision.issues.map((iss, i) => (
                          <li key={i} className="issueItem" data-severity={iss.severity === "high" ? "error" : "warn"}>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              <span className="metaTag mono">{iss.category}</span>
                              {iss.segmentCode ? <span className="metaTag mono">{iss.segmentCode}</span> : null}
                            </div>
                            <strong style={{ fontSize: 12 }}>{iss.problem}</strong>
                            <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>Saran: {iss.fix}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="alertBox" data-tone="ok">
                      Tidak ditemukan cacat alur atau lubang cerita besar.
                    </div>
                  )}
                </>
              )}
            </div>
          ) : null}
        </div>

        <div className="modalFooter">
          <button
            type="button"
            className="btn"
            disabled={Boolean(busyMsg)}
            onClick={() => {
              onClose();
              onOpenPipeline();
            }}
          >
            Lanjut ke Cek &amp; Render
          </button>
          <button type="button" className="btn btnPrimary" disabled={Boolean(busyMsg)} onClick={onClose}>
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
