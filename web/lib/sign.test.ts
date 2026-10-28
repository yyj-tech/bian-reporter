import assert from "node:assert/strict";
import { createHmac } from "crypto";
import { describe, it } from "node:test";
import { signedParams } from "./sign.ts";

describe("signedParams", () => {
  it("signs the exact query string Binance expects", () => {
    const query = signedParams({ recvWindow: "5000", omitZeroBalances: "true" }, "secret", 1_700_000_000_000);
    const [unsigned, signature] = query.split("&signature=");
    assert.equal(unsigned, "recvWindow=5000&omitZeroBalances=true&timestamp=1700000000000");
    assert.equal(signature, createHmac("sha256", "secret").update(unsigned).digest("hex"));
  });
});
