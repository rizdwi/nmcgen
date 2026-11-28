#!/usr/bin/env python3
"""nmcGen Deterministic Chrome CDP + Canvas2D + FFmpeg MP4 Motion Renderer.

Renders storyboard.json (exported by nmcGen) directly into a crisp H.264/AAC MP4
using hardware-accelerated Chrome/Edge Headless (ANGLE D3D11), procedural NumPy
studio audio (or external music file), and FFmpeg with zero dropped frames.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import http.server
import json
import mimetypes
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import wave
from pathlib import Path

import numpy as np
import websockets

CHROME_CANDIDATES = [
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    Path("/usr/bin/google-chrome"),
    Path("/usr/bin/chromium"),
    Path("/usr/bin/chromium-browser"),
]

EMBEDDED_RENDERER_HTML = r"""<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <title>nmcGen Motion Renderer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { overflow: hidden; background: #0a0c10; font-family: "Segoe UI", system-ui, sans-serif; }
    #frame { display: block; }
  </style>
</head>
<body>
  <canvas id="frame"></canvas>
  <script>
  const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    if (e1 <= e0) return x >= e1 ? 1 : 0;
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const easeInOutCubic = (t) => {
    const u = clamp(t, 0, 1);
    return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  };

  function compileSlides(rawSlides) {
    const out = [];
    let cursor = 0;
    for (let i = 0; i < rawSlides.length; i++) {
      const s = rawSlides[i];
      const dur = Math.max(0.4, Number(s.duration || 3.5));
      let tr = i === 0 || s.transition === "cut" ? 0 : Math.max(0, Number(s.transitionSec || 0.55));
      if (i > 0) tr = Math.min(tr, Math.min(out[i - 1].duration, dur) * 0.45);
      const start = i === 0 ? 0 : cursor - tr;
      const end = start + dur;
      cursor = end;
      out.push({
        index: i,
        imageUrl: s.imageUrl,
        duration: dur,
        start,
        end,
        fit: s.fit || "cover",
        motion: s.motion || "zoom-in",
        motionAmount: clamp(Number(s.motionAmount ?? 0.11), 0, 0.35),
        transition: i === 0 ? "cut" : (s.transition || "crossfade"),
        transitionSec: tr,
        tag: s.tag || "",
        caption: s.caption || "",
      });
    }
    return { slides: out, totalDuration: cursor };
  }

  function sampleAt(tl, tRaw) {
    const t = clamp(tRaw, 0, tl.totalDuration);
    const slides = tl.slides;
    for (let i = slides.length - 1; i >= 0; i--) {
      const cur = slides[i];
      if (t >= cur.start) {
        const localProgress = clamp((t - cur.start) / cur.duration, 0, 1);
        if (i > 0 && cur.transitionSec > 0 && t < cur.start + cur.transitionSec) {
          const prev = slides[i - 1];
          const prevProgress = clamp((t - prev.start) / prev.duration, 0, 1);
          const transT = easeInOutCubic((t - cur.start) / cur.transitionSec);
          return {
            inTransition: true,
            transType: cur.transition,
            transT,
            from: { slide: prev, progress: prevProgress },
            to: { slide: cur, progress: localProgress },
            primary: transT < 0.5 ? prev : cur,
            primaryProgress: transT < 0.5 ? prevProgress : localProgress,
          };
        }
        return {
          inTransition: false,
          transType: "none",
          transT: 1,
          from: null,
          to: { slide: cur, progress: localProgress },
          primary: cur,
          primaryProgress: localProgress,
        };
      }
    }
    return { inTransition: false, transType: "none", transT: 1, from: null, to: { slide: slides[0], progress: 0 }, primary: slides[0], primaryProgress: 0 };
  }

  function motionTransform(motion, amount, progress) {
    const u = clamp(progress, 0, 1);
    const a = clamp(amount, 0, 0.35);
    switch (motion) {
      case "zoom-in": return { scale: lerp(1, 1 + a, u), tx: 0, ty: 0, rot: 0 };
      case "zoom-out": return { scale: lerp(1 + a, 1, u), tx: 0, ty: 0, rot: 0 };
      case "pan-left": return { scale: 1 + a, tx: lerp(a * 0.42, -a * 0.42, u), ty: 0, rot: 0 };
      case "pan-right": return { scale: 1 + a, tx: lerp(-a * 0.42, a * 0.42, u), ty: 0, rot: 0 };
      case "pan-up": return { scale: 1 + a, tx: 0, ty: lerp(a * 0.42, -a * 0.42, u), rot: 0 };
      case "pan-down": return { scale: 1 + a, tx: 0, ty: lerp(-a * 0.42, a * 0.42, u), rot: 0 };
      case "tilt-drift": return { scale: lerp(1.03, 1.03 + a, u), tx: lerp(-a * 0.18, a * 0.18, u), ty: lerp(a * 0.12, -a * 0.12, u), rot: lerp(-0.016, 0.016, u) };
      default: return { scale: 1, tx: 0, ty: 0, rot: 0 };
    }
  }

  function fitRect(iw, ih, W, H, mode) {
    const ia = iw / Math.max(1, ih);
    const ca = W / Math.max(1, H);
    let w, h;
    if (mode === "contain-blur") {
      if (ia > ca) { w = W * 0.92; h = w / ia; } else { h = H * 0.72; w = h * ia; }
    } else if (ia > ca) {
      h = H; w = h * ia;
    } else {
      w = W; h = w / ia;
    }
    return { x: (W - w) * 0.5, y: (H - h) * 0.5, w, h };
  }

  function loadImg(url) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("Failed to load " + url));
      im.src = url;
    });
  }

  (async () => {
    try {
      const spec = await (await fetch("/resolved_spec.json")).json();
      const tl = compileSlides(spec.slides || []);
      const W = Number(spec.width || 1080);
      const H = Number(spec.height || 1920);
      const theme = spec.theme || {};
      const accent = theme.accent || "#E87D35";
      const bg = theme.background || "#0A0C10";

      document.documentElement.style.width = W + "px";
      document.documentElement.style.height = H + "px";
      document.body.style.width = W + "px";
      document.body.style.height = H + "px";

      const canvas = document.getElementById("frame");
      canvas.width = W;
      canvas.height = H;
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      const ctx = canvas.getContext("2d");

      const offFrom = document.createElement("canvas");
      offFrom.width = W; offFrom.height = H;
      const offTo = document.createElement("canvas");
      offTo.width = W; offTo.height = H;

      const imgs = new Map();
      await Promise.all(tl.slides.map(async (s) => {
        if (!imgs.has(s.imageUrl)) imgs.set(s.imageUrl, await loadImg(s.imageUrl));
      }));

      function drawSlide(c, s, prog) {
        c.save();
        c.clearRect(0, 0, W, H);
        c.fillStyle = bg;
        c.fillRect(0, 0, W, H);
        const im = imgs.get(s.imageUrl);
        if (!im) { c.restore(); return; }
        c.imageSmoothingEnabled = true;
        c.imageSmoothingQuality = "high";
        const m = motionTransform(s.motion, s.motionAmount, prog);
        if (s.fit === "contain-blur") {
          const bgr = fitRect(im.naturalWidth, im.naturalHeight, W, H, "cover");
          c.save();
          c.filter = "blur(32px) brightness(0.38)";
          c.translate(W * 0.5, H * 0.5);
          c.scale(1.14, 1.14);
          c.drawImage(im, bgr.x - W * 0.5, bgr.y - H * 0.5, bgr.w, bgr.h);
          c.restore();

          const fgr = fitRect(im.naturalWidth, im.naturalHeight, W, H, "contain-blur");
          c.save();
          c.translate(W * 0.5 + m.tx * W, H * 0.5 + m.ty * H);
          c.rotate(m.rot);
          c.scale(m.scale, m.scale);
          c.shadowColor = "rgba(0,0,0,0.55)";
          c.shadowBlur = Math.round(Math.min(W, H) * 0.03);
          c.shadowOffsetY = Math.round(Math.min(W, H) * 0.012);
          c.beginPath();
          c.roundRect(fgr.x - W * 0.5, fgr.y - H * 0.5, fgr.w, fgr.h, Math.round(Math.min(W, H) * 0.014));
          c.fillStyle = "#11151d";
          c.fill();
          c.shadowColor = "transparent";
          c.clip();
          c.drawImage(im, fgr.x - W * 0.5, fgr.y - H * 0.5, fgr.w, fgr.h);
          c.restore();
        } else {
          const r = fitRect(im.naturalWidth, im.naturalHeight, W, H, "cover");
          c.save();
          c.translate(W * 0.5 + m.tx * W, H * 0.5 + m.ty * H);
          c.rotate(m.rot);
          c.scale(m.scale, m.scale);
          c.drawImage(im, r.x - W * 0.5, r.y - H * 0.5, r.w, r.h);
          c.restore();
        }
        c.restore();
      }

      window.setVideoTime = (tRaw) => {
        const t = clamp(tRaw, 0, tl.totalDuration);
        const st = sampleAt(tl, t);
        if (!st.inTransition || !st.from) {
          drawSlide(ctx, st.to.slide, st.to.progress);
        } else {
          drawSlide(offFrom.getContext("2d"), st.from.slide, st.from.progress);
          drawSlide(offTo.getContext("2d"), st.to.slide, st.to.progress);
          const u = st.transT;
          ctx.save();
          ctx.clearRect(0, 0, W, H);
          if (st.transType === "slide-left") {
            ctx.drawImage(offFrom, -u * W, 0);
            ctx.drawImage(offTo, (1 - u) * W, 0);
          } else if (st.transType === "slide-up") {
            ctx.drawImage(offFrom, 0, -u * H);
            ctx.drawImage(offTo, 0, (1 - u) * H);
          } else if (st.transType === "zoom-cut") {
            ctx.save(); ctx.globalAlpha = 1 - u; ctx.translate(W * 0.5, H * 0.5); ctx.scale(1 + u * 0.12, 1 + u * 0.12); ctx.drawImage(offFrom, -W * 0.5, -H * 0.5); ctx.restore();
            ctx.save(); ctx.globalAlpha = u; ctx.translate(W * 0.5, H * 0.5); ctx.scale(1.08 - u * 0.08, 1.08 - u * 0.08); ctx.drawImage(offTo, -W * 0.5, -H * 0.5); ctx.restore();
          } else if (st.transType === "wipe-right") {
            const splitX = u * W;
            ctx.drawImage(offFrom, 0, 0);
            ctx.save(); ctx.beginPath(); ctx.rect(0, 0, splitX, H); ctx.clip(); ctx.drawImage(offTo, 0, 0); ctx.restore();
            ctx.fillStyle = accent;
            ctx.fillRect(splitX - 2, 0, 4, H);
          } else {
            ctx.drawImage(offFrom, 0, 0);
            ctx.globalAlpha = u;
            ctx.drawImage(offTo, 0, 0);
          }
          ctx.restore();
        }

        const scale = Math.min(W, H) / 1080;
        const slide = st.primary;
        const showBadge = theme.showBadge !== false;
        const showSub = theme.showSubtitles !== false;
        const showProg = theme.showProgress !== false;

        if (showBadge || showProg) {
          const topH = Math.round(150 * scale);
          const tg = ctx.createLinearGradient(0, 0, 0, topH);
          tg.addColorStop(0, "rgba(7,9,13,0.84)");
          tg.addColorStop(1, "rgba(7,9,13,0)");
          ctx.fillStyle = tg;
          ctx.fillRect(0, 0, W, topH);
        }

        if (showProg && tl.totalDuration > 0) {
          const padX = Math.round(36 * scale);
          const barY = Math.round(22 * scale);
          const barW = W - padX * 2;
          const barH = Math.max(3, Math.round(4 * scale));
          ctx.fillStyle = "rgba(255,255,255,0.18)";
          ctx.beginPath(); ctx.roundRect(padX, barY, barW, barH, barH / 2); ctx.fill();
          ctx.fillStyle = accent;
          ctx.beginPath(); ctx.roundRect(padX, barY, barW * clamp(t / tl.totalDuration, 0, 1), barH, barH / 2); ctx.fill();
        }

        if (showBadge && slide.tag) {
          ctx.save();
          const fs = Math.max(13, Math.round(20 * scale));
          ctx.font = `700 ${fs}px "Bahnschrift", "Segoe UI", system-ui, sans-serif`;
          const padX = Math.round(16 * scale);
          const bw = Math.min(W - Math.round(72 * scale), ctx.measureText(slide.tag).width + padX * 2);
          const bh = Math.round(40 * scale);
          const bx = Math.round(36 * scale);
          const by = Math.round(40 * scale);
          ctx.fillStyle = "rgba(11,14,20,0.78)";
          ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, Math.round(8 * scale)); ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.14)";
          ctx.lineWidth = Math.max(1, 1.2 * scale);
          ctx.stroke();
          ctx.fillStyle = "#F4F6F9";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(slide.tag, bx + padX, by + bh * 0.52, bw - padX * 2);
          ctx.restore();
        }

        if (showSub && slide.caption) {
          const a = clamp(smoothstep(0.05, 0.16, st.primaryProgress) * (1 - smoothstep(0.88, 0.98, st.primaryProgress)), 0, 1);
          if (a > 0.02) {
            const botH = Math.round(300 * scale);
            const bgGrad = ctx.createLinearGradient(0, H - botH, 0, H);
            bgGrad.addColorStop(0, "rgba(7,9,13,0)");
            bgGrad.addColorStop(0.45, "rgba(7,9,13,0.72)");
            bgGrad.addColorStop(1, "rgba(7,9,13,0.94)");
            ctx.fillStyle = bgGrad;
            ctx.fillRect(0, H - botH, W, botH);

            ctx.save();
            ctx.globalAlpha = a;
            const fs = Math.max(16, Math.round(34 * scale));
            ctx.font = `600 ${fs}px "Segoe UI", system-ui, sans-serif`;
            const maxW = W * 0.84;
            const words = slide.caption.split(/\s+/);
            const lines = [];
            let cur = "";
            for (const w of words) {
              const test = cur ? cur + " " + w : w;
              if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
            }
            if (cur) lines.push(cur);
            const lh = Math.round(fs * 1.36);
            const startY = H - Math.round(68 * scale) - lines.length * lh + lh * 0.5;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.shadowColor = "rgba(0,0,0,0.75)";
            ctx.shadowBlur = Math.round(10 * scale);
            ctx.fillStyle = "#F4F6F9";
            lines.forEach((ln, idx) => ctx.fillText(ln, W * 0.5, startY + idx * lh));
            ctx.restore();
          }
        }
        return true;
      };

      window.__READY__ = true;
      window.setVideoTime(0);
    } catch (e) {
      window.__ERROR__ = String(e);
    }
  })();
  </script>
</body>
</html>
"""


def find_browser() -> str:
    for p in CHROME_CANDIDATES:
        if p.exists():
            return str(p)
    raise FileNotFoundError("Google Chrome atau Microsoft Edge tidak ditemukan di sistem ini.")


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _smoothstep_np(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    if edge1 <= edge0:
        return (x >= edge1).astype(np.float64)
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def synth_ambient_wav(total_sec: float, transition_times: list[float], out_wav: Path, volume: float = 0.85) -> Path:
    sr = 48000
    n = max(1, int(round(total_sec * sr)))
    t = np.arange(n, dtype=np.float64) / sr
    lfo = 0.88 + 0.12 * np.sin(2.0 * np.pi * 0.22 * t)
    pad = (
        0.18 * np.sin(2.0 * np.pi * 110.0 * t)
        + 0.13 * np.sin(2.0 * np.pi * 164.81 * t)
        + 0.10 * np.sin(2.0 * np.pi * 220.0 * t)
        + 0.05 * np.sin(2.0 * np.pi * 277.18 * t)
    ) * lfo
    left = pad * (1.0 + 0.04 * np.sin(2.0 * np.pi * 0.3 * t))
    right = pad * (1.0 - 0.04 * np.sin(2.0 * np.pi * 0.3 * t))

    for ts in transition_times:
        if ts <= 0.05 or ts >= total_sec - 0.05:
            continue
        idx = int(ts * sr)
        dur = int(0.18 * sr)
        end = min(n, idx + dur)
        if end <= idx:
            continue
        tau = np.arange(end - idx, dtype=np.float64) / sr
        tick = 0.11 * np.sin(2.0 * np.pi * 1320.0 * tau) * np.exp(-tau * 70.0)
        swell = 0.08 * np.sin(2.0 * np.pi * (220.0 + 180.0 * tau) * tau) * np.sin(np.pi * tau / 0.18)
        left[idx:end] += tick + swell
        right[idx:end] += tick + swell

    env = _smoothstep_np(0.0, 0.4, t) * (1.0 - _smoothstep_np(max(0.0, total_sec - 0.8), total_sec, t))
    left *= env
    right *= env

    peak = max(float(np.max(np.abs(left))), float(np.max(np.abs(right))), 1e-9)
    scale = min(0.9, max(0.05, volume * 0.86)) / peak
    pcm = np.clip(np.round(np.column_stack((left * scale, right * scale)) * 32767.0), -32768, 32767).astype("<i2")
    with wave.open(str(out_wav), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())
    return out_wav


def prepare_external_audio(src: Path, total_sec: float, out_wav: Path, volume: float = 0.85) -> Path:
    fade_out_st = max(0.0, total_sec - 0.8)
    af = f"volume={volume:.3f},afade=t=in:st=0:d=0.4,afade=t=out:st={fade_out_st:.3f}:d=0.8"
    proc = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-stream_loop", "-1", "-i", str(src), "-t", f"{total_sec:.4f}", "-ar", "48000", "-ac", "2", "-af", af, str(out_wav)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Gagal memproses audio eksternal: {proc.stderr}")
    return out_wav


def compute_timing(slides: list[dict]) -> tuple[float, list[float]]:
    cursor = 0.0
    prev_dur = 0.0
    trans_times: list[float] = []
    for i, s in enumerate(slides):
        dur = max(0.4, float(s.get("duration", 3.5)))
        tr = 0.0 if i == 0 or s.get("transition") == "cut" else max(0.0, float(s.get("transitionSec", 0.55)))
        if i > 0:
            tr = min(tr, min(prev_dur, dur) * 0.45)
        start = 0.0 if i == 0 else cursor - tr
        cursor = start + dur
        prev_dur = dur
        if i > 0:
            trans_times.append(start)
    return cursor, trans_times


def start_http(resolved_spec: dict, media_map: dict[str, Path]) -> tuple[http.server.ThreadingHTTPServer, int]:
    spec_bytes = json.dumps(resolved_spec).encode("utf-8")
    html_bytes = EMBEDDED_RENDERER_HTML.encode("utf-8")

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args) -> None:
            return

        def _send(self, body: bytes, ctype: str) -> None:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            p = self.path.split("?", 1)[0]
            if p == "/" or p == "/index.html":
                self._send(html_bytes, "text/html; charset=utf-8")
            elif p == "/resolved_spec.json":
                self._send(spec_bytes, "application/json; charset=utf-8")
            elif p in media_map:
                f = media_map[p]
                self._send(f.read_bytes(), mimetypes.guess_type(str(f))[0] or "application/octet-stream")
            else:
                self.send_error(404)

    port = find_free_port()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


class Cdp:
    def __init__(self, ws_url: str) -> None:
        self._url = ws_url
        self._id = 0
        self._ws = None

    async def __aenter__(self) -> "Cdp":
        self._ws = await websockets.connect(self._url, max_size=32 * 1024 * 1024)
        return self

    async def __aexit__(self, *args) -> None:
        if self._ws is not None:
            await self._ws.close()

    async def call(self, method: str, params: dict | None = None) -> dict:
        self._id += 1
        rid = self._id
        await self._ws.send(json.dumps({"id": rid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await self._ws.recv())
            if msg.get("id") == rid:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method}: {msg['error']}")
                return msg.get("result", {})


async def render_mp4(spec_path: Path, out_path: Path, audio_override: Path | None, crf: int, use_cpu: bool, json_out: bool) -> dict:
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    base_dir = spec_path.parent
    slides = spec.get("slides") or []
    if not slides:
        raise ValueError("Storyboard tidak memiliki slide gambar.")

    width = int(spec.get("width", 1080))
    height = int(spec.get("height", 1920))
    fps = int(spec.get("fps", 30))
    total_sec, trans_times = compute_timing(slides)

    resolved = json.loads(json.dumps(spec))
    media_map: dict[str, Path] = {}
    for idx, sl in enumerate(resolved["slides"]):
        raw = Path(sl["image"])
        abs_p = raw if raw.is_absolute() else (base_dir / raw).resolve()
        if not abs_p.exists():
            raise FileNotFoundError(f"Gambar slide {idx + 1} tidak ditemukan: {abs_p}")
        key = f"/media/s_{idx:04d}{abs_p.suffix.lower()}"
        media_map[key] = abs_p
        sl["imageUrl"] = key

    srv, http_port = start_http(resolved, media_map)
    cdp_port = find_free_port()
    tmp_dir = Path(tempfile.mkdtemp(prefix="nmcgen_cdp_"))
    gpu_flags = ["--disable-gpu-sandbox", "--use-gl=angle", "--use-angle=swiftshader"] if use_cpu else ["--use-gl=angle", "--use-angle=d3d11"]
    chrome = subprocess.Popen(
        [
            find_browser(),
            "--headless=new",
            *gpu_flags,
            "--enable-webgl",
            "--ignore-gpu-blocklist",
            "--hide-scrollbars",
            f"--window-size={width},{height}",
            f"--remote-debugging-port={cdp_port}",
            f"--user-data-dir={tmp_dir}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        ws_url = None
        for _ in range(60):
            try:
                targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/list").read())
                pg = next((x for x in targets if x.get("type") == "page"), None)
                if pg and pg.get("webSocketDebuggerUrl"):
                    ws_url = pg["webSocketDebuggerUrl"]
                    break
            except Exception:
                pass
            await asyncio.sleep(0.1)
        if not ws_url:
            raise RuntimeError("Chrome Headless CDP tidak merespons.")

        audio_cfg = spec.get("audio") or {"mode": "synth"}
        audio_mode = "file" if audio_override else audio_cfg.get("mode", "synth")
        wav_path: Path | None = None
        if audio_mode == "file":
            src = audio_override if audio_override else (base_dir / audio_cfg["file"]).resolve()
            wav_path = prepare_external_audio(src, total_sec, tmp_dir / "audio.wav", float(audio_cfg.get("volume", 0.85)))
        elif audio_mode == "synth":
            wav_path = synth_ambient_wav(total_sec, trans_times, tmp_dir / "audio.wav", float(audio_cfg.get("volume", 0.85)))

        async with Cdp(ws_url) as cdp:
            await cdp.call("Page.enable")
            await cdp.call("Emulation.setDeviceMetricsOverride", {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False})
            await cdp.call("Page.navigate", {"url": f"http://127.0.0.1:{http_port}/"})

            for _ in range(200):
                res = await cdp.call("Runtime.evaluate", {"expression": "JSON.stringify({r:Boolean(window.__READY__),e:window.__ERROR__||null})", "returnByValue": True})
                raw_val = res.get("result", {}).get("value")
                if raw_val:
                    st = json.loads(raw_val)
                    if st["e"]:
                        raise RuntimeError(st["e"])
                    if st["r"]:
                        break
                await asyncio.sleep(0.05)

            out_path.parent.mkdir(parents=True, exist_ok=True)
            total_frames = max(1, int(round(total_sec * fps)))
            ff_log = tmp_dir / "ffmpeg.log"

            ff_cmd = ["ffmpeg", "-y", "-loglevel", "warning", "-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", str(fps), "-i", "-"]
            if wav_path is not None:
                ff_cmd += ["-i", str(wav_path)]
            ff_cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
            if wav_path is not None:
                ff_cmd += ["-c:a", "aac", "-b:a", "192k", "-shortest"]
            ff_cmd.append(str(out_path))

            t0 = time.perf_counter()
            with ff_log.open("wb") as lf:
                ff = subprocess.Popen(ff_cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=lf)
                try:
                    assert ff.stdin is not None
                    for idx in range(total_frames):
                        t = idx / fps
                        await cdp.call("Runtime.evaluate", {"expression": f"window.setVideoTime({t:.6f})", "returnByValue": True})
                        shot = await cdp.call("Page.captureScreenshot", {"format": "jpeg", "quality": 96})
                        ff.stdin.write(base64.b64decode(shot["data"]))
                        if not json_out and ((idx + 1) % 60 == 0 or idx + 1 == total_frames):
                            print(f"Render {idx + 1}/{total_frames} frame ({time.perf_counter() - t0:.1f}s)", flush=True)
                    ff.stdin.close()
                    rc = ff.wait()
                    if rc != 0:
                        raise RuntimeError(f"FFmpeg gagal ({rc}): {ff_log.read_text(encoding='utf-8', errors='replace')}")
                finally:
                    if ff.poll() is None:
                        ff.kill()

            elapsed = round(time.perf_counter() - t0, 2)
            return {
                "ok": True,
                "output": str(out_path),
                "width": width,
                "height": height,
                "fps": fps,
                "frames": total_frames,
                "duration_sec": round(total_sec, 2),
                "size_bytes": out_path.stat().st_size,
                "render_sec": elapsed,
            }
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=4)
        except subprocess.TimeoutExpired:
            chrome.kill()
        srv.shutdown()
        shutil.rmtree(tmp_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="nmcGen Chrome CDP + FFmpeg MP4 Motion Renderer")
    parser.add_argument("--spec", required=True, type=Path, help="Path ke storyboard.json")
    parser.add_argument("--out", required=True, type=Path, help="Path output MP4")
    parser.add_argument("--audio", type=Path, default=None, help="Opsional: file audio eksternal (mp3/wav)")
    parser.add_argument("--crf", type=int, default=17, help="Kualitas H.264 CRF (default 17)")
    parser.add_argument("--cpu", action="store_true", help="Gunakan SwiftShader CPU jika GPU D3D11 bermasalah")
    parser.add_argument("--json", action="store_true", help="Cetak output JSON bersih di stdout")
    args = parser.parse_args()

    if not shutil.which("ffmpeg"):
        msg = {"ok": False, "error": "ffmpeg tidak ditemukan di PATH."}
        print(json.dumps(msg) if args.json else msg["error"], file=sys.stderr if not args.json else sys.stdout)
        sys.exit(1)

    try:
        info = asyncio.run(render_mp4(args.spec.resolve(), args.out.resolve(), args.audio.resolve() if args.audio else None, args.crf, args.cpu, args.json))
        if args.json:
            print(json.dumps(info))
        else:
            print(f"Selesai: {info['output']} ({info['width']}x{info['height']} @ {info['fps']}fps, {info['duration_sec']}s, {info['size_bytes']} byte dalam {info['render_sec']}s)")
    except Exception as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": str(exc)}))
        else:
            print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
