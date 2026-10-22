import ccxt, pandas as pd, os, requests

EXCHANGE_IDS = ["bitget", "bybit", "okx"]
TIMEFRAME = "15m"
VOLUME_THRESHOLD = 2_500_000
CHANGE_PCT_THRESHOLD = 1.5
TOP_SYMBOLS_LIMIT = 500

TELEGRAM_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN") or os.getenv("TELEGRAM_TOKEN") or ""
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID") or os.getenv("CHAT_ID") or ""

def send_telegram(msg):
    if not TELEGRAM_TOKEN or not CHAT_ID:
        print(f"Missing secrets: TOKEN={bool(TELEGRAM_TOKEN)} CHAT={bool(CHAT_ID)}")
        return
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        requests.post(url, data={"chat_id": CHAT_ID, "text": msg, "parse_mode": "Markdown"}, timeout=10)
        print(f"Telegram OK: {msg[:60]}")
    except Exception as e:
        print(f"Telegram fail: {e}")

def get_exchange():
    for ex_id in EXCHANGE_IDS:
        try:
            ex = getattr(ccxt, ex_id)()
            ex.load_markets()
            print(f"OK {ex_id}")
            return ex
        except: continue
    raise Exception("No exchange")

def check_long(df):
    df=df.copy()
    df['high50']=df['h'].rolling(50).max().shift(1)
    df['ema50']=df['c'].ewm(span=50).mean().shift(1)
    df['change4']=(df['c']-df['c'].shift(4))/df['c'].shift(4)*100
    if len(df)<52: return None
    last, prev = df.iloc[-1], df.iloc[-2]
    if prev['c']<=prev['high50'] and last['c']>last['high50'] and last['v']>VOLUME_THRESHOLD and last['change4']<CHANGE_PCT_THRESHOLD and last['c']>last['ema50']:
        return {"side":"LONG","price":float(last['c']),"level":float(last['high50'])}
    return None

def check_short(df):
    df=df.copy()
    df['low50']=df['l'].rolling(50).min().shift(1)
    df['ema50']=df['c'].ewm(span=50).mean().shift(1)
    df['change4']=(df['c']-df['c'].shift(4))/df['c'].shift(4)*100
    if len(df)<52: return None
    last, prev = df.iloc[-1], df.iloc[-2]
    if prev['c']>=prev['low50'] and last['c']<last['low50'] and last['v']>VOLUME_THRESHOLD and last['change4']>-CHANGE_PCT_THRESHOLD and last['c']<last['ema50']:
        return {"side":"SHORT","price":float(last['c']),"level":float(last['low50'])}
    return None

def get_top_symbols(ex):
    tickers=ex.fetch_tickers()
    all_usdt=[]
    for s in ex.symbols:
        if 'USDT' not in s: continue
        base=s.split('/')[0].split(':')[0]
        if base.startswith('R') and len(base)>=4 and base.isupper() and base not in ['RNDR','RUNE','RAY','RON','ROSE','RLC','RSR','RARE','RENDER']:
            continue
        all_usdt.append(s)
    return sorted(all_usdt, key=lambda x: tickers.get(x,{}).get('quoteVolume',0) or 0, reverse=True)[:TOP_SYMBOLS_LIMIT]

ex=get_exchange()
symbols=get_top_symbols(ex)
print(f"Scanning {len(symbols)} coins...")
found=0
for sym in symbols:
    try:
        ohlcv=ex.fetch_ohlcv(sym, TIMEFRAME, limit=60)
        df=pd.DataFrame(ohlcv, columns=['t','o','h','l','c','v'])
        sig=check_long(df) or check_short(df)
        if sig:
            found+=1
            msg=f"🚨 *RULE #7*\n*{sig['side']}* | {sym}\nPrice: {sig['price']}\nBreak: {sig['level']}\n500 coins scan"
            print(f">>> {sig['side']} | {sym}")
            send_telegram(msg)
    except: continue

if found==0:
    print("No signals - 500 coins scanned")
else:
    send_telegram(f"✅ Done: {found} signals in 500 coins")
