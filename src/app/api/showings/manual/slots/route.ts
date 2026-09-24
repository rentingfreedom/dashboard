import { NextResponse } from "next/server";
import { z } from "zod";
import { getPropertyByKey } from "@/lib/google/properties-repository";
import { getAvailableSlots } from "@/lib/cal/client";

const schema = z.object({
  propertyKey: z.string().trim().min(1, "propertyKey is required"),
  /** How many days out to look. Default matches the picker's default window. */
  days: z.coerce.number().int().min(1).max(30).default(14),
});

/**
 * GET /api/showings/manual/slots?propertyKey=…&days=14 — Cal.com's real
 * availability for one property's event type, for the default (non-custom)
 * side of the 6e picker.
 *
 * Always America/New_York: no workflow in the n8n instance sets a timezone
 * either, and every ET-hour computation elsewhere in this estate is deliberate
 * rather than incidental — matching it here keeps the picker's times meaning
 * the same thing the rest of the system does.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const parsed = schema.safeParse({
      propertyKey: url.searchParams.get("propertyKey") ?? "",
      days: url.searchParams.get("days") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues.map((i) => i.message).join("; ") },
        { status: 400 }
      );
    }

    const property = await getPropertyByKey(parsed.data.propertyKey);
    if (!property) {
      return NextResponse.json({ error: `Unknown property ${parsed.data.propertyKey}` }, { status: 404 });
    }
    const eventTypeId = String(property.cal_event_type_id ?? "").trim();
    if (!eventTypeId) {
      return NextResponse.json(
        { error: `${property.street_address || property.property_key} has no cal.com event type — it cannot be booked.` },
        { status: 400 }
      );
    }

    const start = new Date().toISOString();
    const end = new Date(Date.now() + parsed.data.days * 86_400_000).toISOString();
    const days = await getAvailableSlots(eventTypeId, start, end, "America/New_York");
    return NextResponse.json({ days });
  } catch (err) {
    console.error("[GET /api/showings/manual/slots]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load available slots" },
      { status: 500 }
    );
  }
}
