/**
 * Cashu Access Utility
 * Talks to local Cashuwall API to validate and redeem tokens.
 */

export interface CashuAccessResult {
  decision: 'ACCESS_GRANTED' | 'ACCESS_DENIED';
  amount: number;
  reason: string;
  mode: string;
}

const CASHUWALL_URL = 'http://localhost:3041/cashuwall';
const DEFAULT_RECIPIENT_NPUB = 'npub1ee46qlg09wa9atzuc977urrm7ptkrfqs5uypfstnaxn7370vgcrq8tz3ua';

export async function processCashuToken(
  encodedToken: string,
  minAmount: number = 21
): Promise<CashuAccessResult> {
  if (!encodedToken || typeof encodedToken !== 'string' || encodedToken.trim().length === 0) {
    return {
      decision: 'ACCESS_DENIED',
      amount: 0,
      reason: 'encodedToken is required (cashu... string)',
      mode: 'cashuwall'
    };
  }

  const preview = encodedToken.substring(0, 24);
  console.log(`[cashu_access] Processing token: ${preview}...`);
  console.log(`[cashu_access] Minimum sats required (server-enforced): ${minAmount}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const npub = process.env.CASHUWALL_NPUB || DEFAULT_RECIPIENT_NPUB;
    const res = await fetch(CASHUWALL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The server enforces min threshold. Send token and target npub.
      body: JSON.stringify({ encodedToken, npub }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const contentType = res.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const data = isJson ? await res.json().catch(() => ({})) : {};

    if (res.ok) {
      // 200 responses: either accepted or denied (below threshold)
      if (data && data.accepted === true) {
        const amount = typeof data.amount === 'number' ? data.amount : 0;
        return {
          decision: 'ACCESS_GRANTED',
          amount,
          reason: 'accepted',
          mode: 'cashuwall',
        };
      }

      // denied due to threshold
      const amount = typeof data.amount === 'number' ? data.amount : 0;
      return {
        decision: 'ACCESS_DENIED',
        amount,
        reason: data?.reason || data?.error || 'amount_below_threshold',
        mode: 'cashuwall',
      };
    }

    // Non-200: map to ACCESS_DENIED with error details
    const errorMessage = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    return {
      decision: 'ACCESS_DENIED',
      amount: 0,
      reason: String(errorMessage),
      mode: 'cashuwall',
    };
  } catch (err) {
    clearTimeout(timeout);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const reason = isAbort ? 'request_timeout' : (err instanceof Error ? err.message : 'unknown_error');
    return {
      decision: 'ACCESS_DENIED',
      amount: 0,
      reason,
      mode: 'cashuwall',
    };
  }
}
