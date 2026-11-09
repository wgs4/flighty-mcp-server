import { homedir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";

const FLIGHTY_CONTAINER = join(
  homedir(),
  "Library/Containers/com.flightyapp.flighty/Data"
);

export const MAIN_DB_PATH =
  process.env.FLIGHTY_DB_PATH ??
  join(FLIGHTY_CONTAINER, "Documents/MainFlightyDatabase.db");

export const AUTH_DB_PATH = join(
  FLIGHTY_CONTAINER,
  "Documents/Flighty.sqlite"
);

export const PREFS_PLIST_PATH = join(
  FLIGHTY_CONTAINER,
  "Library/Preferences/com.flightyapp.flighty.plist"
);

export const FLIGHTY_API_BASE = "https://api.flightyapp.com";

export const FLIGHTY_USER_AGENT = "Flighty 4.8.0 (4759) com.flightyapp.flighty";

export const PLUTIL_PATH = "/usr/bin/plutil";

export const FLIGHTY_INFO_PLIST_PATH =
  "/Applications/Flighty.app/Contents/Info.plist";

export type PlutilExecFileSync = (
  file: string,
  args: readonly string[],
  options: { encoding: BufferEncoding }
) => string;

let cachedBuildToken: string | null = null;

// Read the build token lazily from the installed Flighty app's Info.plist.
// This is an app version identifier (not user-specific) that updates automatically
// when the user updates Flighty, and is only needed for API write requests.
export function getFlightyBuildToken(
  infoPlistPath: string = FLIGHTY_INFO_PLIST_PATH,
  execFileImpl: PlutilExecFileSync = execFileSync
): string {
  const isDefaultCall =
    infoPlistPath === FLIGHTY_INFO_PLIST_PATH && execFileImpl === execFileSync;
  if (isDefaultCall && cachedBuildToken !== null) {
    return cachedBuildToken;
  }
  try {
    const token = execFileImpl(
      PLUTIL_PATH,
      ["-extract", "FlightyBuildToken", "raw", infoPlistPath],
      { encoding: "utf-8" }
    ).trim();
    if (isDefaultCall && token) {
      cachedBuildToken = token;
    }
    return token;
  } catch {
    return "";
  }
}

export function resetFlightyBuildTokenCache(): void {
  cachedBuildToken = null;
}

// Inert fallback export kept so unmerged callers compile without running plutil on import.
export const FLIGHTY_BUILD_TOKEN = "";

export const TIMESTAMP_COLUMNS = [
  "departureScheduleGateOriginal",
  "departureScheduleGateEstimated",
  "departureScheduleGateActual",
  "departureScheduleRunwayOriginal",
  "departureScheduleRunwayEstimated",
  "departureScheduleRunwayActual",
  "arrivalScheduleGateOriginal",
  "arrivalScheduleGateEstimated",
  "arrivalScheduleGateActual",
  "arrivalScheduleRunwayOriginal",
  "arrivalScheduleRunwayEstimated",
  "arrivalScheduleRunwayActual",
  "equipmentFirstFlightDate",
  "checkInScheduleOpen",
  "checkInScheduleClose",
  "departureScheduleGateInitial",
  "arrivalScheduleGateInitial",
] as const;

export const KM_TO_MILES = 0.621371;
export const EARTH_CIRCUMFERENCE_KM = 40075;
