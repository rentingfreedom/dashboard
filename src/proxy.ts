import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const COOKIE_NAME = "rf_session";
const PUBLIC_PATHS = ["/login", "/api/auth/login"];

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // Always allow public paths, static assets, and PWA files
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/auth") ||
    /\.(png|svg|ico|jpg|jpeg|webp|woff2?|css|js)$/.test(pathname)
  ) {
    return NextResponse.next();
  }

  // If no ADMIN_PASSWORD is set, auth is disabled — allow everything
  if (!process.env.ADMIN_PASSWORD) {
    return NextResponse.next();
  }

  const sessionCookie = req.cookies.get(COOKIE_NAME)?.value;
  const expectedToken = Buffer.from(
    `${process.env.ADMIN_PASSWORD}:${process.env.ADMIN_PASSWORD}`
  ).toString("base64");

  if (!sessionCookie || sessionCookie !== expectedToken) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|icon|logo).*)"],
};
