"""Matting model registry — download-on-demand with sha256 pinning.

Models live under `<models_dir>` (the server passes OUTPUT_ROOT/cache/models).
Each entry lists mirror URLs tried in order; the downloaded bytes must match
the pinned sha256 before the file is kept. All models are Apache-2.0 —
no GPL RVM (license note kept for reviewers).
"""

import hashlib
import os
import urllib.request

from .worker import EngineError

MODELS = {
    # Google MediaPipe Selfie Segmentation (landscape variant — the one the
    # video-mode API uses). Input NCHW 1x3x144x256 float32 [0,1]; output is a
    # 1x1x144x256 foreground-probability mask. ~250 KB. Runs through
    # cv2.dnn.readNetFromTFLite — no extra deps.
    "mediapipe": {
        "file": "selfie_segmenter_landscape.tflite",
        "urls": [
            "https://storage.googleapis.com/mediapipe-models/image_segmenter/"
            "selfie_segmenter_landscape/float16/1/selfie_segmenter_landscape.tflite",
        ],
        "sha256": "490e9ea734313e0de10fa0cd9e3c6133e36ea4db2b7a49bde9ef019f72796b8e",
        "loader": "tflite",
        "input_size": (256, 144),  # (w, h)
        "license": "Apache-2.0",
        "label": "MediaPipe Selfie Segmentation — fast, light edges",
    },
    # MODNet photographic portrait matting (ONNX export from the official
    # checkpoint). Dynamic HxW; we feed 512x512. ~25 MB. cv2.dnn cannot parse
    # its dynamic-shape Concat nodes → onnxruntime.
    "modnet": {
        "file": "modnet_photographic_portrait_matting.onnx",
        "urls": [
            "https://huggingface.co/DavG25/modnet-pretrained-models/resolve/main/"
            "models/modnet_photographic_portrait_matting.onnx",
            "https://huggingface.co/TheEeeeLin/HivisionIDPhotos_matting/resolve/main/"
            "modnet_photographic_portrait_matting.onnx",
        ],
        "sha256": "07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9",
        "loader": "onnxruntime",
        "input_size": (512, 512),
        "license": "Apache-2.0",
        "label": "MODNet — slower, cleaner hair edges",
    },
}


def ensure_model(name: str, models_dir: str) -> str:
    """Return the local path of model `name`, downloading it on first use.

    Raises EngineError(MODEL_UNKNOWN / MODEL_DOWNLOAD_FAILED /
    MODEL_HASH_MISMATCH)."""
    spec = MODELS.get(name)
    if spec is None:
        raise EngineError(
            "MODEL_UNKNOWN",
            f"unknown matting model {name!r} (available: {', '.join(MODELS)})",
        )
    os.makedirs(models_dir, exist_ok=True)
    path = os.path.join(models_dir, spec["file"])
    if os.path.isfile(path):
        if _sha256(path) == spec["sha256"]:
            return path
        os.remove(path)  # stale/corrupt — refetch

    last_err = None
    for url in spec["urls"]:
        tmp = path + ".part"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "twio-engine"})
            with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
            if _sha256(tmp) != spec["sha256"]:
                os.remove(tmp)
                raise EngineError(
                    "MODEL_HASH_MISMATCH",
                    f"downloaded {spec['file']} failed sha256 verification",
                )
            os.replace(tmp, path)
            return path
        except EngineError:
            raise
        except Exception as e:  # noqa: BLE001 — try the next mirror
            last_err = e
            try:
                os.remove(tmp)
            except OSError:
                pass
    raise EngineError(
        "MODEL_DOWNLOAD_FAILED",
        f"could not download {spec['file']}: {last_err}",
    )


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
