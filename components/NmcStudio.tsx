"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CanvasNode,
  NmcProject,
  NmcSettings,
  NodeKind,
  RenderReceipt,
  RuntimeStatus,
  ScriptNodeData,
  SegmentNodeData,
} from "@/lib/types";
import {
  canConnect,
  createDefaultNode,
  createEmptyProject,
  createSampleProject,
  NODE_META,
  uid,
} from "@/lib/presets";
import { downloadBlob, loadSettings, projectDb, saveSettings } from "@/lib/storage";
import { autoArrangeNodes, updateProjectMeta, validateProject } from "@/lib/validator";
import CanvasBoard from "./CanvasBoard";
import InspectorDrawer from "./InspectorDrawer";
import PipelineModal from "./PipelineModal";
import ProjectDashboard, { type ProjectMetaDraft } from "./ProjectDashboard";
import SettingsModal from "./SettingsModal";
import { CheckIcon, DashboardIcon, NodeKindIcon, PlusIcon, SlidersIcon } from "./Icons";

const STAGE_ORDER: NodeKind[] = ["script", "asset", "segment", "audio", "assembly", "export"];
const SEEDED_KEY = "nmcgen.seeded";

export default function NmcStudio() {
  const [screen, setScreen] = useState<"dashboard" | "studio">("dashboard");
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [settings, setSettings] = useState<NmcSettings | null>(null);
  const [projects, setProjects] = useState<NmcProject[]>([]);
  const [project, setProject] = useState<NmcProject | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"canvas" | "list">("canvas");
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [loadError, setLoadError] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
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
        serverKeys: { gemini: false, geminiImage: false, openai: false },
      });
    }
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setViewMode("list");
    }
    const loadedSettings = loadSettings();
    setSettings(loadedSettings);
    void refreshRuntime();

    (async () => {
      try {
        const list = await projectDb.list();
        const alreadySeeded = typeof window !== "undefined" && localStorage.getItem(SEEDED_KEY) === "1";
        if (list.length === 0 && !alreadySeeded) {
          const sample = createSampleProject();
          await projectDb.put(sample);
          try {
            localStorage.setItem(SEEDED_KEY, "1");
          } catch {
            // ignore storage quota errors
          }
          setProjects([sample]);
          setProject(sample);
          setSelectedNodeId(sample.nodes[0]?.id ?? null);
        } else {
          const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
          const chosen = sorted.find((x) => x.id === loadedSettings.lastProjectId) ?? sorted[0] ?? null;
          setProjects(sorted);
          setProject(chosen);
          setSelectedNodeId(chosen?.nodes[0]?.id ?? null);
        }
      } catch (err) {
        setLoadError(`Gagal memuat database lokal browser: ${(err as Error).message}`);
        const fallback = createSampleProject();
        setProjects([fallback]);
        setProject(fallback);
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

  const commitProject = useCallback((updater: (prev: NmcProject) => NmcProject) => {
    setProject((prev) => {
      if (!prev) return prev;
      const next: NmcProject = { ...updater(prev), updatedAt: Date.now() };
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
        projectDb
          .put(next)
          .then(() => setSaveState("saved"))
          .catch(() => setSaveState("error"));
      }, 260);
      return next;
    });
  }, []);

  const report = useMemo(() => (project ? validateProject(project) : null), [project]);

  const issuesByNode = useMemo(() => {
    const map = new Map<string, NonNullable<typeof report>["errors"]>();
    if (!report) return map;
    for (const issue of [...report.errors, ...report.warnings]) {
      if (!issue.nodeId) continue;
      const arr = map.get(issue.nodeId) ?? [];
      arr.push(issue);
      map.set(issue.nodeId, arr);
    }
    return map;
  }, [report]);

  const flushPendingSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const latest = latestProjectRef.current;
      if (latest) {
        projectDb
          .put(latest)
          .then(() => setSaveState("saved"))
          .catch(() => setSaveState("error"));
      }
    }
  }, []);

  const handleOpenProjectFromDashboard = (id: string) => {
    const found = projects.find((p) => p.id === id);
    if (!found) return;
    setProject(found);
    setSelectedNodeId(found.nodes[0]?.id ?? null);
    setSelectedEdgeId(null);
    setScreen("studio");
    updateSettings((s) => ({ ...s, lastProjectId: found.id }));
  };

  const handleBackToDashboard = () => {
    flushPendingSave();
    setPipelineOpen(false);
    setSelectedEdgeId(null);
    setProjects((prev) => [...prev].sort((a, b) => b.updatedAt - a.updatedAt));
    setScreen("dashboard");
  };

  const handleSwitchProject = (id: string) => {
    flushPendingSave();
    const found = projects.find((p) => p.id === id);
    if (!found) return;
    setProject(found);
    setSelectedNodeId(found.nodes[0]?.id ?? null);
    setSelectedEdgeId(null);
    updateSettings((s) => ({ ...s, lastProjectId: found.id }));
  };

  const handleNewProject = async () => {
    flushPendingSave();
    const fresh = createEmptyProject(`Proyek ${projects.length + 1}`);
    await projectDb.put(fresh).catch(() => {});
    setProjects((prev) => [fresh, ...prev]);
    setProject(fresh);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    updateSettings((s) => ({ ...s, lastProjectId: fresh.id }));
  };

  const handleCreateProjectFromDashboard = async (meta: ProjectMetaDraft, openAfter: boolean) => {
    const base = createEmptyProject(meta.name.trim() || `Proyek ${projects.length + 1}`);
    const fresh = updateProjectMeta(base, meta);
    await projectDb.put(fresh);
    setProjects((prev) => [fresh, ...prev]);
    if (openAfter) {
      setProject(fresh);
      setSelectedNodeId(fresh.nodes[0]?.id ?? null);
      setSelectedEdgeId(null);
      setScreen("studio");
      updateSettings((s) => ({ ...s, lastProjectId: fresh.id }));
    }
  };

  const handleCreateSampleProject = async () => {
    const sample = { ...createSampleProject(), id: uid(), updatedAt: Date.now() };
    await projectDb.put(sample).catch(() => {});
    setProjects((prev) => [sample, ...prev]);
  };

  const handleUpdateProjectMeta = async (projectId: string, meta: ProjectMetaDraft) => {
    const target = projects.find((p) => p.id === projectId);
    if (!target) return;
    const updated = updateProjectMeta(target, meta);
    await projectDb.put(updated);
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
    try {
      localStorage.setItem(SEEDED_KEY, "1");
    } catch {
      // ignore storage errors
    }
    await projectDb.del(projectId).catch(() => {});
    const remaining = projects.filter((p) => p.id !== projectId);
    setProjects(remaining);
    if (project?.id === projectId) {
      const nextProj = remaining[0] ?? null;
      setProject(nextProj);
      setSelectedNodeId(nextProj?.nodes[0]?.id ?? null);
      setSelectedEdgeId(null);
      if (!nextProj) setScreen("dashboard");
    }
  };

  const handleLoadSampleIntoCurrent = () => {
    const sample = createSampleProject();
    commitProject((prev) => ({
      ...sample,
      id: prev.id,
      name: prev.name === "Proyek Baru" ? sample.name : prev.name,
    }));
    setSelectedNodeId(sample.nodes[0]?.id ?? null);
  };

  const handleExportJson = () => {
    if (!project) return;
    const safeName =
      (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") + ".nmcgen.json";
    downloadBlob(new Blob([JSON.stringify(project, null, 2)], { type: "application/json" }), safeName);
  };

  const handleImportJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as NmcProject;
      if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
        throw new Error("Format JSON tidak sesuai skema proyek nmcGen.");
      }
      const imported: NmcProject = {
        ...parsed,
        id: uid(),
        name: parsed.name || file.name.replace(/\.json$/i, ""),
        updatedAt: Date.now(),
        viewport: parsed.viewport || { x: 40, y: 40, zoom: 0.85 },
      };
      await projectDb.put(imported).catch(() => {});
      setProjects((prev) => [imported, ...prev]);
      setProject(imported);
      setSelectedNodeId(imported.nodes[0]?.id ?? null);
      setLoadError("");
    } catch (err) {
      setLoadError(`Gagal mengimpor proyek: ${(err as Error).message}`);
    } finally {
      e.target.value = "";
    }
  };

  const handleAddNode = (kind: NodeKind) => {
    if (!project) return;
    const sameKindCount = project.nodes.filter((n) => n.kind === kind).length;
    const baseCol: Record<NodeKind, number> = {
      script: 40,
      asset: 380,
      segment: 750,
      audio: 750,
      assembly: 1130,
      export: 1470,
    };
    const x = baseCol[kind];
    const y = 40 + sameKindCount * 210;
    const created = createDefaultNode(kind, x, y, sameKindCount + 1);
    commitProject((prev) => ({
      ...prev,
      nodes: [...prev.nodes, created],
    }));
    setSelectedNodeId(created.id);
  };

  const handleMoveNode = useCallback(
    (id: string, x: number, y: number) => {
      commitProject((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
      }));
    },
    [commitProject],
  );

  const handleConnect = useCallback(
    (sourceId: string, targetId: string) => {
      commitProject((prev) => {
        if (sourceId === targetId) return prev;
        const src = prev.nodes.find((n) => n.id === sourceId);
        const dst = prev.nodes.find((n) => n.id === targetId);
        if (!src || !dst || !canConnect(src.kind, dst.kind)) return prev;
        if (prev.edges.some((e) => e.source === sourceId && e.target === targetId)) return prev;
        return {
          ...prev,
          edges: [...prev.edges, { id: uid(), source: sourceId, target: targetId }],
        };
      });
    },
    [commitProject],
  );

  const handleDeleteEdge = useCallback(
    (edgeId: string) => {
      commitProject((prev) => ({
        ...prev,
        edges: prev.edges.filter((e) => e.id !== edgeId),
      }));
      setSelectedEdgeId((prev) => (prev === edgeId ? null : prev));
    },
    [commitProject],
  );

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      commitProject((prev) => ({
        ...prev,
        nodes: prev.nodes.filter((n) => n.id !== nodeId),
        edges: prev.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      }));
      setSelectedNodeId((prev) => (prev === nodeId ? null : prev));
    },
    [commitProject],
  );

  const handleSyncBeatsToSegments = useCallback(
    (scriptNodeId: string) => {
      commitProject((prev) => {
        const scriptNode = prev.nodes.find((n) => n.id === scriptNodeId);
        if (!scriptNode || scriptNode.data.kind !== "script") return prev;
        const sd = scriptNode.data as ScriptNodeData;
        if (!sd.beats.length) return prev;

        const maxDur = Math.max(4, sd.maxSegmentSec || 15);
        const groups: typeof sd.beats[] = [];
        let cur: typeof sd.beats = [];
        let curDur = 0;

        for (const beat of sd.beats) {
          const bDur = Math.max(1, beat.durationSec || 4);
          if (cur.length > 0 && curDur + bDur > maxDur) {
            groups.push(cur);
            cur = [beat];
            curDur = bDur;
          } else {
            cur.push(beat);
            curDur += bDur;
          }
        }
        if (cur.length) groups.push(cur);

        const existingCount = prev.nodes.filter((n) => n.kind === "segment").length;
        const assets = prev.nodes.filter((n) => n.kind === "asset");
        let asmNode = prev.nodes.find((n) => n.kind === "assembly");
        const addedNodes: CanvasNode[] = [];
        const addedEdges = [...prev.edges];

        if (!asmNode) {
          asmNode = createDefaultNode("assembly", 1130, 180, 1);
          addedNodes.push(asmNode);
        }

        groups.forEach((grp, idx) => {
          const segNum = existingCount + idx + 1;
          const totalSec = grp.reduce((s, b) => s + (b.durationSec || 4), 0);
          let cursor = 0;
          const tlLines = grp.map((b) => {
            const start = cursor;
            cursor += b.durationSec || 4;
            return `[0:${String(start).padStart(2, "0")}-0:${String(cursor).padStart(2, "0")}] ${b.summary}`;
          });
          const dialogue = grp.map((b) => b.dialogue.trim()).filter(Boolean).join(" ");
          const node = createDefaultNode("segment", 750, 48 + (segNum - 1) * 250, segNum);
          node.title = `Segmen G${String(segNum).padStart(2, "0")}`;
          node.data = {
            ...(node.data as SegmentNodeData),
            code: `G${String(segNum).padStart(2, "0")}`,
            durationSec: Math.min(maxDur, totalSec),
            shotSize: idx % 2 === 0 ? "MS" : "CU",
            cameraAngle: idx % 2 === 0 ? "Front" : "Side 90",
            cameraMotion: idx % 2 === 0 ? "Push-In" : "Pull-Out",
            timelineText: tlLines.join("\n"),
            dialogue,
          };
          addedNodes.push(node);
          for (const asset of assets) {
            addedEdges.push({ id: uid(), source: asset.id, target: node.id });
          }
          addedEdges.push({ id: uid(), source: node.id, target: asmNode!.id });
        });

        return {
          ...prev,
          nodes: [...prev.nodes, ...addedNodes],
          edges: addedEdges,
        };
      });
    },
    [commitProject],
  );

  const handleSaveReceipt = useCallback(
    (receipt: RenderReceipt) => {
      commitProject((prev) => {
        const hasExp = prev.nodes.some((n) => n.kind === "export");
        if (!hasExp) return prev;
        return {
          ...prev,
          nodes: prev.nodes.map((n) =>
            n.data.kind === "export"
              ? { ...n, data: { ...n.data, lastRender: receipt } }
              : n,
          ),
        };
      });
    },
    [commitProject],
  );

  if (!settings) {
    return (
      <main className="studioShell" style={{ placeItems: "center" }}>
        <p style={{ color: "var(--ink-muted)" }}>Memuat ruang kerja nmcGen...</p>
      </main>
    );
  }

  if (screen === "dashboard" || !project || !report) {
    return (
      <>
        <ProjectDashboard
          projects={projects}
          loading={loadingProjects}
          loadError={loadError}
          runtime={runtime}
          onOpenProject={handleOpenProjectFromDashboard}
          onCreateProject={handleCreateProjectFromDashboard}
          onCreateSampleProject={handleCreateSampleProject}
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

  const selectedNode = project.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const textProfile =
    settings.profiles.find((p) => p.id === settings.textProfileId) ?? settings.profiles[0];
  const imageProfile =
    settings.profiles.find((p) => p.id === settings.imageProfileId) ?? settings.profiles[0];

  return (
    <div className="studioShell">
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

          <button
            type="button"
            className="btn btnSm"
            onClick={handleBackToDashboard}
            title="Kembali ke daftar kartu proyek"
          >
            <DashboardIcon size={14} />
            <span>Dashboard</span>
          </button>

          <div className="projectSelectWrap">
            <label htmlFor="project-select" className="srOnly">
              Pilih proyek
            </label>
            <select
              id="project-select"
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
            <button type="button" className="btn btnSm" onClick={handleNewProject} title="Buat proyek kosong baru">
              <PlusIcon size={13} />
              <span>Baru</span>
            </button>
            <button
              type="button"
              className="btn btnGhost btnSm"
              onClick={handleExportJson}
              title="Ekspor file JSON proyek"
            >
              JSON
            </button>
            <button
              type="button"
              className="btn btnGhost btnSm"
              onClick={() => importRef.current?.click()}
              title="Impor file JSON proyek"
            >
              Impor
            </button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              className="srOnly"
              onChange={handleImportJson}
            />
          </div>
        </div>

        <nav className="topCenter" aria-label="Mode tampilan">
          <div className="segToggle" role="group" aria-label="Pilih tampilan kanvas atau daftar alur">
            <button
              type="button"
              className="segBtn"
              aria-pressed={viewMode === "canvas"}
              onClick={() => setViewMode("canvas")}
            >
              Kanvas
            </button>
            <button
              type="button"
              className="segBtn"
              aria-pressed={viewMode === "list"}
              onClick={() => setViewMode("list")}
            >
              Alur List
            </button>
          </div>

          <span
            className="runtimePill"
            data-ready={runtime?.mode === "local-hybrid"}
            title="Status mesin render FFmpeg & Python saat ini"
          >
            {runtime === null
              ? "Mengecek runtime..."
              : runtime.mode === "local-hybrid"
                ? "Lokal: FFmpeg Siap"
                : "Mode Web Hybrid"}
          </span>
        </nav>

        <div className="topRight">
          <span style={{ fontSize: 12, color: "var(--ink-muted)" }} aria-live="polite">
            {saveState === "saving" ? "Menyimpan..." : saveState === "error" ? "Gagal simpan" : "Tersimpan"}
          </span>
          <button
            type="button"
            className="btn btnSm"
            onClick={() => setSettingsOpen(true)}
            aria-label="Pengaturan AI dan Runtime"
          >
            <SlidersIcon size={14} />
            <span>Pengaturan</span>
          </button>
          <button
            type="button"
            className="btn btnPrimary btnSm"
            onClick={() => setPipelineOpen(true)}
          >
            <CheckIcon size={14} />
            <span>
              Cek &amp; Render ({report.errors.length > 0 ? `${report.errors.length} err` : `${report.totalDurationSec}s`})
            </span>
          </button>
        </div>
      </header>

      {loadError ? (
        <div className="alertBox" data-tone="error" role="alert" style={{ margin: "8px 14px 0" }}>
          {loadError}
        </div>
      ) : null}

      <main className="workspaceGrid" data-inspector-open={Boolean(selectedNode)}>
        {viewMode === "canvas" ? (
          <CanvasBoard
            project={project}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            issuesByNode={issuesByNode}
            onSelectNode={setSelectedNodeId}
            onSelectEdge={setSelectedEdgeId}
            onMoveNode={handleMoveNode}
            onConnect={handleConnect}
            onDeleteEdge={handleDeleteEdge}
            onViewportChange={(viewport) => commitProject((prev) => ({ ...prev, viewport }))}
            onAddNode={handleAddNode}
            onAutoArrange={() => commitProject((prev) => ({ ...prev, nodes: autoArrangeNodes(prev) }))}
            onLoadSample={handleLoadSampleIntoCurrent}
          />
        ) : (
          <div className="listStage" role="region" aria-label="Daftar tahap produksi nmcGen">
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 200px" }}>
                <label htmlFor="proj-name-inline" className="srOnly">
                  Nama proyek
                </label>
                <input
                  id="proj-name-inline"
                  className="input"
                  value={project.name}
                  onChange={(e) => commitProject((prev) => ({ ...prev, name: e.target.value }))}
                />
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {project.nodes.length === 0 ? (
                  <button type="button" className="btn btnPrimary btnSm" onClick={handleLoadSampleIntoCurrent}>
                    Muat Contoh Raka &amp; Dina
                  </button>
                ) : null}
                <button type="button" className="btn btnSm" onClick={handleBackToDashboard}>
                  <DashboardIcon size={14} />
                  <span>Kelola di Dashboard</span>
                </button>
              </div>
            </div>

            {STAGE_ORDER.map((kind) => {
              const stageNodes = project.nodes.filter((n) => n.kind === kind);
              return (
                <section key={kind} className="stageSection">
                  <div className="stageHeading">
                    <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <NodeKindIcon kind={kind} size={15} />
                      <span>
                        {NODE_META[kind].stage}: {NODE_META[kind].label}
                      </span>
                    </h2>
                    <button type="button" className="btn btnSm" onClick={() => handleAddNode(kind)}>
                      + Tambah
                    </button>
                  </div>
                  {stageNodes.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                      Belum ada node pada tahap ini. Klik + Tambah untuk membuatnya.
                    </p>
                  ) : (
                    <div className="listCards">
                      {stageNodes.map((n) => {
                        const nodeIssues = issuesByNode.get(n.id) ?? [];
                        return (
                          <button
                            key={n.id}
                            type="button"
                            className="listCardBtn"
                            data-selected={selectedNodeId === n.id}
                            onClick={() => setSelectedNodeId(n.id)}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, width: "100%" }}>
                              <strong style={{ fontSize: 13 }}>{n.title}</strong>
                              {nodeIssues.length > 0 ? (
                                <span
                                  className="metaTag"
                                  data-tone={nodeIssues.some((i) => i.severity === "error") ? "error" : "warn"}
                                >
                                  {nodeIssues.length} cek
                                </span>
                              ) : (
                                <span className="metaTag" data-tone="ok">
                                  Siap
                                </span>
                              )}
                            </div>
                            <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                              {NODE_META[n.kind].hint}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}

        {selectedNode ? (
          <InspectorDrawer
            project={project}
            node={selectedNode}
            textProfile={textProfile}
            imageProfile={imageProfile}
            runtime={runtime}
            onUpdateNode={(nodeId, updater) =>
              commitProject((prev) => ({
                ...prev,
                nodes: prev.nodes.map((n) => (n.id === nodeId ? updater(n) : n)),
              }))
            }
            onDeleteNode={handleDeleteNode}
            onConnect={handleConnect}
            onDeleteEdge={handleDeleteEdge}
            onSyncBeatsToSegments={handleSyncBeatsToSegments}
            onOpenPipeline={() => setPipelineOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onClose={() => setSelectedNodeId(null)}
          />
        ) : null}
      </main>

      <PipelineModal
        open={pipelineOpen}
        project={project}
        report={report}
        runtime={runtime}
        onSelectNode={(nodeId) => setSelectedNodeId(nodeId)}
        onSaveReceipt={handleSaveReceipt}
        onClose={() => setPipelineOpen(false)}
      />

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
