import { cookies } from "next/headers";
import { SESSION_COOKIE, dashboardPassword, sessionMatches } from "@/lib/auth";
import { getBuyHistory, parseBuyAssets, portfolioError } from "@/lib/binance";
import { demoBuys } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  const url = new URL(request.url);
  if (process.env.DASHBOARD_DEMO === "1") {
    if (process.env.NODE_ENV === "production") {
      return json({ error: "生产环境不能打开演示数据。" }, 503);
    }
    return json({
      buys: demoBuys(),
      warnings: [],
      startDate: "2026-01-01",
      skippedOtherQuote: 0,
    });
  }

  try {
    const history = await getBuyHistory(parseBuyAssets(url.searchParams.get("assets")), url.searchParams.get("fresh") === "1");
    return json(history);
  } catch (error) {
    const message = portfolioError(error);
    console.error(message);
    return json({ error: message }, 502);
  }
}
