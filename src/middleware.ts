import { NextResponse, type NextRequest } from "next/server";
import { BLOCK_MESSAGE } from "@/domain/network-access";
import { clientIp } from "@/lib/client-ip";
import { DEVICE_REQUEST_COOKIE, SESSION_COOKIE, TRUSTED_DEVICE_COOKIE } from "@/server/auth/cookies";
import { gateRequest } from "@/server/auth/network";

/**
 * Every admin page, server action and download: no session goes to sign-in, and a session that
 * can't reach any of its shops from this network or device is refused, signed out and logged.
 * Pages and actions still re-verify the session and drop any shop that's out of reach.
 */
export async function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  const gate = await gateRequest({
    sessionToken: token,
    deviceToken: req.cookies.get(TRUSTED_DEVICE_COOKIE)?.value,
    ip: clientIp(req.headers),
    path: req.nextUrl.pathname,
    userAgent: req.headers.get("user-agent"),
  });
  if (gate.kind === "ok") return NextResponse.next();

  let res: NextResponse;
  if (req.headers.get("next-action") || req.method !== "GET") {
    res = new NextResponse(BLOCK_MESSAGE, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  } else {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?blocked=1&next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
    res = NextResponse.redirect(url);
  }
  res.cookies.delete(SESSION_COOKIE);
  if (gate.ticket)
    res.cookies.set(DEVICE_REQUEST_COOKIE, gate.ticket, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/login", maxAge: 15 * 60 });
  return res;
}

export const config = { matcher: ["/admin/:path*"], runtime: "nodejs" };
