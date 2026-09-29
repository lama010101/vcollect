#!/usr/bin/env python3
"""Detect beats in a decoded PCM WAV file and print a JSON result to stdout.

Invoked by apps/server/src/musicEdit/beatAnalysis.ts, which decodes the song
to mono PCM WAV through the shared FFmpeg service first. Beat times come from
librosa's onset-envelope dynamic-programming tracker, so they follow the real
recording (they are never a fixed BPM grid).

Usage: beat_analysis.py <input.wav> [--hop-length N]
Exit codes: 0 ok, 2 bad input / unreadable audio, 3 missing dependency.
"""

import argparse
import json
import sys


def fail(code: int, message: str) -> None:
    print(json.dumps({"error": message}), file=sys.stderr)
    sys.exit(code)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("--hop-length", type=int, default=256)
    args = parser.parse_args()

    try:
        import numpy as np
        import librosa
        import soundfile as sf
    except ImportError as e:  # pragma: no cover - environment dependent
        fail(3, f"missing python dependency: {e.name}. Run: pip install -r apps/server/python/requirements.txt")

    try:
        y, sr = sf.read(args.input, dtype="float32", always_2d=False)
    except Exception as e:  # noqa: BLE001
        fail(2, f"cannot read decoded audio: {e}")
    if y.ndim > 1:
        y = y.mean(axis=1)
    if y.size == 0:
        fail(2, "decoded audio is empty")

    hop = args.hop_length
    duration = float(y.size) / float(sr)
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=sr, hop_length=hop, units="frames"
    )
    tempo_value = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)
    peak = float(onset_env.max()) if onset_env.size else 0.0

    beats = []
    for frame, t in zip(beat_frames, beat_times):
        idx = int(min(max(frame, 0), onset_env.size - 1)) if onset_env.size else 0
        strength = float(onset_env[idx]) / peak if peak > 0 else 0.0
        beats.append({"time": round(float(t), 6), "strength": round(strength, 4)})

    print(
        json.dumps(
            {
                "bpm": round(tempo_value, 3),
                "duration": round(duration, 6),
                "beats": beats,
                "downbeats": None,
                "analyzer": {
                    "name": "librosa.beat.beat_track",
                    "version": librosa.__version__,
                    "sampleRate": int(sr),
                    "hopLength": hop,
                },
            }
        )
    )


if __name__ == "__main__":
    main()
