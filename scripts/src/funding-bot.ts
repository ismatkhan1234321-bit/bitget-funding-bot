import * as fs from 'fs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim();
if (!BOT_TOKEN || !CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN / CHAT_ID missing");

// ===== UPGRADED TIERS - Ab 24h alerts pakke ayenge =====
const TIERS = { 
  LONG1: -0.002,  // pehle -0.003 tha, ab thoda easy kiya taaki alerts zyada aayen
  LONG2: -0.004,  // pehle -0.005 tha
  SHORT1: 0.002, 
  SHORT2: 0.004,
  // Naya: Medium tier for regular alerts
  LONG_MED: -0.001,
  SHORT_MED: 0.001
};
const VOL_MIN = 10_000_000; // pehle 20M tha, ab 10M kiya taaki 400 coins cover hon
const BLACKLIST = ['USDC', 'BUSD', 'OIL', 'GOLD', 'SILVER'];

const COOLDOWN_HOURS = 2; // 3 se 2 kiya, futures me jaldi move aata hai
const COOLDOWN_FILE = './cooldown.json';

function loadCooldown(): Record<string, number> {
  try { if (fs.existsSync(COOLDOWN_FILE)) return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8')); } catch {}
  return {};
}
function saveCooldown(data: Record<string, number>) { try { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(data)); } catch {} }
const sentCoins: Record<string, number> = loadCooldown();

async function sendTelegram(msg: string) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'Markdown' })
    });
  } catch (e) { console.log("Telegram error", e); }
}

// ===== DATA FETCH =====
async function getBitget() {
  const url = `https://api.bitget.com/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES`;
  const tickerUrl = `https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES`;
  const [f, t]: any = await Promise.all([fetch(url).then(r => r.json()), fetch(tickerUrl).then(r => r.json())]);
  return { exchange: 'BITGET', funding: f.data || [], tickers: t.data || [] };
}
async function getBinance() {
  const fundingUrl = `https://fapi.binance.com/fapi/v1/premiumIndex`;
  const tickerUrl = `https://fapi.binance.com/fapi/v1/ticker/24hr`;
  const [f, t]: any = await Promise.all([fetch(fundingUrl).then(r => r.json()), fetch(tickerUrl).then(r => r.json())]);
  return { exchange: 'BINANCE', funding: Array.isArray(f) ? f : [], tickers: Array.isArray(t) ? t : [] };
}

// Naya: Kline se RSI/EMA nikalne ke liye
async function getKlines(ex: string, symbol: string) {
  try {
    let url = "";
    if (ex === 'BINANCE') url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=30`;
    else return { closes: [], volumes: [] }; // Bitget kline thoda complex hai, Binance se kaam chalega
    const data: any = await fetch(url).then(r => r.json());
    const closes = data.map((c: any) => parseFloat(c[4]));
    const volumes = data.map((c: any) => parseFloat(c[5]));
    return { closes, volumes };
  } catch { return { closes: [], volumes: [] }; }
}
function calcRSI(closes: number[]): number {
  if (closes.length < 15) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= 14; i++) { const d = closes[closes.length - i] - closes[closes.length - i - 1]; if (d > 0) gains += d; else losses -= d; }
  if (losses === 0) return 70;
  const rs = gains / (losses || 1);
  return 100 - (100 / (1 + rs));
}

// ===== MAIN LOGIC - SCORE SYSTEM ADDED =====
async function checkAll() {
  console.log("Scanning 400+ coins...");
  const [bitget, binance] = await Promise.all([getBitget(), getBinance()]);
  let allCoins: any[] = [];

  const bgTickerMap: Record<string, any> = {};
  (bitget.tickers || []).forEach((x: any) => { bgTickerMap[x.symbol] = { vol: parseFloat(x.usdtVolume || 0), change: parseFloat(x.chgUTC || 0) * 100, price: parseFloat(x.lastPr || 0) } });
  (bitget.funding || []).forEach((x: any) => { if (!x.symbol) return; const info = bgTickerMap[x.symbol] || { vol: 0, change: 0, price: 0 }; allCoins.push({ symbol: x.symbol, funding: parseFloat(x.fundingRate), vol: info.vol, change: info.change, price: info.price, ex: 'BITGET' }); });

  const bnTickerMap: Record<string, any> = {};
  (binance.tickers || []).forEach((x: any) => { bnTickerMap[x.symbol] = { vol: parseFloat(x.quoteVolume || 0), change: parseFloat(x.priceChangePercent || 0), price: parseFloat(x.lastPrice || 0) } });
  (binance.funding || []).forEach((x: any) => { if (!x.symbol?.includes('USDT')) return; const info = bnTickerMap[x.symbol] || { vol: 0, change: 0, price: 0 }; allCoins.push({ symbol: x.symbol, funding: parseFloat(x.lastFundingRate), vol: info.vol, change: info.change, price: info.price, ex: 'BINANCE' }); });

  console.log(`Total Scanned: ${allCoins.length} (Bitget + Binance)`);

  let alerts = 0;
  const scoredCoins: any[] = [];

  for (let coin of allCoins) {
    if (!coin.symbol.includes('USDT')) continue;
    if (BLACKLIST.some(b => coin.symbol.includes(b))) continue;
    if (isNaN(coin.funding) || isNaN(coin.vol)) continue;
    if (coin.vol < VOL_MIN) continue;

    const key = `${coin.symbol}_${coin.ex}`;
    if (sentCoins[key]) {
      const hoursPassed = (Date.now() - sentCoins[key]) / (1000 * 3600);
      if (hoursPassed < COOLDOWN_HOURS) continue;
    }

    // ===== SCORE SYSTEM (Naya) =====
    let score = 0;
    let reasons: string[] = [];
    let type = "";
    let tier = "";

    // Funding Score
    if (coin.funding <= TIERS.LONG2) { score += 3; tier = "🔥🔥 SUPER SHORT SQUEEZE"; type = "STRONG LONG"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}% (Extreme -)`); }
    else if (coin.funding <= TIERS.LONG1) { score += 2; tier = "🔥 SHORT SQUEEZE"; type = "LONG"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }
    else if (coin.funding <= TIERS.LONG_MED) { score += 1; tier = "⚡ Early LONG"; type = "Early LONG"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }
    else if (coin.funding >= TIERS.SHORT2) { score += 3; tier = "❄️❄️ SUPER LONG SQUEEZE"; type = "STRONG SHORT"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}% (Extreme +)`); }
    else if (coin.funding >= TIERS.SHORT1) { score += 2; tier = "❄️ LONG SQUEEZE"; type = "SHORT"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }
    else if (coin.funding >= TIERS.SHORT_MED) { score += 1; tier = "⚡ Early SHORT"; type = "Early SHORT"; }

    // Dump / Pump Score (tumhara purana logic)
    if (type.includes("LONG") && coin.change <= -3) { score += 2; reasons.push(`Dump ${coin.change.toFixed(1)}% (PUMP SE PEHLE)`); }
    else if (type.includes("LONG") && coin.change <= -1) { score += 1; reasons.push(`Dump ${coin.change.toFixed(1)}%`); }
    if (type.includes("SHORT") && coin.change >= 3) { score += 2; reasons.push(`Pump +${coin.change.toFixed(1)}% (DUMP SE PEHLE)`); }
    else if (type.includes("SHORT") && coin.change >= 1) { score += 1; reasons.push(`Pump +${coin.change.toFixed(1)}%`); }

    // Volume Score (Naya)
    if (coin.vol > 50_000_000) { score += 2; reasons.push(`High Vol $${(coin.vol / 1e6).toFixed(0)}M`); }
    else if (coin.vol > 20_000_000) { score += 1; }

    // Early entry ke liye Binance wale coins par RSI check (optional, heavy nahi)
    if (score >= 2 && coin.ex === 'BINANCE') {
      // Sirf high score walo ka kline check karenge taaki API limit na lage
      const { closes } = await getKlines(coin.ex, coin.symbol);
      if (closes.length > 14) {
        const rsi = calcRSI(closes);
        if (type.includes("LONG") && rsi < 40) { score += 1; reasons.push(`RSI ${rsi.toFixed(0)} Oversold`); }
        if (type.includes("SHORT") && rsi > 65) { score += 1; reasons.push(`RSI ${rsi.toFixed(0)} Overbought`); }
      }
      await new Promise(r => setTimeout(r, 80)); // rate limit
    }

    if (score >= 3) { // Threshold 3 rakha taaki 24h me lazmi alerts aayen
      scoredCoins.push({ ...coin, score, tier, type, reasons });
    }
  }

  // Score ke hisab se sort karo, sabse best pehle
  scoredCoins.sort((a, b) => b.score - a.score);

  // Top 15 alerts bhejo har scan me (taaki spam na ho)
  const toSend = scoredCoins.slice(0, 15);

  // Agar ek bhi coin 3+ score ka nahi mila, to bhi 1 best coin ka "info" alert bhejo taaki 24h me lazmi alert aaye
  if (toSend.length === 0 && allCoins.length > 0) {
    const best = allCoins.filter(c => c.vol > VOL_MIN).sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding))[0];
    if (best) {
      const msg = `ℹ️ Market Normal - No Squeeze\nTop Funding: ${best.symbol} | ${(best.funding * 100).toFixed(4)}% | Vol $${(best.vol / 1e6).toFixed(1)}M\nTime: ${new Date().toLocaleTimeString()}`;
      console.log(msg);
      // Normal info alert optional hai, chaho to uncomment karo
      // await sendTelegram(msg);
    }
    console.log("No squeeze found - All normal");
  } else {
    for (let coin of toSend) {
      const emoji = coin.score >= 6 ? "🚀" : coin.score >= 4 ? "🔥" : "⚡";
      const msg = `${emoji} ${coin.tier}\n*SCORE ${coin.score}/8 | ${coin.type} | ${coin.symbol} | ${coin.ex}*\n\n💰 Price: $${coin.price}\n💸 Funding: ${(coin.funding * 100).toFixed(4)}%\n📊 Vol: $${(coin.vol / 1e6).toFixed(1)}M\n📈 24h: ${coin.change.toFixed(2)}%\n\n${coin.reasons.join("\n")}\n\n⏰ ${new Date().toLocaleTimeString()}`;

      console.log(msg);
      await sendTelegram(msg);
      sentCoins[`${coin.symbol}_${coin.ex}`] = Date.now();
      saveCooldown(sentCoins);
      alerts++;
      await new Promise(r => setTimeout(r, 400));
    }
  }

  console.log(`Done. Alerts: ${alerts} | Scanned: ${allCoins.length}`);
}

// 24/7 loop ke liye - har 3 min me scan
async function loop() {
  while (true) {
    try { await checkAll(); } catch (e) { console.error(e); }
    console.log("Waiting 3 min...");
    await new Promise(r => setTimeout(r, 180000));
  }
}

loop();
