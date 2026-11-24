"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasEdge, CanvasNode, NmcProject, NodeKind, ValidationIssue } from "@/lib/types";
import { canConnect, NODE_META } from "@/lib/presets";
import NodeCard, { NODE_WIDTH } from "./NodeCard";
import { LayoutIcon, PlusIcon } from "./Icons";

interface CanvasBoardProps {
  project: NmcProject;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  issuesByNode: Map<string, ValidationIssue[]>;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (id: string | null) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  onConnect: (sourceId: string, targetId: string) => void;
  onDeleteEdge: (edgeId: string) => void;
  onViewportChange: (vp: { x: number; y: number; zoom: number }) => void;
  onAddNode: (kind: NodeKind) => void;
  onAutoArrange: () => void;
  onInitStarter: () => void;
}

const NODE_KINDS: NodeKind[] = ["script", "asset", "segment", "audio", "assembly", "export"];

function estimateNodeHeight(node: CanvasNode): number {
  if (node.data.kind === "asset" && node.data.imageDataUrl) return 260;
  if (node.data.kind === "segment" && node.data.candidates.length > 0) return 290;
  if (node.kind === "segment") return 190;
  if (node.kind === "asset") return 155;
  return 150;
}

export default function CanvasBoard({
  project,
  selectedNodeId,
  selectedEdgeId,
  issuesByNode,
  onSelectNode,
  onSelectEdge,
  onMoveNode,
  onConnect,
  onDeleteEdge,
  onViewportChange,
  onAddNode,
  onAutoArrange,
  onInitStarter,
}: CanvasBoardProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [wiringFromId, setWiringFromId] = useState<string | null>(null);
  const [pointerWorld, setPointerWorld] = useState<{ x: number; y: number } | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const dragRef = useRef<
    | { mode: "node"; nodeId: string; startX: number; startY: number; origX: number; origY: number }
    | { mode: "pan"; startX: number; startY: number; origX: number; origY: number }
    | null
  >(null);

  const { viewport } = project;

  const clientToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - viewport.x) / viewport.zoom,
        y: (clientY - rect.top - viewport.y) / viewport.zoom,
      };
    },
    [viewport],
  );

  const nodeMap = useMemo(() => new Map(project.nodes.map((n) => [n.id, n])), [project.nodes]);
  const wiringSourceNode = wiringFromId ? nodeMap.get(wiringFromId) ?? null : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setWiringFromId(null);
        setPointerWorld(null);
        setAddMenuOpen(false);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedEdgeId) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        onDeleteEdge(selectedEdgeId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedEdgeId, onDeleteEdge]);

  const handleStagePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setAddMenuOpen(false);
    if (wiringFromId) {
      setWiringFromId(null);
      setPointerWorld(null);
      return;
    }
    onSelectNode(null);
    onSelectEdge(null);
    dragRef.current = {
      mode: "pan",
      startX: e.clientX,
      startY: e.clientY,
      origX: viewport.x,
      origY: viewport.y,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleNodeHeaderPointerDown = (e: React.PointerEvent, node: CanvasNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setAddMenuOpen(false);
    onSelectNode(node.id);
    onSelectEdge(null);
    dragRef.current = {
      mode: "node",
      nodeId: node.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: node.x,
      origY: node.y,
    };
    stageRef.current?.setPointerCapture(e.pointerId);
  };

  const handleStagePointerMove = (e: React.PointerEvent) => {
    if (wiringFromId) {
      setPointerWorld(clientToWorld(e.clientX, e.clientY));
    }
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "pan") {
      onViewportChange({
        ...viewport,
        x: Math.round(drag.origX + (e.clientX - drag.startX)),
        y: Math.round(drag.origY + (e.clientY - drag.startY)),
      });
    } else if (drag.mode === "node") {
      const dx = (e.clientX - drag.startX) / viewport.zoom;
      const dy = (e.clientY - drag.startY) / viewport.zoom;
      const nx = Math.max(0, Math.round((drag.origX + dx) / 10) * 10);
      const ny = Math.max(0, Math.round((drag.origY + dy) / 10) * 10);
      onMoveNode(drag.nodeId, nx, ny);
    }
  };

  const handleStagePointerUp = (e: React.PointerEvent) => {
    if (dragRef.current) {
      dragRef.current = null;
      try {
        stageRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // ignore if capture already released
      }
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 4) return;
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    const nextZoom = Math.min(1.4, Math.max(0.45, Number((viewport.zoom * factor).toFixed(2))));
    onViewportChange({ ...viewport, zoom: nextZoom });
  };

  const handleStartWire = (e: React.PointerEvent | React.MouseEvent, sourceId: string) => {
    setWiringFromId((prev) => (prev === sourceId ? null : sourceId));
    setPointerWorld(clientToWorld(e.clientX, e.clientY));
  };

  const handleFinishWire = (e: React.PointerEvent | React.MouseEvent, targetId: string) => {
    e.stopPropagation();
    if (!wiringFromId || wiringFromId === targetId) return;
    const src = nodeMap.get(wiringFromId);
    const dst = nodeMap.get(targetId);
    if (src && dst && canConnect(src.kind, dst.kind)) {
      onConnect(src.id, dst.id);
    }
    setWiringFromId(null);
    setPointerWorld(null);
  };

  const fitView = () => {
    if (!project.nodes.length || !stageRef.current) {
      onViewportChange({ x: 36, y: 36, zoom: 0.9 });
      return;
    }
    const rect = stageRef.current.getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of project.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_WIDTH);
      maxY = Math.max(maxY, n.y + estimateNodeHeight(n));
    }
    const pad = 70;
    const contentW = Math.max(300, maxX - minX + pad * 2);
    const contentH = Math.max(240, maxY - minY + pad * 2);
    const zoom = Math.min(1.05, Math.max(0.45, Number(Math.min(rect.width / contentW, rect.height / contentH).toFixed(2))));
    const x = Math.round((rect.width - (maxX - minX) * zoom) / 2 - minX * zoom);
    const y = Math.round((rect.height - (maxY - minY) * zoom) / 2 - minY * zoom);
    onViewportChange({ x, y, zoom });
  };

  const edgeCurve = (edge: CanvasEdge) => {
    const src = nodeMap.get(edge.source);
    const dst = nodeMap.get(edge.target);
    if (!src || !dst) return null;
    const x1 = src.x + NODE_WIDTH;
    const y1 = src.y + estimateNodeHeight(src) / 2;
    const x2 = dst.x;
    const y2 = dst.y + estimateNodeHeight(dst) / 2;
    const dx = Math.max(64, Math.abs(x2 - x1) * 0.45);
    return {
      d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      mx: (x1 + x2) / 2,
      my: (y1 + y2) / 2,
    };
  };

  return (
    <div
      ref={stageRef}
      className="canvasStage"
      role="region"
      aria-label="Kanvas node drag-and-drop nmcGen"
      onPointerDown={handleStagePointerDown}
      onPointerMove={handleStagePointerMove}
      onPointerUp={handleStagePointerUp}
      onWheel={handleWheel}
    >
      <div className="canvasBackdrop" />

      {/* Top-left floating node adder & arrange bar */}
      <div className="canvasBar" onPointerDown={(e) => e.stopPropagation()}>
        <div style={{ position: "relative" }}>
          <button
            type="button"
            className="btn btnPrimary btnSm"
            aria-expanded={addMenuOpen}
            onClick={() => setAddMenuOpen((v) => !v)}
          >
            <PlusIcon size={14} />
            <span>Tambah Node</span>
          </button>
          {addMenuOpen ? (
            <div
              role="menu"
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                left: 0,
                width: 240,
                background: "var(--surface)",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-modal)",
                padding: 6,
                display: "flex",
                flexDirection: "column",
                gap: 4,
                zIndex: 30,
              }}
            >
              {NODE_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="menuitem"
                  className="btn btnGhost"
                  style={{ justifyContent: "flex-start", textAlign: "left", height: "auto", padding: "7px 10px" }}
                  onClick={() => {
                    onAddNode(kind);
                    setAddMenuOpen(false);
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontWeight: 600, color: "var(--ink)", fontSize: 12 }}>
                      {NODE_META[kind].stage}: {NODE_META[kind].label}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--ink-muted)", whiteSpace: "normal" }}>
                      {NODE_META[kind].hint}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="btn btnSm"
          disabled={project.nodes.length === 0}
          onClick={onAutoArrange}
          title="Susun seluruh node rapi dari kiri ke kanan"
        >
          <LayoutIcon size={14} />
          <span>Susun Rapi</span>
        </button>

        {selectedEdgeId ? (
          <button
            type="button"
            className="btn btnDanger btnSm"
            onClick={() => onDeleteEdge(selectedEdgeId)}
          >
            Putus Kabel Terpilih
          </button>
        ) : null}
      </div>

      {wiringSourceNode ? (
        <div className="wiringBanner" onPointerDown={(e) => e.stopPropagation()}>
          <span>
            Menyambung dari {wiringSourceNode.title}: klik port kiri node tujuan (hijau)
          </span>
          <button
            type="button"
            className="btn btnSm"
            onClick={() => {
              setWiringFromId(null);
              setPointerWorld(null);
            }}
          >
            Batal
          </button>
        </div>
      ) : null}

      {project.nodes.length === 0 ? (
        <div className="emptyState" onPointerDown={(e) => e.stopPropagation()}>
          <div className="emptyCard">
            <h2>Kanvas proyek masih kosong</h2>
            <p>
              Buat alur dasar (Naskah, Timeline, dan Ekspor) untuk mulai menulis atau generate naskah adegan
              dengan AI, atau tambah satu node secara manual.
            </p>
            <div className="emptyActions">
              <button type="button" className="btn btnPrimary" onClick={onInitStarter}>
                Buat Alur Dasar
              </button>
              <button type="button" className="btn" onClick={() => onAddNode("script")}>
                Tambah Node Naskah
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div
          className="canvasWorld"
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          }}
        >
          <svg className="wiresSvg" aria-hidden="true">
            {project.edges.map((edge) => {
              const geom = edgeCurve(edge);
              if (!geom) return null;
              const isSelected = selectedEdgeId === edge.id;
              return (
                <g key={edge.id} className="wireGroup">
                  <path
                    d={geom.d}
                    className="wireHit"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectEdge(isSelected ? null : edge.id);
                      onSelectNode(null);
                    }}
                  />
                  <path d={geom.d} className="wirePath" data-active={isSelected} />
                </g>
              );
            })}

            {wiringSourceNode && pointerWorld ? (
              <path
                className="wirePreview"
                d={`M ${wiringSourceNode.x + NODE_WIDTH} ${
                  wiringSourceNode.y + estimateNodeHeight(wiringSourceNode) / 2
                } C ${wiringSourceNode.x + NODE_WIDTH + 90} ${
                  wiringSourceNode.y + estimateNodeHeight(wiringSourceNode) / 2
                }, ${pointerWorld.x - 90} ${pointerWorld.y}, ${pointerWorld.x} ${pointerWorld.y}`}
              />
            ) : null}
          </svg>

          {project.nodes.map((node) => {
            const accept =
              Boolean(wiringSourceNode) &&
              wiringSourceNode!.id !== node.id &&
              canConnect(wiringSourceNode!.kind, node.kind);
            return (
              <NodeCard
                key={node.id}
                node={node}
                project={project}
                selected={selectedNodeId === node.id}
                issues={issuesByNode.get(node.id) ?? []}
                wiringFromId={wiringFromId}
                canAcceptWire={accept}
                onSelect={(id) => {
                  onSelectNode(id);
                  onSelectEdge(null);
                }}
                onHeaderPointerDown={handleNodeHeaderPointerDown}
                onStartWire={handleStartWire}
                onFinishWire={handleFinishWire}
              />
            );
          })}
        </div>
      )}

      {/* Bottom-left zoom controls */}
      <div className="canvasBottomBar" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="btn btnSm btnIcon"
          aria-label="Perkecil kanvas"
          onClick={() =>
            onViewportChange({
              ...viewport,
              zoom: Math.max(0.45, Number((viewport.zoom - 0.1).toFixed(2))),
            })
          }
        >
          -
        </button>
        <span className="mono" style={{ fontSize: 12, minWidth: 44, textAlign: "center" }}>
          {Math.round(viewport.zoom * 100)}%
        </span>
        <button
          type="button"
          className="btn btnSm btnIcon"
          aria-label="Perbesar kanvas"
          onClick={() =>
            onViewportChange({
              ...viewport,
              zoom: Math.min(1.4, Number((viewport.zoom + 0.1).toFixed(2))),
            })
          }
        >
          +
        </button>
        <button type="button" className="btn btnSm" onClick={fitView}>
          Fit Layar
        </button>
      </div>
    </div>
  );
}
