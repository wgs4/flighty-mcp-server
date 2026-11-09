import { sanitizeToolErrorMessage } from "../services/tool-safety.js";

/** Error-only generic redaction. Ordinary booking/preview fields do not use these patterns. */
export function sanitizeReceiptError(raw: string, secrets: readonly string[] = []): string {
  const exact = redactExact(raw, secrets);
  // Private URL paths can themselves carry credentials; omit the entire URL in errors.
  const urls = exact.replace(/https?:\/\/[^\s<>"']+/gi, "[redacted-url]");
  return sanitizeToolErrorMessage(urls).replace(/[\u0000-\u001f\u007f]/g, " ");
}
function redactExact(raw: string, secrets: readonly string[]): string {
  let result = raw;
  const variants = new Set(secrets.filter(Boolean).flatMap(value => [value, encodeURIComponent(value)]));
  for (const secret of [...variants].sort((a, b) => b.length - a.length)) result = result.split(secret).join("[redacted-secret]");
  return result;
}
/** Only exact captured secrets are removed from successful results; booking values stay intact. */
export function redactResultSecrets(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactExact(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactResultSecrets(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactResultSecrets(item, secrets)]));
  return value;
}
