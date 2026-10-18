const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim();
if (!BOT_TOKEN || !CHAT_ID) throw new Error("TOKEN MISSING");

const VOL_MIN = 15_000_000; 
let sentCoins: Record<string, number> = {};
let watchlist: Record<string, number> = {}; // Naya Watchlist System

async function send(msg: string) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'Markdown' })
    });
  } catch(e){ console.log(e); }
}

async function main() {
  console.log("Scanning...");
  
  const fRes = await fetch("https://fapi.binance.com/fapi/v1/premiumIndex");
  const tRes = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");

  const fData: any = await fRes.json();
  const tData: any = await tRes.json();

  const fList = Array.isArray(fData) ? fData : [];
  const tList = Array.isArray(tData) ? tData : [];
  if (fList.length === 0 || tList.length === 0) return;

  const map: any = {};
  tList.forEach((x: any) => map[x.symbol] = x);

  let alerts = 0;
  const now = Date.now();

  for (let x of fList) {
    const sym = x.symbol;
    if (!sym || !sym.includes('USDT')) continue;
    const tk = map[sym];
    if (!tk) continue;

    const funding = parseFloat(x.lastFundingRate);
    const vol = parseFloat(tk.quoteVolume);
    const chg24h = parseFloat(tk.priceChangePercent);
    const last = parseFloat(tk.lastPrice);

    if (isNaN(funding) || isNaN(vol) || vol < VOL_MIN) continue;
    
    // 3 ghante ka cooldown
    if (sentCoins[sym] && (now - sentCoins[sym]) < 3 * 3600 * 1000) continue;

    // --- STEP 1: WATCHLIST ME DAALO (Relaxed Filters) ---
    // Agar coin 3% se zyada gira hai aur funding negative hai, toh watchlist me daalo
    if (chg24h <= -3 && chg24h > -20 && funding < -0.001) {
      // Agar pehle se watchlist me nahi hai, toh daalo
      if (!watchlist[sym]) {
        watchlist[sym] = now;
        console.log(`Added to Watchlist: ${sym} (Dump: ${chg24h}%, Funding: ${funding})`);
        continue; // Agli baar check karenge
      }
    }

    // Watchlist se 6 ghante purane coins hata do
    if (watchlist[sym] && (now - watchlist[sym]) > 6 * 3600 * 1000) {
      delete watchlist[sym];
      continue;
    }

    // --- STEP 2: TRIGGER CHECK (Sirf Watchlist walo ke liye) ---
    if (watchlist[sym]) {
      try {
        const klineRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=25`);
        const klines: any = await klineRes.json();

        if (klines && klines.length > 20) {
          const closes = klines.map((k: any) => parseFloat(k[4]));
          const opens = klines.map((k: any) => parseFloat(k[1]));
          
          const currentClose = closes[closes.length - 1];
          const currentOpen = opens[opens.length - 1];

          // 20 EMA calculate karo (short term trend ke liye)
          const recentCloses = closes.slice(-20);
          const ema20 = recentCloses.reduce((a: number, b: number) => a + b, 0) / 20;

          const isGreenCandle = currentClose > currentOpen;
          const isAboveEma20 = currentClose > ema20;

          // Agar Green Candle hai aur price 20 EMA ke upar hai -> ALERT!
          if (isGreenCandle && isAboveEma20) {
            text = `🔥 *SQUEEZE REVERSAL DETECTED* 🔥\n\n*${sym}*\nDump: ${chg24h.toFixed(2)}%\nFunding: ${(funding*100).toFixed(4)}%\nVol: $${(vol/1e6).toFixed(1)}M\nPrice: ${last}\n\n*Action: 15m Green Candle + Above EMA20. Entry le sakte hain!*`;
            
            await send(text);
            sentCoins[sym] = now;
            delete watchlist[sym]; // Alert ke baad watchlist se nikal do
            alerts++;
            await new Promise(r => setTimeout(r, 400));
          }
        }
      } catch (err) {}
    }
  }
  console.log(`Done. Alerts: ${alerts} | Watchlist Size: ${Object.keys(watchlist).length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
