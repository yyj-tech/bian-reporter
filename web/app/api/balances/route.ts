import { cookies } from "next/headers";
import { SESSION_COOKIE, dashboardPassword, sessionMatches } from "@/lib/auth";
import { getPortfolio, portfolioError } from "@/lib/binance";
import { demoPortfolio } from "@/lib/demo";
import { shanghaiNow } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  const password = dashboardPassword();
  if (!password) {
    return json({ error: "服务器还没有设置 DASHBOARD_PASSWORD。" }, 503);
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sessionMatches(token, password)) {
    return json({ error: "请先输入密码。" }, 401);
  }

  if (process.env.DASHBOARD_DEMO === "1") {
    if (process.env.NODE_ENV === "production") {
      return json({ error: "生产环境不能打开演示数据。" }, 503);
    }
    return json(demoPortfolio(shanghaiNow()));
  }

  try {
    const fresh = new URL(request.url).searchParams.get("fresh") === "1";
    return json(await getPortfolio(fresh));
  } catch (error) {
    const message = portfolioError(error);
    console.error(message);
    return json({ error: message }, 502);
  }
}
