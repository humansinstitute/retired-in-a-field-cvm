import { getDatabase, executeTransaction } from "./database.js";
import { readFileSync } from "fs";

type SplitConfigEntry = {
  npub: string;
  lightningAddress: string;
  min_amount: number;
  comment?: string;
};

type SplitConfig = {
  zapEndpoint?: string;
  entries: SplitConfigEntry[];
};

const DEFAULT_ZAP_ENDPOINT = "http://localhost:4055/zap";
const CONFIG_PATH = "./splits.json";

let running = false;
let loadedConfig: SplitConfig | null = null;

function readConfig(): SplitConfig | null {
  try {
    const text = readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(text) as SplitConfig;
    if (!cfg || !Array.isArray(cfg.entries)) return null;
    return cfg;
  } catch (e) {
    console.warn(
      `[payout-worker] Failed to read config at ${CONFIG_PATH} (cwd=${process.cwd()}): ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

function loadConfigOnce(): boolean {
  loadedConfig = readConfig();
  if (!loadedConfig) {
    console.warn(`[payout-worker] Config not loaded. Worker will idle until restart.`);
    return false;
  }
  console.log(`[payout-worker] Loaded ${loadedConfig.entries.length} entries from ${CONFIG_PATH}`);
  return true;
}

function getOwed(db: any, npub: string): number {
  const row = db.query("SELECT owed_sats FROM split_accumulators WHERE npub=$npub").get({ $npub: npub }) as { owed_sats?: number } | null;
  return row?.owed_sats ?? 0;
}

function getPendingSum(db: any, npub: string): number {
  const row = db
    .query("SELECT COALESCE(SUM(amount_sats),0) as amt FROM payouts WHERE npub=$npub AND status='pending'")
    .get({ $npub: npub }) as { amt?: number } | null;
  return row?.amt ?? 0;
}

function createPendingPayout(db: any, npub: string, amount: number): number {
  const res = db.prepare(`INSERT INTO payouts (npub, amount_sats, status) VALUES (?, ?, 'pending')`).run(npub, amount);
  // @ts-ignore Bun:SQLite lastInsertRowid
  return Number(res.lastInsertRowid ?? 0);
}

function markPayoutSent(db: any, payoutId: number, npub: string, amount: number, externalRef?: string) {
  const updatePayout = db.prepare(
    `UPDATE payouts SET status='sent', finalized_at=CURRENT_TIMESTAMP, external_ref=? WHERE id=?`
  );
  updatePayout.run(externalRef || null, payoutId);

  const decOwed = db.prepare(
    `UPDATE split_accumulators SET owed_sats = owed_sats - ?, updated_at=CURRENT_TIMESTAMP WHERE npub=?`
  );
  decOwed.run(amount, npub);
}

function markPayoutFailed(db: any, payoutId: number, error: string) {
  const stmt = db.prepare(
    `UPDATE payouts SET status='failed', finalized_at=CURRENT_TIMESTAMP, error=? WHERE id=?`
  );
  stmt.run(error, payoutId);
}

async function zap(endpoint: string, npub: string, amount: number, lightningAddress: string, comment?: string): Promise<{ ok: boolean; externalRef?: string; error?: string }> {
  try {
    const body = {
      recipientNpub: npub,
      amount,
      lightningAddress,
      comment: comment || `Auto payout ${amount} sats`,
    };
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
    }
    // Try parse JSON to extract a reference; fallback to text snippet
    let externalRef: string | undefined = undefined;
    try {
      const j = JSON.parse(txt);
      externalRef = (j.id || j.ref || j.txid || j.payment_hash || j.invoice || j.message || "").toString();
    } catch {
      externalRef = txt.slice(0, 120);
    }
    return { ok: true, externalRef };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unknown" };
  }
}

export function startPayoutWorker(intervalMs: number = 120_000) {
  if (running) return;
  running = true;

  let inCycle = false;
  console.log(`[payout-worker] Using CWD: ${process.cwd()}`);
  const ok = loadConfigOnce();
  if (!ok) {
    // Still start timer, but it will find no config and do nothing.
  }
  setInterval(async () => {
    if (inCycle) return; // prevent overlapping cycles
    inCycle = true;
    try {
      const cfg = loadedConfig;
      if (!cfg) return;
      const endpoint = cfg.zapEndpoint || DEFAULT_ZAP_ENDPOINT;
      const db = getDatabase();

      for (const entry of cfg.entries) {
        const { npub, lightningAddress, min_amount, comment } = entry;
        if (!npub || !lightningAddress || !min_amount || min_amount <= 0) {
          console.warn(`[payout-worker] Skipping invalid entry`);
          continue;
        }

        try {
          const owed = getOwed(db, npub);
          const pending = getPendingSum(db, npub);
          const available = Math.max(0, owed - pending);
          if (available < min_amount) {
            continue;
          }

          // Pay the full available amount (above minimum) to catch up quickly
          const payAmount = available;

          let payoutId = 0;
          executeTransaction((txDb) => {
            payoutId = createPendingPayout(txDb, npub, payAmount);
            return true;
          });

          const res = await zap(endpoint, npub, payAmount, lightningAddress, comment);
          if (res.ok) {
            const ext = res.externalRef;
            executeTransaction((txDb) => {
              markPayoutSent(txDb, payoutId, npub, payAmount, ext);
              return true;
            });
            console.log(`[payout-worker] Sent ${payAmount} sats to ${lightningAddress} for ${npub} (${ext || "no-ref"})`);
          } else {
            executeTransaction((txDb) => {
              markPayoutFailed(txDb, payoutId, res.error || "zap_failed");
              return true;
            });
            console.warn(`[payout-worker] Zap failed for ${npub}: ${res.error}`);
          }
        } catch (err) {
          console.error(`[payout-worker] Error for npub ${entry.npub}:`, err);
        }
      }
    } catch (e) {
      console.error(`[payout-worker] Cycle error:`, e);
    } finally {
      inCycle = false;
    }
  }, intervalMs);

  console.log(`[payout-worker] Started. Interval ${intervalMs}ms. Config path ${CONFIG_PATH}`);
}
