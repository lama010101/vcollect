import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hammingDistance, nearDuplicate, classifyDuplicate } from "../src/scoring/duplicate.ts";

describe("duplicate detection (PRD §16)", () => {
  it("L1: identical SHA classified as EXACT", () => {
    const r = classifyDuplicate(
      { sha256: "abc", provider: "pexels", providerAssetId: "1", perceptualHash: null },
      { sha256s: new Set(["abc"]), sourceIds: new Set(), perceptualHashes: [], threshold: 8 },
    );
    assert.equal(r.flag, "EXACT");
    assert.equal(r.duplicate, true);
  });

  it("L2: same provider+assetId is SAME_SOURCE", () => {
    const r = classifyDuplicate(
      { sha256: "zzz", provider: "pexels", providerAssetId: "1", perceptualHash: null },
      { sha256s: new Set(), sourceIds: new Set(["pexels:1"]), perceptualHashes: [], threshold: 8 },
    );
    assert.equal(r.flag, "SAME_SOURCE");
  });

  it("L3: near-duplicate pHash within threshold", () => {
    const a = "f000000000000000";
    const b = "c000000000000000";
    assert.equal(hammingDistance(a, b), 2);
    assert.equal(nearDuplicate(a, b, 8), true);
    const r = classifyDuplicate(
      { sha256: null, provider: "pexels", providerAssetId: "9", perceptualHash: a },
      { sha256s: new Set(), sourceIds: new Set(), perceptualHashes: [b], threshold: 8 },
    );
    assert.equal(r.flag, "NEAR_DUPLICATE");
  });

  it("NONE when no match", () => {
    const r = classifyDuplicate(
      { sha256: "x", provider: "pexels", providerAssetId: "2", perceptualHash: "ffff000000000000" },
      { sha256s: new Set(["y"]), sourceIds: new Set(["pexels:3"]), perceptualHashes: ["0000000000000000"], threshold: 8 },
    );
    assert.equal(r.flag, "NONE");
  });

  it("hamming handles unequal lengths", () => {
    assert.equal(hammingDistance("abc", "abcd"), 64);
  });
});
