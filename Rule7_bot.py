import requests
import time
import os
import json
import sys

# ==========================================
# 1. AUTOMATIC SECRETS FETCHING (GitHub Actions)
# ==========================================
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')
TELEGRAM_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID')

if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
    print("❌ ERROR: TELEGRAM_BOT_TOKEN ya TELEGRAM_CHAT_ID GitHub Secrets mein nahi mila!")
    sys.exit(1)

BASE_FAPI = "https://fapi.binance.com"
STATE_FILE = "telegram_state.json"

def send_telegram(msg):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {"chat_id": TELEGRAM_CHAT_ID, "text": msg, "parse_mode": "Markdown"}
    try:
        r = requests.post(url, json=payload, timeout=10)
        if r.status_code != 200:
            print(f"⚠️ Telegram API Error: {r.text}")
    except Exception as e:
        print(f"⚠️ Telegram Network Error: {e}")

# ==========================================
# 2. STATE MANAGEMENT (Duplicate alerts rokne ke liye)
# ==========================================
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
        return requests.get(f"{BASE_FAPI}/fapi/v1/klines?symbol={sym}&interval=15m&limit=100", timeout=5).json()
    except: 
        return []

def scan_market():
    print("📥 Fetching Top 250 Best (High Volume) Coins from Binance...")
    try:
        # Binance se 24h ticker data fetch kar rahe hain
        tickers = requests.get(f"{BASE_FAPI}/fapi/v1/ticker/24hr", timeout=15).json()
        
        # Sirf USDT pairs filter karo
        usdt_pairs = [t for t in tickers if t['symbol'].endswith('USDT')]
        
        # 24h Volume ke hisaab se sort karo (Sabse zyada volume wale upar)
        usdt_pairs.sort(key=lambda x: float(x['quoteVolume']), reverse=True)
        
        # Top 250 coins uthao (Bakwas/Dead coins filter ho jayenge)
        coins = [t['symbol'] for t in usdt_pairs[:250]]
        
    except Exception as e:
        print(f"❌ Error fetching coins: {e}")
        return

    state = load_state()
    current_time = time.time()
    alerts_found = 0

    print(f"🔍 Scanning {len(coins)} premium coins for 15m strict Sweeps...")

    for sym in coins:
        # Cooldown: Agar 2 ghante me alert ja chuka hai toh skip karo
        if sym in state and current_time - state[sym] < 2 * 3600:
            continue

        kl = get_kl_15m(sym)
        if len(kl) < 55: continue

        # Last CLOSED candle (Live candle nahi)
        closed_candle = kl[-2]
        
        past_50 = kl[-52:-2]
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
        
        # ATR(14) Calculation
        last_14 = kl[-16:-2]
        atr = sum([float(k[2]) - float(k[3]) for k in last_14]) / 14

        # --- STRICT STRATEGY CONDITIONS ---
        vol_cond = cur_vol > 4.0 * avg_volume # Volume average se 4x zyada ho
        atr_cond = (atr / cur_close) > 0.005  # Coin me kam se kam 0.5% ki movement ho
        
        short_cond = (cur_high > highest_50 * 1.005) and (cur_close < highest_50 * 0.995)
        long_cond = (cur_low < lowest_50 * 0.995) and (cur_close > lowest_50 * 1.005)

        if vol_cond and atr_cond:
            if short_cond:
                msg = f"🚨 *HIGH SWEEP (SHORT)* 🚨\n\n*Coin:* {sym}\n*Price:* {cur_close}\n*Volume:* {cur_vol/avg_volume:.1f}x Average\n*Wick High:* {cur_high}\n\n*Action:* Short setup forming on 15m. Check chart!"
                send_telegram(msg)
                print(f"✅ Alert sent for {sym} (SHORT)")
                state[sym] = current_time
                alerts_found += 1
                time.sleep(1) 
                
            elif long_cond:
                msg = f"🚨 *LOW SWEEP (LONG)* 🚨\n\n*Coin:* {sym}\n*Price:* {cur_close}\n*Volume:* {cur_vol/avg_volume:.1f}x Average\n*Wick Low:* {cur_low}\n\n*Action:* Long setup forming on 15m. Check chart!"
                send_telegram(msg)
                print(f"✅ Alert sent for {sym} (LONG)")
                state[sym] = current_time
                alerts_found += 1
                time.sleep(1)

        time.sleep(0.1) # Binance API limit se bachne ke liye

    save_state(state)
    print(f"✅ Scan complete. Total alerts sent: {alerts_found}")

if __name__ == "__main__":
    scan_market()
