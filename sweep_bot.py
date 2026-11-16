import requests
import time
import os
import json
import sys
import pandas as pd

# ==========================================
# 1. TELEGRAM SECRETS (GitHub Actions se aayenge)
# ==========================================
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')
TELEGRAM_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID')

if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
    print("❌ ERROR: Telegram Tokens missing!")
    sys.exit(1)

BASE_URL = "https://www.okx.com/api/v5"
STATE_FILE = "sweep_state.json"

def send_telegram(msg):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {"chat_id": TELEGRAM_CHAT_ID, "text": msg, "parse_mode": "Markdown"}
    try:
        requests.post(url, json=payload, timeout=10)
    except Exception as e:
        print(f"Telegram Error: {e}")

def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r") as f:
                return json.load(f)
        except: pass
    return {}

def save_state(state):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f)
    except: pass

def get_klines(sym):
    try: 
        res = requests.get(f"{BASE_URL}/market/candles?instId={sym}&bar=15m&limit=250", timeout=10).json()
        data = res.get('data', [])
        if not data: return None
        
        data.reverse()
        df = pd.DataFrame(data, columns=['ts', 'open', 'high', 'low', 'close', 'vol', 'volCcy', 'volCcyQuote', 'confirm'])
        for col in ['open', 'high', 'low', 'close', 'vol']:
            df[col] = df[col].astype(float)
        return df
    except Exception as e: 
        return None

def scan_market():
    print("📥 Fetching Top 300 Coins from OKX...")
    try:
        response = requests.get(f"{BASE_URL}/market/tickers?instType=SWAP", timeout=15)
        data = response.json().get('data', [])
        usdt_pairs = [t for t in data if t['instId'].endswith('-USDT-SWAP')]
        
        # Volume ke hisaab se sort karo (Good Coins filter)
        usdt_pairs.sort(key=lambda x: float(x.get('volCcy24h', 0)), reverse=True)
        # TOP 300 COINS SELECT KARO
        coins = [t['instId'] for t in usdt_pairs[:300]]
    except Exception as e:
        print(f"❌ Network Error: {e}")
        return

    state = load_state()
    current_time = time.time()
    alerts_found = 0

    print(f"🔍 Scanning {len(coins)} coins...")

    for sym in coins:
        # Cooldown: Agar 1 ghante me alert ja chuka hai toh skip karo
        if sym in state and current_time - state[sym] < 3600:
            continue

        df = get_klines(sym)
        if df is None or len(df) < 200: 
            continue

        # --- INDICATORS CALCULATION ---
        df['ema200'] = df['close'].ewm(span=200, adjust=False).mean()
        df['sma_vol'] = df['vol'].rolling(window=20).mean()
        
        df['tr'] = df['high'] - df['low']
        df['atr'] = df['tr'].rolling(window=14).mean()
        
        df['high50'] = df['high'].rolling(window=50).max().shift(1)
        df['low50'] = df['low'].rolling(window=50).min().shift(1)

        candle = df.iloc[-2] # Closed candle
        
        close = candle['close']
        high = candle['high']
        low = candle['low']
        vol = candle['vol']
        ema200 = candle['ema200']
        sma_vol = candle['sma_vol']
        atr = candle['atr']
        high50 = candle['high50']
        low50 = candle['low50']

        vol_cond = vol > (sma_vol * 4.0)
        atr_cond = (atr / close) > 0.005

        body = abs(close - candle['open'])
        upper_wick = high - max(close, candle['open'])
        lower_wick = min(close, candle['open']) - low
        wick_cond_short = upper_wick > body
        wick_cond_long = lower_wick > body

        short_cond = (high > high50 * 1.005) and (close < high50) and (close < ema200) and wick_cond_short
        long_cond = (low < low50 * 0.995) and (close > low50) and (close > ema200) and wick_cond_long

        if vol_cond and atr_cond:
            clean_sym = sym.replace("-USDT-SWAP", "USDT")
            
            if short_cond:
                msg = f"🚨 *STRONG SHORT SETUP* 🚨\n\n*Coin:* {clean_sym}\n*Price:* {close}\n*Volume:* {vol/sma_vol:.1f}x Average\n*Trend:* Below EMA 200\n*Wick High:* {high}\n\n_Check chart for entry!_"
                send_telegram(msg)
                print(f"✅ Alert: {clean_sym} (SHORT)")
                state[sym] = current_time
                alerts_found += 1
                time.sleep(1) 
                
            elif long_cond:
                msg = f"🚨 *STRONG LONG SETUP* 🚨\n\n*Coin:* {clean_sym}\n*Price:* {close}\n*Volume:* {vol/sma_vol:.1f}x Average\n*Trend:* Above EMA 200\n*Wick Low:* {low}\n\n_Check chart for entry!_"
                send_telegram(msg)
                print(f"✅ Alert: {clean_sym} (LONG)")
                state[sym] = current_time
                alerts_found += 1
                time.sleep(1)

        time.sleep(0.1) # API limit protection

    save_state(state)
    print(f"✅ Scan complete. Total alerts: {alerts_found}")

if __name__ == "__main__":
    send_telegram("✅ GitHub Bot Started: Scanning Top 300 Coins on OKX...")
    scan_market()
