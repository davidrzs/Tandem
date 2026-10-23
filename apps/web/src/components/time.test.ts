import assert from "node:assert/strict";
import { test } from "node:test";
import { localDay } from "./time.js";

test("localDay is the calendar day in the reader's zone, not UTC's", (t) => {
  const zone = process.env.TZ;
  t.after(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  process.env.TZ = "America/New_York";
  assert.equal(localDay(new Date("2026-10-23T02:30:00Z")), "2026-10-22");
  assert.equal(localDay(new Date("2026-01-05T15:00:00Z")), "2026-01-05");
  process.env.TZ = "Asia/Tokyo";
  assert.equal(localDay(new Date("2026-10-22T16:00:00Z")), "2026-10-23");
});
