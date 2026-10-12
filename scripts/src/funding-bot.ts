const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim();

if (!BOT_TOKEN || !CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN / CHAT_ID missing in secrets");

const TIERS = { LONG1: -0.003, LONG2: -0.005, SHORT1: 0.003, SHORT2: 0.005 };
const VOL_MIN = 20_000_000; // 50M bohat zyada tha Jaan, 20M kar diya
const BLACKLIST = ['USDC', 'BUSD', 'OIL', 'GOLD', 'SILVER'];

async function sendTelegram(msg: string) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'Markdown' })
  });
  if (!res.ok) console.log("Telegram fail:", await res.text());
}

// 1. BITGET - FIXED API
async function getBitget() {
  // ye wala endpoint 500 coins ek sath deta hai Jaan
  const url = `https://api.bitget.com/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES`;
  const tickerUrl = `https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES`;
  const [f, t]: any = await Promise.all([
    fetch(url).then(r=>r.json()), 
    fetch(tickerUrl).then(r=>r.json())
  ]);
  if(f.code !== '00000') throw new Error("Bitget funding fail: " + JSON.stringify(f));
  return { exchange: 'BITGET', funding: f.data || [], tickers: t.data || [] };
}

// 2. BINANCE
async function getBinance() {
  const fundingUrl = `https://fapi.binance.com/fapi/v1/premiumIndex`;
  const tickerUrl = `https://fapi.binance.com/fapi/v1/ticker/24hr`;
  const [f, t]: any = await Promise.all([
    fetch(fundingUrl).then(r=>r.json()), 
    fetch(tickerUrl).then(r=>r.json())
  ]);
  return { exchange: 'BINANCE', funding: f || [], tickers: t || [] };
}

async function checkAll() {
  console.log("Scanning started...");
  const [bitget, binance] = await Promise.all([getBitget(), getBinance()]);
  
  let allCoins: any[] = [];

  const bgTickerMap: Record<string, number> = {};
  bitget.tickers.forEach((x:any)=> bgTickerMap[x.symbol] = parseFloat(x.usdtVolume||x.quoteVolume||0));
  bitget.funding.forEach((x:any)=>{
    allCoins.push({ symbol: x.symbol, funding: parseFloat(x.fundingRate), vol: bgTickerMap[x.symbol]||0, ex: 'BITGET' });
  });

  const bnTickerMap: Record<string, number> = {};
  binance.tickers.forEach((x:any)=> bnTickerMap[x.symbol] = parseFloat(x.quoteVolume||0));
  binance.funding.forEach((x:any)=>{
    if(x.symbol?.includes('USDT')){
      allCoins.push({ symbol: x.symbol, funding: parseFloat(x.lastFundingRate), vol: bnTickerMap[x.symbol]||0, ex: 'BINANCE' });
    }
  });

  console.log(`Total Scanned: ${allCoins.length} coins (Bitget ${bitget.funding.length} + Binance ${binance.funding.length})`);

  let alerts = 0;
  for(let coin of allCoins){
    if(!coin.symbol.includes('USDT')) continue;
    if(BLACKLIST.some(b=>coin.symbol.includes(b))) continue;
    if(isNaN(coin.funding) || isNaN(coin.vol)) continue;
    if(coin.vol < VOL_MIN) continue;

    let type = null, tier = null;
    if(coin.funding <= TIERS.LONG2){ type="STRONG LONG"; tier="🔥🔥 SUPER SHORT SQUEEZE -0.5%"; }
    else if(coin.funding <= TIERS.LONG1){ type="LONG"; tier="🔥 SHORT SQUEEZE -0.3%"; }
    else if(coin.funding >= TIERS.SHORT2){ type="STRONG SHORT"; tier="❄️❄️ SUPER LONG SQUEEZE +0.5%"; }
    else if(coin.funding >= TIERS.SHORT1){ type="SHORT"; tier="❄️ LONG SQUEEZE +0.3%"; }
    else continue;

    const msg = `${tier}\n${type} | ${coin.symbol} | ${coin.ex}\n\n💰 Funding: ${(coin.funding*100).toFixed(4)}%\n📊 Vol: $${(coin.vol/1e6).toFixed(1)}M\n⏰ Scan: ${new Date().toISOString()}`;
    console.log(msg);
    await sendTelegram(msg);
    alerts++;
    await new Promise(r=>setTimeout(r, 400)); // telegram rate limit
  }
  
  if(alerts===0) console.log("No squeeze found this time - All funding normal");
  console.log(`Done. Alerts sent: ${alerts}`);
}

// GitHub Action ke liye single run Jaan
checkAll().catch(e=>{ console.error(e); process.exit(1); });
