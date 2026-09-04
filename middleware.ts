import { NextResponse, type NextRequest } from "next/server";

/** The deployed site exposes only APIs backed by durable deployed storage. */
export function middleware(request: NextRequest) {
  if (!process.env.VERCEL) return NextResponse.next();
  const pathname = request.nextUrl.pathname;
  if (pathname === "/api/status") {
    const url = request.nextUrl.clone();
    url.pathname = "/mirror-api/status";
    return NextResponse.rewrite(url);
  }
  if (["/api/ledger", "/api/ledger/session", "/api/feedback", "/api/critical"].includes(pathname)) {
    return NextResponse.next();
  }
  return NextResponse.json({ error: "This operation is available only on the capture server." }, { status: 503 });
}

export const config = { matcher: "/api/:path*" };
