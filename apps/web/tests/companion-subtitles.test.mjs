import { test } from "node:test";
import assert from "node:assert/strict";
import {
  companionBounds,
  companionSubtitleLayout,
  restoreCompanionPosition,
} from "../src/features/agent/companionPosition.ts";

const desktop = { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0 };
const character = { width: 176, height: 236 };
const subtitle = { width: 320, height: 76 };
const placed = (viewport, character, subtitle, normalized = { x: 1, y: 1 }) => {
  const anchor = restoreCompanionPosition(
    normalized,
    companionBounds(viewport, character),
  );
  const bubble = companionSubtitleLayout(viewport, anchor, character, subtitle);
  return { anchor, bubble };
};
function assertVisible(viewport, anchor, bubble, originalHeight) {
  const x = anchor.x + bubble.x;
  const y = anchor.y + bubble.y;
  const height = Math.min(originalHeight, bubble.maxHeight);
  assert.ok(x >= viewport.offsetLeft + 16, `left edge: ${x}`);
  assert.ok(y >= viewport.offsetTop + 16, `top edge: ${y}`);
  assert.ok(
    x + bubble.width <= viewport.offsetLeft + viewport.width - 16,
    "right edge",
  );
  assert.ok(
    y + height <= viewport.offsetTop + viewport.height - 16,
    "bottom edge",
  );
}
function assertNoOverlap(anchor, character, bubble, originalHeight) {
  const x = anchor.x + bubble.x;
  const y = anchor.y + bubble.y;
  const height = Math.min(originalHeight, bubble.maxHeight);
  assert.ok(
    x + bubble.width <= anchor.x ||
      x >= anchor.x + character.width ||
      y + height <= anchor.y ||
      y >= anchor.y + character.height,
    "speech bubble must leave the character and its controls usable",
  );
}

test("default desktop bubble stays near the upper half of the character and away from its controls", () => {
  const { anchor, bubble } = placed(desktop, character, subtitle);
  assert.equal(bubble.side, "left");
  assert.equal(bubble.width, 320);
  assertVisible(desktop, anchor, bubble, subtitle.height);
  assertNoOverlap(anchor, character, bubble, subtitle.height);
  assert.ok(
    Math.abs(bubble.y + subtitle.height / 2 - character.height * 0.3) < 1,
  );
});

test("dragging between screen edges flips the speech bubble while keeping it attached", () => {
  for (const normalized of [
    { x: 0, y: 0 },
    { x: 1, y: 0.5 },
    { x: 0, y: 1 },
  ]) {
    const { anchor, bubble } = placed(desktop, character, subtitle, normalized);
    assert.equal(bubble.side, normalized.x === 0 ? "right" : "left");
    assertVisible(desktop, anchor, bubble, subtitle.height);
    assertNoOverlap(anchor, character, bubble, subtitle.height);
    assert.ok(Math.abs(bubble.x) <= bubble.width + character.width + 12);
  }
});

test("mobile speech moves above the character instead of becoming a detached page header", () => {
  const viewport = { width: 390, height: 700, offsetLeft: 0, offsetTop: 0 };
  const mobile = { width: 156, height: 213 };
  const { anchor, bubble } = placed(viewport, mobile, subtitle);
  assert.equal(bubble.side, "above");
  assert.equal(bubble.y + subtitle.height, -12);
  assertVisible(viewport, anchor, bubble, subtitle.height);
  assertNoOverlap(anchor, mobile, bubble, subtitle.height);
});

test("keyboard viewport offsets choose a narrower side bubble without covering controls", () => {
  const viewport = { width: 390, height: 320, offsetLeft: 20, offsetTop: 150 };
  const mobile = { width: 156, height: 213 };
  const tall = { width: 320, height: 100 };
  const { anchor, bubble } = placed(viewport, mobile, tall);
  assert.equal(bubble.side, "left");
  assert.ok(bubble.width >= 160 && bubble.width < 320);
  assertVisible(viewport, anchor, bubble, tall.height);
  assertNoOverlap(anchor, mobile, bubble, tall.height);
});

test("the actual four-control width keeps captions readable in a short keyboard viewport", () => {
  const viewport = { width: 390, height: 250, offsetLeft: 0, offsetTop: 200 };
  const mobile = { width: 200, height: 213 };
  const tall = { width: 320, height: 100 };
  const { anchor, bubble } = placed(viewport, mobile, tall);
  assert.equal(bubble.side, "left");
  assert.ok(bubble.width >= 120 && bubble.width < 160);
  assert.ok(bubble.maxHeight >= 44);
  assertVisible(viewport, anchor, bubble, tall.height);
  assertNoOverlap(anchor, mobile, bubble, tall.height);
});

test("caption growth keeps the chosen slot constrained instead of repeatedly expanding over the character", () => {
  const viewport = { width: 300, height: 320, offsetLeft: 0, offsetTop: 0 };
  const mobile = { width: 200, height: 213 };
  const anchor = restoreCompanionPosition(
    { x: 1, y: 1 },
    companionBounds(viewport, mobile),
  );
  let measuredHeight = 180;
  const layouts = [];
  for (let resize = 0; resize < 5; resize++) {
    const bubble = companionSubtitleLayout(viewport, anchor, mobile, {
      width: 268,
      height: measuredHeight,
    });
    layouts.push(bubble);
    assertVisible(viewport, anchor, bubble, measuredHeight);
    assertNoOverlap(anchor, mobile, bubble, measuredHeight);
    measuredHeight = Math.min(180, bubble.maxHeight);
  }
  assert.equal(layouts[0].side, "above");
  assert.ok(layouts[0].maxHeight > 0 && layouts[0].maxHeight < 120);
  assert.ok(layouts.every((layout) => layout.side === layouts[0].side));
  assert.ok(
    layouts.every((layout) => layout.maxHeight === layouts[0].maxHeight),
  );
});

test("landscape and unusually narrow viewports retain scrolling space without overlapping the character", () => {
  for (const viewport of [
    { width: 800, height: 280, offsetLeft: 0, offsetTop: 0 },
    { width: 240, height: 320, offsetLeft: 0, offsetTop: 0 },
  ]) {
    const { anchor, bubble } = placed(viewport, character, {
      width: 320,
      height: 180,
    });
    assertVisible(viewport, anchor, bubble, 180);
    assertNoOverlap(anchor, character, bubble, 180);
    assert.ok(bubble.maxHeight > 0 && bubble.maxHeight < 180);
  }
});

test("invalid or undersized dimensions never produce nonfinite caption styles", () => {
  for (const viewport of [
    { width: 0, height: 0, offsetLeft: 0, offsetTop: 0 },
    { width: NaN, height: Infinity, offsetLeft: NaN, offsetTop: Infinity },
    { width: 90, height: 90, offsetLeft: 4, offsetTop: 7 },
  ]) {
    const bubble = companionSubtitleLayout(
      viewport,
      { x: NaN, y: Infinity },
      character,
      subtitle,
    );
    for (const [key, value] of Object.entries(bubble)) {
      if (key !== "side") assert.ok(Number.isFinite(value), key);
    }
  }
});
