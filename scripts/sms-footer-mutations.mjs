#!/usr/bin/env node
/**
 * Proves sms-footer-verify.mjs is not vacuous.
 *
 *   node scripts/n8n-add-sms-footer.mjs --emit-js scripts/_tmp_footer_js
 *   node scripts/sms-footer-mutations.mjs scripts/_tmp_footer_js
 *
 * Each mutation breaks ONE property the footer rests on, and the named
 * assertion must go red. Committed rather than recorded as prose, because
 * "confirmed non-vacuous by N mutations" does not re-run — and two verifiers in
 * this estate were later found to be testing nothing.
 *
 * Read-only against n8n: it mutates a local --emit-js dump, never the estate.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(process.cwd(), process.argv[2] ?? "scripts/_tmp_footer_js");
const WORK = resolve(__dirname, "_tmp_footer_mut");

const LIVE_NODES = [
  ["L13GUyrWbjSJwn8p", "Build Verification SMS"],
  ["PHSdCWhovdbFDHlX", "Build Failed SMS"],
  ["R3rhuCYEGoBFArBa", "Build Reminder SMS"],
  ["5UvuzQwLjCB4D25A", "Build Nudge"],
  ["ztUEx7Htu620SLbj", "Build SMS (Cron)"],
  ["gR6FWXMcc08ps8LT", "Build SMS (Created)"],
  ["gR6FWXMcc08ps8LT", "Build Cancel SMS"],
  ["UbO0l29GtILMm1sP", "Check & Build Message"],
  ["UbO0l29GtILMm1sP", "Build Cal Link Email"],
  ["3hGnl6mPnu2AMbZ1", "Build Message"],
  ["JDsKrVRHf9TEVj7j", "Resolve Inquiry"],
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
  cron: "3hGnl6mPnu2AMbZ1__Build-Message.js",
  email: "UbO0l29GtILMm1sP__Build-Cal-Link-Email.js",
  sweep: "UbO0l29GtILMm1sP__Check-Build-Message.js",
  verify: "L13GUyrWbjSJwn8p__Build-Verification-SMS.js",
  nudge: "5UvuzQwLjCB4D25A__Build-Nudge.js",
};

const MUTATIONS = [
  {
    id: "M1",
    what: "Cron Poll footers every SMS, not just invitee ones",
    why: "host_sms_1h goes to Justin's own phone. This is the mutation that guards the two-clause condition.",
    expect: "host_sms_1h has NO footer",
    file: F.cron,
    edit: (s) => s.replace(
      "const footeredMessage = (d.channel === 'sms' && String(d.recipient ?? 'invitee') === 'invitee')",
      "const footeredMessage = (d.channel === 'sms')"),
  },
  {
    id: "M2",
    what: "Cron Poll footers email as well as SMS",
    why: "An email has no number to reply to.",
    expect: "invitee EMAIL has NO footer",
    file: F.cron,
    edit: (s) => s.replace(
      "const footeredMessage = (d.channel === 'sms' && String(d.recipient ?? 'invitee') === 'invitee')",
      "const footeredMessage = (true)"),
  },
  {
    id: "M3",
    what: "the cal-link email reads `message` instead of `email_body`",
    why: "THE hazard this feature had to design around: the email body IS the SMS text (CAL_LINK_EMAIL_COPY_MARKER), so reading the footered copy emails 'do not reply to this number' to a reader with no number. NOTE: on ordinary input this mutation stays GREEN, because the suffix strip catches it — which is why the verifier needs a case where the strip cannot help.",
    expect: "email_body wins even when the strip cannot help",
    file: F.email,
    edit: (s) => s.replace("String(d.email_body ?? d.message ?? \"\")", "String(d.message ?? \"\")"),
  },
  {
    id: "M4",
    what: "the email's backstop strip is removed",
    why: "A half-applied patch must still not email the footer. Doubt resolves to no footer.",
    expect: "backstop strips a trailing footer off `message`",
    file: F.email,
    edit: (s) => s.replace(
      "  const smsText = (emailFooter && emailRaw.endsWith(emailFooter)\n    ? emailRaw.slice(0, -emailFooter.length)\n    : emailRaw).trim();",
      "  const smsText = emailRaw.trim();"),
  },
  {
    id: "M5",
    what: "the sweep stops emitting a footer-free email_body",
    why: "Without it the email node has nothing footer-free to prefer.",
    expect: "email_body is emitted",
    file: F.sweep,
    edit: (s) => s.replace("    email_body: message,\n", ""),
  },
  {
    id: "M6",
    what: "withFooter appends to an EMPTY body",
    why: "On a failed render the footer would be the entire message the lead receives.",
    expect: "empty body stays empty (never footer-only)",
    file: F.verify,
    edit: (s) => s.replace("if (!smsFooter || !b || b.includes(smsFooter)) return b;", "if (!smsFooter) return b;"),
  },
  {
    id: "M7",
    what: "withFooter ignores an emptied Settings key",
    why: "The key is the feature's only off switch.",
    expect: "EMPTY key = footer off",
    file: F.verify,
    edit: (s) => s.replace(
      "if (!smsFooter || !b || b.includes(smsFooter)) return b;\n  return b + \"\\n\\n\" + smsFooter;",
      "if (!b) return b;\n  return b + \"\\n\\n\" + (smsFooter || \"Please do not reply to this number - this mailbox is not monitored.\");"),
  },
  {
    id: "M8",
    what: "one node's helper drifts from the other nine",
    why: "Ten copies of one function is the price of Code nodes being unable to import; identical is what stops that becoming ten behaviours.",
    expect: "withFooter is ONE implementation across all ten nodes",
    file: F.nudge,
    edit: (s) => s.replace('return b + "\\n\\n" + smsFooter;', 'return b + " " + smsFooter;'),
  },
  {
    id: "M9",
    what: "the nudge stops footering its SMS",
    why: "A lead-facing send silently losing the footer is the quiet failure mode here.",
    expect: "Build Nudge emits a footered message",
    file: F.nudge,
    edit: (s) => s.replace("  message: withFooter(message),", "  message: message,"),
  },
  {
    id: "M10",
    what: "the nudge footers its EMAIL body too",
    why: "The nudge build node feeds both channels from one node.",
    expect: "Build Nudge leaves the email `body` un-footered",
    file: F.nudge,
    edit: (s) => s.replace("\n  body: body,", "\n  body: withFooter(body),"),
  },
];

let red = 0, green = 0;
console.log("═".repeat(74));
console.log("SMS FOOTER — MUTATIONS   (each must turn its named assertion RED)");
console.log("═".repeat(74));

for (const m of MUTATIONS) {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  for (const f of readdirSync(SRC)) writeFileSync(resolve(WORK, f), readFileSync(resolve(SRC, f), "utf8"));

  const p = resolve(WORK, m.file);
  const before = readFileSync(p, "utf8");
  const after = m.edit(before);
  if (after === before) {
    console.log(`\n${m.id}  ✗ MUTATION DID NOT APPLY — its anchor text has moved in ${m.file}`);
    red++;
    continue;
  }
  writeFileSync(p, after);

  let out = "";
  try {
    out = execFileSync(process.execPath, [resolve(__dirname, "sms-footer-verify.mjs"), "--js", WORK],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    // exit 0 = the verifier saw nothing wrong
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
