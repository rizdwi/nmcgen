"use client";
import React, { useEffect, useState } from "react";
import type { ExportNodeData, NmcProject, RenderReceipt, RuntimeStatus, ValidationReport } from "@/lib/types";
import { buildGoogleFlowGuide, buildOfflineBundleZip } from "@/lib/bundle";
import { renderBrowserWebm } from "@/lib/browserExport";
import { downloadBlob } from "@/lib/storage";
import { CheckIcon, CloseIcon } from "./Icons";

interface PipelineModalProps {
  open: boolean;
  project: NmcProject;
  report: ValidationReport;
  runtime: RuntimeStatus | null;
  onSelectNode: (nodeId: string) => void;
  onSaveReceipt: (receipt: RenderReceipt) => void;
  onClose: () => void;
}

export default function PipelineModal({
  open,
  project,
  report,
  runtime,
  onSelectNode,
  onSaveReceipt,
  onClose,
}: PipelineModalProps) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<RenderReceipt | null>(null);
  const [draftsDir, setDraftsDir] = useState("");
  const [draftName, setDraftName] = useState("");
  const [flowNotice, setFlowNotice] = useState("");

  useEffect(() => {
    if (!open) return;
    const exp = project.nodes.find((n) => n.kind === "export");
    const savedDir = exp?.data.kind === "export" ? (exp.data as ExportNodeData).capcutDraftsDir : "";
    setDraftsDir(savedDir || runtime?.defaultCapCutDir || "");
    setDraftName(
      project.name.replace(/[<>:"/\\|?*]/g, "_").slice(0, 48) || "nmcGen_Draft",
    );
    setError("");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, project, runtime, onClose]);

  if (!open) return null;

  const handleLocalFfmpeg = async () => {
    setBusy("Merender MP4 dengan FFmpeg lokal...");
    setError("");
    try {
      const res = await fetch("/api/pipeline/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Render FFmpeg lokal gagal.");
        return;
      }
      const receipt: RenderReceipt = {
        engine: "ffmpeg-local",
        fileUrl: data.fileUrl,
        fileName: data.fileName,
        durationSec: data.durationSec,
        sizeBytes: data.sizeBytes,
        resolution: data.resolution,
        verifiedAt: Date.now(),
        note: "MP4 berhasil dirender dan diverifikasi ffprobe di mesin lokal.",
      };
      setResult(receipt);
      onSaveReceipt(receipt);
    } catch (err) {
      setError(`Gagal menghubungi server render: ${(err as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const handleLocalCapCut = async () => {
    setBusy("Menyusun Draft CapCut via pyCapCut...");
    setError("");
    try {
      const res = await fetch("/api/pipeline/capcut", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, draftsDir, draftName }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Gagal membuat Draft CapCut.");
        return;
      }
      const receipt: RenderReceipt = {
        engine: "capcut-local",
        draftPath: data.draft_path,
        durationSec: data.duration_sec,
        verifiedAt: Date.now(),
        note: data.note || "Draft CapCut berhasil dibuat. Buka CapCut Desktop untuk Export manual.",
      };
      setResult(receipt);
      onSaveReceipt(receipt);
    } catch (err) {
      setError(`Gagal membuat Draft CapCut: ${(err as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const handleBrowserWebm = async () => {
    setBusy("Menyiapkan render WebM di browser...");
    setError("");
    try {
      const out = await renderBrowserWebm(project, (pct, label) => setBusy(`${label} (${pct}%)`));
      const url = URL.createObjectURL(out.blob);
      const safeName =
        (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") + ".webm";
      const receipt: RenderReceipt = {
        engine: "browser-webm",
        fileUrl: url,
        fileName: safeName,
        durationSec: out.durationSec,
        sizeBytes: out.blob.size,
        resolution: out.resolution,
        verifiedAt: Date.now(),
        note: "Video WebM dirender langsung di browser (tanpa FFmpeg server).",
      };
      setResult(receipt);
      onSaveReceipt(receipt);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const handleDownloadBundle = async () => {
    setBusy("Menyiapkan Bundle ZIP (skrip FFmpeg + pyCapCut + media + SRT)...");
    setError("");
    try {
      const [renderRes, capcutRes] = await Promise.all([
        fetch("/scripts/render_ffmpeg.py"),
        fetch("/scripts/build_capcut_draft.py"),
      ]);
      const renderPy = renderRes.ok ? await renderRes.text() : "";
      const capcutPy = capcutRes.ok ? await capcutRes.text() : "";
      const zipBytes = buildOfflineBundleZip(project, renderPy, capcutPy);
      const safeName =
        (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") + "-bundle.zip";
      const copy = new Uint8Array(zipBytes.byteLength);
      copy.set(zipBytes);
      downloadBlob(new Blob([copy], { type: "application/zip" }), safeName);
      const receipt: RenderReceipt = {
        engine: "bundle-zip",
        fileName: safeName,
        sizeBytes: zipBytes.byteLength,
        verifiedAt: Date.now(),
        note: "Bundle ZIP diunduh. Ekstrak di PC Anda lalu jalankan run_ffmpeg.bat atau run_capcut.bat.",
      };
      setResult(receipt);
      onSaveReceipt(receipt);
    } catch (err) {
      setError(`Gagal membangun Bundle ZIP: ${(err as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const handleCopyGoogleFlow = async () => {
    setFlowNotice("");
    const guide = buildGoogleFlowGuide(project);
    try {
      await navigator.clipboard.writeText(guide);
      setFlowNotice("Semua prompt Google Flow (Ingredients + Veo) berhasil disalin ke clipboard.");
    } catch {
      setError("Browser menolak akses clipboard. Gunakan tombol Unduh google_flow_prompts.md.");
    }
  };

  const handleDownloadGoogleFlow = () => {
    const guide = buildGoogleFlowGuide(project);
    const safeName =
      (project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen") +
      "-google-flow.md";
    downloadBlob(new Blob([guide], { type: "text/markdown;charset=utf-8" }), safeName);
    setFlowNotice(`File ${safeName} berhasil diunduh untuk ditempel di Google Flow.`);
  };

  return (
    <div
      className="modalBackdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pipeline-modal-title"
      onClick={onClose}
    >
      <div className="modalDialog" onClick={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <h2 id="pipeline-modal-title">Validasi Pipeline &amp; Ekspor Hybrid</h2>
          <button type="button" className="btn btnGhost btnIcon" aria-label="Tutup modal" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="modalBody">
          {/* Summary counts: exact measured numbers from current canvas */}
          <div className="nodeMetaRow">
            <span className="metaTag mono">{report.orderedSegmentIds.length} segmen terhubung</span>
            <span className="metaTag mono">Total {report.totalDurationSec} dtk</span>
            <span className="metaTag" data-tone={report.ok ? "ok" : "error"}>
              {report.ok ? "Lolos cek wajib" : `${report.errors.length} error wajib`}
            </span>
            <span className="metaTag" data-tone={report.warnings.length ? "warn" : "ok"}>
              {report.warnings.length} peringatan
            </span>
          </div>

          {/* Issues list */}
          {report.errors.length > 0 || report.warnings.length > 0 ? (
            <ul className="issueList">
              {[...report.errors, ...report.warnings].map((issue) => (
                <li key={issue.id} className="issueItem" data-severity={issue.severity}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <strong style={{ fontSize: 12, color: issue.severity === "error" ? "var(--danger)" : "var(--warn)" }}>
                      [{issue.severity === "error" ? "WAJIB" : "CEK"}] {issue.message}
                    </strong>
                    {issue.nodeId ? (
                      <button
                        type="button"
                        className="btn btnSm"
                        onClick={() => {
                          onSelectNode(issue.nodeId!);
                          onClose();
                        }}
                      >
                        Buka Node
                      </button>
                    ) : null}
                  </div>
                  <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{issue.action}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="alertBox" data-tone="ok" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <CheckIcon size={16} />
              <span>Semua cek struktur, aset, durasi, dan transisi kamera lolos tanpa peringatan.</span>
            </div>
          )}

          {/* Hybrid Output Actions */}
          <div className="sectionBox">
            <h3>Jalur A: Render Video Otomatis (MP4 / WebM)</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                className="btn btnPrimary"
                disabled={!report.ok || Boolean(busy) || !runtime?.localFfmpeg || !runtime?.localPython}
                onClick={handleLocalFfmpeg}
              >
                Render MP4 Lokal (FFmpeg)
              </button>
              <button
                type="button"
                className="btn"
                disabled={!report.ok || Boolean(busy)}
                onClick={handleBrowserWebm}
              >
                Render WebM di Browser
              </button>
            </div>
            {runtime && (!runtime.localFfmpeg || !runtime.localPython) ? (
              <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
                Server ini berjalan tanpa FFmpeg/Python lokal. Gunakan Render WebM di Browser atau Unduh Bundle ZIP di bawah.
              </p>
            ) : null}
          </div>

          <div className="sectionBox">
            <h3>Jalur B: Ekspor Draft CapCut (pyCapCut) &amp; Bundle Offline</h3>
            <div className="fieldRow">
              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="cc-dir-modal">
                  Folder CapCut Drafts
                </label>
                <input
                  id="cc-dir-modal"
                  className="input mono"
                  value={draftsDir}
                  onChange={(e) => setDraftsDir(e.target.value)}
                  placeholder="C:\Users\...\CapCut Drafts"
                />
              </div>
              <div className="fieldGroup">
                <label className="fieldLabel" htmlFor="cc-name-modal">
                  Nama Draft CapCut
                </label>
                <input
                  id="cc-name-modal"
                  className="input"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                />
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={!report.ok || Boolean(busy) || runtime?.isServerless || !runtime?.localPython}
                onClick={handleLocalCapCut}
              >
                Buat Draft CapCut Lokal (pyCapCut)
              </button>
              <button type="button" className="btn" disabled={Boolean(busy)} onClick={handleDownloadBundle}>
                Unduh Bundle ZIP (FFmpeg + pyCapCut + SRT)
              </button>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
              pyCapCut otomatis merakit timeline, media, dan subtitle ke Draft CapCut. Export MP4 akhir dari CapCut tetap dilakukan manual di aplikasi CapCut Desktop.
            </p>
          </div>

          <div className="sectionBox">
            <h3>Jalur C: Ekspor ke Google Flow (Veo &amp; Ingredients)</h3>
            <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
              Susun prompt siap tempel untuk Google Flow (mode Frames-to-Video atau Ingredients-to-Video per 8 detik)
              beserta daftar aset kontinuitas proyek.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button type="button" className="btn btnPrimary btnSm" onClick={() => void handleCopyGoogleFlow()}>
                Salin Semua Prompt Google Flow
              </button>
              <button type="button" className="btn btnSm" onClick={handleDownloadGoogleFlow}>
                Unduh google_flow_prompts.md
              </button>
              <a
                href="https://labs.google/fx/tools/flow"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btnSm"
                style={{ textDecoration: "none" }}
              >
                Buka Google Flow
              </a>
            </div>
            {flowNotice ? (
              <div className="alertBox" data-tone="ok" role="status">
                {flowNotice}
              </div>
            ) : null}
          </div>

          {busy ? (
            <div className="alertBox" role="status">
              {busy}
            </div>
          ) : null}

          {error ? (
            <div className="alertBox" data-tone="error" role="alert">
              {error}
            </div>
          ) : null}

          {result ? (
            <div className="sectionBox">
              <h3>Hasil Eksekusi</h3>
              <div className="alertBox" data-tone="ok">
                {result.note}
                {result.draftPath ? (
                  <div className="mono" style={{ marginTop: 6, fontSize: 11 }}>
                    Lokasi: {result.draftPath}
                  </div>
                ) : null}
              </div>
              {result.fileUrl ? (
                <>
                  <video src={result.fileUrl} controls className="videoPlayer" />
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    <a
                      href={result.engine === "ffmpeg-local" ? `${result.fileUrl}&download=1` : result.fileUrl}
                      download={result.fileName || "nmcgen-output.mp4"}
                      className="btn btnPrimary btnSm"
                      style={{ textDecoration: "none" }}
                    >
                      Unduh {result.fileName || "Video"}
                    </a>
                    {result.durationSec ? <span className="metaTag mono">{result.durationSec} dtk</span> : null}
                    {result.resolution ? <span className="metaTag mono">{result.resolution}</span> : null}
                    {result.sizeBytes ? (
                      <span className="metaTag mono">{(result.sizeBytes / (1024 * 1024)).toFixed(2)} MB</span>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="modalFooter">
          <button type="button" className="btn" onClick={onClose}>
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
