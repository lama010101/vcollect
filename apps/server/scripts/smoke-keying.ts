// Smoke: engine `key_video` on a real clip → VP9-alpha WebM, then verify the
// alpha channel survives a libvpx decode (the render path's exact args).
//   npx tsx apps/server/scripts/smoke-keying.ts <video> [model]
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { engineClient } from "../src/python/engineClient.js";
import { ffmpegService } from "../src/video/ffmpeg.js";
import { videoDecoderArgs } from "../src/visualizer/render.js";
import { vizVideoKeySchema } from "@twio/shared";

const video = resolve(process.argv[2] ?? "");
const model = (process.argv[3] ?? "mediapipe") as "mediapipe" | "modnet";
if (!existsSync(video)) {
  console.error("usage: smoke-keying.ts <video> [mediapipe|modnet]");
  process.exit(2);
}
await ffmpegService.ensure();
const out = video.replace(/\.[^.]+$/, "") + `.${model}.webm`;
const prog = out + ".progress";

const r = (await engineClient.call("key_video", {
  video_path: video,
  out_path: out,
  ffmpeg_path: ffmpegService.ffmpegPath(),
  models_dir: resolve("output/cache/models"),
  model,
  despill: true,
  feather: 1.0,
  progress_path: prog,
})) as { out: string; frames: number; width: number; height: number; fps: number };
console.log("key_video →", JSON.stringify(r));
console.log("progress file →", existsSync(prog) ? readFileSync(prog, "utf8") : "(missing)");
console.log("size:", statSync(out).sizeBytes ?? statSync(out).size, "bytes");

// Decode exactly the way render.ts does and confirm alpha is non-trivial
// (bounded to 5 frames via -frames:v before the pipe target).
const plan = videoDecoderArgs(video, r.width, r.height, 30, vizVideoKeySchema.parse({ method: "cutout" }), out);
const args = [...plan.args.slice(0, -1), "-frames:v", "5", "pipe:1"];
const res = spawnSync(ffmpegService.ffmpegPath(), args, { maxBuffer: 256 * 1024 * 1024 });
if (res.status !== 0) {
  console.error("decode failed:", res.stderr?.toString().slice(-400));
  process.exit(1);
}
const rgba = res.stdout;
const px = rgba.length / 4;
let zero = 0;
let full = 0;
let mid = 0;
for (let i = 3; i < rgba.length; i += 4) {
  if (rgba[i] === 0) zero++;
  else if (rgba[i] === 255) full++;
  else mid++;
}
console.log(`decoded ${px} px — alpha: ${((zero / px) * 100).toFixed(1)}% transparent, ${((full / px) * 100).toFixed(1)}% opaque, ${((mid / px) * 100).toFixed(1)}% partial`);
if (zero === 0 && full === px * 5) console.log("WARNING: alpha is uniformly opaque — matte may not have been applied");
else console.log("OK: alpha variation present");
engineClient.kill();
process.exit(0);
