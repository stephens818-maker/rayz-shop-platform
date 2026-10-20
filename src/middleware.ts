import { NextResponse, type NextRequest } from "next/server";

// Cheap gate only; every admin page and action re-verifies the session server-side.
export function middleware(req: NextRequest) {
  if (!req.cookies.get("rayz_session")?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/admin/:path*"] };
