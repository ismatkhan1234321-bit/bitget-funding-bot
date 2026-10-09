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

    const fundingRate = Number(funding.fundingRate);
    const ticker = tickers[symbol];
    const volume = Number(ticker?.quoteVolume);
    if (!Number.isFinite(fundingRate) || !Number.isFinite(volume)) {
      continue;
    }

    if (volume < MIN_VOLUME_USDT) {
      continue;
    }

    const alertType = getAlertType(fundingRate);
    if (!alertType) {
      continue;
    }

    candidates += 1;
    const fundingPercent = fundingRate * 100;
    const price = ticker?.last ?? ticker?.close ?? "Unavailable";
    const message =
      `🚨 ${alertType} ALERT\n` +
      `${symbol}\n` +
      `Funding: ${fundingPercent.toFixed(3)}%\n` +
      `24h Volume: $${(volume / 1_000_000).toFixed(1)}M\n` +
      `Price: ${price}`;

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
