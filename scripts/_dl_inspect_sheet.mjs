// Read-only: dump Properties headers + rows for DoorLoop matching prep.
import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

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

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });
const res = await sheets.spreadsheets.values.get({
  spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
  range: "Properties",
});
const rows = res.data.values ?? [];
const headers = rows[0] ?? [];
console.log("HEADER COUNT:", headers.length);
headers.forEach((h, i) => console.log(`  [${i}] ${h}`));
const iAddr = headers.indexOf("street_address");
const iKey = headers.indexOf("property_key");
const iStatus = headers.indexOf("status");
const iActive = headers.indexOf("active");
const iDl = headers.indexOf("doorloop_property_id");
console.log(`\nindices: street_address=${iAddr} property_key=${iKey} status=${iStatus} active=${iActive} doorloop_property_id=${iDl}`);
console.log(`\nDATA ROWS: ${rows.length - 1}\n`);
rows.slice(1).forEach((r, n) => {
  console.log(
    `row ${n + 2} | ${(r[iAddr] ?? "").padEnd(34)} | key=${(r[iKey] ?? "").padEnd(28)} | status=${(r[iStatus] ?? "").padEnd(9)} | active=${(r[iActive] ?? "").padEnd(6)} | dl=${iDl >= 0 ? r[iDl] ?? "" : "N/A"}`
  );
});
