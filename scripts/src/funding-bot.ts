import * as fs from 'fs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim();
if (!BOT_TOKEN || !CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN / CHAT_ID missing");

// GitHub Actions ke liye single-run version - LOOP NAHI HAI
const TIERS = { LONG1: -0.0015, LONG2: -0.003, SHORT1: 0.0015, SHORT2: 0.003, LONG_MED: -0.0008, SHORT_MED: 0.0008 };
const VOL_MIN = 5_000_000; // 10M se 5M kiya taaki zyada alerts aayen
const BLACKLIST = ['USDC', 'BUSD', 'OIL', 'GOLD', 'SILVER'];

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

async function checkAll() {
  console.log("Scanning 400+ LIVE (Single Run)...");
  const [bitget, binance] = await Promise.all([getBitget(), getBinance()]);
  let allCoins: any[] = [];

  const bgTickerMap: Record<string, any> = {};
  (bitget.tickers || []).forEach((x: any) => { bgTickerMap[x.symbol] = { vol: parseFloat(x.usdtVolume || 0), change: parseFloat(x.chgUTC || 0) * 100, price: parseFloat(x.lastPr || 0) } });
  (bitget.funding || []).forEach((x: any) => { if (!x.symbol) return; const info = bgTickerMap[x.symbol] || { vol: 0, change: 0, price: 0 }; allCoins.push({ symbol: x.symbol, funding: parseFloat(x.fundingRate), vol: info.vol, change: info.change, price: info.price, ex: 'BITGET' }); });

  const bnTickerMap: Record<string, any> = {};
  (binance.tickers || []).forEach((x: any) => { bnTickerMap[x.symbol] = { vol: parseFloat(x.quoteVolume || 0), change: parseFloat(x.priceChangePercent || 0), price: parseFloat(x.lastPrice || 0) } });
  (binance.funding || []).forEach((x: any) => { if (!x.symbol?.includes('USDT')) return; const info = bnTickerMap[x.symbol] || { vol: 0, change: 0, price: 0 }; allCoins.push({ symbol: x.symbol, funding: parseFloat(x.lastFundingRate), vol: info.vol, change: info.change, price: info.price, ex: 'BINANCE' }); });

  console.log(`Total Scanned: ${allCoins.length}`);

  const scoredCoins: any[] = [];

  for (let coin of allCoins) {
    if (!coin.symbol.includes('USDT')) continue;
    if (BLACKLIST.some(b => coin.symbol.includes(b))) continue;
    if (isNaN(coin.funding) || isNaN(coin.vol)) continue;
    if (coin.vol < VOL_MIN) continue;

    let score = 0; let reasons: string[] = []; let type = ""; let tier = "";

    if (coin.funding <= TIERS.LONG2) { score += 3; tier = "🔥🔥 SUPER SHORT SQUEEZE"; type = "STRONG LONG"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }
    else if (coin.funding <= TIERS.LONG1) { score += 2; tier = "🔥 SHORT SQUEEZE"; type = "LONG"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }
    else if (coin.funding <= TIERS.LONG_MED) { score += 1; tier = "⚡ Early LONG"; type = "Early LONG"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }
    else if (coin.funding >= TIERS.SHORT2) { score += 3; tier = "❄️❄️ SUPER LONG SQUEEZE"; type = "STRONG SHORT"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }
    else if (coin.funding >= TIERS.SHORT1) { score += 2; tier = "❄️ LONG SQUEEZE"; type = "SHORT"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }
    else if (coin.funding >= TIERS.SHORT_MED) { score += 1; tier = "⚡ Early SHORT"; type = "Early SHORT"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }

    if (type.includes("LONG") && coin.change <= -2) { score += 2; reasons.push(`Dump ${coin.change.toFixed(1)}% PUMP SE PEHLE`); }
    else if (type.includes("LONG") && coin.change <= -0.5) { score += 1; reasons.push(`Dump ${coin.change.toFixed(1)}%`); }
    if (type.includes("SHORT") && coin.change >= 2) { score += 2; reasons.push(`Pump +${coin.change.toFixed(1)}% DUMP SE PEHLE`); }
    else if (type.includes("SHORT") && coin.change >= 0.5) { score += 1; reasons.push(`Pump +${coin.change.toFixed(1)}%`); }

    if (coin.vol > 30_000_000) { score += 2; reasons.push(`High Vol $${(coin.vol / 1e6).toFixed(0)}M`); }
    else if (coin.vol > 10_000_000) { score += 1; }

    // Score 2+ par hi alert - taaki 0 alerts na aaye
    if (score >= 2) scoredCoins.push({ ...coin, score, tier, type, reasons });
  }

  scoredCoins.sort((a, b) => b.score - a.score);
  const toSend = scoredCoins.slice(0, 10);

  if (toSend.length === 0) {
    console.log("No squeeze found - Market Normal");
    // Agar 0 alerts hain to top funding wala 1 info bhej do taaki pata chale bot zinda hai
    const best = allCoins.filter(c => c.vol > VOL_MIN).sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding))[0];
    if (best) {
      console.log(`Top Funding: ${best.symbol} ${(best.funding*100).toFixed(4)}%`);
    }
  } else {
    for (let coin of toSend) {
      const emoji = coin.score >= 5 ? "🚀" : coin.score >= 3 ? "🔥" : "⚡";
      const msg = `${emoji} ${coin.tier}\n*SCORE ${coin.score}/8 | ${coin.type} | ${coin.symbol} | ${coin.ex}*\n\n💰 Price: $${coin.price}\n💸 Funding: ${(coin.funding * 100).toFixed(4)}%\n📊 Vol: $${(coin.vol / 1e6).toFixed(1)}M\n📈 24h: ${coin.change.toFixed(2)}%\n\n${coin.reasons.join("\n")}\n\n⏰ ${new Date().toLocaleTimeString()}`;
      console.log(msg);
      await sendTelegram(msg);
      await new Promise(r => setTimeout(r, 400));
    }
  }

  console.log(`Done. Alerts: ${toSend.length} / Scanned: ${allCoins.length}`);
}

// GitHub Actions ke liye sirf ek baar chalega, loop nahi
checkAll().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
