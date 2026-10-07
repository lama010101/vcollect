import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineClient, engineClient, EngineRpcError } from "../src/python/engineClient.ts";
import { DEPS_STAMP_PATH, resolveBasePython, VENV_PYTHON } from "../src/python/pythonService.ts";
import { stemFeatures } from "../src/visualizer/features.ts";

/** Minimal mono 16-bit WAV writer (same pattern as visualizer.node.test.ts). */
function wavBuffer(samples: Float32Array, sr: number): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))), 44 + i * 2);
  }
  return buf;
}

const basePython = () => resolveBasePython();

describe("python engine — interpreter + worker", () => {
  it("resolves a REAL base interpreter (rejects the WindowsApps Store stub)", async () => {
    const py = await resolveBasePython();
    assert.ok(py.exe);
    assert.ok(!py.exe.includes("WindowsApps") || py.argsPrefix.length > 0 || py.source === "py-launcher" || py.source === "config");
  });

  it("worker ping round-trips over NDJSON (lazy imports — no deps needed)", async () => {
    const client = new EngineClient(basePython);
    const r = await client.call<{ engine: string; python: string }>("ping", {}, { timeoutMs: 15000 });
    assert.equal(r.engine, "twio-engine");
    assert.match(r.python, /^\d+\.\d+/);
    assert.equal(client.alive, true);
    client.kill();
    assert.equal(client.alive, false);
  });

  it("unknown method → structured UNKNOWN_METHOD error", async () => {
    const client = new EngineClient(basePython);
    await assert.rejects(client.call("does_not_exist", {}, { timeoutMs: 15000 }), (e: unknown) => {
      assert.ok(e instanceof EngineRpcError);
      assert.equal((e as EngineRpcError).code, "UNKNOWN_METHOD");
      return true;
    });
    client.kill();
  });

  it("worker respawns after kill", async () => {
    const client = new EngineClient(basePython);
    await client.call("ping", {}, { timeoutMs: 15000 });
    client.kill();
    // A fresh call spawns a new worker.
    const r = await client.call<{ engine: string }>("ping", {}, { timeoutMs: 15000 });
    assert.equal(r.engine, "twio-engine");
    client.kill();
  });
});

describe("python engine — stem features (needs provisioned venv)", () => {
  const venvReady = existsSync(VENV_PYTHON) && existsSync(DEPS_STAMP_PATH);

  it("analyze_stem extracts onsets/bands/beats from a synthetic click track", { skip: !venvReady && "venv not provisioned — run POST /api/engine/setup first" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "twio-feat-test-"));
    try {
      const sr = 44100;
      const samples = new Float32Array(Math.round(2 * sr));
      // 120 BPM click track — clicks at 0.25/0.75/1.25/1.75 s (a click at
      // t=0 has no rising edge for spectral flux, so the first is offset).
      // Random amplitude → unique sha256 each run → the first stemFeatures
      // call is always a real compute (the engine cache is content-keyed).
      const amp = 0.85 + Math.random() * 0.1;
      for (let k = 0; k < 4; k++) samples[Math.round((0.25 + k * 0.5) * sr)] = amp;
      const wav = join(dir, "clicks.wav");
      writeFileSync(wav, wavBuffer(samples, sr));

      const { features, cached } = await stemFeatures(wav);
      assert.ok(features.frames > 0);
      assert.equal(features.bands.length, features.bandNames.length * features.frames);
      assert.ok(features.onsets.length >= 3, `expected ≥3 onsets, got ${features.onsets.length}`);
      // First onset should land near the first click (~0.25 s).
      assert.ok(features.onsets[0]!.time < 0.45, `first onset ${features.onsets[0]?.time}`);
      assert.ok(features.onsets[0]!.strength > 0);
      assert.ok(Number.isFinite(features.tempo) && features.tempo > 30 && features.tempo < 300);
      assert.equal(cached, false);

      // Second call must hit the cache.
      const again = await stemFeatures(wav);
      assert.equal(again.cached, true);
    } finally {
      // The shared engineClient worker would keep this test process alive.
      engineClient.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
