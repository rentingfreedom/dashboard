import { NextResponse } from "next/server";
import { getInFlight } from "@/lib/google/in-flight-repository";
import { getAuthedUser } from "@/lib/auth/roles";

/**
 * GET /api/outreach/in-flight?property=<key>&refresh=1
 *
 * Who is currently inside a messaging sequence.
 *
 * This payload is a list of real people with phone numbers and email addresses,
 * so a signed-in user is required — the same reasoning as the funnel route. No
 * specific role: seeing who is being messaged is for whoever runs the business,
 * and the role gate belongs on the writes.
 *
 * NOT a server-to-server route. Do not add it to SERVER_TO_SERVER_PATHS in
 * src/proxy.ts — it is user-facing and must stay behind Clerk.
 */
export async function GET(request: Request) {
  try {
    const user = await getAuthedUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to view outreach." }, { status: 401 });
    }

    const url = new URL(request.url);
    const propertyKey = url.searchParams.get("property")?.trim() || undefined;
    const refresh = url.searchParams.get("refresh") === "1";

    const result = await getInFlight({ propertyKey, force: refresh });
    return NextResponse.json({ result });
  } catch (err) {
    console.error("[GET /api/outreach/in-flight]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load outreach state" },
      { status: 500 }
    );
  }
}
