import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPublication } from "../src/features/admin/publication.ts";

const expected = {
  status: "published",
  visibility: "public",
  point: {
    id: "p",
    name: "图书馆",
    aliases: [],
    category: "academic",
    summary: "新说明",
    revision: 2,
  },
  geometries: [
    {
      point_id: "p",
      map_id: "m",
      map_revision: 3,
      anchor: { x: 5, y: 5 },
      polygon: [
        { x: 1, y: 1 },
        { x: 9, y: 1 },
        { x: 9, y: 9 },
      ],
      label_on_map: false,
    },
  ],
};
function reader(point = expected.point, geometry = expected.geometries[0]) {
  return {
    point: async () => {
      if (!point) throw Object.assign(new Error("not public"), { status: 404 });
      return { data: point };
    },
    mapFeatures: async () => ({
      data: {
        map_id: "m",
        map_revision: 3,
        points: geometry ? [geometry] : [],
      },
    }),
  };
}
const verify = (source, data = expected) =>
  verifyPublication(data, "m", source, new AbortController().signal);

test("a publication receipt requires matching public revision, text, anchor and click region", async () => {
  assert.equal((await verify(reader())).ok, true);
  for (const source of [
    reader({ ...expected.point, revision: 1 }),
    reader({ ...expected.point, name: "旧名称" }),
    reader(null),
    reader(expected.point, null),
    reader(expected.point, {
      ...expected.geometries[0],
      anchor: { x: 0, y: 0 },
    }),
    reader(expected.point, { ...expected.geometries[0], polygon: [] }),
    reader(expected.point, { ...expected.geometries[0], label_on_map: true }),
  ])
    assert.equal((await verify(source)).ok, false);
});

test("retired or internal points are verified absent from both public detail and map APIs", async () => {
  for (const data of [
    { ...expected, status: "retired" },
    { ...expected, visibility: "internal" },
  ]) {
    assert.equal((await verify(reader(null, null), data)).ok, true);
    assert.equal((await verify(reader(null), data)).ok, false);
    assert.equal((await verify(reader(expected.point, null), data)).ok, false);
  }
});

test("network failures cannot produce a successful public receipt or undo the committed publication", async () => {
  const source = reader();
  source.point = async () => {
    throw new Error("timeout");
  };
  const check = await verify(source);
  assert.equal(check.ok, false);
  assert.match(check.message, /已保存/);
});
