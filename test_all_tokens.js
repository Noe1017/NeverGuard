/**
 * 测试所有 Token 价格获取
 * 验证 CoinGecko API 对 tokens.json 中所有 Token 的支持情况
 */

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');

// ==================== 配置 ====================

const PROXY_URL = 'http://127.0.0.1:7890';
const httpsAgent = new HttpsProxyAgent(PROXY_URL);

const api = axios.create({
    httpsAgent,
    timeout: 15000,
    headers: { 'User-Agent': 'NeverGuard/1.0' }
});

// 读取 Token 配置
const tokensConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'tokens.json'), 'utf8'));

// ==================== 核心函数 ====================

/**
 * 提取所有 Token 的 coingeckoId
 */
function getAllTokenIds() {
    const ids = new Set();

    for (const category in tokensConfig.tokens) {
        const categoryTokens = tokensConfig.tokens[category].tokens;
        for (const token of categoryTokens) {
            ids.add(token.coingeckoId);
        }
    }

    return Array.from(ids);
}

/**
 * 批量获取 Token 价格 (CoinGecko 限制一次最多 30 个)
 */
async function fetchPricesByIds(ids) {
    const results = [];
    const batchSize = 30;

    for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        const idsString = batch.join(',');

        console.log(`\n📡 批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(ids.length / batchSize)}: ${batch.length} 个 Token`);

        try {
            const response = await api.get('https://api.coingecko.com/api/v3/simple/price', {
                params: {
                    ids: idsString,
                    vs_currencies: 'usd',
                    include_market_cap: true,
                    include_24hr_vol: false,
                    include_24hr_change: true
                }
            });

            const data = response.data;

            // 分析结果
            for (const id of batch) {
                if (data[id]) {
                    results.push({
                        id,
                        success: true,
                        price: data[id].usd,
                        change24h: data[id].usd_24h_change
                    });
                    console.log(`  ✅ ${id}: $${data[id].usd}`);
                } else {
                    results.push({
                        id,
                        success: false,
                        error: 'Not found in response'
                    });
                    console.log(`  ❌ ${id}: 未找到`);
                }
            }

            // 避免速率限制
            if (i + batchSize < ids.length) {
                await new Promise(r => setTimeout(r, 1000));
            }

        } catch (error) {
            console.error(`  ❌ 批次请求失败: ${error.message}`);
            for (const id of batch) {
                results.push({
                    id,
                    success: false,
                    error: error.message
                });
            }
        }
    }

    return results;
}

/**
 * 生成测试报告
 */
function generateReport(results) {
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    console.log('\n=================================');
    console.log('📊 测试报告');
    console.log('=================================');
    console.log(`总计: ${results.length} 个 Token`);
    console.log(`✅ 成功: ${successful.length} 个`);
    console.log(`❌ 失败: ${failed.length} 个`);
    console.log(`成功率: ${(successful.length / results.length * 100).toFixed(2)}%`);

    if (failed.length > 0) {
        console.log('\n❌ 失败的 Token:');
        failed.forEach(f => {
            console.log(`  - ${f.id}: ${f.error}`);
        });
    }

    console.log('\n✅ 成功获取价格的 Token:');
    successful.forEach(s => {
        const change = s.change24h ? `${s.change24h.toFixed(2)}%` : 'N/A';
        console.log(`  - ${s.id}: $${s.price} (24h: ${change})`);
    });

    // 保存结果到文件
    const reportPath = path.join(__dirname, 'price_test_report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        summary: {
            total: results.length,
            successful: successful.length,
            failed: failed.length,
            successRate: successful.length / results.length
        },
        successful: successful.map(s => ({ id: s.id, price: s.price, change24h: s.change24h })),
        failed: failed.map(f => ({ id: f.id, error: f.error }))
    }, null, 2));

    console.log(`\n📁 详细报告已保存到: ${reportPath}`);
    console.log('=================================\n');

    return { successful, failed };
}

/**
 * 按类别分析
 */
function analyzeByCategory(results) {
    console.log('\n=================================');
    console.log('📋 按类别分析');
    console.log('=================================');

    const resultLookup = new Map();
    results.forEach(r => resultLookup.set(r.id, r));

    for (const [categoryKey, categoryData] of Object.entries(tokensConfig.tokens)) {
        console.log(`\n【${categoryData.description}】`);

        const tokens = categoryData.tokens;
        let successCount = 0;

        for (const token of tokens) {
            const result = resultLookup.get(token.coingeckoId);
            if (result && result.success) {
                console.log(`  ✅ ${token.symbol} (${token.name}): $${result.price}`);
                successCount++;
            } else {
                console.log(`  ❌ ${token.symbol} (${token.name}): 获取失败`);
            }
        }

        console.log(`  成功率: ${successCount}/${tokens.length} = ${(successCount / tokens.length * 100).toFixed(1)}%`);
    }

    console.log('\n=================================\n');
}

// ==================== 主程序 ====================

async function main() {
    console.log('=================================');
    console.log('🧪 NeverGuard Token 价格测试');
    console.log('=================================');
    console.log(`📡 使用代理: ${PROXY_URL}`);

    // 获取所有 Token IDs
    const allIds = getAllTokenIds();
    console.log(`\n📋 共 ${allIds.length} 个 Token 需要测试`);

    // 批量获取价格
    const results = await fetchPricesByIds(allIds);

    // 生成报告
    const { successful, failed } = generateReport(results);

    // 按类别分析
    analyzeByCategory(results);

    // 如果有失败的 Token，输出建议
    if (failed.length > 0) {
        console.log('⚠️ 建议:');
        console.log('  1. 检查 CoinGecko 上是否有该 Token');
        console.log('  2. 尝试使用合约地址查询 (token_price/{platform})');
        console.log('  3. 考虑使用其他数据源 (如 Binance API)');
    }

    return { successful, failed };
}

// 运行测试
main().catch(console.error);
