import fs from "fs/promises";
import path from "path";
import { detectBaseSurges, getTrendingBasePools, getBaseTokenMetrics } from "../crypto_data_service.js";

const PAYWALL_URL = process.env.PAYWALL_URL || "http://localhost:4020/api/premium/surge";
const TELEMETRY_FILE = path.resolve("./workspace/telemetry_surge_feed.json");
const TREASURY_WALLET = "0x7badCdA295Dd7113f374aEA1008e7d5870D48556";

console.log(`
==================================================================
  ⚡ BASE DEX TOKEN VOLATILITY & SURGE MONITOR (24/7 Engine)
  Network: Base Mainnet (Chain ID 8453)
  Treasury: ${TREASURY_WALLET}
  Paywall Stream: ${PAYWALL_URL}
==================================================================
`);

/**
 * Streams detected surge payload to local x402 micropayment gateway
 */
async function streamToPaywall(surgeData) {
  try {
    const res = await fetch(PAYWALL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(surgeData),
    });
    if (res.ok) {
      console.log(`[Stream] ✅ Successfully streamed ${surgeData.surges?.length || 1} surge signals to x402 paywall!`);
    } else {
      console.log(`[Stream] Paywall gateway returned HTTP ${res.status} (offline or busy)`);
    }
  } catch (err) {
    console.log(`[Stream] x402 paywall server standby (${err.message}). Continuing monitor...`);
  }
}

const recentAlerts = new Map(); // Key: token symbol, Value: timestamp

async function dispatchTelegramAlert(surge) {
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID;
  if (!tgToken || !tgChatId) return;

  const key = surge.token || surge.symbol;
  const now = Date.now();
  if (recentAlerts.has(key) && (now - recentAlerts.get(key) < 30 * 60 * 1000)) {
    return; // Cooldown: do not re-alert within 30 minutes
  }
  recentAlerts.set(key, now);

  const priceStr = surge.priceUSD < 0.01 ? surge.priceUSD.toFixed(8) : surge.priceUSD.toFixed(4);
  const volStr = Math.round(surge.volume24hUSD || 0).toLocaleString();

  const text = `🚨 *BASE DEX BREAKOUT SURGE!*\n\n` +
    `🪙 *Asset*: \`${surge.token}\`\n` +
    `📈 *Move*: +${surge.priceChange24hPct}%\n` +
    `💵 *Price*: $${priceStr}\n` +
    `📊 *24h Volume*: $${volStr}\n` +
    `🏦 *DEX*: ${surge.dex || 'Base DEX'}\n\n` +
    `🌐 *Live Radar*: https://evos09.github.io/base-surge-feed/\n` +
    `💰 *Tip Treasury*: \`${TREASURY_WALLET}\``;

  try {
    const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: tgChatId,
        text: text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`[Telegram] 📲 Dispatched breakout alert for ${surge.token} to channel!`);
    }
  } catch (err) {
    console.warn(`[Telegram Alert Error]: ${err.message}`);
  }
}

/**
 * Appends live telemetry to local storage
 */
async function saveTelemetry(surgeData) {
  try {
    let existing = [];
    try {
      const raw = await fs.readFile(TELEMETRY_FILE, "utf8");
      existing = JSON.parse(raw);
    } catch {}

    const entry = {
      timestamp: new Date().toISOString(),
      treasuryRecipient: TREASURY_WALLET,
      detectedCount: surgeData.detectedCount || surgeData.surges?.length || 0,
      surges: surgeData.surges || [],
    };

    existing.unshift(entry);
    // Keep last 100 snapshots
    const trimmed = existing.slice(0, 100);
    await fs.writeFile(TELEMETRY_FILE, JSON.stringify(trimmed, null, 2), "utf8");
    console.log(`[Telemetry] 💾 Saved telemetry snapshot to ${path.basename(TELEMETRY_FILE)} (${trimmed.length} records)`);
  } catch (err) {
    console.error(`[Telemetry Error] Could not write telemetry file: ${err.message}`);
  }
}

/**
 * Execute one cycle of surge scanning and dispatch
 */
export async function runSurgeScan() {
  console.log(`\n[Scan] Scanning Base L2 token pairs for 15-minute volume surges...`);
  
  try {
    // 1. Run live DexScreener & GeckoTerminal surge detection on Base
    const surgeResult = await detectBaseSurges({
      minVolumeH1: 2000,
      minPriceChangeH1: 1.5,
    });

    console.log(`[Scan] Detected ${surgeResult.detectedCount} active surge candidate(s) on Base.`);

    if (surgeResult.surges && surgeResult.surges.length > 0) {
      console.log("\n--- TOP DETECTED BASE SURGES ---");
      surgeResult.surges.slice(0, 5).forEach((s, idx) => {
        console.log(
          ` ${idx + 1}. [${s.token}] Price: $${s.priceUSD.toFixed(6)} | 1h: ${s.priceChange1hPct}% | 24h: ${s.priceChange24hPct}% | 1h Vol: $${s.volume1h?.toLocaleString()}`
        );
      });
      console.log("--------------------------------\n");

      // Dispatch top breakouts to Telegram
      for (const s of surgeResult.surges.slice(0, 2)) {
        if (parseFloat(s.priceChange24hPct) >= 15) {
          await dispatchTelegramAlert(s);
        }
      }
    }

    // 2. Stream to x402 paywall server
    await streamToPaywall(surgeResult);

    // 3. Save telemetry data locally
    await saveTelemetry(surgeResult);

    return surgeResult;
  } catch (err) {
    console.error(`[Scan Error] Failed during surge detection: ${err.message}`);
    return null;
  }
}

/**
 * Main Runner
 */
async function main() {
  const isOnce = process.argv.includes("--once");

  await runSurgeScan();

  if (isOnce) {
    console.log("\n[Monitor] Single scan completed (--once flag passed). Exiting cleanly.");
    process.exit(0);
  }

  // Continuous loop every 60 seconds
  const INTERVAL_MS = 60 * 1000;
  console.log(`[Monitor] Continuous loop active. Next scan in ${INTERVAL_MS / 1000} seconds...`);

  setInterval(async () => {
    await runSurgeScan();
  }, INTERVAL_MS);
}

// Auto-run if executed directly
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("base_surge_feed.js")) {
  main().catch(console.error);
}
