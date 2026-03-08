/**
 * NeverGuard - shMonad Exchange Rate Server
 * 从 Monad 链上获取 shMonad 实时汇率
 * 集成 CoinGecko API 获取主流 Token 价格
 * DeFi 策略收益预估系统
 */

const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== CoinGecko API 配置 ====================

const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';

// Clash 代理配置
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:7890';
const httpsAgent = new HttpsProxyAgent(PROXY_URL);

// 创建 axios 实例用于 CoinGecko API
const coingeckoApi = axios.create({
    httpsAgent,
    timeout: 15000,
    headers: {
        'User-Agent': 'NeverGuard/1.0'
    }
});

// ==================== Token 配置 ====================

// 加载 tokens.json 配置
let tokensConfig = { tokens: {}, strategies: [] };
try {
    const configPath = path.join(__dirname, 'tokens.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    tokensConfig = JSON.parse(configData);
    console.log(`✅ 已加载 Token 配置: ${Object.keys(tokensConfig.tokens).length} 个分类`);
} catch (error) {
    console.warn(`⚠️ 无法加载 tokens.json: ${error.message}`);
}

/**
 * 获取所有 Token 列表（扁平化）
 */
function getAllTokens() {
    const tokens = [];
    for (const [categoryKey, categoryData] of Object.entries(tokensConfig.tokens)) {
        for (const token of categoryData.tokens) {
            tokens.push({
                ...token,
                category: categoryKey,
                categoryDesc: categoryData.description
            });
        }
    }
    return tokens;
}

// 价格缓存 (避免频繁调用 API)
const priceCache = {
    store: new Map(),
    ttl: 30000 // 30秒缓存
};

/**
 * 从 CoinGecko 获取 Token 价格
 * @param {string} ids - Coin IDs, 逗号分隔, 如 'bitcoin,ethereum,monad'
 * @param {string} vsCurrencies - 计价货币, 默认 'usd'
 */
async function getCoinGeckoPrice(ids = 'bitcoin,ethereum,monad,tether,usd-coin', vsCurrencies = 'usd') {
    const cacheKey = `${ids}|${vsCurrencies}`;
    try {
        // 检查缓存
        const now = Date.now();
        const cached = priceCache.store.get(cacheKey);
        if (cached && (now - cached.timestamp) < priceCache.ttl) {
            console.log('📦 使用缓存的价格数据');
            return { success: true, data: cached.data, cached: true };
        }

        const response = await coingeckoApi.get(`${COINGECKO_API_BASE}/simple/price`, {
            params: {
                ids,
                vs_currencies: vsCurrencies,
                include_market_cap: true,
                include_24hr_vol: true,
                include_24hr_change: true
            }
        });

        // 更新缓存
        priceCache.store.set(cacheKey, {
            data: response.data,
            timestamp: now
        });

        return { success: true, data: response.data, cached: false };
    } catch (error) {
        console.error(`❌ CoinGecko API 错误: ${error.message}`);
        // 如果有缓存，即使过期也返回
        const stale = priceCache.store.get(cacheKey);
        if (stale?.data) {
            console.log('📦 使用过期的缓存数据');
            return { success: true, data: stale.data, cached: true, error: error.message };
        }
        return { success: false, error: error.message };
    }
}

/**
 * 获取 BTC/ETH 价格 (最常用)
 */
async function getBtcEthPrice() {
    const result = await getCoinGeckoPrice('bitcoin,ethereum', 'usd');
    if (result.success && result.data) {
        return {
            btc: {
                usd: result.data.bitcoin?.usd || 0,
                cny: result.data.bitcoin?.cny || 0,
                change24h: result.data.bitcoin?.usd_24h_change || 0,
                marketCap: result.data.bitcoin?.usd_market_cap || 0
            },
            eth: {
                usd: result.data.ethereum?.usd || 0,
                cny: result.data.ethereum?.cny || 0,
                change24h: result.data.ethereum?.usd_24h_change || 0,
                marketCap: result.data.ethereum?.usd_market_cap || 0
            }
        };
    }
    return null;
}

/**
 * 从 CoinGecko 获取 markets 数据（包含 icon）
 * @param {string[]} idsList - CoinGecko ids
 * @param {string} vsCurrency - 计价货币
 */
async function getCoinGeckoMarkets(idsList = ['bitcoin', 'monad'], vsCurrency = 'usd') {
    try {
        const response = await coingeckoApi.get(`${COINGECKO_API_BASE}/coins/markets`, {
            params: {
                vs_currency: vsCurrency,
                ids: idsList.join(','),
                sparkline: false
            }
        });
        return { success: true, data: response.data || [] };
    } catch (error) {
        console.error(`❌ CoinGecko markets API 错误: ${error.message}`);
        return { success: false, error: error.message };
    }
}

function withTimeout(promise, ms, fallbackValue) {
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))
    ]);
}

/**
 * 从 DexScreener 通过代币合约地址获取价格
 * @param {string} tokenAddress - 代币合约地址
 */
async function getDexScreenerPriceByTokenAddress(tokenAddress) {
    try {
        const normalizedAddress = tokenAddress.toLowerCase();
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${normalizedAddress}`, {
            httpsAgent,
            timeout: 15000,
            headers: {
                'User-Agent': 'NeverGuard/1.0'
            }
        });

        const pairs = response?.data?.pairs || [];
        const matchedPairs = pairs.filter((pair) =>
            pair?.baseToken?.address?.toLowerCase() === normalizedAddress ||
            pair?.quoteToken?.address?.toLowerCase() === normalizedAddress
        );
        const target = matchedPairs.sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0))[0];

        if (!target) {
            return { success: false, error: `No DexScreener pair found for token ${normalizedAddress}` };
        }

        const baseIsTarget = target?.baseToken?.address?.toLowerCase() === normalizedAddress;
        const targetSymbol = baseIsTarget ? target?.baseToken?.symbol : target?.quoteToken?.symbol;
        const targetName = baseIsTarget ? target?.baseToken?.name : target?.quoteToken?.name;

        return {
            success: true,
            data: {
                address: normalizedAddress,
                symbol: targetSymbol || null,
                name: targetName || null,
                price: target?.priceUsd ? Number(target.priceUsd) : null,
                change24h: target?.priceChange?.h24 ?? null,
                marketCap: target?.marketCap || target?.fdv || null,
                volume24h: target?.volume?.h24 || null,
                liquidity: target?.liquidity?.usd || null,
                pairAddress: target?.pairAddress || null,
                chainId: target?.chainId || null,
                dexId: target?.dexId || null,
                iconUrl:
                    target?.info?.imageUrl ||
                    target?.baseToken?.icon ||
                    target?.quoteToken?.icon ||
                    null
            }
        };
    } catch (error) {
        console.error(`❌ DexScreener API 错误 (${tokenAddress}): ${error.message}`);
        return { success: false, error: error.message };
    }
}

// ==================== 配置 ====================

// Monad RPC 节点
const MONAD_RPC = "https://rpc.monad.xyz";

// shMonad 合约地址
const SHMONAD_ADDRESS = "0x1b68626dca36c7fe922fd2d55e4f631d962de19c";
const DUST_TOKEN_ADDRESS = "0xad96c3dffcd6374294e2573a7fbba96097cc8d7c";
const NSHMON_ADDRESS = "0x38648958836eA88b368b4ac23b86Ad44B0fe7508";
const NEVERLAND_POOL_ADDRESSES_PROVIDER = "0x49D75170F55C964dfdd6726c74fdEDEe75553A0f";
const NEVERLAND_UI_POOL_DATA_PROVIDER = "0x0733e79171dd5A5E8aF41E387c6299bCfE6a7e55";
const NEVERLAND_REWARDS_CONTROLLER = "0x57ea245cCbFAb074baBb9d01d1F0c60525E52cec";
const SHMON_ICON_URL = "https://shmonad.xyz/favicon.ico";
const BTC_ICON_URL = "https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400";
const MON_ICON_URL = "https://coin-images.coingecko.com/coins/images/38927/large/mon.png?1766029057";

const featuredPriceCache = {
    data: null,
    timestamp: 0,
    ttl: 30000
};

const exchangeRateLastKnown = {
    rate: '1.0',
    method: 'default',
    timestamp: 0
};

const neverlandSupplyApyCache = {
    data: null,
    timestamp: 0,
    ttl: 30000
};

// shMonad 合约 ABI (极简版，只包含需要的函数)
const SHMONAD_ABI = [
    // ERC-4626 标准函数
    "function totalAssets() external view returns (uint256)",
    "function totalSupply() external view returns (uint256)",
    "function convertToAssets(uint256 shares) external view returns (uint256)",
    "function convertToShares(uint256 assets) external view returns (uint256)",
    // 自定义函数
    "function getExchangeRate() external view returns (uint256)",
    // ERC20 函数
    "function name() external view returns (string)",
    "function symbol() external view returns (string)",
    "function decimals() external view returns (uint8)"
];

const ERC20_METADATA_ABI = [
    "function totalSupply() external view returns (uint256)",
    "function decimals() external view returns (uint8)"
];

const NEVERLAND_REWARDS_CONTROLLER_ABI = [
    "function getRewardsData(address asset, address reward) external view returns (uint256,uint256,uint256,uint256)"
];

const NEVERLAND_UI_POOL_DATA_PROVIDER_ABI = [
    "function getReservesData(address provider) external view returns ((address underlyingAsset,string name,string symbol,uint256 decimals,uint256 baseLTVasCollateral,uint256 reserveLiquidationThreshold,uint256 reserveLiquidationBonus,uint256 reserveFactor,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen,uint128 liquidityIndex,uint128 variableBorrowIndex,uint128 liquidityRate,uint128 variableBorrowRate,uint128 stableBorrowRate,uint40 lastUpdateTimestamp,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint256 availableLiquidity,uint256 totalPrincipalStableDebt,uint256 averageStableRate,uint256 stableDebtLastUpdateTimestamp,uint256 totalScaledVariableDebt,uint256 priceInMarketReferenceCurrency,address priceOracle,uint256 variableRateSlope1,uint256 variableRateSlope2,uint256 stableRateSlope1,uint256 stableRateSlope2,uint256 baseStableBorrowRate,uint256 baseVariableBorrowRate,uint256 optimalUsageRatio,bool isPaused,bool isSiloedBorrowing,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)[],(uint256,uint256,int256,int256,uint8))"
];

// ==================== 初始化 ====================

let provider;
let shmonadContract;
let neverlandRewardsContract;
let neverlandUiPoolDataProvider;
let nshmonContract;

function initContract() {
    try {
        provider = new ethers.JsonRpcProvider(MONAD_RPC);
        shmonadContract = new ethers.Contract(SHMONAD_ADDRESS, SHMONAD_ABI, provider);
        neverlandRewardsContract = new ethers.Contract(
            NEVERLAND_REWARDS_CONTROLLER,
            NEVERLAND_REWARDS_CONTROLLER_ABI,
            provider
        );
        neverlandUiPoolDataProvider = new ethers.Contract(
            NEVERLAND_UI_POOL_DATA_PROVIDER,
            NEVERLAND_UI_POOL_DATA_PROVIDER_ABI,
            provider
        );
        nshmonContract = new ethers.Contract(NSHMON_ADDRESS, ERC20_METADATA_ABI, provider);
        console.log(`✅ Connected to Monad RPC: ${MONAD_RPC}`);
        console.log(`✅ shMonad Contract: ${SHMONAD_ADDRESS}`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to initialize contract:`, error.message);
        return false;
    }
}

// ==================== 核心函数 ====================

/**
 * 获取实时汇率 (1 shMON = ? MON)
 * 优先级: getExchangeRate() > convertToAssets(1e18) > totalAssets/totalSupply
 */
async function getExchangeRate() {
    try {
        // 方法 1: 尝试调用 getExchangeRate()
        try {
            const rate = await shmonadContract.getExchangeRate();
            const rateFormatted = ethers.formatUnits(rate, 18);
            console.log(`📊 Method 1 - getExchangeRate(): ${rateFormatted}`);
            return {
                rate: rateFormatted,
                method: 'getExchangeRate',
                timestamp: Date.now()
            };
        } catch (e) {
            console.log(`⚠️ getExchangeRate() not available: ${e.message.substring(0, 50)}...`);
        }

        // 方法 2: 使用 convertToAssets(1 shMON)
        try {
            const oneShare = ethers.parseUnits("1", 18);
            const assets = await shmonadContract.convertToAssets(oneShare);
            const rateFormatted = ethers.formatUnits(assets, 18);
            console.log(`📊 Method 2 - convertToAssets(1): ${rateFormatted}`);
            return {
                rate: rateFormatted,
                method: 'convertToAssets',
                timestamp: Date.now()
            };
        } catch (e) {
            console.log(`⚠️ convertToAssets() not available: ${e.message.substring(0, 50)}...`);
        }

        // 方法 3: 计算 totalAssets / totalSupply
        try {
            const [totalAssets, totalSupply] = await Promise.all([
                shmonadContract.totalAssets(),
                shmonadContract.totalSupply()
            ]);

            const assetsBigInt = BigInt(totalAssets);
            const supplyBigInt = BigInt(totalSupply);

            if (supplyBigInt > 0n) {
                // 计算汇率: totalAssets / totalSupply * 1e18
                const rate = (assetsBigInt * 1000000000000000000n) / supplyBigInt;
                const rateFormatted = Number(rate) / 1e18;
                console.log(`📊 Method 3 - totalAssets/totalSupply: ${rateFormatted}`);
                return {
                    rate: rateFormatted.toString(),
                    method: 'totalAssets_div_totalSupply',
                    timestamp: Date.now()
                };
            }
        } catch (e) {
            console.log(`⚠️ totalAssets/totalSupply failed: ${e.message.substring(0, 50)}...`);
        }

        // 所有方法都失败，返回默认值
        console.warn(`⚠️ All methods failed, returning default rate`);
        return {
            rate: "1.0",
            method: 'default',
            timestamp: Date.now()
        };

    } catch (error) {
        console.error(`❌ Error getting exchange rate:`, error.message);
        return {
            rate: "1.0",
            method: 'error',
            error: error.message,
            timestamp: Date.now()
        };
    }
}

/**
 * 获取质押率 (1 MON = ? shMON)
 * 这是 getExchangeRate() 的倒数
 */
async function getStakingRate() {
    const data = await getExchangeRate();
    const rate = parseFloat(data.rate);
    const stakingRate = rate > 0 ? (1 / rate) : 1.0;
    return {
        rate: stakingRate.toString(),
        method: data.method + '_inverted',
        timestamp: data.timestamp
    };
}

const STRATEGY_PROFILES = {
    no_leverage: {
        id: 'no_leverage',
        name: 'No Leverage',
        leverage: 1.0,
        borrowApy: 0,
        riskReserveBps: 0,
        risk: 'low'
    },
    leverage_1_5x: {
        id: 'leverage_1_5x',
        name: 'Leverage 1.5x',
        leverage: 1.5,
        borrowApy: 8.0,
        riskReserveBps: 40,
        risk: 'medium'
    },
    leverage_1_8x: {
        id: 'leverage_1_8x',
        name: 'Leverage 1.8x',
        leverage: 1.8,
        borrowApy: 11.0,
        riskReserveBps: 80,
        risk: 'high'
    }
};

function safeNumber(value, fallback = 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed;
}

function clampNumber(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function round(value, decimals = 6) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

async function getNeverlandShmonSupplyApy() {
    const now = Date.now();
    if (neverlandSupplyApyCache.data && (now - neverlandSupplyApyCache.timestamp) < neverlandSupplyApyCache.ttl) {
        return neverlandSupplyApyCache.data;
    }

    const [reserveResult, rewardsData, nshmonDecimals, nshmonSupplyRaw, dustPriceResult] = await Promise.all([
        neverlandUiPoolDataProvider.getReservesData(NEVERLAND_POOL_ADDRESSES_PROVIDER),
        neverlandRewardsContract.getRewardsData(NSHMON_ADDRESS, DUST_TOKEN_ADDRESS),
        nshmonContract.decimals(),
        nshmonContract.totalSupply(),
        getDexScreenerPriceByTokenAddress(DUST_TOKEN_ADDRESS)
    ]);

    const [reserves, baseCurrencyInfo] = reserveResult;
    const shmonReserve = reserves.find((reserve) =>
        reserve.underlyingAsset?.toLowerCase() === SHMONAD_ADDRESS.toLowerCase()
    );

    if (!shmonReserve) {
        throw new Error('shMON reserve not found in Neverland');
    }

    const marketReferenceCurrencyUnit = safeNumber(baseCurrencyInfo?.[0]?.toString(), 0);
    const marketReferenceCurrencyPriceInUsd = safeNumber(baseCurrencyInfo?.[1]?.toString(), 0) / 1e8;
    const shmonPriceInReference = safeNumber(shmonReserve.priceInMarketReferenceCurrency?.toString(), 0);
    const shmonPriceUsd = marketReferenceCurrencyUnit > 0
        ? (shmonPriceInReference / marketReferenceCurrencyUnit) * marketReferenceCurrencyPriceInUsd
        : 0;

    const baseSupplyApyPct = safeNumber(ethers.formatUnits(shmonReserve.liquidityRate || 0, 25), 0);
    const emissionPerSecond = safeNumber(ethers.formatUnits(rewardsData?.[1] || 0, 18), 0);
    const distributionEnd = safeNumber(rewardsData?.[3]?.toString(), 0);
    const dustPriceUsd = safeNumber(dustPriceResult?.data?.price, 0);
    const nshmonSupply = safeNumber(ethers.formatUnits(nshmonSupplyRaw || 0, Number(nshmonDecimals || 18)), 0);

    let incentiveApyPct = 0;
    if (distributionEnd > Math.floor(now / 1000) && emissionPerSecond > 0 && dustPriceUsd > 0 && nshmonSupply > 0 && shmonPriceUsd > 0) {
        const annualRewardsUsd = emissionPerSecond * 31536000 * dustPriceUsd;
        const totalSuppliedUsd = nshmonSupply * shmonPriceUsd;
        incentiveApyPct = totalSuppliedUsd > 0 ? (annualRewardsUsd / totalSuppliedUsd) * 100 : 0;
    }

    const result = {
        totalApyPct: round(baseSupplyApyPct + incentiveApyPct, 4),
        baseSupplyApyPct: round(baseSupplyApyPct, 4),
        dustIncentiveApyPct: round(incentiveApyPct, 4),
        emissionPerSecond: round(emissionPerSecond, 8),
        distributionEnd,
        nshmonSupply: round(nshmonSupply, 4),
        shmonPriceUsd: round(shmonPriceUsd, 6),
        dustPriceUsd: round(dustPriceUsd, 6),
        source: {
            reserveProvider: NEVERLAND_UI_POOL_DATA_PROVIDER,
            rewardsController: NEVERLAND_REWARDS_CONTROLLER,
            rewardToken: DUST_TOKEN_ADDRESS,
            asset: NSHMON_ADDRESS
        }
    };

    neverlandSupplyApyCache.data = result;
    neverlandSupplyApyCache.timestamp = now;
    return result;
}

function calculateSingleStrategyQuote({
    principalMon,
    monPriceUsd,
    shmonToMon,
    principalGrowthApyPct,
    resultUnit,
    profile,
    rewardContext = null
}) {
    const leveragedExposureMon = principalMon * profile.leverage;
    const grossEarningsMon = leveragedExposureMon * (principalGrowthApyPct / 100);
    const borrowedPrincipalMon = principalMon * Math.max(profile.leverage - 1, 0);
    const borrowCostMon = borrowedPrincipalMon * (profile.borrowApy / 100);
    const riskReserveMon = borrowedPrincipalMon * (profile.riskReserveBps / 10000);
    const netEarningsMon = grossEarningsMon - borrowCostMon - riskReserveMon;
    const endingMon = principalMon + netEarningsMon;
    const netApyPct = principalMon > 0 ? (netEarningsMon / principalMon) * 100 : 0;

    const earningsInResultUnit = resultUnit === 'USDC'
        ? netEarningsMon * monPriceUsd
        : netEarningsMon;
    const endingInResultUnit = resultUnit === 'USDC'
        ? endingMon * monPriceUsd
        : endingMon;

    let rewards = null;
    if (rewardContext && shmonToMon > 0 && rewardContext.nshmonSupply > 0) {
        const suppliedShmon = leveragedExposureMon / shmonToMon;
        const annualDustRewards = (suppliedShmon / rewardContext.nshmonSupply)
            * rewardContext.emissionPerSecond
            * rewardContext.annualRewardSeconds;
        const annualDustRewardsUsd = annualDustRewards * rewardContext.dustPriceUsd;

        rewards = {
            dust: {
                estimatedAmount: round(annualDustRewards, 6),
                estimatedUsd: round(annualDustRewardsUsd, 4),
                priceUsd: round(rewardContext.dustPriceUsd, 6),
                annualRewardSeconds: rewardContext.annualRewardSeconds
            },
            note: 'DUST rewards are separate from MON/shMON ending balance. veDUST / USDC boost not included.'
        };
    }

    return {
        id: profile.id,
        name: profile.name,
        risk: profile.risk,
        leverage: profile.leverage,
        assumptions: {
            borrowApyPct: profile.borrowApy,
            riskReserveBps: profile.riskReserveBps
        },
        grossApyPct: round(principalGrowthApyPct * profile.leverage, 4),
        netApyPct: round(netApyPct, 4),
        pnl: {
            principalMon: round(principalMon, 6),
            grossEarningsMon: round(grossEarningsMon, 6),
            borrowCostMon: round(borrowCostMon, 6),
            riskReserveMon: round(riskReserveMon, 6),
            netEarningsMon: round(netEarningsMon, 6),
            endingMon: round(endingMon, 6)
        },
        display: {
            resultUnit,
            earnings: round(earningsInResultUnit, 4),
            endingBalance: round(endingInResultUnit, 4)
        },
        rewards
    };
}

// ==================== API 路由 ====================

/**
 * GET /api/rate
 * 获取汇率 (1 shMON = ? MON)
 */
app.get('/api/rate', async (req, res) => {
    const data = await getExchangeRate();
    res.json({
        success: data.method !== 'error',
        data: {
            exchangeRate: data.rate,  // 1 shMON = ? MON
            method: data.method,
            timestamp: data.timestamp
        }
    });
});

/**
 * GET /api/staking-rate
 * 获取质押率 (1 MON = ? shMON)
 */
app.get('/api/staking-rate', async (req, res) => {
    const data = await getStakingRate();
    res.json({
        success: data.method !== 'error',
        data: {
            stakingRate: data.rate,  // 1 MON = ? shMON
            method: data.method,
            timestamp: data.timestamp
        }
    });
});

/**
 * GET /api/both
 * 获取两个方向的汇率
 */
app.get('/api/both', async (req, res) => {
    const exchangeData = await getExchangeRate();
    const rate = parseFloat(exchangeData.rate);

    res.json({
        success: exchangeData.method !== 'error',
        data: {
            // 赎回: 1 shMON = ? MON
            shmonToMon: exchangeData.rate,
            // 质押: 1 MON = ? shMON
            monToShmon: rate > 0 ? (1 / rate).toFixed(18) : "1.0",
            method: exchangeData.method,
            timestamp: exchangeData.timestamp
        }
    });
});

/**
 * GET /api/health
 * 健康检查
 */
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        rpc: MONAD_RPC,
        contract: SHMONAD_ADDRESS,
        timestamp: Date.now()
    });
});

/**
 * GET /api/contract-info
 * 获取合约基本信息
 */
app.get('/api/contract-info', async (req, res) => {
    try {
        const [name, symbol, decimals, totalSupply] = await Promise.all([
            shmonadContract.name().catch(() => "shMonad"),
            shmonadContract.symbol().catch(() => "shMON"),
            shmonadContract.decimals().catch(() => 18),
            shmonadContract.totalSupply().catch(() => 0n)
        ]);

        res.json({
            success: true,
            data: {
                address: SHMONAD_ADDRESS,
                name,
                symbol,
                decimals: Number(decimals),
                totalSupply: ethers.formatUnits(totalSupply, Number(decimals)),
                rpc: MONAD_RPC
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== 价格 API 端点 ====================

/**
 * GET /api/price
 * 获取指定 Token 价格
 * Query params: ids (comma-separated), vs_currencies (default: usd)
 * Example: /api/price?ids=bitcoin,ethereum&vs_currencies=usd
 */
app.get('/api/price', async (req, res) => {
    const { ids, vs_currencies = 'usd' } = req.query;
    const defaultIds = 'bitcoin,ethereum,monad,tether,usd-coin';

    const result = await getCoinGeckoPrice(ids || defaultIds, vs_currencies);

    if (result.success) {
        res.json({
            success: true,
            data: result.data,
            cached: result.cached || false,
            timestamp: Date.now()
        });
    } else {
        res.status(500).json({
            success: false,
            error: result.error
        });
    }
});

/**
 * GET /api/price/btc-eth
 * 获取 BTC/ETH 价格 (常用)
 */
app.get('/api/price/btc-eth', async (req, res) => {
    const prices = await getBtcEthPrice();

    if (prices) {
        res.json({
            success: true,
            data: prices,
            timestamp: Date.now()
        });
    } else {
        res.status(500).json({
            success: false,
            error: 'Failed to fetch prices'
        });
    }
});

/**
 * GET /api/price/monad
 * 获取 Monad Token 价格
 */
app.get('/api/price/monad', async (req, res) => {
    const result = await getCoinGeckoPrice('monad', 'usd');

    if (result.success && result.data && result.data.monad) {
        res.json({
            success: true,
            data: {
                symbol: 'MON',
                name: 'Monad',
                price: result.data.monad.usd,
                marketCap: result.data.monad.usd_market_cap,
                volume24h: result.data.monad.usd_24h_vol,
                change24h: result.data.monad.usd_24h_change
            },
            timestamp: Date.now()
        });
    } else {
        res.status(500).json({
            success: false,
            error: 'Failed to fetch Monad price'
        });
    }
});

/**
 * GET /api/price/stables
 * 获取稳定币价格 (USDT, USDC, DAI)
 */
app.get('/api/price/stables', async (req, res) => {
    const result = await getCoinGeckoPrice('tether,usd-coin,dai', 'usd');

    if (result.success) {
        const stables = {};
        for (const [key, value] of Object.entries(result.data)) {
            stables[key] = {
                price: value.usd,
                marketCap: value.usd_market_cap,
                volume24h: value.usd_24h_vol
            };
        }

        res.json({
            success: true,
            data: stables,
            timestamp: Date.now()
        });
    } else {
        res.status(500).json({
            success: false,
            error: result.error
        });
    }
});

/**
 * GET /api/price/featured
 * 获取 Token Prices MVP 固定展示的 4 个币种价格:
 * BTC / MON / DUST / shMON
 */
app.get('/api/price/featured', async (req, res) => {
    try {
        const now = Date.now();
        if (featuredPriceCache.data && (now - featuredPriceCache.timestamp) < featuredPriceCache.ttl) {
            return res.json({
                success: true,
                data: featuredPriceCache.data,
                cached: true,
                timestamp: now
            });
        }

        const [coingeckoResult, exchangeDataFast, dustResult] = await Promise.all([
            withTimeout(
                getCoinGeckoPrice('bitcoin,monad', 'usd'),
                2500,
                { success: false, error: 'CoinGecko simple price timeout' }
            ),
            withTimeout(getExchangeRate(), 1500, null),
            withTimeout(
                getDexScreenerPriceByTokenAddress(DUST_TOKEN_ADDRESS),
                2500,
                { success: false, error: 'DexScreener timeout' }
            )
        ]);

        const btc = coingeckoResult?.data?.bitcoin || {};
        const mon = coingeckoResult?.data?.monad || {};

        // 优先用最新链上汇率，超时则回退最近成功值
        if (exchangeDataFast?.rate) {
            exchangeRateLastKnown.rate = exchangeDataFast.rate;
            exchangeRateLastKnown.method = exchangeDataFast.method || 'unknown';
            exchangeRateLastKnown.timestamp = exchangeDataFast.timestamp || now;
        }
        const exchangeData = exchangeDataFast || exchangeRateLastKnown;

        // 1 shMON = exchangeRate MON -> shMON(USD) = MON(USD) * exchangeRate
        const exchangeRate = parseFloat(exchangeData?.rate || '0');
        const shMonPrice = mon.usd && exchangeRate > 0 ? mon.usd * exchangeRate : null;

        const tokens = [
            {
                id: 'bitcoin',
                symbol: 'BTC',
                name: 'Bitcoin',
                price: btc.usd ?? null,
                marketCap: btc.usd_market_cap ?? null,
                volume24h: btc.usd_24h_vol ?? null,
                change24h: btc.usd_24h_change ?? null,
                priceAvailable: !!btc.usd,
                source: 'coingecko',
                iconUrl: BTC_ICON_URL
            },
            {
                id: 'monad',
                symbol: 'MON',
                name: 'Monad',
                price: mon.usd ?? null,
                marketCap: mon.usd_market_cap ?? null,
                volume24h: mon.usd_24h_vol ?? null,
                change24h: mon.usd_24h_change ?? null,
                priceAvailable: !!mon.usd,
                source: 'coingecko',
                iconUrl: MON_ICON_URL
            },
            {
                id: 'dust',
                symbol: 'DUST',
                name: 'DUST',
                price: dustResult?.data?.price ?? null,
                marketCap: dustResult?.data?.marketCap ?? null,
                volume24h: dustResult?.data?.volume24h ?? null,
                change24h: dustResult?.data?.change24h ?? null,
                priceAvailable: dustResult?.success && dustResult?.data?.price != null,
                source: dustResult?.success ? `dexscreener:${dustResult?.data?.dexId || 'unknown'}` : 'dexscreener',
                tokenAddress: DUST_TOKEN_ADDRESS,
                iconUrl: dustResult?.data?.iconUrl || null
            },
            {
                id: 'shmonad',
                symbol: 'shMON',
                name: 'shMonad',
                price: shMonPrice,
                marketCap: mon.usd_market_cap ?? null,
                volume24h: mon.usd_24h_vol ?? null,
                change24h: mon.usd_24h_change ?? null,
                priceAvailable: shMonPrice != null,
                source: `monad_exchange_rate:${exchangeData?.method || 'unknown'}`,
                iconUrl: SHMON_ICON_URL
            }
        ];

        const payload = {
            tokens,
            exchangeRate: exchangeData?.rate || null,
            exchangeRateMethod: exchangeData?.method || null
        };
        featuredPriceCache.data = payload;
        featuredPriceCache.timestamp = now;

        res.json({
            success: true,
            data: payload,
            partial:
                !coingeckoResult?.success ||
                !dustResult?.success ||
                !exchangeDataFast,
            cached: false,
            timestamp: now
        });
    } catch (error) {
        console.error('Featured price API error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== Token 分页 API ====================

/**
 * GET /api/tokens
 * 分页获取 Token 列表和价格
 * Query params:
 *   - page: 页码 (默认 1)
 *   - limit: 每页数量 (默认 12)
 *   - category: 分类过滤 (可选)
 *   - search: 搜索关键词 (可选)
 */
app.get('/api/tokens', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 12;
        const category = req.query.category;
        const search = req.query?.search?.toLowerCase();

        // 获取所有 Token
        let allTokens = getAllTokens();

        // 按分类过滤
        if (category && category !== 'all') {
            allTokens = allTokens.filter(t => t.category === category);
        }

        // 搜索过滤
        if (search) {
            allTokens = allTokens.filter(t =>
                t.symbol.toLowerCase().includes(search) ||
                t.name.toLowerCase().includes(search) ||
                t.id.toLowerCase().includes(search)
            );
        }

        // 分页
        const total = allTokens.length;
        const totalPages = Math.ceil(total / limit);
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const paginatedTokens = allTokens.slice(startIndex, endIndex);

        // 获取这些 Token 的价格
        const coingeckoIds = paginatedTokens.map(t => t.coingeckoId).join(',');
        const priceResult = await getCoinGeckoPrice(coingeckoIds, 'usd');

        // 合并价格数据
        const tokensWithPrices = paginatedTokens.map(token => {
            const priceData = priceResult.success ? priceResult.data[token.coingeckoId] : null;
            return {
                id: token.id,
                symbol: token.symbol,
                name: token.name,
                category: token.category,
                categoryDesc: token.categoryDesc,
                type: token.type,
                underlying: token.underlying || null,
                // 价格数据
                price: priceData?.usd || null,
                marketCap: priceData?.usd_market_cap || null,
                volume24h: priceData?.usd_24h_vol || null,
                change24h: priceData?.usd_24h_change || null,
                priceAvailable: !!priceData?.usd
            };
        });

        // 获取所有分类
        const categories = Object.entries(tokensConfig.tokens).map(([key, value]) => ({
            key,
            name: value.description,
            count: value.tokens.length
        }));

        res.json({
            success: true,
            data: {
                tokens: tokensWithPrices,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages,
                    hasNext: page < totalPages,
                    hasPrev: page > 1
                },
                categories,
                priceCached: priceResult.cached || false
            },
            timestamp: Date.now()
        });

    } catch (error) {
        console.error('Token API error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/tokens/categories
 * 获取所有 Token 分类
 */
app.get('/api/tokens/categories', (req, res) => {
    const categories = Object.entries(tokensConfig.tokens).map(([key, value]) => ({
        key,
        name: value.description,
        count: value.tokens.length
    }));

    res.json({
        success: true,
        data: categories
    });
});

/**
 * GET /api/tokens/strategies
 * 获取 DeFi 策略类型
 */
app.get('/api/tokens/strategies', (req, res) => {
    res.json({
        success: true,
        data: tokensConfig.strategies || []
    });
});

/**
 * GET /api/strategy/staking/quote
 * 获取质押策略报价（0x / 1.5x / 1.8x）
 *
 * Query params:
 *   - amount: 输入金额（默认 10000）
 *   - inputUnit: MON | USDC（默认 MON）
 *   - resultUnit: MON | USDC（默认 MON）
 *   - baseApy: shMON 基础 APY（百分比，默认 0）
 *   - supplyApy: override Neverland same-asset supply APY（百分比，可选）
 *   - borrowApy15: 1.5x 借款 APY（可选，覆盖默认值）
 *   - borrowApy18: 1.8x 借款 APY（可选，覆盖默认值）
 */
app.get('/api/strategy/staking/quote', async (req, res) => {
    try {
        const amount = clampNumber(safeNumber(req.query.amount, 10000), 0, 1e12);
        const inputUnit = String(req.query.inputUnit || 'MON').toUpperCase() === 'USDC' ? 'USDC' : 'MON';
        const resultUnit = String(req.query.resultUnit || 'MON').toUpperCase() === 'USDC' ? 'USDC' : 'MON';
        const baseApyPct = clampNumber(safeNumber(req.query.baseApy, 0), 0, 500);

        const monPriceResult = await getCoinGeckoPrice('monad', 'usd');
        const monPriceFromApi = monPriceResult?.data?.monad?.usd;
        const monPriceUsd = clampNumber(
            safeNumber(req.query.monPriceUsd, safeNumber(monPriceFromApi, 0)),
            0,
            1e7
        );

        if (monPriceUsd <= 0) {
            return res.status(503).json({
                success: false,
                error: 'MON price unavailable',
                hint: 'Pass monPriceUsd query or ensure /api/price/featured works'
            });
        }

        const principalMon = inputUnit === 'USDC'
            ? amount / monPriceUsd
            : amount;

        let neverlandSupply = null;
        let sameAssetSupplyApyPct = 0;
        let dustIncentiveApyPct = 0;
        const supplyApyOverride = req.query.supplyApy;
        if (supplyApyOverride != null) {
            sameAssetSupplyApyPct = clampNumber(safeNumber(supplyApyOverride, 0), 0, 500);
        } else {
            try {
                neverlandSupply = await getNeverlandShmonSupplyApy();
                sameAssetSupplyApyPct = clampNumber(safeNumber(neverlandSupply?.baseSupplyApyPct, 0), 0, 500);
                dustIncentiveApyPct = clampNumber(safeNumber(neverlandSupply?.dustIncentiveApyPct, 0), 0, 500);
            } catch (error) {
                console.warn(`⚠️ Neverland supply APY unavailable: ${error.message}`);
            }
        }

        const principalGrowthApyPct = ((1 + (baseApyPct / 100)) * (1 + (sameAssetSupplyApyPct / 100)) - 1) * 100;
        const exchangeRateData = await getExchangeRate();
        const shmonToMon = clampNumber(safeNumber(exchangeRateData.rate, 0), 0, 1e12);
        const annualRewardSeconds = neverlandSupply
            ? Math.min(Math.max(neverlandSupply.distributionEnd - Math.floor(Date.now() / 1000), 0), 31536000)
            : 0;
        const rewardContext = neverlandSupply
            ? {
                nshmonSupply: neverlandSupply.nshmonSupply,
                emissionPerSecond: neverlandSupply.emissionPerSecond,
                dustPriceUsd: neverlandSupply.dustPriceUsd,
                annualRewardSeconds
            }
            : null;

        const profile15 = {
            ...STRATEGY_PROFILES.leverage_1_5x,
            borrowApy: clampNumber(
                safeNumber(req.query.borrowApy15, STRATEGY_PROFILES.leverage_1_5x.borrowApy),
                0,
                500
            )
        };
        const profile18 = {
            ...STRATEGY_PROFILES.leverage_1_8x,
            borrowApy: clampNumber(
                safeNumber(req.query.borrowApy18, STRATEGY_PROFILES.leverage_1_8x.borrowApy),
                0,
                500
            )
        };

        const strategies = {
            no_leverage: calculateSingleStrategyQuote({
                principalMon,
                monPriceUsd,
                shmonToMon,
                principalGrowthApyPct,
                resultUnit,
                profile: STRATEGY_PROFILES.no_leverage,
                rewardContext
            }),
            leverage_1_5x: calculateSingleStrategyQuote({
                principalMon,
                monPriceUsd,
                shmonToMon,
                principalGrowthApyPct,
                resultUnit,
                profile: profile15,
                rewardContext
            }),
            leverage_1_8x: calculateSingleStrategyQuote({
                principalMon,
                monPriceUsd,
                shmonToMon,
                principalGrowthApyPct,
                resultUnit,
                profile: profile18,
                rewardContext
            })
        };

        res.json({
            success: true,
            data: {
                input: {
                    amount: round(amount, 6),
                    inputUnit,
                    resultUnit,
                    principalMon: round(principalMon, 6)
                },
                market: {
                    monPriceUsd: round(monPriceUsd, 6),
                    baseApyPct: round(baseApyPct, 4),
                    sameAssetSupplyApyPct: round(sameAssetSupplyApyPct, 4),
                    dustIncentiveApyPct: round(dustIncentiveApyPct, 4),
                    principalGrowthApyPct: round(principalGrowthApyPct, 4),
                    shmonToMon: round(shmonToMon, 6),
                    neverlandSupply: neverlandSupply
                        ? {
                            ...neverlandSupply,
                            annualRewardSeconds
                        }
                        : null
                },
                strategies
            },
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('Strategy quote API error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== 启动服务器 ====================

app.listen(PORT, async () => {
    console.log('=================================');
    console.log('🚀 NeverGuard Server');
    console.log('=================================');
    console.log(`📡 Server running on http://localhost:${PORT}`);

    // 初始化合约连接
    if (initContract()) {
        // 测试获取一次汇率
        console.log('\n📊 Testing exchange rate fetch...');
        const rateData = await getExchangeRate();
        console.log(`✅ Exchange Rate (1 shMON = ? MON): ${rateData.rate}`);
        console.log(`   Method: ${rateData.method}\n`);
    }

    console.log('=================================');
    console.log('📡 API Endpoints:');
    console.log('   shMonad Exchange Rate:');
    console.log(`   GET  /api/rate          - 1 shMON = ? MON`);
    console.log(`   GET  /api/staking-rate   - 1 MON = ? shMON`);
    console.log(`   GET  /api/both           - Both rates`);
    console.log('   Token Prices (CoinGecko):');
    console.log(`   GET  /api/price          - General prices`);
    console.log(`   GET  /api/price/featured - BTC/MON/DUST/shMON`);
    console.log(`   GET  /api/price/btc-eth  - BTC/ETH prices`);
    console.log(`   GET  /api/price/monad    - MON price`);
    console.log(`   GET  /api/price/stables  - Stablecoins`);
    console.log('   Token List (Paginated):');
    console.log(`   GET  /api/tokens        - Token list with prices`);
    console.log(`   GET  /api/tokens/categories - Token categories`);
    console.log(`   GET  /api/tokens/strategies - DeFi strategies`);
    console.log('   System:');
    console.log(`   GET  /api/health         - Health check`);
    console.log(`   GET  /api/contract-info  - Contract info`);
    console.log('=================================\n');
});

module.exports = app;
