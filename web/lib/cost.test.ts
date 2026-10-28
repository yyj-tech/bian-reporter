import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buysFromAutoInvest, buysFromSpotTrades, summarizeBuys } from "./cost.ts";

describe("buy history", () => {
  it("keeps successful USDT auto-invest fills and adds the USDT fee to cost", () => {
    const { buys, skippedOtherQuote } = buysFromAutoInvest([
      {
        transactionStatus: "SUCCESS",
        sourceAsset: "USDT",
        sourceAssetAmount: "100",
        targetAsset: "BTC",
        targetAssetAmount: "0.002",
        transactionFee: "0.1",
        transactionFeeUnit: "USDT",
        executionPrice: "50000",
        transactionDateTime: 1_700_000_000_000,
        planType: "PORTFOLIO",
      },
      {
        transactionStatus: "SUCCESS",
        sourceAsset: "BTC",
        sourceAssetAmount: "1",
        targetAsset: "ETH",
        targetAssetAmount: "10",
        transactionDateTime: 1,
      },
      {
        transactionStatus: "FAILED",
        sourceAsset: "USDT",
        sourceAssetAmount: "20",
        targetAsset: "ETH",
        targetAssetAmount: "0.01",
        transactionDateTime: 2,
      },
    ]);

    assert.equal(skippedOtherQuote, 1);
    assert.equal(buys.length, 1);
    assert.equal(buys[0]?.costUsdt, 100.1);
    assert.equal(buys[0]?.priceUsdt, 50_000);
    assert.equal(buys[0]?.source, "组合定投");
  });

  it("dedupes the same auto-invest fill", () => {
    const item = {
      transactionStatus: "SUCCESS",
      sourceAsset: "USDT",
      sourceAssetAmount: "10",
      targetAsset: "SOL",
      targetAssetAmount: "0.1",
      transactionDateTime: 5,
      planType: "SINGLE",
    };
    const { buys } = buysFromAutoInvest([item, item]);
    assert.equal(buys.length, 1);
    assert.equal(buys[0]?.source, "单币定投");
  });

  it("counts a spot buy and reduces quantity when the fee is paid in that coin", () => {
    const buys = buysFromSpotTrades(
      [
        {
          id: 7,
          symbol: "ETHUSDT",
          qty: "1",
          quoteQty: "2000",
          commission: "0.001",
          commissionAsset: "ETH",
          time: 9,
          isBuyer: true,
        },
        { id: 8, symbol: "ETHUSDT", qty: "1", quoteQty: "2100", commission: "0", commissionAsset: "USDT", time: 10, isBuyer: false },
      ],
      "ETH",
    );
    assert.equal(buys.length, 1);
    assert.equal(buys[0]?.quantity, 0.999);
    assert.equal(buys[0]?.costUsdt, 2000);
    assert.equal(buys[0]?.source, "现货");
  });
});

describe("summarizeBuys", () => {
  it("values the coins still held at the average buy price", () => {
    const summary = summarizeBuys(
      [
        { id: "1", time: 1, asset: "BTC", quantity: 2, costUsdt: 100, priceUsdt: 50, source: "定投" },
        { id: "2", time: 2, asset: "BTC", quantity: 2, costUsdt: 300, priceUsdt: 150, source: "现货" },
      ],
      [{ asset: "BTC", quantity: 1, priceUsdt: 80 }],
    );

    const btc = summary.assets[0];
    assert.equal(btc?.boughtQuantity, 4);
    assert.equal(btc?.avgCostUsdt, 100);
    assert.equal(btc?.pnlUsdt, -20);
    assert.equal(btc?.pnlRate, -20);
    assert.equal(btc?.extraQuantity, 0);
    assert.equal(summary.totals.investedUsdt, 100);
    assert.equal(summary.totals.pnlUsdt, -20);
  });

  it("does not treat coins without a buy record as profit", () => {
    const summary = summarizeBuys(
      [{ id: "1", time: 1, asset: "SOL", quantity: 2, costUsdt: 100, priceUsdt: 50, source: "定投" }],
      [{ asset: "SOL", quantity: 5, priceUsdt: 80 }],
    );
    assert.equal(summary.assets[0]?.pnlUsdt, 60);
    assert.equal(summary.assets[0]?.extraQuantity, 3);
    assert.equal(summary.totals.investedUsdt, 100);
  });
});
