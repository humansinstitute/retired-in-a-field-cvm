/**
 * Reset script: clears leaderboard tables to start fresh for launch.
 * Usage: bun run scripts/reset.ts
 */

import { Database } from 'bun:sqlite';

const DB_PATH = './retired.db';

function reset() {
  console.log(`[reset] Connecting to database at ${DB_PATH}`);
  const db = new Database(DB_PATH);

  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    // Ensure tables exist before deletion (leaderboard + splits/donations/payouts)
    db.exec(`
      CREATE TABLE IF NOT EXISTS leaderboard_entries (
        npub TEXT PRIMARY KEY,
        initials TEXT NOT NULL,
        total_sats_lost INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS leaderboard_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref_id TEXT UNIQUE NOT NULL,
        npub TEXT NOT NULL,
        initials TEXT NOT NULL,
        sats_lost INTEGER NOT NULL,
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Splits/donations/payouts tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS donations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT UNIQUE NOT NULL,
        amount_sats INTEGER NOT NULL,
        redeemed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS split_accumulators (
        npub TEXT PRIMARY KEY,
        owed_sats INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        npub TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        finalized_at DATETIME,
        external_ref TEXT,
        error TEXT
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS cashu_access_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref_id TEXT UNIQUE NOT NULL,
        decision TEXT,
        amount_sats INTEGER,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
      );
    `);

    console.log('[reset] Clearing tables: leaderboard_updates, leaderboard_entries');
    db.exec('DELETE FROM leaderboard_updates;');
    db.exec('DELETE FROM leaderboard_entries;');

    console.log('[reset] Clearing tables: donations, split_accumulators, payouts, cashu_access_requests');
    db.exec('DELETE FROM donations;');
    db.exec('DELETE FROM split_accumulators;');
    db.exec('DELETE FROM payouts;');
    db.exec('DELETE FROM cashu_access_requests;');

    // Optional: reclaim space
    db.exec('VACUUM;');

    console.log('[reset] Reset complete. All leaderboard data cleared.');
  } catch (err) {
    console.error('[reset] Error during reset:', err);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

reset();
