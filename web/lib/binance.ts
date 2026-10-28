import "server-only";

import { buysFromAutoInvest, buysFromSpotTrades, type BuyRecord } from "./cost";
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

const BUY_CACHE_MS = 10 * 60_000;
const PLAN_TYPES = ["PORTFOLIO", "SINGLE", "INDEX"];
const STABLE_ASSETS = new Set(["USDT", "FDUSD", "USDC", "BUSD"]);

export type BuyHistory = {
  buys: BuyRecord[];
  warnings: string[];
  startDate: string;
  skippedOtherQuote: number;
};

type BuyCache = BuyHistory & { at: number; key: string };

let buyCache: BuyCache | null = null;
let buyPending: Promise<BuyHistory> | null = null;
let buyPendingKey = "";

function historyStart(): { ms: number; label: string } {
  const label = process.env.AUTO_INVEST_START_DATE || "2026-01-01";
  const parsed = Date.parse(`${label}T00:00:00Z`);
  return { ms: Number.isFinite(parsed) ? parsed : Date.parse("2026-01-01T00:00:00Z"), label };
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  if (Array.isArray(record.list)) return record.list;
  if (Array.isArray(record.rows)) return record.rows;
  return [];
}

async function fetchAutoInvest(creds: Credentials, startMs: number): Promise<{ items: unknown[]; warnings: string[] }> {
  const items: unknown[] = [];
  const warnings: string[] = [];
  const end = Date.now();
  const windowMs = 30 * 24 * 60 * 60 * 1000;

  await Promise.all(
    PLAN_TYPES.map(async (planType) => {
      let noted = false;
      for (let cursor = startMs; cursor < end; cursor += windowMs) {
        const windowEnd = Math.min(cursor + windowMs - 1, end);
        for (let page = 1; page <= 20; page += 1) {
          try {
            const data = await getSigned(creds, "/sapi/v1/lending/auto-invest/history/list", {
              startTime: String(cursor),
              endTime: String(windowEnd),
              current: String(page),
              size: "100",
              planType,
              recvWindow: "5000",
            });
            const list = asList(data);
            items.push(...list);
            if (list.length < 100) break;
          } catch (error) {
            if (!noted) {
              warnings.push(`定投历史（${planType}）有一段没读到。${explain(error)}`);
              noted = true;
            }
            return;
          }
        }
      }
    }),
  );

  return { items, warnings };
}

async function fetchSpotBuys(creds: Credentials, assets: string[], startMs: number): Promise<{ buys: BuyRecord[]; warnings: string[] }> {
  const buys: BuyRecord[] = [];
  const warnings: string[] = [];
  const symbols = assets.filter((asset) => !STABLE_ASSETS.has(asset));
  let index = 0;

  async function worker() {
    while (index < symbols.length) {
      const asset = symbols[index];
      index += 1;
      if (!asset) continue;
      const collected: unknown[] = [];
      let fromId = "";
      for (let page = 0; page < 10; page += 1) {
        const params: Record<string, string> = { symbol: `${asset}USDT`, limit: "1000", recvWindow: "5000" };
        if (fromId) params.fromId = fromId;
        else params.startTime = String(startMs);
        try {
          const data = await getSigned(creds, "/api/v3/myTrades", params);
          const rows = asList(data);
          collected.push(...rows);
          if (rows.length < 1000) break;
          const last = asRecord(rows[rows.length - 1]);
          const lastId = last ? Number(last.id) : Number.NaN;
          if (!Number.isFinite(lastId)) break;
          fromId = String(lastId + 1);
        } catch (error) {
          const message = explain(error);
          if (!message.includes("-1121")) warnings.push(`${asset} 的现货成交没读到。${message}`);
          break;
        }
      }
      buys.push(...buysFromSpotTrades(collected, asset));
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, symbols.length) }, () => worker()));
  return { buys, warnings };
}

async function loadBuyHistory(assets: string[]): Promise<BuyHistory> {
  const creds = credentials();
  const start = historyStart();
  const [autoResult, spotResult] = await Promise.all([
    fetchAutoInvest(creds, start.ms),
    fetchSpotBuys(creds, assets, start.ms),
  ]);
  const parsed = buysFromAutoInvest(autoResult.items);
  const buys = [...parsed.buys, ...spotResult.buys].sort((a, b) => b.time - a.time || a.asset.localeCompare(b.asset));
  const warnings = [...autoResult.warnings, ...spotResult.warnings];
  if (parsed.skippedOtherQuote > 0) {
    warnings.push(`有 ${parsed.skippedOtherQuote} 笔定投不是用 USDT 买的，没有计入成本。`);
  }
  return { buys, warnings, startDate: start.label, skippedOtherQuote: parsed.skippedOtherQuote };
}

export function parseBuyAssets(value: string | null): string[] {
  if (!value) return [];
  const assets = value
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter((item) => /^[A-Z0-9]{2,20}$/.test(item));
  return [...new Set(assets)].slice(0, 40);
}

export async function getBuyHistory(assets: string[], fresh: boolean): Promise<BuyHistory> {
  const key = assets.slice().sort().join(",");
  if (!fresh && buyCache && buyCache.key === key && Date.now() - buyCache.at < BUY_CACHE_MS) {
    return buyCache;
  }
  if (!fresh && buyPending && buyPendingKey === key) return buyPending;

  buyPendingKey = key;
  buyPending = loadBuyHistory(assets)
    .then((data) => {
      buyCache = { ...data, at: Date.now(), key };
      return data;
    })
    .finally(() => {
      buyPending = null;
      buyPendingKey = "";
    });
  return buyPending;
}
