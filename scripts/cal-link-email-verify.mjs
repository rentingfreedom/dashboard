#!/usr/bin/env node
/**
 * Offline verification of the cal-link email addition to the catch-up sweep.
 *
 *   node scripts/cal-link-email-verify.mjs
 *
 * Pulls the LIVE jsCode for `Check & Build Message` and `Build Cal Link Email`
 * out of the deployed workflow and executes it against synthetic input, then
 * cross-checks the connections graph and the Gmail node's isolation config.
 * Sends nothing, writes nothing, touches no n8n state.
 *
 * The graph assertions matter as much as the code ones: the whole safety story
 * for this change is "parallel branch, nothing inserted in front of anything"
 * (gotcha 19). A future edit that re-wires Send SMS through the email branch
 * would still pass every behavioural test while breaking the SMS path.
 */

import { readFileSync, existsSync } from "fs";
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
    process.env[k] = v;
  }
}

const KEY = process.env.N8N_API_KEY;
const WF_ID = "UbO0l29GtILMm1sP";

let pass = 0;
const failures = [];
const ok = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`    PASS  ${label}`);
  } else {
    failures.push(`${label}: ${a} (expected ${e})`);
    console.log(`    FAIL  ${label}: ${a}   (expected ${e})`);
  }
};
const okTrue = (label, v) => ok(label, !!v, true);

const w = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${WF_ID}`, {
  headers: { "X-N8N-API-KEY": KEY },
}).then((r) => r.json());

console.log("═".repeat(74));
console.log(`CAL LINK EMAIL — VERIFY   (${w.name}, active=${w.active})`);
console.log("═".repeat(74));

// ── 1. Build Cal Link Email, against synthetic sweep output ────────────────
console.log("\n1. Build Cal Link Email · behaviour");
const buildNode = w.nodes.find((n) => n.name === "Build Cal Link Email");
if (!buildNode) {
  console.log("    FAIL  node not found");
  failures.push("Build Cal Link Email missing");
} else {
  const run = (items) => {
    const fn = new Function(
      "$input",
      "console",
      buildNode.parameters.jsCode.replace(/\bexport\b/g, "")
    );
    return fn({ all: () => items.map((json) => ({ json })) }, { log: () => {} });
  };

  const two = run([
    {
      person_id: "2700", person_name: "Jane Q Smith", email: "jane@example.com",
      property_address: "130 Sandtrap Rd", enrichedCalLink: "https://cal.com/rf/a?x=1",
      event_id: "e1", apply_link: "https://apply.example.com",
    },
    {
      person_id: "2700", person_name: "Jane Q Smith", email: "jane@example.com",
      property_address: "102 Braeford", enrichedCalLink: "https://cal.com/rf/b?x=2",
      event_id: "e2",
    },
  ]);
  ok("two properties -> two emails", two.length, 2);
  ok("email 1 targets its OWN property", two[0].json.property_address, "130 Sandtrap Rd");
  ok("email 2 targets its OWN property", two[1].json.property_address, "102 Braeford");
  ok("email 1 carries its OWN link", two[0].json.cal_link, "https://cal.com/rf/a?x=1");
  ok("email 2 carries its OWN link", two[1].json.cal_link, "https://cal.com/rf/b?x=2");
  okTrue("distinct links (gotcha 11 regression)", two[0].json.cal_link !== two[1].json.cal_link);
  ok("recipient", two[0].json.to, "jane@example.com");
  ok("first name only in greeting", two[0].json.message.split("\n")[0], "Hi Jane,");
  okTrue("apply link included when present", two[0].json.message.includes("https://apply.example.com"));
  okTrue("apply link omitted when absent", !two[1].json.message.includes("Ready to apply"));

  const none = run([{ person_id: "2701", person_name: "No Email", email: "", property_address: "x", enrichedCalLink: "y" }]);
  ok("no address -> no email item (never empty `to`)", none.length, 0);

  const relay = run([{
    person_id: "2702", person_name: "Zillow Lead", email: "abc123@convo.zillow.com",
    property_address: "5464 Crown Ave", enrichedCalLink: "https://cal.com/rf/c",
  }]);
  ok("zillow relay address IS emailed (client decision)", relay.length, 1);
  ok("relay recipient preserved", relay[0].json.to, "abc123@convo.zillow.com");

  const missingName = run([{ person_id: "2703", email: "x@y.com", property_address: "z", enrichedCalLink: "l" }]);
  ok("missing name degrades to 'there'", missingName[0].json.message.split("\n")[0], "Hi there,");

  const fallbackLink = run([{ person_id: "2704", person_name: "A B", email: "x@y.com", property_address: "z", cal_link: "https://raw.link" }]);
  ok("falls back to cal_link when enrichedCalLink absent", fallbackLink[0].json.cal_link, "https://raw.link");
}

// ── 2. Check & Build Message emits `email` ─────────────────────────────────
console.log("\n2. Check & Build Message · emits email");
const cb = w.nodes.find((n) => n.name === "Check & Build Message");
okTrue("CAL_LINK_EMAIL_MARKER present", cb.parameters.jsCode.includes("CAL_LINK_EMAIL_MARKER"));
okTrue("reads person.emails[0].value", /const email = person\.emails\?\.\[0\]\?\.value/.test(cb.parameters.jsCode));
okTrue("`email` is in the emitted object", /^\s*email,/m.test(cb.parameters.jsCode));
okTrue("phone gate still first (no phone -> bail)", cb.parameters.jsCode.includes('if (!phone) return bail("no_phone")'));

// ── 3. Wiring — the gotcha-19 assertions ───────────────────────────────────
console.log("\n3. Wiring · parallel branch, nothing inserted in front");
const C = w.connections;
const feeds = (target) =>
  Object.entries(C)
    .filter(([, o]) => (o.main ?? []).flat().some((c) => c && c.node === target))
    .map(([s]) => s);
const outs = (src) => ((C[src]?.main ?? [])[0] ?? []).map((c) => c.node).sort();

ok("Confirm Still Unsent fans out to all three", outs("Confirm Still Unsent"),
   ["Build Cal Link Email", "FUB - Add Tag", "Send SMS"].sort());
ok("Send SMS is still fed ONLY by Confirm Still Unsent", feeds("Send SMS"), ["Confirm Still Unsent"]);
ok("Build Cal Link Email fed ONLY by Confirm Still Unsent", feeds("Build Cal Link Email"), ["Confirm Still Unsent"]);
ok("Send Cal Link Email fed ONLY by Build Cal Link Email", feeds("Send Cal Link Email"), ["Build Cal Link Email"]);
ok("email branch is terminal (feeds nothing)", outs("Send Cal Link Email"), []);
ok("Check & Build Message still feeds Should Send?", outs("Check & Build Message"), ["Should Send?"]);

// ── 4. Isolation config ────────────────────────────────────────────────────
console.log("\n4. Isolation · a Gmail failure must not cost the lead their SMS");
const gm = w.nodes.find((n) => n.name === "Send Cal Link Email");
ok("Send Cal Link Email onError", gm?.onError, "continueRegularOutput");
ok("gmail credential", gm?.credentials?.gmailOAuth2?.name, "Gmail account");
ok("sendTo reads its immediate input", gm?.parameters?.sendTo, "={{ $json.to }}");
const sms = w.nodes.find((n) => n.name === "Send SMS");
okTrue("Send SMS still uses .item not .first() (gotcha 11)",
  String(sms?.parameters?.to).includes("$('Confirm Still Unsent').item"));

console.log("\n" + "═".repeat(74));
if (failures.length) {
  console.log(`✗ ${failures.length} FAILURE(S) — ${pass} passed`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`ALL PASS — ${pass} assertions`);
console.log("═".repeat(74));
