export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FLIGHT_CODE_MIN = 3;
export const FLIGHT_CODE_MAX = 20;
export const MIN_FLIGHT_YEAR = 1900;
export const MAX_FLIGHT_YEAR = 2200;

export class InputBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputBoundsError";
  }
}

export function assertUuid(value: string, label = "Id"): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new InputBoundsError(`${label} must be a UUID.`);
  }
  return value;
}

export function isRealIsoDate(value: string): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < MIN_FLIGHT_YEAR || year > MAX_FLIGHT_YEAR) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function assertIsoDate(value: string): string {
  if (!isRealIsoDate(value)) {
    throw new InputBoundsError("Date must be a real YYYY-MM-DD calendar date.");
  }
  return value;
}

export function assertFlightCode(value: string): string {
  if (typeof value !== "string") {
    throw new InputBoundsError("Flight code must be 3 to 20 characters, like UA194.");
  }
  const trimmed = value.trim();
  if (
    trimmed.length < FLIGHT_CODE_MIN ||
    trimmed.length > FLIGHT_CODE_MAX ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw new InputBoundsError("Flight code must be 3 to 20 characters, like UA194.");
  }
  return trimmed;
}

export function assertFlightNumber(value: string): string {
  if (typeof value !== "string" || !/^\d{1,5}$/.test(value)) {
    throw new InputBoundsError("Flight number must be 1 to 5 digits.");
  }
  return value;
}

export function assertConfirmCodeShape(value: string): string {
  if (typeof value !== "string") {
    throw new InputBoundsError("Confirm code is not valid.");
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 32 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new InputBoundsError("Confirm code is not valid.");
  }
  return trimmed;
}
