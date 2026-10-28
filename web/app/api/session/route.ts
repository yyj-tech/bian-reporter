import { cookies } from "next/headers";
import { SESSION_COOKIE, dashboardPassword, passwordMatches, sessionToken } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookieBase = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const password = dashboardPassword();
  if (!password) {
    return json({ error: "服务器还没有设置 DASHBOARD_PASSWORD。" }, 503);
  }

  let input = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    if (typeof body.password === "string") input = body.password;
  } catch {
    input = "";
  }

  if (input.length === 0 || input.length > 200 || !passwordMatches(input, password)) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return json({ error: "密码不正确。" }, 401);
  }

  (await cookies()).set({
    name: SESSION_COOKIE,
    value: sessionToken(password),
    ...cookieBase,
    maxAge: 60 * 60 * 24 * 14,
  });
  return json({ ok: true });
}

export async function DELETE() {
  (await cookies()).set({
    name: SESSION_COOKIE,
    value: "",
    ...cookieBase,
    maxAge: 0,
  });
  return json({ ok: true });
}
