import * as fs from 'fs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim();
if (!BOT_TOKEN || !CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN / CHAT_ID missing");

// ===== LIVE + ALAG-ALAG POINTS - Duplicate Fix =====
const TIERS = { LONG1: -0.002, LONG2: -0.004, SHORT1: 0.002, SHORT2: 0.004, LONG_MED: -0.001, SHORT_MED: 0.001 };
const VOL_MIN = 10_000_000;
const BLACKLIST = ['USDC', 'BUSD', 'OIL', 'GOLD', 'SILVER'];

const COOLDOWN_HOURS = 2;
const COOLDOWN_FILE = './cooldown.json';
const LAST_ALERT_FILE = './last_alerts.json'; // Naya: alag points ke liye

function loadJson(file: string): any {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return {};
}
function saveJson(file: string, data: any) { try { fs.writeFileSync(file, JSON.stringify(data)); } catch {} }

const sentCoins: Record<string, number> = loadJson(COOLDOWN_FILE);
const lastAlerts: Record<string, {price: number, funding: number, score: number}> = loadJson(LAST_ALERT_FILE);

async function sendTelegram(msg: string) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'Markdown' })
    });
  } catch (e) { console.log("Telegram error", e); }
}

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
async function getKlines(symbol: string) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=30`;
    const data: any = await fetch(url).then(r => r.json());
    const closes = data.map((c: any) => parseFloat(c[4]));
    return { closes };
  } catch { return { closes: [] }; }
}
function calcRSI(closes: number[]): number {
  if (closes.length < 15) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= 14; i++) { const d = closes[closes.length - i] - closes[closes.length - i - 1]; if (d > 0) gains += d; else losses -= d; }
  if (losses === 0) return 70;
  const rs = gains / (losses || 1);
  return 100 - (100 / (1 + rs));
}

async function checkAll() {
  console.log("Scanning 400+ LIVE...");
  const [bitget, binance] = await Promise.all([getBitget(), getBinance()]);
  let allCoins: any[] = [];

  const bgTickerMap: Record<string, any> = {};
  (bitget.tickers || []).forEach((x: any) => { bgTickerMap[x.symbol] = { vol: parseFloat(x.usdtVolume || 0), change: parseFloat(x.chgUTC || 0) * 100, price: parseFloat(x.lastPr || 0) } });
  (bitget.funding || []).forEach((x: any) => { if (!x.symbol) return; const info = bgTickerMap[x.symbol] || { vol: 0, change: 0, price: 0 }; allCoins.push({ symbol: x.symbol, funding: parseFloat(x.fundingRate), vol: info.vol, change: info.change, price: info.price, ex: 'BITGET' }); });

  const bnTickerMap: Record<string, any> = {};
  (binance.tickers || []).forEach((x: any) => { bnTickerMap[x.symbol] = { vol: parseFloat(x.quoteVolume || 0), change: parseFloat(x.priceChangePercent || 0), price: parseFloat(x.lastPrice || 0) } });
  (binance.funding || []).forEach((x: any) => { if (!x.symbol?.includes('USDT')) return; const info = bnTickerMap[x.symbol] || { vol: 0, change: 0, price: 0 }; allCoins.push({ symbol: x.symbol, funding: parseFloat(x.lastFundingRate), vol: info.vol, change: info.change, price: info.price, ex: 'BINANCE' }); });

  console.log(`Total: ${allCoins.length}`);

  const scoredCoins: any[] = [];

  for (let coin of allCoins) {
    if (!coin.symbol.includes('USDT')) continue;
    if (BLACKLIST.some(b => coin.symbol.includes(b))) continue;
    if (isNaN(coin.funding) || isNaN(coin.vol)) continue;
    if (coin.vol < VOL_MIN) continue;

    const key = `${coin.symbol}_${coin.ex}`;

    // ===== DUPLICATE FIX - Alag Points Logic =====
    if (sentCoins[key]) {
      const hoursPassed = (Date.now() - sentCoins[key]) / (1000 * 3600);
      const last = lastAlerts[key];
      
      if (last) {
        const priceDiff = Math.abs(coin.price - last.price) / last.price * 100;
        const fundingDiff = Math.abs(coin.funding - last.funding);
        const scoreDiff = Math.abs(0); // score abhi calculate nahi hua

        // Agar 2 ghante se pehle hai AUR price same hai (0.8% se kam move) AUR funding same hai, to SKIP
        if (hoursPassed < COOLDOWN_HOURS && priceDiff < 0.8 && fundingDiff < 0.0003) {
          continue; // same point bar bar nahi bhejna
        }
        // Agar price alag hai (0.8%+ move) to allow karo chahe cooldown me ho - ye naya point hai
      } else if (hoursPassed < COOLDOWN_HOURS) {
        continue;
      }
    }

    let score = 0; let reasons: string[] = []; let type = ""; let tier = "";

    if (coin.funding <= TIERS.LONG2) { score += 3; tier = "🔥🔥 SUPER SHORT SQUEEZE"; type = "STRONG LONG"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }
    else if (coin.funding <= TIERS.LONG1) { score += 2; tier = "🔥 SHORT SQUEEZE"; type = "LONG"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }
    else if (coin.funding <= TIERS.LONG_MED) { score += 1; tier = "⚡ Early LONG"; type = "Early LONG"; }
    else if (coin.funding >= TIERS.SHORT2) { score += 3; tier = "❄️❄️ SUPER LONG SQUEEZE"; type = "STRONG SHORT"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }
    else if (coin.funding >= TIERS.SHORT1) { score += 2; tier = "❄️ LONG SQUEEZE"; type = "SHORT"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }
    else if (coin.funding >= TIERS.SHORT_MED) { score += 1; tier = "⚡ Early SHORT"; type = "Early SHORT"; }

    if (type.includes("LONG") && coin.change <= -3) { score += 2; reasons.push(`Dump ${coin.change.toFixed(1)}% PUMP SE PEHLE`); }
    else if (type.includes("LONG") && coin.change <= -1) { score += 1; reasons.push(`Dump ${coin.change.toFixed(1)}%`); }
    if (type.includes("SHORT") && coin.change >= 3) { score += 2; reasons.push(`Pump +${coin.change.toFixed(1)}% DUMP SE PEHLE`); }
    else if (type.includes("SHORT") && coin.change >= 1) { score += 1; }

    if (coin.vol > 50_000_000) { score += 2; reasons.push(`Vol $${(coin.vol / 1e6).toFixed(0)}M`); }
    else if (coin.vol > 20_000_000) { score += 1; }

    if (score >= 2 && coin.ex === 'BINANCE') {
      const { closes } = await getKlines(coin.symbol);
      if (closes.length > 14) {
        const rsi = calcRSI(closes);
        if (type.includes("LONG") && rsi < 40) { score += 1; reasons.push(`RSI ${rsi.toFixed(0)} Oversold`); }
        if (type.includes("SHORT") && rsi > 65) { score += 1; reasons.push(`RSI ${rsi.toFixed(0)} Overbought`); }
      }
      await new Promise(r => setTimeout(r, 60));
    }

    if (score >= 3) scoredCoins.push({ ...coin, score, tier, type, reasons });
  }

  scoredCoins.sort((a, b) => b.score - a.score);
  const toSend = scoredCoins.slice(0, 10); // Top 10 only, alag points

  for (let coin of toSend) {
    const key = `${coin.symbol}_${coin.ex}`;
    const emoji = coin.score >= 6 ? "🚀" : coin.score >= 4 ? "🔥" : "⚡";
    
    // Naya point dikhane ke liye last price se farq batao
    const last = lastAlerts[key];
    let pointInfo = "";
    if (last) {
      const diff = ((coin.price - last.price) / last.price * 100).toFixed(2);
      pointInfo = `\n📍 Naya Point: Last alert se ${diff}% move | Last: $${last.price}`;
    }

    const msg = `${emoji} ${coin.tier}\n*SCORE ${coin.score}/8 | ${coin.type} | ${coin.symbol} | ${coin.ex}*\n\n💰 Price: $${coin.price}\n💸 Funding: ${(coin.funding * 100).toFixed(4)}%\n📊 Vol: $${(coin.vol / 1e6).toFixed(1)}M\n📈 24h: ${coin.change.toFixed(2)}%\n\n${coin.reasons.join("\n")}${pointInfo}\n\n⏰ ${new Date().toLocaleTimeString()}`;

    console.log(msg);
    await sendTelegram(msg);
    
    // Save karo taaki next time pata chale ye point pehle bheja tha
    sentCoins[key] = Date.now();
    lastAlerts[key] = { price: coin.price, funding: coin.funding, score: coin.score };
    saveJson(COOLDOWN_FILE, sentCoins);
    saveJson(LAST_ALERT_FILE, lastAlerts);
    
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`Done. Alerts: ${toSend.length}`);
}

async function loop() {
  while (true) {
    try { await checkAll(); } catch (e) { console.error(e); }
    console.log("Waiting 5 min for LIVE...");
    await new Promise(r => setTimeout(r, 300000)); // 5 min LIVE
  }
}

loop();
