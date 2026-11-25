"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AspectRatio, NmcProject, RuntimeStatus } from "@/lib/types";
import {
  DEFAULT_VISUAL_STYLE,
  matchVisualStylePreset,
  VISUAL_STYLE_PRESETS,
} from "@/lib/presets";
import { countApprovedAssets, ensureStoryboard, getStoryboardCover } from "@/lib/storyboard";
import { getProjectCover } from "@/lib/validator";
import { CheckIcon, CloseIcon, EditIcon, PlusIcon, SlidersIcon, TrashIcon } from "./Icons";

export interface ProjectMetaDraft {
  name: string;
  aspectRatio: AspectRatio;
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
  onCreateProject: (meta: ProjectMetaDraft) => Promise<void>;
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
      const sb = ensureStoryboard(p);
      const cover = getStoryboardCover(p) ?? getProjectCover(p);
      const assetCounts = countApprovedAssets(sb);
      return {
        project: p,
        sb,
        cover,
        assetCounts,
      };
    });
  }, [projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return summaries;
    return summaries.filter(({ project, sb }) => {
      return (
        project.name.toLowerCase().includes(q) ||
        sb.idea.toLowerCase().includes(q) ||
        sb.visualStyle.toLowerCase().includes(q)
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
      name: `Storyboard ${projects.length + 1}`,
      aspectRatio: "16:9",
      premise: "",
      visualStyle: DEFAULT_VISUAL_STYLE,
    });
  };

  const openEditModal = (project: NmcProject) => {
    const sb = ensureStoryboard(project);
    setFormMode("edit");
    setEditingId(project.id);
    setFormError("");
    setDraft({
      name: project.name,
      aspectRatio: sb.aspectRatio,
      premise: sb.idea,
      visualStyle: sb.visualStyle,
    });
  };

  const closeFormModal = () => {
    setFormMode(null);
    setEditingId(null);
    setFormError("");
  };

  const handleSaveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.name.trim()) {
      setFormError("Nama proyek tidak boleh kosong.");
      nameInputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setFormError("");
    try {
      if (formMode === "create") {
        await onCreateProject(draft);
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
            data-ready={Boolean(runtime?.workersAiBinding || runtime?.serverKeys.cloudflareAi)}
            title="Status Cloudflare Workers AI (FLUX.2 Klein 4B)"
          >
            {runtime === null
              ? "Mengecek AI..."
              : runtime.workersAiBinding || runtime.serverKeys.cloudflareAi
                ? "Cloudflare AI · FLUX.2 4B"
                : "Cloudflare AI (Setup Key)"}
          </span>
          <span
            className="runtimePill"
            data-ready={supabaseConnected}
            title="Status penyimpanan cloud Supabase"
          >
            {supabaseConnected ? "Cloud Sync" : "Lokal"}
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
            aria-label="Pengaturan AI"
          >
            <SlidersIcon size={14} />
            <span>Pengaturan AI</span>
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
                Storyboard Studio
              </h1>
              <p className="dashboardSub">
                Alur lurus 3 langkah: <strong>1. Ide &amp; Naskah</strong> →{" "}
                <strong>2. Aset &amp; Karakter (ACC)</strong> →{" "}
                <strong>3. Storyboard Per-Frame dengan Continue</strong>.
              </p>
            </div>

            {projects.length > 0 ? (
              <div className="dashboardControls">
                <div className="dashboardSearchWrap">
                  <label htmlFor="project-search" className="srOnly">
                    Cari proyek
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
                <h2>Memuat proyek...</h2>
                <p>Menyinkronkan proyek Storyboard dari penyimpanan cloud dan lokal.</p>
              </div>
            </section>
          ) : projects.length === 0 ? (
            <section className="dashboardEmpty" aria-label="Workspace kosong">
              <div className="emptyCard">
                <h2>Mulai Storyboard Pertama Anda</h2>
                <p>
                  Tulis ide cerita, generate naskah, kunci &amp; ACC aset karakter sesuai naskah dengan FLUX.2 Klein
                  4B, lalu susun storyboard per-frame secara berurutan.
                </p>
                <div className="emptyActions">
                  <button type="button" className="btn btnPrimary" onClick={openCreateModal}>
                    <PlusIcon size={14} />
                    <span>Buat Proyek Baru</span>
                  </button>
                  <button type="button" className="btn" onClick={() => importRef.current?.click()}>
                    Impor JSON
                  </button>
                </div>
              </div>
            </section>
          ) : filtered.length === 0 ? (
            <section className="dashboardEmpty" aria-label="Hasil pencarian kosong">
              <div className="emptyCard">
                <h2>Tidak ada proyek yang cocok</h2>
                <p>Pencarian &ldquo;{query.trim()}&rdquo; tidak menemukan proyek.</p>
                <div className="emptyActions">
                  <button type="button" className="btn" onClick={() => setQuery("")}>
                    Reset Pencarian
                  </button>
                </div>
              </div>
            </section>
          ) : (
            <div className="projectGrid">
              {filtered.map(({ project, sb, cover, assetCounts }) => {
                const styleBadge = styleLabelFor(sb.visualStyle);
                const stageLabel =
                  sb.frames.length > 0
                    ? `${sb.frames.length} Frame`
                    : assetCounts.total > 0
                      ? `Aset ${assetCounts.approved}/${assetCounts.total} ACC`
                      : sb.scriptText.trim()
                        ? "Naskah Siap"
                        : "Draft Awal";

                return (
                  <article key={project.id} className="projectCard">
                    <button
                      type="button"
                      className="projectPreviewBtn"
                      onClick={() => onOpenProject(project.id)}
                      aria-label={`Buka studio untuk ${project.name}`}
                    >
                      {cover ? (
                        <img
                          src={cover}
                          alt={`Pratinjau ${project.name}`}
                          className="projectThumbImg"
                        />
                      ) : (
                        <div className="projectSlate">
                          <div className="projectSlateTop">
                            <span className="metaTag mono">{sb.aspectRatio}</span>
                            <span className="mono projectSlateCount">{stageLabel}</span>
                          </div>
                          <div className="projectStagePips" aria-hidden="true">
                            <span className="stagePip" data-filled={Boolean(sb.scriptText.trim())}>
                              1. Naskah
                            </span>
                            <span className="stagePip" data-filled={assetCounts.approved > 0}>
                              2. Aset ACC
                            </span>
                            <span className="stagePip" data-filled={sb.frames.length > 0}>
                              3. Storyboard
                            </span>
                          </div>
                        </div>
                      )}
                    </button>

                    <div className="projectCardBody">
                      <div className="projectCardHead">
                        <h2 className="projectCardTitle">{project.name}</h2>
                        <span
                          className="metaTag"
                          data-tone={sb.frames.length > 0 ? "ok" : assetCounts.approved > 0 ? "warn" : undefined}
                        >
                          {sb.frames.length > 0 ? <CheckIcon size={11} /> : null}
                          <span>{stageLabel}</span>
                        </span>
                      </div>

                      <p className="projectCardPremise">
                        {sb.idea.trim() || sb.scriptText.trim().slice(0, 120) || "Belum ada ide cerita."}
                      </p>

                      <div className="projectCardMeta">
                        <span className="metaTag mono">{sb.aspectRatio}</span>
                        {styleBadge ? <span className="metaTag">{styleBadge}</span> : null}
                        <span className="metaTag mono">{assetCounts.approved}/{assetCounts.total} aset</span>
                      </div>

                      <p className="projectCardDate">Diubah {formatUpdatedAt(project.updatedAt)}</p>
                    </div>

                    <div className="projectCardFooter">
                      <button
                        type="button"
                        className="btn btnPrimary btnSm projectOpenBtn"
                        onClick={() => onOpenProject(project.id)}
                      >
                        Buka Studio
                      </button>
                      <button
                        type="button"
                        className="btn btnSm"
                        onClick={() => openEditModal(project)}
                        aria-label={`Edit proyek ${project.name}`}
                      >
                        <EditIcon size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn btnDanger btnSm"
                        onClick={() => setDeletingProject(project)}
                        aria-label={`Hapus proyek ${project.name}`}
                      >
                        <TrashIcon size={14} />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
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
                {formMode === "create" ? "Buat Proyek Storyboard Baru" : "Edit Info Proyek"}
              </h2>
              <button
                type="button"
                className="btn btnGhost btnIcon"
                aria-label="Tutup modal"
                onClick={closeFormModal}
              >
                <CloseIcon size={16} />
              </button>
            </div>

            <form onSubmit={(e) => void handleSaveForm(e)}>
              <div className="modalBody">
                {formError ? (
                  <div className="alertBox" data-tone="error" role="alert">
                    {formError}
                  </div>
                ) : null}

                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="dash-project-name">
                    Judul Proyek
                  </label>
                  <input
                    ref={nameInputRef}
                    id="dash-project-name"
                    className="input"
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    placeholder="Contoh: Kopi Terakhir di Stasiun"
                  />
                </div>

                <div className="fieldRow">
                  <div className="fieldGroup">
                    <label className="fieldLabel" htmlFor="dash-project-ratio">
                      Rasio Frame
                    </label>
                    <select
                      id="dash-project-ratio"
                      className="select"
                      value={draft.aspectRatio}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, aspectRatio: e.target.value as AspectRatio }))
                      }
                    >
                      <option value="16:9">16:9 Landscape</option>
                      <option value="9:16">9:16 Vertikal</option>
                    </select>
                  </div>

                  <div className="fieldGroup">
                    <label className="fieldLabel" htmlFor="dash-project-style-preset">
                      Gaya Visual
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
                      <option value="custom">Kustom</option>
                    </select>
                  </div>
                </div>

                {selectedStyleObj ? (
                  <p className="fieldHint" style={{ marginTop: -4 }}>
                    {selectedStyleObj.summary}
                  </p>
                ) : null}

                <div className="fieldGroup">
                  <label className="fieldLabel" htmlFor="dash-project-premise">
                    Ide Cerita Singkat
                  </label>
                  <textarea
                    id="dash-project-premise"
                    className="textarea"
                    style={{ minHeight: 90 }}
                    value={draft.premise}
                    onChange={(e) => setDraft((d) => ({ ...d, premise: e.target.value }))}
                    placeholder="Tulis ide cerita 1–3 kalimat, nanti langsung di-generate jadi naskah di Tahap 1..."
                  />
                </div>
              </div>

              <div className="modalFooter">
                <button type="button" className="btn" onClick={closeFormModal} disabled={submitting}>
                  Batal
                </button>
                <button type="submit" className="btn btnPrimary" disabled={submitting}>
                  {formMode === "create" ? "Buat & Mulai Naskah" : "Simpan Perubahan"}
                </button>
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
                aria-label="Tutup konfirmasi"
                onClick={() => setDeletingProject(null)}
              >
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="modalBody">
              <p style={{ margin: 0 }}>
                Hapus permanen proyek <strong>{deletingProject.name}</strong>?
              </p>
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
                <span>Ya, Hapus</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
