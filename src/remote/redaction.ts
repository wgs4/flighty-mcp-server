import { sanitizeToolErrorMessage } from "../services/tool-safety.js";

/** Error-only generic redaction. Ordinary booking/preview fields do not use these patterns. */
export function sanitizeReceiptError(raw: string, secrets: readonly string[] = []): string {
  const exact = redactExact(raw, secrets);
  const urls = exact.replace(/https?:\/\/[^\s<>"']+/gi, "[redacted-url]");
  return sanitizeToolErrorMessage(urls).replace(/[\u0000-\u001f\u007f]/g, " ");
}
function redactExact(raw: string, secrets: readonly string[]): string {
  const variants = new Set(secrets.filter(Boolean).flatMap(value => [value, encodeURIComponent(value)]));
  if (!variants.size) return raw;
  // Match once against original text: a short secret must never rewrite an inserted marker.
  const pattern = [...variants].sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return raw.replace(new RegExp(pattern, "g"), () => "[redacted-secret]");
}
function redactSourceText(raw: string, secrets: readonly string[], credentials: readonly string[]): string {
  const terms = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length).flatMap(value => {
    return [...new Set([value, encodeURIComponent(value)])].map(variant => {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Short opaque context labels need token boundaries in ordinary source text. Actual login/sync
      // credentials are always scrubbed, even when short; errors use the stricter exact matcher.
      return value.length < 12 && !credentials.includes(value) ? `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])` : escaped;
    });
  });
  return terms.length ? raw.replace(new RegExp(terms.join("|"), "g"), () => "[redacted-secret]") : raw;
}
const controls = new Set(["status", "flight_id", "confirm_code", "flight_code", "date", "server_flight_uuid", "snapshot_id",
  "message"]);
const flightIdentifiers = new Set(["id", "flight_number", "airline_iata", "departure_airport_iata", "arrival_airport_iata",
  "booking_reference", "seat_number", "seat_position", "cabin_class", "tail_number", "tracking_source", "passenger_name_source"]);

/** Typed controls/IDs and legitimate booking fields are data, never substring-redaction targets.
 * Only source text is scrubbed. Public build versions are excluded by the caller, not by length. */
export function redactResultSecrets(value: unknown, secrets: readonly string[], credentials: readonly string[] = secrets): unknown {
  const requestedId = value && typeof value === "object" ? (value as { flight_id?: unknown }).flight_id : undefined;
  const visit = (item: unknown, path: string[]): unknown => {
    if (typeof item === "string") return redactSourceText(item, secrets, credentials);
    if (Array.isArray(item)) return item.map(child => visit(child, [...path, "[]"]));
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => {
      const control = path.length === 0 && controls.has(key);
      const safePublicId = typeof child === "string" && /^[A-Za-z0-9 _/-]{1,80}$/.test(child) && !credentials.some(secret => secret && child.includes(secret));
      const schedule = /^(?:departure|arrival)Schedule(?:Gate|Runway)(?:Original|Estimated|Actual)$/.test(key) &&
        (child === null || (typeof child === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?$/.test(child)));
      const exactUuid = path.length === 1 && path[0] === "flight" && key === "id" && child === requestedId && typeof child === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(child);
      // Source-field shape/name is never a reason to bypass a classified private value.
      // The exact UUID is already bound to the caller's requested protocol control.
      if (!control && !exactUuid && typeof child === "string" && credentials.some(secret => secret && child.includes(secret))) {
        return [key, redactSourceText(child, secrets, credentials)];
      }
      const flightId = path.length === 1 && path[0] === "flight" && (exactUuid || (flightIdentifiers.has(key) && safePublicId) || schedule);
      const ownerId = path.join(".") === "flight.owner_identity" && ["user_id", "source", "label"].includes(key) && safePublicId;
      return [key, control || flightId || ownerId ? child : visit(child, [...path, key])];
    }));
  };
  return visit(value, []);
}

/** CFBundleVersion-style values such as 4759 are public protocol metadata, not credentials. */
export function privateBuildValue(value: string): string[] {
  return /^\d+(?:\.\d+)*$/.test(value) ? [] : [value];
}
