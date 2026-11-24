// Core nmcGen data types. Uses string unions (no TS enums) for native Node type-stripping tests.

export type NodeKind = "script" | "asset" | "segment" | "audio" | "assembly" | "export";
export type AspectRatio = "9:16" | "16:9";
export type AssetCategory = "character" | "location" | "prop";
export type ShotSize = "WS" | "MS" | "MCU" | "CU" | "ECU";
export type CameraAngle = "Front" | "Side 90" | "Rear 3/4" | "High" | "Low";
export type CameraMotion = "Static" | "Push-In" | "Pull-Out" | "Pan Right" | "Pan Left";
export type AudioRole = "vo" | "bgm" | "sfx" | "ambient";
export type PlatformPreset = "tiktok" | "reels" | "youtube" | "google-flow" | "custom";

export interface ScriptBeat {
  id: string;
  code: string;
  durationSec: number;
  summary: string;
  dialogue: string;
}

export interface MediaCandidate {
  id: string;
  kind: "image" | "video";
  label: string;
  dataUrl: string;
  createdAt: number;
}

export interface ScriptNodeData {
  kind: "script";
  premise: string;
  scriptText: string;
  aspectRatio: AspectRatio;
  maxSegmentSec: number;
  visualStyle: string;
  beats: ScriptBeat[];
}

export interface AssetNodeData {
  kind: "asset";
  tag: string;
  category: AssetCategory;
  lockPrompt: string;
  imageDataUrl?: string;
  imageName?: string;
}

export interface SegmentNodeData {
  kind: "segment";
  code: string;
  durationSec: number;
  shotSize: ShotSize;
  cameraAngle: CameraAngle;
  cameraMotion: CameraMotion;
  timelineText: string;
  dialogue: string;
  continuityLock: string;
  candidates: MediaCandidate[];
  adoptedId?: string;
}

export interface AudioNodeData {
  kind: "audio";
  role: AudioRole;
  volume: number;
  startSec: number;
  sourceMode: "upload" | "ambient-rain";
  audioDataUrl?: string;
  fileName?: string;
}

export interface AssemblyNodeData {
  kind: "assembly";
  fps: 24 | 30;
  targetLufs: number;
  burnSubtitles: boolean;
  fadeOutSec: number;
}

export interface RenderReceipt {
  engine: "ffmpeg-local" | "capcut-local" | "browser-webm" | "bundle-zip";
  fileUrl?: string;
  fileName?: string;
  draftPath?: string;
  durationSec?: number;
  sizeBytes?: number;
  resolution?: string;
  verifiedAt: number;
  note?: string;
}

export interface ExportNodeData {
  kind: "export";
  platform: PlatformPreset;
  capcutDraftsDir: string;
  lastRender?: RenderReceipt;
}

export type NodeData =
  | ScriptNodeData
  | AssetNodeData
  | SegmentNodeData
  | AudioNodeData
  | AssemblyNodeData
  | ExportNodeData;

export interface CanvasNode {
  id: string;
  kind: NodeKind;
  title: string;
  x: number;
  y: number;
  data: NodeData;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
}

export interface NmcProject {
  schemaVersion: number;
  id: string;
  name: string;
  updatedAt: number;
  viewport: { x: number; y: number; zoom: number };
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export type ProviderKind = "CloudflareAI" | "Gemini" | "OpenAI" | "Anthropic" | "OpenAICompatible";

export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  textModel: string;
  imageModel: string;
  timeoutSecs: number;
  autoModel?: boolean;
  discoveredTextModels?: string[];
  discoveredImageModels?: string[];
  modelsSyncedAt?: number;
}

export interface NmcSettings {
  profiles: ProviderProfile[];
  textProfileId: string;
  imageProfileId: string;
  lastProjectId: string;
}

export interface RuntimeStatus {
  mode: "local-hybrid" | "web-serverless";
  isServerless: boolean;
  localFfmpeg: boolean;
  localFfprobe: boolean;
  localPython: boolean;
  localPyCapCut: boolean;
  ffmpegVersion?: string;
  defaultCapCutDir?: string;
  supabaseConnected?: boolean;
  workersAiBinding?: boolean;
  serverKeys: {
    cloudflareAi?: boolean;
    gemini: boolean;
    geminiImage: boolean;
    openai: boolean;
  };
}

export interface ValidationIssue {
  id: string;
  severity: "error" | "warn";
  nodeId?: string;
  nodeTitle?: string;
  code: string;
  message: string;
  action: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  orderedSegmentIds: string[];
  totalDurationSec: number;
  missingAssetImages: number;
  missingSegmentMedia: number;
}
