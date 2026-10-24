import { NextResponse, type NextRequest } from "next/server";
import { BLOCK_MESSAGE } from "@/domain/network-access";
import { clientIp } from "@/lib/client-ip";
import { DEVICE_REQUEST_COOKIE, HANDOFF_COOKIE, SESSION_COOKIE, TRUSTED_DEVICE_COOKIE } from "@/server/auth/cookies";
import { HANDOFF_BLOCKED, lockedHandoff } from "@/server/auth/handoff-lock";
import { gateRequest } from "@/server/auth/network";

const isAction = (req: NextRequest) => !!req.headers.get("next-action") || req.method !== "GET";

/**
 * A browser handed to a client shows only that ticket's customer screen: every other page goes back
 * to it and every other action is refused, until a staff PIN takes the device back.
 *
 * Every admin page, server action and download: no session goes to sign-in, and a session that
 * can't reach any of its shops from this network or device is refused, signed out and logged.
 * Pages and actions still re-verify the session and drop any shop that's out of reach.
 */
export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const handoff = req.cookies.get(HANDOFF_COOKIE)?.value;
  if (handoff) {
    const h = await lockedHandoff(handoff);
    if (h) {
      if (path === `/handoff/${h.id}`) return NextResponse.next();
      if (isAction(req)) return new NextResponse(HANDOFF_BLOCKED, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
      const url = req.nextUrl.clone();
      url.pathname = `/handoff/${h.id}`;
      url.search = "";
      return NextResponse.redirect(url);
    }
    if (!path.startsWith("/handoff/")) {
      const res = await adminGate(req, path);
      res.cookies.delete(HANDOFF_COOKIE);
      return res;
    }
  }
  return adminGate(req, path);
}

async function adminGate(req: NextRequest, path: string): Promise<NextResponse> {
  if (!path.startsWith("/admin")) return NextResponse.next();
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
  if (isAction(req)) {
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

/** Admin pages for the session and sign-in rules; every other page only for a device handed to a client. API routes check their own callers. */
export const config = { matcher: ["/((?!_next/|api/|.*\\..*).*)"], runtime: "nodejs" };
