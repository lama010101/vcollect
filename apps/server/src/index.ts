// =============================================================================
// Fastify server — REST API for MODES A–E (PRD §5) + static asset serving
//
// Multi-project: most endpoints accept a `?project=<id>` query param that
// scopes the query to a project. The virtual id "__ALL__" aggregates every
// project. Defaults to the seeded "THE_WORLD_IS_OURS" project for backwards
// compatibility.
//
// Route handlers live in ./routes/*.ts (register*Routes); this file only wires
// plugins and the register calls. Shared helpers (clampInt/clampNum/
// projectOfQuery) live in ./routes/helpers.ts.
// =============================================================================

import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config, OUTPUT_ROOT } from "./config.js";
import { ffmpegService } from "./video/ffmpeg.js";
import { migrate } from "./db/migrate.js";
import { registerMusicEditRoutes } from "./routes/musicEdit.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { registerVisualizerRoutes } from "./routes/visualizer.js";
import { registerWorldRoutes } from "./routes/world.js";
import { registerEngineRoutes } from "./routes/engine.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerManifestRoutes } from "./routes/manifests.js";
import { registerShotRoutes } from "./routes/shots.js";
import { registerTimelineRoutes } from "./routes/timelines.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerMiscRoutes } from "./routes/misc.js";

export async function buildServer() {
  const app = Fastify({ logger: true });
  // CORS: allow loopback/localhost origins only by default (the webapp runs on
  // a local dev port). TWIO_CORS_ORIGIN overrides: a comma-separated list of
  // exact origins, or "*" to reflect any origin.
  await app.register(fastifyCors, {
    origin: process.env.TWIO_CORS_ORIGIN === "*"
      ? true
      : (process.env.TWIO_CORS_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean)
          ?? [/localhost(:\d+)?$/, /127\.0\.0\.1(:\d+)?$/, /\[::1\](:\d+)?$/]),
  });

  // Global error handler — catches unhandled exceptions in route handlers and
  // returns a clean 500 instead of crashing the process.
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _request, reply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({
      statusCode,
      error: error.code ?? "Internal Server Error",
      message: error.message,
    });
  });

  // Serve generated thumbnails / contact sheets / footage statically. The root
  // is OUTPUT_ROOT so per-project files are served as /files/<slug>/footage/...
  await app.register(fastifyStatic, {
    root: OUTPUT_ROOT,
    prefix: "/files/",
    decorateReply: false,
  });

  // --- Music edit (beat-aligned music-video editor) ---------------------------
  await registerMusicEditRoutes(app);

  // --- Local video uploads (drag & drop onto the webapp) ----------------------
  await registerUploadRoutes(app);

  // --- Visualizer (multi-stem waveform renderer) ------------------------------
  await registerVisualizerRoutes(app);

  // --- World Cam (camera-path re-render via remote InSpatio worker) -----------
  await registerWorldRoutes(app);

  // --- Python engine (analysis worker: librosa/numpy/scipy/opencv) ------------
  await registerEngineRoutes(app);

  // --- Projects (multi-project management) + script import --------------------
  await registerProjectRoutes(app);

  // --- MODE E: manifest generation -------------------------------------------
  await registerManifestRoutes(app);

  // --- Shots (MODE A search target list) + shot↔asset links -------------------
  await registerShotRoutes(app);

  // --- Timelines (project-scoped) --------------------------------------------
  await registerTimelineRoutes(app);

  // --- Assets (search / copy / folders / file / thumb / ready / rating) ------
  await registerAssetRoutes(app);

  // --- Concurrent download tasks (parallel searches + downloads) -------------
  await registerTaskRoutes(app);

  // --- Providers (attribution links + live search/acquire) -------------------
  await registerProviderRoutes(app);

  // --- Acquire / review / dashboard / llm-status / health --------------------
  await registerMiscRoutes(app);

  return app;
}

export async function startServer(): Promise<void> {
  await ffmpegService.ensure();
  migrate();
  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
}

// Run directly when invoked as `tsx src/index.ts` / `node dist/index.js`.
// Guarded so tests/tooling can import buildServer without booting a server.
const invokedAsEntry =
  !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsEntry) {
  startServer().catch((err) => {
    console.error("server failed to start:", err);
    process.exit(1);
  });
}
