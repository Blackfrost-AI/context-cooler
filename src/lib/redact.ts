const SECRET_PATTERNS: RegExp[] = [
  // API keys, secrets, tokens, passwords
  /(?:api[_-]?key|secret[_-]?key|access[_-]?token|bearer|password|auth[_-]?token)[\s:=]+["']?([A-Za-z0-9_\-/.+]{20,})["']?/gi,
  // Stripe keys
  /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g,
  // Alpaca keys
  /(?:PK|SK|AK)[A-Z0-9]{16,}/g,
  // Bearer tokens in headers
  /Bearer\s+[A-Za-z0-9_\-/.+]{20,}/gi,
  // Generic long base64-like strings in JSON values (40+ chars)
  /"[^"]+"\s*:\s*"([A-Za-z0-9+/=_\-]{40,})"/g,
  // AWS keys
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  // Generic hex secrets (64+ chars, like SHA256 hashes used as secrets)
  /(?:secret|token|key|password)\s*[:=]\s*[0-9a-f]{64,}/gi,
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexps
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => {
      // Keep the first 8 chars, redact the rest
      if (match.length > 12) {
        return match.slice(0, 8) + "[REDACTED]";
      }
      return "[REDACTED]";
    });
  }
  return result;
}
