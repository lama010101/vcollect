// =============================================================================
// Engine routes — /api/engine/*
//   GET  status   → interpreter/venv/deps status + setup phase (non-blocking)
//   POST setup    → kick managed-venv provisioning in the background
//   POST call     → { method, params } → raw worker RPC (diagnostics)
// =============================================================================

import type { FastifyInstance } from "fastify";
import { engineClient } from "../python/engineClient.js";
import { engineStatus, kickEngineSetup } from "../python/pythonService.js";

export async function registerEngineRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/engine/status", async () => engineStatus());

  app.post("/api/engine/setup", async () => {
    kickEngineSetup();
    return engineStatus();
  });

  app.post("/api/engine/call", async (req, reply) => {
    const body = (req.body ?? {}) as { method?: string; params?: Record<string, unknown>; timeoutMs?: number };
    if (!body.method || typeof body.method !== "string") {
      return reply.code(400).send({ error: "method is required" });
    }
    try {
      const result = await engineClient.call(body.method, body.params ?? {}, {
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      });
      return { ok: true, result };
    } catch (e) {
      const err = e as Error & { code?: string };
      return reply.code(502).send({ ok: false, error: { code: err.code ?? "ENGINE_ERROR", message: err.message } });
    }
  });
}
