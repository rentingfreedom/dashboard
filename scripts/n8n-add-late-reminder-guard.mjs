#!/usr/bin/env node
/**
 * Suppresses pre-event reminders whose target time had already passed when the
 * booking was made (or last rescheduled).
 *
 *   node scripts/n8n-add-late-reminder-guard.mjs            # dry run
 *   node scripts/n8n-add-late-reminder-guard.mjs --apply    # push
 *   node scripts/n8n-add-late-reminder-guard.mjs --revert --apply
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * `Find Due Notifications` marks an anchor:'start' step due when
 * `now >= startMs - offsetHours` and `now < startMs`. For a booking created
 * *inside* that window the target is already in the past, so the step fires on
 * the very next 5-minute tick. Observed live: an 8:00am showing booked at
 * 8:32pm the night before got its "24 hour reminder" at T-11.4h, minutes after
 * the confirmation text. The guest gets two near-identical messages back to
 * back and neither reads like a reminder.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 * Skip the step when the booking was made after the step's target time. No
 * write and no new state: `targetMs` and `bookedMs` are both fixed, so the
 * condition is permanently true and the step simply never becomes due. The
 * `_sent` column stays FALSE, which is accurate — it was never sent. A
 * console.log makes the decision visible in the execution log instead.
 *
 * ── Why `updated_at`, not `created_at` ──────────────────────────────────────
 * `created_at` is wrong for reschedules: a booking made three days ago and
 * moved to two hours from now would still have an old `created_at`, so the
 * guard would not fire and the guest would get an instant "24 hour reminder"
 * for an event moved into the near future. `updated_at` is rewritten by
 * `Reset Row Fields (by old uid)` on every reschedule, alongside the new
 * start/end time — so it means "when this booking's time was last set".
 *
 * Verified before building this (2026-07-31): the cron's `Mark Step Sent`
 * writes ONLY the sentCol:atCol range via values:batchUpdate and does NOT
 * touch `updated_at`. That matters — if per-step marking advanced it, sending
 * the 24h reminder would push `updated_at` forward and wrongly suppress the 2h
 * one. Re-check that if `Mark Step Sent` is ever rewritten.
 *
 * We take max(created_at, updated_at) for safety, and if neither parses the
 * guard is skipped entirely — degrading to exactly today's behaviour rather
 * than silently muting reminders.
 *
 * anchor:'end' follow-ups are deliberately untouched: they are supposed to
 * catch up after a missed cycle (see "Cron Poll" in docs/n8n-workflows.md).
 *
 * Idempotent (marker LATE_REMINDER_MARKER). Backup in
 * n8n/BEFORE-late-reminder-guard/.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const MARKER = "LATE_REMINDER_MARKER";
const WF = "3hGnl6mPnu2AMbZ1";
const NODE = "Find Due Notifications";
const BASE = "https://automation.rentingfreedom.com/api/v1";
const ALLOWED_SETTINGS = new Set([
  "executionOrder",
  "saveManualExecutions",
  "callerPolicy",
  "errorWorkflow",
  "timezone",
]);

const n8n = async (path, init = {}) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: {
      "X-N8N-API-KEY": process.env.N8N_API_KEY,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  let body;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body };
};

const PATCHES = [
  {
    label: "compute bookedMs per row",
    find: `  const startMs = new Date(row.start_time).getTime();
  const endMs = new Date(row.end_time || row.start_time).getTime();
  if (!Number.isFinite(startMs)) continue;`,
    replace: `  const startMs = new Date(row.start_time).getTime();
  const endMs = new Date(row.end_time || row.start_time).getTime();
  if (!Number.isFinite(startMs)) continue;

  // ── ${MARKER} ─────────────────────────────────────────────────────────
  // When this booking's time was last set. updated_at (not created_at) so a
  // reschedule re-anchors it; the cron's Mark Step Sent does not touch it.
  // If neither timestamp parses we leave bookedMs non-finite, which disables
  // the guard below and restores the pre-guard behaviour.
  const createdMs_ = new Date(row.created_at).getTime();
  const updatedMs_ = new Date(row.updated_at).getTime();
  const bookedMs = Math.max(
    Number.isFinite(createdMs_) ? createdMs_ : -Infinity,
    Number.isFinite(updatedMs_) ? updatedMs_ : -Infinity
  );`,
  },
  {
    label: "guard the anchor:'start' due check",
    find: `      const targetMs = startMs - offsetHours * 3600000;
      due_ = now >= targetMs && now < startMs;`,
    replace: `      const targetMs = startMs - offsetHours * 3600000;
      // ── ${MARKER} ───────────────────────────────────────────────────
      // The booking was made after this reminder was due, so it was never a
      // real advance reminder — the guest already got the confirmation. Skip
      // permanently (both operands are fixed) rather than firing it late.
      if (Number.isFinite(bookedMs) && bookedMs > targetMs) {
        console.log('[late-reminder-guard] skip ' + rule.key + ' for ' + row.booking_uid +
          ' — booked ' + new Date(bookedMs).toISOString() +
          ' after target ' + new Date(targetMs).toISOString());
        continue;
      }
      due_ = now >= targetMs && now < startMs;`,
  },
];

const cacheDir = resolve(__dirname, "../n8n/BEFORE-late-reminder-guard");
if (APPLY) mkdirSync(cacheDir, { recursive: true });

console.log("═".repeat(72));
console.log(`LATE REMINDER GUARD  —  ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const r = await n8n(`/workflows/${WF}`);
if (r.status >= 300) {
  console.error(`✗ fetch failed: ${r.status}`);
  process.exit(1);
}
const wf = r.body;
if (APPLY) writeFileSync(`${cacheDir}/${WF}.json`, JSON.stringify(wf, null, 2));

const node = wf.nodes.find((n) => n.name === NODE);
if (!node) {
  console.error(`✗ node "${NODE}" not found`);
  process.exit(1);
}

let code = node.parameters.jsCode ?? "";
let changed = 0;
let failures = 0;

for (const p of PATCHES) {
  console.log(`\n${NODE} → ${p.label}`);
  if (REVERT) {
    if (!code.includes(p.replace)) {
      console.log("  · not present — nothing to revert");
      continue;
    }
    code = code.replace(p.replace, p.find);
    console.log("  ✓ reverted");
    changed++;
  } else {
    if (code.includes(p.replace)) {
      console.log("  · already patched — skipping");
      continue;
    }
    if (!code.includes(p.find)) {
      console.error("  ✗ anchor text not found — workflow drifted, patch by hand");
      failures++;
      continue;
    }
    code = code.replace(p.find, p.replace);
    console.log("  ✓ patched");
    changed++;
  }
}

console.log("\n" + "─".repeat(72));
if (failures) {
  console.error(`✗ ${failures} failure(s) — refusing to push a partial patch.`);
  process.exit(1);
}
if (!changed) {
  console.log("Nothing to do.");
  process.exit(0);
}
if (!APPLY) {
  console.log(`Dry run — ${changed} change(s) staged. Re-run with --apply.`);
  process.exit(0);
}

node.parameters.jsCode = code;
const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${WF}`, {
  method: "PUT",
  body: JSON.stringify({
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings,
    staticData: wf.staticData ?? null,
  }),
});
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
  process.exit(1);
}
console.log(`✓ pushed ${wf.name} (active=${put.body.active})`);
console.log(`Backup: n8n/BEFORE-late-reminder-guard/`);
