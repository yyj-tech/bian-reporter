import "server-only";

import { createHmac, timingSafeEqual } from "crypto";

export const SESSION_COOKIE = "br_session";

const SESSION_MESSAGE = "bian-reporter-session-v1";

export function dashboardPassword(): string | null {
  const password = process.env.DASHBOARD_PASSWORD;
  return password ? password : null;
}

export function passwordMatches(input: string, expected: string): boolean {
  const left = Buffer.from(input);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function sessionToken(password: string): string {
  return createHmac("sha256", password).update(SESSION_MESSAGE).digest("hex");
}

export function sessionMatches(cookie: string | undefined, password: string): boolean {
  if (!cookie) return false;
  const expected = sessionToken(password);
  const left = Buffer.from(cookie);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
