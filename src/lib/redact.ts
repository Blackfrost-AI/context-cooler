// CC-S6-007 hardening: stronger, multi-shape secret redaction.
// The previous regex set missed INI/env-style `key = value` secrets (e.g. an
// aws_secret_access_key in ~/.aws/credentials), GitHub/Slack/Google tokens, JWTs
// and PEM private-key blocks. It also kept the first 8 chars of every match,
// which still leaks short secrets. This version:
//   - redacts the VALUE of any key=value pair whose key looks secret-bearing,
//     across JSON / INI / env / yaml shapes (quotes preserved => JSON stays valid)
//   - redacts well-known token formats wholesale (keeps a 4-char type hint)
//   - redacts PEM private-key blocks
// Replacements never add/remove quotes, so a redacted JSON payload remains parseable.

const REDV = "***REDACTED***";

// Secret-bearing key names (covers aws_secret_access_key, client_secret, etc.)
const KEY =
  "(?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?key[_-]?id|access[_-]?token|" +
  "auth[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|password|passwd|pwd|" +
  "secret|token|credential|bearer)";

// key <sep> value  — sep is :, =, or ": " (JSON). value = run of non-space,
// non-quote, non-comma chars, >=8 long. We keep key+sep and redact only the value.
const KV = new RegExp(KEY + "(\\s*[\"']?\\s*[:=]\\s*[\"']?)([^\\s\"',}{]{8,})", "gi");

// Standalone token formats (redacted wholesale, 4-char type hint kept).
const TOKENS: RegExp[] = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe/Alpaca
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub PAT/OAuth
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_\-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9_\-./+]{16,}/gi, // Bearer header
];

// PEM private-key blocks.
const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

function hint(match: string): string {
  return match.length > 8 ? match.slice(0, 4) + "[REDACTED]" : "[REDACTED]";
}

// Entropy catch-all for bare, prefix-less high-entropy secrets that the keyword
// and known-format matchers miss (e.g. a 40-char API token with no `key=`).
// Conservative on purpose (this masks the model-visible output, so a false
// positive only over-masks a blob): a candidate must mix UPPER + lower + digit
// — which true secrets do but hex hashes (lower+digit) and UUIDs do not, so
// those are left intact — AND clear a Shannon-entropy floor.
const ENTROPY_RE = /[A-Za-z0-9_\-+/=]{24,}/g;
const ENTROPY_MIN_BITS = 3.5;

function shannonBits(s: string): number {
  const n = s.length;
  if (n <= 1) return 0;
  const counts: Record<string, number> = {};
  for (const ch of s) counts[ch] = (counts[ch] || 0) + 1;
  let bits = 0;
  for (const k in counts) {
    const p = counts[k] / n;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function entropyMask(text: string): string {
  ENTROPY_RE.lastIndex = 0;
  return text.replace(ENTROPY_RE, (m) => {
    const mixed = /[A-Z]/.test(m) && /[a-z]/.test(m) && /[0-9]/.test(m);
    if (!mixed) return m; // skip hex hashes, UUIDs, lowercase blobs
    if (shannonBits(m) < ENTROPY_MIN_BITS) return m;
    return hint(m);
  });
}

export function redactSecrets(text: string): string {
  let result = text;

  // 1) PEM blocks first (largest, unambiguous)
  result = result.replace(PEM, "[REDACTED PRIVATE KEY]");

  // 2) key=value: redact only the value, keep key+separator (group1=sep, group2=value)
  KV.lastIndex = 0;
  result = result.replace(KV, (m, sep, value) =>
    m.slice(0, m.length - sep.length - value.length) + sep + REDV
  );

  // 3) standalone token formats
  for (const re of TOKENS) {
    re.lastIndex = 0;
    result = result.replace(re, (m) => hint(m));
  }

  // 4) entropy catch-all for bare high-entropy secrets the above missed
  result = entropyMask(result);

  return result;
}
