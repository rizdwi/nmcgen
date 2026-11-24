"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AspectRatio, NmcProject, NodeKind, RuntimeStatus } from "@/lib/types";
import {
  DEFAULT_VISUAL_STYLE,
  matchVisualStylePreset,
  NODE_META,
  VISUAL_STYLE_PRESETS,
} from "@/lib/presets";
import { getPrimaryScript, getProjectCover, validateProject } from "@/lib/validator";
import { CloseIcon, EditIcon, PlusIcon, SlidersIcon, TrashIcon } from "./Icons";

const STAGE_KINDS: NodeKind[] = ["script", "asset", "segment", "audio", "assembly", "export"];

export interface ProjectMetaDraft {
  name: string;
  aspectRatio: AspectRatio;
  maxSegmentSec: number;
  premise: string;
  visualStyle: string;
}

interface ProjectDashboardProps {
  projects: NmcProject[];
  loading: boolean;
  loadError: string;
  runtime: RuntimeStatus | null;
  supabaseConnected: boolean;
  onOpenProject: (projectId: string) => void;
  onCreateProject: (meta: ProjectMetaDraft, openAfter: boolean, autoGenerate?: boolean) => Promise<void>;
  onUpdateProjectMeta: (projectId: string, meta: ProjectMetaDraft) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
  onImportJson: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onOpenSettings: () => void;
}

function formatUpdatedAt(ts: number): string {
  try {
    return new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

function styleLabelFor(styleText: string | undefined): string {
  if (!styleText?.trim()) return "";
  const id = matchVisualStylePreset(styleText);
  const found = VISUAL_STYLE_PRESETS.find((p) => p.id === id);
  return found ? found.label : "Gaya Kustom";
}

export default function ProjectDashboard({
  projects,
  loading,
  loadError,
  runtime,
  supabaseConnected,
  onOpenProject,
  onCreateProject,
  onUpdateProjectMeta,
  onDeleteProject,
  onImportJson,
  onOpenSettings,
}: ProjectDashboardProps) {
  const [query, setQuery] = useState("");
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProjectMetaDraft>({
    name: "",
    aspectRatio: "16:9",
    maxSegmentSec: 8,
    premise: "",
    visualStyle: DEFAULT_VISUAL_STYLE,
  });
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingProject, setDeletingProject] = useState<NmcProject | null>(null);

  const importRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const summaries = useMemo(() => {
    return projects.map((p) => {
      const report = validateProject(p);
      const script = getPrimaryScript(p);
      const cover = getProjectCover(p);
      const presentKinds = new Set(p.nodes.map((n) => n.kind));
      const segmentCount = p.nodes.filter((n) => n.kind === "segment").length;
      return {
        project: p,
        report,
        script,
        cover,
        presentKinds,
        segmentCount,
      };
    });
  }, [projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return summaries;
    return summaries.filter(({ project, script }) => {
      return (
        project.name.toLowerCase().includes(q) ||
        (script?.premise || "").toLowerCase().includes(q) ||
        (script?.visualStyle || "").toLowerCase().includes(q)
      );
    });
  }, [summaries, query]);

  useEffect(() => {
    if (!formMode && !deletingProject) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFormMode(null);
        setEditingId(null);
        setDeletingProject(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [formMode, deletingProject]);

  useEffect(() => {
    if (formMode) {
      setTimeout(() => nameInputRef.current?.focus(), 20);
    }
  }, [formMode]);

  const openCreateModal = () => {
    setFormMode("create");
    setEditingId(null);
    setFormError("");
    setDraft({
      name: `Proyek ${projects.length + 1}`,
      aspectRatio: "16:9",
      maxSegmentSec: 8,
      premise: "",
      visualStyle: DEFAULT_VISUAL_STYLE,
    });
  };

  const openEditModal = (project: NmcProject) => {
    const script = getPrimaryScript(project);
    setFormMode("edit");
    setEditingId(project.id);
    setFormError("");
    setDraft({
      name: project.name,
      aspectRatio: script?.aspectRatio ?? "16:9",
      maxSegmentSec: script?.maxSegmentSec ?? 8,
      premise: script?.premise ?? "",
      visualStyle: script?.visualStyle ?? DEFAULT_VISUAL_STYLE,
    });
  };

  const closeFormModal = () => {
    setFormMode(null);
    setEditingId(null);
    setFormError("");
  };

  const handleSaveForm = async (openAfter: boolean, autoGenerate = false) => {
    if (!draft.name.trim()) {
      setFormError("Nama proyek tidak boleh kosong.");
      nameInputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setFormError("");
    try {
      if (formMode === "create") {
        await onCreateProject(draft, openAfter, autoGenerate);
      } else if (formMode === "edit" && editingId) {
        await onUpdateProjectMeta(editingId, draft);
      }
      closeFormModal();
    } catch (err) {
      setFormError(`Gagal menyimpan proyek: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingProject) return;
    setSubmitting(true);
    try {
      await onDeleteProject(deletingProject.id);
      setDeletingProject(null);
    } finally {
      setSubmitting(false);
    }
  };

  const selectedStylePresetId = matchVisualStylePreset(draft.visualStyle);
  const selectedStyleObj = VISUAL_STYLE_PRESETS.find((p) => p.id === selectedStylePresetId);

  return (
    <div className="dashboardShell">
      <header className="topBar">
        <div className="topLeft">
          <div className="brandMark" style={{ borderRight: 0, paddingRight: 0 }}>
            <span className="brandGlyph mono" aria-hidden="true">
              nG
            </span>
            <span className="brandTitle">nmcGen</span>
          </div>
          <span
            className="runtimePill"
            data-ready={supabaseConnected}
            title="Status sinkronisasi database cloud Supabase"
          >
            {supabaseConnected ? "Supabase Terhubung" : "Penyimpanan Lokal"}
          </span>
          <span
            className="runtimePill"
            data-ready={runtime?.mode === "local-hybrid" || Boolean(runtime?.workersAiBinding)}
            title="Status runtime server dan Cloudflare Workers AI"
          >
            {runtime === null
              ? "Mengecek runtime..."
              : runtime.mode === "local-hybrid"
                ? "Lokal: FFmpeg Siap"
                : runtime.workersAiBinding
                  ? "Cloudflare Workers AI"
                  : "Mode Web Hybrid"}
          </span>
        </div>

        <div className="topRight">
          <button
            type="button"
            className="btn btnSm"
            onClick={() => importRef.current?.click()}
            title="Impor file JSON proyek nmcGen"
          >
            Impor JSON
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="srOnly"
            onChange={onImportJson}
          />
          <button
            type="button"
            className="btn btnSm"
            onClick={onOpenSettings}
            aria-label="Pengaturan AI dan Runtime"
          >
            <SlidersIcon size={14} />
            <span>Pengaturan</span>
          </button>
          <button type="button" className="btn btnPrimary btnSm" onClick={openCreateModal}>
            <PlusIcon size={14} />
            <span>Proyek Baru</span>
          </button>
        </div>
      </header>

      <main className="dashboardMain">
        <div className="dashboardContainer">
          <section className="dashboardHero" aria-labelledby="dashboard-heading">
            <div className="dashboardHeroCopy">
              <h1 id="dashboard-heading" className="dashboardHeading">
                Dashboard Proyek
              </h1>
              <p className="dashboardSub">
                Pilih kartu proyek untuk masuk ke kanvas node, ubah detail dan gaya visual proyek, atau mulai
                produksi baru.
              </p>
            </div>

            {projects.length > 0 ? (
              <div className="dashboardControls">
                <div className="dashboardSearchWrap">
                  <label htmlFor="project-search" className="srOnly">
                    Cari proyek berdasarkan nama atau premis
                  </label>
                  <input
                    id="project-search"
                    type="search"
                    className="input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Cari proyek..."
                  />
                </div>
              </div>
            ) : null}
          </section>

          {loadError ? (
            <div className="alertBox" data-tone="error" role="alert">
              {loadError}
            </div>
          ) : null}

          {loading ? (
            <section className="dashboardEmpty" aria-live="polite">
              <div className="emptyCard">
                <h2>Memuat daftar proyek...</h2>
                <p>Menyinkronkan proyek nmcGen dari database Supabase dan penyimpanan lokal.</p>
              </div>
            </section>
          ) : projects.length === 0 ? (
            <section className="dashboardEmpty" aria-label="Workspace kosong">
              <div className="emptyCard">
                <h2>Belum ada proyek tersimpan</h2>
                <p>
                  Buat proyek baru, pilih gaya visual serta target Google Flow atau FFmpeg/CapCut, lalu susun
                  naskah adegan dengan AI di dalam kanvas node.
                </p>
                <div className="emptyActions">
                  <button type="button" className="btn btnPrimary" onClick={openCreateModal}>
                    <PlusIcon size={14} />
                    <span>Buat Proyek Baru</span>
                  </button>
                  <button type="button" className="btn" onClick={() => importRef.current?.click()}>
                    Impor File JSON
                  </button>
                </div>
              </div>
            </section>
          ) : filtered.length === 0 ? (
            <section className="dashboardEmpty" aria-label="Hasil pencarian kosong">
              <div className="emptyCard">
                <h2>Tidak ada proyek yang cocok</h2>
                <p>
                  Pencarian &ldquo;{query.trim()}&rdquo; tidak cocok dengan nama, premis, atau gaya visual proyek
                  mana pun.
                </p>
                <div className="emptyActions">
                  <button type="button" className="btn" onClick={() => setQuery("")}>
                    Reset Pencarian
                  </button>
                </div>
              </div>
            </section>
          ) : (
            <>
              <div className="dashboardCountRow">
                <span className="mono" style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                  Menampilkan {filtered.length} dari {projects.length} proyek
                  {supabaseConnected ? " (tersinkron ke Supabase)" : " (lokal)"}
                </span>
              </div>

              <div className="projectGrid">
                {filtered.map(({ project, report, script, cover, presentKinds, segmentCount }) => {
                  const statusTone =
                    project.nodes.length === 0
                      ? "neutral"
                      : report.ok
                        ? "ok"
                        : "error";
                  const statusLabel =
                    project.nodes.length === 0
                      ? "Kosong"
                      : report.ok
                        ? "Siap"
                        : `${report.errors.length} err`;
                  const ratio = script?.aspectRatio ?? "16:9";
                  const styleBadge = styleLabelFor(script?.visualStyle);
                  const isFlowMode = (script?.maxSegmentSec ?? 15) === 8;

                  return (
                    <article key={project.id} className="projectCard">
                      <button
                        type="button"
                        className="projectPreviewBtn"
                        onClick={() => onOpenProject(project.id)}
                        aria-label={`Buka kanvas node untuk ${project.name}`}
                      >
                        {cover ? (
                          <img
                            src={cover}
                            alt={`Pratinjau ${project.name}`}
                            width={640}
                            height={360}
                            className="projectThumbImg"
                          />
                        ) : (
                          <div className="projectSlate">
                            <div className="projectSlateTop">
                              <span className="metaTag mono">{ratio}</span>
                              <span className="mono projectSlateCount">
                                {project.nodes.length} node
                              </span>
                            </div>
                            <div className="projectStagePips" aria-hidden="true">
                              {STAGE_KINDS.map((kind) => (
                                <span
                                  key={kind}
                                  className="stagePip"
                                  data-filled={presentKinds.has(kind)}
                                >
                                  {NODE_META[kind].stage.replace(/^\d+\s+/, "")}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </button>

                      <div className="projectCardBody">
                        <div className="projectCardHead">
                          <h2 className="projectCardTitle">{project.name}</h2>
                          <span
                            className="metaTag"
                            data-tone={statusTone === "neutral" ? undefined : statusTone}
                          >
                            {statusLabel}
                          </span>
                        </div>

                        <p className="projectCardPremise">
                          {script?.premise?.trim() ||
                            "Belum ada premis naskah. Buka kanvas untuk generate naskah via AI."}
                        </p>

                        <div className="projectCardMeta">
                          <span className="metaTag mono">{ratio}</span>
                          {isFlowMode ? <span className="metaTag">Google Flow (8s)</span> : null}
                          {styleBadge ? <span className="metaTag">{styleBadge}</span> : null}
                          <span className="metaTag mono">{segmentCount} segmen</span>
                          <span className="metaTag mono">{report.totalDurationSec} dtk</span>
                        </div>

                        <p className="projectCardDate">
                          Diubah {formatUpdatedAt(project.updatedAt)}
                        </p>
                      </div>

                      <div className="projectCardFooter">
                        <button
                          type="button"
                          className="btn btnPrimary btnSm projectOpenBtn"
                          onClick={() => onOpenProject(project.id)}
                        >
                          Buka Kanvas
                        </button>
                        <button
                          type="button"
                          className="btn btnSm"
                          onClick={() => openEditModal(project)}
                          aria-label={`Edit proyek ${project.name}`}
                        >
                          <EditIcon size={14} />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          className="btn btnDanger btnSm"
                          onClick={() => setDeletingProject(project)}
                          aria-label={`Hapus proyek ${project.name}`}
                        >
                          <TrashIcon size={14} />
                          <span>Hapus</span>
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </main>

      {formMode ? (
        <div
          className="modalBackdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="project-form-title"
          onClick={closeFormModal}
        >
          <div className="modalDialog modalDialogCompact" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <h2 id="project-form-title">
                {formMode === "create" ? "Buat Proyek Baru" : "Edit Kartu Proyek"}
              </h2>
              <button
                type="button"
                className="btn btnGhost btnIcon"
                aria-label="Tutup modal proyek"
                onClick={closeFormModal}
              >
                <CloseIcon size={16} />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSaveForm(formMode === "create");
              }}
            >
              <div className="modalBody">
                {formError ? (
                  <div className="alertBox" data-tone="error" role="alert">
                    {formError}
                  </div>
                ) : null}

                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="dash-project-name">
                    Nama Proyek
                  </label>
                  <input
                    ref={nameInputRef}
                    id="dash-project-name"
                    className="input"
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    placeholder="Contoh: Film Pendek Hujan Malam"
                  />
                </div>

                <div className="fieldRow">
                  <div className="fieldGroup">
                    <label className="fieldLabel" htmlFor="dash-project-ratio">
                      Rasio Aspek
                    </label>
                    <select
                      id="dash-project-ratio"
                      className="select"
                      value={draft.aspectRatio}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, aspectRatio: e.target.value as AspectRatio }))
                      }
                    >
                      <option value="16:9">16:9 (Landscape / YouTube)</option>
                      <option value="9:16">9:16 (Vertikal / Reels / TikTok)</option>
                    </select>
                  </div>

                  <div className="fieldGroup">
                    <label className="fieldLabel" htmlFor="dash-project-engine">
                      Target Durasi / Pipeline
                    </label>
                    <select
                      id="dash-project-engine"
                      className="select"
                      value={draft.maxSegmentSec}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, maxSegmentSec: Number(e.target.value) || 8 }))
                      }
                    >
                      <option value={8}>Google Flow / Veo (8 dtk)</option>
                      <option value={15}>Seedance / Omni (15 dtk)</option>
                      <option value={30}>Segmen Panjang (30 dtk)</option>
                    </select>
                  </div>
                </div>

                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="dash-project-style-preset">
                    Pilihan Gaya Visual Proyek
                  </label>
                  <select
                    id="dash-project-style-preset"
                    className="select"
                    value={selectedStylePresetId}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "custom") return;
                      const preset = VISUAL_STYLE_PRESETS.find((p) => p.id === val);
                      if (preset) setDraft((d) => ({ ...d, visualStyle: preset.prompt }));
                    }}
                  >
                    {VISUAL_STYLE_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                    <option value="custom">Kustom (Tulis Sendiri)</option>
                  </select>
                  {selectedStyleObj ? (
                    <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                      {selectedStyleObj.summary}
                    </span>
                  ) : null}
                </div>

                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="dash-project-style">
                    Detail Prompt Gaya Visual
                  </label>
                  <input
                    id="dash-project-style"
                    className="input"
                    value={draft.visualStyle}
                    onChange={(e) => setDraft((d) => ({ ...d, visualStyle: e.target.value }))}
                    placeholder="Tulis gaya visual kustom atau pilih dari preset di atas..."
                  />
                </div>

                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="dash-project-premise">
                    Premis Singkat (Bahan Generate Naskah AI)
                  </label>
                  <textarea
                    id="dash-project-premise"
                    className="textarea"
                    value={draft.premise}
                    onChange={(e) => setDraft((d) => ({ ...d, premise: e.target.value }))}
                    placeholder="Tulis ide cerita 1 sampai 2 kalimat, lalu generate naskah adegan lengkap di dalam kanvas..."
                  />
                </div>
              </div>

              <div className="modalFooter">
                <button type="button" className="btn" onClick={closeFormModal} disabled={submitting}>
                  Batal
                </button>
                {formMode === "create" ? (
                  <>
                    <button
                      type="button"
                      className="btn"
                      disabled={submitting}
                      onClick={() => void handleSaveForm(false)}
                    >
                      Simpan di Dashboard
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={submitting}
                      onClick={() => void handleSaveForm(true, false)}
                    >
                      Buat &amp; Buka Kanvas
                    </button>
                    <button
                      type="button"
                      className="btn btnPrimary"
                      disabled={submitting}
                      onClick={() => void handleSaveForm(true, true)}
                    >
                      Buat &amp; Generate Jadi (AI)
                    </button>
                  </>
                ) : (
                  <button type="submit" className="btn btnPrimary" disabled={submitting}>
                    Simpan Perubahan
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {deletingProject ? (
        <div
          className="modalBackdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-project-title"
          onClick={() => setDeletingProject(null)}
        >
          <div className="modalDialog modalDialogCompact" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <h2 id="delete-project-title">Hapus Proyek?</h2>
              <button
                type="button"
                className="btn btnGhost btnIcon"
                aria-label="Tutup konfirmasi hapus"
                onClick={() => setDeletingProject(null)}
              >
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="modalBody">
              <p style={{ margin: 0, color: "var(--ink)" }}>
                Anda akan menghapus proyek <strong>{deletingProject.name}</strong> ({deletingProject.nodes.length} node).
              </p>
              <div className="alertBox" data-tone="warn">
                Proyek ini akan dihapus permanen dari{" "}
                {supabaseConnected ? "database Supabase dan penyimpanan lokal browser" : "penyimpanan lokal browser"}.
                Ekspor JSON terlebih dahulu bila masih ingin menyimpan cadangan.
              </div>
            </div>

            <div className="modalFooter">
              <button
                type="button"
                className="btn"
                onClick={() => setDeletingProject(null)}
                disabled={submitting}
              >
                Batal
              </button>
              <button
                type="button"
                className="btn btnDanger"
                onClick={() => void handleConfirmDelete()}
                disabled={submitting}
              >
                <TrashIcon size={14} />
                <span>Ya, Hapus Proyek</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
