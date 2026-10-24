# RULE #7 V2 FINAL FIX - MKR BEAM removed + 24h log
import ccxt, time, requests
from datetime import datetime
import os

TELEGRAM_BOT_TOKEN = "PUT_YOUR_BOT_TOKEN_HERE"
TELEGRAM_CHAT_ID = "PUT_YOUR_CHAT_ID_HERE"

# TOP 48 - OKX pe confirmed working - MKR BEAM removed
TOP_COINS = [
    "BTC/USDT", "ETH/USDT", "BNB/USDT", "SOL/USDT", "XRP/USDT",
    "DOGE/USDT", "ADA/USDT", "AVAX/USDT", "LINK/USDT", "DOT/USDT",
    "LTC/USDT", "BCH/USDT", "POL/USDT", "UNI/USDT", "PEPE/USDT",
    "SHIB/USDT", "ENA/USDT", "NEAR/USDT", "APT/USDT", "ARB/USDT",
    "OP/USDT", "SUI/USDT", "ETC/USDT", "FIL/USDT", "XLM/USDT",
    "HBAR/USDT", "INJ/USDT", "TIA/USDT", "STX/USDT", "RENDER/USDT",
    "WLD/USDT", "SEI/USDT", "JUP/USDT", "ONDO/USDT", "AAVE/USDT",
    "TAO/USDT", "FET/USDT", "BONK/USDT", "WIF/USDT", "FLOKI/USDT",
    "LDO/USDT", "STRK/USDT", "PYTH/USDT", "JTO/USDT", "ORDI/USDT",
    "SATS/USDT", "BLUR/USDT", "PENDLE/USDT"
]

TIMEFRAME = "15m"
CANDLE_COUNT = 50
MIN_VOLUME_24H = 10000000
MIN_PRICE = 0.0001

def get_exchange():
    try:
        ex = ccxt.bybit({'enableRateLimit': True, 'options': {'defaultType': 'linear'}})
        ex.load_markets()
        print("Connected: Bybit")
        return ex
    except:
        try:
            ex = ccxt.okx({'enableRateLimit': True})
            ex.load_markets()
            print("Connected: OKX")
            return ex
        except:
            ex = ccxt.bitget({'enableRateLimit': True})
            ex.load_markets()
            print("Connected: Bitget")
            return ex

exchange = get_exchange()

def send_telegram(msg):
    if "PUT_YOUR" in TELEGRAM_BOT_TOKEN:
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    data = {"chat_id": TELEGRAM_CHAT_ID, "text": msg, "parse_mode": "Markdown"}
    try:
        requests.post(url, data=data, timeout=10)
    except:
        pass

def check_rule_7(symbol):
    try:
        ticker = exchange.fetch_ticker(symbol)
        price = ticker['last']
        qvol = ticker.get('quoteVolume') or ticker.get('baseVolume', 0) * price
        if price is None or price < MIN_PRICE: return None
        if qvol < MIN_VOLUME_24H: return None
        ohlcv = exchange.fetch_ohlcv(symbol, TIMEFRAME, limit=CANDLE_COUNT+1)
        if len(ohlcv) < CANDLE_COUNT+1: return None
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
            return {"symbol": symbol, "signal": signal, "price": current_price, "break": break_level, "volume": qvol}
        return None
    except Exception as e:
        print(f"Skip {symbol} {e}")
        return None

def main():
    total = len(TOP_COINS)
    ex_id = exchange.id.upper()
    print(f"RULE #7 V2 Started - {total} coins - {ex_id}")
    found = 0
    for symbol in TOP_COINS:
        result = check_rule_7(symbol)
        if result:
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            log_line = f"{now} | {result['signal']} | {result['symbol']} | {result['price']}"
            # File me save - 24h count ke liye
            with open("alerts.log", "a") as f:
                f.write(log_line + "\n")
            msg = f"RULE #7\n{result['signal']} | {result['symbol']}\nPrice: {result['price']}\nBreak: {result['break']}\nTime: {now}"
            send_telegram(msg)
            print(f"FOUND {log_line}")
            found += 1
        time.sleep(0.3)
    
    print(f"Done {found} signals")
    print(f"All clean - No 50-candle breakout in Top {total}" if found==0 else f"Total alerts today: {found}")

if __name__ == "__main__":
    main()
