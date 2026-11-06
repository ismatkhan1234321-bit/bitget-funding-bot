import requests
import time
import os
import json
import sys

# ==========================================
# 1. TELEGRAM SECRETS
# ==========================================
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')
TELEGRAM_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID')

if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
    print("❌ ERROR: Telegram Tokens missing in GitHub Secrets!")
    sys.exit(1)

# OKX API Base URL
BASE_URL = "https://www.okx.com/api/v5"
STATE_FILE = "telegram_state.json"

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

def get_kl_15m(sym):
    try: 
        res = requests.get(f"{BASE_URL}/market/candles?instId={sym}&bar=15m&limit=100", timeout=5).json()
        return res.get('data', [])
    except: 
        return []

def scan_market():
    print("📥 Fetching Top 250 Best Coins from OKX...")
    try:
        response = requests.get(f"{BASE_URL}/market/tickers?instType=SWAP", timeout=15)
        
        if response.status_code != 200:
            print(f"❌ OKX API Error! Status Code: {response.status_code}")
            return

        data = response.json().get('data', [])
        usdt_pairs = [t for t in data if t['instId'].endswith('-USDT-SWAP')]
        
        if len(usdt_pairs) == 0:
            print("❌ No USDT pairs found on OKX.")
            return

        usdt_pairs.sort(key=lambda x: float(x.get('volCcy24h', 0)), reverse=True)
        coins = [t['instId'] for t in usdt_pairs[:250]]
        
    except Exception as e:
        print(f"❌ Network Error: {e}")
        return

    state = load_state()
    current_time = time.time()
    alerts_found = 0

    print(f"🔍 Scanning {len(coins)} coins on OKX...")

    for sym in coins:
        if sym in state and current_time - state[sym] < 2 * 3600:
            continue

        kl = get_kl_15m(sym)
        if len(kl) < 55: continue

        closed_candle = kl[1]
        past_50 = kl[2:52]
        
        highs = [float(k[2]) for k in past_50]
        lows = [float(k[3]) for k in past_50]
        volumes = [float(k[5]) for k in past_50]
        
        highest_50 = max(highs)
        lowest_50 = min(lows)
        avg_volume = sum(volumes) / 50
        
        cur_high = float(closed_candle[2])
        cur_low = float(closed_candle[3])
        cur_close = float(closed_candle[4])
        cur_vol = float(closed_candle[5])
        
        last_14 = kl[2:16]
        tr_values = [float(k[2]) - float(k[3]) for k in last_14]
        atr = sum(tr_values) / 14

        vol_cond = cur_vol > 4.0 * avg_volume 
        atr_cond = (atr / cur_close) > 0.005  
        
        short_cond = (cur_high > highest_50 * 1.005) and (cur_close < highest_50 * 0.995)
        long_cond = (cur_low < lowest_50 * 0.995) and (cur_close > lowest_50 * 1.005)

        if vol_cond and atr_cond:
            clean_sym = sym.replace("-USDT-SWAP", "USDT")
            
            if short_cond:
                msg = f"🚨 *HIGH SWEEP (SHORT)* 🚨\n\n*Coin:* {clean_sym}\n*Price:* {cur_close}\n*Volume:* {cur_vol/avg_volume:.1f}x Average\n*Wick High:* {cur_high}"
                send_telegram(msg)
                print(f"✅ Alert sent for {clean_sym} (SHORT)")
                state[sym] = current_time
                alerts_found += 1
                time.sleep(1) 
                
            elif long_cond:
                msg = f"🚨 *LOW SWEEP (LONG)* 🚨\n\n*Coin:* {clean_sym}\n*Price:* {cur_close}\n*Volume:* {cur_vol/avg_volume:.1f}x Average\n*Wick Low:* {cur_low}"
                send_telegram(msg)
                print(f"✅ Alert sent for {clean_sym} (LONG)")
                state[sym] = current_time
                alerts_found += 1
                time.sleep(1)

        time.sleep(0.1)

    save_state(state)
    print(f"✅ Scan complete. Total alerts sent: {alerts_found}")

if __name__ == "__main__":
    send_telegram("✅ Bot Started: Scanning OKX market for setups...")
    scan_market()
