import { NextResponse } from "next/server";
import { clerkMiddleware } from "@clerk/nextjs/server";

const PUBLIC_PATHS = ["/sign-in", "/sign-up"];

// Server-to-server endpoints called by Stripe and n8n, not by a browser —
// there's no Clerk session to check. Each of these enforces its own auth
// (Stripe webhook signature / shared secret header) inside the route itself.
const SERVER_TO_SERVER_PATHS = [
  "/api/identity/create-session",
  "/api/webhooks/stripe-identity",
];

// Role/permission checks happen close to the resource (page and route handler
// level), not here — currentUser()/auth() with metadata aren't usable inside
// the middleware/proxy callback itself. This proxy only enforces "signed in".
export default clerkMiddleware(async (auth, req) => {
  const { pathname } = req.nextUrl;

  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    SERVER_TO_SERVER_PATHS.some((p) => pathname.startsWith(p))
  ) {
    return NextResponse.next();
  }

  const { userId } = await auth();
  if (!userId) {
    const signInUrl = new URL("/sign-in", req.url);
    signInUrl.searchParams.set("redirect_url", pathname + req.nextUrl.search);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|icon|logo).*)",
  ],
};
