# RULE #7 - V2 (No Shitcoins)
import ccxt, time, requests
from datetime import datetime

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

exchange = ccxt.binance({'enableRateLimit': True, 'options': {'defaultType': 'future'}})

def send_telegram(msg):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    data = {"chat_id": TELEGRAM_CHAT_ID, "text": msg, "parse_mode": "Markdown"}
    requests.post(url, data=data)

def check_rule_7(symbol):
    ticker = exchange.fetch_ticker(symbol)
    price = ticker['last']
    volume_24h = ticker['quoteVolume']
    
    if price < MIN_PRICE: return None
    if volume_24h < MIN_VOLUME_24H: return None

    ohlcv = exchange.fetch_ohlcv(symbol, TIMEFRAME, limit=CANDLE_COUNT+1)
    prev_50 = ohlcv[:-1]
    current_price = ohlcv[-1][4]
    
    high_50 = max([c[2] for c in prev_50])
    low_50 = min([c[3] for c in prev_50])

    signal = None
    break_level = None
    if current_price > high_50 * 1.001:
        signal = "LONG"; break_level = high_50
    elif current_price < low_50 * 0.999:
        signal = "SHORT"; break_level = low_50

    if signal:
        return {"symbol": symbol, "signal": signal, "price": current_price, "break": break_level, "volume": volume_24h}
    return None

def main_loop():
    while True:
        signals = []
        for symbol in TOP_COINS:
            result = check_rule_7(symbol)
            if result:
                msg = f"🚨 RULE #7\n{result['signal']} | {result['symbol']}\nPrice: {result['price']}\nBreak: {result['break']}\nVol: ${result['volume']/1e6:.1f}M\nTop 50 scan"
                send_telegram(msg)
                signals.append(result)
            time.sleep(0.3)
        time.sleep(300)

if __name__ == "__main__":
    main_loop()
