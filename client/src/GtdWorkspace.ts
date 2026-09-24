import { api, type ApiResponse } from "./api";

export type Workspace = ApiResponse<typeof api, "listWorkspace">;
type Tab = "today" | "week" | "schedule" | "inbox" | "action" | "project" | "someday" | "reference" | "done";
type ItemKind = "project" | "action" | "client" | "tickler" | "inbox" | "reference" | "someday" | "scheduled";
type ActiveKind = "action" | "project" | "tickler";
type Priority = "A" | "B" | "C" | "unprioritized";
type PriorityFilter = "all" | Priority;
type TodaySection = "inbox" | Priority;
type Scope = "main" | `client:${number}` | `agent:${string}`;
type Tickler = Workspace["ticklers"][number];
type CalendarEvent = Workspace["calendar_events"][number];
type ReleaseNote = { version: string; date: string; changes: string[] };
type LogLevel = "INFO" | "SEND" | "RECV" | "STATE" | "ERROR";
type LogEntry = { sequence: number; timestamp: string; level: LogLevel; event: string; detail?: unknown };
type RenderMeasurement = {
  render_generation: string;
  render_request_id: string | null;
  client_release: string;
  server_release: string;
  tab: Tab;
  rendered_row_count: number;
  state_row_count: number;
  has_data: boolean;
  rendered_at: string;
};
type DiagnosticEntry = {
  id: string;
  kind: string;
  detail: string;
  client_release: string;
  at: string;
};
type CompletedEntry = {
  kind: ActiveKind;
  id: number;
  title: string;
  url: string;
  detail: string;
  completedAt: string | null;
};

const isWorkspaceResponse = (value: unknown): value is Workspace => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.row_count === "number"
    && typeof candidate.loaded_at === "string"
    && typeof candidate.server_release === "string"
    && typeof candidate.health_report === "object"
    && candidate.health_report !== null
    && typeof candidate.calendar_visibility === "object"
    && candidate.calendar_visibility !== null
    && ["clients", "projects", "actions", "ticklers", "inbox", "references", "someday", "scheduled"].every(key => Array.isArray(candidate[key]));
};

const errorHasStatus = (value: unknown, status: number, seen = new WeakSet<object>()): boolean => {
  try {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    const candidate = value as { status?: unknown; errors?: unknown; cause?: unknown };
    if (candidate.status === status) return true;
    if (Array.isArray(candidate.errors) && candidate.errors.some(error => errorHasStatus(error, status, seen))) return true;
    return errorHasStatus(candidate.cause, status, seen);
  } catch {
    return false;
  }
};

const errorMessage = (value: unknown): string => {
  try {
    const detail = value instanceof Error ? value.message : String(value);
    return detail.trim() || "workspace request failed";
  } catch {
    return "workspace request failed";
  }
};

const CURRENT_RELEASE = "2026.09.24.15";
type CalendarKey = keyof Workspace["calendar_visibility"];
const WORKSPACE_WATCHDOG_MS = 15_000;
const LATE_RESULT_TIMEOUT_MS = 45_000;
const MAX_LOAD_ATTEMPTS = 5;
const LOAD_RETRY_BASE_MS = 5_000;
const LOAD_RETRY_MAX_MS = 30_000;
const EMPTY_RESPONSE_GRACE_MS = 4_000;
const DIAGNOSTIC_POST_TIMEOUT_MS = 8_000;
const DIAGNOSTIC_OUTBOX_KEY = "gtd:diagnostic-outbox";
const DIAGNOSTIC_OUTBOX_MAX = 20;
const SELF_CHECK_RETRY_MS = 2_000;
const AUTO_REFRESH_MS = 20_000;
const RELEASE_RELOAD_KEY = "gtd:last-auto-reloaded-release";
const EMPTY_COUNTS: Workspace["health_report"]["state_row_counts"] = { clients: 0, projects: 0, actions: 0, ticklers: 0, inbox: 0, references: 0, someday: 0, scheduled: 0 };
const EMPTY_HEALTH: Workspace["health_report"] = { release_version: CURRENT_RELEASE, state_row_counts: EMPTY_COUNTS, state_row_count: 0, rendered_row_count: null, has_data: false, passed: false, status: "unknown", checked_at: "", render_generation: null, render_request_id: null, rendered_at: null, latest_diagnostic: null };
const EMPTY_WORKSPACE: Workspace = { clients: [], projects: [], actions: [], ticklers: [], inbox: [], references: [], someday: [], scheduled: [], calendar_events: [], calendar_sync: { last_sync_at: null, status: "unknown", error_detail: null }, calendar_visibility: { primary: true, intent: true, tangentcode: true }, daily_items: [], daily_month: [], weekly_items: [], loaded_at: "", row_count: 0, server_release: CURRENT_RELEASE, health_report: EMPTY_HEALTH };
const EVENT_LOG: LogEntry[] = [];
let eventSequence = 0;

const redactKey = (key: string) => /token|password|secret|authorization|credential|cookie/i.test(key);
const safeLogValue = (value: unknown): unknown => {
  const seen = new WeakSet<object>();
  try {
    return JSON.parse(JSON.stringify(value, (key, current) => {
      if (redactKey(key)) return "[REDACTED]";
      if (current instanceof Error) {
        return { name: current.name, message: current.message, stack: current.stack };
      }
      if (typeof current === "bigint") return `${current}n`;
      if (typeof current === "function") return `[Function ${current.name || "anonymous"}]`;
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
      }
      return current;
    }));
  } catch {
    try { return String(value); } catch { return "[Unserializable value]"; }
  }
};
const appendLog = (level: LogLevel, event: string, detail?: unknown) => {
  try {
    EVENT_LOG.push({ sequence: ++eventSequence, timestamp: new Date().toISOString(), level, event, ...(detail === undefined ? {} : { detail: safeLogValue(detail) }) });
    if (EVENT_LOG.length > 250) EVENT_LOG.splice(0, EVENT_LOG.length - 250);
  } catch {
    // Debug logging must never interfere with the GTD workspace.
  }
};
const formatLog = () => EVENT_LOG.map(entry => {
  let line = `${String(entry.sequence).padStart(4, "0")} ${entry.timestamp} ${entry.level.padEnd(5)} ${entry.event}`;
  if (entry.detail !== undefined) {
    try { line += `\n${JSON.stringify(entry.detail, null, 2)}`; }
    catch { line += "\n[Could not format detail]"; }
  }
  return line;
}).join("\n\n");

appendLog("INFO", "module startup", { release: CURRENT_RELEASE, href: location.pathname, visibility: document.visibilityState, online: navigator.onLine });

const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: CURRENT_RELEASE,
    date: "September 24, 2026",
    changes: [
      "Moved private Google Calendar identifiers into server-only local configuration.",
      "The Week view now receives neutral calendar keys while preserving three-calendar sync, visibility controls, and Intent editing.",
    ],
  },
  {
    version: "2026.09.24.14",
    date: "September 24, 2026",
    changes: [
      "Grouped completed items under completion-date headings, with the newest date first.",
      "Backfilled every previously undated completed item once in the database: its stored creation date was used when available; otherwise the earliest recorded completion date among dated Done items was used.",
    ],
  },
  {
    version: "2026.09.24.13",
    date: "September 24, 2026",
    changes: [
      "Removed count badges from the Today and Week folder tabs while preserving every other folder count.",
    ],
  },
  {
    version: "2026.09.24.12",
    date: "September 24, 2026",
    changes: [
      "Added the Tangentcode calendar as a third read-only source in Week alongside Primary and editable Intent blocks.",
      "Added database-backed calendar visibility controls so each calendar can be shown or hidden across reloads without changing its write permissions.",
    ],
  },
  {
    version: "2026.09.24.11",
    date: "September 24, 2026",
    changes: [
      "Moved Reference to the rightmost folder-tab position, after Done, without changing its content, behavior, or count badge.",
    ],
  },
  {
    version: "2026.09.24.10",
    date: "September 24, 2026",
    changes: [
      "Made the selected folder tab the same height as every other tab at phone, tablet, and desktop widths.",
      "Kept the active folder distinct through its dark background and light text instead of extra height.",
    ],
  },
  {
    version: "2026.09.24.9",
    date: "September 24, 2026",
    changes: [
      "Removed the remaining kicker-and-headline blocks from the top of every folder so each working view begins directly beneath the folder tabs.",
      "Kept folder-specific controls and inline add actions in place while reclaiming the heading space.",
    ],
  },
  {
    version: "2026.09.24.8",
    date: "September 24, 2026",
    changes: [
      "Added Week in the former Next-tab slot: a Monday–Sunday planner with previous, next, and this-week navigation.",
      "Week shows the primary calendar as read-only busy time and the intent calendar as softer editable planning blocks.",
      "Intent blocks can be created, edited, and deleted from the week view while staying transparent with calendar-default reminders.",
      "Calendar reads are bounded to the visible week plus one day on each side, with a usable offline grid when sync is unavailable.",
    ],
  },
  {
    version: "2026.09.24.7",
    date: "September 24, 2026",
    changes: [
      "Kept folder action labels hidden on narrow screens so the tabs stay compact.",
      "Restored compact client creation and editing controls beside the global scope selector.",
      "Made Add tickler available in every scope and prefilled new scoped ticklers with the active client or agent.",
      "Tightened client and agent text matching so partial-name mentions no longer leak items into a scope.",
    ],
  },
  {
    version: "2026.09.24.6",
    date: "September 24, 2026",
    changes: [
      "Compressed diagnostics, scope, quick add, and refresh into one top control line.",
      "Quick add now opens a focused menu for Inbox, Next Action, or Project.",
      "Removed the Today page heading so its working lists begin directly below the folder tabs.",
    ],
  },
  {
    version: "2026.09.24.5",
    date: "September 24, 2026",
    changes: [
      "Added an optional URL to inbox items, next actions, projects, ticklers, scheduled items, references, and someday items.",
      "Links now open directly from each item row without opening the item editor.",
      "URLs stay attached when an item is clarified, moved, or promoted.",
    ],
  },
  {
    version: "2026.09.24.4",
    date: "September 24, 2026",
    changes: [
      "Matched the Future tab’s label height to the other folder tabs.",
      "Removed the separate Next tab and changed Today’s action label from Plan to Work.",
      "Made Inbox and each priority group on Today collapsible, with Inbox and Priority A open by default and expansion choices retained while the workspace is open.",
    ],
  },
  {
    version: "2026.09.24.3",
    date: "September 24, 2026",
    changes: [
      "Removed the oversized date and page slogan above the folder tabs so the working lists start higher on screen.",
    ],
  },
  {
    version: "2026.09.24.2",
    date: "September 24, 2026",
    changes: [
      "Renamed the compact Schedule tab to Future, with SCHEDULE as its action label.",
      "Reworked Future into daily and recurring routines on the left, with every dated reminder listed soonest-first on the right.",
      "Moved the smaller green progress calendar above Today’s checklist.",
      "Replaced the Clients tab with a global Main, client, or agent scope filter in the top line.",
    ],
  },
  {
    version: "2026.09.24.1",
    date: "September 24, 2026",
    changes: [
      "Combined Daily, Weekly, and Tickler into one Schedule (FUTURE) workspace.",
      "Reworked Today into a narrow checklist-and-schedule lane beside Inbox, unprioritized next actions, then priority A, B, and C actions.",
      "Empty Today sections are now omitted instead of leaving unused headings behind.",
    ],
  },
  {
    version: "2026.09.23.1",
    date: "September 23, 2026",
    changes: [
      "Added a priority picker to the Add to Next Actions choice while processing an Inbox item, with B selected by default.",
      "The chosen A, B, C, or no-priority value is applied when the next action is created.",
    ],
  },
  {
    version: "2026.09.19.1",
    date: "September 19, 2026",
    changes: [
      "Removed the quick Capture to inbox form; new inputs are captured through conversation instead.",
      "Combined the event-log toggle, release number, loaded-item status, and Copy log control into one compact diagnostic line.",
    ],
  },
  {
    version: "2026.09.18.3",
    date: "September 18, 2026",
    changes: [
      "Added a Weekly tab for recurring activities that need a place in the week without becoming daily habits.",
      "Weekly activities can be checked off once per Monday–Sunday week, with consecutive-week streaks and add/delete controls.",
      "Added Project24 video-course study as the first weekly activity.",
    ],
  },
  {
    version: "2026.09.18.2",
    date: "September 18, 2026",
    changes: [
      "Today page redesigned around two lanes: a Scheduled lane that chronologically merges Google Calendar events, manual scheduled items, and today’s due ticklers, plus a Prioritized next actions lane sorted A → B → C → unprioritized.",
      "New Upcoming section shows the rest of the seven-day window, day by day.",
      "Google Calendar sync: a 15-minute sync keeps a read-only calendar lane fresh; sync problems are reported quietly instead of breaking the page.",
      "New Daily tab for small daily habits: today’s checkboxes, a gray-to-green monthly grid (no red, no shame), and per-habit all-pass streaks.",
    ],
  },
  {
    version: "2026.09.18.1",
    date: "September 18, 2026",
    changes: [
      "Added simple A, B, and C priority flags to next actions and inbox items, with unprioritized as the default.",
      "Next Actions now sorts by priority and can be filtered to one priority level without changing the existing NEXT workflow.",
      "Inbox items keep their priority when clarified into a next action.",
    ],
  },
  {
    version: "2026.09.17.10",
    date: "September 17, 2026",
    changes: [
      "Added a dedicated Done folder that brings completed next actions, projects, and tickler items into one list, with the newest recorded completions first.",
      "New completions now record their completion time. Previously completed items remain honest and are labeled date unknown.",
    ],
  },
  {
    version: "2026.09.17.9",
    date: "September 17, 2026",
    changes: [
      "Fixed the health check after the .17.8 update: the server was still identifying itself as release 2026.09.17.6, which failed every health report and showed a misleading \u201cnewer release available\u201d notice. The server release marker is aligned with the client again.",
    ],
  },
  {
    version: "2026.09.17.8",
    date: "September 17, 2026",
    changes: [
      "The Copy log button moved up to the top line next to the release button, so it is always visible without scrolling to the event log.",
      "The event log body is now collapsed behind an expanding panel by default; the panel header shows the live event count and expands on tap.",
    ],
  },
  {
    version: "2026.09.17.7",
    date: "September 17, 2026",
    changes: [
      "Fixed the desktop empty-state regression: the loaded workspace is now committed through a dedicated workspaceState field instead of the generic data field, which did not survive the custom-element boundary intact (a validated 221-row response was committed as 0 rows).",
      "Every workspace commit is now guarded by an immediate recount of all eight collections; a commit that would lose rows throws instead of silently rendering an empty screen.",
      "The client now loads through a release-specific route (loadWorkspaceRelease2026091707) so the server can prove exactly which desktop bundle is talking to it.",
      "Added a populated-state regression test that proves a validated 221-row workspace commits all 221 rows and produces a matching post-render health report.",
    ],
  },
  {
    version: "2026.09.17.6",
    date: "September 17, 2026",
    changes: [
      "Fixed the empty workspace on desktop Chrome: a strict blob: host denies every localStorage and sessionStorage access, and the validated workspace must never be discarded because of it.",
      "The validated workspace response is now committed straight to in-memory render state; browser storage is only a best-effort cache and can no longer wipe loaded lists.",
      "The diagnostic outbox is memory-first, so a storage-blocked client can still queue and report its own diagnostics to the server.",
      "A storage-blocked client never auto-reloads for a newer release: without a durable reload-once marker (an in-memory flag cannot survive the navigation it gates) it keeps working and shows a notice that a newer release is available.",
      "Added a regression test that denies all storage access and proves a validated 221-row workspace still commits and renders with data.",
    ],
  },
  {
    version: "2026.09.17.5",
    date: "September 17, 2026",
    changes: [
      "Every previously silent failure path now records a server-side diagnostic (watchdog-fired, load-timeout, render-failed, report-failed) so the health check reports a reason instead of going silent.",
      "A stalled first load can no longer wedge the app: the watchdog releases the screen, keeps waiting for the late response in the same request generation, and retries with bounded backoff instead of looping forever.",
      "The render self-check retries once before giving up, and unsent diagnostics wait in a local outbox that flushes on the next successful server round-trip.",
    ],
  },
  {
    version: "2026.09.17.4",
    date: "September 17, 2026",
    changes: [
      "Made the loader-owned workspace object the only holder used for rendering, without a browser snapshot or React state mirror.",
      "Validated the sum of every loaded collection against row_count before accepting any response.",
      "Measured concrete DOM row elements after every settled render and restored strict render-health reporting with an unknown pre-measurement state.",
    ],
  },
  {
    version: "2026.09.17.3",
    date: "September 17, 2026",
    changes: [
      "Removed the React mount lifecycle entirely so one permanent GTD element owns loading, state, and rendering from launch onward.",
      "The render measurement now totals the rows represented by every folder in the DOM and must exactly match the 215+ loaded records.",
      "Made settled render reporting failure-safe and strengthened the health check to fail on any state/render count difference.",
    ],
  },
  {
    version: "2026.09.17.2",
    date: "September 17, 2026",
    changes: [
      "Restored one authoritative workspace state: the mounted GTD element now owns both loading and rendering.",
      "Removed React from workspace data synchronization; it now remains a passive mount with no copied state, event bridge, or remount key.",
      "A selected workspace response is assigned and rendered synchronously, with matching state row counts recorded in the event log.",
    ],
  },
  {
    version: "2026.09.17.1",
    date: "September 17, 2026",
    changes: [
      "Moved the automatic workspace self-check to the end of the actual DOM render.",
      "Render-complete logging, the in-page self-check, and getHealthReport now share one measured visible-row result with a render generation ID.",
      "A populated workspace that draws zero visible rows now records a failed self-check instead of copying the state count into the rendered count.",
    ],
  },
  {
    version: "2026.09.16.10",
    date: "September 16, 2026",
    changes: [
      "Added a build-time mounted-app regression test that loads 210 fake rows through the normal workspace action path.",
      "The build now checks every populated GTD folder in the rendered interface and fails if a populated workspace draws zero rows.",
    ],
  },
  {
    version: "2026.09.16.9",
    date: "September 16, 2026",
    changes: [
      "Added a dedicated getHealthReport action that can run the full workspace consistency check without opening this page.",
      "The pollable report returns every collection count, the total state and render counts, data presence, pass/fail status, release, and check time.",
      "Workspace loading and external health polling now use one canonical server-side health evaluation.",
    ],
  },
  {
    version: "2026.09.16.8",
    date: "September 16, 2026",
    changes: [
      "Loads through a release-specific route first and reconciles an empty reply against a second independent read before changing the visible lists.",
      "Keeps a known populated workspace on screen if both automatic reads unexpectedly return empty, then retries on its own every 12 seconds.",
      "Runs background checks every 20 seconds, automatically reloads once when the server reports a newer release, and includes the client release in every workspace request.",
    ],
  },
  {
    version: "2026.09.16.7",
    date: "September 16, 2026",
    changes: [
      "Restored the proven watchdog behavior: a request that never settles now releases the loading screen and leaves Try again available.",
      "Refresh always starts a new request, while late replies are accepted only when no newer request has replaced them.",
      "Error inspection is cycle-safe so an unusual rejected value cannot strand the workspace between loading and failure states.",
    ],
  },
  {
    version: "2026.09.16.6",
    date: "September 16, 2026",
    changes: [
      "Keeps the last valid workspace visible while a fresh database read connects, so a delayed launch cannot replace populated folders with an empty opening screen.",
      "Every verified workspace response refreshes the browser-side recovery copy; the database remains the canonical source for every item and edit.",
    ],
  },
  {
    version: "2026.09.16.5",
    date: "September 16, 2026",
    changes: [
      "Stopped discarding a valid workspace response just because it arrived after the previous nine-second cutoff.",
      "A slow launch now keeps both workspace routes eligible, shows a clear connection message, and offers a reconnect without replacing the stored lists.",
    ],
  },
  {
    version: "2026.09.16.4",
    date: "September 16, 2026",
    changes: [
      "Added a REF button to every item so its GTD type, ID, and title can be pasted into chat.",
      "Copying now confirms success in place and gives a clear manual-copy fallback when clipboard access is unavailable.",
    ],
  },
  {
    version: "2026.09.16.3",
    date: "September 16, 2026",
    changes: [
      "Made the mounted GTD workspace the single owner of loading and rendering its data.",
      "Removed the separate React Query snapshot that could seed a new workspace instance with an empty result after a live response arrived.",
      "A connected workspace now always starts its own live load, so the rendered row count stays aligned with the action response.",
    ],
  },
  {
    version: "2026.09.16.2",
    date: "September 16, 2026",
    changes: [
      "Restored the complete workspace after a scaffold placeholder replaced the GTD interface.",
      "Initial loading now runs through React Query and the live workspace action before any folder appears.",
      "Inbox processing now includes reference, resolved, do now, action, project with a required next action, delegation, and tickler choices.",
      "Refresh request IDs now always use a browser-safe timestamp and counter.",
    ],
  },
  {
    version: "2026.09.15.9",
    date: "September 15, 2026",
    changes: [
      "Made every render failure resolve to a visible recovery screen instead of leaving the loading view in place.",
      "Hardened date display so one malformed date cannot prevent the remaining lists from opening.",
      "Kept the diagnostic log compact by recording workspace counts instead of every task body.",
    ],
  },
  {
    version: "2026.09.15.8",
    date: "September 15, 2026",
    changes: [
      "Added a compact event log at the top of the workspace with one-click full-log copying.",
      "Requests, payloads, full responses, state changes, rendering, interactions, timeouts, and errors are now recorded in sequence.",
      "Log serialization is failure-safe and redacts credential-like fields before display or copying.",
    ],
  },
  {
    version: "2026.09.15.7",
    date: "September 15, 2026",
    changes: [
      "A stalled workspace request now ends cleanly instead of leaving the page waiting forever.",
      "Each retry starts a genuinely new request, with an automatic second route if the first action does not answer.",
      "Try again can no longer reuse an unresolved request from the previous attempt.",
    ],
  },
  {
    version: "2026.09.15.6",
    date: "September 15, 2026",
    changes: [
      "Added one client table with the anonymized identifiers DH/AP and VC/FR.",
      "Client projects and next actions now show the clock-in rule without revealing real client identities.",
      "Projects can reference a client record instead of repeating client names.",
    ],
  },
  {
    version: "2026.09.15.5",
    date: "September 15, 2026",
    changes: [
      "Removed the custom request-verification handshake that could discard a valid workspace response.",
      "Workspace loading and refresh now use the standard action client without a client-side timeout or strict response checks.",
    ],
  },
  {
    version: "2026.09.15.4",
    date: "September 15, 2026",
    changes: [
      "Replaced the ambiguous empty load state with a verified request-and-response handshake.",
      "Refresh now makes one fresh workspace request and keeps the last loaded lists visible if that request fails.",
    ],
  },
  {
    version: "2026.09.15.3",
    date: "September 15, 2026",
    changes: [
      "Restored workspace loading through the stable list action while preserving a unique refresh key for every request.",
      "A terminal action connection now reconnects the page instead of retrying a client that can no longer send requests.",
    ],
  },
  {
    version: "2026.09.15.2",
    date: "September 15, 2026",
    changes: ["Made load failures reliably show their error message, even when the original error cannot be converted to text."],
  },
  {
    version: "2026.09.15.1",
    date: "September 15, 2026",
    changes: [
      "Restored the release number at the top of every folder.",
      "Added this in-app version log so each change remains traceable.",
    ],
  },
  {
    version: "2026.09.14.1",
    date: "September 14, 2026",
    changes: ["Introduced a visible release identifier for the GTD workspace."],
  },
];

const esc = (value: unknown) => String(value ?? "").replace(/[&<>'"]/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
}[character] || character));
const localDate = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const parseDay = (value: string) => new Date(`${value}T12:00:00`);
const todayKey = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const currentWeekKey = () => {
  const date = localDate(new Date());
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return dayKey(date);
};
const shiftDayKey = (value: string, amount: number) => dayKey(addDays(parseDay(value), amount));
const localRfc3339 = (dateKey: string, time: string) => {
  const reference = new Date(`${dateKey}T12:00:00Z`);
  const zoneName = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" })
    .formatToParts(reference).find(part => part.type === "timeZoneName")?.value ?? "GMT-05:00";
  const offset = zoneName.match(/GMT([+-]\d{2}:\d{2})/)?.[1] ?? "-05:00";
  return `${dateKey}T${time}:00${offset}`;
};
const formatDate = (date: Date, options: Intl.DateTimeFormatOptions, fallback = "Date unavailable") => (
  Number.isNaN(date.getTime()) ? fallback : new Intl.DateTimeFormat(undefined, options).format(date)
);
const timeLabel = (value: string | null) => {
  if (!value) return "Any time";
  const date = new Date(`2000-01-01T${value}:00`);
  return formatDate(date, { hour: "numeric", minute: "2-digit" }, value);
};
const PRIORITY_ORDER: Record<Priority, number> = { A: 0, B: 1, C: 2, unprioritized: 3 };

class GtdWorkspace extends HTMLElement {
  private tab: Tab = "today";
  private weekStart = currentWeekKey();
  private weekSyncing = false;
  private weekCalendarMessage = "";
  private weekCalendarsOpen = false;
  private weekEditor: { date: string; eventId?: number } | null = null;
  private weekDeleteArmed: number | null = null;
  private dailyMonth = todayKey().slice(0, 7);
  private dailyDeleteArmed: number | null = null;
  private weeklyDeleteArmed: number | null = null;
  // Render-critical state lives in a dedicated, explicitly-named field: the
  // generic `data` name did not survive the custom-element boundary intact
  // (release 2026.09.17.6 committed a validated 221-row workspace as 0 rows),
  // so it must never be used for the loaded workspace again.
  private workspaceState: Workspace = EMPTY_WORKSPACE;
  private loading = true;
  private refreshing = false;
  private error = "";
  private syncWarning = "";
  private reconnectRequired = false;
  private slowConnection = false;
  private showDone = false;
  private priorityFilter: PriorityFilter = "all";
  private scope: Scope = "main";
  private expandedProject: number | null = null;
  private readonly expandedTodaySections = new Set<TodaySection>(["inbox", "A"]);
  private dialog: HTMLDialogElement | null = null;
  private refreshTimer: number | null = null;
  private retryTimer: number | null = null;
  private loadPromise: Promise<void> | null = null;
  private loadGeneration = 0;
  private loadAttemptCount = 0;
  private renderSequence = 0;
  private readonly clientInstanceId = `gtd-client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  private latestRenderedGeneration = "";
  private latestHealthReport: Workspace["health_report"] | null = null;
  private renderReportQueue: Promise<void> = Promise.resolve();
  // Memory-first diagnostic outbox: entries live here before any storage or
  // network touch, so a client whose storage throws (strict blob: hosts deny
  // every localStorage/sessionStorage access) can still queue and report them.
  private diagnosticOutboxMemory: DiagnosticEntry[] = [];
  private diagnosticFlushQueue: Promise<void> = Promise.resolve();
  private diagnosticIdCounter = 0;

  private readonly captureWindowError = (event: ErrorEvent) => {
    this.log("ERROR", "window error", { message: event.message, filename: event.filename, line: event.lineno, column: event.colno, error: event.error });
  };

  private readonly captureUnhandledRejection = (event: PromiseRejectionEvent) => {
    this.log("ERROR", "unhandled promise rejection", { reason: event.reason });
  };

  private log(level: LogLevel, event: string, detail?: unknown) {
    appendLog(level, event, detail);
    try {
      const output = this.querySelector<HTMLElement>("[data-event-log-content]");
      if (output) {
        output.textContent = formatLog();
        output.scrollTop = output.scrollHeight;
      }
      const count = this.querySelector<HTMLElement>("[data-event-log-count]");
      if (count) count.textContent = `${EVENT_LOG.length} events`;
    } catch {
      // Never allow the diagnostic panel to break the application.
    }
  }

  private async callAction<T>(name: string, payload: unknown, call: () => Promise<T>): Promise<T> {
    const started = performance.now();
    this.log("SEND", `${name} request`, { payload });
    try {
      const response = await call();
      const detail = isWorkspaceResponse(response)
        ? {
            row_count: response.row_count,
            loaded_at: response.loaded_at,
            request_id: response.request_id,
            client_release: response.client_release,
            server_release: response.server_release,
            counts: {
              clients: response.clients.length,
              projects: response.projects.length,
              actions: response.actions.length,
              ticklers: response.ticklers.length,
              inbox: response.inbox.length,
              references: response.references.length,
              someday: response.someday.length,
              scheduled: response.scheduled.length,
            },
          }
        : response;
      this.log("RECV", `${name} response`, { duration_ms: Math.round(performance.now() - started), response: detail });
      return response;
    } catch (error) {
      this.log("ERROR", `${name} rejected`, { duration_ms: Math.round(performance.now() - started), error });
      throw error;
    }
  }

  private readonly refreshWhenVisible = () => {
    this.log("INFO", "visibility/focus refresh check", { visibility: document.visibilityState, dialog_open: Boolean(this.dialog?.open) });
    if (document.visibilityState === "visible") void this.load(false);
  };

  private readonly handleWorkspaceNavigation = (event: Event) => {
    const control = (event.target as Element | null)?.closest<HTMLElement>("[data-refresh], [data-retry], [data-tab]");
    if (!control || !this.contains(control)) return;

    if (control.matches("[data-refresh], [data-retry]")) {
      const retry = control.hasAttribute("data-retry");
      this.log("INFO", retry ? "Try again clicked" : "Refresh clicked", { reconnect_required: this.reconnectRequired, load_in_flight: Boolean(this.loadPromise) });
      if (this.reconnectRequired) {
        this.log("STATE", "reloading page to reconnect");
        window.location.reload();
        return;
      }
      this.loadAttemptCount = 0;
      if (this.tab === "week") void this.syncWeekCalendar();
      else void this.load(retry, true);
      return;
    }

    const tab = control.dataset.tab as Tab | undefined;
    if (!tab) return;
    this.log("STATE", "tab changed", { from: this.tab, to: tab });
    this.tab = tab;
    this.showDone = false;
    this.weekEditor = null;
    this.weekDeleteArmed = null;
    this.weekCalendarsOpen = false;
    this.render();
    if (tab === "week") void this.syncWeekCalendar();
  };

  private async syncWeekCalendar() {
    if (this.weekSyncing) return;
    this.weekSyncing = true;
    this.weekCalendarMessage = "";
    this.render();
    try {
      const payload = { week_start: this.weekStart };
      const result = await this.callAction("syncCalendarWeek", payload, () => api.syncCalendarWeek(payload));
      if (!result.ok) {
        this.weekCalendarMessage = result.error ?? "Calendar unavailable — showing saved blocks where available.";
        return;
      }
      await this.load(false, true, true);
    } catch (error) {
      this.weekCalendarMessage = `Calendar unavailable — showing saved blocks where available. ${errorMessage(error)}`;
    } finally {
      this.weekSyncing = false;
      this.render();
    }
  }

  private async setCalendarVisibility(calendar: CalendarKey, visible: boolean) {
    const previous = { ...this.workspaceState.calendar_visibility };
    this.workspaceState = {
      ...this.workspaceState,
      calendar_visibility: { ...previous, [calendar]: visible },
    };
    this.render();
    try {
      const payload = { calendar, visible };
      const result = await this.callAction("setCalendarVisibility", payload, () => api.setCalendarVisibility(payload));
      this.workspaceState = { ...this.workspaceState, calendar_visibility: result.calendar_visibility };
      this.log("STATE", "calendar visibility saved", { calendar, visible });
      this.render();
    } catch (error) {
      this.workspaceState = { ...this.workspaceState, calendar_visibility: previous };
      this.weekCalendarMessage = `Calendar visibility could not be saved. ${errorMessage(error)}`;
      this.log("ERROR", "calendar visibility save failed", { calendar, visible, error });
      this.render();
    }
  }

  private async saveIntentBlock(form: HTMLFormElement) {
    const date = form.dataset.intentDate;
    const eventId = Number(form.dataset.intentId ?? 0) || undefined;
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
    const start = String(data.get("start_time") ?? "");
    const end = String(data.get("end_time") ?? "");
    const errorNode = form.querySelector<HTMLElement>(".form-error");
    if (!date || !title || !start || !end) {
      if (errorNode) errorNode.textContent = "Add a title, start time, and end time.";
      return;
    }
    if (end <= start) {
      if (errorNode) errorNode.textContent = "End time must be later than start time.";
      return;
    }
    form.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
    if (errorNode) errorNode.textContent = "Saving…";
    try {
      const payload = {
        ...(eventId ? { event_row_id: eventId } : {}),
        title,
        start_time: localRfc3339(date, start),
        end_time: localRfc3339(date, end),
      };
      const result = await this.callAction("saveIntentCalendarEvent", payload, () => api.saveIntentCalendarEvent(payload));
      if (!result.ok) {
        this.weekCalendarMessage = result.error ?? "The intent block could not be saved.";
        this.render();
        return;
      }
      this.weekEditor = null;
      this.weekCalendarMessage = "";
      await this.load(false, true, true);
    } catch (error) {
      this.weekCalendarMessage = `The intent block could not be saved. ${errorMessage(error)}`;
      this.render();
    }
  }

  private async deleteIntentBlock(eventId: number) {
    this.weekCalendarMessage = "Deleting…";
    this.render();
    try {
      const payload = { event_row_id: eventId };
      const result = await this.callAction("deleteIntentCalendarEvent", payload, () => api.deleteIntentCalendarEvent(payload));
      if (!result.ok) {
        this.weekCalendarMessage = result.error ?? "The intent block could not be deleted.";
        this.render();
        return;
      }
      this.weekEditor = null;
      this.weekDeleteArmed = null;
      this.weekCalendarMessage = "";
      await this.load(false, true, true);
    } catch (error) {
      this.weekCalendarMessage = `The intent block could not be deleted. ${errorMessage(error)}`;
      this.render();
    }
  }

  connectedCallback() {
    this.log("INFO", "component connected", { release: CURRENT_RELEASE, state_row_count: this.workspaceState.row_count });
    this.addEventListener("click", this.handleWorkspaceNavigation);
    document.addEventListener("visibilitychange", this.refreshWhenVisible);
    window.addEventListener("focus", this.refreshWhenVisible);
    window.addEventListener("error", this.captureWindowError);
    window.addEventListener("unhandledrejection", this.captureUnhandledRejection);
    this.refreshTimer = window.setInterval(() => {
      const eligible = document.visibilityState === "visible" && !this.dialog?.open;
      this.log("INFO", "automatic self-check", { release: CURRENT_RELEASE, eligible, visibility: document.visibilityState, dialog_open: Boolean(this.dialog?.open) });
      if (eligible) void this.load(false);
    }, AUTO_REFRESH_MS);
    // This custom element owns the workspace request and the exact response
    // object consumed by every render.
    void this.load();
  }

  disconnectedCallback() {
    this.log("INFO", "component disconnected");
    this.removeEventListener("click", this.handleWorkspaceNavigation);
    document.removeEventListener("visibilitychange", this.refreshWhenVisible);
    window.removeEventListener("focus", this.refreshWhenVisible);
    window.removeEventListener("error", this.captureWindowError);
    window.removeEventListener("unhandledrejection", this.captureUnhandledRejection);
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
  }

  private scheduleLoadRetry(reason: string) {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.loadAttemptCount += 1;
    if (this.loadAttemptCount > MAX_LOAD_ATTEMPTS) {
      this.log("ERROR", "automatic load retries exhausted", { reason, attempts: this.loadAttemptCount, max_attempts: MAX_LOAD_ATTEMPTS });
      void this.queueDiagnostic("load-gave-up", { reason, attempts: this.loadAttemptCount, max_attempts: MAX_LOAD_ATTEMPTS });
      if (!this.workspaceState.loaded_at && !this.error) {
        this.error = "The workspace could not be reached after several tries. Check the connection, then try again.";
      }
      this.loading = false;
      this.refreshing = false;
      this.render();
      return;
    }
    const delay = Math.min(LOAD_RETRY_BASE_MS * 2 ** (this.loadAttemptCount - 1), LOAD_RETRY_MAX_MS);
    this.log("STATE", "automatic retry scheduled", { release: CURRENT_RELEASE, attempt: this.loadAttemptCount, max_attempts: MAX_LOAD_ATTEMPTS, delay_ms: delay, reason });
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (!this.isConnected) return;
      this.log("INFO", "automatic retry started", { release: CURRENT_RELEASE, attempt: this.loadAttemptCount, reason });
      void this.load(false, true);
    }, delay);
  }

  private diagnosticPostTimeout<T>(name: string, call: () => Promise<T>, timeoutMs: number): Promise<T> {
    let timer = 0;
    try {
      return Promise.race([
        call(),
        new Promise<T>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]).finally(() => window.clearTimeout(timer));
    } catch (error) {
      window.clearTimeout(timer);
      throw error;
    }
  }

  private readOutboxRaw(): unknown[] {
    try {
      const raw = window.localStorage.getItem(DIAGNOSTIC_OUTBOX_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private storedDiagnostics(): DiagnosticEntry[] {
    const entries: DiagnosticEntry[] = [];
    for (const raw of this.readOutboxRaw()) {
      if (!raw || typeof raw !== "object") continue;
      const candidate = raw as { id?: unknown; kind?: unknown; detail?: unknown; client_release?: unknown; at?: unknown };
      if (typeof candidate.kind !== "string" || typeof candidate.detail !== "string"
        || typeof candidate.client_release !== "string" || typeof candidate.at !== "string") continue;
      entries.push({
        id: typeof candidate.id === "string" && candidate.id ? candidate.id : `legacy-${candidate.at}-${candidate.kind}`,
        kind: candidate.kind,
        detail: candidate.detail,
        client_release: candidate.client_release,
        at: candidate.at,
      });
    }
    return entries;
  }

  private persistDiagnosticOutbox(entries: DiagnosticEntry[]) {
    const kept = entries.slice(-DIAGNOSTIC_OUTBOX_MAX);
    if (kept.length < entries.length) {
      this.log("ERROR", "diagnostic outbox evicted oldest entries", { evicted: entries.length - kept.length, kept: kept.length, max: DIAGNOSTIC_OUTBOX_MAX });
    }
    try {
      window.localStorage.setItem(DIAGNOSTIC_OUTBOX_KEY, JSON.stringify(kept));
    } catch (error) {
      // The original diagnostic text is already in the event log and in the
      // in-memory queue; this line records the secondary fact that durable
      // local storage failed too.
      this.log("ERROR", "diagnostic outbox persist failed", { error, pending: kept.length });
    }
  }

  private queueDiagnostic(kind: string, detail: unknown) {
    const at = new Date().toISOString();
    let detailText = "";
    try {
      const serialized = JSON.stringify(safeLogValue(detail) ?? null);
      detailText = (typeof serialized === "string" ? serialized : "").slice(0, 2000);
    } catch {
      detailText = "unserializable detail";
    }
    this.log("ERROR", `client diagnostic: ${kind}`, { at, detail: detailText });
    const payload: DiagnosticEntry = {
      id: `diag-${Date.now()}-${++this.diagnosticIdCounter}`,
      kind,
      detail: detailText,
      client_release: CURRENT_RELEASE,
      at,
    };
    // Memory-first: the entry is queued before any storage or network touch,
    // so a storage-blocked client still reports its own failures.
    this.diagnosticOutboxMemory.push(payload);
    if (this.diagnosticOutboxMemory.length > DIAGNOSTIC_OUTBOX_MAX) {
      const evicted = this.diagnosticOutboxMemory.length - DIAGNOSTIC_OUTBOX_MAX;
      this.diagnosticOutboxMemory.splice(0, evicted);
      this.log("ERROR", "diagnostic outbox evicted oldest entries", { evicted, kept: this.diagnosticOutboxMemory.length, max: DIAGNOSTIC_OUTBOX_MAX });
    }
    void this.flushDiagnosticOutbox();
  }

  private async postDiagnosticEntry(entry: DiagnosticEntry): Promise<"sent" | "drop" | "stall"> {
    try {
      await this.diagnosticPostTimeout(
        "reportClientDiagnostic",
        () => this.callAction("reportClientDiagnostic", entry, () => api.reportClientDiagnostic(entry)),
        DIAGNOSTIC_POST_TIMEOUT_MS,
      );
      this.log("INFO", "client diagnostic recorded", { kind: entry.kind, at: entry.at });
      return "sent";
    } catch (error) {
      if (errorHasStatus(error, 400)) {
        // A 4xx means the entry itself is malformed and would never be
        // accepted: drop it and keep draining the rest instead of wedging
        // the FIFO queue behind it forever.
        this.log("ERROR", "dropping malformed diagnostic from outbox", { kind: entry.kind, error });
        return "drop";
      }
      this.log("ERROR", "client diagnostic post failed; queued locally", { kind: entry.kind, at: entry.at, error });
      return "stall";
    }
  }

  // Flushes are serialized through a queue so overlapping triggers (a queued
  // diagnostic, a render self-check, a manual flush) drain one at a time
  // instead of racing over the same pending entries.
  private flushDiagnosticOutbox(): Promise<void> {
    const run = this.diagnosticFlushQueue.then(() => this.flushDiagnosticOutboxInner());
    this.diagnosticFlushQueue = run.then(
      () => undefined,
      error => {
        this.log("ERROR", "diagnostic outbox flush failed", { error });
      },
    );
    return run;
  }

  private async flushDiagnosticOutboxInner() {
    // Memory-first: drain the in-memory queue before touching storage, so a
    // storage-blocked client still reports its diagnostics.
      const settledIds = new Set<string>();
      while (this.diagnosticOutboxMemory.length > 0) {
        const entry = this.diagnosticOutboxMemory[0]!;
        const outcome = await this.postDiagnosticEntry(entry);
        if (outcome === "stall") break;
        this.diagnosticOutboxMemory.shift();
        settledIds.add(entry.id);
      }
      // Reconcile storage once: drop settled ids, drop invalid legacy
      // entries, and best-effort mirror whatever is still queued in memory so
      // a reload can recover entries that never posted.
      const raw = this.readOutboxRaw();
      const stored = this.storedDiagnostics();
      if (stored.length < raw.length) {
        this.log("ERROR", "diagnostic outbox dropped invalid entries", { dropped: raw.length - stored.length });
      }
      const remaining = stored.filter(entry => !settledIds.has(entry.id));
      const remainingIds = new Set(remaining.map(entry => entry.id));
      for (const entry of this.diagnosticOutboxMemory) {
        if (!remainingIds.has(entry.id)) {
          remaining.push(entry);
          remainingIds.add(entry.id);
        }
      }
      this.persistDiagnosticOutbox(remaining);
      // Drain entries persisted by previous page loads (or older releases),
      // skipping anything already queued in memory so nothing posts twice.
      let queue = this.storedDiagnostics().filter(entry => !this.diagnosticOutboxMemory.some(queued => queued.id === entry.id));
      if (queue.length > 0 || this.diagnosticOutboxMemory.length > 0) {
        this.log("INFO", "flushing diagnostic outbox", { pending: queue.length + this.diagnosticOutboxMemory.length });
      }
      while (queue.length > 0) {
        const entry = queue[0]!;
        const outcome = await this.postDiagnosticEntry(entry);
        if (outcome === "stall") {
          this.log("ERROR", "diagnostic outbox flush stalled", { kind: entry.kind });
          break;
        }
        queue = queue.slice(1);
        this.persistDiagnosticOutbox([...this.diagnosticOutboxMemory, ...queue]);
      }
      if (queue.length === 0 && this.diagnosticOutboxMemory.length === 0) {
        this.log("INFO", "diagnostic outbox flushed");
      }
  }

  private async awaitLateResult<T>(promise: Promise<T>): Promise<T> {
    let timer = 0;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error(`stalled workspace request exceeded ${LATE_RESULT_TIMEOUT_MS}ms waiting for a late response`)), LATE_RESULT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      window.clearTimeout(timer);
    }
  }

  private load(showLoading = true, forceNew = false, allowEmpty = false) {
    if (this.loadPromise && !forceNew) {
      this.log("STATE", "background load skipped while a request is active", { show_loading: showLoading });
      return this.loadPromise;
    }

    const generation = ++this.loadGeneration;
    this.log("STATE", "load started", { generation, show_loading: showLoading, force_new: forceNew, had_data: Boolean(this.workspaceState.loaded_at) });
    const run = this.loadWorkspace(showLoading, generation, allowEmpty);
    this.loadPromise = run;
    const clear = () => {
      if (this.loadPromise === run) {
        this.loadPromise = null;
        this.log("STATE", "load promise cleared", { generation });
      }
    };
    void run.then(clear, clear);
    return run;
  }

  private requestWorkspace(
    route: "release" | "live",
    requestId: string,
  ): Promise<Workspace> {
    const calendarWeek = this.tab === "week" ? this.weekStart : currentWeekKey();
    const payload = {
      request_id: requestId,
      client_release: CURRENT_RELEASE,
      daily_date: todayKey(),
      daily_month: this.dailyMonth,
      calendar_start: shiftDayKey(calendarWeek, -1),
      calendar_end: shiftDayKey(calendarWeek, 8),
    };
    const actionName = route === "release" ? "loadWorkspaceRelease2026091803" : "loadWorkspaceLive";
    this.log("INFO", "workspace route selected", { route, action: actionName, request_id: requestId, client_release: CURRENT_RELEASE });
    const request = route === "release"
      ? this.callAction(actionName, payload, () => api.loadWorkspaceRelease2026091803(payload))
      : this.callAction(actionName, payload, () => api.loadWorkspaceLive(payload));
    return request.then(workspace => {
      if (!isWorkspaceResponse(workspace)) {
        const error = new Error(`${actionName} returned an invalid workspace response`);
        console.error("GTD workspace response validation failed", error, workspace);
        this.log("ERROR", "workspace response validation failed", { route, action: actionName, request_id: requestId, error });
        throw error;
      }
      const actualRowCount = workspace.clients.length
        + workspace.projects.length
        + workspace.actions.length
        + workspace.ticklers.length
        + workspace.inbox.length
        + workspace.references.length
        + workspace.someday.length
        + workspace.scheduled.length;
      if (actualRowCount !== workspace.row_count) {
        const error = new Error(`${actionName} returned ${actualRowCount} collection rows but declared row_count ${workspace.row_count}`);
        console.error("GTD workspace response validation failed", error, workspace);
        this.log("ERROR", "workspace response row_count mismatch", { route, action: actionName, request_id: requestId, actual_row_count: actualRowCount, declared_row_count: workspace.row_count });
        throw error;
      }
      this.log("INFO", "workspace response row_count validated", { route, action: actionName, request_id: requestId, actual_row_count: actualRowCount });
      return workspace;
    });
  }

  // The single commit point for a validated workspace. The state lives in the
  // dedicated workspaceState field (never a generic `data` field — see the
  // field comment), and the commit is verified immediately: all eight
  // collections are recounted after the assignment, and any mismatch throws
  // instead of letting an empty or partial state be logged as a success.
  private commitWorkspaceState(workspace: Workspace, expectedRowCount: number) {
    this.workspaceState = workspace;
    const actualRowCount =
      workspace.clients.length +
      workspace.projects.length +
      workspace.actions.length +
      workspace.ticklers.length +
      workspace.inbox.length +
      workspace.references.length +
      workspace.someday.length +
      workspace.scheduled.length;
    if (actualRowCount !== expectedRowCount) {
      throw new Error(`workspace commit changed ${expectedRowCount} validated rows into ${actualRowCount} state rows`);
    }
  }

  private applyWorkspaceResult(
    result: { workspace: Workspace; route: "release" | "live"; attempt: number },
    generation: number,
    timing: "on-time" | "late",
  ) {
    if (generation !== this.loadGeneration) {
      this.log("STATE", "stale workspace response ignored", { generation, current_generation: this.loadGeneration, route: result.route, timing });
      return;
    }
    if (!isWorkspaceResponse(result.workspace)) throw new Error("workspace response had an unexpected shape");

    const workspace = result.workspace;
    const counts = {
      clients: workspace.clients.length,
      projects: workspace.projects.length,
      actions: workspace.actions.length,
      ticklers: workspace.ticklers.length,
      inbox: workspace.inbox.length,
      references: workspace.references.length,
      someday: workspace.someday.length,
      scheduled: workspace.scheduled.length,
    };
    const stateRowCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const health = workspace.health_report;
    const countMismatch = Object.entries(counts).some(([key, value]) => health.state_row_counts[key as keyof typeof counts] !== value);
    if (workspace.row_count !== stateRowCount || health.state_row_count !== stateRowCount || countMismatch) {
      throw new Error("workspace state counts did not match the loaded collections");
    }
    if (health.release_version !== workspace.server_release) throw new Error("workspace health report release did not match the server release");
    if (workspace.client_release && workspace.client_release !== CURRENT_RELEASE) throw new Error("workspace response did not echo the submitted release");
    this.log("INFO", "workspace response selected", { generation, route: result.route, attempt: result.attempt, timing, state_row_count: stateRowCount });
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.error = "";
    this.syncWarning = "";
    this.slowConnection = false;
    this.reconnectRequired = false;
    this.loading = false;
    this.refreshing = false;

    // One owner, one synchronous commit: the validated workspace object is
    // assigned straight to in-memory render state with no round-trip through
    // browser storage. Storage is a best-effort cache only: a host that denies
    // storage access (desktop Chrome inside a strict blob: iframe) must never
    // cause a validated response to be discarded or replaced with an empty
    // default, so nothing on this path reads storage before the commit.
    this.commitWorkspaceState(workspace, stateRowCount);
    this.log("STATE", "workspace state updated", { generation, release: CURRENT_RELEASE, server_release: this.workspaceState.server_release, row_count: this.workspaceState.row_count, counts, data_owner: "gtd-workspace" });
    this.loadAttemptCount = 0;

    // Evaluate the release mismatch BEFORE the single render below, so a
    // storage-blocked client's update notice appears in the same render pass
    // instead of triggering a second render (which would double the render
    // self-check traffic for the whole mismatch window).
    let reloadScheduled = false;
    if (workspace.server_release !== CURRENT_RELEASE) {
      // Reload-once guard: the durable marker lives in sessionStorage. Strict
      // hosts (desktop Chrome in a blob: iframe) deny storage access entirely,
      // and without a durable marker an automatic reload could loop forever:
      // an in-memory flag cannot survive the navigation it gates. So a
      // storage-blocked client never auto-reloads here; it keeps working and
      // tells the user a newer release is available instead of silently
      // staying on the old build.
      let storageAvailable = true;
      let alreadyReloaded = false;
      try {
        alreadyReloaded = window.sessionStorage.getItem(RELEASE_RELOAD_KEY) === workspace.server_release;
      } catch {
        storageAvailable = false;
      }
      this.log("STATE", "release mismatch detected", { client_release: CURRENT_RELEASE, server_release: workspace.server_release, already_reloaded: alreadyReloaded, storage_available: storageAvailable });
      if (!storageAvailable) {
        this.syncWarning = `A newer GTD release (${workspace.server_release}) is available — reload the page to update.`;
      } else if (!alreadyReloaded) {
        try {
          window.sessionStorage.setItem(RELEASE_RELOAD_KEY, workspace.server_release);
          reloadScheduled = true;
        } catch {
          // Storage vanished between the read and the write; without a
          // durable marker, skip the reload rather than risk looping.
          this.syncWarning = `A newer GTD release (${workspace.server_release}) is available — reload the page to update.`;
        }
      }
    }

    this.render();
    void this.flushDiagnosticOutbox();
    if (reloadScheduled) {
      window.setTimeout(() => window.location.reload(), 250);
    }
  }

  private async reconcileEmptyResponse(
    attempts: readonly Promise<{ workspace: Workspace; route: "release" | "live"; attempt: number }>[],
    selected: { workspace: Workspace; route: "release" | "live"; attempt: number },
    generation: number,
  ) {
    this.log("INFO", "empty workspace response awaiting independent reconciliation", { generation, route: selected.route, grace_ms: EMPTY_RESPONSE_GRACE_MS });
    const reconciled = Promise.allSettled(attempts).then(results => {
      const successful = results
        .filter((result): result is PromiseFulfilledResult<{ workspace: Workspace; route: "release" | "live"; attempt: number }> => result.status === "fulfilled")
        .map(result => result.value)
        .sort((left, right) => right.workspace.row_count - left.workspace.row_count);
      return successful[0] ?? selected;
    });
    return Promise.race([
      reconciled,
      new Promise<typeof selected>(resolve => window.setTimeout(() => resolve(selected), EMPTY_RESPONSE_GRACE_MS)),
    ]);
  }

  private async loadWorkspace(showLoading: boolean, generation: number, allowEmpty: boolean) {
    const hadData = Boolean(this.workspaceState.loaded_at);
    this.slowConnection = false;
    this.reconnectRequired = false;
    if (showLoading && !hadData) this.loading = true;
    else this.refreshing = true;
    if (!hadData) this.error = "";
    this.log("STATE", "loading flags updated", { generation, loading: this.loading, refreshing: this.refreshing, had_data: hadData });
    this.render();

    let fallbackTimer: number | null = null;
    let watchdogTimer: number | null = null;
    let workspaceRendered = false;
    try {
      const requestBase = `gtd-${Date.now()}-${++eventSequence}-${Math.random().toString(36).slice(2, 10)}`;
      this.log("INFO", "request ID generated", { generation, request_base: requestBase, generator: "timestamp-counter", client_release: CURRENT_RELEASE });
      let startFallback = () => {};
      const fallbackGate = new Promise<void>(resolve => { startFallback = resolve; });
      fallbackTimer = window.setTimeout(startFallback, 1_200);
      const primary = this.requestWorkspace("release", `${requestBase}-release`)
        .then(workspace => ({ workspace, route: "release" as const, attempt: 1 }))
        .catch(error => {
          this.log("ERROR", "workspace route failed", { generation, route: "release", attempt: 1, error });
          startFallback();
          throw error;
        });
      const fallback = fallbackGate
        .then(() => this.requestWorkspace("live", `${requestBase}-live`))
        .then(workspace => ({ workspace, route: "live" as const, attempt: 2 }))
        .catch(error => {
          this.log("ERROR", "workspace route failed", { generation, route: "live", attempt: 2, error });
          throw error;
        });
      const attempts = [primary, fallback] as const;
      const resultPromise = Promise.any(attempts);
      const watchdog = new Promise<{ kind: "watchdog" }>(resolve => {
        watchdogTimer = window.setTimeout(() => resolve({ kind: "watchdog" }), WORKSPACE_WATCHDOG_MS);
      });
      const outcome = await Promise.race([
        resultPromise.then(result => ({ kind: "result" as const, result })),
        watchdog,
      ]);

      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      if (watchdogTimer !== null) window.clearTimeout(watchdogTimer);

      if (outcome.kind === "watchdog") {
        this.log("ERROR", "workspace watchdog released stalled request", { generation, release: CURRENT_RELEASE, elapsed_ms: WORKSPACE_WATCHDOG_MS, had_data: hadData });
        void this.queueDiagnostic("watchdog-fired", { generation, elapsed_ms: WORKSPACE_WATCHDOG_MS, had_data: hadData });
        if (generation === this.loadGeneration) {
          this.slowConnection = false;
          this.reconnectRequired = false;
          this.loading = false;
          if (hadData) this.syncWarning = "Automatic check is still waiting — keeping the last loaded lists and trying again soon.";
          else this.error = "The workspace did not answer yet. It will try again automatically.";
          this.render();
        }

        // The watchdog releases the UI without cancelling a potentially valid
        // server reply. Keep waiting for that reply inside THIS generation
        // (bounded) so a late-but-valid response is still applied, rendered,
        // and measured — a retry must never orphan a response into "stale"
        // oblivion while a newer generation is already waiting.
        try {
          const lateResult = await this.awaitLateResult(resultPromise);
          if (generation !== this.loadGeneration) {
            this.log("STATE", "late workspace response superseded", { generation, current_generation: this.loadGeneration });
            return;
          }
          let selected = lateResult;
          if (selected.workspace.row_count === 0) {
            selected = await this.reconcileEmptyResponse(attempts, selected, generation);
            if (generation !== this.loadGeneration) return;
          }
          if (!allowEmpty && this.workspaceState.row_count > 0 && selected.workspace.row_count === 0) {
            this.log("ERROR", "late empty workspace rejected by self-check", { generation, release: CURRENT_RELEASE, preserved_row_count: this.workspaceState.row_count });
            this.syncWarning = `Automatic check returned empty — keeping all ${this.workspaceState.row_count} loaded items and trying again.`;
            this.scheduleLoadRetry("late empty workspace");
            return;
          }
          this.applyWorkspaceResult(selected, generation, "late");
          workspaceRendered = true;
          void this.queueDiagnostic("watchdog-recovered", { generation, route: selected.route, state_row_count: selected.workspace.row_count });
        } catch (error) {
          this.log("ERROR", "stalled workspace request never settled", { generation, error });
          if (generation !== this.loadGeneration) return;
          // The original request is still in flight past the late window. It
          // can no longer be applied (a newer generation may own the UI), so
          // note its eventual outcome in the event log instead of discarding
          // it silently.
          void resultPromise.then(
            result => this.log("INFO", "stalled request settled after the late window", { generation, route: result.route, state_row_count: result.workspace.row_count }),
            lateError => this.log("ERROR", "stalled request failed after the late window", { generation, error: lateError }),
          );
          void this.queueDiagnostic("load-timeout", { generation, waited_ms: WORKSPACE_WATCHDOG_MS + LATE_RESULT_TIMEOUT_MS, error: errorMessage(error) });
          this.scheduleLoadRetry("workspace request timed out");
        }
        return;
      }

      let selected = outcome.result;
      if (selected.workspace.row_count === 0) {
        selected = await this.reconcileEmptyResponse(attempts, selected, generation);
      }

      if (!allowEmpty && this.workspaceState.row_count > 0 && selected.workspace.row_count === 0) {
        this.log("ERROR", "empty workspace rejected by self-check", { generation, release: CURRENT_RELEASE, preserved_row_count: this.workspaceState.row_count, route: selected.route });
        this.syncWarning = `Automatic check returned empty — keeping all ${this.workspaceState.row_count} loaded items and trying again.`;
        this.scheduleLoadRetry("unexpected empty workspace");
        return;
      }

      this.applyWorkspaceResult(selected, generation, "on-time");
      workspaceRendered = true;
    } catch (caught) {
      console.error("GTD workspace load failed", caught);
      this.log("ERROR", "workspace load failed", { generation, error: caught, had_data: hadData });
      if (generation !== this.loadGeneration) return;
      void this.queueDiagnostic("load-error", { generation, had_data: hadData, error: errorMessage(caught), reconnect_required: errorHasStatus(caught, 404) });
      this.slowConnection = false;
      this.reconnectRequired = errorHasStatus(caught, 404);
      if (hadData) {
        this.syncWarning = this.reconnectRequired
          ? "Connection changed — keeping the last loaded lists while the app reconnects automatically."
          : "Automatic check failed — keeping the last loaded lists and trying again soon.";
      } else if (this.reconnectRequired) {
        this.error = "The connection changed before your lists opened. The app will reconnect automatically.";
      } else {
        this.error = `Your lists haven't loaded yet (${errorMessage(caught)}). The app will try again automatically.`;
      }
      if (this.reconnectRequired) {
        try {
          const reconnectMarker = `connection:${CURRENT_RELEASE}`;
          if (window.sessionStorage.getItem(RELEASE_RELOAD_KEY) !== reconnectMarker) {
            window.sessionStorage.setItem(RELEASE_RELOAD_KEY, reconnectMarker);
            this.log("STATE", "automatic reconnect reload scheduled", { release: CURRENT_RELEASE });
            window.setTimeout(() => window.location.reload(), 600);
          }
        } catch {
          // If session storage is unavailable, retry the action without
          // introducing an unbounded reload loop: an in-memory flag cannot
          // survive the navigation it would gate.
        }
      }
      this.scheduleLoadRetry(this.reconnectRequired ? "action connection changed" : "workspace load failure");
    } finally {
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      if (watchdogTimer !== null) window.clearTimeout(watchdogTimer);
      if (generation === this.loadGeneration) {
        this.loading = false;
        this.refreshing = false;
        this.log("STATE", "loading flags cleared", { generation, loading: this.loading, refreshing: this.refreshing, error: this.error, sync_warning: this.syncWarning, reconnect_required: this.reconnectRequired, workspace_rendered: workspaceRendered });
        if (!workspaceRendered) this.render();
      } else {
        this.log("STATE", "stale load finished without changing current flags", { generation, current_generation: this.loadGeneration });
      }
    }
  }

  private scopeOptions() {
    const agentNames = new Map<string, string>();
    const rememberAgent = (raw: string) => {
      const name = raw.trim().replace(/^[\s:—-]+|[\s:—-]+$/g, "");
      if (!name || name.length > 80) return;
      const key = name.toLocaleLowerCase();
      if (!agentNames.has(key)) agentNames.set(key, name);
    };
    const scan = (...values: Array<string | null | undefined>) => {
      const text = values.filter(Boolean).join(" · ");
      for (const match of text.matchAll(/\b([A-Za-z][A-Za-z0-9_-]*bot)\b/gi)) {
        const name = match[1];
        if (name) rememberAgent(name);
      }
      const waiting = text.match(/\bWaiting:\s*([^—\n]+?)\s*—/i)?.[1];
      if (waiting) rememberAgent(waiting);
      for (const name of ["Memnar", "Skeletor"]) {
        if (new RegExp(`\\b${name}\\b`, "i").test(text)) rememberAgent(name);
      }
    };
    this.workspaceState.actions.forEach(item => scan(item.title, item.notes, item.context, item.project_title));
    this.workspaceState.projects.forEach(item => scan(item.title, item.outcome, item.notes));
    this.workspaceState.inbox.forEach(item => scan(item.title, item.notes));
    this.workspaceState.ticklers.forEach(item => scan(item.title, item.notes));
    this.workspaceState.scheduled.forEach(item => scan(item.title, item.notes, item.source_label));
    this.workspaceState.references.forEach(item => scan(item.title, item.notes));
    this.workspaceState.someday.forEach(item => scan(item.title, item.notes));
    const agents = [...agentNames.values()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
    return {
      clients: this.workspaceState.clients.map(client => ({ value: `client:${client.id}` as Scope, label: client.name })),
      agents: agents.map(agent => ({ value: `agent:${encodeURIComponent(agent)}` as Scope, label: agent })),
    };
  }

  private scopeControl() {
    const options = this.scopeOptions();
    const valid = this.scope === "main" || [...options.clients, ...options.agents].some(option => option.value === this.scope);
    if (!valid) this.scope = "main";
    const client = this.scopeClient();
    return `<div class="scope-controls ${client ? "has-client" : ""}"><label class="scope-filter"><span>Scope</span><select data-scope-filter aria-label="Filter every folder by scope"><option value="main" ${this.scope === "main" ? "selected" : ""}>Main</option>${options.clients.length ? `<optgroup label="Clients">${options.clients.map(option => `<option value="${esc(option.value)}" ${this.scope === option.value ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</optgroup>` : ""}${options.agents.length ? `<optgroup label="Agents">${options.agents.map(option => `<option value="${esc(option.value)}" ${this.scope === option.value ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</optgroup>` : ""}<option value="add-client">+ Add client…</option></select></label>${client ? `<button type="button" class="scope-edit" data-edit="client" data-id="${client.id}" aria-label="Edit client ${esc(client.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg></button>` : ""}</div>`;
  }

  private scopeClient() {
    if (!this.scope.startsWith("client:")) return null;
    const id = Number(this.scope.slice("client:".length));
    return this.workspaceState.clients.find(client => client.id === id) ?? null;
  }

  private scopeAgent() {
    if (!this.scope.startsWith("agent:")) return null;
    try { return decodeURIComponent(this.scope.slice("agent:".length)); }
    catch { return this.scope.slice("agent:".length); }
  }

  private matchesScopeText(...values: Array<string | null | undefined>) {
    if (this.scope === "main") return true;
    const target = (this.scopeClient()?.name ?? this.scopeAgent())?.trim();
    if (!target) return false;
    const haystack = values.filter(Boolean).join(" ").toLocaleLowerCase();
    const needle = target.toLocaleLowerCase();
    const isWordCharacter = (character: string) => /[\p{L}\p{N}_]/u.test(character);
    let index = haystack.indexOf(needle);
    while (index >= 0) {
      const before = index > 0 ? haystack[index - 1] ?? "" : "";
      const afterIndex = index + needle.length;
      const after = afterIndex < haystack.length ? haystack[afterIndex] ?? "" : "";
      if ((!before || !isWordCharacter(before)) && (!after || !isWordCharacter(after))) return true;
      index = haystack.indexOf(needle, index + Math.max(needle.length, 1));
    }
    return false;
  }

  private scopedProjects() {
    const client = this.scopeClient();
    return this.workspaceState.projects.filter(item => client
      ? item.client_id === client.id || this.matchesScopeText(item.title, item.outcome, item.notes, item.client_name)
      : this.matchesScopeText(item.title, item.outcome, item.notes, item.client_name));
  }

  private scopedActions() {
    const client = this.scopeClient();
    return this.workspaceState.actions.filter(item => client
      ? item.client_name === client.name || this.matchesScopeText(item.title, item.notes, item.context, item.project_title, item.client_name)
      : this.matchesScopeText(item.title, item.notes, item.context, item.project_title, item.client_name));
  }

  private scopedTicklers() { return this.workspaceState.ticklers.filter(item => this.matchesScopeText(item.title, item.notes)); }
  private scopedInbox() { return this.workspaceState.inbox.filter(item => this.matchesScopeText(item.title, item.notes)); }
  private scopedReferences() { return this.workspaceState.references.filter(item => this.matchesScopeText(item.title, item.notes)); }
  private scopedSomeday() { return this.workspaceState.someday.filter(item => this.matchesScopeText(item.title, item.notes)); }
  private scopedScheduled() { return this.workspaceState.scheduled.filter(item => this.matchesScopeText(item.title, item.notes, item.source_label)); }
  // Calendar belongs to the user, not the GTD client/agent scope.
  private scopedCalendarEvents() { return this.calendarEvents(); }

  private activeCount(tab: Tab) {
    if (tab === "today") return this.scopedScheduled().filter(item => item.scheduled_date === todayKey()).length + this.scopedTicklers().filter(item => item.status === "pending" && item.remind_on === todayKey()).length + this.scopedCalendarEvents().filter(item => this.calendarDayKey(item) === todayKey()).length;
    if (tab === "week") {
      const start = currentWeekKey();
      const end = shiftDayKey(start, 7);
      return this.calendarEvents().filter(item => this.isIntentEvent(item) && this.calendarDayKey(item) >= start && this.calendarDayKey(item) < end).length;
    }
    if (tab === "inbox") return this.scopedInbox().length;
    if (tab === "action") return this.scopedActions().filter(item => item.status === "active" && item.is_next).length;
    if (tab === "project") return this.scopedProjects().filter(item => item.status === "active").length;
    if (tab === "schedule") {
      const daily = this.scope === "main" ? this.workspaceState.daily_items ?? [] : [];
      const weekly = this.scope === "main" ? this.workspaceState.weekly_items ?? [] : [];
      const ticklers = this.scopedTicklers().filter(item => item.status === "pending");
      return daily.length + weekly.length + ticklers.length;
    }
    if (tab === "someday") return this.scopedSomeday().length;
    if (tab === "done") return this.completedItems().length;
    return this.scopedReferences().length;
  }

  private render() {
    try {
      this.renderWorkspace();
    } catch (error) {
      this.loading = false;
      this.refreshing = false;
      this.error = "The workspace data arrived, but this view could not be drawn.";
      this.log("ERROR", "workspace render failed", { error, tab: this.tab, row_count: this.workspaceState.row_count });
      void this.queueDiagnostic("render-failed", { tab: this.tab, row_count: this.workspaceState.row_count, error: errorMessage(error) });
      this.innerHTML = `
        <div class="app-shell">
          <div class="release-strip" role="status" aria-label="Current release">
            <button type="button" disabled><strong>Release ${CURRENT_RELEASE}</strong></button>
          </div>
          <main class="render-failure" role="alert">
            <p class="section-code">DISPLAY ERROR</p>
            <h1>Your lists loaded, but this view could not open.</h1>
            <p>Try the view again. If it still fails, copy the diagnostic log below.</p>
            <button type="button" data-retry>Try again</button>
            <pre tabindex="0" aria-label="Complete selectable event log">${esc(formatLog())}</pre>
          </main>
        </div>`;
      this.completeRender();
    }
  }

  private renderWorkspace() {
    if (this.workspaceState.loaded_at) this.latestHealthReport = null;
    this.innerHTML = `
      <div class="app-shell">
        <div class="top-line">
          <div class="diagnostic-panel">
            <div class="diagnostic-bar" role="group" aria-label="Workspace diagnostics">
              <button type="button" data-event-log-toggle aria-expanded="false" aria-controls="event-log-body"><span class="diagnostic-caret" aria-hidden="true">▸</span><strong>Log</strong><span class="event-count" data-event-log-count>${EVENT_LOG.length}</span></button>
              <button type="button" data-version-log aria-haspopup="dialog" aria-label="Open version log for Release ${CURRENT_RELEASE}">v${CURRENT_RELEASE}</button>
              <p data-workspace-status aria-live="polite" title="${esc(this.syncStatus())}">${esc(this.compactSyncStatus())}</p>
              <button type="button" data-copy-event-log aria-label="Copy entire event log">Copy</button>
            </div>
            <div class="event-log-body" id="event-log-body" hidden>
              <pre data-event-log-content tabindex="0" aria-label="Complete selectable event log">${esc(formatLog())}</pre>
            </div>
          </div>
          ${this.scopeControl()}
          <div class="top-actions">
            <button type="button" class="top-action" data-quick-add aria-label="Add item" aria-haspopup="dialog">+</button>
            <button type="button" class="top-action" data-refresh aria-label="${this.refreshing ? "Refreshing workspace" : this.reconnectRequired ? "Reconnect workspace" : "Refresh workspace"}" ${this.refreshing ? "disabled" : ""}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66M20 5v6h-6"/></svg>
            </button>
          </div>
        </div>
        <nav class="folder-tabs" aria-label="GTD folders">
          ${this.tabButton("today", "Today", "Work")}
          ${this.tabButton("week", "Week", "PLAN")}
          ${this.tabButton("schedule", "Future", "SCHEDULE")}
          ${this.tabButton("inbox", "Inbox", "Clarify")}
          ${this.tabButton("project", "Projects", "Finish")}
          ${this.tabButton("someday", "Someday", "Review")}
          ${this.tabButton("done", "Done", "Reflect")}
          ${this.tabButton("reference", "Reference", "Keep")}
        </nav>
        ${this.renderRowInventory()}
        <main class="workspace-main">
          ${this.renderFolderControls()}
          ${this.loading ? `<div class="loading"><span></span><span></span><span></span><p>${this.slowConnection ? "The connection is taking longer than usual. You can reconnect without changing any lists." : "Opening your folders…"}</p></div>` : !this.workspaceState.loaded_at ? `<div class="empty"><h3>Couldn’t open the lists</h3><p>${esc(this.error || "No verified workspace response was received.")}</p><button data-retry>${this.reconnectRequired ? "Reconnect" : "Try again"}</button></div>` : this.renderList()}
        </main>
        <footer><span>INBOX</span> capture · <span>NEXT</span> do · <span>PROJECT</span> finish · <span>SCHEDULE</span> revisit · <span>REFERENCE</span> keep · <span>DONE</span> reflect</footer>
        <dialog class="composer" aria-labelledby="composer-title"></dialog>
        <div class="toast" role="status" aria-live="polite"></div>
      </div>`;
    this.dialog = this.querySelector("dialog");
    this.bind();
    this.completeRender();
  }

  private completeRender() {
    if (!this.workspaceState.loaded_at || this.loading) {
      this.log("STATE", "render pending workspace data", {
        loading: this.loading,
        refreshing: this.refreshing,
        state_row_count: this.workspaceState.row_count,
      });
      return;
    }

    let renderedRowCount = 0;
    let measurementError = "";
    try {
      const renderedRows = Array.from(this.querySelectorAll<HTMLElement>("[data-workspace-row]"));
      renderedRowCount = renderedRows.length;
      const renderedCollectionCounts = {
        clients: this.querySelectorAll('[data-workspace-row][data-collection="clients"]').length,
        projects: this.querySelectorAll('[data-workspace-row][data-collection="projects"]').length,
        actions: this.querySelectorAll('[data-workspace-row][data-collection="actions"]').length,
        ticklers: this.querySelectorAll('[data-workspace-row][data-collection="ticklers"]').length,
        inbox: this.querySelectorAll('[data-workspace-row][data-collection="inbox"]').length,
        references: this.querySelectorAll('[data-workspace-row][data-collection="references"]').length,
        someday: this.querySelectorAll('[data-workspace-row][data-collection="someday"]').length,
        scheduled: this.querySelectorAll('[data-workspace-row][data-collection="scheduled"]').length,
      };
      const expected = this.workspaceState.health_report.state_row_counts;
      const mismatchedCollection = Object.entries(renderedCollectionCounts)
        .find(([collection, count]) => expected[collection as keyof typeof expected] !== count);
      if (mismatchedCollection) {
        throw new Error(`DOM row count mismatch for ${mismatchedCollection[0]}: rendered ${mismatchedCollection[1]}, expected ${expected[mismatchedCollection[0] as keyof typeof expected]}`);
      }
    } catch (error) {
      measurementError = errorMessage(error);
      console.error("GTD render measurement failed", error);
      // A failed DOM measurement is submitted as a zero-row failure so the
      // server never mistakes an incomplete render for a healthy one.
      renderedRowCount = 0;
    }

    const measurement: RenderMeasurement = {
      render_generation: `${this.clientInstanceId}:${this.loadGeneration}:${++this.renderSequence}`,
      render_request_id: this.workspaceState.request_id ?? null,
      client_release: CURRENT_RELEASE,
      server_release: this.workspaceState.server_release,
      tab: this.tab,
      rendered_row_count: renderedRowCount,
      state_row_count: this.workspaceState.row_count,
      has_data: renderedRowCount > 0,
      rendered_at: new Date().toISOString(),
    };
    this.latestRenderedGeneration = measurement.render_generation;
    this.log(measurementError ? "ERROR" : "STATE", "render complete", {
      ...measurement,
      loading: this.loading,
      refreshing: this.refreshing,
      state_row_count: this.workspaceState.row_count,
      visible_tab_rows: this.querySelectorAll("[data-render-row]").length,
      ...(measurementError ? { measurement_error: measurementError } : {}),
    });

    // Keep the queue alive even if an earlier reporting task ever escapes its
    // own error boundary. Every settled render-complete event is submitted.
    this.renderReportQueue = this.renderReportQueue
      .catch(error => this.log("ERROR", "render report queue recovered", { error }))
      .then(() => this.runRenderSelfCheck(measurement));
  }

  private async runRenderSelfCheck(measurement: RenderMeasurement) {
    let report: Workspace["health_report"];
    try {
      report = await this.callAction(
        "reportRenderMeasurement",
        measurement,
        () => api.reportRenderMeasurement(measurement),
      );
      void this.flushDiagnosticOutbox();
    } catch (firstError) {
      this.log("ERROR", "workspace self-check request failed, retrying once", { render_generation: measurement.render_generation, error: firstError });
      try {
        await new Promise(resolve => window.setTimeout(resolve, SELF_CHECK_RETRY_MS));
        report = await this.callAction(
          "reportRenderMeasurement",
          measurement,
          () => api.reportRenderMeasurement(measurement),
        );
        this.log("INFO", "workspace self-check retry succeeded", { render_generation: measurement.render_generation });
        void this.flushDiagnosticOutbox();
      } catch (error) {
        console.error("GTD render measurement write failed", error);
        this.log("ERROR", "workspace self-check request failed", { render_generation: measurement.render_generation, render_request_id: measurement.render_request_id, state_row_count: measurement.state_row_count, rendered_row_count: measurement.rendered_row_count, has_data: measurement.has_data, error });
        void this.queueDiagnostic("report-failed", { render_generation: measurement.render_generation, render_request_id: measurement.render_request_id, state_row_count: measurement.state_row_count, rendered_row_count: measurement.rendered_row_count, has_data: measurement.has_data, error: errorMessage(error) });
        if (measurement.render_generation === this.latestRenderedGeneration) {
          this.latestHealthReport = null;
          this.updateSyncStatus("Self-check could not be recorded; the visible lists remain available.");
        }
        return;
      }
    }
    try {
      const responseMatchesMeasurement = report.render_generation === measurement.render_generation
        && report.render_request_id === measurement.render_request_id
        && report.rendered_row_count === measurement.rendered_row_count
        && report.state_row_count === measurement.state_row_count
        && report.has_data === measurement.has_data
        && report.rendered_at === measurement.rendered_at;
      const passed = responseMatchesMeasurement && report.passed && report.status === "pass";
      this.log(passed ? "INFO" : "ERROR", passed ? "workspace self-check passed" : "workspace self-check failed", {
        client_release: measurement.client_release,
        server_release: measurement.server_release,
        render_request_id: measurement.render_request_id,
        render_generation: measurement.render_generation,
        state_row_count: measurement.state_row_count,
        rendered_row_count: measurement.rendered_row_count,
        has_data: measurement.has_data,
        status: passed ? "pass" : "fail",
        response_matches_measurement: responseMatchesMeasurement,
        checked_at: report.checked_at,
        rendered_at: measurement.rendered_at,
      });
      if (measurement.render_generation === this.latestRenderedGeneration) {
        this.latestHealthReport = responseMatchesMeasurement
          ? report
          : { ...report, passed: false, status: "fail", rendered_row_count: measurement.rendered_row_count, has_data: measurement.has_data };
        this.updateSyncStatus();
      }
    } catch (error) {
      console.error("GTD render measurement write failed", error);
      this.log("ERROR", "workspace self-check response processing failed", { render_generation: measurement.render_generation, render_request_id: measurement.render_request_id, state_row_count: measurement.state_row_count, rendered_row_count: measurement.rendered_row_count, has_data: measurement.has_data, error });
      void this.queueDiagnostic("report-processing-failed", { render_generation: measurement.render_generation, render_request_id: measurement.render_request_id, state_row_count: measurement.state_row_count, rendered_row_count: measurement.rendered_row_count, has_data: measurement.has_data, error: errorMessage(error) });
      if (measurement.render_generation === this.latestRenderedGeneration) {
        this.latestHealthReport = null;
        this.updateSyncStatus("Self-check could not be recorded; the visible lists remain available.");
      }
    }
  }

  private updateSyncStatus(fallback?: string) {
    const status = this.querySelector<HTMLElement>("[data-workspace-status]");
    if (!status) return;
    status.textContent = fallback ? "Check unavailable" : this.compactSyncStatus();
    status.title = fallback ?? this.syncStatus();
    status.classList.toggle("sync-warning", Boolean(fallback) || this.latestHealthReport?.status === "fail" || Boolean(this.syncWarning));
  }

  private compactSyncStatus() {
    if (this.loading) return this.slowConnection ? "Still connecting" : "Loading…";
    if (this.syncWarning) return "Sync warning";
    if (this.error) return "Load error";
    if (!this.workspaceState.loaded_at) return "No data loaded";
    if (this.refreshing) return `${this.workspaceState.row_count} items · checking`;
    if (this.latestHealthReport?.status === "fail") return `${this.workspaceState.row_count} items · check failed`;
    return `${this.workspaceState.row_count} items loaded`;
  }

  private syncStatus() {
    if (this.loading) return this.slowConnection ? "Still connecting — reconnect is available." : "Loading your lists…";
    if (this.syncWarning) return this.syncWarning;
    if (this.error) return this.error;
    if (!this.workspaceState.loaded_at) return "No workspace response received.";
    const time = formatDate(new Date(this.workspaceState.loaded_at), { hour: "numeric", minute: "2-digit", second: "2-digit" }, "time unavailable");
    if (this.refreshing) return `${this.workspaceState.row_count} items loaded · automatic check in progress · v${CURRENT_RELEASE}`;
    if (!this.latestHealthReport || this.latestHealthReport.render_generation !== this.latestRenderedGeneration) {
      return `${this.workspaceState.row_count} items loaded · checking visible render… · v${this.workspaceState.server_release}`;
    }
    if (!this.latestHealthReport.passed) {
      return `${this.workspaceState.row_count} items loaded · self-check failed (${this.latestHealthReport.rendered_row_count} represented rows) · v${this.workspaceState.server_release}`;
    }
    return `${this.workspaceState.row_count} items loaded · self-check passed ${time} · ${this.latestHealthReport.rendered_row_count} represented rows · v${this.workspaceState.server_release}`;
  }

  private tabButton(tab: Tab, title: string, verb: string) {
    const showsCount = tab !== "today" && tab !== "week";
    const count = this.loading && !this.workspaceState.loaded_at ? "…" : this.activeCount(tab);
    return `<button class="folder-tab ${this.tab === tab ? "active" : ""}" data-tab="${tab}" aria-current="${this.tab === tab ? "page" : "false"}"><span class="folder-verb">${verb}</span><strong>${title}</strong>${showsCount ? `<b>${count}</b>` : ""}</button>`;
  }

  private label(kind: Tab | ItemKind) {
    if (kind === "action") return "task";
    if (kind === "reference") return "reference item";
    if (kind === "client") return "client";
    if (kind === "inbox") return "inbox item";
    if (kind === "scheduled") return "scheduled item";
    if (kind === "someday") return "someday item";
    return kind;
  }

  private renderFolderControls() {
    if (!this.supportsDone()) return "";
    return `<div class="section-toolbar" aria-label="Folder controls">
      ${this.tab === "action" ? `<label class="priority-filter">Priority<select data-priority-filter aria-label="Filter Next Actions by priority"><option value="all" ${this.priorityFilter === "all" ? "selected" : ""}>All</option><option value="A" ${this.priorityFilter === "A" ? "selected" : ""}>A</option><option value="B" ${this.priorityFilter === "B" ? "selected" : ""}>B</option><option value="C" ${this.priorityFilter === "C" ? "selected" : ""}>C</option><option value="unprioritized" ${this.priorityFilter === "unprioritized" ? "selected" : ""}>Unprioritized</option></select></label>` : ""}
      <label class="show-done"><input type="checkbox" data-show-done aria-label="Show completed items" ${this.showDone ? "checked" : ""}> Show done</label>
    </div>`;
  }

  private supportsDone() { return this.tab === "action" || this.tab === "project"; }

  private renderRowInventory() {
    const row = (collection: string, id: number) => `<span data-workspace-row data-collection="${collection}" data-row-id="${id}"></span>`;
    return `<div data-render-inventory hidden aria-hidden="true">
      ${this.workspaceState.clients.map(item => row("clients", item.id)).join("")}
      ${this.workspaceState.projects.map(item => row("projects", item.id)).join("")}
      ${this.workspaceState.actions.map(item => row("actions", item.id)).join("")}
      ${this.workspaceState.ticklers.map(item => row("ticklers", item.id)).join("")}
      ${this.workspaceState.inbox.map(item => row("inbox", item.id)).join("")}
      ${this.workspaceState.references.map(item => row("references", item.id)).join("")}
      ${this.workspaceState.someday.map(item => row("someday", item.id)).join("")}
      ${this.workspaceState.scheduled.map(item => row("scheduled", item.id)).join("")}
    </div>`;
  }

  private renderList() {
    if (this.tab === "today") return this.renderToday();
    if (this.tab === "week") return this.renderWeek();
    if (this.tab === "schedule") return this.renderSchedule();
    if (this.tab === "inbox") {
      const rows = this.scopedInbox();
      if (!rows.length) return this.empty("Inbox zero", "Everything in this scope has been clarified and filed.", "inbox");
      return `<div class="inbox-intro"><p>Decide what each item means, then file it once.</p></div><div class="rows inbox-rows">${rows.map(item => this.inboxRow(item)).join("")}</div>`;
    }
    if (this.tab === "action") {
      const rows = this.scopedActions()
        .filter(item => (this.showDone || item.status === "active") && item.is_next && (this.priorityFilter === "all" || item.priority === this.priorityFilter))
        .sort((left, right) => PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] || right.id - left.id);
      if (!rows.length) return this.priorityFilter === "all"
        ? this.empty("No next actions yet", "Flag one or two concrete tasks inside each active project.", "action")
        : `<div class="empty"><h3>No ${this.priorityFilter === "unprioritized" ? "unprioritized" : `priority ${this.priorityFilter}`} next actions</h3><p>Choose another priority filter or update a task’s priority.</p></div>`;
      const groups = new Map<string, { label: string; items: typeof rows }>();
      rows.forEach(action => {
        const key = `${action.priority}:${action.context}`;
        const group = groups.get(key) ?? { label: action.priority === "unprioritized" ? action.context : `${action.priority} · ${action.context}`, items: [] };
        group.items.push(action);
        groups.set(key, group);
      });
      return `<div class="groups">${[...groups.values()].map(group => `<section class="context-group"><div class="context-label"><span>${esc(group.label)}</span><b>${group.items.length}</b></div><div class="rows">${group.items.map(item => this.actionRow(item)).join("")}</div></section>`).join("")}</div>`;
    }
    if (this.tab === "project") {
      const rows = this.scopedProjects().filter(item => this.showDone || item.status === "active");
      if (!rows.length) return this.empty("No projects yet", "A project is an outcome that takes more than one action.", "project");
      return `<div class="rows projects">${rows.map(project => this.projectRow(project)).join("")}</div>`;
    }
    if (this.tab === "someday") {
      const rows = this.scopedSomeday();
      if (!rows.length) return this.empty("Someday is open", "Keep possibilities here without turning them into commitments.", "someday");
      return `<div class="rows someday-rows">${rows.map(item => this.simpleRow("someday", item.id, item.title, item.url, item.notes || "Review when the timing changes", "S")).join("")}</div>`;
    }
    if (this.tab === "done") return this.renderDoneList();
    const rows = this.scopedReferences();
    if (!rows.length) return this.empty("No reference material yet", "Keep information here when it needs no action.", "reference");
    return `<div class="rows reference-rows">${rows.map(item => this.simpleRow("reference", item.id, item.title, item.url, item.notes || "Reference material", "R")).join("")}</div>`;
  }

  private completedItems(): CompletedEntry[] {
    const rows: CompletedEntry[] = [
      ...this.scopedActions()
        .filter(item => item.status !== "active")
        .map(item => ({
          kind: "action" as const,
          id: item.id,
          title: item.title,
          url: item.url,
          detail: item.project_title ? `${item.project_title} · ${item.context}` : item.context,
          completedAt: item.completed_at,
        })),
      ...this.scopedProjects()
        .filter(item => item.status !== "active")
        .map(item => ({
          kind: "project" as const,
          id: item.id,
          title: item.title,
          url: item.url,
          detail: item.outcome || "Project",
          completedAt: item.completed_at,
        })),
      ...this.scopedTicklers()
        .filter(item => item.status !== "pending")
        .map(item => ({
          kind: "tickler" as const,
          id: item.id,
          title: item.title,
          url: item.url,
          detail: `Tickler · scheduled ${formatDate(parseDay(item.remind_on), { month: "short", day: "numeric", year: "numeric" }, "date unavailable")}`,
          completedAt: item.completed_at,
        })),
    ];
    const completedTime = (entry: CompletedEntry) => {
      if (!entry.completedAt) return Number.NEGATIVE_INFINITY;
      const value = new Date(entry.completedAt).getTime();
      return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
    };
    return rows.sort((left, right) => {
      const timeDifference = completedTime(right) - completedTime(left);
      if (timeDifference !== 0) return timeDifference;
      const kindDifference = left.kind.localeCompare(right.kind);
      return kindDifference !== 0 ? kindDifference : right.id - left.id;
    });
  }

  private renderDoneList() {
    const rows = this.completedItems();
    if (!rows.length) return `<div class="empty"><div class="empty-mark" aria-hidden="true">✓</div><h3>Nothing completed yet</h3><p>Completed next actions, projects, and tickler items will collect here.</p></div>`;

    const groups = new Map<string, CompletedEntry[]>();
    for (const item of rows) {
      const parsed = item.completedAt ? new Date(item.completedAt) : null;
      const key = parsed && !Number.isNaN(parsed.getTime()) ? dayKey(parsed) : "unknown";
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    const orderedGroups = [...groups.entries()].sort(([left], [right]) => {
      if (left === "unknown") return 1;
      if (right === "unknown") return -1;
      return right.localeCompare(left);
    });
    const datedGroupCount = orderedGroups.filter(([key]) => key !== "unknown").length;
    const dateSummary = `${datedGroupCount} completion ${datedGroupCount === 1 ? "date" : "dates"} · newest first`;
    const content = orderedGroups.map(([key, items]) => {
      const label = key === "unknown"
        ? "Date unavailable"
        : formatDate(parseDay(key), { month: "long", day: "numeric", year: "numeric" });
      const heading = key === "unknown"
        ? `<h3>${label}</h3>`
        : `<h3><time datetime="${key}">${esc(label)}</time></h3>`;
      return `<section class="done-date-group" data-done-date="${key}"><div class="done-date-label">${heading}<b>${items.length}</b></div><div class="rows done-rows">${items.map(item => this.doneRow(item)).join("")}</div></section>`;
    }).join("");
    return `<div class="done-summary"><strong>${rows.length}</strong><span>${rows.length === 1 ? "completed item" : "completed items"}</span><small>${dateSummary}</small></div><div class="done-groups">${content}</div>`;
  }

  private doneRow(item: CompletedEntry) {
    const parsedDate = item.completedAt ? new Date(item.completedAt) : null;
    const date = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null;
    const completionLabel = date ? formatDate(date, { hour: "numeric", minute: "2-digit" }) : "time unavailable";
    const kindLabel = item.kind === "action" ? "Next action" : item.kind === "project" ? "Project" : "Tickler";
    return `<article class="item done-item is-done" data-render-row>${this.check(item.kind, item.id, true, item.title)}<button class="item-main" data-edit="${item.kind}" data-id="${item.id}"><strong>${esc(item.title)}</strong><span>${esc(item.detail)}</span></button>${this.itemLink(item.url, item.title)}<div class="done-meta"><span>${kindLabel}</span><time datetime="${esc(item.completedAt)}">${esc(completionLabel)}</time></div>${this.copyReferenceButton(item.kind, item.id, item.title)}${this.menu(item.kind, item.id, item.title)}</article>`;
  }

  private calendarEvents() { return this.workspaceState.calendar_events ?? []; }
  private dailyHabits() { return this.workspaceState.daily_items ?? []; }
  private calendarSyncState() {
    return this.workspaceState.calendar_sync ?? { last_sync_at: null, status: "unknown", error_detail: null };
  }

  private calendarParts(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(entry => entry.type === type)?.value;
    const year = part("year");
    const month = part("month");
    const day = part("day");
    const hour = Number(part("hour"));
    const minute = Number(part("minute"));
    return year && month && day && Number.isFinite(hour) && Number.isFinite(minute) ? { year, month, day, hour, minute } : null;
  }

  private calendarDayKey(event: { start_time: string; is_all_day: boolean }) {
    if (event.is_all_day) return event.start_time.slice(0, 10);
    const parts = this.calendarParts(event.start_time);
    return parts ? `${parts.year}-${parts.month}-${parts.day}` : event.start_time.slice(0, 10);
  }

  private calendarStartMinutes(event: { start_time: string; is_all_day: boolean }) {
    if (event.is_all_day) return -1;
    const parts = this.calendarParts(event.start_time);
    return parts ? parts.hour * 60 + parts.minute : Number.MAX_SAFE_INTEGER;
  }

  private calendarTimeRange(event: { start_time: string; end_time: string | null; is_all_day: boolean }) {
    if (event.is_all_day) return "All day";
    const start = new Date(event.start_time);
    const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" };
    const startLabel = Number.isNaN(start.getTime()) ? event.start_time : formatDate(start, options);
    if (!event.end_time) return startLabel;
    const end = new Date(event.end_time);
    const endLabel = Number.isNaN(end.getTime()) ? event.end_time : formatDate(end, options);
    return `${startLabel}–${endLabel}`;
  }

  private calendarKey(event: CalendarEvent): CalendarKey {
    return event.calendar_name;
  }

  private isIntentEvent(event: CalendarEvent) {
    return this.calendarKey(event) === "intent";
  }

  private calendarLabel(event: CalendarEvent) {
    const key = this.calendarKey(event);
    return key === "intent" ? "Intent" : key === "tangentcode" ? "Tangentcode" : "Primary";
  }

  private eventTimeValue(value: string | null, fallback: string) {
    if (!value || !value.includes("T")) return fallback;
    const parts = this.calendarParts(value);
    return parts ? `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}` : fallback;
  }

  private renderIntentEditor(date: string, event?: CalendarEvent) {
    const start = this.eventTimeValue(event?.start_time ?? null, "09:00");
    const end = this.eventTimeValue(event?.end_time ?? null, "10:00");
    const deleting = event ? this.weekDeleteArmed === event.id : false;
    return `<form class="intent-inline-form" data-intent-form data-intent-date="${date}" ${event ? `data-intent-id="${event.id}"` : ""}>
      <label>Intent<input name="title" required maxlength="500" value="${esc(event?.title)}" placeholder="What do you intend to do?"></label>
      <div class="intent-time-fields"><label>Start<input type="time" name="start_time" required value="${esc(start)}"></label><label>End<input type="time" name="end_time" required value="${esc(end)}"></label></div>
      <div class="intent-form-actions">${event ? `<button type="button" class="intent-delete" data-intent-delete="${event.id}" ${deleting ? "data-armed" : ""}>${deleting ? "Delete now" : "Delete"}</button>` : ""}<button type="button" data-intent-cancel>Cancel</button><button type="submit" class="intent-save">${event ? "Update" : "Schedule"}</button></div>
      <p class="form-error" role="alert">${esc(this.weekCalendarMessage)}</p>
    </form>`;
  }

  private renderWeekEvent(event: CalendarEvent) {
    const intent = this.isIntentEvent(event);
    const body = `<span class="week-event-time">${esc(this.calendarTimeRange(event))}</span><strong>${esc(event.title)}</strong>${event.location ? `<small>${esc(event.location)}</small>` : ""}`;
    return intent
      ? `<button type="button" class="week-event intent-event" data-intent-edit="${event.id}" aria-label="Edit intent block ${esc(event.title)}">${body}</button>`
      : `<article class="week-event busy-event ${this.calendarKey(event)}-event" aria-label="${esc(this.calendarLabel(event))}, read-only: ${esc(event.title)}">${body}<small>${esc(this.calendarLabel(event))} · read-only</small></article>`;
  }

  private renderWeek() {
    const start = parseDay(this.weekStart);
    const endKey = shiftDayKey(this.weekStart, 7);
    const visibility = this.workspaceState.calendar_visibility;
    const events = this.calendarEvents()
      .filter(event => visibility[this.calendarKey(event)])
      .filter(event => this.calendarDayKey(event) >= this.weekStart && this.calendarDayKey(event) < endKey)
      .sort((left, right) => this.calendarStartMinutes(left) - this.calendarStartMinutes(right));
    const rangeLabel = `${formatDate(start, { month: "short", day: "numeric" })}–${formatDate(addDays(start, 6), { month: "short", day: "numeric", year: "numeric" })}`;
    const today = todayKey();
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = shiftDayKey(this.weekStart, index);
      const parsed = parseDay(date);
      const dayEvents = events.filter(event => this.calendarDayKey(event) === date);
      const editorEvent = this.weekEditor?.eventId ? this.calendarEvents().find(event => event.id === this.weekEditor?.eventId) : undefined;
      const editor = this.weekEditor?.date === date ? this.renderIntentEditor(date, editorEvent) : "";
      return `<section class="week-day ${date === today ? "is-today" : ""}">
        <header><div><span>${esc(formatDate(parsed, { weekday: "short" }))}</span><strong>${esc(formatDate(parsed, { month: "short", day: "numeric" }))}</strong></div><button type="button" data-intent-add="${date}" aria-label="Add intent block on ${esc(formatDate(parsed, { weekday: "long", month: "long", day: "numeric" }))}">+</button></header>
        <div class="week-events">${dayEvents.length ? dayEvents.map(event => this.renderWeekEvent(event)).join("") : `<button type="button" class="week-empty-slot" data-intent-add="${date}">Add an intent</button>`}</div>
        ${editor}
      </section>`;
    }).join("");
    const sync = this.calendarSyncState();
    const unavailable = this.weekCalendarMessage || (sync.status === "error" ? "Calendar unavailable — showing saved blocks where available." : "");
    return `<div class="week-planner">
      <div class="week-toolbar"><div class="week-navigation"><button type="button" data-week-shift="-7" aria-label="Previous week">‹</button><strong>${esc(rangeLabel)}</strong><button type="button" data-week-shift="7" aria-label="Next week">›</button></div><div class="week-toolbar-actions"><button type="button" class="calendar-config-button" data-calendar-config aria-expanded="${this.weekCalendarsOpen}" aria-controls="calendar-visibility-panel">Calendars</button><button type="button" class="this-week-button" data-week-today ${this.weekStart === currentWeekKey() ? "disabled" : ""}>This week</button></div></div>
      <div id="calendar-visibility-panel" class="calendar-visibility-panel" ${this.weekCalendarsOpen ? "" : "hidden"}>
        <strong>Show in Week</strong>
        <label><input type="checkbox" data-calendar-visibility="primary" ${visibility.primary ? "checked" : ""}>Primary</label>
        <label><input type="checkbox" data-calendar-visibility="intent" ${visibility.intent ? "checked" : ""}>Intent</label>
        <label><input type="checkbox" data-calendar-visibility="tangentcode" ${visibility.tangentcode ? "checked" : ""}>Tangentcode</label>
      </div>
      <div class="week-legend"><span><i class="busy-swatch"></i>Busy</span><span><i class="intent-swatch"></i>Intent</span><em>${this.weekSyncing ? "Updating calendar…" : unavailable ? esc(unavailable) : "Tap an intent to edit it"}</em></div>
      <div class="week-grid">${days}</div>
    </div>`;
  }

  private calendarEventRow(event: { id: number; title: string; start_time: string; end_time: string | null; location: string | null; is_all_day: boolean; calendar_name: string }) {
    return `<article class="item scheduled-item calendar-event"><div class="time-badge"><strong>${esc(this.calendarTimeRange(event))}</strong><span>Calendar</span></div><div class="item-main"><strong>${esc(event.title)}</strong><span>${event.location ? `${esc(event.location)} · ` : ""}${esc(event.calendar_name)} · read-only</span></div></article>`;
  }

  private calendarSyncLine() {
    const sync = this.calendarSyncState();
    if (sync.status === "error") return `<p class="quiet-line calendar-sync-line">Calendar sync ran into a problem — showing the last good pull.${sync.error_detail ? ` ${esc(sync.error_detail.slice(0, 120))}` : ""}</p>`;
    if (sync.status === "ok" && sync.last_sync_at) {
      const when = new Date(sync.last_sync_at);
      const label = Number.isNaN(when.getTime()) ? "recently" : formatDate(when, { hour: "numeric", minute: "2-digit" });
      return `<p class="quiet-line calendar-sync-line">Calendar updated at ${esc(label)}.</p>`;
    }
    return `<p class="quiet-line calendar-sync-line">Calendar sync has not run yet.</p>`;
  }

  private renderTodaySection(section: TodaySection, label: string, count: number, rows: string, rowsClass = "rows") {
    const expanded = this.expandedTodaySections.has(section);
    const bodyId = `today-section-${section}`;
    return `<section class="today-section collapsible-today-section"><button type="button" class="context-label today-section-toggle" data-today-section="${section}" aria-expanded="${expanded}" aria-controls="${bodyId}"><span class="today-section-caret" aria-hidden="true">${expanded ? "▾" : "▸"}</span><span>${esc(label)}</span><b>${count}</b></button><div id="${bodyId}" class="${rowsClass}" ${expanded ? "" : "hidden"}>${rows}</div></section>`;
  }

  private renderToday() {
    const date = todayKey();
    const mainScope = this.scope === "main";
    const daily = mainScope ? this.dailyHabits() : [];
    const manual = this.scopedScheduled().filter(item => item.scheduled_date === date);
    const ticklers = this.scopedTicklers().filter(item => item.status === "pending" && item.remind_on === date);
    const calendarEvents = this.scopedCalendarEvents().filter(event => this.calendarDayKey(event) === date);
    const scheduled: { sort: number; html: string }[] = [
      ...calendarEvents.map(event => ({ sort: this.calendarStartMinutes(event), html: this.calendarEventRow(event) })),
      ...manual.map(item => ({
        sort: item.start_time ? Number(item.start_time.slice(0, 2)) * 60 + Number(item.start_time.slice(3, 5)) : 24 * 60 + 30,
        html: this.scheduledRow(item),
      })),
      ...ticklers.map(item => ({ sort: 24 * 60 + 60, html: this.ticklerRow(item, true) })),
    ].sort((left, right) => left.sort - right.sort);

    const nextActions = this.scopedActions()
      .filter(item => item.status === "active" && item.is_next)
      .sort((left, right) => PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] || right.id - left.id);
    const unprioritized = nextActions.filter(item => item.priority === "unprioritized");
    const prioritized = (["A", "B", "C"] as const)
      .map(priority => ({ priority, items: nextActions.filter(item => item.priority === priority) }))
      .filter(group => group.items.length > 0);
    const inbox = this.scopedInbox();

    const leftSections = [
      mainScope ? this.renderDailyCalendar(true) : "",
      daily.length ? `<section class="today-section"><div class="context-label"><span>Daily checklist</span><b>${daily.filter(item => item.today_passed === true).length}/${daily.length}</b></div><div class="rows">${daily.map(item => this.dailyRow(item, false)).join("")}</div></section>` : "",
      scheduled.length ? `<section class="today-section"><div class="context-label"><span>Scheduled</span><b>${scheduled.length}</b></div><div class="rows">${scheduled.map(item => item.html).join("")}</div>${this.calendarSyncLine()}</section>` : "",
    ].filter(Boolean).join("");

    const rightSections = [
      inbox.length ? this.renderTodaySection("inbox", "Inbox", inbox.length, inbox.map(item => this.inboxRow(item)).join(""), "rows inbox-rows") : "",
      unprioritized.length ? this.renderTodaySection("unprioritized", "Unprioritized next actions", unprioritized.length, unprioritized.map(item => this.actionRow(item)).join("")) : "",
      ...prioritized.map(group => this.renderTodaySection(group.priority, `Priority ${group.priority}`, group.items.length, group.items.map(item => this.actionRow(item)).join(""))),
    ].filter(Boolean).join("");

    if (!leftSections && !rightSections) return `<p class="quiet-line">This scope is clear. New matching work will appear here.</p>`;
    return `<div class="today-board">
      <div class="today-left">${leftSections || `<p class="quiet-line">No checklist or scheduled items in this scope today.</p>`}</div>
      <div class="today-right">${rightSections || `<p class="quiet-line">Inbox and next actions are clear in this scope.</p>`}</div>
    </div>`;
  }

  private renderSchedule() {
    const ticklers = this.scopedTicklers()
      .filter(item => item.status === "pending")
      .sort((left, right) => left.remind_on.localeCompare(right.remind_on) || right.id - left.id);
    const routines = this.scope === "main"
      ? `<section class="schedule-section"><div class="schedule-section-head"><div><p class="section-code">DAILY</p><h3>Daily checklist</h3></div></div>${this.renderDaily()}</section>
        <section class="schedule-section"><div class="schedule-section-head"><div><p class="section-code">RECURRING</p><h3>Weekly rhythm</h3></div></div>${this.renderWeekly()}</section>`
      : `<p class="quiet-line">Daily and recurring routines belong to Main. Dated reminders for this scope appear here.</p>`;
    return `<div class="schedule-board">
      <div class="schedule-routines">${routines}</div>
      <section class="schedule-ticklers"><div class="schedule-section-head"><div><p class="section-code">TICKLER</p><h3>Dated reminders</h3></div><button type="button" class="section-inline-add" data-open="tickler">+ Add tickler</button></div>${ticklers.length ? `<div class="tickler-summary"><strong>${ticklers.length}</strong><span>${ticklers.length === 1 ? "item" : "items"} · soonest first</span></div><div class="rows tickler-list">${ticklers.map(item => this.ticklerRow(item)).join("")}</div>` : `<p class="quiet-line">Nothing waiting for a future date in this scope.</p>`}</section>
    </div>`;
  }

  private dailyRow(item: { id: number; name: string; today_passed: boolean | null; streak: number }, allowDelete = true) {
    const done = item.today_passed === true;
    const streakLabel = item.streak === 1 ? "1-day streak" : item.streak > 1 ? `${item.streak}-day streak` : "";
    return `<article class="item daily-item ${done ? "is-done" : ""}"><button class="check ${done ? "done" : ""}" type="button" data-daily-toggle="${item.id}" data-daily-checked="${done ? "true" : "false"}" aria-label="${done ? `Uncheck ${esc(item.name)}` : `Check ${esc(item.name)}`}">${done ? "✓" : ""}</button><div class="item-main"><strong>${esc(item.name)}</strong>${streakLabel ? `<span class="daily-streak">${esc(streakLabel)}</span>` : ""}</div>${allowDelete ? this.dailyDeleteButton(item.id, item.name) : ""}</article>`;
  }

  private dailyDeleteButton(id: number, name: string) {
    const armed = this.dailyDeleteArmed === id;
    return `<button type="button" class="delete daily-delete" data-daily-delete="${id}" ${armed ? "data-armed" : ""} aria-label="Delete ${esc(name)}">${armed ? "Sure?" : "✕"}</button>`;
  }

  private renderDailyCalendar(compact = false) {
    const monthKey = this.dailyMonth;
    const monthDays = this.workspaceState.daily_month ?? [];
    const monthLabel = formatDate(parseDay(`${monthKey}-01`), { month: "long", year: "numeric" }, monthKey);
    const today = todayKey();
    const leadBlanks = parseDay(`${monthKey}-01`).getDay();
    const dayClass = (day: { date: string; passed: number; total: number }) => {
      if (day.date > today) return "day-cell future";
      if (day.total === 0) return "day-cell g0";
      const fraction = day.passed / day.total;
      const level = fraction >= 1 ? 3 : fraction >= 0.5 ? 2 : fraction > 0 ? 1 : 0;
      const isToday = day.date === today ? " today" : "";
      return `day-cell g${level}${isToday}`;
    };
    return `<section class="daily-month ${compact ? "compact-calendar" : ""}">
      <div class="daily-month-nav"><button type="button" data-daily-month="-1" aria-label="Previous month">‹</button><strong>${esc(monthLabel)}</strong><button type="button" data-daily-month="1" aria-label="Next month">›</button></div>
      ${monthDays.length ? `<div class="month-grid" role="img" aria-label="Daily habit results for ${esc(monthLabel)}">${["S", "M", "T", "W", "T", "F", "S"].map(day => `<span class="day-head" aria-hidden="true">${day}</span>`).join("")}${Array.from({ length: leadBlanks }, () => `<span class="day-cell blank" aria-hidden="true"></span>`).join("")}${monthDays.map(day => `<span class="${dayClass(day)}" title="${esc(day.date)}: ${day.passed} of ${day.total} habits"><b>${Number(day.date.slice(8, 10))}</b></span>`).join("")}</div>` : `<p class="quiet-line">The month fills in as you check off daily habits.</p>`}
    </section>`;
  }

  private renderDaily() {
    const items = this.dailyHabits();
    return `<section class="daily-today">
      <div class="context-label"><span>Today’s habits</span><b>${items.length ? `${items.filter(item => item.today_passed === true).length}/${items.length}` : "0"}</b></div>
      ${items.length ? `<div class="rows">${items.map(item => this.dailyRow(item)).join("")}</div>` : `<p class="quiet-line">No daily habits yet. Add one small rep you can do every day.</p>`}
      <form class="daily-add" data-daily-add><input name="name" maxlength="500" placeholder="New daily habit…" aria-label="New daily habit"><button type="submit">Add</button></form>
    </section>`;
  }

  private weeklyActivities() { return this.workspaceState.weekly_items ?? []; }

  private weeklyRow(item: { id: number; name: string; this_week_passed: boolean | null; streak: number }) {
    const done = item.this_week_passed === true;
    const streakLabel = item.streak === 1 ? "1-week streak" : item.streak > 1 ? `${item.streak}-week streak` : "";
    const armed = this.weeklyDeleteArmed === item.id;
    return `<article class="item daily-item weekly-item ${done ? "is-done" : ""}"><button class="check ${done ? "done" : ""}" type="button" data-weekly-toggle="${item.id}" data-weekly-checked="${done ? "true" : "false"}" aria-label="${done ? `Uncheck ${esc(item.name)} for this week` : `Check ${esc(item.name)} for this week`}">${done ? "✓" : ""}</button><div class="item-main"><strong>${esc(item.name)}</strong><span>${streakLabel ? esc(streakLabel) : "Find a block for this before Sunday"}</span></div><button type="button" class="delete daily-delete" data-weekly-delete="${item.id}" ${armed ? "data-armed" : ""} aria-label="Delete ${esc(item.name)}">${armed ? "Sure?" : "✕"}</button></article>`;
  }

  private renderWeekly() {
    const items = this.weeklyActivities();
    const weekStart = parseDay(currentWeekKey());
    const weekEnd = addDays(weekStart, 6);
    const weekLabel = `${formatDate(weekStart, { month: "short", day: "numeric" })}–${formatDate(weekEnd, { month: "short", day: "numeric" })}`;
    const completed = items.filter(item => item.this_week_passed === true).length;
    return `<section class="daily-today weekly-list">
      <div class="context-label"><span>This week · ${esc(weekLabel)}</span><b>${items.length ? `${completed}/${items.length}` : "0"}</b></div>
      <p class="quiet-line weekly-prompt">Choose a real block in the week for each activity, then check it off when the session is complete.</p>
      ${items.length ? `<div class="rows">${items.map(item => this.weeklyRow(item)).join("")}</div>` : `<p class="quiet-line">No weekly activities yet. Add something worth revisiting every week.</p>`}
      <form class="daily-add" data-weekly-add><input name="name" maxlength="500" placeholder="New weekly activity…" aria-label="New weekly activity"><button type="submit">Add</button></form>
    </section>`;
  }

  private empty(title: string, body: string, kind: ItemKind) {
    return `<div class="empty"><div class="empty-mark">+</div><h3>${title}</h3><p>${body}</p><button data-open="${kind}">Add ${this.label(kind)}</button></div>`;
  }

  private check(kind: ActiveKind, id: number, done: boolean, label: string) {
    return `<button class="check ${done ? "done" : ""}" data-toggle="${kind}" data-id="${id}" data-done="${done}" aria-label="${done ? "Reopen" : "Complete"} ${esc(label)}">${done ? "✓" : ""}</button>`;
  }

  private menu(kind: ItemKind, id: number, label: string) {
    return `<button class="item-menu" data-menu-kind="${kind}" data-menu-id="${id}" data-menu-label="${esc(label)}" aria-label="Actions for ${esc(label)}">•••</button>`;
  }

  private copyReferenceButton(kind: ItemKind, id: number, label: string) {
    return `<button type="button" class="copy-reference" data-copy-reference data-copy-kind="${kind}" data-copy-id="${id}" aria-label="Copy reference to ${esc(label)}"><span aria-hidden="true">REF</span></button>`;
  }

  private itemLink(value: string | null | undefined, label: string) {
    const raw = value?.trim() ?? "";
    if (!raw) return "";
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return `<a class="item-link" data-item-link href="${esc(parsed.href)}" target="_blank" rel="noopener noreferrer" aria-label="Open link for ${esc(label)} in a new tab"><span aria-hidden="true">↗</span></a>`;
    } catch {
      return "";
    }
  }

  private priorityControl(kind: "action" | "inbox", id: number, title: string, priority: Priority) {
    return `<select class="priority-control priority-${priority}" data-priority-kind="${kind}" data-priority-id="${id}" aria-label="Set priority for ${esc(title)}"><option value="unprioritized" ${priority === "unprioritized" ? "selected" : ""}>—</option><option value="A" ${priority === "A" ? "selected" : ""}>A</option><option value="B" ${priority === "B" ? "selected" : ""}>B</option><option value="C" ${priority === "C" ? "selected" : ""}>C</option></select>`;
  }

  private inboxRow(item: Workspace["inbox"][number]) {
    const captured = formatDate(new Date(item.created_at), { month: "short", day: "numeric" }, "date unavailable");
    return `<article class="item inbox-item" data-render-row><div class="inbox-dot" aria-hidden="true"></div><button class="item-main" data-edit="inbox" data-id="${item.id}"><strong>${esc(item.title)}</strong><span>${item.notes ? esc(item.notes) : `Captured ${captured}`}</span></button>${this.itemLink(item.url, item.title)}${this.priorityControl("inbox", item.id, item.title, item.priority)}<button class="process-button" data-process="${item.id}" aria-label="Process ${esc(item.title)}">Process</button>${this.copyReferenceButton("inbox", item.id, item.title)}${this.menu("inbox", item.id, item.title)}</article>`;
  }

  private actionRow(item: Workspace["actions"][number], insideProject = false) {
    const done = item.status !== "active";
    return `<article class="item task-item ${done ? "is-done" : ""}" data-render-row>${this.check("action", item.id, done, item.title)}<button class="item-main" data-edit="action" data-id="${item.id}"><strong>${esc(item.title)}</strong><span>${item.project_title ? `↳ ${esc(item.project_title)}` : "Independent action"}${item.client_name ? ` · ${esc(item.client_name)} · CLOCK IN` : ""}${item.notes ? ` · ${esc(item.notes)}` : ""}</span></button>${this.itemLink(item.url, item.title)}${this.priorityControl("action", item.id, item.title, item.priority)}${insideProject ? `<button class="next-flag ${item.is_next ? "active" : ""}" data-next-id="${item.id}" data-next-value="${item.is_next}" aria-label="${item.is_next ? "Remove" : "Mark"} ${esc(item.title)} as next physical action">${item.is_next ? "NEXT" : "SET NEXT"}</button>` : ""}${this.copyReferenceButton("action", item.id, item.title)}${this.menu("action", item.id, item.title)}</article>`;
  }

  private projectRow(item: Workspace["projects"][number]) {
    const done = item.status !== "active";
    const tasks = this.scopedActions().filter(action => action.project_id === item.id && (this.showDone || action.status === "active"));
    const nextCount = tasks.filter(task => task.status === "active" && task.is_next).length;
    const open = this.expandedProject === item.id;
    return `<article class="project-card ${done ? "is-done" : ""}" data-render-row><div class="item project-head">${this.check("project", item.id, done, item.title)}<button class="item-main" data-project-toggle="${item.id}" aria-expanded="${open}"><strong>${esc(item.title)}</strong><span>${item.outcome ? esc(item.outcome) : "Outcome needs definition"}</span><em>${item.client_name ? `${esc(item.client_name)} · CLOCK IN · ` : ""}${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} · ${nextCount} next</em></button>${this.itemLink(item.url, item.title)}${this.copyReferenceButton("project", item.id, item.title)}${this.menu("project", item.id, item.title)}</div>${open ? `<div class="project-body"><div class="project-body-head"><strong>Project tasks</strong><button data-add-action="${item.id}">+ Add task</button></div>${tasks.length ? `<div class="rows">${tasks.map(task => this.actionRow(task, true)).join("")}</div>` : `<p class="quiet-line">No tasks yet. Add the first concrete step.</p>`}</div>` : ""}</article>`;
  }

  private ticklerRow(item: Tickler, compact = false) {
    const done = item.status !== "pending";
    const date = parseDay(item.remind_on);
    const today = localDate(new Date());
    const validDate = !Number.isNaN(date.getTime());
    const delta = validDate ? Math.round((date.getTime() - today.getTime()) / 86400000) : Number.NaN;
    const word = !validDate ? "DATE NEEDED" : delta < 0 ? "OVERDUE" : delta === 0 ? "TODAY" : delta === 1 ? "TOMORROW" : "";
    const day = formatDate(date, { day: "2-digit" }, "—");
    const month = formatDate(date, { month: "short" }, "DATE").toUpperCase();
    const fullDate = formatDate(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    return `<article class="item tickler ${done ? "is-done" : ""}" data-render-row>${this.check("tickler", item.id, done, item.title)}${compact ? "" : `<button class="date-badge" data-edit="tickler" data-id="${item.id}" aria-label="Edit ${esc(item.title)}"><b>${day}</b><span>${month}</span></button>`}<button class="item-main" data-edit="tickler" data-id="${item.id}"><strong>${esc(item.title)}</strong><span>${word ? `<mark>${word}</mark> ` : ""}${item.notes ? esc(item.notes) : fullDate}</span></button>${this.itemLink(item.url, item.title)}${this.copyReferenceButton("tickler", item.id, item.title)}${this.menu("tickler", item.id, item.title)}</article>`;
  }

  private simpleRow(kind: "reference" | "someday", id: number, title: string, url: string, notes: string, mark: string) {
    return `<article class="item ${kind}-item" data-render-row><div class="reference-mark" aria-hidden="true">${mark}</div><button class="item-main" data-edit="${kind}" data-id="${id}"><strong>${esc(title)}</strong><span>${esc(notes)}</span></button>${this.itemLink(url, title)}${this.copyReferenceButton(kind, id, title)}${this.menu(kind, id, title)}</article>`;
  }

  private scheduledRow(item: Workspace["scheduled"][number]) {
    const range = item.end_time ? `${timeLabel(item.start_time)}–${timeLabel(item.end_time)}` : timeLabel(item.start_time);
    return `<article class="item scheduled-item ${item.is_blocking ? "blocks" : "nudges"}" data-render-row><div class="time-badge"><strong>${esc(range)}</strong><span>${item.is_blocking ? "BLOCKS" : "NUDGE"}</span></div><button class="item-main" data-edit="scheduled" data-id="${item.id}"><strong>${esc(item.title)}</strong><span>${item.source_label ? esc(item.source_label) : "Scheduled item"}${item.notes ? ` · ${esc(item.notes)}` : ""}</span></button>${this.itemLink(item.url, item.title)}${this.copyReferenceButton("scheduled", item.id, item.title)}${this.menu("scheduled", item.id, item.title)}</article>`;
  }

  private bind() {
    // Refresh, retry, and folder tabs are delegated at the custom-element
    // boundary so re-rendering this.innerHTML cannot detach those handlers.
    this.querySelectorAll<HTMLButtonElement>("[data-week-shift]").forEach(button => button.onclick = () => {
      this.weekStart = shiftDayKey(this.weekStart, Number(button.dataset.weekShift ?? 0));
      this.weekEditor = null;
      this.weekDeleteArmed = null;
      this.render();
      void this.syncWeekCalendar();
    });
    const thisWeekButton = this.querySelector<HTMLButtonElement>("[data-week-today]");
    if (thisWeekButton) thisWeekButton.onclick = () => {
      this.weekStart = currentWeekKey();
      this.weekEditor = null;
      this.render();
      void this.syncWeekCalendar();
    };
    const calendarConfig = this.querySelector<HTMLButtonElement>("[data-calendar-config]");
    if (calendarConfig) calendarConfig.onclick = () => {
      this.weekCalendarsOpen = !this.weekCalendarsOpen;
      this.log("STATE", "calendar visibility panel changed", { open: this.weekCalendarsOpen });
      this.render();
    };
    this.querySelectorAll<HTMLInputElement>("[data-calendar-visibility]").forEach(input => input.onchange = () => {
      const calendar = input.dataset.calendarVisibility as CalendarKey | undefined;
      if (!calendar || !["primary", "intent", "tangentcode"].includes(calendar)) return;
      void this.setCalendarVisibility(calendar, input.checked);
    });
    this.querySelectorAll<HTMLButtonElement>("[data-intent-add]").forEach(button => button.onclick = () => {
      this.weekEditor = { date: button.dataset.intentAdd ?? this.weekStart };
      this.weekCalendarMessage = "";
      this.weekDeleteArmed = null;
      this.render();
      this.querySelector<HTMLInputElement>("[data-intent-form] input[name='title']")?.focus();
    });
    this.querySelectorAll<HTMLButtonElement>("[data-intent-edit]").forEach(button => button.onclick = () => {
      const eventId = Number(button.dataset.intentEdit);
      const calendarEvent = this.calendarEvents().find(item => item.id === eventId);
      if (!calendarEvent || !this.isIntentEvent(calendarEvent) || calendarEvent.is_all_day) return;
      this.weekEditor = { date: this.calendarDayKey(calendarEvent), eventId };
      this.weekCalendarMessage = "";
      this.weekDeleteArmed = null;
      this.render();
    });
    const cancelIntent = this.querySelector<HTMLButtonElement>("[data-intent-cancel]");
    if (cancelIntent) cancelIntent.onclick = () => {
      this.weekEditor = null;
      this.weekDeleteArmed = null;
      this.weekCalendarMessage = "";
      this.render();
    };
    this.querySelectorAll<HTMLButtonElement>("[data-intent-delete]").forEach(button => button.onclick = () => {
      const eventId = Number(button.dataset.intentDelete);
      if (this.weekDeleteArmed !== eventId) {
        this.weekDeleteArmed = eventId;
        this.render();
        return;
      }
      void this.deleteIntentBlock(eventId);
    });
    this.querySelector<HTMLFormElement>("[data-intent-form]")?.addEventListener("submit", event => {
      event.preventDefault();
      void this.saveIntentBlock(event.currentTarget as HTMLFormElement);
    });
    this.querySelectorAll<HTMLElement>("[data-open]").forEach(element => element.onclick = () => { this.log("INFO", "add control clicked", { kind: element.dataset.open }); this.openForm(element.dataset.open as ItemKind); });
    this.querySelector<HTMLElement>("[data-quick-add]")?.addEventListener("click", () => { this.log("INFO", "quick add menu opened"); this.openQuickAddMenu(); });
    this.querySelectorAll<HTMLElement>("[data-edit]").forEach(element => element.onclick = () => { this.log("INFO", "edit control clicked", { kind: element.dataset.edit, id: Number(element.dataset.id) }); this.openForm(element.dataset.edit as ItemKind, Number(element.dataset.id)); });
    this.querySelectorAll<HTMLElement>("[data-add-action]").forEach(element => element.onclick = () => { this.log("INFO", "add project action clicked", { project_id: Number(element.dataset.addAction) }); this.openForm("action", undefined, Number(element.dataset.addAction), false); });
    this.querySelectorAll<HTMLElement>("[data-toggle]").forEach(element => element.onclick = () => void this.toggle(element.dataset.toggle as ActiveKind, Number(element.dataset.id), element.dataset.done !== "true"));
    this.querySelectorAll<HTMLElement>("[data-process]").forEach(element => element.onclick = () => { this.log("INFO", "process inbox clicked", { id: Number(element.dataset.process) }); this.openProcess(Number(element.dataset.process)); });
    this.querySelectorAll<HTMLElement>("[data-menu-kind]").forEach(element => element.onclick = () => { this.log("INFO", "item menu opened", { kind: element.dataset.menuKind, id: Number(element.dataset.menuId) }); this.openMenu(element.dataset.menuKind as ItemKind, Number(element.dataset.menuId), element.dataset.menuLabel || "Item"); });
    this.querySelectorAll<HTMLAnchorElement>("[data-item-link]").forEach(element => element.onclick = event => { event.stopPropagation(); this.log("INFO", "item link opened", { href: element.href }); });
    this.querySelectorAll<HTMLButtonElement>("[data-copy-reference]").forEach(element => element.onclick = () => void this.copyItemReference(element));
    this.querySelectorAll<HTMLElement>("[data-project-toggle]").forEach(element => element.onclick = () => { const id = Number(element.dataset.projectToggle); this.expandedProject = this.expandedProject === id ? null : id; this.log("STATE", "project expansion changed", { project_id: id, expanded: this.expandedProject === id }); this.render(); });
    this.querySelectorAll<HTMLButtonElement>("[data-today-section]").forEach(element => element.onclick = () => {
      const section = element.dataset.todaySection as TodaySection;
      const expanded = this.expandedTodaySections.has(section);
      if (expanded) this.expandedTodaySections.delete(section);
      else this.expandedTodaySections.add(section);
      this.log("STATE", "Today section expansion changed", { section, expanded: !expanded });
      this.render();
    });
    this.querySelectorAll<HTMLElement>("[data-next-id]").forEach(element => element.onclick = () => void this.setTaskNext(Number(element.dataset.nextId), element.dataset.nextValue !== "true"));
    this.querySelectorAll<HTMLSelectElement>("[data-priority-kind]").forEach(element => element.onchange = () => void this.setPriority(element.dataset.priorityKind as "action" | "inbox", Number(element.dataset.priorityId), element.value as Priority));
    this.querySelector<HTMLButtonElement>("[data-event-log-toggle]")?.addEventListener("click", event => {
      const toggle = event.currentTarget as HTMLButtonElement;
      const body = this.querySelector<HTMLElement>("#event-log-body");
      if (!body) return;
      const opening = body.hidden;
      body.hidden = !opening;
      toggle.setAttribute("aria-expanded", String(opening));
      const caret = toggle.querySelector<HTMLElement>(".diagnostic-caret");
      if (caret) caret.textContent = opening ? "▾" : "▸";
      this.log("STATE", "event log visibility changed", { open: opening });
    });
    this.querySelector<HTMLElement>("[data-version-log]")?.addEventListener("click", () => { this.log("INFO", "version log opened"); this.openVersionLog(); });
    this.querySelector<HTMLElement>("[data-copy-event-log]")?.addEventListener("click", () => void this.copyEventLog());
    this.querySelector<HTMLInputElement>("[data-show-done]")?.addEventListener("change", event => { this.showDone = (event.target as HTMLInputElement).checked; this.log("STATE", "show completed changed", { show_done: this.showDone }); this.render(); });
    this.querySelector<HTMLSelectElement>("[data-priority-filter]")?.addEventListener("change", event => { this.priorityFilter = (event.target as HTMLSelectElement).value as PriorityFilter; this.log("STATE", "priority filter changed", { priority: this.priorityFilter }); this.render(); });
    this.querySelector<HTMLSelectElement>("[data-scope-filter]")?.addEventListener("change", event => {
      const select = event.target as HTMLSelectElement;
      if (select.value === "add-client") {
        select.value = this.scope;
        this.log("INFO", "add client selected from scope menu");
        this.openForm("client");
        return;
      }
      this.scope = select.value as Scope;
      this.showDone = false;
      this.log("STATE", "global scope changed", { scope: this.scope });
      this.render();
    });
    this.querySelectorAll<HTMLElement>("[data-daily-toggle]").forEach(element => element.onclick = () => void this.toggleDailyResult(Number(element.dataset.dailyToggle), element.dataset.dailyChecked !== "true"));
    this.querySelectorAll<HTMLElement>("[data-daily-delete]").forEach(element => element.onclick = () => void this.deleteDailyItem(Number(element.dataset.dailyDelete)));
    this.querySelectorAll<HTMLElement>("[data-daily-month]").forEach(element => element.onclick = () => this.shiftDailyMonth(Number(element.dataset.dailyMonth)));
    this.querySelector<HTMLFormElement>("[data-daily-add]")?.addEventListener("submit", event => { event.preventDefault(); void this.addDailyItem(event.currentTarget as HTMLFormElement); });
    this.querySelectorAll<HTMLElement>("[data-weekly-toggle]").forEach(element => element.onclick = () => void this.toggleWeeklyResult(Number(element.dataset.weeklyToggle), element.dataset.weeklyChecked !== "true"));
    this.querySelectorAll<HTMLElement>("[data-weekly-delete]").forEach(element => element.onclick = () => void this.deleteWeeklyItem(Number(element.dataset.weeklyDelete)));
    this.querySelector<HTMLFormElement>("[data-weekly-add]")?.addEventListener("submit", event => { event.preventDefault(); void this.addWeeklyItem(event.currentTarget as HTMLFormElement); });
  }

  private async writeClipboard(text: string) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.append(fallback);
    try {
      fallback.select();
      if (!document.execCommand("copy")) throw new Error("clipboard copy was declined");
    } finally {
      fallback.remove();
    }
  }

  private async copyItemReference(button: HTMLButtonElement) {
    const kind = button.dataset.copyKind as ItemKind;
    const id = Number(button.dataset.copyId);
    const item = this.itemFor(kind, id);
    const title = String(item?.title || item?.name || "Untitled item").trim();
    const reference = `GTD ${kind.toUpperCase()} #${id} — ${title}`;
    const marker = button.querySelector<HTMLElement>("span");
    try {
      await this.writeClipboard(reference);
      if (marker) marker.textContent = "DONE";
      button.classList.add("copied");
      this.toast(`Copied ${kind} #${id}`);
      this.log("INFO", "item reference copied", { kind, id, reference });
      window.setTimeout(() => {
        if (!button.isConnected) return;
        if (marker) marker.textContent = "REF";
        button.classList.remove("copied");
      }, 1800);
    } catch (error) {
      this.log("ERROR", "item reference copy failed", { kind, id, error });
      this.toast("Clipboard blocked — reference selected for manual copy");
      this.openManualCopy(reference, title);
    }
  }

  private openManualCopy(reference: string, label: string) {
    if (!this.dialog) return;
    const dialog = this.dialog;
    dialog.innerHTML = `<div class="version-log manual-copy"><div class="dialog-grip"></div><div class="dialog-head"><div><p>MANUAL COPY</p><h2 id="composer-title">Copy item reference</h2></div><button type="button" data-close aria-label="Close manual copy">×</button></div><p>Clipboard access is unavailable. Select and copy this reference:</p><label>Reference<textarea readonly data-manual-reference aria-label="Reference to ${esc(label)}">${esc(reference)}</textarea></label></div>`;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-close]")!.onclick = () => dialog.close();
    const field = dialog.querySelector<HTMLTextAreaElement>("[data-manual-reference]");
    field?.focus();
    field?.select();
  }

  private async copyEventLog() {
    const text = formatLog();
    const button = this.querySelector<HTMLButtonElement>("[data-copy-event-log]");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const fallback = document.createElement("textarea");
        fallback.value = text;
        fallback.setAttribute("readonly", "");
        fallback.style.position = "fixed";
        fallback.style.opacity = "0";
        document.body.append(fallback);
        fallback.select();
        if (!document.execCommand("copy")) throw new Error("clipboard copy was declined");
        fallback.remove();
      }
      if (button) { button.textContent = "Copied"; window.setTimeout(() => { if (button.isConnected) button.textContent = "Copy"; }, 1800); }
      this.toast(`Copied ${EVENT_LOG.length} log events`);
      this.log("INFO", "event log copied", { copied_characters: text.length, copied_events: EVENT_LOG.length });
    } catch (error) {
      this.toast("Copy failed — open the log and select it manually");
      this.log("ERROR", "event log copy failed", { error });
    }
  }

  private itemFor(kind: ItemKind, id: number): any {
    if (kind === "client") return this.workspaceState.clients.find(item => item.id === id);
    if (kind === "project") return this.workspaceState.projects.find(item => item.id === id);
    if (kind === "action") return this.workspaceState.actions.find(item => item.id === id);
    if (kind === "tickler") return this.workspaceState.ticklers.find(item => item.id === id);
    if (kind === "inbox") return this.workspaceState.inbox.find(item => item.id === id);
    if (kind === "reference") return this.workspaceState.references.find(item => item.id === id);
    if (kind === "someday") return this.workspaceState.someday.find(item => item.id === id);
    return this.workspaceState.scheduled.find(item => item.id === id);
  }

  private projectOptions(selected?: number | null) {
    return this.workspaceState.projects.filter(project => project.status === "active" || project.id === selected).map(project => `<option value="${project.id}" ${selected === project.id ? "selected" : ""}>${esc(project.title)}</option>`).join("");
  }

  private clientOptions(selected?: number | null) {
    return this.workspaceState.clients.map(client => `<option value="${client.id}" ${selected === client.id ? "selected" : ""}>${esc(client.name)}</option>`).join("");
  }

  private priorityOptions(selected: Priority = "unprioritized") {
    return `<option value="unprioritized" ${selected === "unprioritized" ? "selected" : ""}>Unprioritized</option><option value="A" ${selected === "A" ? "selected" : ""}>A</option><option value="B" ${selected === "B" ? "selected" : ""}>B</option><option value="C" ${selected === "C" ? "selected" : ""}>C</option>`;
  }

  private openQuickAddMenu() {
    if (!this.dialog) return;
    const dialog = this.dialog;
    dialog.innerHTML = `<div class="quick-add-menu"><div class="dialog-head"><div><p>QUICK ADD</p><h2 id="composer-title">Create an item</h2></div><button type="button" data-close aria-label="Close quick add menu">×</button></div><div class="menu-stack"><button type="button" data-quick-kind="inbox"><strong>Inbox item</strong><span>Capture something to clarify later</span></button><button type="button" data-quick-kind="action"><strong>Next action</strong><span>Add a concrete action directly</span></button><button type="button" data-quick-kind="project"><strong>Project</strong><span>Create a new outcome</span></button></div></div>`;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-close]")!.onclick = () => dialog.close();
    dialog.querySelectorAll<HTMLButtonElement>("[data-quick-kind]").forEach(button => {
      button.onclick = () => {
        const kind = button.dataset.quickKind as "inbox" | "action" | "project";
        this.log("INFO", "quick add choice selected", { kind });
        dialog.close();
        this.openForm(kind);
      };
    });
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); }, { once: true });
  }

  private openVersionLog() {
    if (!this.dialog) return;
    const dialog = this.dialog;
    const notes = RELEASE_NOTES.map((release, index) => `
      <article class="release-note ${index === 0 ? "current" : ""}">
        <div class="release-note-head"><strong>Release ${esc(release.version)}</strong><time>${esc(release.date)}</time></div>
        <ul>${release.changes.map(change => `<li>${esc(change)}</li>`).join("")}</ul>
      </article>`).join("");
    dialog.innerHTML = `<div class="version-log"><div class="dialog-grip"></div><div class="dialog-head"><div><p>CHANGE HISTORY</p><h2 id="composer-title">Version log</h2></div><button type="button" data-close aria-label="Close version log">×</button></div><div class="release-notes">${notes}</div></div>`;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-close]")!.onclick = () => dialog.close();
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); }, { once: true });
  }

  private urlField(value?: string) {
    return `<label>URL<input type="url" name="url" maxlength="2048" value="${esc(value)}" placeholder="https://example.com" inputmode="url"></label>`;
  }

  private openForm(kind: ItemKind, id?: number, projectId?: number, isNext = true) {
    const item = id ? this.itemFor(kind, id) : null;
    const scopedTicklerNote = kind === "tickler" && !id && this.scope !== "main"
      ? this.scopeClient()?.name ?? this.scopeAgent() ?? ""
      : item?.notes;
    let fields = "";
    if (kind === "client") fields = `<label>Anonymized client identifier<input name="name" required maxlength="80" value="${esc(item?.name)}" placeholder="AB/CD"></label><div class="billing-rule-note"><strong>Clocked-in work only</strong><span>Projects linked to this client will carry this rule.</span></div><label>Notes<textarea name="notes" maxlength="4000" placeholder="Optional internal context; avoid real names on stream">${esc(item?.notes)}</textarea></label>`;
    if (kind === "project") fields = `<label>Project name<input name="title" required maxlength="240" value="${esc(item?.title)}" placeholder="Launch the new site"></label>${this.urlField(item?.url)}<label>Client<select name="client_id"><option value="">No client</option>${this.clientOptions(item?.client_id)}</select></label><label>Successful outcome<textarea name="outcome" maxlength="500" placeholder="What does done look like?">${esc(item?.outcome)}</textarea></label><label>Notes<textarea name="notes" maxlength="4000">${esc(item?.notes)}</textarea></label>`;
    if (kind === "action") fields = `<label>Task<input name="title" required maxlength="240" value="${esc(item?.title)}" placeholder="Email Daniel about access"></label>${this.urlField(item?.url)}<div class="field-grid"><label>Context<input name="context" maxlength="80" value="${esc(item?.context || "@computer")}" placeholder="@computer"></label><label>Project<select name="project_id"><option value="">No project</option>${this.projectOptions(item?.project_id ?? projectId)}</select></label></div><label>Priority<select name="priority">${this.priorityOptions(item?.priority)}</select></label><label class="check-field"><input type="checkbox" name="is_next" ${item ? item.is_next ? "checked" : "" : isNext ? "checked" : ""}> Show in Next Actions</label><label>Notes<textarea name="notes" maxlength="4000">${esc(item?.notes)}</textarea></label>`;
    if (kind === "tickler") fields = `<label>What should resurface?<input name="title" required maxlength="240" value="${esc(item?.title)}" placeholder="Renew the domain"></label>${this.urlField(item?.url)}<label>Remind me on<input type="date" name="remind_on" required value="${esc(item?.remind_on || todayKey())}"></label><label>Notes<textarea name="notes" maxlength="4000">${esc(scopedTicklerNote)}</textarea></label>`;
    if (kind === "inbox") fields = `<label>What has your attention?<input name="title" required maxlength="240" value="${esc(item?.title)}" placeholder="Capture it without sorting it"></label>${this.urlField(item?.url)}<label>Priority<select name="priority">${this.priorityOptions(item?.priority)}</select></label><label>Notes<textarea name="notes" maxlength="4000" placeholder="Optional context">${esc(item?.notes)}</textarea></label>${id ? `<button type="button" class="process-wide" data-process-from-edit="${id}">Clarify and file this item</button>` : ""}`;
    if (kind === "reference" || kind === "someday") fields = `<label>${kind === "reference" ? "Reference title" : "Possibility"}<input name="title" required maxlength="240" value="${esc(item?.title)}" placeholder="${kind === "reference" ? "Useful information" : "Maybe, when the time is right"}"></label>${this.urlField(item?.url)}<label>Notes<textarea name="notes" maxlength="12000" placeholder="Notes, links, details…">${esc(item?.notes)}</textarea></label>`;
    if (kind === "scheduled") fields = `<label>What’s scheduled?<input name="title" required maxlength="240" value="${esc(item?.title)}" placeholder="Lean NYC meetup"></label>${this.urlField(item?.url)}<label>Date<input type="date" name="scheduled_date" required value="${esc(item?.scheduled_date || todayKey())}"></label><div class="field-grid"><label>Start time<input type="time" name="start_time" value="${esc(item?.start_time)}"></label><label>End time<input type="time" name="end_time" value="${esc(item?.end_time)}"></label></div><label>Source label<input name="source_label" maxlength="120" value="${esc(item?.source_label)}" placeholder="Family calendar"></label><fieldset class="kind-choice"><legend>How should this affect the day?</legend><label><input type="radio" name="schedule_kind" value="blocking" ${!item || item.is_blocking ? "checked" : ""}> Blocks this time</label><label><input type="radio" name="schedule_kind" value="nudge" ${item && !item.is_blocking ? "checked" : ""}> Small nudge; surrounding time stays free</label></fieldset><label>Notes<textarea name="notes" maxlength="4000">${esc(item?.notes)}</textarea></label>`;
    if (!this.dialog) return;
    const dialog = this.dialog;
    dialog.innerHTML = `<form method="dialog" data-form><div class="dialog-grip"></div><div class="dialog-head"><div><p>${id ? "EDIT" : "ADD"}</p><h2 id="composer-title">${id ? "Refine" : "Add"} ${this.label(kind)}</h2></div><button type="button" data-close aria-label="Close">×</button></div>${fields}<div class="dialog-actions">${id && kind !== "client" ? `<button type="button" class="delete" data-delete="${kind}" data-id="${id}">Delete</button>` : ""}<button type="submit" class="save">Save</button></div><p class="form-error" role="alert"></p></form>`;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-close]")!.onclick = () => dialog.close();
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); }, { once: true });
    const process = dialog.querySelector<HTMLElement>("[data-process-from-edit]");
    if (process) process.onclick = () => { dialog.close(); this.openProcess(Number(process.dataset.processFromEdit)); };
    const remove = dialog.querySelector<HTMLButtonElement>("[data-delete]");
    if (remove) remove.onclick = () => { if (remove.dataset.armed) void this.removeItem(kind, id!); else { remove.dataset.armed = "1"; remove.textContent = "Tap again to delete"; } };
    dialog.querySelector<HTMLFormElement>("[data-form]")!.onsubmit = event => { event.preventDefault(); void this.saveForm(kind, id, new FormData(event.currentTarget as HTMLFormElement)); };
  }

  private openProcess(id: number) {
    const item = this.workspaceState.inbox.find(entry => entry.id === id);
    if (!item || !this.dialog) return;
    const dialog = this.dialog;
    dialog.innerHTML = `<form method="dialog" data-process-form><div class="dialog-grip"></div><div class="dialog-head"><div><p>CLARIFY</p><h2 id="composer-title">Where does this belong?</h2></div><button type="button" data-close aria-label="Close">×</button></div><label>Item<input name="title" required maxlength="240" value="${esc(item.title)}"></label><label>File as<select name="destination" data-destination><option value="reference">Keep as reference</option><option value="resolved">Resolved — no record needed</option><option value="do_now">Do now</option><option value="action">Add to Next Actions</option><option value="project">Create project + next action</option><option value="delegate">Delegate</option><option value="tickler">Defer to Tickler</option></select></label><div class="destination-fields destination-note" data-fields="reference"><p>Keep useful information that has no next action.</p></div><div class="destination-fields destination-note" data-fields="resolved" hidden><p>Is this truly resolved, with no action or reference value left? If not, choose another destination.</p></div><div class="destination-fields destination-note" data-fields="do_now" hidden><p>Complete it now. It will leave Inbox and remain in completed actions.</p></div><div class="destination-fields" data-fields="action" hidden><div class="field-grid"><label>Context<input name="action_context" value="@computer" maxlength="80" list="gtd-contexts"></label><label>Project<select name="project_id"><option value="">No project</option>${this.projectOptions()}</select></label></div><label>Priority<select name="priority"><option value="A">A</option><option value="B" selected>B</option><option value="C">C</option><option value="unprioritized">None</option></select></label></div><div class="destination-fields" data-fields="project" hidden><label>Successful outcome<textarea name="outcome" maxlength="500" placeholder="What does done look like?"></textarea></label><label>Next physical action<input name="next_action_title" maxlength="240" placeholder="What is the very next step?"></label><label>Next action context<input name="project_context" value="@computer" maxlength="80" list="gtd-contexts"></label></div><div class="destination-fields" data-fields="delegate" hidden><label>Delegate to<select name="delegate_to"><option value="Memnar">Memnar</option><option value="Grok bot">Grok bot</option><option value="">Other…</option></select></label><label>Other person or agent<input name="delegate_other" maxlength="120" placeholder="Who is responsible?"></label><p class="destination-note">Delegated work moves to @waiting for internal monitoring.</p></div><div class="destination-fields" data-fields="tickler" hidden><label>Resurface on<input type="date" name="remind_on" value="${todayKey()}"></label></div><datalist id="gtd-contexts"><option value="@computer"><option value="@phone"><option value="@calls"><option value="@waiting"><option value="@agenda"><option value="@anywhere"></datalist>${this.urlField(item.url)}<label>Notes<textarea name="notes" maxlength="12000">${esc(item.notes)}</textarea></label><div class="dialog-actions"><button type="button" class="delete" data-trash-inbox="${id}">Discard</button><button type="submit" class="save">File item</button></div><p class="form-error" role="alert"></p></form>`;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-close]")!.onclick = () => dialog.close();
    const destination = dialog.querySelector<HTMLSelectElement>("[data-destination]")!;
    destination.onchange = () => dialog.querySelectorAll<HTMLElement>("[data-fields]").forEach(element => { element.hidden = element.dataset.fields !== destination.value; });
    dialog.querySelector<HTMLElement>("[data-trash-inbox]")!.onclick = () => void this.removeItem("inbox", id);
    dialog.querySelector<HTMLFormElement>("[data-process-form]")!.onsubmit = event => { event.preventDefault(); void this.processInbox(id, new FormData(event.currentTarget as HTMLFormElement)); };
  }

  private openMenu(kind: ItemKind, id: number, label: string) {
    if (!this.dialog) return;
    const dialog = this.dialog;
    dialog.innerHTML = `<form method="dialog" data-move-form><div class="dialog-grip"></div><div class="dialog-head"><div><p>ITEM MENU</p><h2 id="composer-title">${esc(label)}</h2></div><button type="button" data-close aria-label="Close">×</button></div><div class="menu-stack"><button type="button" data-menu-edit>Edit details</button>${kind === "action" ? `<button type="button" data-promote="${id}">Promote to project</button>` : ""}</div><div class="move-box"><label>Move to<select name="destination" data-move-destination><option value="inbox">Inbox</option><option value="action">Next Actions</option><option value="project_task">A project’s task list</option><option value="tickler">Tickler</option><option value="reference">Reference</option><option value="someday">Someday / Maybe</option></select></label><div data-move-fields="project_task" hidden><label>Project<select name="project_id"><option value="">Choose project</option>${this.projectOptions()}</select></label><label class="check-field"><input type="checkbox" name="is_next"> Also show as a next action</label></div><div data-move-fields="action"><label>Context<input name="context" value="@computer" maxlength="80"></label></div><div data-move-fields="tickler" hidden><label>Resurface on<input type="date" name="remind_on" value="${todayKey()}"></label></div><button type="submit" class="move-button">Move item</button></div><div class="dialog-actions"><button type="button" class="delete" data-menu-delete>Delete item</button></div><p class="form-error" role="alert"></p></form>`;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-close]")!.onclick = () => dialog.close();
    dialog.querySelector<HTMLElement>("[data-menu-edit]")!.onclick = () => { dialog.close(); this.openForm(kind, id); };
    dialog.querySelector<HTMLElement>("[data-menu-delete]")!.onclick = event => { const button = event.currentTarget as HTMLButtonElement; if (button.dataset.armed) void this.removeItem(kind, id); else { button.dataset.armed = "1"; button.textContent = "Tap again to delete"; } };
    const promote = dialog.querySelector<HTMLElement>("[data-promote]");
    if (promote) promote.onclick = () => void this.promoteAction(id);
    const destination = dialog.querySelector<HTMLSelectElement>("[data-move-destination]")!;
    const reveal = () => dialog.querySelectorAll<HTMLElement>("[data-move-fields]").forEach(element => { element.hidden = element.dataset.moveFields !== destination.value; });
    destination.onchange = reveal; reveal();
    dialog.querySelector<HTMLFormElement>("[data-move-form]")!.onsubmit = event => { event.preventDefault(); void this.moveItem(kind, id, new FormData(event.currentTarget as HTMLFormElement)); };
  }

  private async saveForm(kind: ItemKind, id: number | undefined, form: FormData) {
    const error = this.dialog?.querySelector<HTMLElement>(".form-error");
    const save = this.dialog?.querySelector<HTMLButtonElement>(".save");
    if (save) { save.disabled = true; save.textContent = "Saving…"; }
    try {
      let result;
      if (kind === "client") { const payload = { id, name: String(form.get("name")), notes: String(form.get("notes") || "") }; result = await this.callAction("saveClient", payload, () => api.saveClient(payload)); }
      else if (kind === "project") { const payload = { id, title: String(form.get("title")), url: String(form.get("url") || ""), client_id: form.get("client_id") ? Number(form.get("client_id")) : null, outcome: String(form.get("outcome") || ""), notes: String(form.get("notes") || "") }; result = await this.callAction("saveProject", payload, () => api.saveProject(payload)); }
      else if (kind === "action") { const payload = { id, title: String(form.get("title")), url: String(form.get("url") || ""), context: String(form.get("context") || "@anywhere"), project_id: form.get("project_id") ? Number(form.get("project_id")) : null, notes: String(form.get("notes") || ""), is_next: form.get("is_next") === "on", priority: String(form.get("priority") || "unprioritized") as Priority }; result = await this.callAction("saveNextAction", payload, () => api.saveNextAction(payload)); }
      else if (kind === "tickler") { const payload = { id, title: String(form.get("title")), url: String(form.get("url") || ""), remind_on: String(form.get("remind_on")), notes: String(form.get("notes") || "") }; result = await this.callAction("saveTickler", payload, () => api.saveTickler(payload)); }
      else if (kind === "inbox") { const payload = { id, title: String(form.get("title")), url: String(form.get("url") || ""), notes: String(form.get("notes") || ""), priority: String(form.get("priority") || "unprioritized") as Priority }; result = await this.callAction("saveInbox", payload, () => api.saveInbox(payload)); }
      else if (kind === "reference") { const payload = { id, title: String(form.get("title")), url: String(form.get("url") || ""), notes: String(form.get("notes") || "") }; result = await this.callAction("saveReference", payload, () => api.saveReference(payload)); }
      else if (kind === "someday") { const payload = { id, title: String(form.get("title")), url: String(form.get("url") || ""), notes: String(form.get("notes") || "") }; result = await this.callAction("saveSomeday", payload, () => api.saveSomeday(payload)); }
      else { const payload = { id, title: String(form.get("title")), url: String(form.get("url") || ""), scheduled_date: String(form.get("scheduled_date")), start_time: form.get("start_time") ? String(form.get("start_time")) : null, end_time: form.get("end_time") ? String(form.get("end_time")) : null, source_label: String(form.get("source_label") || ""), is_blocking: form.get("schedule_kind") === "blocking", notes: String(form.get("notes") || "") }; result = await this.callAction("saveScheduledItem", payload, () => api.saveScheduledItem(payload)); }
      if (!result.ok) throw new Error(result.error || "Could not save.");
      this.dialog?.close(); await this.load(false, true, true); this.toast("Saved");
    } catch (caught) {
      if (error) error.textContent = caught instanceof Error ? caught.message : "Could not save.";
      if (save) { save.disabled = false; save.textContent = "Save"; }
    }
  }

  private async processInbox(id: number, form: FormData) {
    const error = this.dialog?.querySelector<HTMLElement>(".form-error");
    const save = this.dialog?.querySelector<HTMLButtonElement>(".save");
    if (save) { save.disabled = true; save.textContent = "Filing…"; }
    try {
      const destination = String(form.get("destination")) as "reference" | "resolved" | "do_now" | "action" | "project" | "delegate" | "tickler";
      const selectedDelegate = String(form.get("delegate_to") || "");
      const delegateTo = selectedDelegate || String(form.get("delegate_other") || "");
      const context = destination === "project" ? String(form.get("project_context") || "@computer") : String(form.get("action_context") || "@anywhere");
      const payload = { id, destination, title: String(form.get("title")), url: String(form.get("url") || ""), notes: String(form.get("notes") || ""), context, project_id: form.get("project_id") ? Number(form.get("project_id")) : null, priority: String(form.get("priority") || "B") as Priority, outcome: String(form.get("outcome") || ""), next_action_title: String(form.get("next_action_title") || ""), delegate_to: delegateTo, remind_on: destination === "tickler" ? String(form.get("remind_on")) : undefined };
      const result = await this.callAction("processInbox", payload, () => api.processInbox(payload));
      if (!result.ok) throw new Error(result.error || "Could not file that item.");
      this.dialog?.close(); await this.load(false, true, true); this.toast("Inbox item filed");
    } catch (caught) {
      if (error) error.textContent = caught instanceof Error ? caught.message : "Could not file that item.";
      if (save) { save.disabled = false; save.textContent = "File item"; }
    }
  }

  private async moveItem(kind: ItemKind, id: number, form: FormData) {
    if (kind === "client") return;
    const error = this.dialog?.querySelector<HTMLElement>(".form-error");
    const button = this.dialog?.querySelector<HTMLButtonElement>(".move-button");
    if (button) { button.disabled = true; button.textContent = "Moving…"; }
    try {
      const destination = String(form.get("destination")) as "inbox" | "action" | "project_task" | "tickler" | "reference" | "someday";
      const payload = { kind, id, destination, project_id: form.get("project_id") ? Number(form.get("project_id")) : null, context: String(form.get("context") || "@computer"), remind_on: destination === "tickler" ? String(form.get("remind_on")) : undefined, is_next: form.get("is_next") === "on" };
      const result = await this.callAction("moveItem", payload, () => api.moveItem(payload));
      if (!result.ok) throw new Error(result.error || "Could not move that item.");
      this.dialog?.close(); await this.load(false, true, true); this.toast("Moved");
    } catch (caught) {
      if (error) error.textContent = caught instanceof Error ? caught.message : "Could not move that item.";
      if (button) { button.disabled = false; button.textContent = "Move item"; }
    }
  }

  private async promoteAction(id: number) {
    const payload = { id };
    try { const result = await this.callAction("promoteAction", payload, () => api.promoteAction(payload)); if (!result.ok) throw new Error(result.error || "Could not promote that action."); this.dialog?.close(); this.tab = "project"; this.log("STATE", "tab changed after promotion", { to: this.tab }); await this.load(false, true, true); this.toast("Promoted to project"); }
    catch (error) { this.log("ERROR", "promote action failed", { id, error }); this.toast("Couldn’t promote that action"); }
  }

  private async setPriority(kind: "action" | "inbox", id: number, priority: Priority) {
    const payload = { kind, id, priority };
    try {
      const result = await this.callAction("setPriority", payload, () => api.setPriority(payload));
      if (!result.ok) throw new Error(result.error || "Could not update that priority.");
      await this.load(false, true, true);
      this.toast(priority === "unprioritized" ? "Priority cleared" : `Priority ${priority}`);
    } catch (error) {
      this.log("ERROR", "priority update failed", { kind, id, priority, error });
      this.toast("Couldn’t update that priority");
      await this.load(false, true, true);
    }
  }

  private async setTaskNext(id: number, isNext: boolean) {
    const payload = { id, is_next: isNext };
    try { const result = await this.callAction("setTaskNext", payload, () => api.setTaskNext(payload)); if (!result.ok) throw new Error(result.error || "Could not update that task."); await this.load(false, true, true); this.toast(isNext ? "Added to Next Actions" : "Kept inside project"); }
    catch (error) { this.log("ERROR", "set next action failed", { id, is_next: isNext, error }); this.toast("Couldn’t update that task"); }
  }

  private async toggle(kind: ActiveKind, id: number, done: boolean) {
    const payload = { kind, id, done };
    try { const result = await this.callAction("setItemStatus", payload, () => api.setItemStatus(payload)); if (!result.ok) throw new Error(result.error || "Could not update that item."); await this.load(false, true, true); this.toast(done ? "Completed" : "Reopened"); }
    catch (error) { this.log("ERROR", "item status update failed", { kind, id, done, error }); this.toast("Couldn’t update that item"); }
  }

  private async toggleDailyResult(itemId: number, passed: boolean) {
    const payload = { item_id: itemId, date: todayKey(), passed, recorded_by: "web-ui" };
    try { await this.callAction("recordDailyResult", payload, () => api.recordDailyResult(payload)); this.dailyDeleteArmed = null; await this.load(false, true, true); this.toast(passed ? "Habit checked" : "Habit unchecked"); }
    catch (error) { this.log("ERROR", "daily result update failed", { item_id: itemId, passed, error }); this.toast("Couldn’t update that habit"); }
  }

  private async addDailyItem(form: HTMLFormElement) {
    const field = form.querySelector<HTMLInputElement>("input[name=\"name\"]");
    const name = field?.value.trim() ?? "";
    if (!name) return;
    const payload = { name };
    try { await this.callAction("saveDailyItem", payload, () => api.saveDailyItem(payload)); await this.load(false, true, true); this.toast("Habit added"); }
    catch (error) { this.log("ERROR", "daily item save failed", { name, error }); this.toast("Couldn’t add that habit"); }
  }

  private async deleteDailyItem(itemId: number) {
    if (this.dailyDeleteArmed !== itemId) { this.dailyDeleteArmed = itemId; this.render(); return; }
    this.dailyDeleteArmed = null;
    const payload = { item_id: itemId };
    try { const result = await this.callAction("deleteDailyItem", payload, () => api.deleteDailyItem(payload)); if (!result.deleted) throw new Error("daily item not found"); await this.load(false, true, true); this.toast("Habit deleted"); }
    catch (error) { this.log("ERROR", "daily item delete failed", { item_id: itemId, error }); this.toast("Couldn’t delete that habit"); }
  }

  private shiftDailyMonth(delta: number) {
    const [year = 1970, month = 1] = this.dailyMonth.split("-").map(Number);
    const date = new Date(year, month - 1 + delta, 1);
    this.dailyMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    this.dailyDeleteArmed = null;
    this.log("STATE", "daily month changed", { month: this.dailyMonth });
    void this.load(false, true, true);
  }

  private async toggleWeeklyResult(itemId: number, passed: boolean) {
    const payload = { item_id: itemId, week: currentWeekKey(), passed, recorded_by: "web-ui" };
    try { await this.callAction("recordWeeklyResult", payload, () => api.recordWeeklyResult(payload)); this.weeklyDeleteArmed = null; await this.load(false, true, true); this.toast(passed ? "Weekly activity checked" : "Weekly activity unchecked"); }
    catch (error) { this.log("ERROR", "weekly result update failed", { item_id: itemId, passed, error }); this.toast("Couldn’t update that activity"); }
  }

  private async addWeeklyItem(form: HTMLFormElement) {
    const field = form.querySelector<HTMLInputElement>("input[name=\"name\"]");
    const name = field?.value.trim() ?? "";
    if (!name) return;
    const payload = { name };
    try { await this.callAction("saveWeeklyItem", payload, () => api.saveWeeklyItem(payload)); await this.load(false, true, true); this.toast("Weekly activity added"); }
    catch (error) { this.log("ERROR", "weekly item save failed", { name, error }); this.toast("Couldn’t add that activity"); }
  }

  private async deleteWeeklyItem(itemId: number) {
    if (this.weeklyDeleteArmed !== itemId) { this.weeklyDeleteArmed = itemId; this.render(); return; }
    this.weeklyDeleteArmed = null;
    const payload = { item_id: itemId };
    try { const result = await this.callAction("deleteWeeklyItem", payload, () => api.deleteWeeklyItem(payload)); if (!result.deleted) throw new Error("weekly item not found"); await this.load(false, true, true); this.toast("Weekly activity deleted"); }
    catch (error) { this.log("ERROR", "weekly item delete failed", { item_id: itemId, error }); this.toast("Couldn’t delete that activity"); }
  }

  private async removeItem(kind: ItemKind, id: number) {    if (kind === "client") { this.log("INFO", "client deletion ignored", { id }); return; }
    const payload = { kind, id };
    try { const result = await this.callAction("deleteItem", payload, () => api.deleteItem(payload)); if (!result.ok) throw new Error(result.error || "Could not delete that item."); this.dialog?.close(); await this.load(false, true, true); this.toast("Deleted"); }
    catch (error) { this.log("ERROR", "delete item failed", { kind, id, error }); this.toast("Couldn’t delete that item"); }
  }

  private toast(message: string) {
    const element = this.querySelector<HTMLElement>(".toast");
    if (!element) return;
    element.textContent = message; element.classList.add("show");
    setTimeout(() => element.classList.remove("show"), 1800);
  }
}

if (!customElements.get("gtd-workspace")) customElements.define("gtd-workspace", GtdWorkspace);
