#!/usr/bin/env python3
"""inspatio_worker.py — thin HTTP worker that wraps run_scene_inference.py.

Runs ON THE GPU HOST, inside the inspatio-world conda environment, with the
inspatio-world checkout as --root (default: the directory containing this
script's parent — pass --root explicitly on Kaggle).

    python inspatio_worker.py --root /kaggle/working/inspatio-world-v1.5 \
        --host 0.0.0.0 --port 8199

Then front it with a cloudflared quick tunnel and point the Video Collector
app at the trycloudflare URL (INSPATIO_ENDPOINT or the World Cam tab's
endpoint field). Set INSPATIO_TOKEN on both sides to require a bearer token.

Endpoints:
    GET  /health                      → gpu/torch/checkpoint status
    POST /jobs                        → multipart: video, trajectory,
                                        prompt, output_id, seed, traj_scale,
                                        depth_mode  → {job_id}
    GET  /jobs/{id}                   → {status, phase, log_tail, error}
    GET  /jobs/{id}/files             → result files + sizes
    GET  /jobs/{id}/result?file=…     → pred.mp4 | render.mp4 | mask.mp4 | source.mp4
    POST /jobs/{id}/cancel            → kill the inference subprocess
    DELETE /jobs/{id}                 → remove uploads + outputs

One job at a time — the GPU is the bottleneck (409 when busy).
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

try:
    import numpy as np
except ImportError:  # numpy ships with the inspatio env; fail loudly otherwise
    print("inspatio_worker requires numpy — run it in the inspatio conda env", file=sys.stderr)
    raise

try:
    from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
    from fastapi.responses import FileResponse
    import uvicorn
except ImportError:
    print(
        "Missing deps: pip install fastapi 'uvicorn[standard]' python-multipart",
        file=sys.stderr,
    )
    raise

ROOT = Path(__file__).resolve().parent  # overridden by --root in main()
UPLOADS = ROOT / "worker_uploads"
RESULT_FILES = {"pred.mp4", "render.mp4", "mask.mp4", "source.mp4"}
TOKEN = os.environ.get("INSPATIO_TOKEN", "").strip()

app = FastAPI(title="inspatio-worker", version="1.0.0")


async def auth(request: Request):
    if not TOKEN:
        return
    header = request.headers.get("authorization", "")
    if header != f"Bearer {TOKEN}":
        raise HTTPException(401, "bad or missing bearer token")


# --- job registry --------------------------------------------------------------

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()


def active_job() -> dict | None:
    with JOBS_LOCK:
        for j in JOBS.values():
            if j["status"] in ("queued", "running"):
                return j
    return None


def job_or_404(job_id: str) -> dict:
    with JOBS_LOCK:
        j = JOBS.get(job_id)
    if j is None:
        raise HTTPException(404, f"unknown job: {job_id}")
    return j


def log_tail(path: Path, lines: int = 60) -> str:
    try:
        data = path.read_text(errors="replace").replace("\r", "\n")
    except OSError:
        return ""
    return "\n".join(data.splitlines()[-lines:])


def phase_from_log(text: str) -> str:
    if "All scenes completed" in text:
        return "done"
    if "Infer " in text and " scenes" in text:
        return "inference"
    if "Validated" in text:
        return "depth"
    return "preparing"


def watch_process(job_id: str) -> None:
    """Wait for the inference subprocess and settle the job record."""
    j = JOBS[job_id]
    proc: subprocess.Popen = j["proc"]
    code = proc.wait()
    try:
        j["log_fp"].close()
    except Exception:
        pass
    with JOBS_LOCK:
        if j["status"] == "cancelled":
            return
        tail = log_tail(j["log_path"])
        if code == 0 and (j["output_dir"] / "pred.mp4").is_file():
            j["status"] = "done"
            j["phase"] = "done"
        elif code == 0:
            j["status"] = "failed"
            j["error"] = "inference exited 0 but pred.mp4 is missing"
            j["phase"] = "failed"
        else:
            j["status"] = "failed"
            j["error"] = f"run_scene_inference exited {code}"
            j["phase"] = "failed"
        j["log_tail"] = tail
        j["proc"] = None


def scale_trajectory(traj_path: Path, scale: float) -> None:
    """Multiply the translation column of every 4x4 Tcw by `scale`."""
    if scale == 1.0:
        return
    m = np.loadtxt(traj_path, ndmin=2).astype(np.float64)
    if m.shape[1] != 16:
        raise HTTPException(422, "trajectory must have 16 numbers per line")
    mats = m.reshape(-1, 4, 4)
    mats[:, :3, 3] *= scale
    np.savetxt(traj_path, mats.reshape(-1, 16), fmt="%.8f")


# --- routes ---------------------------------------------------------------------


@app.get("/health")
async def health(_=Depends(auth)):
    gpu, cuda_ver, torch_ver = None, None, None
    try:
        import torch

        torch_ver = torch.__version__
        if torch.cuda.is_available():
            gpu = torch.cuda.get_device_name(0)
            cuda_ver = torch.version.cuda
    except Exception:
        pass
    if gpu is None:
        try:
            out = subprocess.run(
                ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=10,
            )
            gpu = out.stdout.strip().splitlines()[0] if out.returncode == 0 else None
        except Exception:
            pass
    ck = ROOT / "checkpoints"
    return {
        "ok": True,
        "gpu": gpu,
        "cuda": cuda_ver,
        "torch": torch_ver,
        "busy": active_job() is not None,
        "root": str(ROOT),
        "checkpoints": {
            "inspatio": (ck / "InSpatio-World-1.3B" / "InSpatio-World-1.5-1.3B.safetensors").is_file(),
            "wan": (ck / "Wan2.1-T2V-1.3B").is_dir(),
            "depth": (ck / "depth").is_dir(),
        },
    }


@app.post("/jobs")
async def submit_job(
    _=Depends(auth),
    video: UploadFile = File(...),
    trajectory: UploadFile = File(...),
    prompt: str = Form(...),
    output_id: str = Form(...),
    seed: int = Form(0),
    traj_scale: float = Form(1.0),
    depth_mode: str = Form("auto"),
):
    if active_job() is not None:
        raise HTTPException(409, "a job is already running on this worker")
    if not prompt.strip():
        raise HTTPException(422, "prompt is empty")
    if depth_mode not in ("auto", "existing", "estimate"):
        raise HTTPException(422, f"bad depth_mode: {depth_mode}")
    output_id = re.sub(r"[^A-Za-z0-9_.-]", "_", output_id)[:80] or uuid.uuid4().hex[:12]

    job_id = uuid.uuid4().hex[:12]
    work = UPLOADS / job_id
    work.mkdir(parents=True, exist_ok=True)
    video_path = work / "input.mp4"
    traj_path = work / "target_tcw.txt"
    log_path = work / "run.log"

    video_path.write_bytes(await video.read())
    traj_path.write_bytes(await trajectory.read())
    try:
        scale_trajectory(traj_path, traj_scale)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(422, f"bad trajectory file: {e}")

    cmd = [
        sys.executable, "-u", str(ROOT / "run_scene_inference.py"),
        "--video", str(video_path),
        "--prompt", prompt.strip(),
        "--target_traj", str(traj_path),
        "--output_id", output_id,
        "--seed", str(seed),
        "--depth_mode", depth_mode,
    ]
    log_fp = open(log_path, "w", buffering=1)
    proc = subprocess.Popen(
        cmd, cwd=str(ROOT), stdout=log_fp, stderr=subprocess.STDOUT,
        start_new_session=True,  # own process group → cancel kills children too
    )
    j = {
        "id": job_id,
        "status": "running",
        "phase": "preparing",
        "proc": proc,
        "log_fp": log_fp,
        "log_path": log_path,
        "output_id": output_id,
        "output_dir": ROOT / "output" / output_id,
        "work_dir": work,
        "error": None,
        "log_tail": "",
        "submitted_at": time.time(),
    }
    with JOBS_LOCK:
        JOBS[job_id] = j
    threading.Thread(target=watch_process, args=(job_id,), daemon=True).start()
    return {"job_id": job_id, "status": "running", "output_id": output_id}


@app.get("/jobs/{job_id}")
async def job_status(job_id: str, _=Depends(auth)):
    j = job_or_404(job_id)
    tail = log_tail(j["log_path"]) if j["status"] == "running" else (j["log_tail"] or log_tail(j["log_path"]))
    return {
        "status": j["status"],
        "phase": j["phase"] if j["status"] != "running" else phase_from_log(tail),
        "log_tail": tail,
        "error": j["error"],
        "output_id": j["output_id"],
    }


@app.get("/jobs/{job_id}/files")
async def job_files(job_id: str, _=Depends(auth)):
    j = job_or_404(job_id)
    out = j["output_dir"]
    files = {}
    if out.is_dir():
        for f in sorted(out.glob("*.mp4")):
            files[f.name] = f.stat().st_size
    return {"files": files}


@app.get("/jobs/{job_id}/result")
async def job_result(job_id: str, file: str = "pred.mp4", _=Depends(auth)):
    j = job_or_404(job_id)
    if file not in RESULT_FILES:
        raise HTTPException(422, f"file must be one of {sorted(RESULT_FILES)}")
    path = j["output_dir"] / file
    if not path.is_file():
        raise HTTPException(404, f"{file} not produced (job status: {j['status']})")
    return FileResponse(path, media_type="video/mp4", filename=file)


@app.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str, _=Depends(auth)):
    j = job_or_404(job_id)
    proc: subprocess.Popen | None = j["proc"]
    if proc is None or proc.poll() is not None:
        return {"status": j["status"]}
    with JOBS_LOCK:
        j["status"] = "cancelled"
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        proc.terminate()
    return {"status": "cancelled"}


@app.delete("/jobs/{job_id}")
async def delete_job(job_id: str, _=Depends(auth)):
    j = job_or_404(job_id)
    if j["status"] in ("queued", "running"):
        raise HTTPException(409, "job still running — cancel first")
    import shutil

    shutil.rmtree(j["work_dir"], ignore_errors=True)
    shutil.rmtree(j["output_dir"], ignore_errors=True)
    with JOBS_LOCK:
        JOBS.pop(job_id, None)
    return {"ok": True}


def main() -> None:
    global ROOT, UPLOADS
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT,
                        help="inspatio-world checkout (contains run_scene_inference.py)")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8199)
    args = parser.parse_args()
    ROOT = args.root.resolve()
    if not (ROOT / "run_scene_inference.py").is_file():
        print(f"error: {ROOT} does not contain run_scene_inference.py", file=sys.stderr)
        sys.exit(2)
    UPLOADS = ROOT / "worker_uploads"
    UPLOADS.mkdir(parents=True, exist_ok=True)
    print(f"[inspatio-worker] root={ROOT} port={args.port} token={'set' if TOKEN else 'NONE'}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
