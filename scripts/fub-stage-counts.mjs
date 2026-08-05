import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}
const KEY = process.env.FUB_API_KEY;
async function fub(path) {
  const r = await fetch("https://api.followupboss.com/v1" + path, {
    headers: {
      Authorization: "Basic " + Buffer.from(KEY + ":").toString("base64"),
      "X-System": "RentingFreedom",
      "X-System-Key": "55e05a4d42e692a05db7be23f2178e04",
    },
  });
  const txt = await r.text();
  try { return { status: r.status, body: JSON.parse(txt) }; }
  catch { return { status: r.status, body: txt }; }
}
const st = await fub("/stages?limit=100");
const stages = (st.body.stages || []).map(s => s.name);
const rows = [];
for (const name of stages) {
  const r = await fub(`/people?stage=${encodeURIComponent(name)}&limit=1&includeTrash=false`);
  const total = r.body?._metadata?.total ?? "ERR";
  rows.push([total, name]);
  await new Promise(res => setTimeout(res, 250));
}
rows.sort((a,b) => (b[0]||0) - (a[0]||0));
console.log("count  stage");
for (const [c, n] of rows) console.log(String(c).padStart(5), " ", n);
