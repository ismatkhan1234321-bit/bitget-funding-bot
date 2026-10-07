import { logger } from "./logger";

const BITGET_TICKERS_URL =
  "https://api.bitget.com/api/v2/mix/market/tickers";
const TELEGRAM_POLL_INTERVAL_MS = 15 * 60 * 1000;
const BITGET_REQUEST_TIMEOUT_MS = 10_000;
const MIN_QUOTE_VOLUME_USDT = 50_000_000;
const MIN_LAST_PRICE_USDT = 0.1;
const MIN_FUNDING_RATE = -0.0025; // -0.25%
const MAX_FUNDING_RATE = -0.0003; // -0.03%
const BLACKLIST = ["SAMSUNG", "STOCK", "MET", "CL", "BR", "ORCA", "FLOCK"];

interface BitgetTickerResponse {
  code?: unknown;
  data?: unknown;
}

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
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(15_000),
    },
  );

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
    throw new Error(`Telegram rejected the alert: ${description}.`);
  }

  const result = (await response.json()) as { ok?: unknown };
  if (result.ok !== true) {
    throw new Error("Telegram did not accept the alert.");
  }
}

async function checkFunding(
  botToken: string,
  chatId: string,
): Promise<{ matching: number; sent: number }> {
  const url = new URL(BITGET_TICKERS_URL);
  url.searchParams.set("productType", "USDT-FUTURES");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(BITGET_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Bitget returned HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as BitgetTickerResponse;
  if (payload.code !== "00000") {
    throw new Error(`Bitget returned API code ${String(payload.code ?? "unknown")}.`);
  }

  if (!Array.isArray(payload.data)) {
    throw new Error("Bitget returned an unexpected ticker response.");
  }

  let matching = 0;
  let sent = 0;

  for (const entry of payload.data as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const ticker = entry as Record<string, unknown>;
    const rawSymbol = ticker["symbol"];
    if (typeof rawSymbol !== "string") {
      continue;
    }

    const symbol = rawSymbol.toUpperCase();
    if (BLACKLIST.some((blockedName) => symbol.includes(blockedName))) {
      continue;
    }

    const lastPrice = Number(ticker["lastPr"]);
    const fundingRate = Number(ticker["fundingRate"]);
    const quoteVolume = Number(ticker["quoteVolume"]);
    if (
      !Number.isFinite(lastPrice) ||
      !Number.isFinite(fundingRate) ||
      !Number.isFinite(quoteVolume)
    ) {
      continue;
    }

    if (
      quoteVolume < MIN_QUOTE_VOLUME_USDT ||
      lastPrice < MIN_LAST_PRICE_USDT ||
      fundingRate <= MIN_FUNDING_RATE ||
      fundingRate >= MAX_FUNDING_RATE
    ) {
      continue;
    }

    matching += 1;
    const text =
      `🚨 REAL ALERT: ${symbol}\n` +
      `Funding: ${(fundingRate * 100).toFixed(3)}%\n` +
      `Price: ${lastPrice}\n` +
      `24h Vol: $${(quoteVolume / 1_000_000).toFixed(1)}M\n\n` +
      "Chart check karo - Long ka moka ho sakta hai!";

    await sendTelegramMessage(botToken, chatId, text);
    sent += 1;
  }

  return { matching, sent };
}

export function startFundingMonitor(): void {
  const botToken = getRequiredEnvironmentVariable("TELEGRAM_BOT_TOKEN");
  const chatId = getRequiredEnvironmentVariable("TELEGRAM_CHAT_ID");

  logger.info(
    {
      fundingRange: {
        greaterThan: MIN_FUNDING_RATE,
        lessThan: MAX_FUNDING_RATE,
      },
      minimumQuoteVolumeUsdt: MIN_QUOTE_VOLUME_USDT,
      minimumLastPriceUsdt: MIN_LAST_PRICE_USDT,
      pollIntervalMs: TELEGRAM_POLL_INTERVAL_MS,
      blacklistEntries: BLACKLIST.length,
    },
    "Funding monitor started",
  );

  const poll = async (): Promise<void> => {
    try {
      const result = await checkFunding(botToken, chatId);
      logger.info(result, "Funding monitor poll completed");
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown error" },
        "Funding monitor poll failed",
      );
    } finally {
      setTimeout(() => void poll(), TELEGRAM_POLL_INTERVAL_MS);
    }
  };

  void poll();
}
