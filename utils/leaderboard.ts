/**
 * Leaderboard Utility
 * Database-backed leaderboard operations using SQLite
 */

import { getDatabase, executeTransaction } from "./database.js";

export interface LeaderboardEntry {
  initials: string;    // 3-letter initials
  npub: string;        // npub identifier
  satsLost: number;    // sats lost as number
}

export interface LeaderboardUpdateResult {
  message: string;
  npub: string;
  initials: string;
  sats: number;
  totalSats: number;
  refId: string;
  timestamp: string;
  isDuplicate?: boolean;
}

export interface LeaderboardUpdate {
  id: number;
  refId: string;
  npub: string;
  initials: string;
  satsLost: number;
  submittedAt: string;
}

/**
 * Get top 10 leaderboard entries from database
 */
export async function checkLeaderboard(): Promise<LeaderboardEntry[]> {
  console.log(`[check_leaderboard] Fetching leaderboard data from database...`);
  
  try {
    const db = getDatabase();
    const query = db.query(`
      SELECT npub, initials, total_sats_lost as satsLost
      FROM leaderboard_entries
      ORDER BY total_sats_lost DESC
      LIMIT 10
    `);
    
    const results = query.all() as LeaderboardEntry[];
    
    console.log(`[check_leaderboard] Returning ${results.length} leaderboard entries`);
    return results;
    
  } catch (error) {
    console.error(`[check_leaderboard] Database error:`, error);
    throw new Error(`Failed to fetch leaderboard: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Update leaderboard with new sats lost (cumulative) with deduplication
 */
export async function updateLeaderboard(npub: string, initials: string, sats: number, refId: string): Promise<LeaderboardUpdateResult> {
  console.log(`[update_leaderboard] Updating leaderboard for npub: ${npub.substring(0, 20)}... with ${sats} sats (refId: ${refId})`);
  
  if (!npub || !initials || sats <= 0 || !refId) {
    throw new Error("Invalid input: npub, initials, positive sats, and refId are required");
  }
  
  if (initials.length !== 3) {
    throw new Error("Initials must be exactly 3 characters");
  }
  
  try {
    const result = executeTransaction((db) => {
      // Check if this refId has already been processed
      const checkDuplicate = db.prepare(`
        SELECT id FROM leaderboard_updates WHERE ref_id = ?
      `);
      const existingUpdate = checkDuplicate.get(refId);
      
      if (existingUpdate) {
        console.log(`[update_leaderboard] Duplicate refId detected: ${refId}. Skipping processing.`);
        
        // Get current total for this npub to return in response
        const getCurrentTotal = db.prepare(`
          SELECT total_sats_lost FROM leaderboard_entries WHERE npub = ?
        `);
        const currentEntry = getCurrentTotal.get(npub) as { total_sats_lost: number } | undefined;
        
        return {
          totalSats: currentEntry?.total_sats_lost || 0,
          isDuplicate: true
        };
      }
      
      // Check if entry exists in leaderboard_entries
      const checkEntry = db.prepare(`
        SELECT total_sats_lost FROM leaderboard_entries WHERE npub = ?
      `);
      const existingEntry = checkEntry.get(npub) as { total_sats_lost: number } | undefined;
      
      let totalSats: number;
      
      if (existingEntry) {
        // Update existing entry (cumulative)
        totalSats = existingEntry.total_sats_lost + sats;
        const updateEntry = db.prepare(`
          UPDATE leaderboard_entries
          SET total_sats_lost = ?, initials = ?, updated_at = CURRENT_TIMESTAMP
          WHERE npub = ?
        `);
        updateEntry.run(totalSats, initials.toUpperCase(), npub);
      } else {
        // Create new entry
        totalSats = sats;
        const insertEntry = db.prepare(`
          INSERT INTO leaderboard_entries (npub, initials, total_sats_lost)
          VALUES (?, ?, ?)
        `);
        insertEntry.run(npub, initials.toUpperCase(), totalSats);
      }
      
      // Insert the update record (after ensuring the entry exists)
      const insertUpdate = db.prepare(`
        INSERT INTO leaderboard_updates (ref_id, npub, initials, sats_lost)
        VALUES (?, ?, ?, ?)
      `);
      insertUpdate.run(refId, npub, initials.toUpperCase(), sats);
      
      return {
        totalSats: totalSats,
        isDuplicate: false
      };
    });
    
    const updateResult: LeaderboardUpdateResult = {
      message: result.isDuplicate ? "Duplicate request ignored" : "Leaderboard updated successfully",
      npub: npub,
      initials: initials.toUpperCase(),
      sats: sats,
      totalSats: result.totalSats,
      refId: refId,
      timestamp: new Date().toISOString(),
      isDuplicate: result.isDuplicate
    };
    
    if (result.isDuplicate) {
      console.log(`[update_leaderboard] Duplicate request ignored. Current total sats: ${result.totalSats}`);
    } else {
      console.log(`[update_leaderboard] Successfully updated leaderboard entry. Total sats: ${result.totalSats}`);
    }
    
    return updateResult;
    
  } catch (error) {
    console.error(`[update_leaderboard] Database error:`, error);
    throw new Error(`Failed to update leaderboard: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Get all updates for a specific npub
 */
export async function getLeaderboardUpdates(npub: string): Promise<LeaderboardUpdate[]> {
  console.log(`[get_leaderboard_updates] Fetching updates for npub: ${npub.substring(0, 20)}...`);
  
  try {
    const db = getDatabase();
    const query = db.query(`
      SELECT id, ref_id as refId, npub, initials, sats_lost as satsLost, submitted_at as submittedAt
      FROM leaderboard_updates
      WHERE npub = ?
      ORDER BY submitted_at DESC
    `);
    
    const results = query.all(npub) as LeaderboardUpdate[];
    
    console.log(`[get_leaderboard_updates] Returning ${results.length} updates`);
    return results;
    
  } catch (error) {
    console.error(`[get_leaderboard_updates] Database error:`, error);
    throw new Error(`Failed to fetch updates: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Get all recent updates (for admin/debugging)
 */
export async function getAllRecentUpdates(limit: number = 50): Promise<LeaderboardUpdate[]> {
  console.log(`[get_all_recent_updates] Fetching last ${limit} updates...`);
  
  try {
    const db = getDatabase();
    const query = db.query(`
      SELECT id, ref_id as refId, npub, initials, sats_lost as satsLost, submitted_at as submittedAt
      FROM leaderboard_updates
      ORDER BY submitted_at DESC
      LIMIT ?
    `);
    
    const results = query.all(limit) as LeaderboardUpdate[];
    
    console.log(`[get_all_recent_updates] Returning ${results.length} recent updates`);
    return results;
    
  } catch (error) {
    console.error(`[get_all_recent_updates] Database error:`, error);
    throw new Error(`Failed to fetch recent updates: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

export interface PlayerDetails {
  npub: string;
  initials: string;
  score: number;    // total sats lost
  played: number;   // number of games played (unique entries)
}

/**
 * Get player details by npub
 */
export async function getPlayer(npub: string): Promise<PlayerDetails | null> {
  console.log(`[get_player] Fetching player details for npub: ${npub.substring(0, 20)}...`);
  
  if (!npub) {
    throw new Error("npub is required");
  }
  
  try {
    const db = getDatabase();
    
    // Get player's total sats lost and initials from leaderboard_entries
    const playerQuery = db.prepare(`
      SELECT npub, initials, total_sats_lost as score
      FROM leaderboard_entries
      WHERE npub = ?
    `);
    const playerResult = playerQuery.get(npub) as { npub: string; initials: string; score: number } | undefined;
    
    if (!playerResult) {
      console.log(`[get_player] Player not found for npub: ${npub.substring(0, 20)}...`);
      return null;
    }
    
    // Get number of games played (unique entries in leaderboard_updates)
    const gamesQuery = db.prepare(`
      SELECT COUNT(DISTINCT ref_id) as played
      FROM leaderboard_updates
      WHERE npub = ?
    `);
    const gamesResult = gamesQuery.get(npub) as { played: number };
    
    const playerDetails: PlayerDetails = {
      npub: playerResult.npub,
      initials: playerResult.initials,
      score: playerResult.score,
      played: gamesResult.played
    };
    
    console.log(`[get_player] Found player: ${playerDetails.initials} with ${playerDetails.score} sats lost across ${playerDetails.played} games`);
    return playerDetails;
    
  } catch (error) {
    console.error(`[get_player] Database error:`, error);
    throw new Error(`Failed to fetch player details: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}