import { NextRequest, NextResponse } from "next/server";
import { resolveTenant, tenantCookie } from "@/lib/auth";
import { seedDemo } from "@/lib/demo";

/**
 * Explicit, opt-in demo seeding. `/?demo=1` calls this once; nothing else does.
 *
 * The seed lands in the caller's own tenant, not a shared one, so one visitor's
 * follow-up questions can't rewrite what the next visitor sees — and anything they
 * ask afterwards is remembered under their own identity.
 */
export async function GET(req: NextRequest) {
  const { userId, isNew } = resolveTenant(req);
  const { conversationId, created } = seedDemo(userId);

  const res = NextResponse.json({ conversationId, created });
  res.headers.set("Cache-Control", "no-store");
  if (isNew) res.headers.set("Set-Cookie", tenantCookie(userId));
  return res;
}
