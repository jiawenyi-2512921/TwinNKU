import { test } from "node:test";
import assert from "node:assert/strict";
import {
  speechCaptionAt,
  splitSpeechCaptions,
} from "../src/features/agent/captions.ts";

test("caption segments preserve original offsets across Chinese, quotes, whitespace and emoji", () => {
  const text = "  欢迎来到校园！\n小开说：“可以去图书馆。” 🧚让我们出发吧。  ";
  const captions = splitSpeechCaptions(text);
  assert.deepEqual(
    captions.map((caption) => caption.text),
    ["欢迎来到校园！", "小开说：“可以去图书馆。”", "🧚让我们出发吧。"],
  );
  for (const caption of captions) {
    assert.equal(text.slice(caption.start, caption.end), caption.text);
    assert.equal(speechCaptionAt(captions, caption.start), caption);
  }
  assert.equal(speechCaptionAt(captions, text.indexOf("让我们")), captions[2]);
  assert.equal(speechCaptionAt(captions, text.indexOf("\n")), captions[0]);
});

test("long unpunctuated captions are bounded without losing text or splitting surrogate pairs", () => {
  const text = "校园".repeat(28) + "🧚".repeat(60);
  const captions = splitSpeechCaptions(text);
  assert.equal(captions.map((caption) => caption.text).join(""), text);
  assert.ok(captions.every((caption) => Array.from(caption.text).length <= 52));
  assert.ok(captions.every((caption) => caption.text.isWellFormed()));
});

test("long sentences prefer commas or spaces; decimal periods do not create sentence boundaries", () => {
  const text =
    "这是一段用于测试字幕长度的介绍文案请先阅读这一部分，接下来我们继续讲解已发布的校园资料并保留完整回答记录以供查看。";
  const captions = splitSpeechCaptions(text);
  assert.ok(captions[0].text.endsWith("，"));
  assert.equal(captions.map((caption) => caption.text).join(""), text);
  assert.deepEqual(
    splitSpeechCaptions("Version 1.25 is ready. Next sentence!").map(
      (caption) => caption.text,
    ),
    ["Version 1.25 is ready.", "Next sentence!"],
  );
});

test("blank text and invalid or out of range boundary offsets are ignored", () => {
  assert.deepEqual(splitSpeechCaptions(" \n\t"), []);
  assert.equal(speechCaptionAt([], 0), undefined);
  const captions = splitSpeechCaptions("你好。");
  for (const charIndex of [-1, 1.5, NaN, Infinity, 4])
    assert.equal(speechCaptionAt(captions, charIndex), undefined);
  assert.equal(speechCaptionAt(captions, 3), captions[0]);
});
