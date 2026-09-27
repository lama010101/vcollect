import { describe, it, expect } from "vitest";
import { SHOT_DATASET } from "../src/dataset/shots";

describe("100-shot dataset (PRD §27)", () => {
  it("contains exactly 100 rows", () => {
    expect(SHOT_DATASET.length).toBe(100);
  });

  it("shot numbers are 1..100 sequential", () => {
    for (let i = 0; i < 100; i++) {
      expect(SHOT_DATASET[i]!.shotNumber).toBe(i + 1);
    }
  });

  it("every row has required fields", () => {
    for (const r of SHOT_DATASET) {
      expect(r.section.length).toBeGreaterThan(0);
      expect(r.searchQuery.length).toBeGreaterThan(0);
      expect(r.visualDescription.length).toBeGreaterThan(0);
      expect(r.targetSeconds).toBeGreaterThan(0);
      expect(r.priority).toBeGreaterThanOrEqual(1);
    }
  });

  it("final chorus shots are 94-100", () => {
    const fc = SHOT_DATASET.filter((r) => r.section === "FINAL_CHORUS");
    expect(fc.length).toBe(7);
    expect(fc[0]!.shotNumber).toBe(94);
    expect(fc[fc.length - 1]!.shotNumber).toBe(100);
  });
});
