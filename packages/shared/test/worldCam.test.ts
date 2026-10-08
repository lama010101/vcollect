import { describe, it, expect } from "vitest";
import {
  computeCameraTrajectory,
  serializeTrajectoryTxt,
  trajectoryPositions,
  worldCamRequestSchema,
  WORLD_CAM_PRESET_IDS,
  WORLD_CAM_PRESETS,
} from "../src/worldCam";

const N = 24;

describe("computeCameraTrajectory", () => {
  it("returns frames×16 finite floats for every preset", () => {
    for (const id of WORLD_CAM_PRESET_IDS) {
      const m = computeCameraTrajectory(id, { frames: N });
      expect(m.length).toBe(N * 16);
      for (const v of m) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("frame 0 is identity for every preset (first-frame normalized)", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const id of WORLD_CAM_PRESET_IDS) {
      const m = computeCameraTrajectory(id, { frames: N });
      for (let k = 0; k < 16; k++) expect(m[k]).toBeCloseTo(identity[k]!, 6);
    }
  });

  it("presets produce distinct motion", () => {
    const din = computeCameraTrajectory("dolly_in", { frames: N });
    const dout = computeCameraTrajectory("dolly_out", { frames: N });
    // Camera moves +Z → the world translates −Z in camera space (Tcw[2][3],
    // row-major index 11). dolly_out flips the sign.
    expect(din[(N - 1) * 16 + 11]).toBeLessThan(0);
    expect(dout[(N - 1) * 16 + 11]).toBeGreaterThan(0);
    const ol = computeCameraTrajectory("orbit_left", { frames: N });
    const or_ = computeCameraTrajectory("orbit_right", { frames: N });
    // Orbit left/right curve to opposite sides — x translation (index 3).
    expect(Math.sign(ol[(N - 1) * 16 + 3]!)).not.toBe(Math.sign(or_[(N - 1) * 16 + 3]!));
  });

  it("strength scales the displacement", () => {
    const weak = computeCameraTrajectory("pan_right", { frames: N, strength: 0.5 });
    const strong = computeCameraTrajectory("pan_right", { frames: N, strength: 2 });
    const dWeak = Math.abs(weak[(N - 1) * 16 + 3]!);
    const dStrong = Math.abs(strong[(N - 1) * 16 + 3]!);
    expect(dStrong).toBeCloseTo(dWeak * 4, 4);
  });

  it("handles frames=1 without division by zero", () => {
    const m = computeCameraTrajectory("orbit_left", { frames: 1 });
    expect(m.length).toBe(16);
    for (const v of m) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("trajectoryPositions", () => {
  it("extracts one world position per frame, starting at the origin", () => {
    const mats = computeCameraTrajectory("orbit_right", { frames: N });
    const pts = trajectoryPositions(mats);
    expect(pts.length).toBe(N);
    expect(pts[0]).toEqual([expect.closeTo(0, 6), expect.closeTo(0, 6), expect.closeTo(0, 6)]);
    // Orbit ends away from the start.
    expect(Math.hypot(...pts[N - 1]!)).toBeGreaterThan(0.1);
  });
});

describe("serializeTrajectoryTxt", () => {
  it("emits one line of 16 numbers per frame (np.loadtxt(ndmin=2) shape)", () => {
    const mats = computeCameraTrajectory("dolly_in", { frames: N });
    const lines = serializeTrajectoryTxt(mats).trim().split("\n");
    expect(lines.length).toBe(N);
    for (const line of lines) {
      const nums = line.trim().split(/\s+/).map(Number);
      expect(nums.length).toBe(16);
      expect(nums.every((n) => Number.isFinite(n))).toBe(true);
    }
  });

  it("round-trips to the same matrices", () => {
    const mats = computeCameraTrajectory("yaw_left", { frames: 8 });
    const parsed = serializeTrajectoryTxt(mats)
      .trim().split("\n").flatMap((l) => l.trim().split(/\s+/).map(Number));
    for (let i = 0; i < mats.length; i++) expect(parsed[i]).toBeCloseTo(mats[i]!, 7);
  });
});

describe("worldCamRequestSchema", () => {
  const base = { assetId: "a1", prompt: "neon city", preset: "orbit_left" };

  it("accepts a minimal request with defaults", () => {
    const r = worldCamRequestSchema.parse(base);
    expect(r.strength).toBe(1);
    expect(r.seed).toBe(0);
    expect(r.trajScale).toBe(1);
    expect(r.startSec).toBeUndefined();
  });

  it("rejects bad preset, empty prompt, out-of-range strength", () => {
    expect(worldCamRequestSchema.safeParse({ ...base, preset: "fly" }).success).toBe(false);
    expect(worldCamRequestSchema.safeParse({ ...base, prompt: "   " }).success).toBe(false);
    expect(worldCamRequestSchema.safeParse({ ...base, strength: 99 }).success).toBe(false);
    expect(worldCamRequestSchema.safeParse({ prompt: "x", preset: "static" }).success).toBe(false);
  });
});

describe("WORLD_CAM_PRESETS", () => {
  it("descriptors cover every preset id", () => {
    expect(WORLD_CAM_PRESETS.map((p) => p.id).sort()).toEqual([...WORLD_CAM_PRESET_IDS].sort());
    for (const p of WORLD_CAM_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });
});
