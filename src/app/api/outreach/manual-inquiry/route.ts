import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/roles";
import { createManualInquiry } from "@/lib/google/manual-inquiry-repository";

const schema = z.object({
  personId: z.string().trim().min(1, "personId is required"),
  propertyKey: z.string().trim().min(1, "propertyKey is required"),
  phone: z.string().trim().optional(),
  email: z.string().trim().optional(),
  liftSuppression: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * POST /api/outreach/manual-inquiry — hand-create a real `Inquiries` row for a
 * lead re-engaging on a different property (Nicole calls them after their
 * showing was cancelled, they want to look at another house), and push it the
 * same way a real FUB inquiry event would.
 *
 * **Admin only**, matching `restart-nudges` and `restart`: this can send a
 * real cal-link SMS/email, or a real ID-verification SMS, to a real customer
 * immediately. Every trash tag, stage gate and phone check is still
 * re-applied by n8n at send time regardless of what happens here.
 *
 * User-facing: do NOT add to SERVER_TO_SERVER_PATHS in src/proxy.ts.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireRole(["admin"]);
    if (!auth.ok) return auth.response;

    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues.map((i) => i.message).join("; ") },
        { status: 400 }
      );
    }
    const d = parsed.data;

    const result = await createManualInquiry(
      {
        personId: d.personId,
        propertyKey: d.propertyKey,
        phone: d.phone ?? "",
        email: d.email ?? "",
        liftSuppression: Boolean(d.liftSuppression),
        reason: d.reason,
      },
      auth.user.actorLabel
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[POST /api/outreach/manual-inquiry]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create the inquiry" },
      { status: 500 }
    );
  }
}
