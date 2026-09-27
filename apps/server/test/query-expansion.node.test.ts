import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandQuery, allQueries } from "../src/acquisition/queryExpansion.ts";

describe("query expansion (PRD §9, §29)", () => {
  it("generates meaning-preserving variants", () => {
    const v = expandQuery("children running outdoors");
    assert.ok(v.length > 0);
    assert.ok(v.length <= 4);
    assert.ok(v.some((q) => q.includes("kids") || q.includes("outside")));
  });

  it("never produces forbidden tokens (PRD §29)", () => {
    for (const q of expandQuery("children running outdoors")) {
      assert.ok(!/sports|school|classroom/.test(q));
    }
  });

  it("does not make queries excessively long", () => {
    for (const q of expandQuery("children running outdoors")) {
      assert.ok(q.split(/\s+/).length <= 8);
    }
  });

  it("allQueries returns primary first, deduped", () => {
    const all = allQueries("children running outdoors");
    assert.equal(all[0], "children running outdoors");
    assert.equal(new Set(all).size, all.length);
  });
});
