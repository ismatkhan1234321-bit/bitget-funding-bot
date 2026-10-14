import * as fs from 'fs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim();
if (!BOT_TOKEN || !CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN / CHAT_ID missing");

const TIERS = { LONG1: -0.001, LONG2: -0.003, SHORT1: 0.001, SHORT2: 0.003, LONG_MED: -0.0006, SHORT_MED: 0.0006 };
const VOL_MIN = 8_000_000;
const BLACKLIST = ['USDC', 'BUSD', 'OIL', 'GOLD', 'SILVER'];
const MAJORS_LOW_FILTER = ['BTCUSDT', 'ETHUSDT']; // Inko sirf high score par

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
  console.log("Scanning LIVE - Clean Alerts...");
  const [bitget, binance] = await Promise.all([getBitget(), getBinance()]);
  let allCoins: any[] = [];

  const bgTickerMap: Record<string, any> = {};
  (bitget.tickers || []).forEach((x: any) => { 
    // Bitget 24h change fix - chgUTC is like -0.012 = -1.2%
    const changeRaw = parseFloat(x.chgUTC || 0);
    const change = Math.abs(changeRaw) < 1 ? changeRaw * 100 : changeRaw;
    bgTickerMap[x.symbol] = { vol: parseFloat(x.usdtVolume || 0), change: change, price: parseFloat(x.lastPr || 0) } 
  });
  (bitget.funding || []).forEach((x: any) => { 
    if (!x.symbol) return; 
    const info = bgTickerMap[x.symbol] || { vol: 0, change: 0, price: 0 }; 
    allCoins.push({ symbol: x.symbol, funding: parseFloat(x.fundingRate), vol: info.vol, change: info.change, price: info.price, ex: 'BITGET' }); 
  });

  const bnTickerMap: Record<string, any> = {};
  (binance.tickers || []).forEach((x: any) => { bnTickerMap[x.symbol] = { vol: parseFloat(x.quoteVolume || 0), change: parseFloat(x.priceChangePercent || 0), price: parseFloat(x.lastPrice || 0) } });
  (binance.funding || []).forEach((x: any) => { 
    if (!x.symbol?.includes('USDT')) return; 
    const info = bnTickerMap[x.symbol] || { vol: 0, change: 0, price: 0 }; 
    allCoins.push({ symbol: x.symbol, funding: parseFloat(x.lastFundingRate), vol: info.vol, change: info.change, price: info.price, ex: 'BINANCE' }); 
  });

  console.log(`Total Scanned: ${allCoins.length}`);
  const scoredCoins: any[] = [];

  for (let coin of allCoins) {
    if (!coin.symbol.includes('USDT')) continue;
    if (BLACKLIST.some(b => coin.symbol.includes(b))) continue;
    if (isNaN(coin.funding) || isNaN(coin.vol)) continue;
    if (coin.vol < VOL_MIN) continue;
    // BTC/ETH ko low score par ignore karo
    if (MAJORS_LOW_FILTER.includes(coin.symbol) && Math.abs(coin.funding) < 0.001) continue;

    let score = 0; let reasons: string[] = []; let type = ""; let tier = "";

    if (coin.funding <= TIERS.LONG2) { score += 3; tier = "🔥🔥 SUPER SHORT SQUEEZE"; type = "STRONG LONG"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}% (Extreme)`); }
    else if (coin.funding <= TIERS.LONG1) { score += 2; tier = "🔥 SHORT SQUEEZE"; type = "LONG"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }
    else if (coin.funding <= TIERS.LONG_MED) { score += 1; tier = "⚡ Early LONG"; type = "Early LONG"; }
    else if (coin.funding >= TIERS.SHORT2) { score += 3; tier = "❄️❄️ SUPER LONG SQUEEZE"; type = "STRONG SHORT"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}% (Extreme)`); }
    else if (coin.funding >= TIERS.SHORT1) { score += 2; tier = "❄️ LONG SQUEEZE"; type = "SHORT"; reasons.push(`Funding ${(coin.funding * 100).toFixed(4)}%`); }
    else if (coin.funding >= TIERS.SHORT_MED) { score += 1; tier = "⚡ Early SHORT"; type = "Early SHORT"; }

    if (type.includes("LONG") && coin.change <= -2.5) { score += 2; reasons.push(`Dump ${coin.change.toFixed(1)}% -> PUMP Expected`); }
    else if (type.includes("LONG") && coin.change <= -0.8) { score += 1; }
    if (type.includes("SHORT") && coin.change >= 2.5) { score += 2; reasons.push(`Pump +${coin.change.toFixed(1)}% -> DUMP Expected`); }
    else if (type.includes("SHORT") && coin.change >= 0.8) { score += 1; }

    if (coin.vol > 30_000_000) { score += 1; }

    // Quality filter: kam se kam funding 0.06% ho ya score 3+ ho
    if (Math.abs(coin.funding) < 0.0006 && score < 3) continue;

    if (score >= 3) scoredCoins.push({ ...coin, score, tier, type, reasons });
  }

  scoredCoins.sort((a, b) => b.score - a.score);
  // Top 5 hi bhejo, quality alerts - pehle 10 bhej rahe the isliye BTC jaisa low quality bhi aa gaya
  const toSend = scoredCoins.slice(0, 5);

  if (toSend.length === 0) {
    console.log("Market Normal - No strong squeeze");
  } else {
    for (let coin of toSend) {
      const emoji = coin.score >= 5 ? "🚀" : coin.score >= 4 ? "🔥" : "⚡";
      const direction = coin.type.includes("LONG") ? "LONG 🟢" : "SHORT 🔴";
      const msg = `${emoji} ${coin.tier}\n*SCORE ${coin.score}/8 | ${direction} | ${coin.symbol} | ${coin.ex}*\n\n💰 Price: $${coin.price}\n💸 Funding: ${(coin.funding * 100).toFixed(4)}%\n📊 Vol: $${(coin.vol / 1e6).toFixed(1)}M\n📈 24h: ${coin.change.toFixed(2)}%\n\n${coin.reasons.join("\n")}\n\n⏰ ${new Date().toLocaleTimeString()}`;

      console.log(msg);
      await sendTelegram(msg);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  console.log(`Done. Alerts: ${toSend.length} / Scanned: ${allCoins.length}`);
}

checkAll().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
