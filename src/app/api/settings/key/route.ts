import { NextResponse } from "next/server";
import { requireRole, getAuthedUser } from "@/lib/auth/roles";
import {
  isWritableKey,
  readSettingRow,
  readsAsEnabled,
  writeSettingValue,
  WRITABLE_KEYS,
} from "@/lib/google/settings-repository";
import { planRelease } from "@/lib/verification/release-stranded";
import { writeAuditLog } from "@/lib/google/audit-repository";

/**
 * Read and write a single Settings key.
 *
 * The first write path this app has ever had into the Settings tab. It is kept
 * generic in shape — it is the obvious home for the other nine `*_enabled` keys
 * later — but only keys on `WRITABLE_KEYS` are accepted, because Settings also
 * holds kill switches on paths that send SMS and door codes.
 *
 * NOT a server-to-server route: it is called by an admin's browser, so it must
 * NOT be added to `SERVER_TO_SERVER_PATHS` in `src/proxy.ts`. n8n has no business
 * writing its own configuration.
 */

// The POST re-reads three tabs to build the release plan. Sheets retries under
// quota pressure are the ceiling, matching the DoorLoop routes.
export const maxDuration = 60;

export async function GET(request: Request) {
  // Reading the switch position is not an admin action: the funnel page shows it
  // to everyone, because it changes what the numbers on that page mean.
  const user = await getAuthedUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to read settings." }, { status: 401 });
  }

  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!isWritableKey(key)) {
    return NextResponse.json(
      { error: `Unknown or non-readable setting "${key}".` },
      { status: 400 }
    );
  }

  try {
    const row = await readSettingRow(key);
    return NextResponse.json({
      key,
      value: row?.value ?? null,
      enabled: readsAsEnabled(row?.value),
      exists: row !== null,
    });
  } catch (err) {
    console.error("[GET /api/settings/key]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read setting" },
      { status: 500 }
    );
  }
}

/**
 * POST { key, value } — write one key.
 *
 * ── Turning ID verification OFF does NOT send anything from here ──────────
 * Flipping it off strands everyone mid-verification: their Inquiries row sits at
 * `link_sent = false` waiting on a Result Handler replay that will never come.
 * Releasing them is required, and the response carries the plan for doing it —
 * but the sends happen through `/api/verification/release`, in paced chunks.
 *
 * That split is not squeamishness. Measured on live data, a release today is 29
 * leads, and the sweep costs ~4.6 Sheets requests per lead against a 60/minute
 * bucket; pacing it safely takes about four minutes, which no single request can
 * hold. Doing it here would either exhaust the quota — the failure that has cost
 * this system real leads — or be killed mid-way by the platform, with no record
 * of who had already been messaged.
 *
 * The setting is written FIRST and independently. If the release then fails, the
 * switch is still correctly off and the release can simply be re-run; the reverse
 * order would message people about a policy that had not taken effect.
 */
export async function POST(request: Request) {
  const auth = await requireRole(["admin"]);
  if (!auth.ok) return auth.response;

  try {
    const body = (await request.json()) as { key?: string; value?: string };
    const key = String(body.key ?? "");
    const value = String(body.value ?? "");

    if (!isWritableKey(key)) {
      return NextResponse.json(
        { error: `"${key}" is not writable. Writable keys: ${WRITABLE_KEYS.join(", ")}.` },
        { status: 400 }
      );
    }

    // Boolean keys accept only the two spellings the sheet already uses. Anything
    // else — "0", "off", "" — reads as ENABLED through the inverted default and
    // would leave an operator who typed it believing the opposite of what is true.
    const upper = value.trim().toUpperCase();
    if (upper !== "TRUE" && upper !== "FALSE") {
      return NextResponse.json(
        { error: `Value must be "TRUE" or "FALSE", got ${JSON.stringify(value)}.` },
        { status: 400 }
      );
    }

    const { previous } = await writeSettingValue(key, upper);

    await writeAuditLog({
      timestamp: new Date().toISOString(),
      actor: auth.user.actorLabel,
      action: "settings.key_updated",
      entity_type: "setting",
      entity_id: key,
      property_key: "",
      before_json: JSON.stringify({ value: previous }),
      after_json: JSON.stringify({ value: upper }),
      source: "dashboard",
      notes:
        key === "identity_verification_enabled"
          ? upper === "FALSE"
            ? "ID verification switched OFF — leads now receive cal links without Stripe Identity."
            : "ID verification switched ON — new leads must verify before receiving a cal link."
          : "",
    });

    // Only a flip to OFF strands anyone. Turning it back ON deliberately leaves
    // existing link-holders alone: they were served in good faith, cal.com links
    // are public URLs, and adding a dispatch-time verification check is Proposal
    // Three, which is not approved.
    const turningOff = key === "identity_verification_enabled" && upper === "FALSE";
    const wasOn = readsAsEnabled(previous);

    let release = null;
    if (turningOff && wasOn) {
      try {
        release = await planRelease();
      } catch (err) {
        // The switch is already written and correct. A plan we could not build is
        // a thing to report, not a reason to pretend the flip failed.
        console.error("[POST /api/settings/key] release plan failed", err);
        release = { error: err instanceof Error ? err.message : "Could not build the release plan." };
      }
    }

    return NextResponse.json({
      key,
      value: upper,
      enabled: readsAsEnabled(upper),
      previous,
      changed: previous.trim().toUpperCase() !== upper,
      release,
    });
  } catch (err) {
    console.error("[POST /api/settings/key]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to write setting" },
      { status: 500 }
    );
  }
}
