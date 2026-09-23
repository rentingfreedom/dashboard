#!/usr/bin/env node
/**
 * Proves outreach-suppression-verify.mjs is not vacuous.
 *
 *   node scripts/n8n-add-outreach-suppression.mjs --emit-js scripts/_tmp_sup_js
 *   node scripts/outreach-suppression-mutations.mjs scripts/_tmp_sup_js
 *
 * Each mutation breaks ONE property the stop button rests on, and the named
 * assertion must go red. Committed rather than recorded as prose, because
 * "confirmed non-vacuous by N mutations" does not re-run.
 *
 * M1 is the important one. If suppression ever reaches the access-code path, a
 * suppressed lead with a confirmed showing arrives at a door that will not
 * open — the exact failure this project started from.
 *
 * Read-only against n8n: it mutates a local --emit-js dump, never the estate.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(process.cwd(), process.argv[2] ?? "scripts/_tmp_sup_js");
const WORK = resolve(__dirname, "_tmp_sup_mut");

const LIVE_NODES = [
  ["L13GUyrWbjSJwn8p", "Check Guards"],
  ["R3rhuCYEGoBFArBa", "Find Due Reminders"],
  ["UbO0l29GtILMm1sP", "Check & Build Message"],
  ["JDsKrVRHf9TEVj7j", "Resolve Inquiry"],
  ["5UvuzQwLjCB4D25A", "Find Due Nudges"],
  ["3hGnl6mPnu2AMbZ1", "Find Due Notifications"],
];

// Once the patch is APPLIED, `--emit-js` is a no-op (the builder is idempotent
// and emits nothing), so a mutation suite depending on a leftover dump would
// quietly stop being runnable. Fall back to the LIVE deployed code, which is
// what we actually want to mutate anyway.
const fetchLive = async (dir) => {
  const envPath = resolve(__dirname, "../.env.local");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  const KEY = process.env.N8N_API_KEY;
  mkdirSync(dir, { recursive: true });
  const cache = new Map();
  for (const [wf, node] of LIVE_NODES) {
    if (!cache.has(wf)) {
      const r = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${wf}`, { headers: { "X-N8N-API-KEY": KEY } });
      if (!r.ok) throw new Error(`GET ${wf} -> ${r.status}`);
      cache.set(wf, await r.json());
    }
    const js = String(cache.get(wf).nodes.find((n) => n.name === node)?.parameters?.jsCode ?? "");
    if (!js) throw new Error(`no jsCode for ${wf} ${node}`);
    writeFileSync(resolve(dir, `${wf}__${node.replace(/[^\w]+/g, "-")}.js`), js);
  }
  console.log(`  (using LIVE deployed code, cached in ${dir})`);
};

if (!existsSync(SRC) || readdirSync(SRC).length === 0) {
  await fetchLive(SRC);
}

const F = {
  guards: "L13GUyrWbjSJwn8p__Check-Guards.js",
  reminders: "R3rhuCYEGoBFArBa__Find-Due-Reminders.js",
  sweep: "UbO0l29GtILMm1sP__Check-Build-Message.js",
  inquiry: "JDsKrVRHf9TEVj7j__Resolve-Inquiry.js",
  nudges: "5UvuzQwLjCB4D25A__Find-Due-Nudges.js",
  cron: "3hGnl6mPnu2AMbZ1__Find-Due-Notifications.js",
};
// Not produced by --emit-js: the verifier falls back to the LIVE node for any
// file absent from the dir, so writing one here is how a forbidden node gets
// mutated without touching the estate.
const ACCESS_CODE = "ztUEx7Htu620SLbj__Build-SMS-Cron-.js";

const MUTATIONS = [
  {
    id: "M1",
    what: "the ACCESS CODE path acquires the suppression check",
    why: "A suppressed lead with a confirmed showing must still get in. Suppressing a door code strands a customer at a locked door.",
    expect: "Build SMS (Cron) (the access code, cron path) has NO suppression check",
    write: [[ACCESS_CODE, "// OUTREACH_SUPPRESSION_MARKER\nconst x = isSuppressed('all', {});\n"]],
  },
  {
    id: "M2",
    what: "the Cron Poll suppresses STAFF steps as well as invitee ones",
    why: "host_sms_1h goes to Justin and nicole_2h to Nicole. They still need to know the appointment exists.",
    expect: "cron: NO staff step is suppressed",
    file: F.cron,
    edit: (s) => s.replace("if ((rule.recipient ?? 'invitee') === 'invitee') {", "if (true) {"),
  },
  {
    id: "M3",
    what: "the sentinel is dropped from the alreadySent allowlist",
    why: "That allowlist is explicit. A sentinel missing from it is INERT, and these end-anchored follow-ups re-queue every 5 minutes forever.",
    expect: "skipped_outreach_suppressed is in the alreadySent allowlist",
    file: F.cron,
    edit: (s) => s.replace(" || sentColValue === 'skipped_outreach_suppressed'", ""),
  },
  {
    id: "M4",
    what: "an unparseable expires_at reads as EXPIRED",
    why: "\"We cannot tell when this ends\" must never resolve to \"resume messaging them\".",
    expect: "UNPARSEABLE expires_at = permanent",
    file: F.guards,
    edit: (s) => s.replace("  if (!Number.isFinite(ms)) return true;", "  if (!Number.isFinite(ms)) return false;"),
  },
  {
    id: "M5",
    what: "an unrecognised scope suppresses everything",
    why: "A typo must not silently mute a lead nobody meant to mute.",
    expect: "an UNRECOGNISED scope suppresses nothing",
    file: F.guards,
    edit: (s) => s.replace('    if (s !== "all" && s !== scope) return false;', '    if (s === "cal_link" && scope !== "cal_link") return false;'),
  },
  {
    id: "M6",
    what: "the sweep fails OPEN on an unreadable tab",
    why: "\"Cannot prove they are not suppressed\" must not resolve to \"message them\".",
    expect: "sweep: unreadable tab fails CLOSED",
    file: F.sweep,
    edit: (s) => s.replace('if (supUnreadable) return bail("outreach_suppression_unreadable");', ""),
  },
  {
    id: "M7",
    what: "scope is ignored — any row suppresses any sequence",
    why: "Stopping booking nudges must not also stop the booking link.",
    expect: "a DIFFERENT scope does not",
    file: F.nudges,
    edit: (s) => s.replace('    if (s !== "all" && s !== scope) return false;', "    if (false) return false;"),
  },
  {
    id: "M8",
    what: "the identity join narrows to person_id only",
    why: "A FUB merge changes person_id, and Cal Bookings rows predating CAL_BOOKINGS_PERSON_ID_MARKER carry none at all.",
    expect: "matches on phone last-10 with no person_id",
    file: F.reminders,
    edit: (s) => s.replace(
      "    const hit = (rid !== \"\" && pid !== \"\" && rid === pid)\n      || (ph !== \"\" && supLast10(r.phone) === ph)\n      || (em !== \"\" && String(r.email ?? \"\").trim().toLowerCase() === em);",
      "    const hit = (rid !== \"\" && pid !== \"\" && rid === pid);"),
  },
  {
    id: "M9",
    what: "the inquiry flow's immediate send ignores suppression",
    why: "This is the non-idempotent path — the link goes out once, right now.",
    expect: "inquiry: suppressed lead does NOT send now",
    file: F.inquiry,
    edit: (s) => s.replace(
      "const send_now = testGateOpen && stageAllowed && deliverable && treatAsVerified && !outreachSuppressed && !supUnreadable;",
      "const send_now = testGateOpen && stageAllowed && deliverable && treatAsVerified;"),
  },
  {
    id: "M10",
    what: "the Identity Gate stops checking suppression",
    why: "A stopped lead must not be asked to verify their ID.",
    expect: "Check Guards: suppressed lead does NOT proceed",
    file: F.guards,
    edit: (s) => s.replace('if (isSuppressed("identity", { person_id: person.id, phone: phone, email: person.emails?.[0]?.value })) {\n  return fail("outreach_suppressed");\n}', ""),
  },
  {
    id: "M11",
    what: "a suppressed inquiry row is dropped instead of recorded",
    why: "House convention: blocked leads are RECORDED, not dropped, so lifting a suppression never fires a silent backlog and a human can see why it went quiet.",
    expect: "inquiry: the row is still RECORDED with a stamp",
    file: F.inquiry,
    edit: (s) => s.replace('else if (outreachSuppressed) link_sent_value = "skipped_outreach_suppressed";', ""),
  },
];

let red = 0, green = 0;
console.log("═".repeat(74));
console.log("OUTREACH SUPPRESSION — MUTATIONS   (each must turn its named assertion RED)");
console.log("═".repeat(74));

for (const m of MUTATIONS) {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  for (const f of readdirSync(SRC)) writeFileSync(resolve(WORK, f), readFileSync(resolve(SRC, f), "utf8"));

  if (m.write) {
    for (const [name, body] of m.write) writeFileSync(resolve(WORK, name), body);
  } else {
    const p = resolve(WORK, m.file);
    const before = readFileSync(p, "utf8");
    const after = m.edit(before);
    if (after === before) {
      console.log(`\n${m.id}  ✗ MUTATION DID NOT APPLY — its anchor text has moved in ${m.file}`);
      red++;
      continue;
    }
    writeFileSync(p, after);
  }

  let out = "";
  try {
    out = execFileSync(process.execPath, [resolve(__dirname, "outreach-suppression-verify.mjs"), "--js", WORK],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    console.log(`\n${m.id}  ✗ VERIFIER STAYED GREEN — ${m.what}`);
    console.log(`      the assertion "${m.expect}" is VACUOUS`);
    red++;
    continue;
  } catch (e) {
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  const hit = out.split("\n").some((l) => l.includes("FAIL") && l.includes(m.expect));
  if (hit) {
    green++;
    console.log(`\n${m.id}  ✓ ${m.what}`);
    console.log(`      red: "${m.expect}"`);
  } else {
    red++;
    console.log(`\n${m.id}  ✗ the verifier failed, but NOT on "${m.expect}"`);
    console.log(out.split("\n").filter((l) => l.includes("FAIL")).slice(0, 6).map((l) => "      " + l.trim()).join("\n"));
  }
}

rmSync(WORK, { recursive: true, force: true });
console.log("\n" + "═".repeat(74));
if (red) { console.log(`✗ ${red} mutation(s) did not prove their assertion — ${green} did`); process.exit(1); }
console.log(`ALL ${green} MUTATIONS PROVED THEIR ASSERTION`);
console.log("═".repeat(74));
