/**
 * Cashu Access Utility
 * Talks to local Cashuwall API to validate and redeem tokens.
 * When CASHU_LOCAL=TRUE, tokens are accepted locally without network calls.
 */

import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";

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
  const trimmedToken = (encodedToken || "").trim();
  if (!encodedToken || typeof encodedToken !== 'string' || encodedToken.trim().length === 0) {
    return {
      decision: 'ACCESS_DENIED',
      amount: 0,
      reason: 'encodedToken is required (cashu... string)',
      mode: 'cashuwall'
    };
  }

  const isLocalMode = String(process.env.CASHU_LOCAL || '').toUpperCase() === 'TRUE';

  if (isLocalMode) {
    return await processTokenLocally(trimmedToken, minAmount);
  }

  const preview = trimmedToken.substring(0, 24);
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
      body: JSON.stringify({ encodedToken: trimmedToken, npub }),
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

async function processTokenLocally(encodedToken: string, minAmount: number): Promise<CashuAccessResult> {
  const preview = encodedToken.substring(0, 24);
  console.log(`[cashu_access.local] Processing token locally: ${preview}...`);

  const { amount: decodedAmount, error: decodeError } = decodeCashuAmount(encodedToken);
  if (decodeError) {
    console.warn(`[cashu_access.local] Failed to decode token amount: ${decodeError}`);
  }

  const amount = decodedAmount && decodedAmount > 0
    ? decodedAmount
    : (typeof minAmount === "number" && minAmount > 0 ? minAmount : 21);
  const storageDir =
    process.env.CASHU_LOCAL_STORE_DIR ||
    path.join(process.cwd(), "data", "cashu-local");

  const tokenHash = createHash("sha256").update(encodedToken).digest("hex");
  const tokenPath = path.join(storageDir, `${tokenHash}.json`);

  try {
    await fs.mkdir(storageDir, { recursive: true });
  } catch (err) {
    console.error("[cashu_access.local] Failed to ensure storage directory:", err);
    return {
      decision: "ACCESS_DENIED",
      amount: 0,
      reason: "storage_unavailable",
      mode: "local",
    };
  }

  try {
    await fs.access(tokenPath);
    console.warn(`[cashu_access.local] Duplicate token detected: ${preview}`);
    return {
      decision: "ACCESS_DENIED",
      amount: 0,
      reason: "token_already_used",
      mode: "local",
    };
  } catch {
    // File does not exist yet - proceed
  }

  const record = {
    token: encodedToken,
    amount,
    storedAt: new Date().toISOString(),
  };

  try {
    await fs.writeFile(tokenPath, JSON.stringify(record, null, 2), "utf-8");
    console.log(`[cashu_access.local] Stored token ${preview} at ${tokenPath}`);
    return {
      decision: "ACCESS_GRANTED",
      amount,
      reason: "accepted_local_mode",
      mode: "local",
    };
  } catch (err) {
    console.error("[cashu_access.local] Failed to write token record:", err);
    return {
      decision: "ACCESS_DENIED",
      amount: 0,
      reason: "storage_write_failed",
      mode: "local",
    };
  }
}

function decodeCashuAmount(encodedToken: string): { amount: number | null; error?: string } {
  try {
    const baseToken = encodedToken.trim();
    const prefixMatch = baseToken.match(/^cashu[A-Za-z]?/i);
    const payload = prefixMatch
      ? baseToken.substring(prefixMatch[0].length)
      : baseToken;

    const normalized = payload
      .replace(/[\r\n\s]/g, "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    const padded = normalized.padEnd(normalized.length + (4 - (normalized.length % 4)) % 4, "=");
    const jsonString = Buffer.from(padded, "base64").toString("utf-8");
    const parsed = JSON.parse(jsonString) as {
      token?: Array<{ proofs?: Array<{ amount?: number }> }>;
    };

    if (!parsed?.token?.length) {
      return { amount: null, error: "missing_token_array" };
    }

    const total = parsed.token.reduce((sum, entry) => {
      const proofs = entry?.proofs || [];
      const entrySum = proofs.reduce((innerSum, proof) => {
        const proofAmount = typeof proof?.amount === "number"
          ? proof.amount
          : Number.parseInt(String(proof?.amount ?? "0"), 10);
        return Number.isFinite(proofAmount) && proofAmount > 0
          ? innerSum + proofAmount
          : innerSum;
      }, 0);
      return sum + entrySum;
    }, 0);

    if (total <= 0) {
      return { amount: null, error: "no_positive_proofs" };
    }

    return { amount: total };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    return { amount: null, error: message };
  }
}
