"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  NmcProject,
  NmcSettings,
  RuntimeStatus,
  StoryboardData,
  StoryboardStep as StepKey,
} from "@/lib/types";
import { uid } from "@/lib/presets";
import { callAi, clipVideoDb, downloadBlob, loadSettings, projectDb, saveSettings } from "@/lib/storage";
import { cloudDb, mergeProjects } from "@/lib/supabaseSync";
import { updateProjectMeta } from "@/lib/validator";
import {
  buildExtractAssetsFromScriptPrompt,
  countApprovedAssets,
  createStoryboardProject,
  ensureStoryboard,
  formatSegmentsToScript,
  getSelectedAssetImage,
  parseExtractedStoryAssets,
  parseScriptIntoSegments,
} from "@/lib/storyboard";
import AnimateStep from "./AnimateStep";
import AssetsStep from "./AssetsStep";
import ProjectDashboard, { type ProjectMetaDraft } from "./ProjectDashboard";
import ScriptStep from "./ScriptStep";
import SettingsModal from "./SettingsModal";
import StoryboardStep from "./StoryboardStep";
import { CheckIcon, DashboardIcon, SlidersIcon } from "./Icons";

export default function NmcStudio() {
  const [screen, setScreen] = useState<"dashboard" | "studio">("dashboard");
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [supabaseConnected, setSupabaseConnected] = useState(false);
  const [settings, setSettings] = useState<NmcSettings | null>(null);
  const [projects, setProjects] = useState<NmcProject[]>([]);
  const [project, setProject] = useState<NmcProject | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [saveError, setSaveError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [stepNotice, setStepNotice] = useState("");
  const [globalBusy, setGlobalBusy] = useState("");
  const [autoAnimateSegmentId, setAutoAnimateSegmentId] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestProjectRef = useRef<NmcProject | null>(null);

  useEffect(() => {
    latestProjectRef.current = project;
  }, [project]);

  const refreshRuntime = useCallback(async () => {
    try {
      const res = await fetch("/api/runtime");
      const data = await res.json();
      if (data?.runtime) setRuntime(data.runtime);
    } catch {
      setRuntime({
        mode: "web-serverless",
        isServerless: true,
        localFfmpeg: false,
        localFfprobe: false,
        localPython: false,
        localPyCapCut: false,
        serverKeys: { cloudflareAi: false, gemini: false, geminiImage: false, openai: false },
      });
    }
  }, []);

  useEffect(() => {
    const loadedSettings = loadSettings();
    setSettings(loadedSettings);
    void refreshRuntime();

    (async () => {
      try {
        const [localList, remoteRes] = await Promise.all([
          projectDb.list().catch(() => [] as NmcProject[]),
          cloudDb.list(),
        ]);

        setSupabaseConnected(remoteRes.connected);
        if (remoteRes.error) {
          setLoadError(`Sinkronisasi cloud terkendala (${remoteRes.error}). Menampilkan data lokal.`);
        }

        const merged = mergeProjects(localList, remoteRes.projects);
        const localMap = new Map(localList.map((p) => [p.id, p]));
        for (const remote of remoteRes.projects) {
          const cur = localMap.get(remote.id);
          if (!cur || remote.updatedAt > cur.updatedAt) {
            void projectDb.put(remote).catch(() => {});
          }
        }

        const chosen = merged.find((x) => x.id === loadedSettings.lastProjectId) ?? merged[0] ?? null;
        setProjects(merged);
        setProject(chosen);
      } catch (err) {
        setLoadError(`Gagal memuat daftar proyek: ${(err as Error).message}`);
        setProjects([]);
        setProject(null);
      } finally {
        setLoadingProjects(false);
      }
    })();
  }, [refreshRuntime]);

  const updateSettings = useCallback((fn: (prev: NmcSettings) => NmcSettings) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      saveSettings(next);
      return next;
    });
  }, []);

  const persistProject = useCallback(async (next: NmcProject) => {
    await projectDb.put(next);
    const cloud = await cloudDb.put(next);
    if (cloud.connected) {
      setSupabaseConnected(true);
      if (!cloud.ok) throw new Error(cloud.error || "Gagal menyimpan ke Supabase");
    }
  }, []);

  const commitProject = useCallback(
    (updater: (prev: NmcProject) => NmcProject) => {
      setProject((prev) => {
        if (!prev) return prev;
        const next: NmcProject = { ...updater(prev), updatedAt: Date.now() };
        latestProjectRef.current = next;
        setProjects((list) => {
          const idx = list.findIndex((p) => p.id === next.id);
          if (idx === -1) return [next, ...list];
          const copy = [...list];
          copy[idx] = next;
          return copy;
        });
        setSaveState("saving");
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          persistProject(next)
            .then(() => {
              setSaveError("");
              setSaveState("saved");
            })
            .catch((err) => {
              setSaveError((err as Error).message || "Gagal menyimpan ke Supabase");
              setSaveState("error");
            });
        }, 320);
        return next;
      });
    },
    [persistProject],
  );

  const patchStoryboard = useCallback(
    (patch: Partial<StoryboardData>) => {
      commitProject((prev) => {
        const currentSb = ensureStoryboard(prev);
        return {
          ...prev,
          schemaVersion: 2,
          storyboard: { ...currentSb, ...patch },
        };
      });
    },
    [commitProject],
  );

  const flushPendingSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const latest = latestProjectRef.current;
      if (latest) {
        persistProject(latest)
          .then(() => {
            setSaveError("");
            setSaveState("saved");
          })
          .catch((err) => {
            setSaveError((err as Error).message || "Gagal menyimpan ke Supabase");
            setSaveState("error");
          });
      }
    }
  }, [persistProject]);

  const handleOpenProjectFromDashboard = (id: string) => {
    const found = projects.find((p) => p.id === id);
    if (!found) return;
    // Normalize into schema v2 storyboard cleanly on open
    const normalized: NmcProject = found.storyboard
      ? found
      : { ...found, schemaVersion: 2, storyboard: ensureStoryboard(found) };
    setProject(normalized);
    setStepNotice("");
    setScreen("studio");
    updateSettings((s) => ({ ...s, lastProjectId: normalized.id }));
  };

  const handleBackToDashboard = () => {
    flushPendingSave();
    setStepNotice("");
    setProjects((prev) => [...prev].sort((a, b) => b.updatedAt - a.updatedAt));
    setScreen("dashboard");
  };

  const handleSwitchProject = (id: string) => {
    flushPendingSave();
    const found = projects.find((p) => p.id === id);
    if (!found) return;
    const normalized: NmcProject = found.storyboard
      ? found
      : { ...found, schemaVersion: 2, storyboard: ensureStoryboard(found) };
    setProject(normalized);
    setStepNotice("");
    updateSettings((s) => ({ ...s, lastProjectId: normalized.id }));
  };

  const handleCreateProjectFromDashboard = async (meta: ProjectMetaDraft) => {
    const fresh = createStoryboardProject(meta.name.trim() || `Storyboard ${projects.length + 1}`, {
      aspectRatio: meta.aspectRatio,
      visualStyle: meta.visualStyle,
      idea: meta.premise,
    });
    await persistProject(fresh);
    setProjects((prev) => [fresh, ...prev]);
    setProject(fresh);
    setStepNotice("");
    setScreen("studio");
    updateSettings((s) => ({ ...s, lastProjectId: fresh.id }));
  };

  const handleUpdateProjectMeta = async (projectId: string, meta: ProjectMetaDraft) => {
    const target = projects.find((p) => p.id === projectId);
    if (!target) return;
    const updated = updateProjectMeta(target, meta);
    await persistProject(updated);
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? updated : p)).sort((a, b) => b.updatedAt - a.updatedAt),
    );
    if (project?.id === projectId) {
      setProject(updated);
    }
  };

  const handleDeleteProjectById = async (projectId: string) => {
    if (project?.id === projectId && saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    await Promise.all([
      projectDb.del(projectId).catch(() => {}),
      clipVideoDb.delByProject(projectId).catch(() => {}),
      cloudDb.del(projectId).catch(() => {}),
    ]);
    const remaining = projects.filter((p) => p.id !== projectId);
    setProjects(remaining);
    if (project?.id === projectId) {
      const nextProj = remaining[0] ?? null;
      setProject(nextProj);
      if (!nextProj) setScreen("dashboard");
    }
  };

  const handleExportJson = () => {
    if (!project) return;
    const safeName =
      (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") +
      ".nmcgen.json";
    downloadBlob(new Blob([JSON.stringify(project, null, 2)], { type: "application/json" }), safeName);
  };

  const handleImportJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as NmcProject;
      if (!parsed || (!Array.isArray(parsed.nodes) && !parsed.storyboard)) {
        throw new Error("Format JSON tidak sesuai proyek nmcGen.");
      }
      const importedBase: NmcProject = {
        ...parsed,
        id: uid(),
        name: parsed.name || file.name.replace(/\.json$/i, ""),
        updatedAt: Date.now(),
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
        viewport: parsed.viewport || { x: 0, y: 0, zoom: 1 },
      };
      const imported: NmcProject = {
        ...importedBase,
        schemaVersion: 2,
        storyboard: ensureStoryboard(importedBase),
      };
      await persistProject(imported).catch(() => {});
      setProjects((prev) => [imported, ...prev]);
      setProject(imported);
      setLoadError("");
    } catch (err) {
      setLoadError(`Gagal mengimpor proyek: ${(err as Error).message}`);
    } finally {
      e.target.value = "";
    }
  };

  const handleSyncDiscoveredModels = useCallback(
    (profileId: string, discovered: { textModels: string[]; imageModels: string[]; fetchedAt: number }) => {
      updateSettings((prev) => ({
        ...prev,
        profiles: prev.profiles.map((p) =>
          p.id === profileId
            ? {
                ...p,
                discoveredTextModels: discovered.textModels,
                discoveredImageModels: discovered.imageModels,
                modelsSyncedAt: discovered.fetchedAt,
              }
            : p,
        ),
      }));
    },
    [updateSettings],
  );

  if (!settings) {
    return (
      <main className="studioShell" style={{ placeItems: "center" }}>
        <p style={{ color: "var(--ink-muted)" }}>Memuat nmcGen Storyboard Studio...</p>
      </main>
    );
  }

  if (screen === "dashboard" || !project) {
    return (
      <>
        <ProjectDashboard
          projects={projects}
          loading={loadingProjects}
          loadError={loadError}
          runtime={runtime}
          supabaseConnected={supabaseConnected}
          onOpenProject={handleOpenProjectFromDashboard}
          onCreateProject={handleCreateProjectFromDashboard}
          onUpdateProjectMeta={handleUpdateProjectMeta}
          onDeleteProject={handleDeleteProjectById}
          onImportJson={handleImportJson}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <SettingsModal
          open={settingsOpen}
          settings={settings}
          runtime={runtime}
          onUpdateSettings={updateSettings}
          onRefreshRuntime={refreshRuntime}
          onClose={() => setSettingsOpen(false)}
        />
      </>
    );
  }

  const sb = ensureStoryboard(project);
  const textProfile =
    settings.profiles.find((p) => p.id === settings.textProfileId) ?? settings.profiles[0];
  const imageProfile =
    settings.profiles.find((p) => p.id === settings.imageProfileId) ?? settings.profiles[0];
  const assetCounts = countApprovedAssets(sb);

  // Strict Step 1 -> Step 2 transition: extracts ONLY assets physically present in the entire script
  const handleExtractAssetsFromScript = async () => {
    const curProj = latestProjectRef.current ?? project;
    const curSb = ensureStoryboard(curProj);
    const syncedSegments =
      curSb.segments && curSb.segments.length > 0
        ? curSb.segments
        : parseScriptIntoSegments(curSb.scriptText, [], 5);
    const fullScript = curSb.scriptText.trim() || formatSegmentsToScript(syncedSegments);
    if (!fullScript) {
      setStepNotice("Tulis atau generate naskah terlebih dahulu di Tahap 1.");
      return;
    }
    setStepNotice("");
    setGlobalBusy("Membaca seluruh naskah per-segmen & mengekstrak karakter, lokasi, dan properti yang dibutuhkan...");
    patchStoryboard({
      scriptText: fullScript,
      segments: syncedSegments,
      scriptApproved: true,
      step: "assets",
    });
    try {
      const built = buildExtractAssetsFromScriptPrompt({
        projectName: curProj.name,
        scriptText: fullScript,
        visualStyle: curSb.visualStyle,
      });
      const res = await callAi(textProfile, "text", built);
      if (res.discovered) handleSyncDiscoveredModels(textProfile.id, res.discovered);
      if (!res.ok || !res.text) {
        throw new Error(res.error || "Gagal mengekstrak aset dari naskah.");
      }
      const extracted = parseExtractedStoryAssets(res.text);
      patchStoryboard({
        scriptText: fullScript,
        segments: syncedSegments,
        scriptApproved: true,
        assets: extracted,
        assetsApproved: false,
        step: "assets",
      });
    } catch (err) {
      setStepNotice(`Ekstraksi aset gagal: ${(err as Error).message}`);
    } finally {
      setGlobalBusy("");
    }
  };

  const handleApproveAllAndGoStoryboard = () => {
    const curSb = ensureStoryboard(latestProjectRef.current ?? project);
    const updatedAssets = curSb.assets.map((a) =>
      getSelectedAssetImage(a) ? { ...a, approved: true } : a,
    );
    const anyApproved = updatedAssets.some((a) => a.approved);
    if (!anyApproved) {
      setStepNotice("Generate atau unggah gambar minimal 1 aset terlebih dahulu sebelum masuk Storyboard.");
      return;
    }
    setStepNotice("");
    patchStoryboard({
      assets: updatedAssets,
      assetsApproved: updatedAssets.every((a) => a.approved),
      step: "storyboard",
    });
  };

  const handleNavigateStep = (target: StepKey) => {
    setStepNotice("");
    if (target === "assets" && !sb.scriptText.trim()) {
      setStepNotice("Tulis atau generate naskah dulu di Tahap 1 sebelum masuk ke Aset & Karakter.");
      return;
    }
    if (target === "storyboard" && assetCounts.approved === 0 && sb.frames.length === 0) {
      setStepNotice("Generate dan beri ACC pada Aset & Karakter dulu di Tahap 2 agar Storyboard mengacu pada aset yang sudah ACC.");
      return;
    }
    if (target === "animate" && sb.frames.length === 0) {
      setStepNotice("Buat minimal 1 panel storyboard dulu di Tahap 3 sebelum menganimasikan ke Gemini / Omni 1.2.");
      return;
    }
    patchStoryboard({ step: target });
  };

  return (
    <div className="studioShell storyboardShell">
      <header className="topBar">
        <div className="topLeft">
          <button
            type="button"
            className="brandBtn"
            onClick={handleBackToDashboard}
            title="Kembali ke Dashboard Proyek"
          >
            <span className="brandGlyph mono" aria-hidden="true">
              nG
            </span>
            <h1 className="brandTitle">nmcGen</h1>
          </button>

          <button type="button" className="btn btnSm" onClick={handleBackToDashboard}>
            <DashboardIcon size={14} />
            <span>Dashboard</span>
          </button>

          <select
            aria-label="Pilih proyek"
            className="projectSelect"
            value={project.id}
            onChange={(e) => handleSwitchProject(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {/* Center: Clean 4-Step Linear Stepper */}
        <nav className="stepperNav" aria-label="Tahapan Storyboard & Animasi">
          <button
            type="button"
            className="stepperBtn"
            data-active={sb.step === "script"}
            data-done={sb.scriptApproved && Boolean(sb.scriptText.trim())}
            onClick={() => handleNavigateStep("script")}
          >
            <span className="stepperNum mono">
              {sb.scriptApproved && sb.scriptText.trim() ? <CheckIcon size={11} /> : "1"}
            </span>
            <span>Naskah</span>
          </button>

          <span className="stepperArrow" aria-hidden="true">
            →
          </span>

          <button
            type="button"
            className="stepperBtn"
            data-active={sb.step === "assets"}
            data-done={assetCounts.total > 0 && assetCounts.approved === assetCounts.total}
            onClick={() => handleNavigateStep("assets")}
          >
            <span className="stepperNum mono">
              {assetCounts.total > 0 && assetCounts.approved === assetCounts.total ? (
                <CheckIcon size={11} />
              ) : (
                "2"
              )}
            </span>
            <span>
              Aset &amp; Karakter
              {assetCounts.total > 0 ? ` (${assetCounts.approved}/${assetCounts.total})` : ""}
            </span>
          </button>

          <span className="stepperArrow" aria-hidden="true">
            →
          </span>

          <button
            type="button"
            className="stepperBtn"
            data-active={sb.step === "storyboard"}
            data-done={sb.frames.length > 0 && sb.frames.every((f) => f.approved)}
            data-locked={assetCounts.approved === 0 && sb.frames.length === 0}
            onClick={() => handleNavigateStep("storyboard")}
          >
            <span className="stepperNum mono">3</span>
            <span>Storyboard{sb.frames.length > 0 ? ` (${sb.frames.length})` : ""}</span>
          </button>

          <span className="stepperArrow" aria-hidden="true">
            →
          </span>

          <button
            type="button"
            className="stepperBtn"
            data-active={sb.step === "animate"}
            data-done={Boolean(sb.animationClips?.some((c) => c.status === "ready"))}
            data-locked={sb.frames.length === 0}
            onClick={() => handleNavigateStep("animate")}
          >
            <span className="stepperNum mono">4</span>
            <span>Animasi</span>
          </button>
        </nav>

        <div className="topRight">
          <span className="saveStateText" aria-live="polite" title={saveError || undefined}>
            {saveState === "saving"
              ? "Menyimpan..."
              : saveState === "error"
                ? "Gagal sinkron"
                : supabaseConnected
                  ? "Tersimpan"
                  : "Lokal"}
          </span>
          <button type="button" className="btn btnGhost btnSm" onClick={handleExportJson} title="Backup JSON proyek">
            JSON
          </button>
          <button
            type="button"
            className="btn btnSm"
            onClick={() => setSettingsOpen(true)}
            aria-label="Pengaturan AI"
          >
            <SlidersIcon size={14} />
            <span>{imageProfile.kind === "CloudflareAI" ? "Cloudflare 4B" : imageProfile.name}</span>
          </button>
        </div>
      </header>

      <main className="studioMainScroll">
        {loadError ? (
          <div className="stepNoticeWrap">
            <div className="alertBox" data-tone="error" role="alert">
              {loadError}
            </div>
          </div>
        ) : null}

        {saveState === "error" && saveError ? (
          <div className="stepNoticeWrap">
            <div className="alertBox" data-tone="error" role="alert">
              Gagal sinkron: {saveError}
            </div>
          </div>
        ) : null}

        {stepNotice ? (
          <div className="stepNoticeWrap">
            <div className="alertBox" data-tone="warn" role="alert">
              {stepNotice}
            </div>
          </div>
        ) : null}

        {sb.step === "script" ? (
          <ScriptStep
            projectName={project.name}
            sb={sb}
            textProfile={textProfile}
            onRenameProject={(name) => commitProject((prev) => ({ ...prev, name }))}
            onPatchSb={patchStoryboard}
            onSyncDiscoveredModels={handleSyncDiscoveredModels}
            onApproveAndExtractAssets={handleExtractAssetsFromScript}
            onGoToAssets={() => patchStoryboard({ step: "assets" })}
            onOpenSettings={() => setSettingsOpen(true)}
            externalBusy={globalBusy}
          />
        ) : null}

        {sb.step === "assets" ? (
          <AssetsStep
            projectName={project.name}
            sb={sb}
            textProfile={textProfile}
            imageProfile={imageProfile}
            onPatchSb={patchStoryboard}
            onSyncDiscoveredModels={handleSyncDiscoveredModels}
            onReExtractAssets={handleExtractAssetsFromScript}
            onApproveAllAndGoStoryboard={handleApproveAllAndGoStoryboard}
            onOpenSettings={() => setSettingsOpen(true)}
            externalBusy={globalBusy}
          />
        ) : null}

        {sb.step === "storyboard" ? (
          <StoryboardStep
            project={project}
            sb={sb}
            textProfile={textProfile}
            imageProfile={imageProfile}
            onPatchSb={patchStoryboard}
            onSyncDiscoveredModels={handleSyncDiscoveredModels}
            onGoToAnimate={() => {
              setAutoAnimateSegmentId(null);
              patchStoryboard({ step: "animate" });
            }}
            onAnimateSegment={(segmentId) => {
              setAutoAnimateSegmentId(segmentId);
              patchStoryboard({ step: "animate" });
            }}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : null}

        {sb.step === "animate" ? (
          <AnimateStep
            project={project}
            sb={sb}
            runtime={runtime}
            profiles={settings.profiles}
            autoAnimateSegmentId={autoAnimateSegmentId}
            onConsumeAutoAnimate={() => setAutoAnimateSegmentId(null)}
            onPatchSb={patchStoryboard}
            onBackToStoryboard={() => {
              setAutoAnimateSegmentId(null);
              patchStoryboard({ step: "storyboard" });
            }}
          />
        ) : null}
      </main>

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        runtime={runtime}
        onUpdateSettings={updateSettings}
        onRefreshRuntime={refreshRuntime}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
