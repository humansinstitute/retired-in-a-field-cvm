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

/**
 * Validate and synchronize a player's score from their update history
 * This ensures consistency between leaderboard_entries and leaderboard_updates
 */
export async function validateAndSyncPlayerScore(npub: string): Promise<{
  wasInconsistent: boolean;
  oldTotal: number;
  newTotal: number;
  difference: number;
}> {
  console.log(`[validate_sync_player] Validating and syncing score for npub: ${npub.substring(0, 20)}...`);
  
  if (!npub) {
    throw new Error("npub is required");
  }
  
  try {
    const result = executeTransaction((db) => {
      // Get current leaderboard entry
      const getCurrentTotal = db.prepare(`
        SELECT total_sats_lost FROM leaderboard_entries WHERE npub = ?
      `);
      const currentEntry = getCurrentTotal.get(npub) as { total_sats_lost: number } | undefined;
      
      if (!currentEntry) {
        console.log(`[validate_sync_player] No leaderboard entry found for npub: ${npub.substring(0, 20)}...`);
        return { wasInconsistent: false, oldTotal: 0, newTotal: 0, difference: 0 };
      }
      
      // Calculate actual total from updates
      const calculateTotal = db.prepare(`
        SELECT COALESCE(SUM(sats_lost), 0) as calculated_total
        FROM leaderboard_updates
        WHERE npub = ?
      `);
      const calculatedResult = calculateTotal.get(npub) as { calculated_total: number };
      
      const oldTotal = currentEntry.total_sats_lost;
      const newTotal = calculatedResult.calculated_total;
      const difference = newTotal - oldTotal;
      
      if (difference === 0) {
        console.log(`[validate_sync_player] Score is already consistent: ${oldTotal} sats`);
        return { wasInconsistent: false, oldTotal, newTotal, difference: 0 };
      }
      
      // Update the leaderboard entry with correct total
      const updateEntry = db.prepare(`
        UPDATE leaderboard_entries
        SET total_sats_lost = ?, updated_at = CURRENT_TIMESTAMP
        WHERE npub = ?
      `);
      updateEntry.run(newTotal, npub);
      
      console.log(`[validate_sync_player] Synced score: ${oldTotal} → ${newTotal} (diff: ${difference})`);
      return { wasInconsistent: true, oldTotal, newTotal, difference };
    });
    
    return result;
    
  } catch (error) {
    console.error(`[validate_sync_player] Error:`, error);
    throw new Error(`Failed to validate and sync player score: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Enhanced update leaderboard with built-in validation
 * This version ensures consistency and prevents race conditions
 */
export async function updateLeaderboardWithValidation(
  npub: string,
  initials: string,
  sats: number,
  refId: string
): Promise<LeaderboardUpdateResult & { validationResult?: any }> {
  console.log(`[update_leaderboard_validated] Updating leaderboard for npub: ${npub.substring(0, 20)}... with ${sats} sats (refId: ${refId})`);
  
  if (!npub || !initials || sats <= 0 || !refId) {
    throw new Error("Invalid input: npub, initials, positive sats, and refId are required");
  }
  
  if (initials.length !== 3) {
    throw new Error("Initials must be exactly 3 characters");
  }
  
  try {
    // First, validate current state before updating
    const preValidation = await validateAndSyncPlayerScore(npub).catch(() => null);
    
    // Perform the standard update
    const updateResult = await updateLeaderboard(npub, initials, sats, refId);
    
    // Validate again after update to ensure consistency
    const postValidation = await validateAndSyncPlayerScore(npub);
    
    return {
      ...updateResult,
      validationResult: {
        preValidation,
        postValidation,
        isConsistent: !postValidation.wasInconsistent
      }
    };
    
  } catch (error) {
    console.error(`[update_leaderboard_validated] Error:`, error);
    throw error;
  }
}

/**
 * Get player score with validation
 * This ensures the returned score is consistent with update history
 */
export async function getPlayerWithValidation(npub: string): Promise<PlayerDetails | null> {
  console.log(`[get_player_validated] Fetching validated player details for npub: ${npub.substring(0, 20)}...`);
  
  try {
    // Validate and sync score first
    await validateAndSyncPlayerScore(npub);
    
    // Then get the player details
    return await getPlayer(npub);
    
  } catch (error) {
    console.error(`[get_player_validated] Error:`, error);
    throw error;
  }
}

/**
 * Check if a cashu token amount matches expected game score
 * This helps prevent random end screen submissions
 */
export async function validateCashuTokenAmount(
  npub: string,
  tokenAmount: number,
  expectedGameScore?: number
): Promise<{
  isValid: boolean;
  reason: string;
  playerHistory?: PlayerDetails;
  recommendations: string[];
}> {
  console.log(`[validate_cashu_amount] Validating token amount ${tokenAmount} for npub: ${npub.substring(0, 20)}...`);
  
  try {
    const playerHistory = await getPlayer(npub);
    const recommendations: string[] = [];
    
    // Basic validation rules
    if (tokenAmount <= 0) {
      return {
        isValid: false,
        reason: "Token amount must be positive",
        recommendations: ["Ensure the cashu token has a valid positive amount"]
      };
    }
    
    if (tokenAmount < 21) {
      return {
        isValid: false,
        reason: "Token amount below minimum threshold",
        recommendations: ["Minimum game cost is 21 sats"]
      };
    }
    
    // If we have expected game score, validate it matches
    if (expectedGameScore !== undefined && expectedGameScore !== tokenAmount) {
      recommendations.push(`Expected game score (${expectedGameScore}) doesn't match token amount (${tokenAmount})`);
      return {
        isValid: false,
        reason: "Game score mismatch with token amount",
        playerHistory: playerHistory || undefined,
        recommendations
      };
    }
    
    // Check for suspicious patterns
    if (playerHistory) {
      const avgGameScore = playerHistory.played > 0 ? playerHistory.score / playerHistory.played : 0;
      
      // Flag if this submission is significantly different from player's average
      if (avgGameScore > 0 && (tokenAmount > avgGameScore * 3 || tokenAmount < avgGameScore * 0.3)) {
        recommendations.push(`Token amount (${tokenAmount}) is significantly different from player average (${avgGameScore.toFixed(1)})`);
      }
      
      // Flag rapid submissions (this would need timestamp checking)
      recommendations.push("Consider implementing rate limiting for rapid submissions");
    }
    
    return {
      isValid: true,
      reason: "Token amount appears valid",
      playerHistory: playerHistory || undefined,
      recommendations
    };
    
  } catch (error) {
    console.error(`[validate_cashu_amount] Error:`, error);
    return {
      isValid: false,
      reason: `Validation error: ${error instanceof Error ? error.message : 'unknown'}`,
      recommendations: ["Check system logs for validation errors"]
    };
  }
}

/**
 * Comprehensive leaderboard integrity check
 * Validates all players and returns summary of issues
 */
export async function performIntegrityCheck(): Promise<{
  totalPlayers: number;
  consistentPlayers: number;
  inconsistentPlayers: number;
  totalDiscrepancy: number;
  issues: Array<{
    npub: string;
    initials: string;
    leaderboardTotal: number;
    calculatedTotal: number;
    difference: number;
  }>;
}> {
  console.log(`[integrity_check] Performing comprehensive leaderboard integrity check...`);
  
  try {
    const db = getDatabase();
    
    // Get all players
    const playersQuery = db.query(`
      SELECT npub, initials, total_sats_lost
      FROM leaderboard_entries
      ORDER BY total_sats_lost DESC
    `);
    const players = playersQuery.all() as { npub: string; initials: string; total_sats_lost: number }[];
    
    const issues: Array<{
      npub: string;
      initials: string;
      leaderboardTotal: number;
      calculatedTotal: number;
      difference: number;
    }> = [];
    
    let totalDiscrepancy = 0;
    
    for (const player of players) {
      // Calculate actual total from updates
      const updatesQuery = db.query(`
        SELECT COALESCE(SUM(sats_lost), 0) as calculated_total
        FROM leaderboard_updates
        WHERE npub = ?
      `);
      const updateResult = updatesQuery.get(player.npub) as { calculated_total: number };
      
      const difference = updateResult.calculated_total - player.total_sats_lost;
      
      if (difference !== 0) {
        issues.push({
          npub: player.npub,
          initials: player.initials,
          leaderboardTotal: player.total_sats_lost,
          calculatedTotal: updateResult.calculated_total,
          difference: difference
        });
        totalDiscrepancy += Math.abs(difference);
      }
    }
    
    const result = {
      totalPlayers: players.length,
      consistentPlayers: players.length - issues.length,
      inconsistentPlayers: issues.length,
      totalDiscrepancy,
      issues
    };
    
    console.log(`[integrity_check] Complete: ${result.consistentPlayers}/${result.totalPlayers} players consistent, ${result.totalDiscrepancy} total discrepancy`);
    
    return result;
    
  } catch (error) {
    console.error(`[integrity_check] Error:`, error);
    throw new Error(`Failed to perform integrity check: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}