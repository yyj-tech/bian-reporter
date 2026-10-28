import "server-only";

import { formatApr, shanghaiNow } from "./format";
import { buildPortfolio, type Portfolio, type RawBalance, type RawEarn } from "./portfolio";
import { signedParams } from "./sign";

const CACHE_MS = 15_000;

type CacheEntry = {
  at: number;
  data: Portfolio;
};

let cached: CacheEntry | null = null;
let pending: Promise<Portfolio> | null = null;

type Credentials = {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
};

function credentials(): Credentials {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("服务器还没有设置 BINANCE_API_KEY 或 BINANCE_API_SECRET。");
  }
  return {
    apiKey,
    apiSecret,
    baseUrl: (process.env.BINANCE_BASE_URL || "https://api.binance.com").replace(/\/$/, ""),
  };
}

function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : "读取账户失败";
  if (message.includes("451") || /restricted location/i.test(message)) {
    return "币安拒绝了这台服务器所在地区。在 Vercel 的 Settings → Functions 里只保留 fra1（法兰克福）或 hnd1（东京），然后重新部署。";
  }
  if (message.includes("-2015")) {
    return "币安拒绝了这把 API Key。请使用只读、没有提现权限的 Key，并关掉 IP 白名单。Vercel 的出口 IP 不固定，绑了家里或 GitHub 的地址后这里会读不到。";
  }
  return message;
}

async function binanceFetch(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "网络异常";
    throw new Error(`连接币安失败：${reason}`);
  }

  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 240);
    try {
      const parsed = JSON.parse(text) as { msg?: string; code?: number };
      if (parsed.msg) detail = `${parsed.code ?? response.status}: ${parsed.msg}`;
    } catch {
      detail = text.slice(0, 240);
    }
    throw new Error(`币安接口 ${response.status} ${detail}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("币安返回了无法解析的内容。");
  }
}

async function getPublic(baseUrl: string, path: string): Promise<unknown> {
  return binanceFetch(`${baseUrl}${path}`, { method: "GET" });
}

async function getSigned(creds: Credentials, path: string, params: Record<string, string>): Promise<unknown> {
  const query = signedParams(params, creds.apiSecret);
  return binanceFetch(`${creds.baseUrl}${path}?${query}`, {
    method: "GET",
    headers: { "X-MBX-APIKEY": creds.apiKey },
  });
}

async function postSigned(creds: Credentials, path: string, params: Record<string, string>): Promise<unknown> {
  const body = signedParams(params, creds.apiSecret);
  return binanceFetch(`${creds.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "X-MBX-APIKEY": creds.apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asBalances(value: unknown): RawBalance[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = asRecord(item);
    if (!row || typeof row.asset !== "string") return [];
    return [
      {
        asset: row.asset,
        free: String(row.free ?? "0"),
        locked: String(row.locked ?? "0"),
        freeze: String(row.freeze ?? "0"),
        withdrawing: String(row.withdrawing ?? "0"),
      },
    ];
  });
}

function asPrices(value: unknown): Record<string, number> {
  const prices: Record<string, number> = {};
  if (!Array.isArray(value)) return prices;
  for (const item of value) {
    const row = asRecord(item);
    if (!row || typeof row.symbol !== "string") continue;
    const price = Number(row.price);
    if (Number.isFinite(price)) prices[row.symbol] = price;
  }
  return prices;
}

function earnDetail(row: Record<string, unknown>, durationField: "duration" | null): string {
  const parts: string[] = [];
  if (durationField) {
    const duration = Number(row[durationField]);
    if (Number.isFinite(duration) && duration > 0) parts.push(`${duration} 天`);
  }
  const apr = formatApr(
    typeof row.latestAnnualPercentageRate === "string"
      ? row.latestAnnualPercentageRate
      : typeof row.apr === "string"
        ? row.apr
        : undefined,
  );
  if (apr) parts.push(apr);
  return parts.join(" · ");
}

function asEarn(value: unknown, amountField: "totalAmount" | "amount"): RawEarn[] {
  const record = asRecord(value);
  const rows = record && Array.isArray(record.rows) ? record.rows : [];
  return rows.flatMap((item) => {
    const row = asRecord(item);
    if (!row || typeof row.asset !== "string") return [];
    const amount = row[amountField];
    return [
      {
        asset: row.asset,
        amount: typeof amount === "string" || typeof amount === "number" ? String(amount) : "0",
        detail: earnDetail(row, amountField === "amount" ? "duration" : null),
      },
    ];
  });
}

async function getAllEarn(creds: Credentials, path: string, amountField: "totalAmount" | "amount"): Promise<RawEarn[]> {
  const rows: RawEarn[] = [];
  for (let current = 1; current <= 20; current += 1) {
    const page = await getSigned(creds, path, {
      current: String(current),
      size: "100",
      recvWindow: "5000",
    });
    const pageRows = asEarn(page, amountField);
    rows.push(...pageRows);
    const record = asRecord(page);
    const rawCount = record && Array.isArray(record.rows) ? record.rows.length : 0;
    if (rawCount < 100) break;
  }
  return rows;
}

async function fetchCnyRate(): Promise<number | null> {
  const configured = Number(process.env.USD_CNY_RATE);
  if (Number.isFinite(configured) && configured > 0) return configured;
  const response = await fetch("https://open.er-api.com/v6/latest/USD", {
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { rates?: { CNY?: number } };
  const rate = data.rates?.CNY;
  return typeof rate === "number" && Number.isFinite(rate) ? rate : null;
}

async function loadPortfolio(): Promise<Portfolio> {
  const creds = credentials();
  const warnings: string[] = [];

  const [priceResult, accountResult, fundingResult, flexibleResult, lockedResult, cnyResult] = await Promise.allSettled([
    getPublic(creds.baseUrl, "/api/v3/ticker/price"),
    getSigned(creds, "/api/v3/account", { omitZeroBalances: "true", recvWindow: "5000" }),
    postSigned(creds, "/sapi/v1/asset/get-funding-asset", { needBtcValuation: "false", recvWindow: "5000" }),
    getAllEarn(creds, "/sapi/v1/simple-earn/flexible/position", "totalAmount"),
    getAllEarn(creds, "/sapi/v1/simple-earn/locked/position", "amount"),
    fetchCnyRate(),
  ]);

  if (accountResult.status === "rejected") throw new Error(explain(accountResult.reason));

  const account = asRecord(accountResult.value);
  if (!account || !Array.isArray(account.balances)) {
    throw new Error("币安现货账户返回的数据无法识别。");
  }

  let prices: Record<string, number> = {};
  if (priceResult.status === "fulfilled") {
    prices = asPrices(priceResult.value);
  } else {
    warnings.push(`行情暂时读不到，数量仍会显示。${explain(priceResult.reason)}`);
  }

  let funding: RawBalance[] = [];
  if (fundingResult.status === "fulfilled") {
    funding = asBalances(fundingResult.value);
  } else {
    warnings.push(`资金账户暂时读不到。${explain(fundingResult.reason)}`);
  }

  let flexible: RawEarn[] = [];
  if (flexibleResult.status === "fulfilled") {
    flexible = flexibleResult.value;
  } else {
    warnings.push(`Simple Earn 活期暂时读不到。${explain(flexibleResult.reason)}`);
  }

  let locked: RawEarn[] = [];
  if (lockedResult.status === "fulfilled") {
    locked = lockedResult.value;
  } else {
    warnings.push(`Simple Earn 定期暂时读不到。${explain(lockedResult.reason)}`);
  }

  let cnyRate: number | null = null;
  if (cnyResult.status === "fulfilled") cnyRate = cnyResult.value;

  return buildPortfolio({
    spot: asBalances(account.balances),
    funding,
    flexible,
    locked,
    prices,
    warnings,
    generatedAt: shanghaiNow(),
    cnyRate,
  });
}

export async function getPortfolio(fresh: boolean): Promise<Portfolio> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  if (!fresh && pending) return pending;

  pending = loadPortfolio()
    .then((data) => {
      cached = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      pending = null;
    });

  return pending;
}

export function portfolioError(error: unknown): string {
  return explain(error);
}
