import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPortfolio } from "./portfolio.ts";

const prices = {
  BTCUSDT: 68_000,
  ETHUSDT: 2_500,
  SPCXBBTC: 0.001,
};

describe("buildPortfolio", () => {
  it("sums spot, funding, and earn, and counts an LD receipt only once", () => {
    const portfolio = buildPortfolio({
      generatedAt: "2026-10-28 16:00:00",
      cnyRate: 7.2,
      prices,
      spot: [
        { asset: "BTC", free: "0.01", locked: "0.001" },
        { asset: "USDT", free: "100", locked: "0" },
        { asset: "LDUSDT", free: "50", locked: "0" },
        { asset: "DUST", free: "0", locked: "0" },
      ],
      funding: [{ asset: "SPCXB", free: "2", locked: "0", freeze: "1", withdrawing: "0" }],
      flexible: [{ asset: "USDT", amount: "50", detail: "年化 3.20%" }],
      locked: [{ asset: "ETH", amount: "0.4", detail: "30 天" }],
    });

    assert.deepEqual(portfolio.omittedLendingTokens, ["LDUSDT"]);
    assert.equal(portfolio.holdings.some((row) => row.asset === "LDUSDT"), false);
    assert.equal(portfolio.holdings.some((row) => row.asset === "DUST"), false);

    const btc = portfolio.holdings.find((row) => row.asset === "BTC");
    assert.equal(btc?.quantity, 0.011);
    assert.equal(btc?.valueUsdt, 0.011 * 68_000);

    const funding = portfolio.holdings.find((row) => row.asset === "SPCXB");
    assert.equal(funding?.quantity, 3);
    assert.equal(funding?.valueUsdt, 3 * 0.001 * 68_000);

    assert.equal(portfolio.totals.spot, 0.011 * 68_000 + 100);
    assert.equal(portfolio.totals.funding, 3 * 68);
    assert.equal(portfolio.totals.flexible, 50);
    assert.equal(portfolio.totals.locked, 0.4 * 2_500);
    assert.equal(
      portfolio.totals.grand,
      portfolio.totals.spot + portfolio.totals.funding + portfolio.totals.flexible + portfolio.totals.locked,
    );

    const usdt = portfolio.overview.find((row) => row.asset === "USDT");
    assert.equal(usdt?.quantity, 150);
    assert.deepEqual(usdt?.wallets, [
      { label: "现货", quantity: 100 },
      { label: "活期", quantity: 50 },
    ]);
  });

  it("keeps an LD token when the earn position is missing", () => {
    const portfolio = buildPortfolio({
      generatedAt: "now",
      cnyRate: null,
      prices: {},
      spot: [{ asset: "LDUSDT", free: "8", locked: "0" }],
      funding: [],
      flexible: [],
      locked: [],
    });

    assert.equal(portfolio.holdings[0]?.asset, "LDUSDT");
    assert.equal(portfolio.holdings[0]?.valueUsdt, 8);
    assert.deepEqual(portfolio.omittedLendingTokens, []);
  });

  it("shows a coin that has no USDT price without adding it to the total", () => {
    const portfolio = buildPortfolio({
      generatedAt: "now",
      cnyRate: null,
      prices: {},
      spot: [{ asset: "ABC", free: "4", locked: "1" }],
      funding: [],
      flexible: [],
      locked: [],
    });

    assert.equal(portfolio.holdings[0]?.quantity, 5);
    assert.equal(portfolio.holdings[0]?.valueUsdt, null);
    assert.equal(portfolio.totals.grand, 0);
    assert.match(portfolio.warnings[0] ?? "", /ABC/);
  });
});
