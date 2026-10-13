const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim();
if (!BOT_TOKEN ||!CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN / CHAT_ID missing");

const TIERS = { LONG1: -0.003, LONG2: -0.005, SHORT1: 0.003, SHORT2: 0.005 };
const VOL_MIN = 20_000_000;
const BLACKLIST = ['USDC', 'BUSD', 'OIL', 'GOLD', 'SILVER'];

// JAAN NAYA LOGIC - COOLDOWN SYSTEM
const COOLDOWN_HOURS = 3;
const sentCoins: Record<string, number> = {}; // symbol + ex -> timestamp

async function sendTelegram(msg: string) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
    });
  } catch(e){ console.log("Telegram error", e); }
}

async function getBitget() {
  const url = `https://api.bitget.com/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES`;
  const tickerUrl = `https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES`;
  const [f, t]: any = await Promise.all([
    fetch(url).then(r=>r.json()),
    fetch(tickerUrl).then(r=>r.json())
  ]);
  return { exchange: 'BITGET', funding: f.data || [], tickers: t.data || [] };
}

async function getBinance() {
  const fundingUrl = `https://fapi.binance.com/fapi/v1/premiumIndex`;
  const tickerUrl = `https://fapi.binance.com/fapi/v1/ticker/24hr`;
  const [f, t]: any = await Promise.all([
    fetch(fundingUrl).then(r=>r.json()),
    fetch(tickerUrl).then(r=>r.json())
  ]);
  const fundingArr = Array.isArray(f)? f : [];
  const tickerArr = Array.isArray(t)? t : [];
  return { exchange: 'BINANCE', funding: fundingArr, tickers: tickerArr };
}

async function checkAll() {
  console.log("Scanning started...");
  const [bitget, binance] = await Promise.all([getBitget(), getBinance()]);

  let allCoins: any[] = [];

  // Bitget - ticker me change bhi lete hain Jaan
  const bgTickerMap: Record<string, {vol: number, change: number}> = {};
  (bitget.tickers || []).forEach((x:any)=> {
    bgTickerMap[x.symbol] = {
      vol: parseFloat(x.usdtVolume||x.quoteVolume||0),
      change: parseFloat(x.priceChange24h || x.chgUTC || 0) * 100
    }
  });
  (bitget.funding || []).forEach((x:any)=>{
    if(!x.symbol) return;
    const info = bgTickerMap[x.symbol] || {vol:0, change:0};
    allCoins.push({ symbol: x.symbol, funding: parseFloat(x.fundingRate), vol: info.vol, change: info.change, ex: 'BITGET' });
  });

  // Binance
  const bnTickerMap: Record<string, {vol: number, change: number}> = {};
  (binance.tickers || []).forEach((x:any)=> {
    bnTickerMap[x.symbol] = {
      vol: parseFloat(x.quoteVolume||0),
      change: parseFloat(x.priceChangePercent||0)
    }
  });
  (binance.funding || []).forEach((x:any)=>{
    if(!x.symbol?.includes('USDT')) return;
    const info = bnTickerMap[x.symbol] || {vol:0, change:0};
    allCoins.push({ symbol: x.symbol, funding: parseFloat(x.lastFundingRate), vol: info.vol, change: info.change, ex: 'BINANCE' });
  });

  console.log(`Total Scanned: ${allCoins.length}`);

  let alerts = 0;
  for(let coin of allCoins){
    if(!coin.symbol.includes('USDT')) continue;
    if(BLACKLIST.some(b=>coin.symbol.includes(b))) continue;
    if(isNaN(coin.funding) || isNaN(coin.vol)) continue;
    if(coin.vol < VOL_MIN) continue;

    // JAAN NAYA - COOLDOWN CHECK - 3 ghante me ek hi baar
    const key = `${coin.symbol}_${coin.ex}`;
    if(sentCoins[key]){
      const hoursPassed = (Date.now() - sentCoins[key]) / (1000 * 3600);
      if(hoursPassed < COOLDOWN_HOURS){
        continue; // Skip - abhi 3 ghante nahi hue
      }
    }

    let type = null, tier = null, extraMsg = "";

    // JAAN NAYA - PUMP SE PEHLE WALA LOGIC
    if(coin.funding <= TIERS.LONG2){
      // STRONG LONG - lekin sirf tab jab -5% se zyada gira ho (DUMP ke beech me)
      if(coin.change <= -5){
        type="STRONG LONG";
        tier="🔥🔥 SUPER SHORT SQUEEZE -0.5%";
        extraMsg = `📉 Dump: ${coin.change.toFixed(1)}% | BUYERS AA RAHE HAIN`;
      } else {
        continue; // Pump ho chuka hai, skip karo
      }
    }
    else if(coin.funding <= TIERS.LONG1){
      if(coin.change <= -3){ // -3% se zyada gira ho
        type="LONG";
        tier="🔥 SHORT SQUEEZE -0.3%";
        extraMsg = `📉 Dump: ${coin.change.toFixed(1)}% | PUMP SE PEHLE`;
      } else {
        continue;
      }
    }
    else if(coin.funding >= TIERS.SHORT2){
      if(coin.change >= 5){
        type="STRONG SHORT";
        tier="❄️❄️ SUPER LONG SQUEEZE +0.5%";
        extraMsg = `📈 Pump: +${coin.change.toFixed(1)}% | SELLERS AA RAHE HAIN`;
      } else {
        continue;
      }
    }
    else if(coin.funding >= TIERS.SHORT1){
      if(coin.change >= 3){
        type="SHORT";
        tier="❄️ LONG SQUEEZE +0.3%";
        extraMsg = `📈 Pump: +${coin.change.toFixed(1)}% | DUMP SE PEHLE`;
      } else {
        continue;
      }
    }
    else continue;

    const msg = `${tier}\n${type} | ${coin.symbol} | ${coin.ex}\n\n💰 Funding: ${(coin.funding*100).toFixed(4)}%\n📊 Vol: $${(coin.vol/1e6).toFixed(1)}M\n${extraMsg}`;
    console.log(msg);
    await sendTelegram(msg);
    sentCoins[key] = Date.now(); // Cooldown set
    alerts++;
    await new Promise(r=>setTimeout(r, 400));
  }

  if(alerts===0) console.log("No squeeze found - All normal (Cooldown active or no dump/pump)");
  console.log(`Done. Alerts: ${alerts} | Cooldown list: ${Object.keys(sentCoins).length} coins`);
}

checkAll().catch(e=>{ console.error(e); process.exit(1); });
