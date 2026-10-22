import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(
  process.env.CAD_ARTIFACTS || "artifacts/group-drag",
);
const storage = "sketchworks.document.v1";
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CAD_BROWSER_PATH ||
    (!existsSync(chromium.executablePath()) && existsSync(chrome)
      ? chrome
      : undefined),
});
const results = {
  url,
  browser: browser.version(),
  started: new Date().toISOString(),
  checks: [],
  consoleErrors: [],
  pageErrors: [],
  externalRequests: [],
};
await fs.mkdir(output, { recursive: true });
const entity = (kind, id, points, extra = {}) => ({
  kind,
  id,
  name: id,
  points: points.map(([x, y], i) => ({ id: `${id}_p${i}`, x, y })),
  ...extra,
});
const guide = entity(
  "line",
  "guide",
  [
    [-50, -40],
    [50, 40],
  ],
  { construction: true },
);
const documentFixture = (entities = [], constraints = []) => ({
  version: 1,
  name: "Composite drag frame regression",
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: "group-drag-fixture",
      name: "Sketch 1",
      visible: true,
      entities: [guide, ...entities],
      constraints: [
        { id: "guide-fixed", kind: "fixed", refs: [guide.id] },
        ...constraints,
      ],
    },
  ],
});
function rectangle({ dimensioned = false, fixed = false } = {}) {
  const coords = [
    [-22.3, 8.7],
    [-2.3, 8.7],
    [-2.3, 24.7],
    [-22.3, 24.7],
  ];
  const lines = coords.map((p, i) =>
    entity("line", `edge${i}`, [p, coords[(i + 1) % 4]]),
  );
  const constraints = lines.flatMap((line, i) => [
    {
      id: `corner${i}`,
      kind: "coincident",
      refs: [`${line.id}_p1`, `${lines[(i + 1) % 4].id}_p0`],
    },
    {
      id: `axis${i}`,
      kind: i % 2 ? "vertical" : "horizontal",
      refs: [line.id],
    },
  ]);
  if (dimensioned)
    constraints.push(
      { id: "width", kind: "length", refs: ["edge0"], value: 20 },
      { id: "height", kind: "length", refs: ["edge1"], value: 16 },
    );
  if (fixed)
    constraints.push({ id: "corner-fixed", kind: "fixed", refs: ["edge0_p0"] });
  return documentFixture(lines, constraints);
}
function slot() {
  const shapes = [
    entity("line", "slot0", [
      [-22.3, 24.7],
      [-2.3, 24.7],
    ]),
    entity(
      "arc",
      "slot1",
      [
        [-2.3, 20.7],
        [-2.3, 16.7],
        [-2.3, 24.7],
      ],
      { radius: 4, ccw: true },
    ),
    entity("line", "slot2", [
      [-2.3, 16.7],
      [-22.3, 16.7],
    ]),
    entity(
      "arc",
      "slot3",
      [
        [-22.3, 20.7],
        [-22.3, 24.7],
        [-22.3, 16.7],
      ],
      { radius: 4, ccw: true },
    ),
  ];
  const constraints = [
    { id: "slot-parallel", kind: "parallel", refs: ["slot0", "slot2"] },
    ...["slot0", "slot2"].flatMap((line) =>
      ["slot1", "slot3"].map((arc) => ({
        id: `${line}-${arc}`,
        kind: "tangent",
        refs: [line, arc],
      })),
    ),
    { id: "slot-c0", kind: "coincident", refs: ["slot0_p1", "slot1_p2"] },
    { id: "slot-c1", kind: "coincident", refs: ["slot2_p0", "slot1_p1"] },
    { id: "slot-c2", kind: "coincident", refs: ["slot0_p0", "slot3_p1"] },
    { id: "slot-c3", kind: "coincident", refs: ["slot2_p1", "slot3_p2"] },
    { id: "slot-equal", kind: "equal", refs: ["slot1", "slot3"] },
  ];
  return documentFixture(shapes, constraints);
}
function polyline() {
  const coords = [
    [-25.3, 8.7],
    [-9.3, 14.7],
    [-3.3, 28.7],
    [10.7, 20.7],
  ];
  const shapes = coords
    .slice(0, -1)
    .map((p, i) => entity("line", `chain${i}`, [p, coords[i + 1]]));
  return documentFixture(
    shapes,
    shapes.slice(0, -1).map((line, i) => ({
      id: `chain-coincident${i}`,
      kind: "coincident",
      refs: [`${line.id}_p1`, `${shapes[i + 1].id}_p0`],
    })),
  );
}
function pointGroup(fixed = false) {
  const points = [0, 1, 2].map((i) =>
    entity("point", `peer${i}`, [[-22.3, 8.7]]),
  );
  return documentFixture(points, [
    { id: "peer01", kind: "coincident", refs: ["peer0_p0", "peer1_p0"] },
    { id: "peer12", kind: "coincident", refs: ["peer1_p0", "peer2_p0"] },
    ...(fixed ? [{ id: "peer-fixed", kind: "fixed", refs: ["peer0_p0"] }] : []),
  ]);
}
function arrayPlate() {
  const doc = rectangle({ dimensioned: true });
  const sources = doc.sketches[0].entities.filter((e) => e.id !== "guide");
  for (const source of sources) {
    doc.sketches[0].entities.push({
      ...source,
      id: `array-${source.id}`,
      name: `array-${source.id}`,
      points: source.points.map((p, i) => ({
        id: `array-${source.id}_p${i}`,
        x: p.x + 36,
        y: p.y - 6,
      })),
      sourceId: source.id,
      transform: { kind: "translate", x: 36, y: -6 },
    });
  }
  return doc;
}
function tetheredPointGroup() {
  return documentFixture(
    [
      entity("line", "tether", [
        [-32.3, 8.7],
        [-22.3, 8.7],
      ]),
      entity("point", "peer0", [[-22.3, 8.7]]),
      entity("point", "peer1", [[-22.3, 8.7]]),
    ],
    [
      { id: "tether-fixed", kind: "fixed", refs: ["tether_p0"] },
      { id: "tether-length", kind: "length", refs: ["tether"], value: 10 },
      {
        id: "tether-peer",
        kind: "coincident",
        refs: ["tether_p1", "peer0_p0"],
      },
      {
        id: "peer-coincident",
        kind: "coincident",
        refs: ["peer0_p0", "peer1_p0"],
      },
    ],
  );
}
const pointsOf = (doc, ids) =>
  Object.fromEntries(
    doc.sketches[0].entities
      .filter((e) => ids.includes(e.id))
      .flatMap((e) => e.points.map((p) => [p.id, { x: p.x, y: p.y }])),
  );
const near = (a, b, epsilon = 1e-5) =>
  Math.hypot(a.x - b.x, a.y - b.y) <= epsilon;

// Metadata is published immediately after a native canvas draw. This hook records
// every publication, including frames that disappear before Playwright can poll.
function installRecorder({ fixture, storage }) {
  localStorage.setItem(storage, JSON.stringify(fixture));
  const metadata = new WeakMap();
  const state = (window.__groupDrag = {
    active: false,
    frames: [],
    observations: [],
    inputs: [],
    images: [],
    config: null,
    pointer: null,
  });
  function liveViewport(canvas, info) {
    const key = Object.keys(canvas).find((key) =>
      key.startsWith("__reactFiber$"),
    );
    if (!key) return null;
    const candidates = [];
    for (const root of [canvas[key], canvas[key]?.alternate]) {
      for (let fiber = root; fiber; fiber = fiber.return) {
        for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
          if (
            Array.isArray(props?.sketches) &&
            Array.isArray(props?.selection)
          ) {
            const points = new Map(
              props.sketches.flatMap((sk) =>
                sk.entities.flatMap((e) => e.points.map((p) => [p.id, p])),
              ),
            );
            const score = info.handles.reduce((sum, handle) => {
              const point = points.get(handle.pointId);
              return (
                sum +
                (point
                  ? Math.hypot(
                      info.origin.x + point.x * info.scale - handle.x,
                      info.origin.y - point.y * info.scale - handle.y,
                    )
                  : 1e6)
              );
            }, 0);
            candidates.push({ props, score });
          }
        }
      }
    }
    return candidates.sort((a, b) => a.score - b.score)[0] || null;
  }
  function pixels(canvas, info, point) {
    const cx = info.origin.x + point.x * info.scale;
    const cy = info.origin.y - point.y * info.scale;
    const radius = 3;
    const x = Math.max(0, Math.floor((cx - radius) * info.dpr));
    const y = Math.max(0, Math.floor((cy - radius) * info.dpr));
    const width = Math.min(canvas.width - x, Math.ceil(radius * 2 * info.dpr));
    const height = Math.min(
      canvas.height - y,
      Math.ceil(radius * 2 * info.dpr),
    );
    if (width <= 0 || height <= 0) return 0;
    const data = canvas.getContext("2d").getImageData(x, y, width, height).data;
    let count = 0;
    for (let at = 0; at < data.length; at += 4) {
      const r = data[at],
        g = data[at + 1],
        b = data[at + 2];
      if (
        (g > r * 1.12 && g > b * 1.08 && g < 190) ||
        (r > g * 1.12 && g > b * 1.3 && b < 100)
      )
        count++;
    }
    return count;
  }
  function record(canvas, info, source) {
    if (!state.active || !state.config || !info?.stats) return;
    if (source === "draw" && state.frames.at(-1)?.frame === info.stats.frames)
      return;
    const config = state.config;
    const pose = Object.fromEntries(
      info.handles
        .filter((h) => config.pointIds.includes(h.pointId))
        .map((h) => [
          h.pointId,
          {
            x: (h.x - info.origin.x) / info.scale,
            y: (info.origin.y - h.y) / info.scale,
            screenX: h.x,
            screenY: h.y,
          },
        ]),
    );
    const anchor = pose[config.anchorId];
    const baseline = config.baseline[config.anchorId];
    const delta = anchor
      ? { x: anchor.x - baseline.x, y: anchor.y - baseline.y }
      : null;
    const distance = delta ? Math.hypot(delta.x, delta.y) * info.scale : 0;
    const viewport = liveViewport(canvas, info);
    const frame = {
      source,
      at: performance.now(),
      frame: info.stats.frames,
      stage: config.stage,
      expected: config.expected,
      pointer: state.pointer,
      pose,
      delta,
      distance,
      origin: info.origin,
      scale: info.scale,
      stats: info.stats,
      selection: viewport?.props.selection || null,
      modelMetadataError: viewport?.score ?? null,
      modelPose: viewport
        ? Object.fromEntries(
            viewport.props.sketches.flatMap((sk) =>
              sk.entities
                .filter((e) => config.entityIds.includes(e.id))
                .flatMap((e) =>
                  e.points.map((p) => [p.id, { x: p.x, y: p.y }]),
                ),
            ),
          )
        : null,
      selectedRows: [...document.querySelectorAll(".entity-row.selected")].map(
        (row) => row.title || row.textContent,
      ),
      snap: info.snap
        ? {
            ...info.snap,
            point: {
              x: (info.snap.x - info.origin.x) / info.scale,
              y: (info.origin.y - info.snap.y) / info.scale,
            },
          }
        : null,
      pixels: (config.probes || []).map((probe) => ({
        original: pixels(canvas, info, probe),
        progressive: delta
          ? pixels(canvas, info, { x: probe.x + delta.x, y: probe.y + delta.y })
          : 0,
      })),
    };
    if (source === "draw") {
      const previous = state.frames.at(-1);
      state.pointAccepted ||= {};
      const returnedPoint = Object.entries(pose).find(
        ([id, point]) =>
          state.pointAccepted[id] &&
          Math.hypot(
            point.x - config.baseline[id].x,
            point.y - config.baseline[id].y,
          ) *
            info.scale <
            1.5,
      );
      const returned = state.accepted && distance < 1.5;
      const holdMismatch =
        config.stage?.startsWith("hold") &&
        config.expected &&
        anchor &&
        Math.hypot(anchor.x - config.expected.x, anchor.y - config.expected.y) *
          info.scale >
          2 &&
        previous?.stage === config.stage;
      const missingProgressive =
        distance > 12 && frame.pixels.some((probe) => probe.progressive === 0);
      const isCancelled = config.stage === "cancel";
      if (
        !isCancelled &&
        (returned || returnedPoint || holdMismatch || missingProgressive) &&
        state.images.length < 4
      ) {
        const reason =
          returned || returnedPoint
            ? "original-pose-reappeared"
            : holdMismatch
              ? "held-target-mismatch"
              : "progressive-body-missing";
        state.images.push({
          frame: info.stats.frames,
          reason,
          png: canvas.toDataURL("image/png"),
        });
      }
      if (distance > 10) state.accepted = true;
      for (const [id, point] of Object.entries(pose)) {
        if (
          Math.hypot(
            point.x - config.baseline[id].x,
            point.y - config.baseline[id].y,
          ) *
            info.scale >
          10
        )
          state.pointAccepted[id] = true;
      }
      state.frames.push(frame);
    } else {
      state.observations.push({
        at: frame.at,
        frame: frame.frame,
        stage: frame.stage,
        distance: frame.distance,
      });
    }
  }
  Object.defineProperty(HTMLCanvasElement.prototype, "__cadViewport", {
    configurable: true,
    get() {
      return metadata.get(this);
    },
    set(info) {
      metadata.set(this, info);
      record(this, info, "draw");
    },
  });
  for (const type of [
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
  ]) {
    document.addEventListener(
      type,
      (event) => {
        if (event.target?.dataset?.testid !== "cad-canvas") return;
        state.pointer = {
          x: event.clientX,
          y: event.clientY,
          buttons: event.buttons,
          type,
        };
        if (state.active)
          state.inputs.push({
            ...state.pointer,
            at: performance.now(),
            stage: state.config?.stage,
          });
      },
      true,
    );
  }
  const nativeRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) =>
    nativeRaf((timestamp) => {
      callback(timestamp);
      const canvas = document.querySelector('[data-testid="cad-canvas"]');
      if (canvas) record(canvas, canvas.__cadViewport, "raf-after-callback");
    });
}
async function open(fixture, { dpr = 1 } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: dpr,
  });
  await context.route("**/*", (route) => {
    const target = route.request().url();
    if (
      /^https?:/.test(target) &&
      new URL(target).origin !== new URL(url).origin
    ) {
      results.externalRequests.push(target);
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") results.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => results.pageErrors.push(error.message));
  await page.addInitScript(installRecorder, { fixture, storage });
  await page.goto(url);
  await page
    .locator(".loading-overlay")
    .waitFor({ state: "hidden", timeout: 120000 });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport?.stats
        .frames > 0,
  );
  const canvas = page.getByTestId("cad-canvas");
  const projectToggle = page.locator(
    '.app-header button[aria-label="项目管理"]',
  );
  if ((await projectToggle.getAttribute("aria-pressed")) === "true")
    await projectToggle.click();
  return {
    context,
    page,
    canvas,
    metadata: () => canvas.evaluate((el) => el.__cadViewport),
  };
}
async function settle(session, count = 3) {
  await session.page.evaluate(
    (count) =>
      new Promise((resolve) => {
        const next = () =>
          count-- > 0 ? requestAnimationFrame(next) : resolve();
        requestAnimationFrame(next);
      }),
    count,
  );
}
async function saved(session) {
  await session.page.waitForTimeout(750);
  await session.page.locator('.save-dot[data-saved="true"]').waitFor();
  return session.page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    storage,
  );
}
// Fixed-count tools commit the final canvas pick without a confirm button;
// Escape waits until the persisted sketch really contains the new geometry.
const entityCount = (session) =>
  session.page.evaluate((key) => {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
    return (parsed?.sketches ?? []).reduce(
      (total, sketch) => total + sketch.entities.length,
      0,
    );
  }, storage);
const commitEntities = (session, expected) =>
  session.page.waitForFunction(
    ({ key, expected }) => {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
      return (
        (parsed?.sketches ?? []).reduce(
          (total, sketch) => total + sketch.entities.length,
          0,
        ) >= expected
      );
    },
    { key: storage, expected },
    { timeout: 20000 },
  );
async function screen(session, point) {
  const info = await session.metadata(),
    box = await session.canvas.boundingBox();
  return {
    x: box.x + info.origin.x + point.x * info.scale,
    y: box.y + info.origin.y - point.y * info.scale,
  };
}
async function setStage(session, stage, expected = null) {
  await session.page.evaluate(
    ({ stage, expected }) => {
      window.__groupDrag.config.stage = stage;
      window.__groupDrag.config.expected = expected;
    },
    { stage, expected },
  );
}
async function beginRecording(session, doc, spec) {
  const baseline = pointsOf(doc, spec.ids);
  await session.page.evaluate(
    (config) => {
      Object.assign(window.__groupDrag, {
        active: true,
        accepted: false,
        pointAccepted: {},
        frames: [],
        observations: [],
        inputs: [],
        images: [],
        config,
      });
    },
    {
      entityIds: spec.ids,
      pointIds: Object.keys(baseline),
      baseline,
      geometry: doc.sketches[0].entities,
      constraints: doc.sketches[0].constraints,
      anchorId: spec.anchorId,
      probes: spec.probes || [],
      stage: "start",
      expected: null,
    },
  );
  return baseline;
}
async function stopRecording(session, name) {
  const capture = await session.page.evaluate(() => {
    window.__groupDrag.active = false;
    return window.__groupDrag;
  });
  for (const image of capture.images) {
    const filename = `${name}-frame-${image.frame}-${image.reason}.png`;
    await fs.writeFile(
      path.join(output, filename),
      Buffer.from(image.png.split(",")[1], "base64"),
    );
    image.file = filename;
    delete image.png;
  }
  await fs.writeFile(
    path.join(output, `${name}-frames.json`),
    JSON.stringify(capture, null, 2),
  );
  return capture;
}
async function boxSelectMembers(session, ids) {
  const from = await screen(session, { x: -40, y: 32 }),
    to = await screen(session, { x: 35, y: -30 });
  await session.page.mouse.move(from.x, from.y);
  await session.page.mouse.down();
  await session.page.mouse.move(to.x, to.y, { steps: 6 });
  await session.page.mouse.up();
  await settle(session);
  const selected = await session.page
    .locator(".entity-row.selected")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("title")));
  assert.deepEqual(
    selected.sort(),
    [...ids].sort(),
    "marquee selects all requested whole entities",
  );
}
async function selectMembers(session, ids) {
  for (let i = 0; i < ids.length; i++) {
    await session.page
      .locator(`.entity-row[title="${ids[i]}"]`)
      .click({ modifiers: i ? ["Control"] : [] });
  }
  await settle(session);
  assert.equal(
    await session.page.locator(".entity-row.selected").count(),
    ids.length,
  );
}
function validateConstraints(doc) {
  const sketch = doc.sketches[0];
  const owners = new Map(sketch.entities.map((e) => [e.id, e]));
  const points = new Map(
    sketch.entities.flatMap((e) => e.points.map((p) => [p.id, p])),
  );
  const pair = (refs) =>
    refs.length === 1
      ? owners.get(refs[0]).points.slice(0, 2)
      : refs.map((id) => points.get(id));
  const radius = (e) =>
    e.kind === "arc"
      ? Math.hypot(e.points[1].x - e.points[0].x, e.points[1].y - e.points[0].y)
      : e.radius;
  const tolerance = 1e-4;
  for (const entity of sketch.entities) {
    if (entity.kind !== "arc") continue;
    const [center, start, end] = entity.points;
    assert(
      Math.abs(
        Math.hypot(start.x - center.x, start.y - center.y) -
          Math.hypot(end.x - center.x, end.y - center.y),
      ) < tolerance,
      `arc radii disagree: ${entity.id}`,
    );
  }
  for (const c of sketch.constraints) {
    if (c.kind === "parallel") {
      const [a, b] = c.refs.map((ref) => owners.get(ref));
      const av = {
        x: a.points[1].x - a.points[0].x,
        y: a.points[1].y - a.points[0].y,
      };
      const bv = {
        x: b.points[1].x - b.points[0].x,
        y: b.points[1].y - b.points[0].y,
      };
      assert(
        Math.abs(av.x * bv.y - av.y * bv.x) /
          (Math.hypot(av.x, av.y) * Math.hypot(bv.x, bv.y)) <
          tolerance,
        `parallel sides broken: ${c.id}`,
      );
    }
    if (c.kind === "equal") {
      const values = c.refs.map((ref) => {
        const e = owners.get(ref);
        return e.kind === "line"
          ? Math.hypot(
              e.points[1].x - e.points[0].x,
              e.points[1].y - e.points[0].y,
            )
          : radius(e);
      });
      assert(
        Math.abs(values[0] - values[1]) < tolerance,
        `equal geometry broken: ${c.id}`,
      );
    }
    if (c.kind === "coincident")
      assert(
        near(points.get(c.refs[0]), points.get(c.refs[1]), tolerance),
        `coincidence broken: ${c.id}`,
      );
    if (c.kind === "horizontal" || c.kind === "vertical") {
      const [a, b] = pair(c.refs);
      assert(
        Math.abs(c.kind === "horizontal" ? a.y - b.y : a.x - b.x) < tolerance,
        `axis broken: ${c.id}`,
      );
    }
    if (c.kind === "length") {
      const [a, b] = pair(c.refs);
      assert(
        Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - c.value) < tolerance,
        `length broken: ${c.id}`,
      );
    }
    if (c.kind === "fixed") {
      for (const anchor of c.anchors || [])
        if (points.has(anchor.id))
          assert(
            near(points.get(anchor.id), anchor, tolerance),
            `fixed anchor moved: ${c.id}`,
          );
    }
    if (c.kind === "tangent") {
      const [line, arc] = c.refs.map((id) => owners.get(id));
      if (line.kind !== "line") continue;
      const [a, b] = line.points,
        center = arc.points[0];
      const distance =
        Math.abs(
          (b.x - a.x) * (center.y - a.y) - (b.y - a.y) * (center.x - a.x),
        ) / Math.hypot(b.x - a.x, b.y - a.y);
      assert(
        Math.abs(distance - radius(arc)) < tolerance,
        `tangency broken: ${c.id}`,
      );
    }
  }
}
function distanceToGeometry(point, entity, pose) {
  const ps = entity.points.map((p) => pose[p.id] || p);
  if (entity.kind === "point")
    return Math.hypot(point.x - ps[0].x, point.y - ps[0].y);
  if (entity.kind === "circle" || entity.kind === "arc") {
    const radius =
      entity.kind === "arc"
        ? Math.hypot(ps[1].x - ps[0].x, ps[1].y - ps[0].y)
        : entity.radius;
    return Math.abs(Math.hypot(point.x - ps[0].x, point.y - ps[0].y) - radius);
  }
  if (entity.kind !== "line") return Infinity;
  const [a, b] = ps,
    dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy),
    ),
  );
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}
function validateFrames(capture, { rigid = false, rejected = false } = {}) {
  const { frames, config } = capture;
  assert(
    frames.length >= (rejected ? 8 : 12),
    `need actual canvas frames, recorded ${frames.length}`,
  );
  let accepted = false;
  const pointAccepted = new Set();
  const regressions = [],
    pointRegressions = [],
    poseErrors = [],
    rigidErrors = [],
    cueErrors = [],
    pixelErrors = [];
  let maxDriverError = 0,
    maxRigidError = 0,
    maxCueError = 0;
  const baselinePixels =
    frames.find((frame) => frame.stage === "start")?.pixels || [];
  for (let i = 0; i < config.probes.length; i++)
    assert(
      baselinePixels[i]?.original > 0,
      `baseline pixel probe ${i} missed the actual body`,
    );
  for (const frame of frames) {
    for (const id of config.pointIds)
      assert(
        frame.pose[id],
        `rendered handle missing in actual frame ${frame.frame}: ${id}`,
      );
    validateConstraints({
      sketches: [
        {
          entities: config.geometry.map((entity) => ({
            ...entity,
            points: entity.points.map((point) => ({
              ...point,
              ...(frame.pose[point.id] || {}),
            })),
          })),
          constraints: config.constraints,
        },
      ],
    });
    const cancelled = frame.stage === "cancel";
    if (accepted && frame.distance < 1.5 && !cancelled)
      regressions.push({
        frame: frame.frame,
        stage: frame.stage,
        distance: frame.distance,
        stats: frame.stats,
        pixels: frame.pixels,
      });
    if (frame.distance > 10) accepted = true;
    for (const [id, point] of Object.entries(frame.pose)) {
      const baseline = config.baseline[id];
      const distance =
        Math.hypot(point.x - baseline.x, point.y - baseline.y) * frame.scale;
      if (!cancelled && pointAccepted.has(id) && distance < 1.5)
        pointRegressions.push({
          frame: frame.frame,
          stage: frame.stage,
          id,
          distance,
        });
      if (distance > 10) pointAccepted.add(id);
    }
    if (!cancelled && frame.distance > 12) {
      for (let i = 0; i < frame.pixels.length; i++) {
        const pixel = frame.pixels[i];
        if (!baselinePixels[i]?.original) continue;
        const collision = config.geometry.some(
          (entity) =>
            distanceToGeometry(config.probes[i], entity, frame.pose) *
              frame.scale <
            6,
        );
        if (pixel.progressive === 0)
          pixelErrors.push({
            frame: frame.frame,
            probe: i,
            reason: "progressive-body-missing",
            pixel,
          });
        if (
          !collision &&
          pixel.original >= Math.max(2, baselinePixels[i].original * 0.5)
        )
          pixelErrors.push({
            frame: frame.frame,
            probe: i,
            reason: "original-body-painted-without-geometry",
            pixel,
          });
      }
    }
    if (rejected)
      assert(
        frame.distance < 0.05,
        `rejected group moved ${frame.distance}px in frame ${frame.frame}`,
      );
    if (frame.snap && frame.stage !== "start" && frame.distance > 3) {
      const error =
        Math.hypot(
          frame.pose[config.anchorId].x - frame.snap.point.x,
          frame.pose[config.anchorId].y - frame.snap.point.y,
        ) * frame.scale;
      maxCueError = Math.max(maxCueError, error);
      if (error > 1)
        cueErrors.push({ frame: frame.frame, error, snap: frame.snap });
    }
    if (rigid && frame.distance > 3) {
      for (const [id, point] of Object.entries(config.baseline)) {
        const actual = frame.pose[id];
        if (!actual) continue;
        const error =
          Math.hypot(
            actual.x - point.x - frame.delta.x,
            actual.y - point.y - frame.delta.y,
          ) * frame.scale;
        maxRigidError = Math.max(maxRigidError, error);
        if (error > 1) rigidErrors.push({ frame: frame.frame, id, error });
      }
    }
    if (
      frame.stage?.startsWith("hold") &&
      frame.expected &&
      frames.filter((f) => f.stage === frame.stage).at(-1) === frame &&
      !rejected
    ) {
      const error =
        Math.hypot(
          frame.pose[config.anchorId].x - frame.expected.x,
          frame.pose[config.anchorId].y - frame.expected.y,
        ) * frame.scale;
      maxDriverError = Math.max(maxDriverError, error);
      if (error > 1)
        poseErrors.push({
          frame: frame.frame,
          stage: frame.stage,
          actual: frame.pose[config.anchorId],
          expected: frame.expected,
          error,
        });
    }
  }
  const detail = {
    actualDraws: frames.length,
    rafObservations: capture.observations.length,
    accepted,
    acceptedPointIds: [...pointAccepted],
    regressions,
    pointRegressions,
    poseErrors,
    rigidErrors: rigidErrors.slice(0, 12),
    cueErrors,
    pixelErrors: pixelErrors.slice(0, 12),
    maxDriverError,
    maxRigidError,
    maxCueError,
    baseDraws: [frames[0].stats.baseDraws, frames.at(-1).stats.baseDraws],
    images: capture.images,
  };
  capture.summary = detail;
  assert.equal(
    regressions.length,
    0,
    `original pose reappeared in ${regressions.length} actual canvas frames: ${JSON.stringify(regressions.slice(0, 3))}`,
  );
  assert.equal(
    pointRegressions.length,
    0,
    `group point returned to baseline: ${JSON.stringify(pointRegressions.slice(0, 3))}`,
  );
  assert.equal(
    pixelErrors.length,
    0,
    `native canvas disagrees with progressive geometry: ${JSON.stringify(pixelErrors.slice(0, 3))}`,
  );
  assert.equal(
    poseErrors.length,
    0,
    `held progressive target mismatch: ${JSON.stringify(poseErrors.slice(0, 3))}`,
  );
  assert.equal(
    rigidErrors.length,
    0,
    `rigid group distorted during drag: ${JSON.stringify(rigidErrors.slice(0, 3))}`,
  );
  assert.equal(
    cueErrors.length,
    0,
    `snap cue does not match rendered anchor: ${JSON.stringify(cueErrors.slice(0, 3))}`,
  );
  if (!rejected) assert(accepted, "no valid movement was accepted");
  return detail;
}
async function assertRenderedPose(session, doc, ids) {
  await settle(session, 4);
  const info = await session.metadata();
  for (const [id, point] of Object.entries(pointsOf(doc, ids))) {
    const handle = info.handles.find((h) => h.pointId === id);
    assert(handle, `missing rendered group handle: ${id}`);
    const error = Math.hypot(
      handle.x - info.origin.x - point.x * info.scale,
      handle.y - info.origin.y + point.y * info.scale,
    );
    assert(
      error < 0.1,
      `rendered pose disagrees with restored model for ${id}: ${error}px`,
    );
  }
}
async function exercise(
  session,
  spec,
  {
    cancel = false,
    history = false,
    grid = false,
    endpoint = false,
    rejected = false,
    projected = false,
  } = {},
) {
  if (!grid) {
    await session.page
      .getByRole("checkbox", { name: "\u7f51\u683c", exact: true })
      .uncheck();
    const gridCapture = session.page
      .locator(".bottom-actions")
      .getByRole("button", { name: "\u7f51\u683c\u6355\u83b7", exact: true });
    if ((await gridCapture.getAttribute("aria-pressed")) === "true")
      await gridCapture.click();
  }
  if (!grid && !endpoint)
    await session.page
      .getByRole("checkbox", { name: "\u5438\u9644", exact: true })
      .uncheck();
  if (spec.boxselect) await boxSelectMembers(session, spec.ids);
  else if (spec.multiselect) await selectMembers(session, spec.ids);
  await settle(session);
  const before = await saved(session);
  const observedIds = spec.observedIds || spec.ids;
  const origin = pointsOf(before, observedIds)[spec.anchorId];
  const start = await screen(session, spec.grab);
  await session.page.mouse.move(start.x, start.y);
  await settle(session);
  const baseline = await beginRecording(session, before, {
    ...spec,
    ids: observedIds,
  });
  await session.page.mouse.down();
  await settle(session);
  if (spec.boxselect)
    assert.equal(
      await session.page.locator(".entity-row.selected").count(),
      spec.ids.length,
      "handle press preserves the complete marquee selection",
    );
  const samples = [];
  for (let i = 1; i <= 15; i++) {
    const delta = { x: i * 1.2, y: -i * 0.75 };
    const expected = { x: origin.x + delta.x, y: origin.y + delta.y };
    await setStage(session, `move-${i}`, expected);
    const target = await screen(session, {
      x: spec.grab.x + delta.x,
      y: spec.grab.y + delta.y,
    });
    await session.page.mouse.move(target.x, target.y);
    if (i % 3 === 0) {
      await setStage(session, `hold-${i}`, grid || projected ? null : expected);
      await settle(session, 5);
      samples.push({ stage: `hold-${i}`, metadata: await session.metadata() });
      if (!grid && !rejected && !projected) {
        const handle = samples
          .at(-1)
          .metadata.handles.find((h) => h.pointId === spec.anchorId);
        samples.at(-1).driverError = Math.hypot(
          handle.x -
            samples.at(-1).metadata.origin.x -
            expected.x * samples.at(-1).metadata.scale,
          handle.y -
            samples.at(-1).metadata.origin.y +
            expected.y * samples.at(-1).metadata.scale,
        );
      }
    }
  }
  for (let i = 1; i <= 21; i++) {
    const delta = { x: 18 + (i * 6) / 21, y: -11.25 - (i * 5.75) / 21 };
    await setStage(session, `rapid-${i}`, {
      x: origin.x + delta.x,
      y: origin.y + delta.y,
    });
    const target = await screen(session, {
      x: spec.grab.x + delta.x,
      y: spec.grab.y + delta.y,
    });
    await session.page.mouse.move(target.x, target.y);
  }
  let finalTarget = { x: origin.x + 24, y: origin.y - 17 };
  if (grid) {
    const info = await session.metadata();
    finalTarget = {
      x: Math.round(finalTarget.x / info.gridStep) * info.gridStep,
      y: Math.round(finalTarget.y / info.gridStep) * info.gridStep,
    };
  }
  if (endpoint) finalTarget = { x: 6.7, y: -8.3 };
  const finish = await screen(session, {
    x: spec.grab.x + finalTarget.x - origin.x,
    y: spec.grab.y + finalTarget.y - origin.y,
  });
  await setStage(session, "move-final", finalTarget);
  await session.page.mouse.move(
    finish.x + (grid || endpoint ? 1 : 0),
    finish.y + (grid || endpoint ? 1 : 0),
    { steps: 8 },
  );
  await settle(session, 4);
  await setStage(
    session,
    "hold-final",
    grid || endpoint || projected ? null : finalTarget,
  );
  for (let i = 0; i < 12; i++) {
    await session.page.mouse.move(
      finish.x + (grid || endpoint ? 1 + (i % 3) : 0),
      finish.y + (grid || endpoint ? 1 + (i % 2) : 0),
    );
    await settle(session, 2);
  }
  const live = await session.metadata();
  if (cancel) {
    await setStage(session, "cancel");
    await session.page.keyboard.press("Escape");
  } else await setStage(session, "released");
  await session.page.mouse.up();
  await settle(session, 5);
  const capture = await stopRecording(session, spec.name);
  const after = await saved(session);
  const detail = {
    samples: samples.map(({ stage, driverError }) => ({ stage, driverError })),
    finalTarget,
    snap: live.snap,
    afterPoints: pointsOf(after, observedIds),
    ...capture.summary,
  };
  try {
    const frameSummary = validateFrames(capture, {
      rigid: spec.rigid,
      rejected,
    });
    Object.assign(detail, frameSummary);
    for (const sample of samples)
      if (sample.driverError !== undefined)
        assert(
          sample.driverError < 1,
          `settled driver lag at ${sample.stage}: ${sample.driverError}px`,
        );
    validateConstraints(after);
    assert.equal(
      after.sketches[0].constraints.length,
      before.sketches[0].constraints.length,
      "drag must not add/remove constraints",
    );
    if (cancel || rejected) {
      assert.deepEqual(
        after,
        before,
        "cancelled/rejected drag changed the document",
      );
      if (!spec.created)
        assert(
          await session.page
            .getByRole("button", { name: "\u64a4\u9500 (Ctrl+Z)", exact: true })
            .isDisabled(),
          "cancelled/rejected drag added history",
        );
      await assertRenderedPose(session, before, observedIds);
      if (rejected)
        assert.equal(
          live.snap,
          null,
          "rejected drag must not advertise an incompatible capture",
        );
    } else {
      const actual = pointsOf(after, observedIds)[spec.anchorId];
      if (projected) {
        assert(
          !near(actual, finalTarget, 1 / live.scale),
          "incompatible length-constrained point group reached an impossible target",
        );
        assert.equal(
          live.snap,
          null,
          "incompatible constrained capture cue must be suppressed",
        );
      } else {
        assert(
          near(actual, finalTarget, 1 / live.scale),
          `final driver is ${JSON.stringify(actual)}, expected ${JSON.stringify(finalTarget)}`,
        );
        if (grid || endpoint)
          assert.equal(
            live.snap?.kind,
            endpoint ? "endpoint" : "grid",
            "final hold must advertise achievable capture",
          );
      }
      await assertRenderedPose(session, after, observedIds);
      if (history) {
        await session.page
          .getByRole("button", { name: "\u64a4\u9500 (Ctrl+Z)", exact: true })
          .click();
        const undone = await saved(session);
        assert.deepEqual(
          pointsOf(undone, observedIds),
          baseline,
          "one undo must restore every group member",
        );
        if (spec.boxselect) await selectMembers(session, spec.ids);
        await assertRenderedPose(session, undone, observedIds);
        await session.page
          .getByRole("button", {
            name: "\u91cd\u505a (Ctrl+Shift+Z)",
            exact: true,
          })
          .click();
        const redone = await saved(session);
        assert.deepEqual(
          pointsOf(redone, observedIds),
          pointsOf(after, observedIds),
          "redo must restore final group pose",
        );
        if (spec.boxselect) await selectMembers(session, spec.ids);
        await assertRenderedPose(session, redone, observedIds);
      }
    }
    return detail;
  } finally {
    await fs.writeFile(
      path.join(output, `${spec.name}-summary.json`),
      JSON.stringify({ ...detail, ...capture.summary }, null, 2),
    );
  }
}
async function check(name, fixture, spec, options = {}) {
  if (process.env.CAD_CASE && !name.includes(process.env.CAD_CASE)) return;
  let session;
  try {
    session = await open(fixture, options);
    if (options.create) {
      await session.page
        .getByRole("checkbox", { name: "\u7f51\u683c", exact: true })
        .uncheck();
      await session.page
        .getByRole("checkbox", { name: "\u5438\u9644", exact: true })
        .uncheck();
      if (options.create === "rectangle")
        await session.page
          .getByRole("button", {
            name: "\u4e24\u70b9\u77e9\u5f62",
            exact: true,
          })
          .click();
      else {
        await session.page
          .locator(".dropdown-caption")
          .filter({ hasText: "\u521b\u5efa" })
          .click();
        await session.page
          .getByRole("button", { name: "\u76f4\u7ebf\u69fd", exact: true })
          .click();
      }
      const coords =
        options.create === "rectangle"
          ? [
              { x: -22.3, y: 8.7 },
              { x: -2.3, y: 24.7 },
            ]
          : [
              { x: -22.3, y: 20.7 },
              { x: -2.3, y: 20.7 },
              { x: -2.3, y: 24.7 },
            ];
      const before = await entityCount(session);
      for (const point of coords) {
        const at = await screen(session, point);
        await session.page.mouse.click(at.x, at.y);
        await settle(session);
      }
      // The final pick auto-commits the primitive; Escape leaves the tool
      // only once the persisted document gained all four members.
      await commitEntities(session, before + 4);
      await session.page.keyboard.press("Escape");
      await session.page
        .getByRole("checkbox", { name: "\u5438\u9644", exact: true })
        .check();
      const doc = await saved(session);
      const created = doc.sketches[0].entities.filter((e) => e.id !== "guide");
      assert.equal(
        created.length,
        4,
        "primitive creation must make four members",
      );
      const edges = created.map((e) => e.id);
      spec = {
        ...spec,
        ids: edges,
        anchorId: created[0].points[0].id,
        grab: {
          x: (created[0].points[0].x + created[0].points[1].x) / 2,
          y: (created[0].points[0].y + created[0].points[1].y) / 2,
        },
        created: true,
      };
      if (spec.multiselect) {
        for (let i = 0; i < 4; i++)
          await session.page
            .locator(".entity-row")
            .nth(i + 1)
            .click({ modifiers: i ? ["Control"] : [] });
        spec.multiselect = false;
      }
      results.creation = {
        tool: options.create,
        entities: created,
        constraints: doc.sketches[0].constraints,
      };
    }
    const detail = await exercise(session, { ...spec, name }, options);
    results.checks.push({ name, passed: true, detail });
    console.log(
      `PASS ${name}: ${detail.actualDraws} actual draws, max driver error ${detail.maxDriverError}px`,
    );
  } catch (error) {
    results.checks.push({ name, passed: false, error: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
    if (session) {
      await session.page
        .screenshot({ path: path.join(output, `${name}-failure.png`) })
        .catch(() => {});
      const capture = await stopRecording(session, name).catch(() => null);
      if (capture) results.checks.at(-1).actualDraws = capture.frames.length;
    }
  } finally {
    if (session) await session.context.close();
  }
}
const rect = {
  ids: ["edge0", "edge1", "edge2", "edge3"],
  anchorId: "edge0_p0",
  grab: { x: -12.3, y: 8.7 },
  probes: [{ x: -15.7, y: 8.7 }],
};
const slotSpec = {
  ids: ["slot0", "slot1", "slot2", "slot3"],
  anchorId: "slot0_p0",
  grab: { x: -12.3, y: 24.7 },
  probes: [{ x: -15.7, y: 24.7 }],
};
const chain = {
  ids: ["chain0", "chain1", "chain2"],
  anchorId: "chain0_p0",
  grab: { x: -17.3, y: 11.7 },
  probes: [{ x: -20.5, y: 10.5 }],
};
const mixedGrips = [
  entity("line", "mixed-line", [
    [-26, 8],
    [-14, 15],
  ]),
  entity("circle", "mixed-circle", [[-21, 16]], { radius: 5 }),
  entity(
    "arc",
    "mixed-arc",
    [
      [-21, 13],
      [-16, 13],
      [-21, 18],
    ],
    { radius: 5, ccw: true },
  ),
  entity(
    "ellipse",
    "mixed-ellipse",
    [
      [-22, 14],
      [-15, 14],
    ],
    { ry: 4 },
  ),
  entity("spline", "mixed-spline", [
    [-28, 8],
    [-23, 19],
    [-18, 5],
    [-12, 15],
  ]),
  entity("bezier", "mixed-bezier", [
    [-28, 8],
    [-27, 21],
    [-17, 4],
    [-12, 15],
  ]),
  entity(
    "conic",
    "mixed-conic",
    [
      [-28, 8],
      [-22, 21],
      [-12, 10],
    ],
    { weight: 0.65 },
  ),
  entity("point", "mixed-point", [[-21, 16]]),
  entity("text", "mixed-text", [[-23, 12]], {
    text: "ABC",
    fontSize: 3,
    rotation: 15,
  }),
];
const mixedPeers = () => [
  entity("line", "peer-line", [
    [15, -10],
    [25, -8],
  ]),
  entity("point", "peer-point", [[24, 22]]),
];
try {
  for (const primary of mixedGrips) {
    for (let index = 0; index < primary.points.length; index++) {
      const name = `marquee-${primary.kind}-handle-${index}`;
      await check(
        name,
        documentFixture([primary, ...mixedPeers()]),
        {
          ids: [primary.id, "peer-line", "peer-point"],
          anchorId: primary.points[0].id,
          grab: primary.points[index],
          boxselect: true,
          rigid: true,
        },
        { history: index === 0 },
      );
    }
  }
  const mixedCircle = mixedGrips.find((e) => e.kind === "circle");
  const circleGroup = {
    ids: [mixedCircle.id, "peer-line", "peer-point"],
    anchorId: mixedCircle.points[0].id,
    grab: mixedCircle.points[0],
    boxselect: true,
    rigid: true,
  };
  await check(
    "marquee-circle-control-cancel",
    documentFixture([mixedCircle, ...mixedPeers()]),
    circleGroup,
    { cancel: true },
  );
  await check(
    "marquee-circle-fixed-peer",
    documentFixture(
      [mixedCircle, ...mixedPeers()],
      [{ id: "peer-fixed", kind: "fixed", refs: ["peer-line"] }],
    ),
    circleGroup,
    { rejected: true },
  );
  await check(
    "marquee-circle-control-dpr2",
    documentFixture([mixedCircle, ...mixedPeers()]),
    circleGroup,
    { dpr: 2, history: true },
  );
  await check(
    "marquee-circle-body",
    documentFixture([mixedCircle, ...mixedPeers()]),
    {
      ...circleGroup,
      grab: {
        x: mixedCircle.points[0].x + mixedCircle.radius,
        y: mixedCircle.points[0].y,
      },
    },
    { history: true },
  );
  await check(
    "marquee-circle-grid-capture",
    documentFixture([mixedCircle, ...mixedPeers()]),
    circleGroup,
    { grid: true, history: true },
  );
  const circleEndpointDoc = documentFixture(
    [
      mixedCircle,
      ...mixedPeers(),
      entity("line", "external-capture", [
        [6.7, -8.3],
        [60, -8.3],
      ]),
    ],
    [
      {
        id: "external-capture-fixed",
        kind: "fixed",
        refs: ["external-capture"],
      },
    ],
  );
  await check(
    "marquee-circle-endpoint-capture",
    circleEndpointDoc,
    circleGroup,
    { endpoint: true, history: true },
  );
  await check("rectangle-single-edge", rectangle(), rect);
  await check(
    "rectangle-all-members",
    rectangle(),
    { ...rect, multiselect: true, rigid: true },
    { history: true },
  );
  await check("rectangle-created-body", documentFixture(), rect, {
    create: "rectangle",
  });
  await check(
    "rectangle-created-all-members",
    documentFixture(),
    { ...rect, multiselect: true, rigid: true },
    { create: "rectangle" },
  );
  await check("slot-tangent-single-edge", slot(), slotSpec);
  await check(
    "slot-tangent-all-members",
    slot(),
    { ...slotSpec, multiselect: true, rigid: true },
    { history: true },
  );
  await check("slot-created-body", documentFixture(), slotSpec, {
    create: "slot",
  });
  await check(
    "dimensioned-plate-single-edge",
    rectangle({ dimensioned: true }),
    { ...rect, rigid: true },
  );
  await check(
    "dimensioned-plate-grid-hold",
    rectangle({ dimensioned: true }),
    { ...rect, multiselect: true, rigid: true },
    { grid: true, history: true },
  );
  const endpointDoc = rectangle({ dimensioned: true });
  endpointDoc.sketches[0].entities.push(
    entity("line", "capture", [
      [6.7, -8.3],
      [11.7, -13.3],
    ]),
  );
  endpointDoc.sketches[0].constraints.push({
    id: "capture-fixed",
    kind: "fixed",
    refs: ["capture"],
  });
  await check(
    "dimensioned-plate-endpoint-hold",
    endpointDoc,
    { ...rect, multiselect: true, rigid: true },
    { endpoint: true },
  );
  await check("polyline-connected-body", polyline(), chain);
  await check("polyline-all-members", polyline(), {
    ...chain,
    multiselect: true,
    rigid: true,
  });
  await check("coincident-point-group-free", pointGroup(), {
    ids: ["peer0", "peer1", "peer2"],
    anchorId: "peer2_p0",
    grab: { x: -22.3, y: 8.7 },
  });
  await check(
    "coincident-point-group-fixed",
    pointGroup(true),
    {
      ids: ["peer0", "peer1", "peer2"],
      anchorId: "peer2_p0",
      grab: { x: -22.3, y: 8.7 },
    },
    { rejected: true },
  );
  await check(
    "coincident-point-group-incompatible",
    tetheredPointGroup(),
    {
      ids: ["tether", "peer0", "peer1"],
      anchorId: "peer1_p0",
      grab: { x: -22.3, y: 8.7 },
    },
    { projected: true, grid: true, history: true },
  );
  await check(
    "rectangle-fixed-member-incompatible",
    rectangle({ dimensioned: true, fixed: true }),
    { ...rect, multiselect: true },
    { rejected: true },
  );
  await check(
    "rectangle-group-cancel",
    rectangle({ dimensioned: true }),
    { ...rect, multiselect: true, rigid: true },
    { cancel: true, grid: true },
  );
  await check(
    "rectangle-associated-array",
    arrayPlate(),
    {
      ...rect,
      multiselect: true,
      rigid: true,
      observedIds: [...rect.ids, ...rect.ids.map((id) => `array-${id}`)],
    },
    { history: true },
  );
  await check(
    "rectangle-group-dpr2",
    rectangle({ dimensioned: true }),
    { ...rect, multiselect: true, rigid: true },
    { dpr: 2, history: true },
  );
} finally {
  results.finished = new Date().toISOString();
  results.passed =
    results.checks.every((check) => check.passed) &&
    results.checks.length > 0 &&
    !results.consoleErrors.length &&
    !results.pageErrors.length;
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
  console.log(
    `Browser closed. ${results.checks.filter((check) => check.passed).length}/${results.checks.length} checks passed. Artifacts: ${output}`,
  );
  if (!results.passed) process.exitCode = 1;
}
