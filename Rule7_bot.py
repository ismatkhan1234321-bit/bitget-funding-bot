# RULE #7 V2 - FIXED FOR GITHUB ACTIONS (No Binance Ban)
# Bybit + OKX - No Restriction - Top 50 Only
import ccxt
import time
import requests
from datetime import datetime

# ============ CONFIG ============
TELEGRAM_BOT_TOKEN = "PUT_YOUR_BOT_TOKEN"
TELEGRAM_CHAT_ID = "PUT_YOUR_CHAT_ID"

TOP_COINS = [
    "BTC/USDT", "ETH/USDT", "BNB/USDT", "SOL/USDT", "XRP/USDT",
    "DOGE/USDT", "ADA/USDT", "AVAX/USDT", "LINK/USDT", "DOT/USDT",
    "LTC/USDT", "BCH/USDT", "MATIC/USDT", "UNI/USDT", "PEPE/USDT",
    "SHIB/USDT", "ENA/USDT", "NEAR/USDT", "APT/USDT", "ARB/USDT",
    "OP/USDT", "SUI/USDT", "ETC/USDT", "FIL/USDT", "XLM/USDT",
    "HBAR/USDT", "INJ/USDT", "TIA/USDT", "STX/USDT", "MKR/USDT",
    "RNDR/USDT", "WLD/USDT", "SEI/USDT", "JUP/USDT", "ONDO/USDT",
    "AAVE/USDT", "TAO/USDT", "FET/USDT", "BONK/USDT", "WIF/USDT",
    "FLOKI/USDT", "LDO/USDT", "STRK/USDT", "PYTH/USDT", "JTO/USDT",
    "ORDI/USDT", "1000SATS/USDT", "BEAM/USDT", "BLUR/USDT", "PENDLE/USDT"
]

TIMEFRAME = "15m"
CANDLE_COUNT = 50
MIN_VOLUME_24H = 10_000_000
MIN_PRICE = 0.0001

# ============ FIXED EXCHANGE - NO BAN ============
def get_exchange():
    # Try Bybit first (best for GitHub)
    try:
        ex = ccxt.bybit({'enableRateLimit': True, 'options': {'defaultType': 'linear'}})
        ex.load_markets()
        print("✅ Connected: Bybit")
        return ex
    except Exception as e:
        print(f"Bybit failed: {e}, trying OKX...")

    # Fallback OKX
    try:
        ex = ccxt.okx({'enableRateLimit': True})
        ex.load_markets()
        print("✅ Connected: OKX")
        return ex
    except Exception as e:
        print(f"OKX failed: {e}, trying Bitget...")
    
    # Last fallback Bitget
    ex = ccxt.bitget({'enableRateLimit': True})
    ex.load_markets()
    print("✅ Connected: Bitget")
    return ex

exchange = get_exchange()

def send_telegram(msg):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    data = {"chat_id": TELEGRAM_CHAT_ID, "text": msg, "parse_mode": "Markdown"}
    try:
        requests.post(url, data=data, timeout=10)
    except Exception as e:
        print(f"Telegram Error: {e}")

def check_rule_7(symbol):
    try:
        ticker = exchange.fetch_ticker(symbol)
        price = ticker['last']
        # OKX/Bybit me quoteVolume alag hota hai
        volume_24h = ticker.get('quoteVolume') or ticker.get('baseVolume', 0) * price or 0

        if price is None or price < MIN_PRICE:
            return None
        if volume_24h < MIN_VOLUME_24H:
            return None

        ohlcv = exchange.fetch_ohlcv(symbol, TIMEFRAME, limit=CANDLE_COUNT+1)
        if len(ohlcv) < CANDLE_COUNT+1:
            return None

        prev_50 = ohlcv[:-1]
        current_price = ohlcv[-1][4]
        
        high_50 = max([c[2] for c in prev_50])
        low_50 = min([c[3] for c in prev_50])

        signal = None
        break_level = None
        # 0.1% buffer fake breakout se bachne ke liye
        if current_price > high_50 * 1.001:
            signal = "LONG"
            break_level = high_50
        elif current_price < low_50 * 0.999:
            signal = "SHORT"
            break_level = low_50

        if signal:
            return {
                "symbol": symbol,
                "signal": signal,
                "price": current_price,
                "break": break_level,
                "volume": volume_24h
            }
        return None
    except Exception as e:
        print(f"Skip {symbol}: {e}")
        return None

def main_loop():
    print(f"RULE #7 V2 Started - {len(TOP_COINS)} coins - {
