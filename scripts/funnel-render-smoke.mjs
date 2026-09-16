#!/usr/bin/env node
/**
 * Render smoke test for the funnel charts.
 *
 *   node scripts/funnel-render-smoke.mjs
 *
 * The palette validator checks colour, not geometry, and the charts are
 * hand-rolled SVG — so the failure mode they actually have is arithmetic:
 * a NaN coordinate from dividing by zero, a negative bar height, an Infinity
 * from an empty dataset. Those render as an invisible or corrupt chart rather
 * than an error, which is exactly the kind of bug a passing build hides.
 *
 * This renders every chart to static markup across the awkward datasets —
 * empty, a single point, all-zero, one huge outlier — and fails on any
 * non-finite number or negative dimension in the emitted SVG.
 *
 * It is NOT a substitute for looking at the page. It cannot see a label
 * collision or an overflow. It catches the class of bug that is invisible in a
 * screenshot taken on friendly data.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { createRequire } from "module";
import { execFileSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

let pass = 0; const fails = [];
const ok = (l, c, d = "") => { if (c) { pass++; return; } fails.push(`${l}${d ? "  [" + d + "]" : ""}`); };

/**
 * The components are TSX, which Node cannot strip. Compile just this component
 * file plus a harness to plain JS with the project's own esbuild (bundled with
 * Next), then render with react-dom/server.
 */

/** Rendered with react-dom/server against the awkward datasets, not friendly ones. */
const HARNESS = `
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { FunnelChart, TrendChart, BarChart, InlineBar } from "./charts";

const out = {};
const render = (name, el) => { try { out[name] = renderToStaticMarkup(el); } catch (e) { out[name] = "THREW: " + e.message; } };
const stage = (label, count, conv, share) => ({ key: label, label, count, conversionFromPrev: conv, shareOfTop: share });
const pt = (d, a, b, c, e) => ({ capturedAt: d, reachedOut: a, sentVerification: b, verified: c, booked: e });

render("funnel_normal", React.createElement(FunnelChart, { stages: [stage("A", 74, null, 100), stage("B", 63, 85.1, 85.1), stage("C", 21, 33.3, 28.4), stage("D", 8, 38.1, 10.8)], biggestDropIndex: 2 }));
render("funnel_empty", React.createElement(FunnelChart, { stages: [stage("A", 0, null, 0), stage("B", 0, 0, 0)], biggestDropIndex: null }));
render("funnel_allsame", React.createElement(FunnelChart, { stages: [stage("A", 5, null, 100), stage("B", 5, 100, 100)], biggestDropIndex: null }));
render("funnel_outlier", React.createElement(FunnelChart, { stages: [stage("A", 100000, null, 100), stage("B", 1, 0, 0)], biggestDropIndex: 1 }));

render("trend_empty", React.createElement(TrendChart, { points: [], markers: [] }));
render("trend_one", React.createElement(TrendChart, { points: [pt("2026-09-01T00:00:00.000Z", 5, 4, 1, 0)], markers: [] }));
render("trend_two", React.createElement(TrendChart, { points: [pt("2026-09-01T00:00:00.000Z", 5, 4, 1, 0), pt("2026-09-02T00:00:00.000Z", 9, 7, 3, 1)], markers: [] }));
render("trend_zeros", React.createElement(TrendChart, { points: [pt("2026-09-01T00:00:00.000Z", 0, 0, 0, 0), pt("2026-09-02T00:00:00.000Z", 0, 0, 0, 0)], markers: [] }));
render("trend_marker", React.createElement(TrendChart, { points: [pt("2026-09-01T00:00:00.000Z", 5, 4, 1, 0), pt("2026-09-02T00:00:00.000Z", 9, 7, 3, 1)], markers: [{ capturedAt: "2026-09-02T00:00:00.000Z", enabled: false }] }));
render("trend_many", React.createElement(TrendChart, { points: Array.from({ length: 40 }, (_, i) => pt(new Date(Date.UTC(2026, 8, 1) + i * 86400000).toISOString(), i, i - 1, Math.floor(i / 3), Math.floor(i / 9))), markers: [] }));
render("trend_baddate", React.createElement(TrendChart, { points: [pt("not-a-date", 3, 2, 1, 0)], markers: [] }));

render("bar_empty", React.createElement(BarChart, { categories: [], series: [] }));
render("bar_zeros", React.createElement(BarChart, { categories: ["a", "b"], series: [{ label: "x", color: "red", values: [0, 0] }] }));
render("bar_single", React.createElement(BarChart, { categories: ["only"], series: [{ label: "x", color: "red", values: [5] }] }));
render("bar_two_series", React.createElement(BarChart, { categories: ["a", "b", "c", "d", "e"], series: [{ label: "x", color: "red", values: [5, 3, 0, 9, 1] }, { label: "y", color: "blue", values: [2, 0, 0, 4, 1] }] }));
render("bar_outlier", React.createElement(BarChart, { categories: ["a", "b"], series: [{ label: "x", color: "red", values: [100000, 1] }] }));
render("bar_missing_values", React.createElement(BarChart, { categories: ["a", "b", "c"], series: [{ label: "x", color: "red", values: [1] }] }));

render("inlinebar_zeromax", React.createElement(InlineBar, { value: 0, max: 0, color: "red" }));
render("inlinebar_normal", React.createElement(InlineBar, { value: 3, max: 10, color: "red" }));

console.log(JSON.stringify(out));
`;

function build() {
  // No esbuild in this project (Next 16 bundles with its own toolchain), so the
  // TSX is transpiled with the TypeScript compiler that is already a dev
  // dependency — no new package for a test.
  //
  // The output lands inside node_modules/.cache so that Node's resolution walks
  // up and finds `react` from the project, which it would not do from the OS
  // temp directory.
  const ts = require(resolve(ROOT, "node_modules/typescript"));
  const outDir = resolve(ROOT, "node_modules/.cache/rf-funnel-render");
  mkdirSync(outDir, { recursive: true });

  const compile = (src, file) =>
    ts.transpileModule(src, {
      fileName: file,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;

  const chartsSrc = readFileSync(resolve(ROOT, "src/components/funnel/charts.tsx"), "utf8");
  writeFileSync(resolve(outDir, "charts.js"), compile(chartsSrc, "charts.tsx"));
  writeFileSync(resolve(outDir, "harness.js"), compile(HARNESS, "harness.tsx"));
  return resolve(outDir, "harness.js");
}

async function main() {
  console.log("═".repeat(72));
  console.log("FUNNEL CHART RENDER SMOKE TEST");
  console.log("═".repeat(72));

  let bundle;
  try { bundle = build(); }
  catch (e) {
    console.error("✗ could not bundle the chart components:\n" + String(e.stdout || e.message).slice(0, 900));
    return done(1);
  }

  const raw = execFileSync("node", [bundle], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const rendered = JSON.parse(raw.trim().split("\n").pop());

  console.log(`\nrendered ${Object.keys(rendered).length} chart variants\n`);

  for (const [name, html] of Object.entries(rendered)) {
    ok(`${name}: did not throw`, !html.startsWith("THREW:"), html.slice(0, 160));
    if (html.startsWith("THREW:")) continue;

    // The bugs that render silently rather than erroring.
    ok(`${name}: no NaN in output`, !/NaN/.test(html), (html.match(/[^"]*NaN[^"]*/) ?? [""])[0].slice(0, 80));
    ok(`${name}: no Infinity in output`, !/Infinity/.test(html));
    ok(`${name}: no undefined in an attribute`, !/="[^"]*undefined[^"]*"/.test(html));

    // Negative geometry paints nothing, or paints inverted.
    const negAttr = html.match(/\b(width|height|r|rx)="(-[\d.]+)"/);
    ok(`${name}: no negative geometry`, !negAttr, negAttr ? negAttr[0] : "");

    // A path with a non-finite coordinate.
    for (const d of html.matchAll(/ d="([^"]+)"/g)) {
      ok(`${name}: path coords are finite`, !/(NaN|Infinity|e\+)/.test(d[1]), d[1].slice(0, 80));
    }
    // A percentage width outside 0–100 overflows its container.
    for (const w of html.matchAll(/width:\s*([-\d.]+)%/g)) {
      const v = Number(w[1]);
      ok(`${name}: width% within bounds`, Number.isFinite(v) && v >= 0 && v <= 100, w[1]);
    }
  }

  // The empty states must actually say something, not render a blank box.
  ok("trend_empty explains itself", /snapshot/i.test(rendered.trend_empty), rendered.trend_empty.slice(0, 120));
  ok("bar_empty explains itself", /nothing to show/i.test(rendered.bar_empty));
  ok("funnel_empty explains itself", /no leads/i.test(rendered.funnel_empty));
  // A single snapshot must draw points, not a line pretending one day is a trend.
  ok("trend_one draws markers, not a line", rendered.trend_one.includes("<circle") && !rendered.trend_one.includes("<path"));
  ok("trend_two draws a line", rendered.trend_two.includes("<path"));
  ok("trend_marker renders its annotation", /ID check/.test(rendered.trend_marker));

  console.log("═".repeat(72));
  if (fails.length === 0) {
    console.log(`✓ ${pass} assertions passed, 0 failures.`);
    console.log("  NOTE: geometry only. This cannot see label collisions or overflow —");
    console.log("  open /funnel in a browser for that.");
    return done(0);
  }
  console.log(`✗ ${pass} passed, ${fails.length} FAILED:`);
  for (const f of fails) console.log("   " + f);
  return done(1);
}

await main();
