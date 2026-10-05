#!/usr/bin/env node
/**
 * Item 1 (Justin feedback, 2026-09-28): remove the review-request language
 * from post-visit follow-ups sent after a self-guided showing (SGT).
 *
 * Client's own clarification of scope (2026-09-28): remove review LANGUAGE
 * only, keep the "still interested? apply here" nudges.
 *
 *   - Day-0 `followup` email for `showing` is PURE review request ("please
 *     leave your feedback") with nothing else worth keeping, so it is
 *     removed entirely -- the rule no longer fires for `showing` at all.
 *   - Day 1/2/3 `followup_1day_email` / `followup_2day_email` /
 *     `followup_3day_email` for `showing` mix an apply-link nudge with a
 *     review-link sentence -- only the review-link sentence is stripped.
 *   - Day 1/2/3 SMS (`followup_1day_sms` etc.) already has no review
 *     language for `showing` -- untouched.
 *   - walkthrough / consult follow-ups are OUT OF SCOPE (not self-guided
 *     tours) -- untouched.
 *
 * Two nodes in `3hGnl6mPnu2AMbZ1` (Cal Reminder - Cron Poll):
 *   - `Find Due Notifications` -- the `followup` rule's `categories` drops
 *     `'showing'`, so it is never selected as due for a showing booking.
 *   - `Build Message` -- the day-0 `followup` case no longer branches on
 *     `showing` (unreachable after the rule change, so the branch is
 *     removed rather than left as dead code); the three day-N email cases
 *     drop the "leave feedback" sentence for `showing`.
 *
 * SHOWING_CODE_GATE_MARKER's `FOLLOWUP_KEYS` set (also in `Find Due
 * Notifications`) is left untouched -- it still lists `'followup'`, but
 * that is now inert for `showing` since the rule can never select it for
 * that category. No functional change, so no reason to touch it.
 *
 *   node scripts/n8n-remove-showing-review-messages.mjs            # dry run
 *   node scripts/n8n-remove-showing-review-messages.mjs --apply
 *   node scripts/n8n-remove-showing-review-messages.mjs --revert --apply
 *
 * Idempotent (checked by marker string in jsCode). Backup in
 * n8n/BEFORE-showing-review-removal/.
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

const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error("✗ N8N_API_KEY missing from .env.local"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "3hGnl6mPnu2AMbZ1";
const MARKER = "SHOWING_REVIEW_REMOVED_MARKER";

const ALLOWED_SETTINGS = new Set([
  "executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone",
]);

async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-showing-review-removal");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const findNode = wf.nodes.find((n) => n.name === "Find Due Notifications");
const buildNode = wf.nodes.find((n) => n.name === "Build Message");
if (!findNode) { console.error(`✗ node "Find Due Notifications" not found`); process.exit(1); }
if (!buildNode) { console.error(`✗ node "Build Message" not found`); process.exit(1); }

const findCode = findNode.parameters.jsCode;
const buildCode = buildNode.parameters.jsCode;
const alreadyApplied = buildCode.includes(MARKER);

// ── Find Due Notifications: drop 'showing' from the `followup` rule ────────
const FIND_RULE =
  "  { key: 'followup', channel: 'email', categories: ['walkthrough', 'consult', 'showing'], anchor: 'end', offsetHours: 0, sentCol: 'followup_sent', atCol: 'followup_sent_at' },";
const REPLACE_RULE =
  "  { key: 'followup', channel: 'email', categories: ['walkthrough', 'consult'], anchor: 'end', offsetHours: 0, sentCol: 'followup_sent', atCol: 'followup_sent_at' },";

// ── Build Message: day-0 `followup` case, remove the showing branch ────────
const FIND_FOLLOWUP_CASE =
  "    case 'followup':\n" +
  "      if (d.category === 'showing') {\n" +
  "        subject = `${d.invitee_name} Thank you for your Time! Please leave your Feedback!`;\n" +
  "        message = `Hi ${d.invitee_name}, Thank you for attending ${eventName} at ${timeStr} on ${dateStr}. Here is a link to apply for the property <a href=\"${doorloopLink}\">Apply Here</a>. You can also leave feedback on the property here. <a href=\"${reviewLink}\">Leave Feedback Here</a>`;\n" +
  "      } else {\n" +
  "        subject = 'Thank you for your time!';\n" +
  "        if (d.category === 'consult') {\n" +
  "          message = `Hi ${d.invitee_name}, Thank you for attending ${eventName} at ${timeStr} on ${dateStr}. I hope I was able to answer all of your questions. Like I mentioned the next step would be to schedule a property walk through using the following link <a href=\"${walkthroughUrl}\">Schedule Property Walkthrough</a>. If you have any additional questions please respond to this email. Here is a link to our review page. Please take a moment to rate how your experience was during our consultation today! <a href=\"${reviewLink}\">Please Leave a Review</a>`;\n" +
  "        } else {\n" +
  "          message = `Hi ${d.invitee_name}, Thank you for attending ${eventName} at ${timeStr} on ${dateStr}.<br><br>Here is a link to our review page. <a href=\"${reviewLink}\">Leave a Review</a> Please take a moment to rate how well we were able to help guide you through the decision making process of renting or selling your home.`;\n" +
  "        }\n" +
  "      }\n" +
  "      break;";
const REPLACE_FOLLOWUP_CASE =
  "    case 'followup':\n" +
  `      // ${MARKER}: 'showing' is no longer in this rule's categories\n` +
  "      // (see Find Due Notifications), so a self-guided-showing lead never\n" +
  "      // reaches this pure review-request email. Only walkthrough/consult do.\n" +
  "      subject = 'Thank you for your time!';\n" +
  "      if (d.category === 'consult') {\n" +
  "        message = `Hi ${d.invitee_name}, Thank you for attending ${eventName} at ${timeStr} on ${dateStr}. I hope I was able to answer all of your questions. Like I mentioned the next step would be to schedule a property walk through using the following link <a href=\"${walkthroughUrl}\">Schedule Property Walkthrough</a>. If you have any additional questions please respond to this email. Here is a link to our review page. Please take a moment to rate how your experience was during our consultation today! <a href=\"${reviewLink}\">Please Leave a Review</a>`;\n" +
  "      } else {\n" +
  "        message = `Hi ${d.invitee_name}, Thank you for attending ${eventName} at ${timeStr} on ${dateStr}.<br><br>Here is a link to our review page. <a href=\"${reviewLink}\">Leave a Review</a> Please take a moment to rate how well we were able to help guide you through the decision making process of renting or selling your home.`;\n" +
  "      }\n" +
  "      break;";

// ── Build Message: day 1/2 email, strip the review-link sentence ───────────
const FIND_1_2_DAY =
  "    case 'followup_1day_email':\n" +
  "    case 'followup_2day_email':\n" +
  "      subject = `${d.invitee_first_name} are you still Interested in ${answer1}?`;\n" +
  "      message = `Hi ${d.invitee_name}, Thank you for attending ${eventName} at ${timeStr} on ${dateStr}. Here is a link to apply to ${answer1} <a href=\"${doorloopLink}\">Apply Here</a>. You can also leave feedback on the property here. <a href=\"${reviewLink}\">Leave Feedback Here</a>`;\n" +
  "      break;";
const REPLACE_1_2_DAY =
  "    case 'followup_1day_email':\n" +
  "    case 'followup_2day_email':\n" +
  "      subject = `${d.invitee_first_name} are you still Interested in ${answer1}?`;\n" +
  "      message = `Hi ${d.invitee_name}, Thank you for attending ${eventName} at ${timeStr} on ${dateStr}. Here is a link to apply to ${answer1} <a href=\"${doorloopLink}\">Apply Here</a>.`;\n" +
  "      break;";

// ── Build Message: day 3 email, strip the review-link sentence (showing only) ──
const FIND_3_DAY =
  "    case 'followup_3day_email':\n" +
  "      if (d.category === 'showing') {\n" +
  "        subject = `${d.invitee_first_name} are you still Interested in ${answer1}?`;\n" +
  "        message = `Hi ${d.invitee_name}, Thank you for attending ${eventName} at ${timeStr} on ${dateStr}. Here is a link to apply to ${answer1} <a href=\"${doorloopLink}\">Apply Here</a>. You can also leave feedback on the property here. <a href=\"${reviewLink}\">Leave Feedback Here</a>`;\n" +
  "      } else {";
const REPLACE_3_DAY =
  "    case 'followup_3day_email':\n" +
  "      if (d.category === 'showing') {\n" +
  "        subject = `${d.invitee_first_name} are you still Interested in ${answer1}?`;\n" +
  "        message = `Hi ${d.invitee_name}, Thank you for attending ${eventName} at ${timeStr} on ${dateStr}. Here is a link to apply to ${answer1} <a href=\"${doorloopLink}\">Apply Here</a>.`;\n" +
  "      } else {";

if (REVERT) {
  if (!alreadyApplied) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  const nextFind = findCode.replace(REPLACE_RULE, FIND_RULE);
  const nextBuild = buildCode
    .replace(REPLACE_FOLLOWUP_CASE, FIND_FOLLOWUP_CASE)
    .replace(REPLACE_1_2_DAY, FIND_1_2_DAY)
    .replace(REPLACE_3_DAY, FIND_3_DAY);
  if (nextFind === findCode || nextBuild === buildCode) {
    console.error("✗ revert patterns not found — refusing to guess"); process.exit(1);
  }
  findNode.parameters.jsCode = nextFind;
  buildNode.parameters.jsCode = nextBuild;
  console.log("· reverted: restored 'showing' to the followup rule and restored review-link sentences");
} else {
  if (alreadyApplied) { console.log("✓ already patched — nothing to do"); process.exit(0); }
  const missing = [];
  if (!findCode.includes(FIND_RULE)) missing.push("Find Due Notifications: followup rule");
  if (!buildCode.includes(FIND_FOLLOWUP_CASE)) missing.push("Build Message: followup case");
  if (!buildCode.includes(FIND_1_2_DAY)) missing.push("Build Message: followup_1day/2day_email case");
  if (!buildCode.includes(FIND_3_DAY)) missing.push("Build Message: followup_3day_email case");
  if (missing.length) {
    console.error("✗ expected code not found, refusing to guess:\n  " + missing.join("\n  "));
    process.exit(1);
  }

  findNode.parameters.jsCode = findCode.replace(FIND_RULE, REPLACE_RULE);
  buildNode.parameters.jsCode = buildCode
    .replace(FIND_FOLLOWUP_CASE, REPLACE_FOLLOWUP_CASE)
    .replace(FIND_1_2_DAY, REPLACE_1_2_DAY)
    .replace(FIND_3_DAY, REPLACE_3_DAY);

  console.log("· patched: day-0 review email no longer fires for showings; review-link sentence stripped from day 1/2/3 emails");
}

if (!APPLY) { console.log("(dry run — not pushed)"); process.exit(0); }

const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${WF_ID}`, {
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
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 500)}`);
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
