# No Leverage Strategy Spec

## 1) Strategy Summary
- Strategy Name: No Leverage (0.0x)
- One-line Goal: 用户仅使用自有资金完成 `MON -> shMON -> Neverland supply`，给出 1 年预估收益。
- Target Users: 保守型用户、首次使用 NeverGuard 的用户、对清算风险敏感用户。

## 2) User Inputs
- Supported input amount units: `MON` / `USDC`
- Default input unit: `MON`
- Minimum input amount: `0`
- Maximum input amount: `1e12`（服务端硬限制，防止异常输入）
- Earnings display unit options: `MON` / `USDC`
- Default earnings unit: `MON`
- Neverland Supply APY input: `0 ~ 500`（百分比）

## 3) Live Data Sources
- shMON base APY source: DeFiLlama `yields.llama.fi/pools`（project=`shmonad`）
- shMON base APY refresh interval: 前端每 `10s` 轮询
- MON price source: `/api/price/featured`（后端聚合 CoinGecko/DexScreener）
- MON price refresh interval: 前端每 `10s` 轮询
- shMON/MON exchange-rate source: `/api/both`（链上合约）
- Exchange-rate refresh interval: 前端每 `10s` 轮询

## 4) Estimation Rules (1-Year)
- Compounding mode: `simple`（当前实现）
- Include fees/slippage: `no`（暂不计 gas、滑点、协议费）
- Strategy constraints/guards:
  - APY 小于 0 时按 0 处理
  - 价格不可用时不展示收益值
  - 输入金额为负值时按 0 处理

## 5) Output Metrics
- Estimated 1Y earnings (in selected unit)
- Estimated 1Y ending balance
- Effective APY（组合后 APY）
- Assumptions shown to user:
  - shMON APY
  - Neverland supply APY
  - MON USD 价格
  - 估算周期为 1 年、简单收益模型

## 6) Formula Notes
- Principal conversion rule:
  - 若输入单位为 `USDC`：`principalMon = amount / monPriceUsd`
  - 若输入单位为 `MON`：`principalMon = amount`
- Effective APY:
  - `combinedApy = ((1 + shmonApy/100) * (1 + supplyApy/100) - 1) * 100`
- Earnings formula:
  - `earningsMon = principalMon * (combinedApy / 100)`
  - `endingMon = principalMon + earningsMon`
- Unit conversion rule:
  - `earningsUsdc = earningsMon * monPriceUsd`
  - `endingUsdc = endingMon * monPriceUsd`
- Rounding rules:
  - APY: 2 位小数
  - MON: 4 位小数
  - USDC: 2 位小数

## 7) UI Behavior
- When data source fails: 显示 `--`，并给出 `Waiting for ...` 或 `API unavailable` 提示
- When APY unavailable: 不计算收益，仅显示占位
- When input invalid: 自动归零，不抛前端异常
- Loading state: 初始展示占位，拿到价格/APY后自动刷新

## 8) Copy/Text (UI)
- Card title: `No Leverage`
- Card subtitle: `Stake MON to shMON, then supply shMON to Neverland.`
- Primary label: `Estimated 1Y Earnings`
- Risk note: `Low risk, no liquidation path`

## 9) Acceptance Criteria
1. 输入 `MON/USDC` 后，收益可在 `MON/USDC` 两种结果单位间正确切换。
2. APY 变化后，组合 APY 与收益结果同步更新，且公式一致。
3. 数据源不可用时不显示错误计算值，只显示明确占位与提示文案。

## 10) Open Questions
- Q1: 是否要从 Neverland 实时接口获取 supply APY，替换手动输入？
- Q2: 估算模型是否升级为日复利（daily compounding）？
- Q3: 是否加入 gas/滑点/协议费扣减后的净收益版本？
