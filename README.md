# cvm

To install dependencies:

```bash
bun install
```

To run the reference client:

```bash
bun run client.ts
```

To run the reference server:

```bash
bun run server.ts
```

## Cashuwall Integration

This server integrates with a local Cashuwall API to validate and redeem Cashu tokens before granting access to play the game.

- Endpoint: `POST http://localhost:3041/cashuwall`
- Minimum sats: 21 (server-enforced)
- The `cashu_access` tool sends `{ encodedToken }` to the API and grants access only when the API returns `{ accepted: true }`.
- If the amount is below the threshold, access is denied with a friendly 200 response (so callers can retry).

By default, the request targets the recipient npub:

```
npub1ee46qlg09wa9atzuc977urrm7ptkrfqs5uypfstnaxn7370vgcrq8tz3ua
```

You can override this by setting `CASHUWALL_NPUB` in your environment (Bun loads `.env` automatically):

```
# .env
CASHUWALL_NPUB=npub1yourrecipient...
```

Ensure your Cashuwall service is running locally and configured with:

- `CASHUWALL_NPUB`: Recipient npub (required)
- `CASHUWALL_MIN_SATS`: Optional, defaults to `21`
- `MINT_URL`: Optional guard to prevent cross-mint deposits

Example test (replace with your token):

```bash
curl -X POST http://localhost:3041/cashuwall \
  -H 'Content-Type: application/json' \
  -d '{"encodedToken":"cashuA..."}'
```

Note the Zod versoning to be compatible with MCP is not currently the latest:

```
"zod": "^3.23.8"
```

This project was created using `bun init` in bun v1.2.22. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
