# Score Validation and Consistency Guide

## Problem Overview

The game was experiencing issues where:
1. **Random end screen loading** - Game sometimes reached end screen without proper gameplay
2. **Score discrepancies** - Player scores differed between leaderboard display and player stats
3. **Inconsistent calculations** - Scores calculated from different sources (cashu tokens vs. update history)

## Solution Implementation

### 1. Enhanced Validation System

#### New Functions Added to `utils/leaderboard.ts`:
- [`validateAndSyncPlayerScore()`](utils/leaderboard.ts:272) - Validates and syncs individual player scores
- [`updateLeaderboardWithValidation()`](utils/leaderboard.ts:320) - Enhanced leaderboard updates with validation
- [`getPlayerWithValidation()`](utils/leaderboard.ts:349) - Player retrieval with automatic validation
- [`validateCashuTokenAmount()`](utils/leaderboard.ts:361) - Validates cashu token amounts against player history
- [`performIntegrityCheck()`](utils/leaderboard.ts:477) - Comprehensive system-wide validation

#### Enhanced Cashu Processing in `utils/splits.ts`:
- [`redeemCashuAndRecordSplitWithValidation()`](utils/splits.ts:109) - Enhanced cashu processing with validation
- Duplicate token detection and prevention
- Player context validation
- Game score consistency checks

### 2. Server API Enhancements

#### Updated Tools in [`server.ts`](server.ts):
- **`cashu_access`** - Now includes validation parameters:
  - `expectedGameScore` - Expected game score for validation
  - `playerNpub` - Player context for validation
- **`update_leaderboard`** - Enhanced with validation option
- **`get_player`** - Now includes validation by default
- **`validate_player_score`** - New tool for manual score validation
- **`integrity_check`** - New tool for system-wide integrity checks

### 3. Debug and Monitoring Tools

#### Debug Script: [`scripts/debug-score-discrepancy.ts`](scripts/debug-score-discrepancy.ts)

**Available Commands:**
```bash
# Check all players for score discrepancies
npm run debug validate

# Fix discrepancies (dry run by default)
npm run debug fix
npm run debug fix --execute  # Actually fix issues

# Validate specific player
npm run debug player <npub>

# Get detailed debug info for player
npm run debug debug <npub>

# Check for game flow issues
npm run debug flow
```

## Preventing Random End Screen Loading

### 1. Cashu Token Validation
- Validates token amounts against player history
- Flags suspicious patterns (amounts significantly different from player average)
- Prevents duplicate token processing

### 2. Game Flow Monitoring
- Tracks rapid submissions from same player
- Monitors for duplicate reference IDs
- Identifies unusual submission patterns

### 3. Enhanced Deduplication
- Multiple layers of duplicate prevention
- Reference ID uniqueness enforcement
- Token hash-based duplicate detection

## Ensuring Consistent Score Calculation

### 1. Single Source of Truth
Both leaderboard display and player stats now use the same data source:
- **Primary**: `leaderboard_entries.total_sats_lost`
- **Validation**: Sum of `leaderboard_updates.sats_lost` per player
- **Sync**: Automatic synchronization when discrepancies detected

### 2. Automatic Validation
- All player retrievals include validation by default
- Leaderboard updates trigger validation checks
- Background integrity monitoring

### 3. Transaction Safety
- All updates wrapped in database transactions
- Atomic operations prevent partial updates
- Rollback on errors

## Usage Examples

### For Game Client Integration

```typescript
// When processing a game result with validation
const result = await mcpClient.callTool({
  name: "cashu_access",
  arguments: {
    encodedToken: "cashuA...",
    expectedGameScore: 42,  // Score from game
    playerNpub: "npub1..."  // Player context
  }
});

// Enhanced player retrieval with validation
const player = await mcpClient.callTool({
  name: "get_player",
  arguments: {
    npub: "npub1...",
    useValidation: true  // Default: true
  }
});
```

### For Administrative Tasks

```bash
# Daily integrity check
npm run debug validate

# Fix any found discrepancies
npm run debug fix --execute

# Monitor specific player
npm run debug debug npub1vnwqt2l88w2qytnje0fgjat6dykr0cuaffpaenntsdl57lkkwxxs76e4f6

# Check for game flow issues
npm run debug flow
```

### For Manual Score Validation

```typescript
// Validate and sync specific player
const validation = await mcpClient.callTool({
  name: "validate_player_score",
  arguments: {
    npub: "npub1..."
  }
});

// System-wide integrity check
const integrity = await mcpClient.callTool({
  name: "integrity_check",
  arguments: {}
});
```

## Monitoring and Alerts

### Key Metrics to Monitor
1. **Score Discrepancies**: Number of players with inconsistent scores
2. **Rapid Submissions**: Players submitting multiple games quickly
3. **Duplicate Tokens**: Attempts to process same token multiple times
4. **Validation Failures**: Failed validation attempts

### Recommended Monitoring Schedule
- **Real-time**: Validation during game submissions
- **Hourly**: Game flow issue checks
- **Daily**: Full integrity checks
- **Weekly**: Comprehensive system validation

## Troubleshooting

### Common Issues

#### Score Discrepancy Found
```bash
# Identify the issue
npm run debug player <npub>

# Get detailed information
npm run debug debug <npub>

# Fix the discrepancy
npm run debug fix --execute
```

#### Random End Screen Loading
1. Check for duplicate token processing
2. Validate game flow patterns
3. Review cashu token validation logs
4. Monitor for rapid submissions

#### System-wide Inconsistencies
```bash
# Full system check
npm run debug validate

# Fix all issues
npm run debug fix --execute

# Verify fix
npm run debug validate
```

### Log Analysis
Look for these log patterns:
- `❌ Score discrepancy:` - Individual player issues
- `⚠️ Found X players with score discrepancies` - System-wide issues
- `🔧 Fixing player:` - Automatic corrections
- `🔍 Validation failed:` - Validation issues

## Best Practices

### For Game Development
1. Always provide `expectedGameScore` when processing cashu tokens
2. Include `playerNpub` for validation context
3. Handle validation failures gracefully
4. Monitor validation results for patterns

### For System Administration
1. Run daily integrity checks
2. Monitor validation logs
3. Set up alerts for score discrepancies
4. Regular backup before running fixes

### For Debugging
1. Use debug commands to investigate issues
2. Check both individual players and system-wide patterns
3. Validate fixes before and after applying them
4. Document any manual interventions

## Migration Notes

### Existing Data
- All existing data remains intact
- Validation functions work with current database schema
- No breaking changes to existing APIs

### Backward Compatibility
- Original functions still available
- New validation is opt-in for most operations
- Enhanced functions are additive, not replacements

### Performance Impact
- Validation adds minimal overhead
- Database queries optimized for performance
- Caching prevents redundant validations