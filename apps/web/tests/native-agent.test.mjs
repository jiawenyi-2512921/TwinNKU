import { test } from "node:test";
import assert from "node:assert/strict";
import { actionLocation, canAutoApply } from "../src/features/agent/native.ts";

test("guide actions ignore model URLs and construct internal resource selection", () => {
  const a = {
    type: "open_vr",
    point_id: "point-b",
    resource_id: "scene-b",
    url: "https://evil.test/run",
    context_revision: 3,
  };
  const url = new URL(
    actionLocation(
      "https://guide.test/?point=a&floor=f&floor_section=west&experience=tour-1&experience_point=stop-1",
      a,
    ),
  );
  assert.equal(url.origin, "https://guide.test");
  assert.equal(url.searchParams.get("panorama"), "scene-b");
  assert.equal(url.searchParams.get("point"), "point-b");
  assert.equal(url.searchParams.get("floor"), null);
  assert.equal(url.searchParams.get("experience"), "tour-1");
  assert.equal(url.searchParams.get("experience_point"), "stop-1");
});

test("automatic actions require the server's matching explicit intent and unchanged context", () => {
  const action = { type: "show_route", action_id: "one", context_revision: 3 };
  assert.ok(canAutoApply(action, 3, 3, "one"));
  assert.equal(canAutoApply(action, 3, 3), false);
  assert.equal(canAutoApply(action, 3, 3, null), false);
  assert.equal(canAutoApply(action, 3, 3, "other"), false);
  assert.equal(canAutoApply(action, 3, 4, "one"), false);
  assert.equal(
    canAutoApply({ ...action, context_revision: 2 }, 3, 3, "one"),
    false,
  );
  assert.equal(canAutoApply({ ...action, type: "open_vr" }, 3, 3), false);
});
