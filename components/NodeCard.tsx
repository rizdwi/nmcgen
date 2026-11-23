"use client";
import React from "react";
import type {
  AssemblyNodeData,
  AssetNodeData,
  AudioNodeData,
  CanvasNode,
  ExportNodeData,
  NmcProject,
  ScriptNodeData,
  SegmentNodeData,
  ValidationIssue,
} from "@/lib/types";
import { NODE_META } from "@/lib/presets";
import { getAdoptedMedia, getBoundAssets, getOrderedSegments } from "@/lib/validator";
import { NodeKindIcon } from "./Icons";

export const NODE_WIDTH = 276;

interface NodeCardProps {
  node: CanvasNode;
  project: NmcProject;
  selected: boolean;
  issues: ValidationIssue[];
  wiringFromId: string | null;
  canAcceptWire: boolean;
  onSelect: (id: string) => void;
  onHeaderPointerDown: (e: React.PointerEvent, node: CanvasNode) => void;
  onStartWire: (e: React.PointerEvent | React.MouseEvent, nodeId: string) => void;
  onFinishWire: (e: React.PointerEvent | React.MouseEvent, nodeId: string) => void;
}

export default function NodeCard({
  node,
  project,
  selected,
  issues,
  wiringFromId,
  canAcceptWire,
  onSelect,
  onHeaderPointerDown,
  onStartWire,
  onFinishWire,
}: NodeCardProps) {
  const meta = NODE_META[node.kind];
  const errCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warn").length;

  const renderContent = () => {
    switch (node.data.kind) {
      case "script": {
        const d = node.data as ScriptNodeData;
        const totalBeatsSec = d.beats.reduce((sum, b) => sum + (b.durationSec || 0), 0);
        return (
          <>
            <p className="nodeSnippet">
              {d.premise.trim() || d.scriptText.trim() || "Belum ada naskah. Klik node untuk mulai menulis."}
            </p>
            <div className="nodeMetaRow">
              <span className="metaTag mono">{d.aspectRatio}</span>
              <span className="metaTag mono">Maks {d.maxSegmentSec} dtk</span>
              <span className="metaTag mono">
                {d.beats.length} beat ({totalBeatsSec} dtk)
              </span>
            </div>
          </>
        );
      }
      case "asset": {
        const d = node.data as AssetNodeData;
        const catLabel =
          d.category === "character" ? "Karakter" : d.category === "location" ? "Lokasi" : "Prop";
        return (
          <>
            {d.imageDataUrl ? (
              <img
                src={d.imageDataUrl}
                alt={`Referensi ${d.tag || node.title}`}
                width={252}
                height={142}
                className="nodeThumb"
              />
            ) : null}
            <p className="nodeSnippet">{d.lockPrompt.trim() || "Belum ada teks Continuity Lock."}</p>
            <div className="nodeMetaRow">
              <span className="metaTag mono">{d.tag || "@Aset"}</span>
              <span className="metaTag">{catLabel}</span>
              <span className="metaTag" data-tone={d.imageDataUrl ? "ok" : "warn"}>
                {d.imageDataUrl ? "Gambar siap" : "Belum ada gambar"}
              </span>
            </div>
          </>
        );
      }
      case "segment": {
        const d = node.data as SegmentNodeData;
        const adopted = getAdoptedMedia(d);
        const boundAssets = getBoundAssets(project, node.id);
        return (
          <>
            {adopted && adopted.kind === "image" ? (
              <img
                src={adopted.dataUrl}
                alt={`Preview ${node.title}`}
                width={252}
                height={142}
                className="nodeThumb"
              />
            ) : adopted && adopted.kind === "video" ? (
              <video
                src={adopted.dataUrl}
                width={252}
                height={142}
                className="nodeThumb"
                muted
                playsInline
              />
            ) : null}
            <p className="nodeSnippet">
              {d.timelineText.trim() || d.dialogue.trim() || "Belum ada deskripsi adegan."}
            </p>
            <div className="nodeMetaRow">
              <span className="metaTag mono">{d.code}</span>
              <span className="metaTag mono">{d.durationSec} dtk</span>
              <span className="metaTag mono">
                {d.shotSize} · {d.cameraAngle}
              </span>
              <span className="metaTag" data-tone={adopted ? "ok" : "warn"}>
                {adopted ? `Diadopsi (${d.candidates.length})` : "Belum ada media"}
              </span>
            </div>
            {boundAssets.length > 0 ? (
              <div className="nodeMetaRow">
                {boundAssets.map((a) => (
                  <span key={a.id} className="metaTag mono">
                    {(a.data as AssetNodeData).tag}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        );
      }
      case "audio": {
        const d = node.data as AudioNodeData;
        return (
          <>
            <p className="nodeSnippet">
              {d.sourceMode === "ambient-rain"
                ? "Ambient hujan malam sintetis (FFmpeg lokal)"
                : d.fileName || "Belum ada berkas audio diunggah."}
            </p>
            <div className="nodeMetaRow">
              <span className="metaTag mono">{d.role.toUpperCase()}</span>
              <span className="metaTag mono">Vol {Math.round(d.volume * 100)}%</span>
            </div>
          </>
        );
      }
      case "assembly": {
        const d = node.data as AssemblyNodeData;
        const segs = getOrderedSegments(project);
        const totalDur = segs.reduce((s, n) => s + (n.data.kind === "segment" ? n.data.durationSec : 0), 0);
        return (
          <>
            <p className="nodeSnippet">
              Menyusun {segs.length} segmen berurutan ({totalDur} dtk) dengan validasi kontinuitas &amp; subtitle.
            </p>
            <div className="nodeMetaRow">
              <span className="metaTag mono">{d.fps} fps</span>
              <span className="metaTag mono">{d.targetLufs} LUFS</span>
              <span className="metaTag">{d.burnSubtitles ? "Subtitle aktif" : "Tanpa subtitle"}</span>
            </div>
          </>
        );
      }
      case "export": {
        const d = node.data as ExportNodeData;
        return (
          <>
            <p className="nodeSnippet">
              {d.lastRender
                ? `Terakhir: ${d.lastRender.engine} (${d.lastRender.durationSec ?? "?"} dtk)`
                : "Siap untuk render FFmpeg lokal, Draft CapCut, WebM browser, atau Bundle ZIP."}
            </p>
            <div className="nodeMetaRow">
              <span className="metaTag mono">{d.platform.toUpperCase()}</span>
              {d.lastRender ? (
                <span className="metaTag" data-tone="ok">
                  Terverifikasi
                </span>
              ) : null}
            </div>
          </>
        );
      }
    }
  };

  return (
    <article
      className="nodeCard"
      data-node-id={node.id}
      data-selected={selected}
      data-drop-valid={canAcceptWire}
      style={{ left: node.x, top: node.y, width: NODE_WIDTH }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(node.id);
      }}
    >
      {meta.hasInput ? (
        <button
          type="button"
          className="portBtn portIn"
          data-accepting={canAcceptWire}
          aria-label={`Port masuk ${node.title}`}
          title={canAcceptWire ? `Lepas atau klik untuk sambungkan ke ${node.title}` : `Port masuk ${node.title}`}
          onMouseUp={(e) => onFinishWire(e, node.id)}
          onClick={(e) => {
            e.stopPropagation();
            if (wiringFromId) onFinishWire(e, node.id);
          }}
        />
      ) : null}

      <div
        className="nodeHeader"
        onPointerDown={(e) => onHeaderPointerDown(e, node)}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="nodeStageTag" style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <NodeKindIcon kind={node.kind} size={13} />
            <span>{meta.stage}</span>
          </div>
          <h3 className="nodeTitle" title={node.title}>
            {node.title}
          </h3>
        </div>
        {errCount > 0 ? (
          <span className="metaTag" data-tone="error">
            {errCount} err
          </span>
        ) : warnCount > 0 ? (
          <span className="metaTag" data-tone="warn">
            {warnCount} cek
          </span>
        ) : null}
      </div>

      <div className="nodeBody">{renderContent()}</div>

      {meta.hasOutput ? (
        <button
          type="button"
          className="portBtn portOut"
          data-wiring={wiringFromId === node.id}
          aria-label={`Tarik kabel keluar dari ${node.title}`}
          title={`Tarik atau klik untuk menyambungkan dari ${node.title}`}
          onPointerDown={(e) => {
            e.stopPropagation();
            onStartWire(e, node.id);
          }}
          onClick={(e) => {
            e.stopPropagation();
            onStartWire(e, node.id);
          }}
        />
      ) : null}
    </article>
  );
}
