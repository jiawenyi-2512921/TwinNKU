// Run after the actual Vite build: node tests/public-bundle-check.mjs.
// This inspects emitted dependency graphs; it does not claim browser timing.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const dist = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const html = readFileSync(resolve(dist, "index.html"), "utf8");
const entries = [
  ...html.matchAll(
    /<(?:script|link)\b[^>]*(?:src|href)="(\/assets\/[^"]+\.js)"/g,
  ),
].map((m) => m[1]);
assert.ok(entries.length, "built index has a real JS entry");
const seen = new Set(),
  dynamic = new Set();
function read(path) {
  const file = resolve(dist, path.replace(/^\//, ""));
  assert.ok(file.startsWith(dist + "/") || file.startsWith(dist + "\\"));
  if (seen.has(file)) return;
  seen.add(file);
  const source = readFileSync(file, "utf8");
  assert.doesNotMatch(
    basename(file),
    /^(?:MapCanvas|FloorViewer|FloorPanel|coordinates)-/,
    "viewers cannot be initial dependencies",
  );
  assert.doesNotMatch(
    source,
    /_leaflet_id/,
    "Leaflet implementation cannot execute with the public home entry",
  );
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  function child(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const name = node.moduleSpecifier.text;
      if (name.startsWith(".")) read("/assets/" + name.replace(/^\.\//, ""));
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      dynamic.add(node.arguments[0].text);
    ts.forEachChild(node, child);
  }
  child(ast);
}
entries.forEach(read);
for (const viewer of ["MapCanvas", "FloorViewer", "FloorPanel"]) {
  assert.ok(
    [...dynamic].some((path) => basename(path).startsWith(viewer + "-")),
    `${viewer} remains available through a lazy import`,
  );
  assert.ok(
    readdirSync(resolve(dist, "assets")).some(
      (path) => path.startsWith(viewer + "-") && path.endsWith(".js"),
    ),
    `${viewer} is emitted rather than removed`,
  );
}
const bytes = [...seen].reduce((n, file) => n + readFileSync(file).length, 0);
const gzip = [...seen].reduce(
  (n, file) => n + gzipSync(readFileSync(file)).length,
  0,
);
assert.ok(
  bytes < 500 * 1024,
  "public initial JS dependency budget is below 500KiB",
);
console.log(
  JSON.stringify({
    status: "passed",
    initial_modules: seen.size,
    initial_bytes: bytes,
    initial_gzip_bytes: gzip,
    lazy_viewers: ["MapCanvas", "FloorViewer", "FloorPanel"],
    browser_verified: false,
  }),
);
