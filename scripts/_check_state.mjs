import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
const require = createRequire(import.meta.url);
const envPath = "/sessions/great-dazzling-ritchie/mnt/RentingFreedom/.env.local";
const lines = readFileSync(envPath, "utf8").split("\n");
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
  if (!process.env[key]) process.env[key] = val;
}
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
const auth = new GoogleAuth({ credentials: { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: privateKey }, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets = google.sheets({ version: "v4", auth });
const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID });
console.log("tabs:", meta.data.sheets.map(s=>s.properties.title).join(", "));
const settingsRes = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID, range: "Settings" });
const rows = settingsRes.data.values ?? [];
console.log("settings row count:", rows.length);
console.log("last 5 keys:", rows.slice(-5).map(r=>r[0]));
