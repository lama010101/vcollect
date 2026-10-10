"""twio engine worker — NDJSON stdio RPC server.

Reads one JSON request per line on stdin:
    {"id": "<any>", "method": "<name>", "params": {...}}
and writes exactly one JSON response per line on stdout:
    {"id": "<same>", "ok": true,  "result": ...}
    {"id": "<same>", "ok": false, "error": {"code": "...", "message": "...",
                                           "trace": [...]}}

Design rules:
- Method bodies are imported lazily so `ping` never pays for numpy/librosa.
- Everything is deterministic: identical params → identical result bytes.
- The worker exits cleanly on stdin EOF or the `shutdown` method.

Run:  python -m twio_engine.worker          (cwd = apps/server/python)
"""

import json
import sys
import traceback

from . import ENGINE_NAME, ENGINE_VERSION


class EngineError(Exception):
    """Error with a stable machine-readable code (surfaced to the API)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


METHODS = {}


def method(name):
    def deco(fn):
        METHODS[name] = fn
        return fn

    return deco


@method("ping")
def _ping(_params):
    return {"engine": ENGINE_NAME, "version": ENGINE_VERSION,
            "python": sys.version.split()[0]}


@method("analyze_stem")
def _analyze_stem(params):
    # Lazy: imports numpy/librosa only for this method.
    from . import features
    return features.analyze_stem(params)


@method("key_video")
def _key_video(params):
    # Lazy: imports cv2/onnxruntime only for this method.
    from . import matting
    return matting.key_video(params)


@method("separate_stems")
def _separate_stems(params):
    # Lazy: imports librosa only for this method; torch/demucs only for hq.
    from . import separate
    return separate.separate_stems(params)


@method("sep_status")
def _sep_status(params):
    # Lazy + dependency-light: reports which backends are installed.
    from . import separate
    return separate.sep_status(params)


def _respond(req_id, ok, **kw):
    sys.stdout.write(json.dumps({"id": req_id, "ok": ok, **kw}) + "\n")
    sys.stdout.flush()


def _error_payload(exc):
    # Duck-type `.code` rather than isinstance(exc, EngineError): this module
    # runs as __main__, so `from .worker import EngineError` in a method
    # module resolves to a SECOND EngineError class and isinstance fails —
    # stable codes must survive either identity.
    code = getattr(exc, "code", None)
    if not code:
        code = "MISSING_DEP" if isinstance(exc, ImportError) else "ENGINE_ERROR"
    return {"code": code,
            "message": str(exc) or repr(exc),
            "trace": traceback.format_exc().splitlines()[-6:]}


def main():
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")
    print(f"[twio-engine] worker ready · python {sys.version.split()[0]}",
          file=sys.stderr, flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            name = req.get("method")
            params = req.get("params") or {}
            if name == "shutdown":
                _respond(req_id, True, result={"bye": True})
                return
            fn = METHODS.get(name)
            if fn is None:
                _respond(req_id, False, error={
                    "code": "UNKNOWN_METHOD",
                    "message": f"unknown method: {name}",
                })
                continue
            _respond(req_id, True, result=fn(params))
        except json.JSONDecodeError as e:
            _respond(req_id, False,
                     error={"code": "BAD_REQUEST",
                            "message": f"invalid JSON: {e}"})
        except Exception as e:  # noqa: BLE001 — worker must never die silently
            _respond(req_id, False, error=_error_payload(e))


if __name__ == "__main__":
    main()
