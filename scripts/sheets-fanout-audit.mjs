import fs from "node:fs";
const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }),
);
const K = env.N8N_API_KEY;
const B = "https://automation.rentingfreedom.com/api/v1";
const WFS = {
  L13GUyrWbjSJwn8p: "Identity Gate",
  JDsKrVRHf9TEVj7j: "Inquiry flow",
  UbO0l29GtILMm1sP: "Sweep",
  ztUEx7Htu620SLbj: "Access Dispatch",
  "3hGnl6mPnu2AMbZ1": "Cal Cron Poll",
  "5LwTZS4dw5qmInL2": "Cal Immediate",
  gR6FWXMcc08ps8LT: "Booking Handler",
  R3rhuCYEGoBFArBa: "Identity Reminders",
};
for (const [id, label] of Object.entries(WFS)) {
  const full = await (await fetch(B + "/workflows/" + id, { headers: { "X-N8N-API-KEY": K } })).json();
  const sheetNodes = new Set(full.nodes.filter((n) => String(n.type).includes("googleSheets") && !String(n.type).includes("Trigger")).map((n) => n.name));
  const execOnce = Object.fromEntries(full.nodes.map((n) => [n.name, !!n.executeOnce]));
  const j = await (await fetch(`${B}/executions?workflowId=${id}&limit=12&includeData=true`, { headers: { "X-N8N-API-KEY": K } })).json();
  const worst = {};
  for (const e of j.data || []) {
    const rd = e.data?.resultData?.runData || {};
    for (const [name, runs] of Object.entries(rd)) {
      if (!sheetNodes.has(name)) continue;
      let inItems = 0, outItems = 0, ms = 0;
      for (const r of runs) { outItems += (r.data?.main?.[0] || []).length; ms += r.executionTime || 0; }
      const cur = worst[name];
      if (!cur || outItems > cur.out) worst[name] = { out: outItems, ms, exec: e.id, runs: runs.length };
    }
  }
  console.log(`\n=== ${label} (${id}) ===`);
  for (const [n, v] of Object.entries(worst).sort((a, b) => b[1].out - a[1].out)) {
    const flag = v.out > 200 ? "  <<< HEAVY" : "";
    console.log(`  ${String(v.out).padStart(5)} items  ${String(v.ms).padStart(6)}ms  runs=${v.runs}  executeOnce=${execOnce[n]}  ${n}${flag}`);
  }
}
