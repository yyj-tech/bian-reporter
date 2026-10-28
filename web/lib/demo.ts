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
