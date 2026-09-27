# Kaggle + ComfyUI + Wan 2.1

## Reproducible Setup Document

This document records the setup that was successfully established for
running ComfyUI with Wan 2.1 T2V 1.3B on Kaggle.

## Target environment

-   **Platform:** Kaggle
-   **GPU:** Tesla T4
-   **GPU count:** 2 × Tesla T4 detected
-   **VRAM:** \~14.9 GB reported
-   **Python:** 3.10.12
-   **PyTorch:** 2.5.1+cu121
-   **CUDA:** 12.1
-   **ComfyUI:** v0.30.0
-   **comfy-kitchen:** 0.2.26
-   **Model:** Wan 2.1 T2V 1.3B

### Critical compatibility lesson

> **Do not use the current ComfyUI master with Kaggle's PyTorch 2.5.1
> environment.**

The current master caused `comfy-kitchen` incompatibilities. The
successful solution was to pin ComfyUI to **v0.30.0** and
`comfy-kitchen` to **0.2.26**.

------------------------------------------------------------------------

# CELL 1 --- Clean installation

Run this first.

``` python
# ============================================================
# CELL 1 — CLEAN COMFYUI INSTALLATION
# ============================================================

%cd /kaggle/working

!rm -rf ComfyUI
!rm -f /tmp/cloudflared
!rm -f /kaggle/working/comfyui.log

print("Cloning ComfyUI...")

!git clone https://github.com/comfyanonymous/ComfyUI.git

%cd /kaggle/working/ComfyUI

print("Installing base requirements...")

!pip install --upgrade pip -q
!pip install -r requirements.txt -q

print("Installation complete.")
```

------------------------------------------------------------------------

# CELL 2 --- Pin the compatible ComfyUI version

**This is the important compatibility step.**

Do not leave ComfyUI on `master`.

``` python
# ============================================================
# CELL 2 — PIN COMFYUI TO v0.30.0
# ============================================================

%cd /kaggle/working/ComfyUI

!git fetch --tags --quiet

!git checkout -f v0.30.0

print("ComfyUI version:")
!git describe --tags --exact-match HEAD
```

Expected:

``` text
v0.30.0
```

------------------------------------------------------------------------

# CELL 3 --- Install compatible comfy-kitchen

Kaggle's environment has:

``` text
PyTorch 2.5.1+cu121
CUDA 12.1
```

Use:

``` text
comfy-kitchen 0.2.26
```

``` python
# ============================================================
# CELL 3 — COMPATIBLE COMFY-KITCHEN
# ============================================================

!pip uninstall -y comfy-kitchen -q
!pip install "comfy-kitchen==0.2.26" -q

import torch
import importlib.metadata

print("=" * 60)
print("ENVIRONMENT")
print("=" * 60)

print("PyTorch:", torch.__version__)
print("CUDA:", torch.version.cuda)

if torch.cuda.is_available():
    print("GPU:", torch.cuda.get_device_name(0))

print("comfy-kitchen:",
      importlib.metadata.version("comfy-kitchen"))
```

Expected:

``` text
PyTorch: 2.5.1+cu121
CUDA: 12.1
GPU: Tesla T4
comfy-kitchen: 0.2.26
```

------------------------------------------------------------------------

# CELL 4 --- Create model directories

``` python
# ============================================================
# CELL 4 — MODEL DIRECTORIES
# ============================================================

%cd /kaggle/working/ComfyUI

!mkdir -p models/diffusion_models
!mkdir -p models/vae
!mkdir -p models/clip
!mkdir -p models/checkpoints

print("Model directories created.")
```

------------------------------------------------------------------------

# CELL 5 --- Install ComfyUI Manager

``` python
# ============================================================
# CELL 5 — COMFYUI MANAGER
# ============================================================

%cd /kaggle/working/ComfyUI/custom_nodes

!rm -rf ComfyUI-Manager

!git clone https://github.com/ltdrdata/ComfyUI-Manager.git

print("ComfyUI Manager installed.")
```

------------------------------------------------------------------------

# CELL 6 --- Download Wan 2.1 1.3B

These are the files that successfully existed in the working
environment.

``` python
# ============================================================
# CELL 6 — WAN 2.1 1.3B
# ============================================================

%cd /kaggle/working/ComfyUI

print("--> Downloading Wan 2.1 1.3B diffusion model...")

!wget -O models/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors \
"https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors"

print("--> Downloading Wan VAE...")

!wget -O models/vae/wan_2.1_vae.safetensors \
"https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors"

print("--> Downloading UMT5 text encoder...")

!wget -O models/clip/umt5_xxl_fp8.safetensors \
"https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"

print("Wan downloads complete.")
```

### Verified files

``` text
wan2.1_t2v_1.3B_fp16.safetensors     2.64 GB
wan_2.1_vae.safetensors              0.24 GB
umt5_xxl_fp8.safetensors             6.27 GB
```

------------------------------------------------------------------------

# CELL 7 --- Optional LTX download

**Do not run this yet.**

The LTX file was missing, but LTX is not required to test Wan.

When LTX is added later, verify the correct current model and workflow
first rather than blindly reusing the earlier URL.

Leave this out of the initial setup.

------------------------------------------------------------------------

# CELL 8 --- Verify models

``` python
# ============================================================
# CELL 8 — VERIFY MODELS
# ============================================================

from pathlib import Path

base = Path("/kaggle/working/ComfyUI/models")

paths = {
    "Wan diffusion model":
        base / "diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors",

    "Wan VAE":
        base / "vae/wan_2.1_vae.safetensors",

    "Wan text encoder":
        base / "clip/umt5_xxl_fp8.safetensors",

    "LTX-Video":
        base / "checkpoints/ltx-video-2b-v0.9.1.safetensors",
}

print("=" * 70)
print("MODEL FILE CHECK")
print("=" * 70)

for name, path in paths.items():

    if path.exists():

        size_gb = path.stat().st_size / (1024**3)

        print(f"✓ {name}")
        print(f"  {size_gb:.2f} GB")

    else:

        print(f"✗ MISSING: {name}")

print("=" * 70)
```

At this point the three Wan files should show as `✓`.

LTX may correctly show as `✗ MISSING`; that is expected because LTX is
optional.

------------------------------------------------------------------------

# CELL 9 --- Start ComfyUI

Use `0.0.0.0`, not `127.0.0.1`.

This is important for the Cloudflare tunnel.

``` python
# ============================================================
# CELL 9 — START COMFYUI
# ============================================================

%cd /kaggle/working/ComfyUI

import subprocess
import time

!pkill -f "python main.py" || true

!rm -f /kaggle/working/comfyui.log

comfyui_log = open(
    "/kaggle/working/comfyui.log",
    "w"
)

comfy_process = subprocess.Popen(
    [
        "python",
        "main.py",
        "--listen",
        "0.0.0.0",
        "--port",
        "8188"
    ],
    stdout=comfyui_log,
    stderr=subprocess.STDOUT
)

print("Starting ComfyUI...")
print("Process ID:", comfy_process.pid)

time.sleep(15)

if comfy_process.poll() is None:

    print()
    print("=" * 60)
    print("STATUS: RUNNING")
    print("=" * 60)

else:

    print("STATUS: CRASHED")
    print("Exit code:", comfy_process.returncode)

    print()
    !tail -100 /kaggle/working/comfyui.log
```

Expected:

``` text
STATUS: RUNNING
```

------------------------------------------------------------------------

# CELL 10 --- Verify ComfyUI locally

``` python
# ============================================================
# CELL 10 — LOCAL COMFYUI TEST
# ============================================================

import requests

r = requests.get(
    "http://127.0.0.1:8188/",
    timeout=10
)

print("HTTP:", r.status_code)

if r.status_code == 200:
    print("ComfyUI: OK")
else:
    print("ComfyUI: ERROR")
```

Expected:

``` text
HTTP: 200
ComfyUI: OK
```

------------------------------------------------------------------------

# CELL 11 --- Install Cloudflare Tunnel

``` python
# ============================================================
# CELL 11 — CLOUDFLARE
# ============================================================

!pkill -f cloudflared || true
!rm -f /tmp/cloudflared

!wget -q -O /tmp/cloudflared \
"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"

!chmod +x /tmp/cloudflared

print("cloudflared installed.")
```

------------------------------------------------------------------------

# CELL 12 --- Create the public ComfyUI URL

``` python
# ============================================================
# CELL 12 — PUBLIC COMFYUI URL
# ============================================================

import subprocess
import time
import re

!pkill -f cloudflared || true

tunnel = subprocess.Popen(
    [
        "/tmp/cloudflared",
        "tunnel",
        "--url",
        "http://127.0.0.1:8188"
    ],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1
)

print("=" * 70)
print("WAITING FOR CLOUDFLARE URL")
print("=" * 70)

url = None

start = time.time()

while time.time() - start < 30:

    line = tunnel.stdout.readline()

    if line:

        match = re.search(
            r"https://[a-zA-Z0-9-]+\.trycloudflare\.com",
            line
        )

        if match:

            url = match.group(0)
            break

    time.sleep(0.5)

if url:

    print()
    print("=" * 70)
    print("COMFYUI PUBLIC URL")
    print("=" * 70)
    print()
    print(url)
    print()
    print("OPEN THIS URL IN YOUR BROWSER.")
    print("=" * 70)

else:

    print("Cloudflare URL was not detected.")
```

------------------------------------------------------------------------

# Resulting architecture

Once Cell 12 is running:

``` text
                 INTERNET
                     │
                     ▼
          Cloudflare Quick Tunnel
                     │
                     ▼
            Kaggle notebook
                     │
                     ▼
             ComfyUI :8188
                     │
                     ▼
              Tesla T4 GPU
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
      Wan 2.1 1.3B          Output MP4
```

## Operational notes

1.  Run the cells in order from Cell 1 through Cell 12.
2.  The Kaggle runtime is ephemeral. If the session is stopped or reset,
    the installation and downloaded models may need to be recreated
    unless you have persisted them separately.
3.  The public `trycloudflare.com` URL is temporary and changes when a
    new tunnel is created.
4.  Keep the Kaggle notebook session running while using the public
    ComfyUI URL.
5.  Wan 2.1 is the initial target. LTX should be added only after its
    model and workflow have been independently verified.
6.  If ComfyUI starts failing after package changes, recreate the
    environment using the pinned versions above rather than upgrading
    ComfyUI to the current master.
