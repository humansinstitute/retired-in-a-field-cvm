# Cashu Access Tool - Full Specification

## Overview

The `cashu_access` tool is an MCP (Model Context Protocol) tool that validates and redeems Cashu tokens through a local Cashuwall API. It provides access control functionality by checking if a provided Cashu token meets minimum satoshi requirements.

## Tool Registration

**Tool Name:** `cashu_access`
**Title:** "Cashu Access Tool"
**Description:** "Redeem a Cashu token via Cashuwall and check access permissions"

## Input Schema

The tool accepts the following parameters:

### Required Parameters

- **`encodedToken`** (string)
  - **Description:** Cashu token string (typically starts with "cashuA...")
  - **Validation:** Must be a non-empty string
  - **Example:** `"cashuAeyJ0b2tlbiI6W3sicHJvb2ZzIjpbeyJhbW91bnQiOjEsImlkIjoiMDA..."`

### Optional Parameters

- **`minAmount`** (number, optional)
  - **Description:** Client hint for minimum sats required (default: 21)
  - **Note:** Server enforces the actual threshold; this is just a client hint
  - **Default:** 21
  - **Example:** `100`

## Response Format

The tool returns a JSON response with the following structure:

```typescript
interface CashuAccessResult {
  decision: 'ACCESS_GRANTED' | 'ACCESS_DENIED';
  amount: number;
  reason: string;
  mode: string;
}
```

### Response Fields

- **`decision`** (string): Either `'ACCESS_GRANTED'` or `'ACCESS_DENIED'`
- **`amount`** (number): The amount of satoshis in the token (0 if invalid/error)
- **`reason`** (string): Explanation for the decision
- **`mode`** (string): Always `'cashuwall'` for normal operations, `'error'` for exceptions

## Usage Examples

### Basic Usage (Minimum Parameters)

```javascript
// Call the tool with just the required token
const result = await mcpClient.callTool('cashu_access', {
  encodedToken: 'cashuAeyJ0b2tlbiI6W3sicHJvb2ZzIjpbeyJhbW91bnQiOjEsImlkIjoiMDA...'
});
```

### With Custom Minimum Amount

```javascript
// Call with custom minimum amount hint
const result = await mcpClient.callTool('cashu_access', {
  encodedToken: 'cashuAeyJ0b2tlbiI6W3sicHJvb2ZzIjpbeyJhbW91bnQiOjEsImlkIjoiMDA...',
  minAmount: 100
});
```

## Response Examples

### Successful Access Grant

```json
{
  "decision": "ACCESS_GRANTED",
  "amount": 150,
  "reason": "accepted",
  "mode": "cashuwall"
}
```

### Access Denied - Below Threshold

```json
{
  "decision": "ACCESS_DENIED",
  "amount": 10,
  "reason": "amount_below_threshold",
  "mode": "cashuwall"
}
```

### Access Denied - Invalid Token

```json
{
  "decision": "ACCESS_DENIED",
  "amount": 0,
  "reason": "encodedToken is required (cashu... string)",
  "mode": "cashuwall"
}
```

### Error Response

```json
{
  "decision": "ACCESS_DENIED",
  "amount": 0,
  "reason": "error: Network timeout",
  "mode": "error"
}
```

## Backend Configuration

### Environment Variables

The tool uses the following environment variables:

- **`CASHUWALL_NPUB`** (optional)
  - **Description:** Target npub for token redemption
  - **Default:** `npub1ee46qlg09wa9atzuc977urrm7ptkrfqs5uypfstnaxn7370vgcrq8tz3ua`
  - **Format:** Nostr public key in npub format

### Cashuwall API Endpoint

- **URL:** `http://localhost:3041/cashuwall`
- **Method:** POST
- **Content-Type:** `application/json`
- **Timeout:** 10 seconds

### Request Payload to Cashuwall

```json
{
  "encodedToken": "cashuA...",
  "npub": "npub1ee46qlg09wa9atzuc977urrm7ptkrfqs5uypfstnaxn7370vgcrq8tz3ua"
}
```

## Error Handling

The tool handles various error scenarios:

### Input Validation Errors

- **Empty/null token:** Returns `ACCESS_DENIED` with reason "encodedToken is required (cashu... string)"
- **Invalid token format:** Handled by Cashuwall API

### Network Errors

- **Timeout (>10s):** Returns `ACCESS_DENIED` with reason "request_timeout"
- **Connection errors:** Returns `ACCESS_DENIED` with error message
- **Non-JSON responses:** Gracefully handled with empty data object

### API Response Handling

- **200 OK with accepted=true:** Returns `ACCESS_GRANTED`
- **200 OK with accepted=false:** Returns `ACCESS_DENIED` with threshold reason
- **Non-200 status codes:** Returns `ACCESS_DENIED` with HTTP error details

## Dependencies

### Required Packages

- `@modelcontextprotocol/sdk` - MCP server framework
- `zod` - Input schema validation
- Node.js built-in `fetch` API

### External Services

- **Cashuwall API** - Must be running on `localhost:3041`
- **Cashu Mint** - Cashuwall communicates with the appropriate mint

## Security Considerations

1. **Local API Only:** The tool only communicates with localhost Cashuwall API
2. **Token Validation:** All token validation is delegated to the Cashuwall service
3. **Timeout Protection:** 10-second timeout prevents hanging requests
4. **Error Sanitization:** Error messages are sanitized before returning to client

## Integration Notes

- The tool is part of a larger MCP server that includes leaderboard functionality
- Tokens are processed through a local Cashuwall instance for security
- The server enforces minimum thresholds regardless of client hints
- All operations are logged for debugging purposes

## Troubleshooting

### Common Issues

1. **"request_timeout" errors:** Check if Cashuwall service is running on port 3041
2. **"HTTP 500" errors:** Verify Cashuwall configuration and mint connectivity
3. **"amount_below_threshold":** Token amount is below server-enforced minimum
4. **Invalid token format:** Ensure token starts with "cashuA" and is properly encoded

### Debug Information

The tool logs the following information:
- Token preview (first 24 characters)
- Minimum amount requirements
- Processing status and results