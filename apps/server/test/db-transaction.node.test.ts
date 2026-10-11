import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_DESCRIPTION, DEFAULT_PROJECT_ID } from "@twio/shared";

// Point OUTPUT_ROOT at a throwaway dir BEFORE importing server modules —
// config resolves OUTPUT_ROOT + the DB path from env at import time, so these
// tests never touch the real dev DB (output/database/footage.db).
const OUT = mkdtempSync(join(tmpdir(), "twio-dbtx-"));
process.env.OUTPUT_DIR = OUT;

const { migrate } = await import("../src/db/migrate.ts");
const { db } = await import("../src/db/client.ts");
const { createShot, deleteShot, getShot } = await import("../src/db/repository.ts");

migrate();

interface DescriptionRow {
  description: string | null;
}
const projectDescription = () =>
  db.get<DescriptionRow>("SELECT description FROM projects WHERE id = ?", DEFAULT_PROJECT_ID)?.description;

describe("Sql.transaction — nested SAVEPOINTs", () => {
  // db.transaction(() => …) callbacks may call repository helpers that open
  // their own transaction (e.g. deleteShot) or nest transactions directly.
  // That used to fail with "cannot start a transaction within a transaction";
  // nested calls now run inside SAVEPOINTs. Assertions that write run inside
  // an outermost tx that always throws ("rewind"), forcing a full rollback —
  // nothing persists even if this file ever runs against the real dev DB.

  it("a transaction nested inside another completes without throwing", () => {
    let innerRan = false;
    db.transaction(() => {
      db.transaction(() => {
        innerRan = true;
      });
    });
    assert.equal(innerRan, true);
  });

  it("supports three levels of nesting", () => {
    let depthReached = 0;
    db.transaction(() => {
      depthReached = 1;
      db.transaction(() => {
        depthReached = 2;
        db.transaction(() => {
          depthReached = 3;
        });
      });
    });
    assert.equal(depthReached, 3);
  });

  it("an inner throw rolls back only the inner unit; the outer still commits", () => {
    assert.throws(
      () =>
        db.transaction(() => {
          db.run("UPDATE projects SET description = ? WHERE id = ?", "outer-write", DEFAULT_PROJECT_ID);
          assert.throws(
            () =>
              db.transaction(() => {
                db.run("UPDATE projects SET description = ? WHERE id = ?", "inner-write", DEFAULT_PROJECT_ID);
                throw new Error("inner failure");
              }),
            /inner failure/,
          );
          // The inner write was rolled back to its savepoint; the outer write
          // survives and the outer transaction can still commit cleanly.
          assert.equal(projectDescription(), "outer-write");
          throw new Error("rewind");
        }),
      /rewind/,
    );
    // The rewind rolled everything back — the seeded description is intact.
    assert.equal(projectDescription(), DEFAULT_PROJECT_DESCRIPTION);
  });

  it("an outer throw rolls back inner writes as well", () => {
    assert.throws(
      () =>
        db.transaction(() => {
          db.transaction(() => {
            db.run("UPDATE projects SET description = ? WHERE id = ?", "inner-write", DEFAULT_PROJECT_ID);
          });
          throw new Error("outer failure");
        }),
      /outer failure/,
    );
    assert.equal(projectDescription(), DEFAULT_PROJECT_DESCRIPTION);
  });

  it("a repository helper that opens its own transaction runs inside a caller's tx", () => {
    // Regression test: deleteShot wraps its deletes in db.transaction(), so
    // calling it inside a transaction used to throw. Wrap in a rewind tx so
    // the shot row is never actually committed.
    assert.throws(
      () =>
        db.transaction(() => {
          const shot = createShot({
            id: "TX_TEST_SHOT",
            projectId: DEFAULT_PROJECT_ID,
            shotNumber: 9999,
            section: "TEST",
            visualDescription: "tx nesting regression",
            searchQuery: "tx",
            targetDurationSeconds: null,
            priority: 5,
          });
          assert.ok(getShot(shot.id));
          deleteShot(shot.id); // opens a nested transaction internally
          assert.equal(getShot(shot.id), undefined);
          throw new Error("rewind");
        }),
      /rewind/,
    );
    assert.equal(getShot("TX_TEST_SHOT"), undefined);
  });
});
