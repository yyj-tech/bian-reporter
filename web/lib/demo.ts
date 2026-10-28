import type { BuyRecord } from "./cost";
import { buildPortfolio, type Portfolio } from "./portfolio";

export function demoPortfolio(generatedAt: string): Portfolio {
  return buildPortfolio({
    generatedAt,
    cnyRate: 7.12,
    warnings: ["当前是演示数据，没有连接币安。"],
    prices: {
      BTCUSDT: 68_000,
      ETHUSDT: 2_500,
      SOLUSDT: 150,
      BNBUSDT: 600,
      SPCXBUSDT: 115.6,
    },
    spot: [
      { asset: "BTC", free: "0.0152", locked: "0.001" },
      { asset: "USDT", free: "820.5", locked: "0" },
      { asset: "ETH", free: "1.25", locked: "0" },
      { asset: "LDUSDT", free: "300", locked: "0" },
    ],
    funding: [{ asset: "SPCXB", free: "12.51778149", locked: "0", freeze: "0", withdrawing: "0" }],
    flexible: [
      { asset: "USDT", amount: "300", detail: "年化 3.20%" },
      { asset: "SOL", amount: "6.5", detail: "年化 1.10%" },
    ],
    locked: [{ asset: "BNB", amount: "0.8", detail: "30 天 · 年化 2.40%" }],
  });
}

export function demoBuys(): BuyRecord[] {
  return [
    { id: "btc-1", time: Date.parse("2026-03-02T02:00:00Z"), asset: "BTC", quantity: 0.01, costUsdt: 600, priceUsdt: 60_000, source: "组合定投" },
    { id: "btc-2", time: Date.parse("2026-08-01T02:00:00Z"), asset: "BTC", quantity: 0.0062, costUsdt: 434, priceUsdt: 70_000, source: "组合定投" },
    { id: "eth-1", time: Date.parse("2026-04-15T02:00:00Z"), asset: "ETH", quantity: 1.25, costUsdt: 3_750, priceUsdt: 3_000, source: "单币定投" },
    { id: "sol-1", time: Date.parse("2026-06-20T02:00:00Z"), asset: "SOL", quantity: 6.5, costUsdt: 650, priceUsdt: 100, source: "组合定投" },
    { id: "bnb-1", time: Date.parse("2026-05-10T02:00:00Z"), asset: "BNB", quantity: 0.8, costUsdt: 400, priceUsdt: 500, source: "现货" },
  ];
}
