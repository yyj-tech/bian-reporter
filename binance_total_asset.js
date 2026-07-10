const crypto = require("crypto");

const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;
const baseUrl = "https://api.binance.com";

if (!apiKey || !apiSecret) {
  console.error("Missing BINANCE_API_KEY or BINANCE_API_SECRET.");
  process.exit(1);
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

function sign(params) {
  const query = new URLSearchParams(params).toString();
  return crypto.createHmac("sha256", apiSecret).update(query).digest("hex");
}

async function getSigned(path, params = {}) {
  const payload = {
    ...params,
    timestamp: Date.now().toString(),
  };
  payload.signature = sign(payload);
  const query = new URLSearchParams(payload).toString();
  return requestJson(`${baseUrl}${path}?${query}`, {
    headers: {
      "X-MBX-APIKEY": apiKey,
    },
  });
}

async function getPublic(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const suffix = query ? `?${query}` : "";
  return requestJson(`${baseUrl}${path}${suffix}`);
}

function resolveAssetValue(asset, qty, priceMap) {
  if (qty === 0) return 0;
  if (["USDT", "FDUSD", "USDC", "BUSD"].includes(asset)) return qty;

  const direct = `${asset}USDT`;
  if (priceMap[direct]) return qty * priceMap[direct];

  const viaFdusd = `${asset}FDUSD`;
  if (priceMap[viaFdusd]) return qty * priceMap[viaFdusd];

  const viaBtc = `${asset}BTC`;
  if (priceMap[viaBtc] && priceMap.BTCUSDT) {
    return qty * priceMap[viaBtc] * priceMap.BTCUSDT;
  }

  const viaEth = `${asset}ETH`;
  if (priceMap[viaEth] && priceMap.ETHUSDT) {
    return qty * priceMap[viaEth] * priceMap.ETHUSDT;
  }

  return null;
}

async function main() {
  const [account, tickers] = await Promise.all([
    getSigned("/api/v3/account", { omitZeroBalances: "true", recvWindow: "5000" }),
    getPublic("/api/v3/ticker/price"),
  ]);

  const priceMap = Object.fromEntries(
    tickers.map((item) => [item.symbol, Number(item.price)])
  );

  let totalUsdt = 0;
  const rows = [];
  const unresolved = [];

  for (const bal of account.balances) {
    const qty = Number(bal.free) + Number(bal.locked);
    const value = resolveAssetValue(bal.asset, qty, priceMap);
    if (value == null) {
      unresolved.push({ asset: bal.asset, qty });
      continue;
    }
    totalUsdt += value;
    rows.push({ asset: bal.asset, qty, value });
  }

  rows.sort((a, b) => b.value - a.value);

  console.log(`Total Spot Asset ~= ${totalUsdt.toFixed(2)} USDT`);
  console.log("------------------------------------------------------------");
  for (const row of rows) {
    console.log(
      `${row.asset.padEnd(10)} qty=${row.qty.toFixed(8).padStart(18)}  value=${row.value
        .toFixed(2)
        .padStart(12)} USDT`
    );
  }

  if (unresolved.length) {
    console.log("\nUnresolved assets:");
    for (const item of unresolved) {
      console.log(`${item.asset}: ${item.qty}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
