# Score Discrepancy Debug Analysis

## Problem Statement
Player with initials "21" (npub: `npub1vnwqt2l88w2qytnje0fgjat6dykr0cuaffpaenntsdl57lkkwxxs76e4f6`) shows:
- **107 sats** in `get_player` response (stat line)
- **86 sats** in leaderboard display
- **Difference: 21 sats** (exactly one transaction amount)

## Data Flow Analysis

### Both Functions Use Same Data Source
1. **`get_player()` function** ([`utils/leaderboard.ts:236`](utils/leaderboard.ts:236)):
   ```sql
   SELECT npub, initials, total_sats_lost as score
   FROM leaderboard_entries
   WHERE npub = ?
   ```

2. **`checkLeaderboard()` function** ([`utils/leaderboard.ts:43`](utils/leaderboard.ts:43)):
   ```sql
   SELECT npub, initials, total_sats_lost as satsLost
   FROM leaderboard_entries
   ORDER BY total_sats_lost DESC
   LIMIT 10
   ```

### Key Finding
**Both functions query the same table and column (`leaderboard_entries.total_sats_lost`)**, so they should return identical values. The discrepancy indicates a database inconsistency or caching issue.

## Potential Root Causes

### 1. Database Transaction Race Condition
- The `updateLeaderboard()` function uses transactions ([`utils/leaderboard.ts:75`](utils/leaderboard.ts:75))
- Possible race condition between:
  - Updating `leaderboard_entries.total_sats_lost`
  - Reading from the same table

### 2. Incomplete Transaction
- A transaction may have partially completed:
  - `leaderboard_updates` table was updated (showing 107 total)
  - `leaderboard_entries` table was not updated (showing 86)

### 3. Database Corruption or Inconsistency
- The cumulative total in `leaderboard_entries` may be out of sync
- Manual database modification outside the application

### 4. Caching Issue
- One of the queries might be hitting a cached result
- SQLite WAL mode could cause read inconsistencies

## Diagnostic Queries Needed

To identify the root cause, we need to run these queries:

```sql
-- 1. Check current state in leaderboard_entries
SELECT npub, initials, total_sats_lost, updated_at
FROM leaderboard_entries 
WHERE npub = 'npub1vnwqt2l88w2qytnje0fgjat6dykr0cuaffpaenntsdl57lkkwxxs76e4f6';

-- 2. Calculate actual total from leaderboard_updates
SELECT npub, initials, SUM(sats_lost) as calculated_total, COUNT(*) as game_count
FROM leaderboard_updates 
WHERE npub = 'npub1vnwqt2l88w2qytnje0fgjat6dykr0cuaffpaenntsdl57lkkwxxs76e4f6'
GROUP BY npub, initials;

-- 3. Compare the two values
SELECT 
  le.total_sats_lost as leaderboard_total,
  COALESCE(lu.calculated_total, 0) as updates_total,
  (COALESCE(lu.calculated_total, 0) - le.total_sats_lost) as difference
FROM leaderboard_entries le
LEFT JOIN (
  SELECT npub, SUM(sats_lost) as calculated_total
  FROM leaderboard_updates 
  WHERE npub = 'npub1vnwqt2l88w2qytnje0fgjat6dykr0cuaffpaenntsdl57lkkwxxs76e4f6'
  GROUP BY npub
) lu ON le.npub = lu.npub
WHERE le.npub = 'npub1vnwqt2l88w2qytnje0fgjat6dykr0cuaffpaenntsdl57lkkwxxs76e4f6';

-- 4. Check for any missing or duplicate entries
SELECT ref_id, npub, initials, sats_lost, submitted_at
FROM leaderboard_updates 
WHERE npub = 'npub1vnwqt2l88w2qytnje0fgjat6dykr0cuaffpaenntsdl57lkkwxxs76e4f6'
ORDER BY submitted_at DESC;
```

## Recommended Solutions

### Immediate Fix
1. **Recalculate and sync the totals**:
   ```sql
   UPDATE leaderboard_entries 
   SET total_sats_lost = (
     SELECT COALESCE(SUM(sats_lost), 0) 
     FROM leaderboard_updates 
     WHERE leaderboard_updates.npub = leaderboard_entries.npub
   ),
   updated_at = CURRENT_TIMESTAMP
   WHERE npub = 'npub1vnwqt2l88w2qytnje0fgjat6dykr0cuaffpaenntsdl57lkkwxxs76e4f6';
   ```

### Long-term Prevention
1. **Add database integrity checks** in [`utils/leaderboard.ts`](utils/leaderboard.ts)
2. **Implement a sync verification function**
3. **Add logging to track when discrepancies occur**
4. **Consider using database triggers** to maintain consistency

## Next Steps
1. Run diagnostic queries to confirm the root cause
2. Implement the immediate fix
3. Add preventive measures
4. Test the fix with the specific npub
5. Monitor for future discrepancies