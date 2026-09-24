import { calendarConfig } from "./local-config";

export const CALENDAR_KEYS = ["primary", "intent", "tangentcode"] as const;
export type CalendarKey = (typeof CALENDAR_KEYS)[number];

type CalendarConfig = Record<CalendarKey, string>;

const missing = CALENDAR_KEYS.filter(key => typeof calendarConfig[key] !== "string" || calendarConfig[key].trim().length === 0);
if (missing.length > 0) {
  throw new Error(`Invalid server/src/local-config.ts: missing ${missing.join(", ")}. Copy server/src/local-config.example.ts and fill every calendar ID.`);
}

export const CALENDAR_IDS: CalendarConfig = calendarConfig;

export const calendarKeyFor = (calendarName: string): CalendarKey => {
  const normalized = calendarName.trim().toLocaleLowerCase();
  const neutralKey = CALENDAR_KEYS.find(key => key === normalized);
  if (neutralKey) return neutralKey;
  const configuredKey = CALENDAR_KEYS.find(key => CALENDAR_IDS[key] === calendarName);
  return configuredKey ?? "primary";
};
