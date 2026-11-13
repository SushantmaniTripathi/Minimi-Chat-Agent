import { NextRequest, NextResponse } from "next/server";
import { listConversations } from "@/lib/db";
import { resolveTenant, tenantCookie } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const { userId, isNew } = resolveTenant(req);
  const res = NextResponse.json({ conversations: listConversations(userId) });
  // Never cache a tenant-scoped list: a stale copy from another session shows
  // conversations the current tenant doesn't own, and every click 404s.
  res.headers.set("Cache-Control", "no-store");
  if (isNew) res.headers.set("Set-Cookie", tenantCookie(userId));
  return res;
}
