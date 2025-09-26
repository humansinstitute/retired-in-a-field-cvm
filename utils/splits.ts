import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { getDatabase, executeTransaction } from "./database.js";
import { processCashuToken } from "./cashu-access.js";
import { validateCashuTokenAmount } from "./leaderboard.js";

const DEFAULT_THRESHOLD = 1000;

export function getConfig() {
  const npub1 = process.env.SPLIT_NPUB1 || process.env.NPUB1 || "npub1_tbd";
  const npub2 = process.env.SPLIT_NPUB2 || process.env.NPUB2 || "npub2_tbd";
  const threshold = Number(process.env.SPLIT_THRESHOLD_SATS || DEFAULT_THRESHOLD);
  return { npub1, npub2, threshold };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export type PayoutStatus = "pending" | "sent" | "failed" | "canceled";

export interface RedeemAndSplitResult {
  accepted: boolean;
  amount: number;
  reason?: string;
  donationRecorded?: boolean;
  donationSource?: string;
  splits?: { npub: string; added: number; newOwed: number }[];
  payouts?: { npub: string; amount: number; status: PayoutStatus; externalRef?: string }[];
  validation?: {
    isValid: boolean;
    reason: string;
    recommendations: string[];
  };
  preventedDuplicate?: boolean;
}

function upsertAccumulator(db: Database, npub: string, delta: number) {
  const stmt = db.prepare(
    `INSERT INTO split_accumulators (npub, owed_sats, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(npub) DO UPDATE SET owed_sats = owed_sats + ?, updated_at = CURRENT_TIMESTAMP`
  );
  stmt.run(npub, delta, delta);
}

function getOwed(db: Database, npub: string): number {
  const stmt = db.prepare("SELECT owed_sats FROM split_accumulators WHERE npub = ?");
  const row = stmt.get(npub) as { owed_sats?: number } | null;
  return row?.owed_sats ?? 0;
}

function recordDonationAndSplit(db: Database, source: string, amount: number, npub1: string, npub2: string) {
  // Insert donation if new; idempotent via UNIQUE source
  const stmt = db.prepare(`INSERT OR IGNORE INTO donations (source, amount_sats) VALUES (?, ?)`);
  const inserted = stmt.run(source, amount);
  const isNew = (inserted.changes || 0) > 0;

  if (!isNew) {
    return { isNew: false, splits: [] as { npub: string; added: number; newOwed: number }[] };
  }

  const part1 = Math.ceil(amount / 2);
  const part2 = Math.floor(amount / 2);

  upsertAccumulator(db, npub1, part1);
  upsertAccumulator(db, npub2, part2);

  const owed1 = getOwed(db, npub1);
  const owed2 = getOwed(db, npub2);

  return {
    isNew: true,
    splits: [
      { npub: npub1, added: part1, newOwed: owed1 },
      { npub: npub2, added: part2, newOwed: owed2 },
    ],
  };
}

async function requestInvoiceAndPayStub(npub: string, amount: number): Promise<{ ok: boolean; externalRef?: string; error?: string }> {
  // Stub: simulate success
  await new Promise((r) => setTimeout(r, 10));
  return { ok: true, externalRef: `stub_tx_${Date.now()}_${npub.slice(0, 8)}` };
}

function createPayoutRow(db: Database, npub: string, amount: number): number {
  const stmt = db.prepare(`INSERT INTO payouts (npub, amount_sats, status) VALUES (?, ?, 'pending')`);
  const res = stmt.run(npub, amount);
  // @ts-ignore Bun:SQLite returns lastInsertRowid
  return Number(res.lastInsertRowid ?? 0);
}

function finalizePayoutSuccess(db: Database, payoutId: number, npub: string, amount: number, externalRef?: string) {
  const updatePayoutStmt = db.prepare(`UPDATE payouts SET status='sent', finalized_at=CURRENT_TIMESTAMP, external_ref=? WHERE id=?`);
  updatePayoutStmt.run(externalRef || null, payoutId);
  
  const updateAccumulatorStmt = db.prepare(`UPDATE split_accumulators SET owed_sats = owed_sats - ?, updated_at=CURRENT_TIMESTAMP WHERE npub=?`);
  updateAccumulatorStmt.run(amount, npub);
}

function finalizePayoutFailure(db: Database, payoutId: number, error: string) {
  const stmt = db.prepare(`UPDATE payouts SET status='failed', finalized_at=CURRENT_TIMESTAMP, error=? WHERE id=?`);
  stmt.run(error, payoutId);
}

function triggerPayoutsIfThreshold(db: Database, npub: string, threshold: number): { payouts: { npub: string; amount: number; status: PayoutStatus; externalRef?: string }[] } {
  const out: { npub: string; amount: number; status: PayoutStatus; externalRef?: string }[] = [];
  let owed = getOwed(db, npub);
  while (owed >= threshold) {
    const amount = threshold; // pay in threshold-sized chunks
    const payoutId = createPayoutRow(db, npub, amount);
    // Commit this row creation and process payment outside
    // We return the pending payout to be processed by caller
    out.push({ npub, amount, status: "pending" });
    owed -= threshold;
  }
  return { payouts: out };
}

/**
 * Enhanced version with validation to prevent random end screen submissions
 */
export async function redeemCashuAndRecordSplitWithValidation(
  encodedToken: string,
  minAmount: number = 21,
  expectedGameScore?: number,
  playerNpub?: string
): Promise<RedeemAndSplitResult> {
  console.log(`[redeem_cashu_validated] Processing token with validation...`);
  
  // First validate the token amount if we have player context
  let validation: any = { isValid: true, reason: "No validation performed", recommendations: [] };
  
  if (playerNpub) {
    try {
      // Pre-validate the expected amount
      const tokenPreview = encodedToken.substring(0, 24);
      console.log(`[redeem_cashu_validated] Pre-validating for player ${playerNpub.substring(0, 20)}... token: ${tokenPreview}...`);
      
      // We'll validate after we know the actual amount from cashu processing
    } catch (error) {
      console.warn(`[redeem_cashu_validated] Pre-validation warning:`, error);
    }
  }
  
  // Process the cashu token
  const res = await processCashuToken(encodedToken, minAmount);
  if (res.decision !== "ACCESS_GRANTED" || !res.amount || res.amount <= 0) {
    return {
      accepted: false,
      amount: res.amount || 0,
      reason: res.reason,
      validation: {
        isValid: false,
        reason: "Cashu token rejected",
        recommendations: ["Ensure token is valid and meets minimum threshold"]
      }
    };
  }
  
  // Now validate the actual amount if we have player context
  if (playerNpub) {
    try {
      validation = await validateCashuTokenAmount(playerNpub, res.amount, expectedGameScore);
      
      if (!validation.isValid) {
        console.warn(`[redeem_cashu_validated] Validation failed: ${validation.reason}`);
        // Still process but flag the validation issue
      }
    } catch (error) {
      console.warn(`[redeem_cashu_validated] Validation error:`, error);
      validation = {
        isValid: false,
        reason: `Validation error: ${error instanceof Error ? error.message : 'unknown'}`,
        recommendations: ["Check validation system"]
      };
    }
  }
  
  const { npub1, npub2, threshold } = getConfig();
  const source = sha256(encodedToken);
  
  const db = getDatabase();
  let splits: { npub: string; added: number; newOwed: number }[] = [];
  let pendingPayouts: { npub: string; amount: number; status: PayoutStatus; externalRef?: string }[] = [];
  let preventedDuplicate = false;
  
  executeTransaction((txDb) => {
    // Check if this token has already been processed (additional safety)
    const existingDonation = txDb.query("SELECT source FROM donations WHERE source = ?").get(source);
    if (existingDonation) {
      console.log(`[redeem_cashu_validated] Duplicate token detected: ${source.substring(0, 16)}...`);
      preventedDuplicate = true;
      return true;
    }
    
    const { isNew, splits: newSplits } = recordDonationAndSplit(txDb, source, res.amount, npub1, npub2);
    splits = newSplits;
    if (isNew) {
      const tp1 = triggerPayoutsIfThreshold(txDb, npub1, threshold);
      const tp2 = triggerPayoutsIfThreshold(txDb, npub2, threshold);
      pendingPayouts = [...tp1.payouts, ...tp2.payouts];
    }
    return true;
  });
  
  if (preventedDuplicate) {
    return {
      accepted: false,
      amount: res.amount,
      reason: "Duplicate token already processed",
      donationRecorded: false,
      donationSource: source,
      validation,
      preventedDuplicate: true
    };
  }
  
  // Process any pending payouts (stubbed)
  const finalized: { npub: string; amount: number; status: PayoutStatus; externalRef?: string }[] = [];
  for (const p of pendingPayouts) {
    const attempt = await requestInvoiceAndPayStub(p.npub, p.amount);
    if (attempt.ok) {
      const stmt = db.prepare(`SELECT id FROM payouts WHERE npub=? AND amount_sats=? AND status='pending' ORDER BY id DESC LIMIT 1`);
      const row = stmt.get(p.npub, p.amount) as { id?: number } | null;
      if (row?.id) {
        executeTransaction((txDb) => {
          finalizePayoutSuccess(txDb, row.id!, p.npub, p.amount, attempt.externalRef);
          return true;
        });
      }
      finalized.push({ ...p, status: "sent", externalRef: attempt.externalRef });
    } else {
      const stmt = db.prepare(`SELECT id FROM payouts WHERE npub=? AND amount_sats=? AND status='pending' ORDER BY id DESC LIMIT 1`);
      const row = stmt.get(p.npub, p.amount) as { id?: number } | null;
      if (row?.id) {
        executeTransaction((txDb) => {
          finalizePayoutFailure(txDb, row.id!, attempt.error || "stub_failure");
          return true;
        });
      }
      finalized.push({ ...p, status: "failed" });
    }
  }
  
  return {
    accepted: true,
    amount: res.amount,
    donationRecorded: splits.length > 0,
    donationSource: source,
    splits,
    payouts: finalized,
    validation,
    preventedDuplicate: false
  };
}

export async function redeemCashuAndRecordSplit(encodedToken: string, minAmount: number = 21): Promise<RedeemAndSplitResult> {
  const res = await processCashuToken(encodedToken, minAmount);
  if (res.decision !== "ACCESS_GRANTED" || !res.amount || res.amount <= 0) {
    return { accepted: false, amount: res.amount || 0, reason: res.reason };
  }

  const { npub1, npub2, threshold } = getConfig();
  const source = sha256(encodedToken);

  const db = getDatabase();
  let splits: { npub: string; added: number; newOwed: number }[] = [];
  let pendingPayouts: { npub: string; amount: number; status: PayoutStatus; externalRef?: string }[] = [];

  executeTransaction((txDb) => {
    const { isNew, splits: newSplits } = recordDonationAndSplit(txDb, source, res.amount, npub1, npub2);
    splits = newSplits;
    if (isNew) {
      const tp1 = triggerPayoutsIfThreshold(txDb, npub1, threshold);
      const tp2 = triggerPayoutsIfThreshold(txDb, npub2, threshold);
      pendingPayouts = [...tp1.payouts, ...tp2.payouts];
    }
    return true;
  });

  // Process any pending payouts (stubbed)
  const finalized: { npub: string; amount: number; status: PayoutStatus; externalRef?: string }[] = [];
  for (const p of pendingPayouts) {
    const attempt = await requestInvoiceAndPayStub(p.npub, p.amount);
    if (attempt.ok) {
      // find payout id by npub+amount+pending and the most recent row
      const row = db.query(`SELECT id FROM payouts WHERE npub=$npub AND amount_sats=$amt AND status='pending' ORDER BY id DESC LIMIT 1`).get({ $npub: p.npub, $amt: p.amount }) as { id?: number } | null;
      if (row?.id) {
        executeTransaction((txDb) => {
          finalizePayoutSuccess(txDb, row.id!, p.npub, p.amount, attempt.externalRef);
          return true;
        });
      }
      finalized.push({ ...p, status: "sent", externalRef: attempt.externalRef });
    } else {
      const row = db.query(`SELECT id FROM payouts WHERE npub=$npub AND amount_sats=$amt AND status='pending' ORDER BY id DESC LIMIT 1`).get({ $npub: p.npub, $amt: p.amount }) as { id?: number } | null;
      if (row?.id) {
        executeTransaction((txDb) => {
          finalizePayoutFailure(txDb, row.id!, attempt.error || "stub_failure");
          return true;
        });
      }
      finalized.push({ ...p, status: "failed" });
    }
  }

  return {
    accepted: true,
    amount: res.amount,
    donationRecorded: splits.length > 0,
    donationSource: source,
    splits,
    payouts: finalized,
  };
}

/**
 * Record-only path: assumes token has already been redeemed and we know the amount.
 * This function will not contact Cashuwall. It will idempotently record the donation
 * (deduped by token hash) and update split accumulators and payouts.
 */
export async function recordDonationAndSplitFromAmount(
  encodedToken: string,
  amountSats: number
): Promise<{
  donationRecorded: boolean;
  donationSource: string;
  splits: { npub: string; added: number; newOwed: number }[];
  payouts: { npub: string; amount: number; status: PayoutStatus; externalRef?: string }[];
  preventedDuplicate: boolean;
}> {
  if (!encodedToken || typeof encodedToken !== "string") {
    throw new Error("encodedToken is required");
  }
  if (!amountSats || amountSats <= 0) {
    throw new Error("amountSats must be > 0");
  }

  const { npub1, npub2, threshold } = getConfig();
  const source = sha256(encodedToken);

  const db = getDatabase();
  let splits: { npub: string; added: number; newOwed: number }[] = [];
  let pendingPayouts: { npub: string; amount: number; status: PayoutStatus; externalRef?: string }[] = [];
  let preventedDuplicate = false;

  executeTransaction((txDb) => {
    // Prevent duplicates if this token was already recorded
    const existingDonation = txDb.query("SELECT source FROM donations WHERE source = ?").get(source);
    if (existingDonation) {
      preventedDuplicate = true;
      return true;
    }

    const { isNew, splits: newSplits } = recordDonationAndSplit(txDb, source, amountSats, npub1, npub2);
    splits = newSplits;
    if (isNew) {
      const tp1 = triggerPayoutsIfThreshold(txDb, npub1, threshold);
      const tp2 = triggerPayoutsIfThreshold(txDb, npub2, threshold);
      pendingPayouts = [...tp1.payouts, ...tp2.payouts];
    }
    return true;
  });

  if (preventedDuplicate) {
    return {
      donationRecorded: false,
      donationSource: source,
      splits: [],
      payouts: [],
      preventedDuplicate: true,
    };
  }

  // Finalize any pending payouts (stubbed)
  const finalized: { npub: string; amount: number; status: PayoutStatus; externalRef?: string }[] = [];
  for (const p of pendingPayouts) {
    const attempt = await requestInvoiceAndPayStub(p.npub, p.amount);
    if (attempt.ok) {
      const row = db
        .query(
          `SELECT id FROM payouts WHERE npub=$npub AND amount_sats=$amt AND status='pending' ORDER BY id DESC LIMIT 1`
        )
        .get({ $npub: p.npub, $amt: p.amount }) as { id?: number } | null;
      if (row?.id) {
        executeTransaction((txDb) => {
          finalizePayoutSuccess(txDb, row.id!, p.npub, p.amount, attempt.externalRef);
          return true;
        });
      }
      finalized.push({ ...p, status: "sent", externalRef: attempt.externalRef });
    } else {
      const row = db
        .query(
          `SELECT id FROM payouts WHERE npub=$npub AND amount_sats=$amt AND status='pending' ORDER BY id DESC LIMIT 1`
        )
        .get({ $npub: p.npub, $amt: p.amount }) as { id?: number } | null;
      if (row?.id) {
        executeTransaction((txDb) => {
          finalizePayoutFailure(txDb, row.id!, attempt.error || "stub_failure");
          return true;
        });
      }
      finalized.push({ ...p, status: "failed" });
    }
  }

  return {
    donationRecorded: splits.length > 0,
    donationSource: source,
    splits,
    payouts: finalized,
    preventedDuplicate: false,
  };
}
