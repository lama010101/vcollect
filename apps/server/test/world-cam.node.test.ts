import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { worldCamRequestSchema } from "@twio/shared";
import {
  normalizeEndpoint,
  setWorldEndpoint,
  worldEndpoint,
  worldEndpointInfo,
} from "../src/world/client.ts";
import { config } from "../src/config.ts";

describe("world cam — request schema", () => {
  const base = { assetId: "a1", prompt: "neon city", preset: "orbit_left" };

  it("accepts a minimal request", () => {
    assert.equal(worldCamRequestSchema.safeParse(base).success, true);
  });

  it("rejects unknown presets and empty prompts", () => {
    assert.equal(worldCamRequestSchema.safeParse({ ...base, preset: "zoomies" }).success, false);
    assert.equal(worldCamRequestSchema.safeParse({ ...base, prompt: " " }).success, false);
    assert.equal(worldCamRequestSchema.safeParse({ ...base, assetId: "" }).success, false);
    assert.equal(worldCamRequestSchema.safeParse({ ...base, trajScale: 0 }).success, false);
  });
});

describe("world cam — endpoint resolution", () => {
  it("normalizeEndpoint strips trailing slashes and rejects non-http", () => {
    assert.equal(normalizeEndpoint("https://x.trycloudflare.com///"), "https://x.trycloudflare.com");
    assert.throws(() => normalizeEndpoint("not-a-url"), /http/);
    assert.throws(() => normalizeEndpoint("ftp://x"), /http/);
  });

  it("runtime override wins over env and clears cleanly", () => {
    try {
      setWorldEndpoint("https://session.trycloudflare.com/");
      assert.equal(worldEndpoint(), "https://session.trycloudflare.com");
      assert.equal(worldEndpointInfo().source, "override");
      setWorldEndpoint(null);
      assert.equal(worldEndpointInfo().source, config.inspatioEndpoint ? "env" : null);
    } finally {
      setWorldEndpoint(null);
    }
  });

  it("worldEndpoint throws WORLD_NOT_CONFIGURED only when nothing is set", () => {
    if (config.inspatioEndpoint) {
      assert.equal(worldEndpoint(), normalizeEndpoint(config.inspatioEndpoint));
    } else {
      assert.throws(
        () => worldEndpoint(),
        (e: Error & { code?: string }) => e.code === "WORLD_NOT_CONFIGURED",
      );
    }
  });
});
