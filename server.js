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

// ==================== 初始化 ====================

let provider;
let shmonadContract;

function initContract() {
    try {
        provider = new ethers.JsonRpcProvider(MONAD_RPC);
        shmonadContract = new ethers.Contract(SHMONAD_ADDRESS, SHMONAD_ABI, provider);
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
