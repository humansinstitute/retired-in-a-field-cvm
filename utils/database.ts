/**
 * Database Utility Module
 * Handles SQLite database operations using Bun's built-in SQLite support
 */

import { Database } from "bun:sqlite";

const DB_PATH = "./retired.db";

let db: Database | null = null;

/**
 * Get or create database connection
 */
export function getDatabase(): Database {
  if (!db) {
    db = new Database(DB_PATH);
    // Enable WAL mode for better concurrent access
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA cache_size = 1000;");
    db.exec("PRAGMA foreign_keys = ON;");
  }
  return db;
}

/**
 * Initialize database tables
 */
export function initializeDatabase(): void {
  const database = getDatabase();
  
  console.log("[database] Initializing database tables...");
  
  // Create leaderboard_entries table
  database.exec(`
    CREATE TABLE IF NOT EXISTS leaderboard_entries (
      npub TEXT PRIMARY KEY,
      initials TEXT NOT NULL,
      total_sats_lost INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Create leaderboard_updates table
  database.exec(`
    CREATE TABLE IF NOT EXISTS leaderboard_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref_id TEXT UNIQUE NOT NULL,
      npub TEXT NOT NULL,
      initials TEXT NOT NULL,
      sats_lost INTEGER NOT NULL,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (npub) REFERENCES leaderboard_entries(npub)
    )
  `);
  
  // Create indexes for better performance
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_leaderboard_entries_total_sats_lost 
    ON leaderboard_entries(total_sats_lost DESC)
  `);
  
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_leaderboard_updates_npub
    ON leaderboard_updates(npub)
  `);
  
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_leaderboard_updates_submitted_at
    ON leaderboard_updates(submitted_at DESC)
  `);
  
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_leaderboard_updates_ref_id
    ON leaderboard_updates(ref_id)
  `);
  
  console.log("[database] Database tables initialized successfully");
  
  // Run migrations for existing databases
  migrateDatabase();
}

/**
 * Migrate existing database to add ref_id column if it doesn't exist
 */
export function migrateDatabase(): void {
  const database = getDatabase();
  
  console.log("[database] Checking for database migrations...");
  
  try {
    // --- New tables for donations, split accumulators, and payouts ---
    database.exec(`
      CREATE TABLE IF NOT EXISTS donations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT UNIQUE NOT NULL,
        amount_sats INTEGER NOT NULL,
        redeemed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    database.exec(`
      CREATE TABLE IF NOT EXISTS split_accumulators (
        npub TEXT PRIMARY KEY,
        owed_sats INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    database.exec(`
      CREATE TABLE IF NOT EXISTS payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        npub TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        finalized_at DATETIME,
        external_ref TEXT,
        error TEXT
      )
    `);

    database.exec(`CREATE INDEX IF NOT EXISTS idx_donations_source ON donations(source);`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_payouts_npub_status ON payouts(npub, status);`);

    // Dedupe table for cashu_access requests (prevents double redemption attempts)
    database.exec(`
      CREATE TABLE IF NOT EXISTS cashu_access_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref_id TEXT UNIQUE NOT NULL,
        decision TEXT,
        amount_sats INTEGER,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
      )
    `);
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cashu_access_ref_id ON cashu_access_requests(ref_id);`);

    // Check if ref_id column exists in leaderboard_updates
    const tableInfo = database.query("PRAGMA table_info(leaderboard_updates)").all() as Array<{name: string}>;
    const hasRefId = tableInfo.some(col => col.name === 'ref_id');
    
    if (!hasRefId) {
      console.log("[database] Adding ref_id column to leaderboard_updates table...");
      
      // Add ref_id column with a default value for existing records
      database.exec(`
        ALTER TABLE leaderboard_updates
        ADD COLUMN ref_id TEXT
      `);
      
      // Update existing records with generated ref_ids
      database.exec(`
        UPDATE leaderboard_updates
        SET ref_id = 'legacy_' || id || '_' || substr(npub, 1, 8) || '_' || datetime(submitted_at, 'unixepoch')
        WHERE ref_id IS NULL
      `);
      
      // Now make ref_id NOT NULL and UNIQUE
      database.exec(`
        CREATE UNIQUE INDEX idx_leaderboard_updates_ref_id_unique
        ON leaderboard_updates(ref_id)
      `);
      
      console.log("[database] Migration completed successfully");
    } else {
      console.log("[database] Database schema is up to date");
    }
  } catch (error) {
    console.error("[database] Migration error:", error);
    throw error;
  }
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.log("[database] Database connection closed");
  }
}

/**
 * Execute a transaction with automatic rollback on error
 */
export function executeTransaction<T>(callback: (db: Database) => T): T {
  const database = getDatabase();
  const transaction = database.transaction(callback);
  return transaction(database);
}
