import { google } from "googleapis";

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID!;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAuth(): any {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !rawKey) {
    throw new Error(
      "Missing Google credentials. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY."
    );
  }

  const privateKey = rawKey.replace(/\\n/g, "\n");

  return new google.auth.GoogleAuth({
    credentials: {
      client_email: email,
      private_key: privateKey,
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

export function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: "v4", auth });
}

export function getSpreadsheetId(): string {
  if (!SPREADSHEET_ID) {
    throw new Error("Missing GOOGLE_SHEETS_SPREADSHEET_ID environment variable.");
  }
  return SPREADSHEET_ID;
}

/** Read all rows from a named tab, returning [headers, ...rows] */
export async function readSheet(tabName: string): Promise<string[][]> {
  const sheets = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tabName,
  });

  return (res.data.values as string[][]) ?? [];
}

/**
 * Append a single row and return the 1-based row index where it landed.
 * Only pass values for columns you own — do NOT pass empty strings for
 * formula/computed columns, as that will overwrite spill formulas.
 */
export async function appendRow(tabName: string, row: string[]): Promise<number> {
  const sheets = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });

  // Parse the returned range to get the row number, e.g. "Properties!A65" → 65
  const updatedRange = res.data.updates?.updatedRange ?? "";
  const match = updatedRange.match(/(\d+)$/);
  return match ? parseInt(match[1]) : -1;
}

/** Convert a 1-based column number to A1 letter notation (1→A, 27→AA, etc.) */
function columnToLetter(col: number): string {
  let result = "";
  while (col > 0) {
    const rem = (col - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    col = Math.floor((col - 1) / 26);
  }
  return result;
}

/**
 * Write ONLY the specified columns in a single row, leaving all other cells
 * (including formula/computed columns) completely untouched.
 *
 * @param tabName  Sheet tab name
 * @param rowIndex 1-based row index
 * @param updates  Map of column header name → new value
 * @param headers  Ordered list of all column headers (used to find column positions)
 */
export async function updateSpecificColumns(
  tabName: string,
  rowIndex: number,
  updates: Record<string, string>,
  headers: string[]
): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  const data: { range: string; values: string[][] }[] = [];

  for (const [column, value] of Object.entries(updates)) {
    const colIdx = headers.indexOf(column);
    if (colIdx === -1) continue; // column not present — skip silently
    data.push({
      range: `${tabName}!${columnToLetter(colIdx + 1)}${rowIndex}`,
      values: [[value]],
    });
  }

  if (data.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data,
    },
  });
}

/** List all sheet/tab names in the spreadsheet */
export async function listSheetNames(): Promise<string[]> {
  const sheets = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  const res = await sheets.spreadsheets.get({ spreadsheetId });
  return (
    res.data.sheets?.map((s) => s.properties?.title ?? "").filter(Boolean) ?? []
  );
}

/** Ensure a tab exists; create it if missing */
export async function ensureSheetExists(tabName: string): Promise<void> {
  const existing = await listSheetNames();
  if (existing.includes(tabName)) return;

  const sheets = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: tabName } } }],
    },
  });
}

/**
 * Convert a raw rows array + header row into typed objects.
 * Unknown columns are preserved under their original key.
 */
export function rowsToObjects(
  rows: string[][]
): { headers: string[]; objects: Record<string, string>[] } {
  if (rows.length === 0) return { headers: [], objects: [] };
  const [headerRow, ...dataRows] = rows;
  const headers = headerRow.map((h) => h.trim());

  const objects = dataRows.map((row, dataIdx) => {
    const obj: Record<string, string> = { _rowIndex: String(dataIdx + 2) };
    headers.forEach((header, i) => {
      obj[header] = row[i] ?? "";
    });
    return obj;
  });

  return { headers, objects };
}
