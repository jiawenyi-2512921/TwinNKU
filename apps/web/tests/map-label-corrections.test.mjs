import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  correctedDisplayName,
  getMapLabelCorrections,
  MEDIA_COLLEGE_ID,
  SOUTHWEST_GATE_ID,
} from "../src/features/map/labelCorrections.ts";

const manifest = JSON.parse(
  readFileSync(
    new URL("../public/assets/map-labels/manifest.json", import.meta.url),
  ),
);
const map = {
  id: manifest.map_id,
  revision: manifest.map_revision,
  source_sha256: manifest.map_sha256,
  width_px: manifest.width_px,
  height_px: manifest.height_px,
};
const points = [
  { id: MEDIA_COLLEGE_ID, name: "新闻与传播学院" },
  { id: SOUTHWEST_GATE_ID, name: "西南门" },
];
const features = {
  map_id: map.id,
  map_revision: map.revision,
  points: points.map((point, index) => ({
    point_id: point.id,
    map_id: map.id,
    map_revision: map.revision,
    label_on_map: false,
    anchor: { x: 2471 + index * 60, y: 3057 + index * 1953 },
    polygon: index
      ? [
          { x: 2518, y: 4933 },
          { x: 2572, y: 4943 },
          { x: 2543, y: 5089 },
          { x: 2491, y: 5078 },
        ]
      : [
          { x: 2388, y: 2990 },
          { x: 2365, y: 3077 },
          { x: 2553, y: 3127 },
          { x: 2577, y: 3037 },
        ],
  })),
};

test("only the exact requested college ID and former display names are corrected", () => {
  assert.equal(
    correctedDisplayName(MEDIA_COLLEGE_ID, "新闻与传播学院"),
    "信息与传媒学院",
  );
  assert.equal(
    correctedDisplayName(MEDIA_COLLEGE_ID, "新闻与传媒学院"),
    "信息与传媒学院",
  );
  assert.equal(
    correctedDisplayName(MEDIA_COLLEGE_ID, "后台后来修改的名称"),
    "后台后来修改的名称",
  );
  assert.equal(
    correctedDisplayName("another", "新闻与传播学院"),
    "新闻与传播学院",
  );
});
test("restorations only apply to the verified map image and matching public geometry", () => {
  assert.equal(getMapLabelCorrections(map, features, points).length, 2);
  for (const change of [
    { revision: 4 },
    { source_sha256: "new" },
    { width_px: 9000 },
    { id: "another" },
  ])
    assert.deepEqual(
      getMapLabelCorrections({ ...map, ...change }, features, points),
      [],
    );
  assert.deepEqual(
    getMapLabelCorrections(map, { ...features, map_revision: 2 }, points),
    [],
  );
  assert.deepEqual(getMapLabelCorrections(map, features, []), []);
});
test("labels follow current anchors without mutating geometry and fit the narrow gate", () => {
  const moved = structuredClone(features);
  moved.points[1].anchor = { x: 2540, y: 5015 };
  const before = structuredClone(moved);
  const correction = getMapLabelCorrections(map, moved, points).find(
    (item) => item.pointId === SOUTHWEST_GATE_ID,
  );
  assert.deepEqual(correction.anchor, moved.points[1].anchor);
  assert.equal(correction.label.vertical, true);
  assert.ok(correction.label.fontSize < 38);
  assert.ok(correction.label.rotation > 0 && correction.label.rotation < 15);
  assert.deepEqual(moved, before);
  moved.points[1].label_on_map = true;
  assert.equal(
    getMapLabelCorrections(map, moved, points).find(
      (item) => item.pointId === SOUTHWEST_GATE_ID,
    ).label,
    null,
  );
});
test("patches match recorded fingerprints and original-size pixel rectangles", () => {
  for (const patch of manifest.patches) {
    const bytes = readFileSync(
      new URL(`../public/assets/map-labels/${patch.file}`, import.meta.url),
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      patch.sha256,
    );
    assert.equal(bytes.readUInt32BE(16), patch.box[2] - patch.box[0]);
    assert.equal(bytes.readUInt32BE(20), patch.box[3] - patch.box[1]);
  }
});
