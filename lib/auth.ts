import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { adoptLegacyRows } from "./db";

export const USER_COOKIE = "minimi_uid";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Before tenants existed every visitor was handed this literal id. It is NOT a
 * tenant: treating it as one meant any new visitor's adoption could reassign
 * rows out from under a browser that was still using it. It is now a one-time
 * migration marker instead.
 */
const LEGACY_TENANT = "local";

export interface Tenant {
  userId: string;
  isNew: boolean;
}

/**
 * Identity, not authentication. A stable partitioning key is all long-term
 * memory needs; proving who someone is across devices is a separate, later
 * problem (see DESIGN.md) and drops into this one function when it arrives.
 */
export function resolveTenant(req: NextRequest): Tenant {
  const existing = req.cookies.get(USER_COOKIE)?.value;

  // A browser from the pre-tenant build still sends "local". Mint a real id and
  // move the legacy rows onto it, so that browser keeps its history — once.
  if (existing === LEGACY_TENANT) {
    const userId = randomUUID();
    adoptLegacyRows(userId);
    return { userId, isNew: true };
  }

  if (existing && /^[A-Za-z0-9_-]{1,64}$/.test(existing)) {
    return { userId: existing, isNew: false };
  }

  // A genuinely new browser gets a private tenant and inherits nothing. Adoption
  // is deliberately NOT called here: it must only ever happen for the legacy
  // cookie, or one visitor's arrival would reassign another's conversations.
  return { userId: randomUUID(), isNew: true };
}

export function tenantCookie(userId: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${USER_COOKIE}=${userId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure}`;
}
