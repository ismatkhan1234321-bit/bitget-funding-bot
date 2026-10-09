import { access, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ccxt from "ccxt";
import { logger } from "./logger";

const POLL_INTERVAL_MS = 15 * 60 * 1000;
const ERROR_RETRY_INTERVAL_MS = 60 * 1000;
const FUNDING_TIERS = {
  longTier1: -0.003,
  longTier2: -0.005,
  shortTier1: 0.003,
  shortTier2: 0.005,
} as const;
const MIN_QUOTE_VOLUME_USDT = 30_000_000;
const OI_MIN_INCREASE = 2;
const MARKET_PARAMS = { productType: "USDT-FUTURES" };
const BLACKLIST = ["BZ", "SOXL", "OIL", "GOLD", "SILVER", "SPX", "NDX", "DXY"];
const TRADE_LOG_PATH = path.resolve(process.cwd(), "trade_log.csv");
const TRADE_LOG_HEADER =
  "timestamp,symbol,funding_percent,volume_usdt,alert_type,price,ma25,oi_change_percent\n";

const exchange = new ccxt.bitget({
  enableRateLimit: true,
  timeout: 10_000,
  options: { defaultType: "swap" },
});
const oiHistory = new Map<string, number>();
let tradeLogReady = false;

type AlertType = "LONG" | "STRONG LONG" | "SHORT" | "STRONG SHORT";

interface FundingTier {
  alertType: AlertType;
  tierText: string;
  strong: boolean;
  direction: "LONG" | "SHORT";
}

interface MovingAverages {
  lastPrice: number;
  ma25: number;
  ma7: number;
}

class TelegramDeliveryError extends Error {}

function getRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} environment variable is required.`);
  }

  return value;
}

async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new TelegramDeliveryError("Telegram request failed.");
  }

  if (!response.ok) {
    let description = `HTTP ${response.status}`;
    try {
      const errorBody = (await response.json()) as { description?: unknown };
      if (typeof errorBody.description === "string") {
        description = errorBody.description
          .replaceAll(botToken, "[redacted]")
          .replaceAll(chatId, "[redacted]")
          .slice(0, 200);
      }
    } catch {
      // Keep the HTTP status as the error when Telegram does not return JSON.
    }
    throw new TelegramDeliveryError(
      `Telegram rejected the alert: ${description}.`,
    );
  }

  const result = (await response.json()) as { ok?: unknown };
  if (result.ok !== true) {
    throw new TelegramDeliveryError("Telegram did not accept the alert.");
  }
}

function isCryptoOnly(symbol: string): boolean {
  const normalized = symbol.toUpperCase();
  return (
    normalized.includes("USDT") &&
    !BLACKLIST.some((blockedName) => normalized.includes(blockedName))
  );
}

function getFundingTier(fundingRate: number): FundingTier | null {
  if (fundingRate <= FUNDING_TIERS.longTier2) {
    return {
      alertType: "STRONG LONG",
      tierText: "🔥🔥 SUPER SHORT SQUEEZE (-0.5%)",
      strong: true,
      direction: "LONG",
    };
  }
  if (fundingRate <= FUNDING_TIERS.longTier1) {
    return {
      alertType: "LONG",
      tierText: "🔥 SHORT SQUEEZE (-0.3%)",
      strong: false,
      direction: "LONG",
    };
  }
  if (fundingRate >= FUNDING_TIERS.shortTier2) {
    return {
      alertType: "STRONG SHORT",
      tierText: "❄️❄️ SUPER LONG SQUEEZE (+0.5%)",
      strong: true,
      direction: "SHORT",
    };
  }
  if (fundingRate >= FUNDING_TIERS.shortTier1) {
    return {
      alertType: "SHORT",
      tierText: "❄️ LONG SQUEEZE (+0.3%)",
      strong: false,
      direction: "SHORT",
    };
  }
  return null;
}

async function getMovingAverages(
  symbol: string,
): Promise<MovingAverages | null> {
  try {
    const candles = await exchange.fetchOHLCV(
      symbol,
      "15m",
      undefined,
      30,
      MARKET_PARAMS,
    );
    const closes = candles
      .map((candle) => candle[4])
      .filter((close): close is number => Number.isFinite(close));

    if (closes.length < 25) {
      return null;
    }

    const mean = (values: number[]) =>
      values.reduce((total, value) => total + value, 0) / values.length;
    return {
      lastPrice: closes[closes.length - 1]!,
      ma25: mean(closes.slice(-25)),
      ma7: mean(closes.slice(-7)),
    };
  } catch (error) {
    logger.warn(
      { symbol, error: error instanceof Error ? error.message : "Unknown error" },
      "Unable to fetch Bitget candles",
    );
    return null;
  }
}

function formatPaktTimestamp(date: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Karachi",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );

  return `${parts["day"]}-${parts["month"]} ${parts["hour"]}:${parts["minute"]}:${parts["second"]} PKT`;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function csvCell(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function appendTradeLog(values: Array<string | number>): Promise<void> {
  if (!tradeLogReady) {
    try {
      await access(TRADE_LOG_PATH);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
      try {
        await writeFile(TRADE_LOG_PATH, TRADE_LOG_HEADER, {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (writeError) {
        if (!isErrorCode(writeError, "EEXIST")) {
          throw writeError;
        }
      }
    }
    tradeLogReady = true;
  }

  const row = values.map(csvCell).join(",") + "\n";
  await appendFile(TRADE_LOG_PATH, row, "utf8");
}

async function checkSymbol(
  symbol: string,
  fundingRate: number,
  volume: number,
  tier: FundingTier,
  botToken: string,
  chatId: string,
): Promise<boolean> {
  if (!isCryptoOnly(symbol) || volume < MIN_QUOTE_VOLUME_USDT) {
    return false;
  }

  const averages = await getMovingAverages(symbol);
  if (!averages) {
    return false;
  }
  if (!tier.strong) {
    if (tier.direction === "LONG" && averages.lastPrice < averages.ma25) {
      logger.info({ symbol }, "Signal skipped: price is below MA25 for LONG");
      return false;
    }
    if (tier.direction === "SHORT" && averages.lastPrice > averages.ma25) {
      logger.info({ symbol }, "Signal skipped: price is above MA25 for SHORT");
      return false;
    }
  }

  let openInterest: number;
  try {
    const oiData = await exchange.fetchOpenInterest(symbol, MARKET_PARAMS);
    openInterest = Number(oiData.openInterestAmount);
  } catch (error) {
    logger.warn(
      { symbol, error: error instanceof Error ? error.message : "Unknown error" },
      "Unable to fetch open interest; signal skipped",
    );
    return false;
  }

  if (!Number.isFinite(openInterest) || openInterest <= 0) {
    logger.warn({ symbol }, "Open interest was unavailable; signal skipped");
    return false;
  }

  const previousOpenInterest = oiHistory.get(symbol);
  oiHistory.set(symbol, openInterest);
  const oiChange =
    previousOpenInterest !== undefined && previousOpenInterest !== 0
      ? ((openInterest - previousOpenInterest) / previousOpenInterest) * 100
      : null;

  if (!tier.strong && oiChange === null) {
    logger.info(
      { symbol },
      "Open-interest baseline saved; waiting for the next scan",
    );
    return false;
  }
  if (!tier.strong && oiChange !== null && oiChange < OI_MIN_INCREASE) {
    logger.info({ symbol, oiChange }, "Signal skipped: OI increase is below 2%");
    return false;
  }

  const fundingPercent = fundingRate * 100;
  const oiDisplay = oiChange === null ? "Baseline pending" : `${oiChange.toFixed(2)}%`;
  const passedCriteria = tier.strong
    ? "Crypto | Vol>30M | Strong tier (MA25 bypassed; OI available)"
    : "Crypto | Vol>30M | MA25 | OI>2%";
  const message =
    `${tier.tierText}\n` +
    `${tier.alertType} | ${symbol}\n\n` +
    `💰 Funding: ${fundingPercent.toFixed(4)}%\n` +
    `📊 Vol 24h: $${(volume / 1_000_000).toFixed(1)}M\n` +
    `📈 OI Change: ${oiDisplay}\n` +
    `💵 Price: ${averages.lastPrice}\n` +
    `MA7: ${averages.ma7.toFixed(4)} | MA25: ${averages.ma25.toFixed(4)}\n\n` +
    `✅ Passed: ${passedCriteria}\n` +
    `⏰ ${formatPaktTimestamp(new Date())} - 24H ACTIVE`;

  await sendTelegramMessage(botToken, chatId, message);
  try {
    await appendTradeLog([
      formatPaktTimestamp(new Date()),
      symbol,
      fundingPercent,
      volume,
      tier.alertType,
      averages.lastPrice,
      averages.ma25,
      oiChange ?? "",
    ]);
  } catch (error) {
    logger.error(
      { symbol, error: error instanceof Error ? error.message : "Unknown error" },
      "Alert was delivered, but trade log could not be saved",
    );
  }

  logger.info({ symbol, alertType: tier.alertType }, "Telegram funding alert sent");
  return true;
}

async function scanFunding(
  botToken: string,
  chatId: string,
): Promise<{ candidates: number; sent: number }> {
  const fundingRates = await exchange.fetchFundingRates(undefined, MARKET_PARAMS);
  const tickers = await exchange.fetchTickers(undefined, MARKET_PARAMS);
  let candidates = 0;
  let sent = 0;

  for (const [symbol, funding] of Object.entries(fundingRates)) {
    if (!isCryptoOnly(symbol)) {
      continue;
    }
    const fundingRate = Number(funding.fundingRate);
    const volume = Number(tickers[symbol]?.quoteVolume ?? 0);
    if (!Number.isFinite(fundingRate) || !Number.isFinite(volume)) {
      continue;
    }
    const tier = getFundingTier(fundingRate);
    if (!tier || volume < MIN_QUOTE_VOLUME_USDT) {
      continue;
    }

    candidates += 1;
    try {
      if (
        await checkSymbol(
          symbol,
          fundingRate,
          volume,
          tier,
          botToken,
          chatId,
        )
      ) {
        sent += 1;
      }
    } catch (error) {
      if (error instanceof TelegramDeliveryError) {
        logger.error(
          { symbol, error: error.message },
          "Unable to send Telegram funding alert; remaining alerts skipped this scan",
        );
        break;
      }
      logger.warn(
        { symbol, error: error instanceof Error ? error.message : "Unknown error" },
        "Unable to process funding candidate",
      );
    }
  }

  return { candidates, sent };
}

export function startFundingMonitor(): void {
  const botToken = getRequiredEnvironmentVariable("TELEGRAM_BOT_TOKEN");
  const chatId = getRequiredEnvironmentVariable("TELEGRAM_CHAT_ID");

  logger.info(
    {
      fundingTiers: FUNDING_TIERS,
      minimumQuoteVolumeUsdt: MIN_QUOTE_VOLUME_USDT,
      minimumOiIncreasePercent: OI_MIN_INCREASE,
      pollIntervalMs: POLL_INTERVAL_MS,
      blacklistEntries: BLACKLIST.length,
      exchange: "Bitget",
    },
    "Funding monitor started",
  );

  const poll = async (): Promise<void> => {
    let nextDelay = POLL_INTERVAL_MS;
    try {
      const result = await scanFunding(botToken, chatId);
      logger.info(result, "Funding scan complete; next scan in 15 minutes");
    } catch (error) {
      nextDelay = ERROR_RETRY_INTERVAL_MS;
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown error" },
        "Funding scan failed; retrying in 1 minute",
      );
    } finally {
      setTimeout(() => void poll(), nextDelay);
    }
  };

  void poll();
}
