"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetCategory,
  ProviderProfile,
  StoryAsset,
  StoryboardData,
} from "@/lib/types";
import { uid } from "@/lib/presets";
import { callAi, downloadBlob, fileToDataUrl } from "@/lib/storage";
import { compressImageForStorage, downscaleImageForFlux2 } from "@/lib/imageUtils";
import { ANIMATION_APP_LINKS } from "@/lib/omniAnimation";
import {
  buildFlowAssetImagePackZip,
  buildFlowImageFolderSlug,
  FLOW_IMAGE_MODELS,
  matchDownloadedImageToSlot,
  type FlowConnectorImageModel,
} from "@/lib/flowImageConnector";
import {
  ASSET_CATEGORY_LABEL,
  assetAspectFor,
  buildAssetImagePrompt,
  buildQuickEditPrompt,
  buildSyncAssetVisualPrompt,
  countApprovedAssets,
  getSelectedAssetImage,
  parseQuickEditResponse,
  trimCandidates,
} from "@/lib/storyboard";
import {
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  PlusIcon,
  RefreshIcon,
  SparklesIcon,
  TrashIcon,
  UploadIcon,
} from "./Icons";

interface FsFileHandleLike {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
}

interface FsDirHandleLike {
  kind?: "directory";
  name: string;
  values: () => AsyncIterable<FsFileHandleLike | FsDirHandleLike | { kind: string; name: string }>;
}

type WindowWithDirPicker = Window & {
  showDirectoryPicker?: (opts?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: string;
  }) => Promise<FsDirHandleLike>;
};

const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;
const FLOW_IMAGE_MODEL_STORAGE_KEY = "nmcgen.flowImageModel";
const FLOW_CLI_INSTALL_CMD = "npm install -g flow-connector-cli";

function loadPreferredFlowImageModel(): FlowConnectorImageModel {
  if (typeof window === "undefined") return "nano-banana-2-lite";
  try {
    const saved = window.localStorage.getItem(FLOW_IMAGE_MODEL_STORAGE_KEY);
    if (saved === "nano-banana-2-lite" || saved === "nano-banana-2" || saved === "nano-banana-pro") return saved;
  } catch {
    // ignore storage errors
  }
  return "nano-banana-2-lite";
}

interface AssetsStepProps {
  projectName: string;
  sb: StoryboardData;
  textProfile: ProviderProfile;
  imageProfile: ProviderProfile;
  onPatchSb: (patch: Partial<StoryboardData>) => void;
  onSyncDiscoveredModels: (
    profileId: string,
    discovered: { textModels: string[]; imageModels: string[]; fetchedAt: number },
  ) => void;
  onReExtractAssets: () => Promise<void>;
  onApproveAllAndGoStoryboard: () => void;
  onOpenSettings: () => void;
  externalBusy: string;
}

export default function AssetsStep({
  projectName,
  sb,
  textProfile,
  imageProfile,
  onPatchSb,
  onSyncDiscoveredModels,
  onReExtractAssets,
  onApproveAllAndGoStoryboard,
  onOpenSettings,
  externalBusy,
}: AssetsStepProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [batchMsg, setBatchMsg] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copyFeedback, setCopyFeedback] = useState("");
  const [showScriptDrawer, setShowScriptDrawer] = useState(false);
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  const [flowImageModel, setFlowImageModel] = useState<FlowConnectorImageModel>(() => loadPreferredFlowImageModel());
  const [includeExistingFlow, setIncludeExistingFlow] = useState(false);
  const [watchFolderName, setWatchFolderName] = useState("");
  const [folderWatchSupported, setFolderWatchSupported] = useState(false);

  const abortRef = useRef(false);
  const uploadInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const batchImageInputRef = useRef<HTMLInputElement>(null);
  const watchDirHandleRef = useRef<FsDirHandleLike | null>(null);
  const seenFilesRef = useRef<Set<string>>(new Set());
  const pendingFileSizesRef = useRef<Map<string, number>>(new Map());
  const watchStartedAtRef = useRef<number>(0);
  const latestAssetsRef = useRef<StoryAsset[]>(sb.assets);
  latestAssetsRef.current = sb.assets;

  const isBusy = Boolean(busyId || batchMsg || externalBusy);
  const counts = countApprovedAssets(sb);
  const missingImagesCount = Math.max(0, counts.total - counts.withImages);
  const effectiveOnlyMissing = !includeExistingFlow && missingImagesCount > 0;
  const allApproved = counts.total > 0 && counts.approved === counts.total;
  const canProceed = counts.approved > 0;
  const flowFolderSlug = useMemo(() => buildFlowImageFolderSlug(projectName, "assets"), [projectName]);

  useEffect(() => {
    setFolderWatchSupported(typeof window !== "undefined" && "showDirectoryPicker" in window);
  }, []);

  const selectFlowImageModel = (nextModel: FlowConnectorImageModel) => {
    setFlowImageModel(nextModel);
    try {
      window.localStorage.setItem(FLOW_IMAGE_MODEL_STORAGE_KEY, nextModel);
    } catch {
      // ignore storage errors
    }
  };

  const commitAssets = (nextAssets: StoryAsset[]) => {
    latestAssetsRef.current = nextAssets;
    const allAcc = nextAssets.length > 0 && nextAssets.every((a) => a.approved);
    onPatchSb({ assets: nextAssets, assetsApproved: allAcc });
  };

  const updateAsset = (assetId: string, patch: Partial<StoryAsset>) => {
    commitAssets(latestAssetsRef.current.map((a) => (a.id === assetId ? { ...a, ...patch } : a)));
  };

  const generateOneAsset = async (asset: StoryAsset): Promise<StoryAsset[]> => {
    let workingAsset = asset;
    if (!workingAsset.visualDesc.trim()) {
      const syncBuilt = buildSyncAssetVisualPrompt(workingAsset);
      const tr = await callAi(textProfile, "text", syncBuilt);
      if (tr.discovered) onSyncDiscoveredModels(textProfile.id, tr.discovered);
      const translated = (tr.text || "").trim() || workingAsset.name;
      workingAsset = { ...workingAsset, visualDesc: translated };
      updateAsset(asset.id, { visualDesc: translated });
    }
    const aspect = assetAspectFor(workingAsset.category, sb.aspectRatio);
    const prompt = buildAssetImagePrompt(workingAsset, sb.visualStyle);
    const res = await callAi(imageProfile, "image", {
      prompt,
      aspectRatio: aspect,
    });
    if (res.discovered) onSyncDiscoveredModels(imageProfile.id, res.discovered);
    if (!res.ok || !res.image) {
      throw new Error(res.error || `Gagal generate gambar untuk ${asset.name}.`);
    }
    const optimizedImg = await compressImageForStorage(res.image, { maxSide: 1280, quality: 0.84 });
    const candId = uid();
    const nextAssets = latestAssetsRef.current.map((a) => {
      if (a.id !== asset.id) return a;
      const merged = [
        ...a.candidates,
        {
          id: candId,
          dataUrl: optimizedImg,
          model: res.usedModel ? res.usedModel.split("/").pop() : "flux-2-klein-4b",
          createdAt: Date.now(),
        },
      ];
      return {
        ...a,
        candidates: trimCandidates(merged, candId, 3),
        selectedCandidateId: candId,
      };
    });
    commitAssets(nextAssets);
    return nextAssets;
  };

  const handleGenerateSingle = async (asset: StoryAsset) => {
    setBusyId(asset.id);
    setError("");
    setNotice("");
    try {
      await generateOneAsset(asset);
      setNotice(`Gambar referensi "${asset.name}" selesai dibuat. Cek hasilnya lalu klik ACC jika sudah cocok.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const handleBatchGenerate = async (onlyMissing: boolean) => {
    const targets = latestAssetsRef.current.filter((a) => (onlyMissing ? !getSelectedAssetImage(a) : true));
    if (targets.length === 0) {
      setNotice("Semua aset sudah memiliki gambar referensi.");
      return;
    }
    abortRef.current = false;
    setError("");
    setNotice("");
    try {
      for (let i = 0; i < targets.length; i++) {
        if (abortRef.current) break;
        const target = targets[i];
        setBusyId(target.id);
        setBatchMsg(`Generate gambar aset ${i + 1}/${targets.length}: ${target.name} (FLUX.2 Klein 4B)...`);
        await generateOneAsset(target);
      }
      setNotice(
        abortRef.current
          ? "Generate batch dihentikan."
          : `Selesai membuat ${targets.length} gambar aset. Periksa tiap kartu lalu klik ACC.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
      setBatchMsg("");
    }
  };

  const handleQuickEditAsset = async (asset: StoryAsset) => {
    const instruction = (editDrafts[asset.id] || "").trim();
    const currentImg = getSelectedAssetImage(asset);
    if (!instruction) {
      setError("Tulis instruksi revisi singkat terlebih dahulu.");
      return;
    }
    if (!currentImg) {
      setError("Generate gambar aset terlebih dahulu sebelum melakukan revisi gambar.");
      return;
    }

    setBusyId(asset.id);
    setError("");
    setNotice("");
    try {
      const built = buildQuickEditPrompt({
        mode: "asset",
        label: `${asset.name} (${ASSET_CATEGORY_LABEL[asset.category]})`,
        currentVisualDesc: asset.visualDesc,
        instruction,
        visualStyle: sb.visualStyle,
      });
      const textRes = await callAi(textProfile, "text", built);
      if (textRes.discovered) onSyncDiscoveredModels(textProfile.id, textRes.discovered);
      const parsed = parseQuickEditResponse(textRes.text || "", sb.visualStyle, instruction);

      // Resize current image strictly < 512x512 for FLUX.2 Klein 4B image editing.
      const refThumb = await downscaleImageForFlux2(currentImg, 480);
      const imgRes = await callAi(imageProfile, "image", {
        prompt: parsed.editPrompt,
        aspectRatio: assetAspectFor(asset.category, sb.aspectRatio),
        referenceImages: [refThumb],
      });
      if (imgRes.discovered) onSyncDiscoveredModels(imageProfile.id, imgRes.discovered);
      if (!imgRes.ok || !imgRes.image) {
        throw new Error(imgRes.error || `Gagal merevisi gambar ${asset.name}.`);
      }

      const optimizedImg = await compressImageForStorage(imgRes.image, { maxSide: 1280, quality: 0.84 });
      const candId = uid();
      const nextAssets = latestAssetsRef.current.map((a) => {
        if (a.id !== asset.id) return a;
        const merged = [
          ...a.candidates,
          {
            id: candId,
            dataUrl: optimizedImg,
            model: imgRes.usedModel ? `${imgRes.usedModel.split("/").pop()} (edit)` : "edit",
            createdAt: Date.now(),
          },
        ];
        return {
          ...a,
          visualDesc: parsed.updatedVisualDesc || a.visualDesc,
          approved: false,
          candidates: trimCandidates(merged, candId, 3),
          selectedCandidateId: candId,
        };
      });
      commitAssets(nextAssets);
      setEditDrafts((prev) => ({ ...prev, [asset.id]: "" }));
      setNotice(`Revisi gambar "${asset.name}" selesai. Klik ACC bila hasilnya sudah sesuai.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const attachImageFileToAsset = async (
    asset: StoryAsset,
    file: File,
    modelLabel: string,
    customNotice?: string,
  ) => {
    const rawDataUrl = await fileToDataUrl(file);
    const optimizedImg = await compressImageForStorage(rawDataUrl, { maxSide: 1280, quality: 0.84 });
    const candId = uid();
    const nextAssets = latestAssetsRef.current.map((a) =>
      a.id === asset.id
        ? {
            ...a,
            candidates: trimCandidates(
              [...a.candidates, { id: candId, dataUrl: optimizedImg, model: modelLabel, createdAt: Date.now() }],
              candId,
              3,
            ),
            selectedCandidateId: candId,
          }
        : a,
    );
    commitAssets(nextAssets);
    setNotice(customNotice || `Gambar "${file.name}" berhasil dipasang ke "${asset.name}".`);
    setError("");
  };

  const handleUploadAssetImage = async (assetId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const asset = latestAssetsRef.current.find((a) => a.id === assetId);
    if (!asset) {
      e.target.value = "";
      return;
    }
    try {
      await attachImageFileToAsset(asset, file, "upload");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      e.target.value = "";
    }
  };

  const handleBatchAssetImagesChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
      .filter((f) => f.type.startsWith("image/") || IMAGE_EXT_RE.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    e.target.value = "";
    if (files.length === 0) return;

    const curAssets = latestAssetsRef.current;
    const attachedIds = new Set(curAssets.filter((a) => Boolean(getSelectedAssetImage(a))).map((a) => a.id));
    const batchUsedIds = new Set<string>();
    let assigned = 0;

    try {
      for (const file of files) {
        const target =
          matchDownloadedImageToSlot(file.name, curAssets, attachedIds, { allowOverwriteIndexed: true }) ??
          curAssets.find((a) => !batchUsedIds.has(a.id)) ??
          null;
        if (!target || batchUsedIds.has(target.id)) continue;
        batchUsedIds.add(target.id);
        attachedIds.add(target.id);
        await attachImageFileToAsset(target, file, flowImageModel);
        assigned += 1;
      }
      if (assigned > 0) {
        setNotice(`${assigned} gambar aset berhasil dipasang otomatis sesuai nomor urut!`);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCopyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(key);
      setTimeout(() => setCopyFeedback(""), 2200);
    } catch {
      setError("Gagal menyalin ke clipboard.");
    }
  };

  const handleDownloadFlowAssetsZip = () => {
    if (sb.assets.length === 0) return;
    const pack = buildFlowAssetImagePackZip(projectName, sb, {
      model: flowImageModel,
      onlyMissing: effectiveOnlyMissing,
    });
    if (pack.jobCount === 0) {
      setNotice("Semua aset sudah memiliki gambar. Centang opsi sertakan aset lama jika ingin render ulang.");
      return;
    }
    const copy = new Uint8Array(pack.zipBytes.byteLength);
    copy.set(pack.zipBytes);
    const safeSlug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen";
    downloadBlob(new Blob([copy], { type: "application/zip" }), `${safeSlug}-flow-assets-${flowImageModel}.zip`);
    setError("");
    setNotice(
      `Paket Flow Connector (${pack.jobCount} aset · ${flowImageModel} · 0 kredit Flow) diunduh! Ekstrak lalu jalankan run_flow_images saat tab flow.google.com terbuka.`,
    );
  };

  const handleCopyFlowAgentPrompt = async () => {
    const pack = buildFlowAssetImagePackZip(projectName, sb, {
      model: flowImageModel,
      onlyMissing: effectiveOnlyMissing,
    });
    await handleCopyText(pack.agentPrompt, "flow-assets-agent");
  };

  // Collect image files at root + 1-level subfolders (catches Downloads/nmcgen-<slug>-assets/1 - *.png)
  const collectImageEntries = async (
    rootDir: FsDirHandleLike,
  ): Promise<Array<{ file: File; folderLabel: string; sigKey: string }>> => {
    const out: Array<{ file: File; folderLabel: string; sigKey: string }> = [];
    const scanOneDir = async (dir: FsDirHandleLike, prefix: string) => {
      for await (const entry of dir.values()) {
        if (entry.kind === "file") {
          const name = entry.name || "";
          if (!IMAGE_EXT_RE.test(name) || name.startsWith(".") || name.endsWith(".crdownload")) continue;
          const file = await (entry as FsFileHandleLike).getFile().catch(() => null);
          if (!file || file.size === 0) continue;
          const folderLabel = prefix ? `${rootDir.name}/${prefix}` : rootDir.name;
          out.push({ file, folderLabel, sigKey: `${prefix}/${file.name}` });
        } else if (entry.kind === "directory" && !prefix) {
          const subName = entry.name || "";
          if (!subName || subName.startsWith(".")) continue;
          try {
            await scanOneDir(entry as FsDirHandleLike, subName);
          } catch {
            // Skip unreadable subfolder
          }
        }
      }
    };
    await scanOneDir(rootDir, "");
    return out;
  };

  const scanWatchedFolder = async () => {
    const dir = watchDirHandleRef.current;
    if (!dir) return;
    try {
      const entries = await collectImageEntries(dir);
      const freshItems: Array<{ file: File; folderLabel: string }> = [];

      for (const { file, folderLabel, sigKey } of entries) {
        const sig = `${sigKey}:${file.lastModified}:${file.size}`;
        if (seenFilesRef.current.has(sig)) continue;
        if (file.lastModified < watchStartedAtRef.current - 5000) {
          seenFilesRef.current.add(sig);
          continue;
        }
        const prevSize = pendingFileSizesRef.current.get(sigKey);
        if (prevSize !== file.size && Date.now() - file.lastModified < 1500) {
          pendingFileSizesRef.current.set(sigKey, file.size);
          continue;
        }
        pendingFileSizesRef.current.delete(sigKey);
        seenFilesRef.current.add(sig);
        freshItems.push({ file, folderLabel });
      }

      if (freshItems.length === 0) return;
      freshItems.sort((a, b) => a.file.lastModified - b.file.lastModified);

      const curAssets = latestAssetsRef.current;
      const attachedIds = new Set(curAssets.filter((a) => Boolean(getSelectedAssetImage(a))).map((a) => a.id));
      const scanMatchedIds = new Set<string>();

      for (const { file, folderLabel } of freshItems) {
        const target = matchDownloadedImageToSlot(file.name, curAssets, attachedIds, {
          allowOverwriteIndexed: true,
        });
        if (!target || scanMatchedIds.has(target.id)) continue;
        scanMatchedIds.add(target.id);
        attachedIds.add(target.id);
        await attachImageFileToAsset(
          target,
          file,
          flowImageModel,
          `Otomatis terpasang dari "${folderLabel}": "${file.name}" → ${target.name}!`,
        );
      }
    } catch {
      // Permission revoked or folder unavailable
    }
  };

  const handleEnableFolderWatch = async () => {
    const picker = (window as WindowWithDirPicker).showDirectoryPicker;
    if (!picker) {
      setError("Browser ini belum mendukung pantau folder otomatis (tersedia di Chrome/Edge Desktop).");
      return;
    }
    try {
      const dir = await picker({
        id: "nmcgen-flow-assets",
        mode: "read",
        startIn: "downloads",
      });
      const existing = await collectImageEntries(dir);
      const snapshot = new Set<string>();
      for (const item of existing) {
        snapshot.add(`${item.sigKey}:${item.file.lastModified}:${item.file.size}`);
      }
      seenFilesRef.current = snapshot;
      pendingFileSizesRef.current.clear();
      watchStartedAtRef.current = Date.now();
      watchDirHandleRef.current = dir;
      setWatchFolderName(dir.name || "Downloads");
      setError("");
      setNotice(
        `Pantau otomatis "${dir.name || "Downloads"}" (+ subfolder "${flowFolderSlug}") aktif! Gambar baru dari Flow Connector langsung masuk ke kartu aset sesuai nomornya.`,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(`Gagal mengaktifkan pantau folder: ${(err as Error).message}`);
      }
    }
  };

  const handleStopFolderWatch = () => {
    watchDirHandleRef.current = null;
    setWatchFolderName("");
    setNotice("Pantau folder Downloads aset dimatikan.");
  };

  useEffect(() => {
    if (!watchFolderName) return;
    const timer = window.setInterval(() => {
      void scanWatchedFolder();
    }, 2500);
    const onReturn = () => {
      if (document.visibilityState !== "hidden") void scanWatchedFolder();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchFolderName, flowImageModel]);

  const handleAddManualAsset = () => {
    const created: StoryAsset = {
      id: uid(),
      name: `Aset Baru ${sb.assets.length + 1}`,
      category: "character",
      roleInScript: "Ditambahkan manual sesuai naskah",
      visualDesc: "",
      approved: false,
      candidates: [],
    };
    commitAssets([...latestAssetsRef.current, created]);
  };

  const handleDeleteAsset = (assetId: string) => {
    commitAssets(latestAssetsRef.current.filter((a) => a.id !== assetId));
  };

  const handleToggleAcc = (asset: StoryAsset) => {
    if (!asset.approved && !getSelectedAssetImage(asset)) {
      setError(`Generate atau unggah gambar "${asset.name}" terlebih dahulu sebelum memberi ACC.`);
      return;
    }
    setError("");
    updateAsset(asset.id, { approved: !asset.approved });
  };

  return (
    <div className="stepContainer">
      <input
        ref={batchImageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="srOnly"
        onChange={(e) => void handleBatchAssetImagesChange(e)}
      />

      <div className="stepIntroRow">
        <div>
          <span className="stepKicker mono">TAHAP 2 DARI 4 · GERBANG ACC</span>
          <h2 className="stepTitle">Aset &amp; Karakter Sesuai Naskah</h2>
          <p className="stepSubtitle">
            Semua karakter, lokasi, dan properti di bawah diekstrak langsung dari keseluruhan naskah{" "}
            <strong>{projectName}</strong>. Generate gambarnya dengan FLUX.2 Klein 4B atau lewat{" "}
            <strong>Flow Connector (Nano Banana 2 Lite · 0 Kredit)</strong>, lalu beri <strong>ACC</strong>.
          </p>
        </div>

        <div className="actionGroup">
          <span className="statusBadge" data-tone={allApproved ? "ok" : counts.approved > 0 ? "warn" : undefined}>
            <CheckIcon size={13} />
            <span>
              {counts.approved}/{counts.total} ACC
            </span>
          </span>
          <button
            type="button"
            className="btn btnSm"
            onClick={() => setShowScriptDrawer((v) => !v)}
          >
            {showScriptDrawer ? "Tutup Naskah" : "Lihat Naskah"}
          </button>
        </div>
      </div>

      {/* Action toolbar */}
      <div className="toolbarCard">
        <div className="actionGroup">
          <button
            type="button"
            className="btn btnPrimary btnSm"
            disabled={isBusy || sb.assets.length === 0}
            onClick={() => void handleBatchGenerate(true)}
          >
            <SparklesIcon size={14} />
            <span>
              {counts.withImages < counts.total
                ? `Generate Semua Gambar (${counts.total - counts.withImages} kosong)`
                : "Semua Sudah Ada Gambar"}
            </span>
          </button>
          <button
            type="button"
            className="btn btnSm"
            disabled={isBusy || !sb.scriptText.trim()}
            onClick={() => void onReExtractAssets()}
          >
            <RefreshIcon size={14} />
            <span>Ekstrak Ulang dari Naskah</span>
          </button>
          <button type="button" className="btn btnSm" disabled={isBusy} onClick={handleAddManualAsset}>
            <PlusIcon size={14} />
            <span>Tambah Aset</span>
          </button>
        </div>

        <div className="actionGroup">
          {counts.withImages > 0 && !allApproved ? (
            <button
              type="button"
              className="btn btnOk btnSm"
              disabled={isBusy}
              onClick={onApproveAllAndGoStoryboard}
            >
              <CheckIcon size={14} />
              <span>ACC Semua &amp; Mulai Storyboard</span>
              <ArrowRightIcon size={14} />
            </button>
          ) : (
            <button
              type="button"
              className={`btn btnSm ${allApproved ? "btnPrimary" : ""}`}
              disabled={isBusy || !canProceed}
              onClick={() => onPatchSb({ assetsApproved: true, step: "storyboard" })}
              title={canProceed ? "Masuk ke Storyboard Per-Frame" : "Beri ACC minimal 1 aset terlebih dahulu"}
            >
              <span>Lanjut ke Storyboard Per-Frame</span>
              <ArrowRightIcon size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Collapsible Zero-API-Quota Flow Connector Image Runner (Nano Banana 2 Lite · 0 Flow Credits) */}
      {sb.assets.length > 0 ? (
        <details className="subtleDetails animateCompactDetails">
          <summary className="animateDetailsSummary">
            <span>Bebas Kuota API: Gambar Aset via Flow Connector (Nano Banana 2 Lite · 0 Kredit)</span>
            <span className="statusBadge mono" data-tone={watchFolderName ? "ok" : undefined}>
              {watchFolderName ? `Pantau Aktif: ${watchFolderName}` : "0 Kredit · 400/Hari"}
            </span>
          </summary>

          <div className="subtleDetailsBody animateAdvancedBody">
            <div className="flowConnectorCard">
              <div className="panelHead">
                <div>
                  <strong>Generate Aset di Google Flow (Tanpa Kuota API Cloudflare / AI Studio)</strong>
                  <p className="fieldHint" style={{ margin: "2px 0 0" }}>
                    Memakai <strong>Nano Banana 2 Lite</strong> di Google Flow (<strong>0 kredit Flow</strong>, kuota
                    gratis hingga 400 gambar/hari). Hasil otomatis masuk sesuai nomor kartu aset (#01–#
                    {String(sb.assets.length).padStart(2, "0")}).
                  </p>
                </div>
                <a
                  href={ANIMATION_APP_LINKS.googleFlow}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btnSm"
                >
                  <ExternalLinkIcon size={13} />
                  <span>Buka Google Flow</span>
                </a>
              </div>

              <label className="inlineControl" style={{ width: "100%", justifyContent: "space-between" }}>
                <span className="fieldLabel">Model Gambar Google Flow:</span>
                <select
                  className="select inputSm"
                  value={flowImageModel}
                  onChange={(e) => selectFlowImageModel(e.target.value as FlowConnectorImageModel)}
                  aria-label="Model gambar Google Flow Connector"
                >
                  {FLOW_IMAGE_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>

              {counts.withImages > 0 && missingImagesCount > 0 ? (
                <label className="inlineControl" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={includeExistingFlow}
                    onChange={(e) => setIncludeExistingFlow(e.target.checked)}
                  />
                  <span className="fieldHint">
                    Sertakan aset yang sudah bergambar (total semua {counts.total} aset sebagai versi baru)
                  </span>
                </label>
              ) : null}

              <ol className="flowConnectorSteps">
                <li>
                  <strong>Pasang sekali (Chrome/Edge Desktop):</strong>{" "}
                  <a
                    href={ANIMATION_APP_LINKS.flowConnectorExtension}
                    target="_blank"
                    rel="noreferrer"
                    className="flowInlineLink"
                  >
                    Ekstensi Flow Connector
                  </a>{" "}
                  + CLI lokal:
                  <div className="flowCodeChip">
                    <code className="mono">{FLOW_CLI_INSTALL_CMD}</code>
                    <button
                      type="button"
                      className="btn btnGhost btnSm"
                      onClick={() => void handleCopyText(FLOW_CLI_INSTALL_CMD, "flow-cli-assets")}
                    >
                      {copyFeedback === "flow-cli-assets" ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                      <span>{copyFeedback === "flow-cli-assets" ? "Tersalin" : "Salin"}</span>
                    </button>
                  </div>
                </li>
                <li>
                  <strong>Jalankan otomatis:</strong> Unduh paket ZIP, ekstrak, lalu jalankan{" "}
                  <code className="mono">run_flow_images.bat</code> (Windows),{" "}
                  <code className="mono">run_flow_images.command</code> (Mac), atau{" "}
                  <code className="mono">node run_flow_images.mjs</code> saat tab <strong>flow.google.com</strong>{" "}
                  terbuka.
                </li>
                <li>
                  <strong>Pasang otomatis:</strong> Aktifkan <strong>Pantau Downloads</strong> di bawah (hasil tersimpan
                  di <code className="mono">Downloads/{flowFolderSlug}/</code>) atau klik{" "}
                  <strong>Unggah Banyak Gambar</strong> sekaligus.
                </li>
              </ol>

              <div className="actionGroup">
                <button
                  type="button"
                  className="btn btnPrimary btnSm"
                  disabled={isBusy}
                  onClick={handleDownloadFlowAssetsZip}
                >
                  <DownloadIcon size={13} />
                  <span>
                    Unduh Paket Gambar Aset (
                    {effectiveOnlyMissing ? `${missingImagesCount} kosong` : `Semua ${counts.total}`} · .zip)
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btnSm"
                  disabled={isBusy}
                  onClick={() => batchImageInputRef.current?.click()}
                  title="Pilih banyak gambar sekaligus untuk otomatis dipasang sesuai nomor urut"
                >
                  <UploadIcon size={13} />
                  <span>Unggah Banyak Gambar</span>
                </button>
                <button
                  type="button"
                  className="btn btnGhost btnSm"
                  onClick={() => void handleCopyFlowAgentPrompt()}
                >
                  {copyFeedback === "flow-assets-agent" ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                  <span>{copyFeedback === "flow-assets-agent" ? "Tersalin" : "Salin Prompt Agent"}</span>
                </button>
              </div>
            </div>

            <div className="flowWatchBox" data-active={Boolean(watchFolderName)}>
              <div style={{ flex: "1 1 220px" }}>
                <strong>
                  {watchFolderName
                    ? `Pantau Otomatis Aktif: "${watchFolderName}" (+ ${flowFolderSlug})`
                    : "Pantau Folder Downloads Otomatis (Chrome/Edge Desktop)"}
                </strong>
                <p className="fieldHint" style={{ margin: "3px 0 0" }}>
                  {watchFolderName
                    ? `Memantau "${watchFolderName}/" dan "${watchFolderName}/${flowFolderSlug}/" tiap 2,5 detik. Gambar bernomor 1–${sb.assets.length} langsung terpasang.`
                    : folderWatchSupported
                      ? `Pilih folder Downloads sekali saja agar hasil Nano Banana 2 Lite di Downloads/${flowFolderSlug}/ otomatis masuk ke tiap kartu aset.`
                      : "Browser HP tidak mendukung pantau folder otomatis. Gunakan tombol Unggah Banyak Gambar."}
                </p>
              </div>
              <div className="actionGroup">
                {watchFolderName ? (
                  <>
                    <button type="button" className="btn btnSm" onClick={() => void scanWatchedFolder()}>
                      <RefreshIcon size={13} />
                      <span>Pindai Sekarang</span>
                    </button>
                    <button type="button" className="btn btnGhost btnSm" onClick={handleStopFolderWatch}>
                      Matikan
                    </button>
                  </>
                ) : folderWatchSupported ? (
                  <button
                    type="button"
                    className="btn btnOk btnSm"
                    onClick={() => void handleEnableFolderWatch()}
                  >
                    <RefreshIcon size={13} />
                    <span>Aktifkan Pantau Downloads</span>
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </details>
      ) : null}

      {batchMsg || externalBusy ? (
        <div className="alertBox" role="status" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span>{batchMsg || externalBusy}</span>
          {batchMsg ? (
            <button
              type="button"
              className="btn btnDanger btnSm"
              onClick={() => {
                abortRef.current = true;
              }}
            >
              Hentikan
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="alertBox" data-tone="error" role="alert">
          <span>{error}</span>{" "}
          <button type="button" className="btn btnSm" style={{ marginLeft: 8 }} onClick={onOpenSettings}>
            Pengaturan AI
          </button>
        </div>
      ) : null}

      {notice ? (
        <div className="alertBox" data-tone="ok" role="status">
          {notice}
        </div>
      ) : null}

      {showScriptDrawer ? (
        <section className="scriptPeekBox" aria-label="Pratinjau naskah acuan">
          <div className="panelHead">
            <h3>Naskah Acuan (Read-only)</h3>
            <button type="button" className="btn btnGhost btnSm" onClick={() => onPatchSb({ step: "script" })}>
              Edit Naskah
            </button>
          </div>
          <pre className="scriptPeekPre">{sb.scriptText || "(Naskah kosong)"}</pre>
        </section>
      ) : null}

      {sb.assets.length === 0 ? (
        <div className="emptyPanel">
          <h3>Belum ada aset terekstrak</h3>
          <p>
            Klik tombol di bawah agar AI membaca keseluruhan naskah dan mendaftar karakter, lokasi, dan properti yang
            dibutuhkan secara persis.
          </p>
          <button
            type="button"
            className="btn btnPrimary"
            disabled={isBusy || !sb.scriptText.trim()}
            onClick={() => void onReExtractAssets()}
          >
            <SparklesIcon size={15} />
            <span>Ekstrak Aset &amp; Karakter dari Naskah</span>
          </button>
        </div>
      ) : (
        <div className="assetGrid">
          {sb.assets.map((asset, assetIdx) => {
            const img = getSelectedAssetImage(asset);
            const aspect = assetAspectFor(asset.category, sb.aspectRatio);
            const cardBusy = busyId === asset.id;

            return (
              <article
                key={asset.id}
                className="assetCard"
                data-approved={asset.approved}
              >
                <div className="assetCardHeader">
                  <div className="assetTitleGroup">
                    <span className="metaTag mono" title={`Nomor urut Flow Connector: #${assetIdx + 1}`}>
                      #{String(assetIdx + 1).padStart(2, "0")}
                    </span>
                    <select
                      aria-label={`Kategori ${asset.name}`}
                      className="catSelect"
                      value={asset.category}
                      disabled={isBusy}
                      onChange={(e) =>
                        updateAsset(asset.id, { category: e.target.value as AssetCategory, approved: false })
                      }
                    >
                      <option value="character">Karakter</option>
                      <option value="location">Lokasi</option>
                      <option value="prop">Properti</option>
                    </select>
                    <span className="metaTag mono">{aspect}</span>
                  </div>

                  <button
                    type="button"
                    className={`accToggleBtn ${asset.approved ? "isApproved" : ""}`}
                    disabled={isBusy}
                    onClick={() => handleToggleAcc(asset)}
                  >
                    <CheckIcon size={13} />
                    <span>{asset.approved ? "ACC" : "Beri ACC"}</span>
                  </button>
                </div>

                {/* Image preview stage */}
                <div className="assetMediaBox" data-aspect={aspect}>
                  {img ? (
                    <img
                      src={img}
                      alt={`Referensi ${asset.name}`}
                      className="assetMediaImg"
                    />
                  ) : (
                    <div className="assetEmptyStage">
                      <span>{cardBusy ? "Sedang menggambar (4B)..." : "Belum ada gambar referensi"}</span>
                    </div>
                  )}
                  {cardBusy && img ? (
                    <div className="mediaBusyOverlay">Memproses FLUX.2 Klein 4B...</div>
                  ) : null}
                </div>

                {/* Candidate version switcher if multiple tries exist */}
                {asset.candidates.length > 1 ? (
                  <div className="candStrip" aria-label={`Versi gambar ${asset.name}`}>
                    {asset.candidates.map((cand, idx) => (
                      <button
                        key={cand.id}
                        type="button"
                        className="candThumbBtn"
                        data-active={cand.id === (asset.selectedCandidateId ?? asset.candidates[asset.candidates.length - 1].id)}
                        onClick={() => updateAsset(asset.id, { selectedCandidateId: cand.id })}
                        title={`Versi #${idx + 1}${cand.model ? ` (${cand.model})` : ""}`}
                      >
                        <img src={cand.dataUrl} alt={`Versi ${idx + 1}`} />
                        <span className="mono">#{idx + 1}</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                {/* Name & script evidence */}
                <div className="assetCardBody">
                  <input
                    aria-label="Nama aset"
                    className="input assetNameInput"
                    value={asset.name}
                    disabled={isBusy}
                    onChange={(e) => updateAsset(asset.id, { name: e.target.value })}
                    placeholder="Nama karakter / lokasi / properti"
                  />

                  <textarea
                    aria-label={`Keterangan naskah ${asset.name}`}
                    className="scriptEvidenceInput"
                    rows={2}
                    value={asset.roleInScript}
                    disabled={isBusy}
                    onChange={(e) => updateAsset(asset.id, { roleInScript: e.target.value })}
                    placeholder="Deskripsi singkat sesuai naskah (bahasa Indonesia)..."
                  />

                  {/* Image actions */}
                  <div className="assetActionRow">
                    <button
                      type="button"
                      className={`btn btnSm ${!img ? "btnPrimary" : ""}`}
                      disabled={isBusy || (!asset.visualDesc.trim() && !asset.name.trim())}
                      onClick={() => void handleGenerateSingle(asset)}
                    >
                      {img ? <RefreshIcon size={13} /> : <SparklesIcon size={13} />}
                      <span>{img ? "Regenerate" : "Generate (4B)"}</span>
                    </button>

                    <button
                      type="button"
                      className="btn btnSm"
                      disabled={isBusy}
                      onClick={() => uploadInputRefs.current[asset.id]?.click()}
                    >
                      <UploadIcon size={13} />
                      <span>Upload</span>
                    </button>
                    <input
                      ref={(el) => {
                        uploadInputRefs.current[asset.id] = el;
                      }}
                      type="file"
                      accept="image/*"
                      className="srOnly"
                      onChange={(e) => void handleUploadAssetImage(asset.id, e)}
                    />

                    <button
                      type="button"
                      className="btn btnGhost btnSm btnIcon"
                      style={{ marginLeft: "auto" }}
                      disabled={isBusy}
                      aria-label={`Hapus aset ${asset.name}`}
                      onClick={() => handleDeleteAsset(asset.id)}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>

                  {/* Inline quick FLUX.2 image edit */}
                  {img ? (
                    <div className="inlineEditRow">
                      <input
                        aria-label={`Revisi cepat gambar ${asset.name}`}
                        className="input inputSm"
                        value={editDrafts[asset.id] || ""}
                        disabled={isBusy}
                        onChange={(e) =>
                          setEditDrafts((prev) => ({ ...prev, [asset.id]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleQuickEditAsset(asset);
                          }
                        }}
                        placeholder="Revisi gambar (mis. ganti jaket merah)..."
                      />
                      <button
                        type="button"
                        className="btn btnSm"
                        disabled={isBusy || !(editDrafts[asset.id] || "").trim()}
                        onClick={() => void handleQuickEditAsset(asset)}
                      >
                        Edit
                      </button>
                    </div>
                  ) : null}

                  <details className="subtleDetails">
                    <summary>Deskripsi Visual (EN)</summary>
                    <div className="subtleDetailsBody">
                      <textarea
                        aria-label={`Deskripsi visual ${asset.name}`}
                        className="textarea"
                        style={{ minHeight: 68, fontSize: 12 }}
                        value={asset.visualDesc}
                        disabled={isBusy}
                        onChange={(e) => updateAsset(asset.id, { visualDesc: e.target.value, approved: false })}
                        placeholder="Pure English physical description matching the script..."
                      />
                    </div>
                  </details>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
