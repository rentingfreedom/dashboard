// Read-only: dump raw unit address fields for the multi-unit properties.
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

const H = { Authorization: `bearer ${process.env.DOORLOOP_API_KEY}`, Accept: "application/json" };
const base = "https://app.doorloop.com/api";

const props = (await (await fetch(`${base}/properties?page_size=1000`, { headers: H })).json()).data;
const units = (await (await fetch(`${base}/units?page_size=1000`, { headers: H })).json()).data;

const TARGETS = [/west end/i, /farrell/i, /tyler portfolio/i, /hayden.s portfolio/i];

for (const p of props) {
  if (!TARGETS.some((t) => t.test(p.name ?? ""))) continue;
  console.log(`\n=== PROPERTY: "${p.name}"  (id ${p.id})  numActiveUnits=${p.numActiveUnits}`);
  console.log(`    property.address.street1 = "${p.address?.street1 ?? ""}"  ${p.address?.city ?? ""} ${p.address?.state ?? ""} ${p.address?.zip ?? ""}`);
  for (const u of units.filter((u) => u.property === p.id)) {
    console.log(`    UNIT "${u.name}"  (id ${u.id})`);
    console.log(`         addressSameAsProperty = ${u.addressSameAsProperty}`);
    console.log(`         address.street1       = "${u.address?.street1 ?? ""}"`);
    console.log(`         address.city/state/zip= "${u.address?.city ?? ""}" / "${u.address?.state ?? ""}" / "${u.address?.zip ?? ""}"`);
  }
}
