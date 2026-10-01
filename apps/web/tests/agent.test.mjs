import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_CONTEXT,
  FRAME_CHANNEL,
  contextQuestion,
  contextKey,
  safeContext,
  isFrameMessage,
} from "../src/features/agent/protocol.ts";
import { pointLocation } from "../src/shared/navigation.ts";

const context = {
  ...EMPTY_CONTEXT,
  campus_id: "nku-jinnan",
  campus_name: "南开大学津南校区",
  point_id: "12345678-1234-1234-1234-123456789abc",
  point_name: "图书馆",
  point_revision: "2",
};

test("only public allowlisted context reaches the embed initialization", () => {
  assert.deepEqual(
    safeContext({
      ...context,
      token: "private",
      SYS_USERID: "staff",
      history: ["private text"],
      question: "x",
    }),
    context,
  );
  const invalid = safeContext({
    ...context,
    point_id: "<script>",
    floor_id: "12345678-1234-1234-1234-123456789aaa",
    floor_label: "三层",
  });
  assert.equal(invalid.point_id, "");
  assert.equal(invalid.point_name, "");
  assert.equal(invalid.floor_id, "");
  assert.deepEqual(
    safeContext({ ...context, campus_id: "../../admin" }),
    EMPTY_CONTEXT,
  );
  assert.equal(
    safeContext({ ...context, map_revision: "-1", floor_section: "../../" })
      .map_revision,
    "",
  );
});

test("message bridge rejects other windows, wrong origins, stale frames and action messages", () => {
  const source = {};
  const origin = "https://2512921.cn";
  const instance = "a";
  const data = { channel: FRAME_CHANNEL, instance, type: "initialized" };
  const message = { source, origin, data };
  assert.ok(isFrameMessage(message, source, origin, instance));
  for (const candidate of [
    { ...message, origin: "https://evil.test" },
    { ...message, source: {} },
    { ...message, data: { ...data, instance: "old" } },
    {
      ...message,
      data: { ...data, type: "open_vr", url: "javascript:alert(1)" },
    },
    { ...message, data: null },
  ])
    assert.equal(isFrameMessage(candidate, source, origin, instance), false);
  assert.equal(isFrameMessage(message, null, origin, instance), false);
});

test("context changes include revision and floor, without pretending an image was understood", () => {
  assert.notEqual(
    contextKey(context),
    contextKey({ ...context, point_revision: "3" }),
  );
  const floor = {
    ...context,
    floor_id: "12345678-1234-1234-1234-123456789aaa",
    floor_label: "二层",
    floor_section: "a",
  };
  const question = contextQuestion(floor);
  assert.match(question, /图书馆二层/);
  assert.match(question, /没有房间资料/);
  assert.notEqual(contextKey(context), contextKey(floor));
});

test("switching point clears an old VR target while same-point selection preserves it", () => {
  const url = "https://2512921.cn/?point=one&panorama=vr-1&floor=floor-1";
  assert.equal(pointLocation(url, "one"), url);
  for (const next of ["two", null]) {
    const result = new URL(pointLocation(url, next));
    assert.equal(result.searchParams.has("panorama"), false);
    assert.equal(result.searchParams.has("floor"), false);
  }
});
