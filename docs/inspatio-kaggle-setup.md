# Kaggle + InSpatio-World 1.5 + cloudflared

## Reproducible Setup Document

Companion to `Kaggle_ComfyUI_Wan21_Reproducible_Setup.md` — same pattern:
the GPU work happens in a Kaggle notebook, the local app reaches it through
a Cloudflare quick tunnel. Instead of ComfyUI we run
`scripts/inspatio_worker.py`, a thin FastAPI wrapper around the upstream
`run_scene_inference.py` from
https://github.com/inspatio/inspatio-world-v1.5

## Target environment

-   **Platform:** Kaggle (GPU session, T4 ×2 works; P100/L4x2 are better)
-   **Python:** conda env `inspatio_world_test` (Python 3.10, per
    `environment.yml` — NOT the notebook's own interpreter)
-   **Models:** InSpatio-World-1.5-1.3B, Wan2.1-T2V-1.3B (text encoder +
    VAE + config), DA3NESTED-GIANT-LARGE — fetched by the repo's own
    `pipeline/download.sh`
-   **Worker port:** 8199

### What the worker exposes

| Route | Purpose |
| --- | --- |
| `GET /health` | GPU name, torch/CUDA, checkpoint presence, busy flag |
| `POST /jobs` | multipart: `video`, `trajectory`, `prompt`, `output_id`, `seed`, `traj_scale`, `depth_mode` |
| `GET /jobs/{id}` | status + phase + log tail |
| `GET /jobs/{id}/result?file=pred.mp4` | result MP4 (pred/render/mask/source) |
| `POST /jobs/{id}/cancel` | kill the inference subprocess |

The Video Collector app (World Cam tab → `/api/world/*`) is the only client.

------------------------------------------------------------------------

# CELL 1 — Clone the repo

``` python
# ============================================================
# CELL 1 — CLONE INSPATIO-WORLD
# ============================================================

%cd /kaggle/working

!rm -rf inspatio-world-v1.5
!git clone https://github.com/inspatio/inspatio-world-v1.5.git

%cd /kaggle/working/inspatio-world-v1.5
!git log --oneline -1
```

Pin to the recorded commit once one is proven (edit `KAGGLE_COMMIT` below
later); `main` is fine to start — the repo only has a handful of commits.

------------------------------------------------------------------------

# CELL 2 — Conda environment

Kaggle ships conda at `/opt/conda`. The env is large (~10 GB) — this cell
takes a while and only needs to run once per session.

``` python
# ============================================================
# CELL 2 — CONDA ENVIRONMENT
# ============================================================

%cd /kaggle/working/inspatio-world-v1.5

!conda env create -f environment.yml -y

# Depth-Anything-3 without its app/bench deps, plus the worker's HTTP deps.
!conda run -n inspatio_world_test python -m pip install --no-deps "depth-anything-3==0.1.1"
!conda run -n inspatio_world_test python -m pip install fastapi "uvicorn[standard]" python-multipart

print("Environment ready.")
```

> If `conda env create` is too slow, `conda install -n base mamba` then
> `mamba env create -f environment.yml` resolves much faster.

------------------------------------------------------------------------

# CELL 3 — Model checkpoints

Downloads ~15 GB from HuggingFace: the InSpatio checkpoint, the full
Wan2.1-T2V-1.3B repo (git-lfs), and DA3 giant weights.

``` python
# ============================================================
# CELL 3 — MODEL CHECKPOINTS (~15 GB)
# ============================================================

%cd /kaggle/working/inspatio-world-v1.5

# huggingface_hub + git-lfs for the download script.
!conda run -n inspatio_world_test python -m pip install -U "huggingface_hub[cli]"
!apt-get -qq install git-lfs && git lfs install

# If any HF repo is gated/rate-limited, set a token first:
# import os; os.environ["HF_TOKEN"] = "hf_..."

!conda run -n inspatio_world_test bash pipeline/download.sh

!ls -la checkpoints/InSpatio-World-1.3B checkpoints/depth
!ls checkpoints/Wan2.1-T2V-1.3B | head
```

Expected: `checkpoints/InSpatio-World-1.3B/InSpatio-World-1.5-1.3B.safetensors`,
`checkpoints/Wan2.1-T2V-1.3B/`, `checkpoints/depth/{config.json,model.safetensors}`.

------------------------------------------------------------------------

# CELL 4 — The worker script

`inspatio_worker.py` lives in THIS repo (`scripts/inspatio_worker.py`). Get it
onto Kaggle by either:

- uploading it into the notebook (right sidebar → "Add Data"/file upload, or
  attach it as a Kaggle Dataset), then `!cp` it into the checkout; or
- a `%%writefile /kaggle/working/inspatio-world-v1.5/inspatio_worker.py` cell
  with the file's contents pasted in.

``` python
# ============================================================
# CELL 4 — PLACE THE WORKER SCRIPT
# ============================================================

import shutil, os

# Adjust the source to wherever the file was uploaded/attached.
src = "/kaggle/working/inspatio_worker.py"
dst = "/kaggle/working/inspatio-world-v1.5/inspatio_worker.py"
if os.path.exists(src):
    shutil.copy(src, dst)
print("worker present:", os.path.exists(dst))
```

------------------------------------------------------------------------

# CELL 5 — Start the worker

``` python
# ============================================================
# CELL 5 — START INSPATIO WORKER (:8199)
# ============================================================

import subprocess, time

!pkill -f inspatio_worker.py || true

worker_log = open("/kaggle/working/inspatio_worker.log", "w")
worker_proc = subprocess.Popen(
    [
        "conda", "run", "-n", "inspatio_world_test", "--no-capture-output",
        "python", "inspatio_worker.py",
        "--root", "/kaggle/working/inspatio-world-v1.5",
        "--host", "0.0.0.0", "--port", "8199",
    ],
    stdout=worker_log, stderr=subprocess.STDOUT,
)
print("PID:", worker_proc.pid)
time.sleep(10)

import requests
print(requests.get("http://127.0.0.1:8199/health", timeout=10).json())
```

Expected `/health`: `ok: true`, `gpu: "Tesla T4"` (or similar), all three
`checkpoints` true. If `ok` fails, `!tail -80 /kaggle/working/inspatio_worker.log`.

> **Shared secret (recommended):** the tunnel URL is public. Set the same
> token on both sides —
> `import os; os.environ["INSPATIO_TOKEN"] = "…"` in the cell *before* the
> `Popen`, and `INSPATIO_TOKEN=…` in the app's `.env.local`.

------------------------------------------------------------------------

# CELL 6 — Cloudflare tunnel

Identical to the ComfyUI doc — same `cloudflared` binary, different port.

``` python
# ============================================================
# CELL 6 — CLOUDFLARE TUNNEL → :8199
# ============================================================

import subprocess, time, re

!pkill -f cloudflared || true
!wget -q -O /tmp/cloudflared \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
!chmod +x /tmp/cloudflared

tunnel = subprocess.Popen(
    ["/tmp/cloudflared", "tunnel", "--url", "http://127.0.0.1:8199"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
)

url = None
start = time.time()
while time.time() - start < 30:
    line = tunnel.stdout.readline()
    if line:
        m = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", line)
        if m:
            url = m.group(0)
            break
    time.sleep(0.5)

print("=" * 60)
print(url or "no URL detected — check cloudflared output")
print("=" * 60)
```

------------------------------------------------------------------------

# Hook up the app

Paste the `*.trycloudflare.com` URL into the **World Cam** tab's endpoint
field (session override), or set `INSPATIO_ENDPOINT=<url>` in `.env.local`
before `npm run dev` — the session field wins and is friendlier to the
rotating URL.

# Resulting architecture

``` text
   VIDEO COLLECT app (this PC)                KAGGLE
   World Cam tab ──► /api/world/* ──► HTTPS ──► cloudflared
        │                                        │
        │                                   inspatio_worker.py :8199
        │                                        │
        │                              run_scene_inference.py
        │                                   (conda env, GPU)
        │                                        │
        └────── pred.mp4 ──► assets/world/ ◄──── output/<id>/pred.mp4
             (syncProjectAssets → Library/Folders/Visualizer layers)
```

## Operational notes

1.  Run cells in order. A stopped Kaggle session loses the venv, checkpoints
    and tunnel — rerun everything (checkpoint download is the slow part;
    consider a Kaggle Dataset holding `checkpoints/` for warm starts).
2.  The trycloudflare URL changes every tunnel — re-save the endpoint in the
    World Cam tab each session.
3.  One job at a time — the worker 409s while busy and the app serializes too.
4.  `target_tcw.txt` uses first-frame-normalized OpenCV world-to-camera
    matrices whose translation scale must roughly match DA3's estimated
    source cameras. The app's presets emit normalized units; the `strength`
    slider and the worker's `traj_scale` multiplier tune the effective move —
    start at strength 1 / traj_scale 1 and adjust if the camera barely moves.
5.  Licenses: inspatio-world code is Apache-2.0; Wan2.1, Depth-Anything-3 and
    the InSpatio weights carry their own licenses — check them before using
    outputs commercially.
6.  T4 15 GB is tight for the 1.3B DiT + UMT5-XXL + DA3-giant stack; keep
    source clips short (a few seconds) and let it be slow rather than OOM.
