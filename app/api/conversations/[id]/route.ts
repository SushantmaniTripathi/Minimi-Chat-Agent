import { NextRequest, NextResponse } from "next/server";
import { deleteConversation, getConversation, getMessages } from "@/lib/db";
import { resolveTenant, tenantCookie } from "@/lib/auth";

// Every handler resolves the tenant first and filters by it. A conversation that
// belongs to another tenant is indistinguishable from a missing one.
function owned(req: NextRequest, id: string) {
  const { userId, isNew } = resolveTenant(req);
  const conversation = getConversation(id, userId);
  return { userId, isNew, conversation };
}

/**
 * A visitor whose first request is a conversation URL still needs their id, and
 * every response that mints one has to set it — otherwise each follow-up request
 * would invent a new tenant and 404 forever.
 */
function withTenant(res: NextResponse, isNew: boolean, userId: string) {
  if (isNew) res.headers.set("Set-Cookie", tenantCookie(userId));
  return res;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { userId, isNew, conversation } = owned(req, id);
  if (!conversation) {
    return withTenant(NextResponse.json({ error: "Not found" }, { status: 404 }), isNew, userId);
  }

  const messages = getMessages(id).map((m) => ({
    ...m,
    citations: m.citations ? JSON.parse(m.citations) : null,
  }));
  const res = NextResponse.json({ conversation, messages });
  res.headers.set("Cache-Control", "no-store");
  return withTenant(res, isNew, userId);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { userId, isNew, conversation } = owned(req, id);
  if (!conversation) {
    return withTenant(NextResponse.json({ error: "Not found" }, { status: 404 }), isNew, userId);
  }

  deleteConversation(id, userId);
  return withTenant(NextResponse.json({ ok: true }), isNew, userId);
}
