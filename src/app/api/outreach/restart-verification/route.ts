import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/roles";
import { restartIdVerification } from "@/lib/google/outreach-repository";

/** The n8n workflow does a FUB lookup, four sheet reads, Stripe and Twilio before it answers. */
export const maxDuration = 60;

const schema = z.object({
  personId: z.string().trim().regex(/^\d{1,10}$/, "personId must be a FUB person id"),
  propertyKey: z.string().trim().optional(),
});

/**
 * POST /api/outreach/restart-verification — restart one lead's ID
 * verification from the top: a fresh verification SMS now, then the four
 * daily reminders (IDENTITY_RESTART_MARKER).
 *
 * Admin AND User, by client decision 2026-10-27 — unlike Restart and Send
 * link, which are admin-only. It is send-causing, but bounded: one text per
 * person per 20h, re-checked by the workflow, and every guard the reminders
 * apply is applied first.
 *
 * Person-level: `propertyKey` is audit context only.
 *
 * User-facing: do NOT add to SERVER_TO_SERVER_PATHS in src/proxy.ts.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireRole(["admin", "user"]);
    if (!auth.ok) return auth.response;

    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues.map((i) => i.message).join("; ") },
        { status: 400 }
      );
    }

    const result = await restartIdVerification(
      { personId: parsed.data.personId, propertyKey: parsed.data.propertyKey },
      auth.user.actorLabel
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[POST /api/outreach/restart-verification]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to restart ID verification" },
      { status: 500 }
    );
  }
}
