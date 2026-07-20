import crypto from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const COOKIE_NAME = "rf_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export async function POST(req: Request) {
  const adminPassword = process.env.ADMIN_PASSWORD;

  // If no password is configured, auth is disabled — allow through
  if (!adminPassword) {
    const res = NextResponse.json({ ok: true });
    res.cookies.set(COOKIE_NAME, "open", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    });
    return res;
  }

  if (!process.env.AUTH_SECRET) {
    throw new Error(
      "AUTH_SECRET is not set. ADMIN_PASSWORD is configured, so AUTH_SECRET must also be set to sign session cookies."
    );
  }

  const body = await req.json().catch(() => ({}));
  if (body.password !== adminPassword) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  // Token = base64(HMAC-SHA256(AUTH_SECRET, "authenticated"))
  // Static, stable, doesn't depend on password value
  const token = crypto
    .createHmac("sha256", process.env.AUTH_SECRET)
    .update("authenticated")
    .digest("base64");

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
  return res;
}
