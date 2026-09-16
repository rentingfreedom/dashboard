import { NextResponse } from "next/server";
import { getFunnelMetrics } from "@/lib/google/funnel-repository";
import { getAuthedUser } from "@/lib/auth/roles";
import { LAUNCH_DATE } from "@/lib/metrics/funnel";

/**
 * GET /api/metrics/funnel?from=<iso>&to=<iso>&refresh=1
 *
 * Defaults to since-launch. `refresh=1` bypasses the repository's short cache.
 *
 * This route returns lead names, phone numbers and FUB links — the "currently
 * stuck" panel is a list of real people. The sibling routes have no server-side
 * auth check, relying on Clerk at the app shell; that is not enough for a
 * payload like this, so a signed-in user is required here. No specific role:
 * the funnel is for whoever runs the business, and the admin gate belongs on
 * writes, not on reading the numbers.
 */
export async function GET(request: Request) {
  try {
    const user = await getAuthedUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to view funnel metrics." }, { status: 401 });
    }

    const url = new URL(request.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const refresh = url.searchParams.get("refresh") === "1";

    // A malformed date must not silently become "since the epoch", which would
    // quietly include the whole pre-launch CRM in the numbers.
    const valid = (v: string | null) => v && Number.isFinite(new Date(v).getTime());
    if (fromParam && !valid(fromParam)) {
      return NextResponse.json({ error: `Invalid "from" date: ${fromParam}` }, { status: 400 });
    }
    if (toParam && !valid(toParam)) {
      return NextResponse.json({ error: `Invalid "to" date: ${toParam}` }, { status: 400 });
    }

    const metrics = await getFunnelMetrics({
      from: fromParam ?? LAUNCH_DATE,
      to: toParam ?? undefined,
      force: refresh,
    });

    return NextResponse.json({ metrics });
  } catch (err) {
    console.error("[GET /api/metrics/funnel]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load funnel metrics" },
      { status: 500 }
    );
  }
}
