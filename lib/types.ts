// Core nmcGen data types. Uses string unions (no TS enums) for native Node type-stripping tests.

export type NodeKind = "script" | "asset" | "segment" | "audio" | "assembly" | "export";
export type AspectRatio = "9:16" | "16:9";
export type ImageAspect = "16:9" | "9:16" | "3:4" | "1:1";
export type StoryboardStep = "script" | "assets" | "storyboard";
export type AssetCategory = "character" | "location" | "prop";
export type ShotSize = "WS" | "MS" | "MCU" | "CU" | "ECU";
export type CameraAngle = "Front" | "Side 90" | "Rear 3/4" | "High" | "Low";
export type CameraMotion = "Static" | "Push-In" | "Pull-Out" | "Pan Right" | "Pan Left";
export type AudioRole = "vo" | "bgm" | "sfx" | "ambient";
export type PlatformPreset = "tiktok" | "reels" | "youtube" | "google-flow" | "custom";

export interface StoryAssetCandidate {
  id: string;
  dataUrl: string;
  model?: string;
  createdAt: number;
}

export interface StoryAsset {
  id: string;
  name: string;
  category: AssetCategory;
  roleInScript: string;
  visualDesc: string;
  approved: boolean;
  candidates: StoryAssetCandidate[];
  selectedCandidateId?: string;
}

export interface StorySegment {
  id: string;
  index: number;
  title: string;
  locationHint: string;
  scriptContent: string;
  targetPanels: number; // 4 to 7 panels per segment to prevent jump cuts
}

export interface StoryFrameCandidate {
  id: string;
  dataUrl: string;
  model?: string;
  promptUsed?: string;
  createdAt: number;
}

export interface StoryFrame {
  id: string;
  segmentId?: string;
  panelNumber?: number;
  index: number;
  title: string;
  scriptExcerpt: string;
  sceneSummary: string;
  dialogue: string;
  shotSize: ShotSize;
  cameraAngle: CameraAngle;
  assetIds: string[];
  sameLocationAsPrev: boolean;
  visualPrompt: string;
  approved: boolean;
  candidates: StoryFrameCandidate[];
  selectedCandidateId?: string;
}

export interface StoryboardData {
  step: StoryboardStep;
  idea: string;
  aspectRatio: AspectRatio;
  visualStyle: string;
  scriptText: string;
  segments?: StorySegment[];
  scriptApproved: boolean;
  assets: StoryAsset[];
  assetsApproved: boolean;
  frames: StoryFrame[];
  storyFinished?: boolean;
}

export interface ScriptBeat {
  id: string;
  code: string;
  stage?: string;
  durationSec: number;
  summary: string;
  dialogue: string;
  continuityLock?: string;
  shotSize?: ShotSize;
  cameraAngle?: CameraAngle;
  cameraMotion?: CameraMotion;
  visualPrompt?: string;
  visibleAssets?: string[];
}

export interface MediaCandidate {
  id: string;
  kind: "image" | "video";
  label: string;
  dataUrl: string;
  createdAt: number;
}

export interface ToonflowChapter {
  id: string;
  index: number;
  title: string;
  content: string;
  wordCount: number;
}

export interface ToonflowEventNode {
  id: string;
  code: string;
  stage: string;
  title: string;
  summary: string;
  cause: string;
  effect: string;
  conflict: string;
  emotion: string;
  location: string;
  characters: string[];
  durationSec: number;
}

export interface ToonflowSceneBlock {
  id: string;
  eventId: string;
  code: string;
  stage: string;
  heading: string;
  action: string;
  dialogue: string;
  innerThought?: string;
  directorNote?: string;
  emotion: string;
}

export interface ToonflowSupervisionIssue {
  segmentCode?: string;
  category: "alur" | "karakter" | "kontinuitas" | "visual" | "dialog";
  severity: "high" | "medium";
  problem: string;
  fix: string;
}

export interface ToonflowSupervisionReport {
  checkedAt: number;
  score: number;
  verdict: "siap" | "perlu-revisi";
  summary: string;
  strengths: string[];
  issues: ToonflowSupervisionIssue[];
}

export interface ScriptNodeData {
  kind: "script";
  premise: string;
  scriptText: string;
  aspectRatio: AspectRatio;
  maxSegmentSec: number;
  targetSegments?: number;
  visualStyle: string;
  beats: ScriptBeat[];
  sourceText?: string;
  chapters?: ToonflowChapter[];
  activeChapterId?: string;
  eventGraph?: ToonflowEventNode[];
  structuredScenes?: ToonflowSceneBlock[];
  supervision?: ToonflowSupervisionReport;
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
  storyStage?: string;
  durationSec: number;
  shotSize: ShotSize;
  cameraAngle: CameraAngle;
  cameraMotion: CameraMotion;
  timelineText: string;
  dialogue: string;
  continuityLock: string;
  visualPrompt?: string;
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
  storyboard?: StoryboardData;
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
