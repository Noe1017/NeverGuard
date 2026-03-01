/**
 * CoinGecko API 测试脚本
 * 测试获取主流 Token 价格
 * 支持 Clash 代理
 */

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';

// Clash 代理配置
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:7890';
const httpsAgent = new HttpsProxyAgent(PROXY_URL);

// 创建 axios 实例，配置代理
const api = axios.create({
    httpsAgent,
    timeout: 15000,
    headers: {
        'User-Agent': 'NeverGuard/1.0'
    }
});

console.log(`📡 使用代理: ${PROXY_URL}`);

// ==================== API 函数 ====================

/**
 * 方式1: 获取简单价格 (通过 Coin ID)
 * API: /api/v3/simple/price
 * 支持批量查询，最多 30 个币种
 */
async function getSimplePrice() {
    const ids = ['bitcoin', 'ethereum', 'monad', 'tether', 'usd-coin'].join(',');
    const vsCurrencies = 'usd';
    const url = `${COINGECKO_API_BASE}/simple/price`;

    console.log('\n=== 方式1: Simple Price API ===');
    console.log(`URL: ${url}`);

    try {
        const response = await api.get(url, {
            params: {
                ids,
                vs_currencies: vsCurrencies,
                include_market_cap: true,
                include_24hr_vol: true,
                include_24hr_change: true
            }
        });

        console.log('\n✅ 成功获取价格:');
        console.log(JSON.stringify(response.data, null, 2));
        return { success: true, data: response.data };
    } catch (error) {
        console.error(`❌ 请求失败: ${error.message}`);
        if (error.response) {
            console.error(`   状态码: ${error.response.status}`);
        }
        return { success: false, error: error.message };
    }
}

/**
 * 方式2: 通过合约地址获取价格 (适用于 ERC-20 Token)
 * API: /api/v3/simple/token_price/{id}
 * 注意: Monad 链可能尚未被 CoinGecko 支持
 */
async function getTokenPriceByAddress() {
    // 以以太坊上的 USDC 为例
    const contractAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const url = `${COINGECKO_API_BASE}/simple/token_price/ethereum`;

    console.log('\n=== 方式2: Token Price by Contract Address ===');
    console.log(`URL: ${url}`);

    try {
        const response = await api.get(url, {
            params: {
                contract_addresses: contractAddress,
                vs_currencies: 'usd'
            }
        });

        if (Object.keys(response.data).length > 0) {
            console.log('\n✅ 成功获取价格:');
            console.log(JSON.stringify(response.data, null, 2));
            return { success: true, data: response.data };
        } else {
            console.warn('⚠️ 该合约地址未被 CoinGecko 索引');
            return { success: false, error: 'Contract not indexed' };
        }
    } catch (error) {
        console.error(`❌ 请求失败: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * 方式3: 获取市场行情
 * API: /api/v3/coins/markets
 * 获取更详细的市场数据
 */
async function getMarketData() {
    const url = `${COINGECKO_API_BASE}/coins/markets`;

    console.log('\n=== 方式3: Market Data API ===');
    console.log(`URL: ${url}`);

    try {
        const response = await api.get(url, {
            params: {
                vs_currency: 'usd',
                ids: 'bitcoin,ethereum,monad',
                order: 'market_cap_desc',
                per_page: 10,
                page: 1,
                sparkline: false
            }
        });

        console.log('\n✅ 成功获取市场数据:');
        response.data.forEach(coin => {
            console.log(`\n📊 ${coin.name} (${coin.symbol.toUpperCase()})`);
            console.log(`   价格: $${coin.current_price?.toLocaleString()}`);
            console.log(`   24h变化: ${coin.price_change_percentage_24h?.toFixed(2)}%`);
            console.log(`   市值: $${coin.market_cap?.toLocaleString()}`);
            console.log(`   24h交易量: $${coin.total_volume?.toLocaleString()}`);
        });
        return { success: true, data: response.data };
    } catch (error) {
        console.error(`❌ 请求失败: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * 方式4: 获取特定币种详情
 * API: /api/v3/coins/{id}
 */
async function getCoinDetails(coinId = 'bitcoin') {
    const url = `${COINGECKO_API_BASE}/coins/${coinId}`;

    console.log(`\n=== 方式4: Coin Details (${coinId}) ===`);
    console.log(`URL: ${url}`);

    try {
        const response = await api.get(url, {
            params: {
                localization: false,
                tickers: false,
                community_data: false,
                developer_data: false
            }
        });

        const data = response.data;
        console.log('\n✅ 成功获取币种详情:');
        console.log(`   名称: ${data.name}`);
        console.log(`   符号: ${data.symbol.toUpperCase()}`);
        console.log(`   排名: #${data.market_cap_rank}`);
        console.log(`   价格: $${data.market_data?.current_price?.usd?.toLocaleString()}`);
        console.log(`   24h高低: $${data.market_data?.low_24h?.usd?.toLocaleString()} - $${data.market_data?.high_24h?.usd?.toLocaleString()}`);
        return { success: true, data };
    } catch (error) {
        console.error(`❌ 请求失败: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * 方式5: 获取 BTC/ETH 价格 (最常用)
 */
async function getBtcEthPrice() {
    const url = `${COINGECKO_API_BASE}/simple/price`;

    console.log('\n=== 方式5: BTC/ETH 价格 (常用) ===');

    try {
        const response = await api.get(url, {
            params: {
                ids: 'bitcoin,ethereum',
                vs_currencies: 'usd,cny',
                include_market_cap: true,
                include_24hr_change: true
            }
        });

        console.log('\n✅ 成功获取 BTC/ETH 价格:');
        const btc = response.data.bitcoin;
        const eth = response.data.ethereum;

        console.log('\n📈 Bitcoin (BTC)');
        console.log(`   $${btc.usd}`);
        console.log(`   ¥${btc.cny}`);
        console.log(`   24h: ${btc.usd_24h_change?.toFixed(2)}%`);
        console.log(`   市值: $${(btc.usd_market_cap / 1e9).toFixed(2)}B`);

        console.log('\n📈 Ethereum (ETH)');
        console.log(`   $${eth.usd}`);
        console.log(`   ¥${eth.cny}`);
        console.log(`   24h: ${eth.usd_24h_change?.toFixed(2)}%`);
        console.log(`   市值: $${(eth.usd_market_cap / 1e9).toFixed(2)}B`);

        return { success: true, data: response.data };
    } catch (error) {
        console.error(`❌ 请求失败: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// ==================== 主程序 ====================

async function main() {
    console.log('=================================');
    console.log('🧪 CoinGecko API 测试');
    console.log('=================================');

    // 测试各 API 端点
    await getSimplePrice();
    await new Promise(r => setTimeout(r, 1000));

    await getTokenPriceByAddress();
    await new Promise(r => setTimeout(r, 1000));

    await getMarketData();
    await new Promise(r => setTimeout(r, 1000));

    await getCoinDetails('ethereum');
    await new Promise(r => setTimeout(r, 1000));

    await getBtcEthPrice();

    console.log('\n=================================');
    console.log('✅ 测试完成');
    console.log('=================================\n');
}

// 运行测试
main().catch(console.error);
