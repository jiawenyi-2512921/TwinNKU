import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { appendMapLabelCorrections } from "../src/features/map/labelCorrections.ts";
import * as mapDefaults from "../src/features/map/mapDefaults.ts";
const compile = (file) =>
  ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const panelCode = compile("../src/features/map/NavigationPanel.tsx");
const mapCode = compile("../src/features/map/MapCanvas.tsx");
const walk = (tree, predicate) => {
  if (Array.isArray(tree)) return tree.flatMap((node) => walk(node, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...walk(tree.props?.children, predicate),
  ];
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
// Controlled hooks run the real component effects and handlers; not browser layout.
function hooks() {
  const slots = [],
    effects = [];
  let index = 0,
    dirty = false,
    queued = [];
  return {
    react: {
      useState(value) {
        const key = index++;
        if (!(key in slots)) slots[key] = value;
        return [
          slots[key],
          (next) => {
            const value = typeof next === "function" ? next(slots[key]) : next;
            if (!Object.is(value, slots[key])) {
              slots[key] = value;
              dirty = true;
            }
          },
        ];
      },
      useRef(value) {
        const key = index++;
        if (!(key in slots)) slots[key] = { current: value };
        return slots[key];
      },
      useEffect(effect, deps) {
        const key = index++,
          previous = effects[key];
        if (
          !previous ||
          !deps ||
          deps.some((value, i) => !Object.is(value, previous.deps[i]))
        )
          queued.push(() => {
            previous?.cleanup?.();
            effects[key] = { deps, cleanup: effect() };
          });
      },
    },
    render(component, props) {
      let tree,
        iterations = 0;
      do {
        assert.ok(++iterations < 20, "effects settle");
        index = 0;
        dirty = false;
        queued = [];
        tree = component(props);
        for (const node of walk(tree, (node) => node.props?.ref))
          node.props.ref.current ??= {};
        queued.forEach((effect) => effect());
      } while (dirty);
      return tree;
    },
    dispose() {
      effects.forEach((effect) => effect?.cleanup?.());
    },
  };
}
const points = [
  { id: "a", name: "起点楼" },
  { id: "b", name: "终点楼" },
  { id: "c", name: "未开放楼" },
  { id: "d", name: "备用楼" },
];
const map = { id: "map", revision: 3 };
const graph = {
  map_id: "map",
  map_revision: 3,
  graph_revision: 8,
  ready: true,
  available_point_ids: ["a", "b", "d"],
  message: "",
};
const path = {
  id: "route",
  map_id: "map",
  graph_revision: 8,
  start_point_id: "a",
  end_point_id: "b",
  expires_at: "2099-01-01T00:00:00Z",
  distance_m: null,
  segments: [],
  warnings: [],
};
function panel(initial = { sequence: 1, end: "b" }) {
  const h = hooks(),
    reads = [],
    posts = [],
    routes = [],
    selections = [],
    browser = new EventTarget(),
    exported = {};
  const props = {
    map,
    points,
    initial,
    pickMode: null,
    pickedPoint: null,
    onRoute: (value) => routes.push(value),
    onClose() {},
    onPickMode: (value) => {
      props.pickMode = value;
    },
    onSelectionChange: (value) => selections.push(value),
  };
  vm.runInNewContext(panelCode, {
    exports: exported,
    AbortController,
    Error,
    window: browser,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 2,
    clearTimeout() {},
    require(name) {
      if (name === "react") return h.react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith(".css")) return {};
      if (name === "../../shared/api/client")
        return {
          get: (url, signal) =>
            new Promise((resolve, reject) =>
              reads.push({ url, signal, resolve, reject }),
            ),
        };
      if (name === "../agent/native")
        return {
          post: (url, body, csrf, signal) =>
            new Promise((resolve, reject) =>
              posts.push({ url, body, csrf, signal, resolve, reject }),
            ),
        };
      throw new Error(name);
    },
  });
  const render = () => h.render(exported.NavigationPanel, props);
  const button = (label) =>
    walk(
      render(),
      (node) => node.type === "button" && node.props.children === label,
    )[0];
  const select = (kind, value) => {
    walk(
      render(),
      (node) => node.props?.["aria-label"] === `导航${kind}`,
    )[0].props.onChange({ target: { value } });
    render();
  };
  render();
  return {
    ...h,
    props,
    browser,
    reads,
    posts,
    routes,
    selections,
    render,
    button,
    select,
    submit: () =>
      walk(render(), (node) => node.type === "form")[0].props.onSubmit({
        preventDefault() {},
      }),
    async available(value = graph) {
      reads.at(-1).resolve({ data: value });
      await flush();
      render();
    },
    async readyRoute() {
      await this.available();
      select("起点", "a");
      this.submit();
      posts.at(-1).resolve(path);
      await flush();
      render();
    },
  };
}
test("picking preserves a route on cancel, rejects unavailable entrances, accepts a published point", async () => {
  const h = panel();
  try {
    await h.readyRoute();
    assert.equal(h.routes.at(-1), path);
    h.button("地图选起点").props.onClick();
    assert.equal(h.props.pickMode, "start");
    assert.equal(h.routes.at(-1), path);
    assert.equal(walk(h.render(), (node) => node.type === "select").length, 0);
    h.props.pickedPoint = { sequence: 1, id: "c" };
    h.render();
    assert.equal(h.props.pickMode, "start");
    assert.equal(h.selections.at(-1).start, "a");
    assert.ok(
      walk(
        h.render(),
        (node) => node.props?.role === "alert",
      )[0].props.children.includes("暂无可用入口"),
    );
    h.button("取消选点").props.onClick();
    h.render();
    assert.equal(h.props.pickMode, null);
    assert.equal(h.routes.at(-1), path);
    h.button("地图选终点").props.onClick();
    h.render();
    h.props.pickedPoint = { sequence: 2, id: "d" };
    h.render();
    assert.equal(h.props.pickMode, null);
    assert.equal(h.selections.at(-1).start, "a");
    assert.equal(h.selections.at(-1).end, "d");
    assert.equal(h.routes.at(-1), null);
    assert.deepEqual(
      [...h.selections.at(-1).availablePointIds],
      ["a", "b", "d"],
    );
  } finally {
    h.dispose();
  }
});
test("Escape cancels picking, preserves endpoints and route, removes listener on unmount", async () => {
  const h = panel();
  try {
    await h.readyRoute();
    h.button("地图选起点").props.onClick();
    h.render();
    const event = new Event("keydown", { cancelable: true });
    event.key = "Escape";
    h.browser.dispatchEvent(event);
    h.render();
    assert.equal(event.defaultPrevented, true);
    assert.equal(h.props.pickMode, null);
    assert.equal(h.selections.at(-1).start, "a");
    assert.equal(h.routes.at(-1), path);
    h.button("地图选终点").props.onClick();
    h.render();
  } finally {
    h.dispose();
  }
  const event = new Event("keydown");
  event.key = "Escape";
  h.browser.dispatchEvent(event);
  assert.equal(h.props.pickMode, "end");
});
test("swap aborts the previous calculation and ignores its late route", async () => {
  const h = panel();
  try {
    await h.available();
    h.select("起点", "a");
    h.submit();
    assert.equal(h.posts[0].body.graph_revision, 8);
    h.button("交换起终点").props.onClick();
    h.render();
    assert.equal(h.posts[0].signal.aborted, true);
    assert.equal(h.selections.at(-1).start, "b");
    assert.equal(h.selections.at(-1).end, "a");
    h.posts[0].resolve(path);
    await flush();
    h.render();
    assert.equal(h.routes.at(-1), null);
    h.submit();
    assert.equal(h.posts.at(-1).body.start_point_id, "b");
    assert.equal(h.posts.at(-1).body.end_point_id, "a");
  } finally {
    h.dispose();
  }
});
test("overlapping availability reads are cancelled; failure cancels a pending route; reconnect restores choices", async () => {
  const h = panel();
  try {
    h.browser.dispatchEvent(new Event("focus"));
    assert.equal(h.reads[0].signal.aborted, true);
    await h.available();
    h.reads[0].resolve({
      data: { ...graph, graph_revision: 4, available_point_ids: ["c"] },
    });
    await flush();
    h.render();
    assert.deepEqual(
      [...h.selections.at(-1).availablePointIds],
      ["a", "b", "d"],
    );
    h.select("起点", "a");
    h.submit();
    h.browser.dispatchEvent(new Event("focus"));
    h.reads.at(-1).reject(new Error("网络断开"));
    await flush();
    h.render();
    assert.equal(h.posts[0].signal.aborted, true);
    assert.equal(h.button("地图选起点").props.disabled, true);
    h.posts[0].resolve(path);
    await flush();
    h.render();
    assert.equal(h.routes.at(-1), null);
    h.browser.dispatchEvent(new Event("online"));
    await h.available();
    assert.equal(h.button("地图选起点").props.disabled, false);
  } finally {
    h.dispose();
  }
});
test("initial routes wait for entrance verification, can retry, and ignore late results after unmount", async () => {
  const h = panel({ sequence: 3, start: "a", end: "b" });
  assert.equal(h.posts.length, 0);
  h.reads[0].reject(new Error("temporary"));
  await flush();
  h.render();
  assert.equal(h.posts.length, 0);
  h.button("重新读取可选地点").props.onClick();
  h.render();
  await h.available();
  assert.equal(h.posts.length, 1);
  h.dispose();
  assert.equal(h.posts[0].signal.aborted, true);
  const count = h.routes.length;
  h.posts[0].resolve(path);
  await flush();
  assert.equal(h.routes.length, count);
});
test("road revision updates cancel pending routes and same-point routes stay disabled", async () => {
  const h = panel();
  try {
    await h.available();
    h.select("起点", "b");
    assert.equal(h.button("在地图显示路线").props.disabled, true);
    h.select("起点", "a");
    h.submit();
    h.browser.dispatchEvent(new Event("focus"));
    await h.available({ ...graph, graph_revision: 9 });
    assert.equal(h.posts[0].signal.aborted, true);
    h.posts[0].resolve(path);
    await flush();
    h.render();
    assert.equal(h.routes.at(-1), null);
  } finally {
    h.dispose();
  }
});
function mapHarness(
  viewport = null,
  { reducedMotion = false, center = { lat: -1, lng: 1 } } = {},
) {
  const h = hooks(),
    polygons = [],
    picks = [],
    details = [],
    markers = [],
    options = [],
    fits = [],
    groups = [],
    tileWatches = [],
    lifecycle = [],
    views = [],
    tileOptions = [],
    zoomBounds = [],
    mapEvents = {},
    viewportStorage = new Map();
  if (viewport)
    viewportStorage.set("twinnku:map-view:map:3", JSON.stringify(viewport));
  const element = () => ({
    attributes: {},
    listeners: {},
    classList: { add() {} },
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    addEventListener(k, fn) {
      this.listeners[k] = fn;
    },
  });
  const layer = () => ({
    addTo() {
      return this;
    },
    remove() {},
    on() {
      return this;
    },
    bindTooltip() {
      return this;
    },
  });
  const bounds = {
    pad() {
      return this;
    },
    isValid() {
      return false;
    },
  };
  const leaflet = {
    CRS: { Simple: {} },
    map(_element, config) {
      options.push(config);
      return {
        setMaxBounds() {},
        on(event, callback) {
          mapEvents[event] = callback;
        },
        setView(...args) {
          views.push(args);
        },
        setMinZoom(value) {
          zoomBounds.push(["min", value]);
        },
        setMaxZoom(value) {
          zoomBounds.push(["max", value]);
        },
        getCenter() {
          return center;
        },
        getZoom() {
          return 0;
        },
        once() {},
        off() {},
        getBounds() {
          return { contains: () => false };
        },
        whenReady(callback) {
          callback();
        },
        fitBounds(...args) {
          fits.push(args);
        },
        getSize() {
          return { x: 1000, y: 600 };
        },
        invalidateSize() {},
        remove() {
          lifecycle.push("map removed");
        },
      };
    },
    tileLayer(_url, config) {
      tileOptions.push(config);
      return {
        ...layer(),
        addTo() {
          lifecycle.push("tiles added");
          return this;
        },
      };
    },
    layerGroup() {
      const group = layer();
      groups.push(group);
      return group;
    },
    latLngBounds: () => bounds,
    divIcon: (value) => value,
    marker(point, config) {
      markers.push({ point, config });
      return layer();
    },
    polygon(coordinates, config) {
      const path = element(),
        handlers = {};
      const shape = {
        ...layer(),
        coordinates,
        config,
        path,
        handlers,
        on(event, callback) {
          handlers[event] = callback;
          return this;
        },
        getElement() {
          return path;
        },
        setStyle() {},
        openTooltip() {},
        closeTooltip() {},
      };
      polygons.push(shape);
      return shape;
    },
  };
  let cancelled = 0;
  const props = {
    info: {
      ...map,
      title: "测试第二校区",
      width_px: 800,
      height_px: 600,
      tiles: {
        min_zoom: -2,
        max_native_zoom: 3,
        tile_size: 256,
        url_template: "/tiles/{z}/{x}/{y}.png",
      },
    },
    points,
    selectedId: null,
    routePickMode: "start",
    routeAvailablePointIds: ["a", "b", "d"],
    routeStartId: "a",
    routeEndId: "b",
    routeSegments: [],
    features: {
      map_id: "map",
      map_revision: 3,
      points: points.map((p, i) => ({
        point_id: p.id,
        map_id: "map",
        map_revision: 3,
        anchor: { x: i, y: 2 },
        polygon: [
          { x: i, y: 0 },
          { x: i + 1, y: 0 },
          { x: i, y: 1 },
        ],
      })),
    },
    onSelect: (id) => details.push(id),
    onRoutePick: (id) => picks.push(id),
    onRoutePickCancel() {
      cancelled++;
    },
  };
  const exported = {};
  vm.runInNewContext(mapCode, {
    exports: exported,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    document: { createElement: element, createElementNS: element },
    window: {
      setTimeout,
      clearTimeout,
      matchMedia: (query) => ({
        matches: reducedMotion && query.includes("prefers-reduced-motion"),
      }),
    },
    sessionStorage: {
      getItem: (key) => viewportStorage.get(key) ?? null,
      setItem: (key, value) => viewportStorage.set(key, value),
    },
    require(name) {
      if (name === "react") return h.react;
      if (name === "react/jsx-runtime") return jsx;
      if (name === "leaflet") return leaflet;
      if (name === "./labelCorrections") return { appendMapLabelCorrections };
      if (name === "./mapDefaults") return mapDefaults;
      if (name === "./tileLoad")
        return {
          watchMapTiles(_layer, _map, onChange) {
            lifecycle.push("tiles observed");
            const controller = {
              onChange,
              retries: 0,
              retry() {
                this.retries++;
              },
              dispose() {
                lifecycle.push("tiles released");
              },
            };
            tileWatches.push(controller);
            return controller;
          },
        };
      if (name.endsWith(".css")) return {};
      if (name === "./coordinates")
        return { imageBounds: () => bounds, toMapPoint: (p) => [p.x, p.y] };
      throw new Error(name);
    },
  });
  return {
    ...h,
    props,
    polygons,
    picks,
    details,
    markers,
    options,
    fits,
    groups,
    tileWatches,
    lifecycle,
    views,
    tileOptions,
    zoomBounds,
    mapEvents,
    viewportStorage,
    get cancelled() {
      return cancelled;
    },
    render: () => h.render(exported.MapCanvas, props),
  };
}
test("map picks never open details; keyboard, Escape and endpoint badges work without the zoom toolbar", () => {
  const h = mapHarness();
  try {
    const tree = h.render();
    assert.equal(
      walk(tree, (node) => node.props?.["aria-label"] === "地图工具").length,
      0,
    );
    assert.equal(h.options[0].zoomControl, false);
    h.polygons[0].handlers.click();
    h.polygons[1].path.listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.deepEqual(h.picks, ["a", "b"]);
    assert.deepEqual(h.details, []);
    assert.equal(h.polygons[2].path.attributes["aria-disabled"], "true");
    assert.equal(h.polygons[2].path.attributes.tabindex, "-1");
    assert.ok(h.polygons[0].path.attributes["aria-label"].includes("设为起点"));
    assert.equal(h.markers[0].config.icon.html.textContent, "起点");
    assert.equal(h.markers[1].config.icon.html.textContent, "终点");
    const canvas = walk(tree, (node) => node.props?.role === "region")[0];
    assert.ok(canvas.props["aria-label"].startsWith("测试第二校区"));
    assert.ok(canvas.props["aria-label"].includes("双指缩放"));
    canvas.props.onKeyDown({
      key: "Escape",
      preventDefault() {},
      stopPropagation() {},
    });
    assert.equal(h.cancelled, 1);
    h.props.routePickMode = null;
    h.render();
    h.polygons.at(-4).handlers.click();
    assert.deepEqual(h.details, ["a"]);
  } finally {
    h.dispose();
  }
});

test("unrelated renders with fresh empty routes do not snap a selected map back or recreate empty layers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = mapHarness();
  try {
    h.props.selectedId = "a";
    h.props.routePickMode = null;
    h.render();
    t.mock.timers.tick(30);
    assert.equal(
      h.fits.length,
      2,
      "initial campus fit plus selected point fit",
    );
    const groupCount = h.groups.length;
    for (let i = 0; i < 3; i++) {
      h.props.routeSegments = [];
      h.props.onSelect = () => {};
      h.render();
      t.mock.timers.tick(30);
    }
    assert.equal(h.options.length, 1, "map remains mounted");
    assert.equal(h.tileWatches.length, 1, "tile lifecycle remains attached");
    assert.equal(
      h.fits.length,
      2,
      "polls and search renders leave the user's viewport alone",
    );
    assert.equal(
      h.groups.length,
      groupCount,
      "empty route renders create no layers",
    );
    h.props.selectedId = "b";
    h.render();
    t.mock.timers.tick(30);
    assert.equal(
      h.fits.length,
      3,
      "explicitly selecting another point still focuses it",
    );
  } finally {
    h.dispose();
  }
});

test("omitted optional array props are stable and tile retry does not recreate the map", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = mapHarness();
  delete h.props.routeSegments;
  delete h.props.routeAvailablePointIds;
  h.props.routePickMode = null;
  h.props.selectedId = "a";
  try {
    h.render();
    t.mock.timers.tick(30);
    assert.deepEqual(h.lifecycle, ["tiles observed", "tiles added"]);
    const groupCount = h.groups.length,
      polygonCount = h.polygons.length;
    h.tileWatches[0].onChange({ failed: 1, retrying: false });
    const tree = h.render();
    const retry = walk(tree, (node) => node.type === "button")[0];
    assert.equal(retry.props.disabled, false);
    retry.props.onClick();
    assert.equal(h.tileWatches[0].retries, 1);
    h.tileWatches[0].onChange({ failed: 1, retrying: true });
    assert.equal(
      walk(h.render(), (node) => node.type === "button")[0].props.disabled,
      true,
    );
    h.tileWatches[0].onChange({ failed: 0, retrying: false });
    assert.equal(
      walk(h.render(), (node) => node.props?.className === "tile-warning")
        .length,
      0,
    );
    t.mock.timers.tick(30);
    assert.equal(h.fits.length, 2);
    assert.equal(h.groups.length, groupCount);
    assert.equal(h.polygons.length, polygonCount);
    assert.equal(h.options.length, 1);
  } finally {
    h.dispose();
  }
  assert.deepEqual(h.lifecycle.slice(-2), ["tiles released", "map removed"]);
});

test("map viewport resumes only matching dimensions and a bounded zoom, using native pixel coordinates", () => {
  const h = mapHarness({ x: 100, y: 200, zoom: 1, width: 800, height: 600 });
  h.props.routePickMode = null;
  try {
    h.render();
    assert.equal(h.views.length, 1);
    assert.deepEqual(h.views[0][0], [100, 200]);
    h.mapEvents.moveend();
    const saved = JSON.parse(h.viewportStorage.get("twinnku:map-view:map:3"));
    assert.deepEqual(saved, { x: 8, y: 8, zoom: 0, width: 800, height: 600 });
  } finally {
    h.dispose();
  }
  for (const changed of [
    { x: -1, y: 200, zoom: 1, width: 800, height: 600 },
    { x: 100, y: 200, zoom: 9, width: 800, height: 600 },
    { x: 100, y: 200, zoom: 1, width: 801, height: 600 },
  ]) {
    const invalid = mapHarness(changed);
    try {
      invalid.render();
      assert.equal(invalid.views.length, 0);
    } finally {
      invalid.dispose();
    }
  }
});

test("private map preview neither resumes nor rewrites public viewport memory", () => {
  const saved = { x: 100, y: 200, zoom: 1, width: 800, height: 600 };
  const h = mapHarness(saved);
  h.props.previewOnly = true;
  h.props.routePickMode = null;
  try {
    h.render();
    assert.equal(h.views.length, 0);
    h.mapEvents.moveend();
    assert.deepEqual(
      JSON.parse(h.viewportStorage.get("twinnku:map-view:map:3")),
      saved,
    );
    h.polygons[0].handlers.click();
    assert.deepEqual(
      h.details,
      ["a"],
      "real published geometry remains interactive",
    );
  } finally {
    h.dispose();
  }
});

test("route overview location dots use actual anchors only and do not change the map labels or click geometry", () => {
  const h = mapHarness();
  h.props.routePickMode = null;
  h.props.routeStartId = null;
  h.props.routeEndId = null;
  h.props.highlightedPointIds = ["a", "missing"];
  h.props.showLabels = false;
  try {
    h.render();
    assert.equal(h.markers.length, 1);
    assert.deepEqual(h.markers[0].point, [0, 2]);
    assert.equal(h.markers[0].config.icon.html.className, "map-location-dot");
    assert.equal(h.polygons[0].config.opacity, 1);
    assert.equal(h.polygons[1].config.opacity, 0);
    h.polygons[0].handlers.click();
    assert.deepEqual(h.details, ["a"]);
  } finally {
    h.dispose();
  }
});

test("hiding supplementary map labels keeps the actual geometry interactive and repeated locate is explicit", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = mapHarness();
  h.props.routePickMode = null;
  h.props.showLabels = false;
  h.props.selectedId = "a";
  try {
    h.render();
    t.mock.timers.tick(30);
    h.polygons[0].handlers.click();
    assert.deepEqual(h.details, ["a"]);
    const fits = h.fits.length;
    h.render();
    t.mock.timers.tick(30);
    assert.equal(h.fits.length, fits);
    h.props.focusToken = 1;
    h.render();
    t.mock.timers.tick(30);
    assert.equal(h.fits.length, fits + 1);
  } finally {
    h.dispose();
  }
});

const defaultCamera = {
  map_id: "map",
  map_revision: 3,
  center: { x: 210, y: 180 },
  min_zoom: -3,
  zoom: -1.25,
  max_zoom: 4,
};
test("reviewed camera uses pixels and negative zoom while the tile source stays at its real native minimum", () => {
  const h = mapHarness();
  h.props.routePickMode = null;
  h.props.info.tiles.min_zoom = 0;
  h.props.defaultView = defaultCamera;
  try {
    h.render();
    assert.equal(h.options[0].minZoom, -3);
    assert.equal(h.options[0].maxZoom, 4);
    assert.equal(h.tileOptions[0].minZoom, -8);
    assert.equal(h.tileOptions[0].minNativeZoom, 0);
    assert.equal(h.tileOptions[0].maxNativeZoom, 3);
    assert.deepEqual(h.views[0][0], [210, 180]);
    assert.equal(h.views[0][1], -1.25);
    assert.equal(h.views[0][2].animate, false);
    assert.equal(
      h.viewportStorage.size,
      0,
      "initial default is not a visitor drag record",
    );
    h.props.defaultView = { ...defaultCamera, center: { x: 400, y: 300 } };
    h.render();
    assert.equal(
      h.views.length,
      1,
      "later policy refresh cannot reposition the current map",
    );
    assert.equal(h.options.length, 1);
  } finally {
    h.dispose();
  }
});

test("late first defaults initialize only an untouched map; manual movement and valid visitor memory take priority", () => {
  for (const protectedBy of [null, "move", "memory"]) {
    const h = mapHarness(
      protectedBy === "memory"
        ? { x: 50, y: 60, zoom: 1, width: 800, height: 600 }
        : null,
    );
    h.props.routePickMode = null;
    h.props.defaultsReady = false;
    try {
      h.render();
      if (protectedBy === "move") h.mapEvents.movestart();
      const before = h.views.length;
      h.props.defaultsReady = true;
      h.props.defaultView = defaultCamera;
      h.render();
      assert.equal(h.views.length, before + (protectedBy ? 0 : 1));
      assert.equal(h.zoomBounds.length, protectedBy ? 0 : 2);
      h.props.defaultView = { ...defaultCamera, zoom: 1 };
      h.render();
      assert.equal(h.views.length, before + (protectedBy ? 0 : 1));
    } finally {
      h.dispose();
    }
  }
});

test("invalid or different-version default cameras fit the actual map and do not reuse foreign pixels", () => {
  for (const camera of [
    { ...defaultCamera, map_id: "other-map" },
    { ...defaultCamera, map_revision: 2 },
    { ...defaultCamera, center: { x: 801, y: 20 } },
    { ...defaultCamera, zoom: Number.NaN },
    { ...defaultCamera, max_zoom: 5 },
    { ...defaultCamera, min_zoom: 2 },
  ]) {
    const h = mapHarness();
    h.props.routePickMode = null;
    h.props.defaultView = camera;
    try {
      h.render();
      assert.equal(h.views.length, 0);
      assert.equal(h.fits.length, 1);
    } finally {
      h.dispose();
    }
  }
});

test("private current viewport capture uses native pixels without reading or writing visitor memory", () => {
  const saved = { x: 100, y: 200, zoom: 1, width: 800, height: 600 },
    h = mapHarness(saved),
    captures = [];
  h.props.previewOnly = true;
  h.props.routePickMode = null;
  h.props.onViewportChange = (camera) => captures.push(camera);
  try {
    h.render();
    h.mapEvents.moveend();
    assert.equal(h.views.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(captures[0])), {
      map_id: "map",
      map_revision: 3,
      center: { x: 8, y: 8 },
      zoom: 0,
    });
    assert.deepEqual(
      JSON.parse(h.viewportStorage.get("twinnku:map-view:map:3")),
      saved,
    );
  } finally {
    h.dispose();
  }
});

test("an out-of-image viewport is reported for editor validation but cannot replace valid visitor memory", () => {
  const saved = { x: 100, y: 200, zoom: 1, width: 800, height: 600 };
  const h = mapHarness(saved, { center: { lat: -1, lng: -1 } }),
    captures = [];
  h.props.routePickMode = null;
  h.props.onViewportChange = (viewport) => captures.push(viewport);
  try {
    h.render();
    h.mapEvents.moveend();
    assert.equal(captures.at(-1).center.x, -8);
    assert.equal(captures.at(-1).map_revision, 3);
    assert.deepEqual(
      JSON.parse(h.viewportStorage.get("twinnku:map-view:map:3")),
      saved,
    );
  } finally {
    h.dispose();
  }
});

test("hiding optional point regions cannot hide base tiles or necessary route endpoints and selection targets", () => {
  const h = mapHarness();
  h.props.showRegions = false;
  try {
    h.render();
    assert.ok(h.lifecycle.includes("tiles added"));
    assert.equal(h.markers.length, 2);
    assert.deepEqual(
      h.polygons.map((polygon) => polygon.path.attributes["aria-label"]),
      ["起点楼，设为起点", "终点楼，设为起点", "备用楼，设为起点"],
    );
    h.polygons[0].handlers.click();
    assert.deepEqual(h.picks, ["a"]);
  } finally {
    h.dispose();
  }
});

test("instant focus and reduced motion override short animation without policy refresh relocating the map", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [effect, reducedMotion, animate] of [
    ["instant", false, false],
    ["short", true, false],
    ["short", false, true],
  ]) {
    const h = mapHarness(null, { reducedMotion });
    h.props.routePickMode = null;
    h.props.selectedId = "a";
    h.props.focusEffect = effect;
    try {
      h.render();
      t.mock.timers.tick(30);
      assert.equal(h.fits.at(-1)[1].animate, animate);
      assert.equal(h.fits.at(-1)[1].duration, 0.25);
      const before = h.fits.length;
      h.props.focusEffect = effect === "instant" ? "short" : "instant";
      h.render();
      t.mock.timers.tick(30);
      assert.equal(h.fits.length, before);
    } finally {
      h.dispose();
    }
  }
});
