"""Video matting ("auto cutout") — person segmentation → VP9-alpha WebM.

Called via worker.py's `key_video` method. Decodes the source with OpenCV,
runs a per-frame segmentation model (MediaPipe Selfie Segmentation via
cv2.dnn/TFLite or MODNet via onnxruntime), post-processes the matte
(temporal EMA to kill flicker + gaussian feather + alpha-weighted despill),
and pipes BGRA frames into the server's ffmpeg binary → libvpx-vp9
`-pix_fmt yuva420p` WebM.

The result is a self-contained transparent video: the browser <video> and
the server decoder (with `-c:v libvpx-vp9`) both read the baked alpha, so
preview and MP4 export composite the identical pixels.

Params (from the Node caller):
    video_path    source video file
    out_path      destination .webm (written via `<out>.part` then renamed)
    ffmpeg_path   resolved ffmpeg binary (from ffmpegService)
    models_dir    model cache dir (OUTPUT_ROOT/cache/models)
    model         "mediapipe" | "modnet"           (default mediapipe)
    despill       bool — green-spill clamp on semi-transparent edges
                  (default true)
    feather       gaussian blur sigma on the matte edge, px   (default 1.0)
    smooth        temporal EMA factor on the matte 0..1        (default 0.5)
    max_dim       longest-side cap for the encoded webm        (default 1920)
    progress_path optional JSON file rewritten every ~10 frames
"""

# Confidence→alpha normalization. The shipped float16 MediaPipe export tops
# out around p≈0.9 on a clear person and ~0.6 on small figures — using raw
# probabilities as alpha would leave every subject translucent. A fixed soft
# ramp (p≤0.2 → 0, p≥0.8 → 1) makes confident pixels opaque while keeping the
# edge band smooth; for MODNet's near-binary output the ramp is ~identity.
_ALPHA_LO = 0.2
_ALPHA_HI = 0.8

import json
import os
import subprocess

from .worker import EngineError
from . import models as _models


class _MediapipeSeg:
    """selfie_segmenter_landscape.tflite through cv2.dnn — NCHW f32 [-1,1].

    Input normalization matters: feeding [0,1] collapses the output
    confidence to ≤0.9 (subjects render translucent); the model's trained
    range is [-1,1] (scalefactor 2/255, mean 127.5)."""

    def __init__(self, model_path: str, input_size):
        import cv2

        self._net = cv2.dnn.readNetFromTFLite(model_path)
        self._w, self._h = input_size

    def alpha(self, frame_bgr):
        import cv2
        import numpy as np

        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        blob = cv2.dnn.blobFromImage(rgb, scalefactor=2.0 / 255.0,
                                   size=(self._w, self._h),
                                   mean=(127.5, 127.5, 127.5))
        self._net.setInput(blob)
        return np.clip(self._net.forward()[0, 0], 0.0, 1.0).astype("f4")


class _ModnetSeg:
    """modnet_photographic_portrait_matting.onnx through onnxruntime.
    Input "input" (b,3,h,w) normalized to [-1,1]; output matte in [0,1]."""

    def __init__(self, model_path: str, input_size):
        import onnxruntime as ort

        self._sess = ort.InferenceSession(
            model_path, providers=["CPUExecutionProvider"]
        )
        self._name = self._sess.get_inputs()[0].name
        self._w, self._h = input_size

    def alpha(self, frame_bgr):
        import cv2
        import numpy as np

        rgb = cv2.cvtColor(
            cv2.resize(frame_bgr, (self._w, self._h)), cv2.COLOR_BGR2RGB
        )
        x = (rgb.astype("f4") / 255.0 - 0.5) / 0.5
        x = np.transpose(x, (2, 0, 1))[None]
        out = self._sess.run(None, {self._name: x})[0][0, 0]
        return np.clip(out, 0.0, 1.0).astype("f4")


_RUNNERS = {"tflite": _MediapipeSeg, "onnxruntime": _ModnetSeg}


def _write_progress(path: str | None, done: int, total: int) -> None:
    if not path:
        return
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"done": done, "total": total}, f)
        os.replace(tmp, path)
    except OSError:
        pass


def key_video(params: dict) -> dict:
    import cv2
    import numpy as np

    video_path = params.get("video_path")
    out_path = params.get("out_path")
    ffmpeg = params.get("ffmpeg_path")
    models_dir = params.get("models_dir")
    if not video_path or not os.path.isfile(video_path):
        raise EngineError("BAD_PARAMS", f"video_path missing or unreadable: {video_path}")
    if not out_path:
        raise EngineError("BAD_PARAMS", "out_path is required")
    if not ffmpeg or not os.path.isfile(ffmpeg):
        raise EngineError("BAD_PARAMS", f"ffmpeg_path missing or unreadable: {ffmpeg}")
    if not models_dir:
        raise EngineError("BAD_PARAMS", "models_dir is required")

    model_name = params.get("model") or "mediapipe"
    despill = bool(params.get("despill", True))
    feather = float(params.get("feather", 1.0))
    smooth = max(0.0, min(1.0, float(params.get("smooth", 0.5))))
    max_dim = int(params.get("max_dim", 1920))
    progress_path = params.get("progress_path")

    spec = _models.MODELS.get(model_name)
    if spec is None:
        raise EngineError("MODEL_UNKNOWN", f"unknown matting model: {model_name!r}")
    if spec["loader"] == "onnxruntime":
        try:
            import onnxruntime  # noqa: F401
        except ImportError as e:
            raise EngineError(
                "MISSING_DEP",
                "model 'modnet' needs onnxruntime — run POST /api/engine/setup "
                "so the managed venv reinstalls the updated requirements.",
            ) from e
    model_path = _models.ensure_model(model_name, models_dir)
    runner = _RUNNERS[spec["loader"]](model_path, spec["input_size"])

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise EngineError("CORRUPT_VIDEO", f"cannot decode video: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if src_w <= 0 or src_h <= 0:
        cap.release()
        raise EngineError("CORRUPT_VIDEO", f"video has no usable frames: {video_path}")

    scale = min(1.0, max_dim / float(max(src_w, src_h)))
    # yuva420p needs even dims.
    w = max(2, int(src_w * scale) & ~1)
    h = max(2, int(src_h * scale) & ~1)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    part_path = out_path + ".part"
    cmd = [
        ffmpeg, "-v", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgra",
        "-s", f"{w}x{h}", "-r", f"{fps:.6f}",
        "-i", "pipe:0",
        "-an", "-sn", "-dn",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
        "-auto-alt-ref", "0", "-b:v", "0", "-crf", "20",
        "-deadline", "good", "-cpu-used", "4", "-row-mt", "1",
        # .part has no webm extension — the muxer must be forced.
        "-f", "webm",
        part_path,
    ]
    try:
        proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
    except OSError as e:
        cap.release()
        raise EngineError("ENGINE_ERROR", f"cannot spawn ffmpeg: {e}") from e

    done = 0
    prev = None
    err = None
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if frame.shape[1] != w or frame.shape[0] != h:
                frame = cv2.resize(frame, (w, h))
            alpha = runner.alpha(frame)
            alpha = cv2.resize(alpha, (w, h))
            alpha = np.clip((alpha - _ALPHA_LO) / (_ALPHA_HI - _ALPHA_LO), 0.0, 1.0)
            if prev is not None and smooth > 0.0:
                alpha = smooth * prev + (1.0 - smooth) * alpha
            prev = alpha.copy()
            if feather > 0.0:
                alpha = cv2.GaussianBlur(alpha, (0, 0), feather)
            if despill:
                # Alpha-weighted green-spill clamp (vf_despill defaults:
                # mix 0.5, key-channel scale −1) — semi-transparent edge
                # pixels get despilled, solid foreground keeps its greens.
                b = frame[:, :, 0].astype("f4")
                g = frame[:, :, 1].astype("f4")
                r = frame[:, :, 2].astype("f4")
                spill = np.maximum(g - (0.5 * r + 0.5 * b), 0.0) * (1.0 - alpha)
                frame[:, :, 1] = np.clip(g - spill, 0, 255).astype("u1")
            a8 = np.clip(alpha * 255.0 + 0.5, 0, 255).astype("u1")
            bgra = np.dstack([frame, a8])
            try:
                proc.stdin.write(bgra.tobytes())
            except (BrokenPipeError, OSError):
                err = "ffmpeg closed the pipe mid-encode"
                break
            done += 1
            if done % 10 == 0:
                _write_progress(progress_path, done, max(total, done))
        try:
            proc.stdin.close()
        except OSError:
            pass
        rc = proc.wait()
    finally:
        cap.release()
        _write_progress(progress_path, done, max(total, done))
        if proc.poll() is None:
            proc.kill()

    tail = (proc.stderr.read().decode("utf-8", "replace") if proc.stderr else "")[-600:]
    if err:
        raise EngineError("ENGINE_ERROR", f"{err}: {tail.strip()}")
    if rc != 0:
        raise EngineError("ENGINE_ERROR", f"ffmpeg webm encode failed (rc={rc}): {tail.strip()}")
    if done == 0:
        raise EngineError("CORRUPT_VIDEO", "video produced no frames")

    os.replace(part_path, out_path)
    return {"out": out_path, "frames": done, "width": w, "height": h,
            "fps": fps, "model": model_name}
