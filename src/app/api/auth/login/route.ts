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

  const body = await req.json().catch(() => ({}));
  if (body.password !== adminPassword) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  // Simple token: hash of password + a server secret
  const token = Buffer.from(`${adminPassword}:${process.env.ADMIN_PASSWORD}`).toString("base64");

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
