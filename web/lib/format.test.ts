import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatApr, formatCny, formatQty, formatUsdt } from "./format.ts";

describe("formatters", () => {
  it("keeps coin quantities exact to 8 decimals without trailing zeros", () => {
    assert.equal(formatQty(0.0152), "0.0152");
    assert.equal(formatQty(820.5), "820.5");
    assert.equal(formatQty(12.51778149), "12.51778149");
    assert.equal(formatQty(1000), "1,000");
  });

  it("formats USDT and CNY estimates", () => {
    assert.equal(formatUsdt(1101.6), "1,101.60 USDT");
    assert.equal(formatUsdt(null), "无法折算");
    assert.equal(formatCny(100, 7.1), "≈ ¥710.00");
    assert.equal(formatCny(100, null), "人民币估算暂不可用");
  });

  it("treats Binance APR decimals as percentages", () => {
    assert.equal(formatApr("0.032"), "年化 3.20%");
  });
});
