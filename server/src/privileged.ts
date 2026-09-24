import { definePrivilegedContracts, definePrivilegedHandlers, z } from "@hatch/space-sdk";
import { CALENDAR_IDS, CALENDAR_KEYS, type CalendarKey } from "./calendar-config";

const calendarEventResponse = z.object({
  google_event_id: z.string(),
  calendar_name: z.enum(["primary", "intent", "tangentcode"]),
  title: z.string(),
  start_time: z.string(),
  end_time: z.string().nullable(),
  location: z.string().nullable(),
  is_all_day: z.boolean(),
});

export const privileged = definePrivilegedContracts({
  verifyCalendarSyncToken: {
    request: z.object({ token: z.string().min(1).max(500) }),
    response: z.object({ matches: z.boolean() }),
    timeoutMs: 5_000,
  },
  readCalendarWindow: {
    request: z.object({
      time_min: z.string().min(1).max(80),
      time_max: z.string().min(1).max(80),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      events: z.array(z.object({
        google_event_id: z.string(),
        calendar_name: z.enum(["primary", "intent", "tangentcode"]),
        title: z.string(),
        start_time: z.string(),
        end_time: z.string().nullable(),
        location: z.string().nullable(),
        is_all_day: z.boolean(),
      })),
    }),
    timeoutMs: 30_000,
  },
  writeIntentCalendarEvent: {
    request: z.object({
      operation: z.enum(["create", "update", "delete"]),
      event_id: z.string().max(1024).optional(),
      title: z.string().trim().min(1).max(500).optional(),
      start_time: z.string().max(80).optional(),
      end_time: z.string().max(80).optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      event: z.object({
        google_event_id: z.string(),
        calendar_name: z.enum(["primary", "intent", "tangentcode"]),
        title: z.string(),
        start_time: z.string(),
        end_time: z.string().nullable(),
        location: z.string().nullable(),
        is_all_day: z.boolean(),
      }).optional(),
    }),
    timeoutMs: 30_000,
  },
});

type CalendarRow = z.infer<typeof calendarEventResponse>;
type CalendarJson = {
  id?: unknown;
  summary?: unknown;
  location?: unknown;
  status?: unknown;
  start?: { dateTime?: unknown; date?: unknown };
  end?: { dateTime?: unknown; date?: unknown };
};

const runCalendar = async (resource: string, method: string, params: Record<string, unknown>, body?: Record<string, unknown>) => {
  const command = ["hatch_gws_cli", "calendar", resource, method, "--params", JSON.stringify(params)];
  if (body) command.push("--json", JSON.stringify(body));
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || "Google Calendar did not accept the request.");
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== "object") throw new Error("Google Calendar returned an unreadable response.");
  return parsed as Record<string, unknown>;
};

const normalizeEvent = (value: unknown, calendarName: CalendarKey): CalendarRow | null => {
  if (!value || typeof value !== "object") return null;
  const event = value as CalendarJson;
  if (event.status === "cancelled" || typeof event.id !== "string") return null;
  const start = typeof event.start?.dateTime === "string" ? event.start.dateTime : typeof event.start?.date === "string" ? event.start.date : null;
  if (!start) return null;
  const end = typeof event.end?.dateTime === "string" ? event.end.dateTime : typeof event.end?.date === "string" ? event.end.date : null;
  return {
    google_event_id: event.id,
    calendar_name: calendarName,
    title: typeof event.summary === "string" && event.summary.trim() ? event.summary.trim() : "Busy",
    start_time: start,
    end_time: end,
    location: typeof event.location === "string" && event.location.trim() ? event.location.trim() : null,
    is_all_day: typeof event.start?.date === "string",
  };
};

const safeCalendarError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/not.?connected|auth|credential|permission|scope|403/i.test(message)) return "Google Calendar access is unavailable. Reconnect Calendar and try again.";
  if (/network|fetch|timeout|timed out|unreachable/i.test(message)) return "Google Calendar is temporarily unavailable. Try again when the connection returns.";
  return "Google Calendar could not complete the request.";
};

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  verifyCalendarSyncToken(args) {
    const expected = process.env.GTD_CALENDAR_SYNC_TOKEN ?? "";
    const provided = args.token;
    if (!expected || provided.length !== expected.length) return { matches: false };
    let diff = 0;
    for (let index = 0; index < provided.length; index += 1) {
      diff |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
    }
    return { matches: diff === 0 };
  },
  async readCalendarWindow(args) {
    try {
      const events: CalendarRow[] = [];
      for (const calendarKey of CALENDAR_KEYS) {
        const result = await runCalendar("events", "list", {
          calendarId: CALENDAR_IDS[calendarKey],
          timeMin: args.time_min,
          timeMax: args.time_max,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 250,
        });
        const items = Array.isArray(result.items) ? result.items : [];
        for (const item of items) {
          const normalized = normalizeEvent(item, calendarKey);
          if (normalized) events.push(normalized);
        }
      }
      return { ok: true, events };
    } catch (error) {
      return { ok: false, error: safeCalendarError(error), events: [] };
    }
  },
  async writeIntentCalendarEvent(args) {
    try {
      if (args.operation === "delete") {
        if (!args.event_id) return { ok: false, error: "That intent block could not be identified." };
        await runCalendar("events", "delete", { calendarId: CALENDAR_IDS.intent, eventId: args.event_id });
        return { ok: true };
      }
      if (!args.title || !args.start_time || !args.end_time) {
        return { ok: false, error: "Title, start time, and end time are required." };
      }
      const body = {
        summary: args.title,
        start: { dateTime: args.start_time },
        end: { dateTime: args.end_time },
        transparency: "transparent",
        reminders: { useDefault: true },
      };
      const result = args.operation === "create"
        ? await runCalendar("events", "insert", { calendarId: CALENDAR_IDS.intent }, body)
        : args.event_id
          ? await runCalendar("events", "patch", { calendarId: CALENDAR_IDS.intent, eventId: args.event_id }, body)
          : null;
      if (!result) return { ok: false, error: "That intent block could not be identified." };
      const event = normalizeEvent(result, "intent");
      return event ? { ok: true, event } : { ok: false, error: "Google Calendar saved the block but did not return its details." };
    } catch (error) {
      return { ok: false, error: safeCalendarError(error) };
    }
  },
});
