# NeverGuard 质押策略文档

## 项目概述

**目标**: 设计一个 DApp，实现 MON 的高效率质押

## 基础资产信息

### MON (Monad Token)
- **类型**: Monad 区块链原生代币
- **用途**: 质押、Gas 费、DeFi 交互
- **质押方式**: 通过 shMonad.xyz 进行液态质押

### shMonad (shMON)
- **开发者**: FastLane Labs
- **协议类型**: 液态质押协议 (LST)
- **标准**: ERC-4626
- **官网**: https://shmonad.xyz

### 合约信息
| 项目 | 值 |
|------|-----|
| **RPC** | https://rpc.monad.xyz |
| **shMON 合约** | 0x1b68626dca36c7fe922fd2d55e4f631d962de19c |
| **方法** | convertToAssets(uint256) |

### 实时汇率
| 方向 | 汇率 |
|------|------|
| **质押** | 1 MON → 0.6683 shMON |
| **赎回** | 1 shMON → 1.4963 MON |

---

## 质押策略

### 第一步：MON → shMON 质押

**流程**:
```
用户 MON → FastLane (shMonad.xyz) → 用户 shMON
```

**说明**:
- 用户将 MON 存入 FastLane 的 shMonad 协议
- 协议返回等值的 shMON (液态质押代币)
- shMON 代表用户的质押凭证，可以在 DeFi 中继续使用

**技术实现**:
- 调用 shMonad 合约的 `deposit()` 或 `stake()` 函数
- 用户授权 NeverGuard 使用其 MON
- NeverGuard 作为中介，替用户执行质押操作

**汇率**:
- 1 MON → 0.6683 shMON (实时汇率)

**收益**:
- **Staking APY**: 17.8%
- **FastLane Points**: 10x multiplier 可用

---

## 更新日志

| 时间 | 更新内容 |
|------|----------|
| 2025-02-01 | 初始文档，记录基础信息 |
