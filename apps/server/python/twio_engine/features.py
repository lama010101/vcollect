"""Per-stem audio feature extraction (librosa / NumPy / SciPy).

Called via worker.py's `analyze_stem` method. Input is always raw mono
little-endian float32 PCM — the Node server decodes any uploaded audio
through its shared FFmpeg service first, so this module never touches
compressed formats itself.

Everything is deterministic: same PCM → same features. Outputs are written
into `params.out_dir`:

    manifest.json   feature metadata + onset/beat lists
    bands.f32       (n_bands × n_frames) LE f32, row-major
    env.f32         (n_frames,) LE f32 — RMS energy envelope
    onset_env.f32   (n_frames,) LE f32 — spectral-flux onset strength
"""

import json
import os

from .worker import EngineError

FEATURE_VERSION = 2
HOP_LENGTH = 512
N_FFT = 2048

# Perceptual bands (Hz). `presence` tops out at Nyquist/2 of the 22050 Hz
# analysis rate, so all six bands always have bins.
BANDS = [
    ("sub", 20.0, 60.0),
    ("bass", 60.0, 250.0),
    ("lowmid", 250.0, 500.0),
    ("mid", 500.0, 2000.0),
    ("highmid", 2000.0, 6000.0),
    ("presence", 6000.0, 10500.0),
]


def _norm(series):
    """Scale to [0,1] by the 95th percentile (robust to transients)."""
    import numpy as np

    peak = float(np.percentile(series, 95)) if series.size else 0.0
    if peak <= 1e-8:
        return np.zeros_like(series, dtype="<f4")
    return np.clip(series / peak, 0.0, 1.0).astype("<f4")


def analyze_stem(params):
    import numpy as np
    import librosa

    pcm_path = params.get("pcm_path")
    out_dir = params.get("out_dir")
    sr = int(params.get("sr") or 0)
    if not pcm_path or not os.path.isfile(pcm_path):
        raise EngineError("BAD_PARAMS", f"pcm_path missing or unreadable: {pcm_path}")
    if not out_dir:
        raise EngineError("BAD_PARAMS", "out_dir is required")
    if sr <= 0:
        raise EngineError("BAD_PARAMS", f"invalid sample rate: {sr}")

    y = np.memmap(pcm_path, dtype="<f4", mode="r")
    if y.size < HOP_LENGTH:
        raise EngineError("CORRUPT_AUDIO", f"decoded PCM too short ({y.size} samples)")

    duration = float(y.size) / sr

    # --- onset envelope → onsets + beat track --------------------------------
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_LENGTH)
    # backtrack=True snaps each onset to the foot of its rise (accurate hit
    # time, ~0 strength); the non-backtracked peak frames carry the strength.
    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env, sr=sr, hop_length=HOP_LENGTH,
        backtrack=True, units="frames",
    )
    peak_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env, sr=sr, hop_length=HOP_LENGTH,
        backtrack=False, units="frames",
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=HOP_LENGTH)
    onset_str = onset_env[peak_frames] if peak_frames.size else np.zeros(0)
    onset_str = _norm(onset_str)

    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=sr, hop_length=HOP_LENGTH,
    )
    tempo = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP_LENGTH)
    beat_str = onset_env[beat_frames] if beat_frames.size else np.zeros(0)
    beat_str = _norm(beat_str)

    # --- band envelopes + rms --------------------------------------------------
    S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP_LENGTH))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)
    band_rows = []
    for _name, lo, hi in BANDS:
        mask = (freqs >= lo) & (freqs < hi)
        if mask.any():
            band_rows.append(np.sqrt((S[mask] ** 2).mean(axis=0)))
        else:
            band_rows.append(np.zeros(S.shape[1]))
    bands = np.stack([_norm(b) for b in band_rows])  # (n_bands, n_frames)

    rms = librosa.feature.rms(y=y, hop_length=HOP_LENGTH)[0]
    env = _norm(rms)

    n_frames = int(bands.shape[1])
    feature_rate = float(sr) / HOP_LENGTH

    os.makedirs(out_dir, exist_ok=True)
    bands.astype("<f4").tofile(os.path.join(out_dir, "bands.f32"))
    env.tofile(os.path.join(out_dir, "env.f32"))
    _norm(onset_env).tofile(os.path.join(out_dir, "onset_env.f32"))

    manifest = {
        "version": FEATURE_VERSION,
        "duration": duration,
        "sampleRate": sr,
        "hopLength": HOP_LENGTH,
        "featureRate": feature_rate,
        "frames": n_frames,
        "tempo": tempo,
        "bands": [name for name, _lo, _hi in BANDS],
        "bandRanges": [[lo, hi] for _n, lo, hi in BANDS],
        "onsets": [
            {"time": round(float(t), 6), "strength": round(float(s), 6)}
            for t, s in zip(onset_times, onset_str)
        ],
        "beats": [
            {"time": round(float(t), 6), "strength": round(float(s), 6)}
            for t, s in zip(beat_times, beat_str)
        ],
        "files": {"bands": "bands.f32", "env": "env.f32", "onsetEnv": "onset_env.f32"},
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, separators=(",", ":"))
    return manifest
