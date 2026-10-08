// =============================================================================
// @twio/shared — World Cam (InSpatio-World): camera-move presets & trajectory
// math for camera-path video re-rendering.
//
// Everything in this module is PURE and DETERMINISTIC: the same (preset,
// params, frames) always yields the same per-frame world-to-camera matrices.
// The browser draws the trajectory preview from computeCameraTrajectory() and
// the server serializes the identical output into the target_tcw.txt the
// InSpatio pipeline consumes — parity by construction.
//
// Output format: InSpatio expects one OpenCV world-to-camera 4x4 matrix per
// frame (16 row-major numbers per line, x right / y down / z forward), in a
// first-frame-normalized coordinate system. frame 0 is always identity.
// =============================================================================

import { z } from "zod";

// --- Presets ------------------------------------------------------------------

export const WORLD_CAM_PRESET_IDS = [
  "static",
  "dolly_in",
  "dolly_out",
  "pan_left",
  "pan_right",
  "crane_up",
  "crane_down",
  "tilt_up",
  "tilt_down",
  "yaw_left",
  "yaw_right",
  "orbit_left",
  "orbit_right",
] as const;
export type WorldCamPresetId = (typeof WORLD_CAM_PRESET_IDS)[number];

export interface WorldCamPresetInfo {
  id: WorldCamPresetId;
  label: string;
  description: string;
  icon: string;
}

export const WORLD_CAM_PRESETS: readonly WorldCamPresetInfo[] = [
  { id: "static", label: "Static", icon: "▣", description: "Camera holds its position — re-renders the scene unchanged." },
  { id: "dolly_in", label: "Dolly In", icon: "→◎", description: "Push forward into the scene." },
  { id: "dolly_out", label: "Dolly Out", icon: "←◎", description: "Pull backward away from the scene." },
  { id: "pan_left", label: "Pan Left", icon: "←", description: "Slide sideways to the left (tracking shot)." },
  { id: "pan_right", label: "Pan Right", icon: "→", description: "Slide sideways to the right (tracking shot)." },
  { id: "crane_up", label: "Crane Up", icon: "↑", description: "Rise vertically while keeping the framing direction." },
  { id: "crane_down", label: "Crane Down", icon: "↓", description: "Descend vertically while keeping the framing direction." },
  { id: "tilt_up", label: "Tilt Up", icon: "↥", description: "Rotate the view upward, camera stays in place." },
  { id: "tilt_down", label: "Tilt Down", icon: "↧", description: "Rotate the view downward, camera stays in place." },
  { id: "yaw_left", label: "Yaw Left", icon: "↺", description: "Rotate the view to the left, camera stays in place." },
  { id: "yaw_right", label: "Yaw Right", icon: "↻", description: "Rotate the view to the right, camera stays in place." },
  { id: "orbit_left", label: "Orbit Left", icon: "◠", description: "Arc around the subject to the left, always facing it." },
  { id: "orbit_right", label: "Orbit Right", icon: "◡", description: "Arc around the subject to the right, always facing it." },
];

// --- Request schema -------------------------------------------------------------

/** POST /api/world/jobs body — one camera-path re-render request. */
export const worldCamRequestSchema = z.object({
  assetId: z.string().min(1),
  prompt: z.string().trim().min(1).max(2000),
  preset: z.enum(WORLD_CAM_PRESET_IDS),
  /** Amplitude of the move — scales displacement/rotation (0.05–3). */
  strength: z.number().min(0.05).max(3).default(1),
  seed: z.number().int().min(0).default(0),
  /** Optional trim of the source clip before upload (seconds). */
  startSec: z.number().min(0).optional(),
  durationSec: z.number().positive().max(600).optional(),
  /** Extra translation scale applied worker-side (DA3 space tuning). */
  trajScale: z.number().positive().max(100).default(1),
});
export type WorldCamRequest = z.infer<typeof worldCamRequestSchema>;

// --- Matrix helpers (row-major 3x3 / 4x4) ---------------------------------------

type Vec3 = [number, number, number];
type Mat3 = [number, number, number, number, number, number, number, number, number];

const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function rotX(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

function rotY(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Camera rotation (world-from-camera) whose columns are right/down/forward —
 *  the OpenCV basis. `forward` need not be normalized. */
function lookAtRotation(forward: Vec3): Mat3 {
  const f = norm(forward);
  const up: Vec3 = [0, -1, 0]; // OpenCV y is down, so world-up is -Y
  const r = norm(cross(f, up));
  const d = cross(f, r);
  return [r[0], d[0], f[0], r[1], d[1], f[1], r[2], d[2], f[2]];
}

/** Invert a rigid transform (R | p) into the world-to-camera matrix
 *  [R^T | -R^T p] and emit row-major 4x4 (16 numbers). */
function toTcw(R: Mat3, p: Vec3): number[] {
  const t: Vec3 = [
    -(R[0] * p[0] + R[3] * p[1] + R[6] * p[2]),
    -(R[1] * p[0] + R[4] * p[1] + R[7] * p[2]),
    -(R[2] * p[0] + R[5] * p[1] + R[8] * p[2]),
  ];
  return [
    R[0], R[3], R[6], t[0],
    R[1], R[4], R[7], t[1],
    R[2], R[5], R[8], t[2],
    0, 0, 0, 1,
  ];
}

// --- Preset poses ---------------------------------------------------------------

/** Max sweep for orbit presets at strength=1 (60°). */
const ORBIT_ARC = Math.PI / 3;
/** Max sweep for tilt/yaw presets at strength=1 (30°). */
const TURN_ARC = Math.PI / 6;
/** Orbit radius in normalized units. */
const ORBIT_RADIUS = 2;

interface Pose { p: Vec3; R: Mat3 }

/** World-from-camera pose at normalized time t∈[0,1] with amplitude s. */
function presetPose(id: WorldCamPresetId, t: number, s: number): Pose {
  switch (id) {
    case "static":
      return { p: [0, 0, 0], R: I3 };
    case "dolly_in":
      return { p: [0, 0, s * t], R: I3 };
    case "dolly_out":
      return { p: [0, 0, -s * t], R: I3 };
    case "pan_left":
      return { p: [-s * t, 0, 0], R: I3 };
    case "pan_right":
      return { p: [s * t, 0, 0], R: I3 };
    case "crane_up":
      return { p: [0, -s * t, 0], R: I3 };
    case "crane_down":
      return { p: [0, s * t, 0], R: I3 };
    case "tilt_up":
      return { p: [0, 0, 0], R: rotX(TURN_ARC * s * t) };
    case "tilt_down":
      return { p: [0, 0, 0], R: rotX(-TURN_ARC * s * t) };
    case "yaw_left":
      return { p: [0, 0, 0], R: rotY(-TURN_ARC * s * t) };
    case "yaw_right":
      return { p: [0, 0, 0], R: rotY(TURN_ARC * s * t) };
    case "orbit_left":
    case "orbit_right": {
      const dir = id === "orbit_left" ? -1 : 1;
      const th = ORBIT_ARC * s * t * dir;
      const r = ORBIT_RADIUS;
      const c: Vec3 = [0, 0, r]; // subject sits r units ahead on +Z
      const p: Vec3 = [r * Math.sin(th), 0, r - r * Math.cos(th)];
      const fwd: Vec3 = [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
      return { p, R: lookAtRotation(fwd) };
    }
  }
}

// --- Public API -------------------------------------------------------------------

/** Per-frame world-to-camera matrices for `frames` frames.
 *  Returns frames×16 row-major floats; frame 0 is always identity. */
export function computeCameraTrajectory(
  preset: WorldCamPresetId,
  opts: { frames: number; strength?: number },
): Float32Array {
  const frames = Math.max(1, Math.floor(opts.frames));
  const s = opts.strength ?? 1;
  const out = new Float32Array(frames * 16);
  for (let i = 0; i < frames; i++) {
    const t = frames > 1 ? i / (frames - 1) : 0;
    const { p, R } = presetPose(preset, t, s);
    const m = toTcw(R, p);
    for (let k = 0; k < 16; k++) out[i * 16 + k] = m[k]!;
  }
  return out;
}

/** Per-frame camera positions extracted from a trajectory (for UI previews). */
export function trajectoryPositions(mats: Float32Array): Array<Vec3> {
  const n = Math.floor(mats.length / 16);
  const out: Array<Vec3> = [];
  for (let i = 0; i < n; i++) {
    const m = mats.slice(i * 16, i * 16 + 16);
    // Camera center in world = -R p^-1 t = -R^T t (R orthonormal).
    const x = -(m[0]! * m[3]! + m[4]! * m[7]! + m[8]! * m[11]!);
    const y = -(m[1]! * m[3]! + m[5]! * m[7]! + m[9]! * m[11]!);
    const z = -(m[2]! * m[3]! + m[6]! * m[7]! + m[10]! * m[11]!);
    out.push([x, y, z]);
  }
  return out;
}

/** Serialize to the InSpatio target_tcw.txt format: one line per frame,
 *  16 space-separated row-major numbers (np.loadtxt(ndmin=2) compatible). */
export function serializeTrajectoryTxt(mats: Float32Array): string {
  const n = Math.floor(mats.length / 16);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const row: string[] = [];
    for (let k = 0; k < 16; k++) row.push(mats[i * 16 + k]!.toFixed(8));
    lines.push(row.join(" "));
  }
  return lines.join("\n") + "\n";
}
