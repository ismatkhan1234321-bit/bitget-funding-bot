import ccxt from "ccxt";
import { logger } from "./logger";

const POLL_INTERVAL_MS = 2 * 60 * 1000;
const MIN_VOLUME_USDT = 30_000_000;
const FUNDING_THRESHOLDS = {
  strongLong: -0.003,
  normalLong: -0.001,
  normalShort: 0.001,
  strongShort: 0.003,
} as const;

const exchange = new ccxt.binanceusdm({
  enableRateLimit: true,
  timeout: 10_000,
});

type AlertType = "NORMAL LONG" | "STRONG LONG" | "NORMAL SHORT" | "STRONG SHORT";

function getRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required.`);
  }
  return value;
}

function isUsdtPerpetual(symbol: string): boolean {
  const market = exchange.markets?.[symbol];
  return market?.swap === true && market.settle === "USDT";
}

function getAlertType(fundingRate: number): AlertType | null {
  if (fundingRate <= FUNDING_THRESHOLDS.strongLong) {
    return "STRONG LONG";
  }
  if (fundingRate <= FUNDING_THRESHOLDS.normalLong) {
    return "NORMAL LONG";
  }
  if (fundingRate >= FUNDING_THRESHOLDS.strongShort) {
    return "STRONG SHORT";
  }
  if (fundingRate >= FUNDING_THRESHOLDS.normalShort) {
    return "NORMAL SHORT";
  }
  return null;
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
    throw new Error("Telegram request failed.");
  }

  if (!response.ok) {
    throw new Error(`Telegram API returned HTTP ${response.status}.`);
  }

  const result = (await response.json()) as { ok?: unknown };
  if (result.ok !== true) {
    throw new Error("Telegram did not accept the alert.");
  }
}
function calculateSignalScore(fundingRate: number, volume: number): number {
  let score = 0;
  const absRate = Math.abs(fundingRate);
  if (absRate >= 0.003) score += 50;
  else if (absRate >= 0.001) score += 30;
  else score += 15;
  if (volume > 100_000_000) score += 50;
  else if (volume > 50_000_000) score += 30;
  else score += 20;
  return Math.min(score, 100);
}

function getSignalQuality(score: number): string {
  if (score >= 80) return "🔥 HIGH QUALITY - Strong Trade";
  if (score >= 60) return "✅ GOOD - Decent Trade";
  return "⚠️ LOW - Be Careful / Small Size";
}
async function scanFunding(
  botToken: string,
  chatId: string,
): Promise<{ candidates: number; sent: number }> {
  await exchange.loadMarkets();
  const fundingRates = await exchange.fetchFundingRates();
  const tickers = await exchange.fetchTickers();
  let candidates = 0;
  let sent = 0;

  for (const [symbol, funding] of Object.entries(fundingRates)) {
    if (!isUsdtPerpetual(symbol)) {
      continue;
    }

      try {
        const ticker = tickers[symbol];
        const fundingRate = (funding as any)?.fundingRate?? 0;
        const volume = ticker?.quoteVolume?? 0;

        if (Math.abs(fundingRate) < 0.0005) {
          continue;
        }

        const alertType = fundingRate > 0? "SHORT" : "LONG";

        candidates += 1;
        const fundingPercent = fundingRate * 100;
        const price = ticker?.last?? ticker?.close?? "Unavailable";
        const score = calculateSignalScore(fundingRate, volume);
        const quality = getSignalQuality(score);
        const message =
          `🚨 ${alertType} ALERT\n` +
          `${symbol}\n` +
          `Funding: ${fundingPercent.toFixed(3)}%\n` +
          `24h Volume: $${(volume / 1_000_000).toFixed(1)}M\n` +
          `Price: ${price}\n\n` +
          `📊 SCORE: ${score}/100\n` +
          `${quality}`;
    try {
      await sendTelegramMessage(botToken, chatId, message);
      sent += 1;
      logger.info({ symbol, alertType }, "Binance funding alert sent");
    } catch (error) {
      logger.error(
        {
          symbol,
          alertType,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Unable to send Binance funding alert",
      );
    }
  } catch (error) {
    logger.error(
      {
        symbol,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Error processing funding",
    );
  }
  }

  return { candidates, sent };
}

  return { candidates, sent };
}

export function startFundingMonitor(): void {
  const botToken = getRequiredEnvironmentVariable("TELEGRAM_BOT_TOKEN");
  const chatId = getRequiredEnvironmentVariable("TELEGRAM_CHAT_ID");

  logger.info(
    {
      exchange: "Binance USDⓈ-M",
      minimumVolumeUsdt: MIN_VOLUME_USDT,
      fundingThresholdsPercent: {
        normalLong: -0.1,
        strongLong: -0.3,
        normalShort: 0.1,
        strongShort: 0.3,
      },
      pollIntervalMs: POLL_INTERVAL_MS,
    },
    "Simple funding monitor started",
  );

  const poll = async (): Promise<void> => {
    try {
      const result = await scanFunding(botToken, chatId);
      logger.info(result, "Funding scan complete; next scan in 2 minutes");
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown error" },
        "Binance funding scan failed",
      );
    } finally {
      setTimeout(() => void poll(), POLL_INTERVAL_MS);
    }
  };

  void poll();
}
