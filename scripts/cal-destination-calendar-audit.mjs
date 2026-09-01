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
    if (!process.env[k]) process.env[k] = v;
  }
}
const KEY = process.env.CAL_COM_CLAUDE_API;
const H = { Authorization: `Bearer ${KEY}` };

const etRes = await fetch("https://api.cal.com/v2/event-types?username=rentingfreedom", {
  headers: { ...H, "cal-api-version": "2024-06-14" },
});
const etJson = await etRes.json();
const groups = etJson.data ?? [];
const ets = Array.isArray(groups) && groups[0]?.eventTypes ? groups.flatMap((g) => g.eventTypes) : groups;
const destOf = new Map(ets.map((et) => [et.id, et.destinationCalendar?.externalId ?? "contact@rentingfreedom.com"]));

const CRED = {
  "emilye@rentingfreedom.com": 2480786,
  "nicolee@rentingfreedom.com": 2476280,
  "contact@rentingfreedom.com": 2476280,
};

const bRes = await fetch("https://api.cal.com/v2/bookings?take=100&sortStart=desc", {
  headers: { ...H, "cal-api-version": "2024-08-13" },
});
const bookings = (await bRes.json()).data ?? [];
const accepted = bookings.filter((b) => b.status === "accepted");

const cache = new Map();
async function busy(cal, day) {
  const k = `${cal}|${day}`;
  if (cache.has(k)) return cache.get(k);
  const next = new Date(day + "T00:00:00Z");
  next.setUTCDate(next.getUTCDate() + 2);
  const prev = new Date(day + "T00:00:00Z");
  prev.setUTCDate(prev.getUTCDate() - 1);
  const qs = new URLSearchParams({
    loggedInUsersTz: "UTC",
    dateFrom: prev.toISOString().slice(0, 10),
    dateTo: next.toISOString().slice(0, 10),
  });
  qs.append("calendarsToLoad[0][credentialId]", String(CRED[cal]));
  qs.append("calendarsToLoad[0][externalId]", cal);
  const r = await fetch(`https://api.cal.com/v2/calendars/busy-times?${qs}`, { headers: H });
  const out = (await r.json().catch(() => null))?.data ?? [];
  cache.set(k, out);
  return out;
}

console.log("EXACT = a busy block with identical start AND end (i.e. the Cal.com-created event)\n");
let exact = 0, none = 0;
for (const b of accepted) {
  const cal = destOf.get(b.eventTypeId) ?? "?";
  if (!CRED[cal]) continue;
  const blocks = await busy(cal, b.start.slice(0, 10));
  const s = new Date(b.start).getTime(), e = new Date(b.end).getTime();
  const isExact = blocks.some((x) => new Date(x.start).getTime() === s && new Date(x.end).getTime() === e);
  const overlapping = blocks.filter((x) => new Date(x.start).getTime() < e && new Date(x.end).getTime() > s);
  if (isExact) exact++; else none++;
  console.log(
    `${b.start.slice(0, 16)} ${b.end.slice(11, 16)} ${cal.split("@")[0].padEnd(8)} ${(isExact ? "EXACT" : "-----").padEnd(6)} blocksReturned=${String(blocks.length).padEnd(3)} overlap=${JSON.stringify(overlapping.map((o) => o.start.slice(11, 16) + "-" + o.end.slice(11, 16)))} "${(b.title || "").slice(0, 30)}"`
  );
}
console.log(`\nexact=${exact} missing=${none}`);
