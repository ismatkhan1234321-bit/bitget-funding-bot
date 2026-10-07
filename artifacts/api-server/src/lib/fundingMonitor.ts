import { logger } from "./logger";

const BITGET_TICKERS_URL =
  "https://api.bitget.com/api/v2/mix/market/tickers";
const TELEGRAM_POLL_INTERVAL_MS = 5 * 60 * 1000;
const FUNDING_THRESHOLD = -0.0003;

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
    signal: AbortSignal.timeout(15_000),
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
    const fundingRate = Number(ticker["fundingRate"]);
    if (!Number.isFinite(fundingRate) || fundingRate >= FUNDING_THRESHOLD) {
      continue;
    }

    matching += 1;
    const symbol =
      typeof ticker["symbol"] === "string" ? ticker["symbol"] : "Unknown symbol";
    const price =
      typeof ticker["lastPr"] === "string" ||
      typeof ticker["lastPr"] === "number"
        ? String(ticker["lastPr"])
        : "unavailable";
    const text =
      `Funding alert: ${symbol} is at ${(fundingRate * 100).toFixed(3)}%` +
      ` (below -0.030%). Price: ${price}. Check market conditions before trading.`;

    await sendTelegramMessage(botToken, chatId, text);
    sent += 1;
  }

  return { matching, sent };
}

export function startFundingMonitor(): void {
  const botToken = getRequiredEnvironmentVariable("TELEGRAM_BOT_TOKEN");
  const chatId = getRequiredEnvironmentVariable("TELEGRAM_CHAT_ID");

  logger.info(
    { threshold: FUNDING_THRESHOLD, pollIntervalMs: TELEGRAM_POLL_INTERVAL_MS },
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
