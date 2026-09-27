import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canTransition, transition, classifyLicense, canApprove } from "../src/state/machine.ts";

describe("state machine (PRD §8)", () => {
  it("allows the happy path", () => {
    assert.equal(canTransition("DISCOVERED", "TECHNICALLY_VALID"), true);
    assert.equal(canTransition("TECHNICALLY_VALID", "LICENSE_SOURCE_CONFIRMED"), true);
    assert.equal(canTransition("LICENSE_SOURCE_CONFIRMED", "HUMAN_REVIEW_REQUIRED"), true);
    assert.equal(canTransition("HUMAN_REVIEW_REQUIRED", "APPROVED_FOR_EDIT"), true);
    // Human KEEP on a license-confirmed candidate — the SELECT button's path.
    assert.equal(canTransition("LICENSE_SOURCE_CONFIRMED", "APPROVED_FOR_EDIT"), true);
  });

  it("allows rejection paths", () => {
    assert.equal(canTransition("DISCOVERED", "REJECTED"), true);
    assert.equal(canTransition("LICENSE_SOURCE_CONFIRMED", "RIGHTS_RISK"), true);
    assert.equal(canTransition("RIGHTS_RISK", "REJECTED"), true);
  });

  it("NEVER allows UNKNOWN -> APPROVED_FOR_EDIT (PRD §2 hard rule)", () => {
    assert.equal(canApprove("UNKNOWN", "HUMAN_REVIEW_REQUIRED", true), false);
    assert.equal(canApprove("NOT_APPROVED", "HUMAN_REVIEW_REQUIRED", true), false);
    assert.equal(canApprove("LICENSE_SOURCE_CONFIRMED", "HUMAN_REVIEW_REQUIRED", false), true);
    assert.equal(canApprove("RIGHTS_REVIEW_REQUIRED", "HUMAN_REVIEW_REQUIRED", true), true);
    assert.equal(canApprove("RIGHTS_REVIEW_REQUIRED", "HUMAN_REVIEW_REQUIRED", false), false);
  });

  it("rejects invalid transitions", () => {
    assert.throws(() => transition("DISCOVERED", "APPROVED_FOR_EDIT"));
    // REJECTED is now reversible by human review (toggle behavior).
    assert.equal(canTransition("REJECTED", "APPROVED_FOR_EDIT"), true);
    assert.equal(canTransition("REJECTED", "LICENSE_SOURCE_CONFIRMED"), true);
    assert.equal(canTransition("APPROVED_FOR_EDIT", "REJECTED"), true);
    // But UNKNOWN license can never be approved.
    assert.equal(canTransition("APPROVED_FOR_EDIT", "DISCOVERED"), false);
  });

  it("allows human override of REJECTED (toggle behavior)", () => {
    // A human reviewer can change their mind: REJECTED → APPROVED_FOR_EDIT.
    assert.equal(canApprove("LICENSE_SOURCE_CONFIRMED", "REJECTED", true), true);
    assert.equal(canApprove("LICENSE_SOURCE_CONFIRMED", "REJECTED", false), false);
    // And APPROVED_FOR_EDIT → REJECTED (via the REJECT action).
    assert.equal(canTransition("APPROVED_FOR_EDIT", "REJECTED"), true);
  });

  it("classifies licenses correctly", () => {
    assert.equal(classifyLicense(null, "LICENSE_SOURCE_CONFIRMED"), "UNKNOWN");
    assert.equal(classifyLicense("Pexels License", "LICENSE_SOURCE_CONFIRMED"), "LICENSE_SOURCE_CONFIRMED");
    assert.equal(classifyLicense("Pixabay Content License", "LICENSE_SOURCE_CONFIRMED"), "LICENSE_SOURCE_CONFIRMED");
  });
});
