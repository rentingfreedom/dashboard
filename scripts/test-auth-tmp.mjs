import { readFileSync, existsSync } from "fs";
const envPath = "./.env.local";
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
console.log("spreadsheet id present:", !!process.env.GOOGLE_SHEETS_SPREADSHEET_ID);
console.log("sa email present:", !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
console.log("private key present:", !!process.env.GOOGLE_PRIVATE_KEY, "len", (process.env.GOOGLE_PRIVATE_KEY||"").length);

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
console.log("libs loaded");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
console.log("auth object created, fetching sheet...");
const sheets = google.sheets({ version: "v4", auth });
const t0 = Date.now();
const res = await sheets.spreadsheets.values.get({
  spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
  range: "Properties!A1:A2",
});
console.log("got response in", Date.now()-t0, "ms, rows:", res.data.values?.length);
