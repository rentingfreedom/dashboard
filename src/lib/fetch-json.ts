/**
 * Fetch JSON from one of our own API routes, failing with a message that says
 * what actually went wrong.
 *
 * The pages used to do this:
 *
 *   if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load");
 *   const data = await res.json();
 *
 * Both lines parse the body blindly, so any non-JSON response surfaced as
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` — which hides the
 * HTTP status, the single most useful fact about the failure. That is exactly
 * what the Showings page showed in production on 2026-09-01, and it made the
 * cause (auth redirect? platform 500? function timeout?) undiagnosable from the
 * screenshot alone.
 *
 * An HTML body from one of our routes is never a route-level error — every
 * route returns JSON on both paths — so it means the request never reached the
 * handler. The two realistic causes are named explicitly below.
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();

  console.log(
    `[fetchJson] ${url} -> ${res.status} ${res.statusText} ` +
      `content-type="${contentType}" redirected=${res.redirected} ` +
      `finalUrl=${res.url} bytes=${body.length}`
  );

  if (!contentType.includes("application/json")) {
    // Signed-out requests are redirected to /sign-in by the proxy, and fetch
    // follows that redirect, so the HTML sign-in page arrives here as a 200.
    const looksLikeSignIn = res.redirected && /\/sign-in/.test(res.url);
    if (looksLikeSignIn) {
      throw new Error("Your session expired. Reload the page to sign in again.");
    }
    throw new Error(
      `${url} returned ${res.status} ${res.statusText} as ${contentType || "an unknown type"}, ` +
        `not JSON. This usually means the request never reached the route — ` +
        `an expired session, or a platform error such as a function timeout.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${url} returned ${res.status} with a malformed JSON body.`);
  }

  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new Error(message);
  }

  return parsed as T;
}
