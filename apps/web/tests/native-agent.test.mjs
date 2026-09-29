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

test("manual context changes prevent automatic actions; VR opens the internal viewer", () => {
  assert.ok(canAutoApply({ type: "show_route", context_revision: 3 }, 3, 3));
  assert.equal(
    canAutoApply({ type: "show_route", context_revision: 3 }, 3, 4),
    false,
  );
  assert.equal(
    canAutoApply({ type: "show_route", context_revision: 2 }, 3, 3),
    false,
  );
  assert.equal(
    canAutoApply({ type: "open_vr", context_revision: 3 }, 3, 3),
    true,
  );
});
