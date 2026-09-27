import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rank, licensingConfidence, scoreTo100 } from "../src/scoring/ranker.ts";

describe("final ranker (PRD §19)", () => {
  it("hard-rejects license_unknown", () => {
    const r = rank({
      relevanceScore: 1, visualQualityScore: 1, technicalScore: 1,
      diversityScore: 1, actionMatchScore: 1, licenseStatus: "UNKNOWN", hardRejection: null,
    });
    assert.equal(r.rejected, true);
    assert.equal(r.finalScore, 0);
  });

  it("scores a clean confirmed asset", () => {
    const r = rank({
      relevanceScore: 0.9, visualQualityScore: 0.85, technicalScore: 0.85,
      diversityScore: 1, actionMatchScore: 0.8, licenseStatus: "LICENSE_SOURCE_CONFIRMED", hardRejection: null,
    });
    assert.equal(r.rejected, false);
    assert.ok(r.finalScore > 0.8);
  });

  it("hard rejection overrides score", () => {
    const r = rank({
      relevanceScore: 1, visualQualityScore: 1, technicalScore: 1,
      diversityScore: 1, actionMatchScore: 1, licenseStatus: "LICENSE_SOURCE_CONFIRMED", hardRejection: "corrupt_file",
    });
    assert.equal(r.rejected, true);
    assert.equal(r.rejectionReason, "corrupt_file");
  });

  it("licensing confidence values", () => {
    assert.equal(licensingConfidence("LICENSE_SOURCE_CONFIRMED"), 1.0);
    assert.equal(licensingConfidence("RIGHTS_REVIEW_REQUIRED"), 0.5);
    assert.equal(licensingConfidence("UNKNOWN"), 0.0);
    assert.equal(licensingConfidence("NOT_APPROVED"), 0.0);
  });

  it("scoreTo100 clamps", () => {
    assert.equal(scoreTo100(0.5), 50);
    assert.equal(scoreTo100(1.5), 100);
    assert.equal(scoreTo100(-1), 0);
  });
});
