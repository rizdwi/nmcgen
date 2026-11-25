"use client";
import React, { useRef, useState } from "react";
import type {
  AssetCategory,
  ProviderProfile,
  StoryAsset,
  StoryboardData,
} from "@/lib/types";
import { uid } from "@/lib/presets";
import { callAi, fileToDataUrl } from "@/lib/storage";
import { downscaleImageForFlux2 } from "@/lib/imageUtils";
import {
  ASSET_CATEGORY_LABEL,
  assetAspectFor,
  buildAssetImagePrompt,
  buildQuickEditPrompt,
  buildSyncAssetVisualPrompt,
  countApprovedAssets,
  getSelectedAssetImage,
  parseQuickEditResponse,
} from "@/lib/storyboard";
import {
  ArrowRightIcon,
  CheckIcon,
  PlusIcon,
  RefreshIcon,
  SparklesIcon,
  TrashIcon,
  UploadIcon,
} from "./Icons";

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
  const [showScriptDrawer, setShowScriptDrawer] = useState(false);
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  const abortRef = useRef(false);
  const uploadInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const latestAssetsRef = useRef<StoryAsset[]>(sb.assets);
  latestAssetsRef.current = sb.assets;

  const isBusy = Boolean(busyId || batchMsg || externalBusy);
  const counts = countApprovedAssets(sb);
  const allApproved = counts.total > 0 && counts.approved === counts.total;
  const canProceed = counts.approved > 0;

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
    const candId = uid();
    const nextAssets = latestAssetsRef.current.map((a) => {
      if (a.id !== asset.id) return a;
      return {
        ...a,
        candidates: [
          ...a.candidates,
          {
            id: candId,
            dataUrl: res.image!,
            model: res.usedModel ? res.usedModel.split("/").pop() : "flux-2-klein-4b",
            createdAt: Date.now(),
          },
        ],
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

      const candId = uid();
      const nextAssets = latestAssetsRef.current.map((a) => {
        if (a.id !== asset.id) return a;
        return {
          ...a,
          visualDesc: parsed.updatedVisualDesc || a.visualDesc,
          approved: false,
          candidates: [
            ...a.candidates,
            {
              id: candId,
              dataUrl: imgRes.image!,
              model: imgRes.usedModel ? `${imgRes.usedModel.split("/").pop()} (edit)` : "edit",
              createdAt: Date.now(),
            },
          ],
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

  const handleUploadAssetImage = async (assetId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      const candId = uid();
      const nextAssets = latestAssetsRef.current.map((a) =>
        a.id === assetId
          ? {
              ...a,
              candidates: [
                ...a.candidates,
                { id: candId, dataUrl, model: "upload", createdAt: Date.now() },
              ],
              selectedCandidateId: candId,
            }
          : a,
      );
      commitAssets(nextAssets);
      setNotice(`Gambar "${file.name}" berhasil dipasang.`);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      e.target.value = "";
    }
  };

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
      <div className="stepIntroRow">
        <div>
          <span className="stepKicker mono">TAHAP 2 DARI 3 · GERBANG ACC</span>
          <h2 className="stepTitle">Aset &amp; Karakter Sesuai Naskah</h2>
          <p className="stepSubtitle">
            Semua karakter, lokasi, dan properti di bawah diekstrak langsung dari keseluruhan naskah{" "}
            <strong>{projectName}</strong>. Generate gambarnya dengan FLUX.2 Klein 4B, cek kesesuaiannya, lalu beri{" "}
            <strong>ACC</strong> sebelum masuk ke Storyboard.
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
          {sb.assets.map((asset) => {
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
