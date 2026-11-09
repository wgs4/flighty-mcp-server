import { z } from "zod";

export const MIN_YEAR = 1970;
export const MAX_YEAR = 2100;

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export const DEFAULT_REFERENCE_LIMIT = 10;
export const MAX_REFERENCE_LIMIT = 50;

export const MAX_OFFSET = 100_000;
export const MAX_QUERY_LENGTH = 100;
export const MAX_FLIGHT_NUMBER_LENGTH = 16;

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

export const FLIGHT_NUMBER_REGEX = /^[A-Za-z0-9][A-Za-z0-9\s-]*$/;

/**
 * Validates that a string is an actual calendar date in YYYY-MM-DD format
 * within [MIN_YEAR, MAX_YEAR], rejecting invalid dates and calendar rollovers
 * such as 2025-02-29, 2025-02-30, or 2025-04-31.
 */
export function isValidIsoDate(value: string): boolean {
  const trimmed = value.trim();
  const match = ISO_DATE_REGEX.exec(trimmed);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (
    !Number.isInteger(year) ||
    year < MIN_YEAR ||
    year > MAX_YEAR ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }

  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value.trim());
}

export function isValidFlightNumber(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 1 &&
    trimmed.length <= MAX_FLIGHT_NUMBER_LENGTH &&
    FLIGHT_NUMBER_REGEX.test(trimmed)
  );
}

export function isValidBoundedQuery(
  value: string,
  maxLength: number = MAX_QUERY_LENGTH
): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= maxLength;
}

export const isoDateSchema = z
  .string()
  .trim()
  .refine(isValidIsoDate, {
    message: `Invalid date: expected an actual calendar date in YYYY-MM-DD format between ${MIN_YEAR}-01-01 and ${MAX_YEAR}-12-31.`,
  });

export const uuidSchema = z
  .string()
  .trim()
  .refine(isValidUuid, {
    message:
      "Invalid UUID: expected 36-character 8-4-4-4-12 hexadecimal UUID format.",
  });

export const yearSchema = z
  .number()
  .int()
  .min(MIN_YEAR, `Year must be at least ${MIN_YEAR}.`)
  .max(MAX_YEAR, `Year must be at most ${MAX_YEAR}.`);

export const flightNumberSchema = z
  .string()
  .trim()
  .min(1, "Flight number must not be empty.")
  .max(
    MAX_FLIGHT_NUMBER_LENGTH,
    `Flight number must be at most ${MAX_FLIGHT_NUMBER_LENGTH} characters.`
  )
  .regex(
    FLIGHT_NUMBER_REGEX,
    "Flight number may only contain letters, digits, spaces, and hyphens."
  );

export const boundedQuerySchema = z
  .string()
  .trim()
  .min(1, "Filter string must not be empty.")
  .max(
    MAX_QUERY_LENGTH,
    `Filter string must be at most ${MAX_QUERY_LENGTH} characters.`
  );

export const pageLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_LIMIT)
  .default(DEFAULT_PAGE_LIMIT);

export const referenceLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_REFERENCE_LIMIT)
  .default(DEFAULT_REFERENCE_LIMIT);

export const pageOffsetSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_OFFSET)
  .default(0);

export function validateGetFlightSelectors(params: {
  flight_id?: string;
  flight_number?: string;
}):
  | { ok: true; mode: "id" | "number"; flight_id?: string; flight_number?: string }
  | { ok: false; error: string } {
  const hasId = params.flight_id !== undefined && params.flight_id !== "";
  const hasNumber =
    params.flight_number !== undefined && params.flight_number !== "";

  if (!hasId && !hasNumber) {
    return {
      ok: false,
      error: "Error: Provide either flight_id or flight_number.",
    };
  }

  if (hasId && hasNumber) {
    return {
      ok: false,
      error:
        "Error: Provide either flight_id or flight_number, not both (selectors are mutually exclusive).",
    };
  }

  if (hasId) {
    const parsed = uuidSchema.safeParse(params.flight_id);
    if (!parsed.success) {
      return {
        ok: false,
        error: `Error: ${parsed.error.issues[0]?.message ?? "Invalid flight_id UUID."}`,
      };
    }
    return { ok: true, mode: "id", flight_id: parsed.data };
  }

  const parsed = flightNumberSchema.safeParse(params.flight_number);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Error: ${parsed.error.issues[0]?.message ?? "Invalid flight_number."}`,
    };
  }
  return { ok: true, mode: "number", flight_number: parsed.data };
}

export function assertValidYear(year: number | undefined): void {
  if (year === undefined) return;
  const parsed = yearSchema.safeParse(year);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid year.");
  }
}

export function assertValidLimit(
  limit: number | undefined,
  maxLimit: number = MAX_PAGE_LIMIT
): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new Error(`Invalid limit: expected an integer between 1 and ${maxLimit}.`);
  }
}

export function assertValidOffset(offset: number | undefined): void {
  if (offset === undefined) return;
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
    throw new Error(
      `Invalid offset: expected an integer between 0 and ${MAX_OFFSET}.`
    );
  }
}

export function assertValidIsoDate(
  dateStr: string | undefined,
  fieldName: string = "date"
): void {
  if (dateStr === undefined) return;
  if (!isValidIsoDate(dateStr)) {
    throw new Error(
      `Invalid ${fieldName}: expected an actual calendar date in YYYY-MM-DD format.`
    );
  }
}

export function assertValidBoundedQuery(
  value: string | undefined,
  fieldName: string = "query"
): void {
  if (value === undefined) return;
  if (!isValidBoundedQuery(value)) {
    throw new Error(
      `Invalid ${fieldName}: must be between 1 and ${MAX_QUERY_LENGTH} non-whitespace characters.`
    );
  }
}

export function assertValidFlightNumber(value: string): void {
  if (!isValidFlightNumber(value)) {
    throw new Error("Invalid flight_number format.");
  }
}
