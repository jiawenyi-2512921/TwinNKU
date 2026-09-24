import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseIntroduction } from "../src/features/points/introduction.ts";

const footer = "\n\n资料来源：\n";
test("existing plain introductions remain readable, including unrecognised markup", () => {
  for (const summary of [
    "普通介绍\n\n第二段",
    "<img src=x onerror=alert(1)>",
    "",
    "[文字](http://example.test)",
  ]) {
    const result = parseIntroduction(summary);
    assert.deepEqual(result.sources, []);
    assert.equal(result.paragraphs.join("\n\n"), summary);
  }
});

test("all 83 curated introductions have readable body and collapsed source data", () => {
  const pack = JSON.parse(
    readFileSync(
      new URL(
        "../../../data/introductions/jinnan-20260924.json",
        import.meta.url,
      ),
    ),
  );
  assert.equal(pack.entries.length, 83);
  for (const entry of pack.entries) {
    const links = entry.source_ids.map((id) => {
      const source = pack.sources[id];
      return source.url ? `[${source.title}](${source.url})` : source.title;
    });
    const summary =
      entry.paragraphs.join("\n\n") +
      footer +
      links.join("\n") +
      "\n资料核对：" +
      pack.checked_on;
    const parsed = parseIntroduction(summary);
    assert.deepEqual(parsed.paragraphs, entry.paragraphs);
    assert.equal(parsed.sources.length, entry.source_ids.length);
    assert.equal(parsed.checkedOn, pack.checked_on);
  }
});

test("unsafe or malformed source footers stay escaped plain text with no links", () => {
  for (const line of [
    "[危险](javascript:alert%281%29)",
    "[危险](data:text/html,test)",
    "[凭据](https://user:secret@example.test)",
    "[脚本](https://a.test/<svg>)",
    "[破损](https://)",
  ]) {
    const summary = "正文" + footer + line + "\n资料核对：2026-09-24";
    assert.deepEqual(parseIntroduction(summary).sources, []);
    assert.equal(parseIntroduction(summary).paragraphs.join("\n\n"), summary);
  }
  for (const date of ["2026-02-30", "2026-99-10", "昨天"]) {
    assert.deepEqual(
      parseIntroduction(
        "正文" + footer + "[来源](https://nankai.edu.cn)\n资料核对：" + date,
      ).sources,
      [],
    );
  }
});
