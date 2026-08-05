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
const KEY = process.env.N8N_API_KEY;
const id = process.argv[2];
const r = await fetch(
  `https://automation.rentingfreedom.com/api/v1/executions?workflowId=${id}&limit=2&includeData=true`,
  { headers: { "X-N8N-API-KEY": KEY } }
);
const b = await r.json();
for (const ex of b.data ?? []) {
  console.log(`\nexecution ${ex.id}  status=${ex.status}  started=${ex.startedAt}`);
  const rd = ex.data?.resultData;
  if (rd?.error) console.log("  ERROR:", rd.error.node?.name, "-", rd.error.message);
  for (const [node, runs] of Object.entries(rd?.runData ?? {})) {
    for (const run of runs) {
      const items = run.data?.main?.[0] ?? [];
      let note = `items=${items.length}`;
      if (run.error) note += `  ERROR: ${run.error.message}`;
      console.log(`  ${node.padEnd(34)} ${note}`);
      for (const it of items.slice(0, 4)) {
        const j = it.json ?? {};
        const keys = ["skipped", "reason", "stage", "proceed", "send_now", "needs_gate", "link_sent", "stage_allowed", "message", "phone", "property_address"];
        const shown = keys.filter((k) => j[k] !== undefined).map((k) => `${k}=${JSON.stringify(String(j[k]).slice(0, 70))}`);
        if (shown.length) console.log(`      ${shown.join("  ")}`);
      }
    }
  }
}
