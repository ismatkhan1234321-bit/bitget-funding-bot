import ccxt
import pandas as pd
import time
import argparse

# ============ 500 BEST CRYPTO FUTURE ============
EXCHANGE_IDS = ["bitget", "bybit", "okx"]
TIMEFRAME = "15m"
VOLUME_THRESHOLD = 2_500_000
CHANGE_PCT_THRESHOLD = 1.5
TOP_SYMBOLS_LIMIT = 500  # <-- 500 kar diya

def get_exchange():
    for ex_id in EXCHANGE_IDS:
        try:
            print(f"Trying {ex_id}...")
            ex = getattr(ccxt, ex_id)()
            ex.load_markets()
            print(f"OK {ex_id} - {len(ex.symbols)} markets")
            return ex
        except Exception as e:
            print(f"{ex_id} fail: {e}")
            continue
    raise Exception("All exchanges failed")

def check_rule7_long(df):
    df = df.copy()
    df['high50'] = df['h'].rolling(50).max().shift(1)
    df['ema50'] = df['c'].ewm(span=50, adjust=False).mean().shift(1)
    df['change4'] = (df['c'] - df['c'].shift(4)) / df['c'].shift(4) * 100
    if len(df) < 52: return None
    last = df.iloc[-1]
    prev = df.iloc[-2]
    crosses_above = (prev['c'] <= prev['high50']) and (last['c'] > last['high50'])
    if crosses_above and last['v'] > VOLUME_THRESHOLD and last['change4'] < CHANGE_PCT_THRESHOLD and last['c'] > last['ema50']:
        return {"side": "LONG", "price": float(last['c']), "level": float(last['high50'])}
    return None

def check_rule7_short(df):
    df = df.copy()
    df['low50'] = df['l'].rolling(50).min().shift(1)
    df['ema50'] = df['c'].ewm(span=50, adjust=False).mean().shift(1)
    df['change4'] = (df['c'] - df['c'].shift(4)) / df['c'].shift(4) * 100
    if len(df) < 52: return None
    last = df.iloc[-1]
    prev = df.iloc[-2]
    crosses_below = (prev['c'] >= prev['low50']) and (last['c'] < last['low50'])
    if crosses_below and last['v'] > VOLUME_THRESHOLD and last['change4'] > -CHANGE_PCT_THRESHOLD and last['c'] < last['ema50']:
        return {"side": "SHORT", "price": float(last['c']), "level": float(last['low50'])}
    return None

def scan_both(df):
    return check_rule7_long(df) or check_rule7_short(df)

def get_top_symbols(ex):
    try:
        tickers = ex.fetch_tickers()
        # Saare USDT futures, R wale stocks hata ke
        all_usdt = []
        for s in ex.symbols:
            if 'USDT' not in s:
                continue
            # R wale stock tokens hatao - RNVDA, RTSLA, RAAPL etc
            base = s.split('/')[0].split(':')[0]
            if base.startswith('R') and len(base) >= 4 and base.isupper():
                # Lekin asli crypto ko rakho: RON, RNDR, RUNE, RAY, ROSE etc
                if base not in ['RNDR', 'RUNE', 'RAY', 'RON', 'ROSE', 'RARE', 'RENDER']:
                    if base not in ['RLC', 'RSR', 'RIF']:
                        continue
            all_usdt.append(s)
        
        # Volume se sort karke Top 500 lo
        sorted_syms = sorted(all_usdt, key=lambda x: tickers.get(x, {}).get('quoteVolume', 0) or 0, reverse=True)
        print(f"Total USDT markets: {len(all_usdt)}, Taking top {TOP_SYMBOLS_LIMIT}")
        return sorted_syms[:TOP_SYMBOLS_LIMIT]
    except Exception as e:
        print(f"Ticker fetch fail: {e}, using first 500")
        all_usdt = [s for s in ex.symbols if 'USDT' in s and not s.startswith('R')]
        return all_usdt[:TOP_SYMBOLS_LIMIT]

def scan_current():
    ex = get_exchange()
    symbols = get_top_symbols(ex)
    print(f"\n=== Rule #7 Live Scan: {len(symbols)} coins on {ex.id} ===")
    found = 0
    for i, sym in enumerate(symbols):
        try:
            if i % 50 == 0:
                print(f"Scanning {i}/{len(symbols)}...")
            ohlcv = ex.fetch_ohlcv(sym, TIMEFRAME, limit=60)
            df = pd.DataFrame(ohlcv, columns=['t','o','h','l','c','v'])
            if len(df) < 52: continue
            sig = scan_both(df)
            if sig:
                found += 1
                print(f">>> {sig['side']:5} | {sym:18} | Price={sig['price']:.6f}")
        except Exception as e:
            continue
    if found == 0: 
        print("No signals in 500 coins")
    print(f"Total signals: {found} / {len(symbols)} coins scanned\n")

def scan_24h_history():
    ex = get_exchange()
    symbols = get_top_symbols(ex)
    print(f"\n=== 24h History: {len(symbols)} coins on {ex.id} ===")
    hits = 0
    for sym in symbols:
        try:
            ohlcv = ex.fetch_ohlcv(sym, TIMEFRAME, limit=100)
            df_full = pd.DataFrame(ohlcv, columns=['t','o','h','l','c','v'])
            for j in range(60, len(df_full)):
                sig = scan_both(df_full.iloc[j-60:j+1])
                if sig:
                    ts = pd.to_datetime(df_full.iloc[j]['t'], unit='ms')
                    print(f"{ts} | {sig['side']:5} | {sym}")
                    hits += 1
        except: continue
    print(f"Total 24h hits: {hits}\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--scan', action='store_true')
    parser.add_argument('--history', action='store_true')
    parser.add_argument('--live', action='store_true')
    args = parser.parse_args()
    if args.history: scan_24h_history()
    elif args.live:
        while True:
            scan_current()
            time.sleep(60)
    else: scan_current()
