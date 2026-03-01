"""
NeverGuard - shMonad Exchange Rate Fetcher

获取 shMonad (shMON) 的实时 Exchange Rate
Exchange Rate = totalAssets / totalSupply (ERC-4626 标准)
"""

import requests
import json
from web3 import Web3
from decimal import Decimal

# ==================== 配置 ====================

# Monad RPC 节点 (需要替换为可用的 RPC)
MONAD_RPC_URL = "https://monad-rpc.example.com"  # 需要替换

# shMON Token 合约地址 (测试网)
SHMON_TOKEN_ADDRESS = "0x3a98250F98Dd388C211206983453837C8365BDc1"

# shMonad 质押合约地址 (需要根据实际情况更新)
SHMON_VAULT_ADDRESS = ""  # 需要找到质押合约地址

# ==================== DeFiLlama API ====================

def get_exchange_rate_from_defillama():
    """
    从 DeFiLlama API 获取 shMonad 的 TVL 和相关数据
    API: https://api.llama.fi/protocol/shmonad
    """
    try:
        url = "https://api.llama.fi/protocol/shmonad"
        response = requests.get(url)
        response.raise_for_status()
        data = response.json()

        print("=== DeFiLlama Data ===")
        print(f"TVL: ${data.get('tvl', 0):,.2f}")
        print(f"Chain: {data.get('chain', 'N/A')}")
        print(f"Category: {data.get('category', 'N/A')}")

        # 获取价格数据
        if 'tokens' in data:
            for token in data['tokens']:
                print(f"Token: {token}")

        return data
    except Exception as e:
        print(f"Error fetching from DeFiLlama: {e}")
        return None


def get_defillama_tvl():
    """
    获取 shMonad 的 TVL
    API: https://api.llama.fi/tvl/shmonad
    """
    try:
        url = "https://api.llama.fi/tvl/shmonad"
        response = requests.get(url)
        response.raise_for_status()

        tvl_data = response.json()

        # TVL 数据通常包含时间戳和对应值
        if isinstance(tvl_data, list):
            latest = tvl_data[-1]
            print(f"\n=== Latest TVL ===")
            print(f"Timestamp: {latest[0]}")
            print(f"TVL: ${latest[1]:,.2f}")
        else:
            print(f"TVL: ${tvl_data:,.2f}")

        return tvl_data
    except Exception as e:
        print(f"Error fetching TVL: {e}")
        return None


def get_yield_data():
    """
    获取 shMonad 的收益/APY 数据
    API: https://yields.llama.fi/pools
    """
    try:
        url = "https://yields.llama.fi/pools"
        response = requests.get(url)
        response.raise_for_status()
        data = response.json()

        # 查找 shMonad 相关的池子
        shmonad_pools = [
            pool for pool in data['data']
            if 'shmonad' in pool.get('project', '').lower() or 'shmonad' in pool.get('symbol', '').lower()
        ]

        print(f"\n=== Yield Data ===")
        print(f"Found {len(shmonad_pools)} shMonad pools")

        for pool in shmonad_pools:
            print(f"\nPool: {pool.get('name', 'N/A')}")
            print(f"  APY: {pool.get('apy', 0):.2f}%")
            print(f"  TVL: ${pool.get('tvlUsd', 0):,.2f}")
            print(f"  Chain: {pool.get('chain', 'N/A')}")

        return shmonad_pools
    except Exception as e:
        print(f"Error fetching yield data: {e}")
        return None


# ==================== 链上数据获取 ====================

def get_exchange_rate_onchain():
    """
    直接从 Monad 链上获取 Exchange Rate
    Exchange Rate = totalAssets() / totalSupply()

    需要找到 shMonad 的质押合约地址 (ERC-4626 Vault)
    """
    try:
        w3 = Web3(Web3.HTTPProvider(MONAD_RPC_URL))

        if not w3.is_connected():
            print("Warning: Cannot connect to Monad RPC")
            return None

        # ERC-4626 minimal ABI for totalAssets and totalSupply
        ERC4626_ABI = [
            {
                "constant": True,
                "inputs": [],
                "name": "totalAssets",
                "outputs": [{"name": "", "type": "uint256"}],
                "type": "function"
            },
            {
                "constant": True,
                "inputs": [],
                "name": "totalSupply",
                "outputs": [{"name": "", "type": "uint256"}],
                "type": "function"
            },
            {
                "constant": True,
                "inputs": [],
                "name": "convertToAssets",
                "outputs": [{"name": "", "type": "uint256"}],
                "type": "function"
            },
            {
                "constant": True,
                "inputs": [{"name": "shares", "type": "uint256"}],
                "name": "convertToAssets",
                "outputs": [{"name": "", "type": "uint256"}],
                "type": "function"
            }
        ]

        # 连接到质押合约
        vault = w3.eth.contract(address=SHMON_VAULT_ADDRESS, abi=ERC4626_ABI)

        # 获取数据
        total_assets = vault.functions.totalAssets().call()
        total_supply = vault.functions.totalSupply().call()

        # 计算 Exchange Rate (1 shMON = ? MON)
        if total_supply > 0:
            exchange_rate = Decimal(total_assets) / Decimal(total_supply)
            print(f"\n=== On-chain Exchange Rate ===")
            print(f"Total Assets: {total_assets}")
            print(f"Total Supply: {total_supply}")
            print(f"Exchange Rate: {exchange_rate}")
            print(f"1 shMON = {exchange_rate} MON")

            return float(exchange_rate)
        else:
            print("Total supply is 0")
            return None

    except Exception as e:
        print(f"Error fetching on-chain data: {e}")
        return None


# ==================== 主程序 ====================

def main():
    print("=" * 50)
    print("NeverGuard - shMonad Exchange Rate Fetcher")
    print("=" * 50)

    # 从 DeFiLlama 获取数据
    get_exchange_rate_from_defillama()
    get_defillama_tvl()
    get_yield_data()

    # 从链上获取 (需要有效的 RPC 和合约地址)
    # get_exchange_rate_onchain()


if __name__ == "__main__":
    main()
