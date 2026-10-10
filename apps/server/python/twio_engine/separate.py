"""Song → stems separation.

Called via worker.py's `separate_stems` method. The Node server decodes the
uploaded song to a plain WAV first, so this module reads it with soundfile.

Two backends:

- `quality="fast"` — librosa harmonic/percussive source separation plus a
  low-band split. Produces `drums`, `bass`, `other` in seconds with zero
  extra dependencies. No `vocals` stem is emitted — HPSS can't isolate a
  voice, so the UI shows exactly what the algorithm really extracted.
- `quality="hq"` — Meta's Demucs (`htdemucs`) on CPU: `drums`, `bass`,
  `other`, `vocals`. Requires the separation extras (torch CPU + demucs —
  provisioned on demand by POST /api/visualizer/sep-setup, ~600 MB).
  The htdemucs weights (~80 MB) download on first run via torch hub.

Everything is deterministic: same input + params → same output files.
Outputs land in `params.out_dir` as `<name>.wav` and the server moves them
into the project's stems folder.
"""

import json
import os

from .worker import EngineError

# htdemucs source order — demucs names them "drums", "bass", "other",
# "vocals" (model.sources is authoritative; this is only a doc hint).
DEMUCS_MODEL = "htdemucs"


def _write_progress(path, done, total, phase=""):
    """Same sidecar protocol as matting.py — the server polls it."""
    if not path:
        return
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"done": done, "total": total, "phase": phase}, f)
        os.replace(tmp, path)
    except OSError:
        pass  # progress is best-effort — never fail the call over it


def _read_stereo(path):
    import soundfile as sf

    data, sr = sf.read(path, dtype="float32", always_2d=True)  # (T, C)
    if data.shape[0] == 0:
        raise EngineError("CORRUPT_AUDIO", f"decoded audio is empty: {path}")
    # (C, T) — channel axis first, mono duplicated to stereo for mask math,
    # extra channels (5.1 etc.) folded to the first two.
    y = data.T
    if y.shape[0] == 1:
        y = y.repeat(2, axis=0)
    return y[:2, :], sr


def _write_stem(out_dir, name, y, sr):
    import numpy as np
    import soundfile as sf

    # Gentle limiter so mask math can't clip the output wavs.
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    if peak > 0.98:
        y = y * (0.98 / peak)
    path = os.path.join(out_dir, f"{name}.wav")
    sf.write(path, y.T, sr, subtype="PCM_16")
    return path


def separate_stems(params: dict) -> dict:
    src = params.get("src_path")
    out_dir = params.get("out_dir")
    quality = params.get("quality") or "fast"
    progress_path = params.get("progress_path")
    if not src or not os.path.isfile(src):
        raise EngineError("BAD_PARAMS", f"src_path missing or unreadable: {src}")
    if not out_dir:
        raise EngineError("BAD_PARAMS", "out_dir is required")
    os.makedirs(out_dir, exist_ok=True)

    if quality == "hq":
        return _separate_demucs(src, out_dir, progress_path)
    return _separate_fast(src, out_dir, progress_path)


def _separate_fast(src, out_dir, progress_path):
    """HPSS + low-band split — drums / bass / other."""
    import librosa
    import numpy as np

    y, sr = _read_stereo(src)
    mono = y.mean(axis=0)
    _write_progress(progress_path, 0, 4, "separating (HPSS)")

    # Soft ratio masks computed on the mono STFT, applied per channel — keeps
    # the stereo image and splits energy cleanly.
    S = np.abs(librosa.stft(mono, n_fft=2048, hop_length=512))
    H, P = librosa.decompose.hpss(S, kernel_size=(17, 31))
    den = H + P + 1e-10
    hm = H / den
    pm = P / den
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    low = (freqs < 250.0).reshape(-1, 1)

    stems = {}
    for i, (name, mask) in enumerate(
        (
            ("drums", pm),
            ("bass", hm * low),
            ("other", hm * (1.0 - low)),
        )
    ):
        chans = []
        for c in range(y.shape[0]):
            Sc = librosa.stft(y[c], n_fft=2048, hop_length=512)
            chans.append(librosa.istft(Sc * mask, hop_length=512, length=y.shape[1]))
        stems[name] = np.stack(chans)
        _write_progress(progress_path, i + 1, 4, f"extracted {name}")

    _write_progress(progress_path, 3, 4, "writing stems")
    files = {name: _write_stem(out_dir, name, chans, sr) for name, chans in stems.items()}
    _write_progress(progress_path, 4, 4, "done")
    return {"backend": "hpss", "stems": [{"name": n, "path": p} for n, p in files.items()]}


def _separate_demucs(src, out_dir, progress_path):
    """Meta htdemucs on CPU — drums / bass / other / vocals."""
    try:
        import torch
        import soundfile as sf
        from demucs.apply import apply_model
        from demucs.pretrained import get_model
    except ImportError as e:
        raise EngineError(
            "SEP_DEPS_MISSING",
            "High-quality separation needs the separation extras "
            "(torch CPU + demucs). Set them up with "
            "POST /api/visualizer/sep-setup — ~600 MB one-time install. "
            f"(import failed: {e})",
        )

    _write_progress(progress_path, 0, 3, "loading htdemucs (downloads ~80 MB on first run)")
    model = get_model(DEMUCS_MODEL)
    y, sr = _read_stereo(src)
    wav = torch.from_numpy(y).float()
    _write_progress(progress_path, 1, 3, f"separating ({DEMUCS_MODEL}, CPU — roughly realtime)")
    est = apply_model(model, wav, device="cpu", shifts=1, split=True, overlap=0.25)
    _write_progress(progress_path, 2, 3, "writing stems")
    files = {}
    for i, name in enumerate(model.sources):
        stem = est[i].cpu().numpy()
        files[name] = _write_stem(out_dir, name, stem, model.samplerate)
        _write_progress(progress_path, 2 + (i + 1) / max(1, len(model.sources)), 3, f"wrote {name}")
    _write_progress(progress_path, 3, 3, "done")
    return {"backend": DEMUCS_MODEL, "stems": [{"name": n, "path": p} for n, p in files.items()]}


def sep_status(_params=None):
    """Report which separation backends are importable in this env."""
    import importlib.util

    return {
        "fast": True,  # librosa ships with the base deps
        "demucs": importlib.util.find_spec("demucs") is not None,
        "torch": importlib.util.find_spec("torch") is not None,
    }
