# 调研来源

- Binance Spot Account Endpoints: `GET /api/v3/account` 只返回当前账户余额等信息，不返回成本价。
  - https://developers.binance.com/docs/binance-spot-api-docs/rest-api/account-endpoints

- Binance Spot Account Trade List: `GET /api/v3/myTrades` 可以查询指定交易对的成交明细，返回 `price`、`qty`、`quoteQty`、`commission`、`time` 等字段，可用于普通现货交易的加权成本计算。
  - https://developers.binance.com/docs/binance-spot-api-docs/rest-api/account-endpoints

- Binance Auto-Invest endpoint: `GET /sapi/v1/lending/auto-invest/history/list` 用于查询定投 subscription transaction history。
  - https://binance.hexdocs.pm/Binance.AutoInvest.html
  - https://github.com/binance/binance-api-swagger/releases

- Binance Convert Trade History: 如果 Auto-Invest 记录最终落在 Convert 历史里，可能需要补查 `GET /sapi/v1/convert/tradeFlow`。
  - https://www.binance.com/en-JP/skills/detail/binance/convert
