import { getDatabase, initializeDatabase, closeDatabase } from "../utils/database.js";
import { getConfig } from "../utils/splits.js";

function fmt(n: number): string { return n.toLocaleString(); }

async function main() {
  initializeDatabase();
  const db = getDatabase();
  const { npub1, npub2, threshold } = getConfig();

  const donationRow = db.query("SELECT COUNT(*) as cnt, COALESCE(SUM(amount_sats),0) as total FROM donations").get() as { cnt: number; total: number };

  const npubs = [npub1, npub2];

  type Stat = { npub: string; owed: number; sentAmt: number; sentCnt: number; pendingAmt: number; pendingCnt: number; failedCnt: number };
  const stats: Stat[] = npubs.map((npub) => {
    const owedRow = db.query("SELECT COALESCE(owed_sats,0) as owed FROM split_accumulators WHERE npub=$npub").get({ $npub: npub }) as { owed?: number } | null;
    const sent = db.query("SELECT COALESCE(SUM(amount_sats),0) as amt, COUNT(*) as cnt FROM payouts WHERE npub=$npub AND status='sent'").get({ $npub: npub }) as { amt: number; cnt: number };
    const pending = db.query("SELECT COALESCE(SUM(amount_sats),0) as amt, COUNT(*) as cnt FROM payouts WHERE npub=$npub AND status='pending'").get({ $npub: npub }) as { amt: number; cnt: number };
    const failed = db.query("SELECT COUNT(*) as cnt FROM payouts WHERE npub=$npub AND status='failed'").get({ $npub: npub }) as { cnt: number };
    return {
      npub,
      owed: owedRow?.owed ?? 0,
      sentAmt: sent.amt || 0,
      sentCnt: sent.cnt || 0,
      pendingAmt: pending.amt || 0,
      pendingCnt: pending.cnt || 0,
      failedCnt: failed.cnt || 0,
    };
  });

  const owedTotal = stats.reduce((s, x) => s + x.owed, 0);
  const payoutsSentTotal = stats.reduce((s, x) => s + x.sentAmt, 0);
  const reconciliationDelta = donationRow.total - (owedTotal + payoutsSentTotal);

  console.log("=== Split Report (npub1/npub2) ===");
  console.log(`Threshold: ${fmt(threshold)} sats`);
  console.log(`npub1: ${npub1}`);
  console.log(`npub2: ${npub2}`);
  console.log("");

  console.log("-- All-time Donations --");
  console.log(`Count: ${fmt(donationRow.cnt)}  Total: ${fmt(donationRow.total)} sats`);
  console.log("");

  for (const s of stats) {
    console.log(`-- ${s.npub} --`);
    console.log(`Owed now: ${fmt(s.owed)} sats`);
    console.log(`Payouts sent: ${fmt(s.sentCnt)}  Amount: ${fmt(s.sentAmt)} sats`);
    console.log(`Pending payouts: ${fmt(s.pendingCnt)}  Amount: ${fmt(s.pendingAmt)} sats`);
    console.log(`Failed payouts: ${fmt(s.failedCnt)}`);
    console.log("");
  }

  console.log("-- Reconciliation --");
  console.log(`Total owed (npub1+npub2): ${fmt(owedTotal)} sats`);
  console.log(`Total payouts sent: ${fmt(payoutsSentTotal)} sats`);
  console.log(`Donations - (Owed + Sent): ${fmt(reconciliationDelta)} sats`);
  console.log("");

  const lastDonations = db.query("SELECT id, amount_sats, redeemed_at FROM donations ORDER BY id DESC LIMIT 5").all() as { id: number; amount_sats: number; redeemed_at: string }[];
  console.log("-- Recent Donations (5) --");
  if (lastDonations.length === 0) {
    console.log("None");
  } else {
    for (const d of lastDonations) {
      console.log(`#${d.id}  ${fmt(d.amount_sats)} sats  @ ${d.redeemed_at}`);
    }
  }
  console.log("");

  for (const npub of npubs) {
    const lastPayouts = db.query("SELECT id, amount_sats, status, created_at, finalized_at, external_ref FROM payouts WHERE npub=$npub ORDER BY id DESC LIMIT 5").all({ $npub: npub }) as Array<{ id: number; amount_sats: number; status: string; created_at: string; finalized_at: string | null; external_ref: string | null }>;
    console.log(`-- Recent Payouts (5) for ${npub} --`);
    if (lastPayouts.length === 0) {
      console.log("None");
    } else {
      for (const p of lastPayouts) {
        console.log(`#${p.id}  ${fmt(p.amount_sats)} sats  ${p.status}  created:${p.created_at}  finalized:${p.finalized_at || '-'}  ref:${p.external_ref || '-'}`);
      }
    }
    console.log("");
  }

  closeDatabase();
}

main().catch((e) => {
  console.error("Report error:", e);
  closeDatabase();
  process.exit(1);
});

