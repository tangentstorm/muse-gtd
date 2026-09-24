import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { privileged } from "@space/privileged";
import { CALENDAR_KEYS, calendarKeyFor } from "./calendar-config";
import * as schema from "./schema";

const CURRENT_RELEASE = "2026.09.24.15";
const calendarKeySchema = z.enum(CALENDAR_KEYS);
const mutationResponse = z.object({ ok: z.boolean(), id: z.number().optional(), error: z.string().optional() });
const prioritySchema = z.enum(["A", "B", "C", "unprioritized"]);
const optionalUrlSchema = z.string().trim().max(2048).refine(value => value === "" || /^https?:\/\//i.test(value), "Enter a full URL beginning with http:// or https://");
const priorityItemKindSchema = z.enum(["action", "inbox"]);
const itemKindSchema = z.enum(["project", "action", "tickler", "inbox", "reference", "someday", "scheduled"]);
const processDestinationSchema = z.enum(["reference", "resolved", "do_now", "action", "project", "delegate", "tickler"]);
const moveDestinationSchema = z.enum(["inbox", "action", "project_task", "tickler", "reference", "someday"]);

const collectionCountsResponse = z.object({
  clients: z.number().int().nonnegative(),
  projects: z.number().int().nonnegative(),
  actions: z.number().int().nonnegative(),
  ticklers: z.number().int().nonnegative(),
  inbox: z.number().int().nonnegative(),
  references: z.number().int().nonnegative(),
  someday: z.number().int().nonnegative(),
  scheduled: z.number().int().nonnegative(),
});

const clientDiagnosticResponse = z.object({
  kind: z.string(),
  detail: z.string(),
  client_release: z.string(),
  created_at: z.string(),
});

const healthReportResponse = z.object({
  release_version: z.string(),
  state_row_counts: collectionCountsResponse,
  state_row_count: z.number().int().nonnegative(),
  rendered_row_count: z.number().int().nonnegative().nullable(),
  has_data: z.boolean(),
  passed: z.boolean(),
  status: z.enum(["pass", "fail", "unknown"]),
  checked_at: z.string(),
  render_generation: z.string().nullable(),
  render_request_id: z.string().nullable(),
  rendered_at: z.string().nullable(),
  latest_diagnostic: clientDiagnosticResponse.nullable(),
});

const renderMeasurementRequest = z.object({
  render_generation: z.string().min(1).max(200),
  render_request_id: z.string().min(1).max(240).nullable(),
  client_release: z.string().min(1).max(80),
  server_release: z.string().min(1).max(80),
  tab: z.string().min(1).max(40),
  rendered_row_count: z.number().int().nonnegative(),
  state_row_count: z.number().int().nonnegative(),
  has_data: z.boolean(),
  rendered_at: z.string().min(1).max(80),
});

const workspaceCollectionsResponse = z.object({
  clients: z.array(z.object({ id: z.number(), name: z.string(), relationship: z.string(), billing_rule: z.string(), notes: z.string(), updated_at: z.string() })),
  projects: z.array(z.object({ id: z.number(), title: z.string(), url: z.string(), client_id: z.number().nullable(), client_name: z.string().nullable(), billing_rule: z.string().nullable(), outcome: z.string(), notes: z.string(), status: z.string(), completed_at: z.string().nullable(), updated_at: z.string() })),
  actions: z.array(z.object({ id: z.number(), title: z.string(), url: z.string(), context: z.string(), project_id: z.number().nullable(), project_title: z.string().nullable(), client_name: z.string().nullable(), billing_rule: z.string().nullable(), notes: z.string(), status: z.string(), completed_at: z.string().nullable(), is_next: z.boolean(), priority: prioritySchema, created_at: z.string() })),
  ticklers: z.array(z.object({ id: z.number(), title: z.string(), url: z.string(), remind_on: z.string(), notes: z.string(), status: z.string(), completed_at: z.string().nullable(), created_at: z.string() })),
  inbox: z.array(z.object({ id: z.number(), title: z.string(), url: z.string(), notes: z.string(), priority: prioritySchema, created_at: z.string() })),
  references: z.array(z.object({ id: z.number(), title: z.string(), url: z.string(), notes: z.string(), updated_at: z.string() })),
  someday: z.array(z.object({ id: z.number(), title: z.string(), url: z.string(), notes: z.string(), updated_at: z.string() })),
  scheduled: z.array(z.object({ id: z.number(), title: z.string(), url: z.string(), scheduled_date: z.string(), start_time: z.string().nullable(), end_time: z.string().nullable(), source_label: z.string(), is_blocking: z.boolean(), notes: z.string(), updated_at: z.string() })),
});

type WorkspaceCollections = z.infer<typeof workspaceCollectionsResponse>;
type CollectionCounts = z.infer<typeof collectionCountsResponse>;
type HealthReport = z.infer<typeof healthReportResponse>;

const workspaceResponse = workspaceCollectionsResponse.extend({
  loaded_at: z.string(),
  row_count: z.number().int().nonnegative(),
  request_id: z.string().optional(),
  server_release: z.string(),
  client_release: z.string().optional(),
  health_report: healthReportResponse,
  // Parallel fields, deliberately outside the eight-collection health count:
  // calendar events carry no Google ids to the client (title/time/location
  // only; the google id stays server-side).
  calendar_events: z.array(z.object({
    id: z.number(),
    title: z.string(),
    start_time: z.string(),
    end_time: z.string().nullable(),
    location: z.string().nullable(),
    is_all_day: z.boolean(),
    calendar_name: calendarKeySchema,
  })),
  calendar_sync: z.object({
    last_sync_at: z.string().nullable(),
    status: z.string(),
    error_detail: z.string().nullable(),
  }),
  calendar_visibility: z.object({
    primary: z.boolean(),
    intent: z.boolean(),
    tangentcode: z.boolean(),
  }),
  daily_items: z.array(z.object({
    id: z.number(),
    name: z.string(),
    position: z.number(),
    archived_at: z.string().nullable(),
    today_passed: z.boolean().nullable(),
    streak: z.number().int().nonnegative(),
  })),
  daily_month: z.array(z.object({
    date: z.string(),
    passed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })),
  weekly_items: z.array(z.object({
    id: z.number(),
    name: z.string(),
    position: z.number(),
    archived_at: z.string().nullable(),
    this_week_passed: z.boolean().nullable(),
    streak: z.number().int().nonnegative(),
  })),
});

const totalRows = (counts: CollectionCounts) => Object.values(counts).reduce((sum, value) => sum + value, 0);

type RenderMeasurement = {
  renderGeneration: string;
  requestId: string | null;
  clientRelease: string;
  serverRelease: string;
  tab: string;
  renderedRowCount: number;
  hasData: boolean;
  renderedAt: string;
};

type ClientDiagnostic = z.infer<typeof clientDiagnosticResponse>;

const evaluateWorkspaceHealth = (
  loadedCounts: CollectionCounts,
  measurement: RenderMeasurement | null,
  checkedAt = new Date().toISOString(),
  latestDiagnostic: ClientDiagnostic | null = null,
): HealthReport => {
  const stateRowCount = totalRows(loadedCounts);
  const renderedRowCount = measurement?.renderedRowCount ?? null;
  const hasData = measurement?.hasData ?? false;
  const measurementMatchesRelease = measurement?.serverRelease === CURRENT_RELEASE && measurement.clientRelease === CURRENT_RELEASE;
  const passed = measurement !== null
    && measurementMatchesRelease
    && measurement.renderGeneration.length > 0
    && stateRowCount > 0
    && renderedRowCount !== null
    && renderedRowCount > 0
    && hasData === true
    && renderedRowCount === stateRowCount;
  return {
    release_version: CURRENT_RELEASE,
    state_row_counts: loadedCounts,
    state_row_count: stateRowCount,
    rendered_row_count: renderedRowCount,
    has_data: hasData,
    passed,
    status: measurement === null ? "unknown" : passed ? "pass" : "fail",
    checked_at: checkedAt,
    render_generation: measurement?.renderGeneration ?? null,
    render_request_id: measurement?.requestId ?? null,
    rendered_at: measurement?.renderedAt ?? null,
    latest_diagnostic: latestDiagnostic,
  };
};

const readLatestRenderMeasurement = async (ctx: Ctx): Promise<RenderMeasurement | null> => {
  const rows = await ctx.db<typeof schema>().select().from(schema.renderHealthMeasurements).where(eq(schema.renderHealthMeasurements.id, 1));
  const row = rows[0];
  if (!row) return null;
  return {
    renderGeneration: row.renderGeneration,
    requestId: row.requestId,
    clientRelease: row.clientRelease,
    serverRelease: row.serverRelease,
    tab: row.tab,
    renderedRowCount: row.renderedRowCount,
    hasData: row.hasData,
    renderedAt: row.renderedAt,
  };
};

const readLatestClientDiagnostic = async (ctx: Ctx): Promise<ClientDiagnostic | null> => {
  const rows = await ctx.db<typeof schema>().select().from(schema.clientDiagnostics).orderBy(desc(schema.clientDiagnostics.id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    kind: row.kind,
    detail: row.detail,
    client_release: row.clientRelease,
    created_at: row.createdAt,
  };
};

const readWorkspaceState = async (ctx: Ctx): Promise<{ workspace: WorkspaceCollections; stateCounts: CollectionCounts }> => {
  const db = ctx.db<typeof schema>();
  const [clients, projects, actions, ticklers, inbox, references, someday, scheduled] = await Promise.all([
    db.select().from(schema.clients).orderBy(asc(schema.clients.name)),
    db.select({
      id: schema.projects.id, title: schema.projects.title, url: schema.projects.url, clientId: schema.projects.clientId,
      clientName: schema.clients.name, billingRule: schema.clients.billingRule, outcome: schema.projects.outcome,
      notes: schema.projects.notes, status: schema.projects.status, completedAt: schema.projects.completedAt, updatedAt: schema.projects.updatedAt,
    }).from(schema.projects).leftJoin(schema.clients, eq(schema.projects.clientId, schema.clients.id)).orderBy(desc(schema.projects.updatedAt)),
    db.select({
      id: schema.nextActions.id, title: schema.nextActions.title, url: schema.nextActions.url, context: schema.nextActions.context,
      projectId: schema.nextActions.projectId, projectTitle: schema.projects.title, clientName: schema.clients.name,
      billingRule: schema.clients.billingRule, notes: schema.nextActions.notes, status: schema.nextActions.status,
      completedAt: schema.nextActions.completedAt, isNext: schema.nextActions.isNext, priority: schema.nextActions.priority, createdAt: schema.nextActions.createdAt,
    }).from(schema.nextActions)
      .leftJoin(schema.projects, eq(schema.nextActions.projectId, schema.projects.id))
      .leftJoin(schema.clients, eq(schema.projects.clientId, schema.clients.id))
      .orderBy(desc(schema.nextActions.id)),
    db.select().from(schema.ticklers).orderBy(asc(schema.ticklers.remindOn), desc(schema.ticklers.id)),
    db.select().from(schema.inboxItems).orderBy(desc(schema.inboxItems.id)),
    db.select().from(schema.referenceItems).orderBy(desc(schema.referenceItems.updatedAt)),
    db.select().from(schema.somedayItems).orderBy(desc(schema.somedayItems.updatedAt)),
    db.select().from(schema.scheduledItems).orderBy(asc(schema.scheduledItems.scheduledDate), asc(schema.scheduledItems.startTime)),
  ]);

  const stateCounts: CollectionCounts = {
    clients: clients.length,
    projects: projects.length,
    actions: actions.length,
    ticklers: ticklers.length,
    inbox: inbox.length,
    references: references.length,
    someday: someday.length,
    scheduled: scheduled.length,
  };
  const workspace: WorkspaceCollections = {
    clients: clients.map(c => ({ id: c.id, name: c.name, relationship: c.relationship, billing_rule: c.billingRule, notes: c.notes, updated_at: c.updatedAt.toISOString() })),
    projects: projects.map(p => ({ id: p.id, title: p.title, url: p.url, client_id: p.clientId, client_name: p.clientName, billing_rule: p.billingRule, outcome: p.outcome, notes: p.notes, status: p.status, completed_at: p.completedAt?.toISOString() ?? null, updated_at: p.updatedAt.toISOString() })),
    actions: actions.map(a => ({ id: a.id, title: a.title, url: a.url, context: a.context, project_id: a.projectId, project_title: a.projectTitle, client_name: a.clientName, billing_rule: a.billingRule, notes: a.notes, status: a.status, completed_at: a.completedAt?.toISOString() ?? null, is_next: a.isNext, priority: a.priority, created_at: a.createdAt.toISOString() })),
    ticklers: ticklers.map(t => ({ id: t.id, title: t.title, url: t.url, remind_on: t.remindOn, notes: t.notes, status: t.status, completed_at: t.completedAt?.toISOString() ?? null, created_at: t.createdAt.toISOString() })),
    inbox: inbox.map(i => ({ id: i.id, title: i.title, url: i.url, notes: i.notes, priority: i.priority, created_at: i.createdAt.toISOString() })),
    references: references.map(r => ({ id: r.id, title: r.title, url: r.url, notes: r.notes, updated_at: r.updatedAt.toISOString() })),
    someday: someday.map(s => ({ id: s.id, title: s.title, url: s.url, notes: s.notes, updated_at: s.updatedAt.toISOString() })),
    scheduled: scheduled.map(s => ({ id: s.id, title: s.title, url: s.url, scheduled_date: s.scheduledDate, start_time: s.startTime, end_time: s.endTime, source_label: s.sourceLabel, is_blocking: s.isBlocking, notes: s.notes, updated_at: s.updatedAt.toISOString() })),
  };
  return { workspace, stateCounts };
};

const createWorkspaceReader = (requiredNonce = false) => defineAction({
  request: requiredNonce
    ? z.object({ request_id: z.string().min(1), client_release: z.string().min(1), daily_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), daily_month: z.string().regex(/^\d{4}-\d{2}$/).optional(), calendar_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), calendar_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
    : z.object({ refresh_key: z.string().optional(), client_release: z.string().optional(), daily_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), daily_month: z.string().regex(/^\d{4}-\d{2}$/).optional(), calendar_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), calendar_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
  response: workspaceResponse,
  async handler(ctx, args): Promise<z.infer<typeof workspaceResponse>> {
    const checkedAt = new Date().toISOString();
    const [{ workspace, stateCounts }, latestMeasurement, latestDiagnostic, calendarAndDaily] = await Promise.all([
      readWorkspaceState(ctx),
      readLatestRenderMeasurement(ctx),
      readLatestClientDiagnostic(ctx),
      readCalendarAndDaily(ctx, args.daily_date, args.daily_month, args.calendar_start, args.calendar_end),
    ]);
    const healthReport = evaluateWorkspaceHealth(stateCounts, latestMeasurement, checkedAt, latestDiagnostic);
    return {
      ...workspace,
      ...calendarAndDaily,
      loaded_at: checkedAt,
      row_count: healthReport.state_row_count,
      server_release: CURRENT_RELEASE,
      health_report: healthReport,
      ...(args.client_release ? { client_release: args.client_release } : {}),
      ...("request_id" in args ? { request_id: args.request_id } : {}),
    };
  },
});

const dateKeyOf = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const shiftDayKey = (dayKey: string, amount: number) => {
  const date = new Date(`${dayKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
};
const previousDayKey = (dayKey: string) => {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(year!, month! - 1, day!);
  date.setDate(date.getDate() - 1);
  return dateKeyOf(date);
};
// Week key: the Monday of the week containing the given day, as YYYY-MM-DD.
const weekKeyOfDay = (dayKey: string) => {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(year!, month! - 1, day!);
  const mondayOffset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - mondayOffset);
  return dateKeyOf(date);
};
const previousWeekKey = (weekKey: string) => {
  const [year, month, day] = weekKey.split("-").map(Number);
  const date = new Date(year!, month! - 1, day!);
  date.setDate(date.getDate() - 7);
  return dateKeyOf(date);
};
const daysInMonth = (monthKey: string) => {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year!, month!, 0).getDate();
};

type CalendarAndDaily = {
  calendar_events: z.infer<typeof workspaceResponse>["calendar_events"];
  calendar_sync: z.infer<typeof workspaceResponse>["calendar_sync"];
  calendar_visibility: z.infer<typeof workspaceResponse>["calendar_visibility"];
  daily_items: z.infer<typeof workspaceResponse>["daily_items"];
  daily_month: z.infer<typeof workspaceResponse>["daily_month"];
  weekly_items: z.infer<typeof workspaceResponse>["weekly_items"];
};

// Reads the three parallel payloads that sit outside the eight-collection
// health count: synced Google Calendar events + sync status, the daily
// habit items with their results, and the weekly items with their results.
// Streaks walk back through every recorded result (matching the retired
// personal-unit-tests artifact), not just the requested month.
const readCalendarAndDaily = async (ctx: Ctx, dailyDate?: string, dailyMonth?: string, calendarStart?: string, calendarEnd?: string): Promise<CalendarAndDaily> => {
  const db = ctx.db<typeof schema>();
  const todayKey = dailyDate ?? dateKeyOf(new Date());
  const monthKey = dailyMonth ?? todayKey.slice(0, 7);
  const boundedCalendarStart = calendarStart ?? shiftDayKey(todayKey, -1);
  const boundedCalendarEnd = calendarEnd ?? shiftDayKey(todayKey, 8);

  const [eventRows, syncRows, visibilityRows, itemRows, resultRows, weeklyItemRows, weeklyResultRows] = await Promise.all([
    db.select().from(schema.calendarEvents)
      .where(and(gte(schema.calendarEvents.startTime, boundedCalendarStart), lt(schema.calendarEvents.startTime, boundedCalendarEnd)))
      .orderBy(asc(schema.calendarEvents.startTime)),
    db.select().from(schema.calendarSyncState).where(eq(schema.calendarSyncState.id, 1)),
    db.select().from(schema.calendarVisibilityPreferences).where(eq(schema.calendarVisibilityPreferences.id, 1)),
    db.select().from(schema.dailyItems).orderBy(asc(schema.dailyItems.position), asc(schema.dailyItems.id)),
    db.select().from(schema.dailyResults).orderBy(desc(schema.dailyResults.resultDate)),
    db.select().from(schema.weeklyItems).orderBy(asc(schema.weeklyItems.position), asc(schema.weeklyItems.id)),
    db.select().from(schema.weeklyResults).orderBy(desc(schema.weeklyResults.resultWeek)),
  ]);

  const syncRow = syncRows[0];
  const calendar_events = eventRows.map(row => ({
    id: row.id,
    title: row.title,
    start_time: row.startTime,
    end_time: row.endTime,
    location: row.location,
    is_all_day: row.isAllDay,
    calendar_name: calendarKeyFor(row.calendarName),
  }));
  const calendar_sync = {
    last_sync_at: syncRow?.lastSyncAt ?? null,
    status: syncRow?.status ?? "unknown",
    error_detail: syncRow?.errorDetail ?? null,
  };
  const visibilityRow = visibilityRows[0];
  const calendar_visibility = {
    primary: visibilityRow?.primaryVisible ?? true,
    intent: visibilityRow?.intentVisible ?? true,
    tangentcode: visibilityRow?.tangentcodeVisible ?? true,
  };

  const activeItems = itemRows.filter(item => item.archivedAt === null);
  const resultsByItem = new Map<number, Map<string, boolean>>();
  for (const result of resultRows) {
    const map = resultsByItem.get(result.itemId) ?? new Map<string, boolean>();
    map.set(result.resultDate, result.passed);
    resultsByItem.set(result.itemId, map);
  }
  const streakFor = (itemId: number) => {
    const map = resultsByItem.get(itemId) ?? new Map<string, boolean>();
    // Start from the most recent recorded day on or before today: an
    // unrecorded today must not zero a live streak, but a recorded fail ends it.
    let cursor = todayKey;
    for (let guard = 0; guard < 4000 && map.get(cursor) === undefined; guard += 1) cursor = previousDayKey(cursor);
    let streak = 0;
    for (let guard = 0; guard < 4000 && map.get(cursor) === true; guard += 1) {
      streak += 1;
      cursor = previousDayKey(cursor);
    }
    return streak;
  };
  const daily_items = activeItems.map(item => {
    const map = resultsByItem.get(item.id);
    return {
      id: item.id,
      name: item.name,
      position: item.position,
      archived_at: item.archivedAt,
      today_passed: map?.get(todayKey) ?? null,
      streak: streakFor(item.id),
    };
  });

  const monthDays: CalendarAndDaily["daily_month"] = [];
  if (activeItems.length > 0) {
    const total = activeItems.length;
    for (let day = 1; day <= daysInMonth(monthKey); day += 1) {
      const date = `${monthKey}-${String(day).padStart(2, "0")}`;
      let passed = 0;
      for (const item of activeItems) {
        if (resultsByItem.get(item.id)?.get(date) === true) passed += 1;
      }
      monthDays.push({ date, passed, total });
    }
  }

  const thisWeekKey = weekKeyOfDay(todayKey);
  const activeWeeklyItems = weeklyItemRows.filter(item => item.archivedAt === null);
  const weeklyResultsByItem = new Map<number, Map<string, boolean>>();
  for (const result of weeklyResultRows) {
    const map = weeklyResultsByItem.get(result.itemId) ?? new Map<string, boolean>();
    map.set(result.resultWeek, result.passed);
    weeklyResultsByItem.set(result.itemId, map);
  }
  const weeklyStreakFor = (itemId: number) => {
    const map = weeklyResultsByItem.get(itemId) ?? new Map<string, boolean>();
    // Same rule as daily streaks: an unrecorded current week must not zero a
    // live streak, but a recorded fail ends it.
    let cursor = thisWeekKey;
    for (let guard = 0; guard < 4000 && map.get(cursor) === undefined; guard += 1) cursor = previousWeekKey(cursor);
    let streak = 0;
    for (let guard = 0; guard < 4000 && map.get(cursor) === true; guard += 1) {
      streak += 1;
      cursor = previousWeekKey(cursor);
    }
    return streak;
  };
  const weekly_items = activeWeeklyItems.map(item => {
    const map = weeklyResultsByItem.get(item.id);
    return {
      id: item.id,
      name: item.name,
      position: item.position,
      archived_at: item.archivedAt,
      this_week_passed: map?.get(thisWeekKey) ?? null,
      streak: weeklyStreakFor(item.id),
    };
  });

  return { calendar_events, calendar_sync, calendar_visibility, daily_items, daily_month: monthDays, weekly_items };
};

const setCalendarEventsRequest = z.object({
  token: z.string().min(1).max(500),
  events: z.array(z.object({
    google_event_id: z.string().min(1).max(500),
    calendar_name: calendarKeySchema.default("primary"),
    title: z.string().trim().min(1).max(500),
    start_time: z.string().trim().min(1).max(80),
    end_time: z.string().trim().max(80).nullable().default(null),
    location: z.string().trim().max(500).nullable().default(null),
    is_all_day: z.boolean().default(false),
  })).max(1000).default([]),
  // When set, the Google pull itself failed: record the error in the sync
  // state without touching the stored events, so the client can say the sync
  // is unavailable instead of showing stale data as fresh.
  sync_error: z.string().trim().max(2000).optional(),
});

export const Actions = {
  // Keep older names for integrations. Each registration owns its definition,
  // and the client uses the new required-nonce reader for launch and focus
  // refreshes so a retained empty response cannot masquerade as live state.
  listWorkspace: createWorkspaceReader(),
  openWorkspaceFresh: createWorkspaceReader(),
  loadWorkspaceLive: createWorkspaceReader(true),
  loadWorkspaceRelease2026091608: createWorkspaceReader(true),
  loadWorkspaceRelease2026091609: createWorkspaceReader(true),
  loadWorkspaceRelease2026091610: createWorkspaceReader(true),
  loadWorkspaceRelease2026091701: createWorkspaceReader(true),
  loadWorkspaceRelease2026091702: createWorkspaceReader(true),
  loadWorkspaceRelease2026091703: createWorkspaceReader(true),
  loadWorkspaceRelease2026091704: createWorkspaceReader(true),
  loadWorkspaceRelease2026091705: createWorkspaceReader(true),
  loadWorkspaceRelease2026091706: createWorkspaceReader(true),
  loadWorkspaceRelease2026091707: createWorkspaceReader(true),
  loadWorkspaceRelease2026091710: createWorkspaceReader(true),
  loadWorkspaceRelease2026091801: createWorkspaceReader(true),

  // New release route; the pinned 2026091801 route stays so the audit
  // can compare behavior across releases.
  loadWorkspaceRelease2026091802: createWorkspaceReader(true),

  // New release route for the Weekly tab; the 2026091802 route stays pinned.
  loadWorkspaceRelease2026091803: createWorkspaceReader(true),

  setCalendarVisibility: defineAction({
    request: z.object({
      calendar: z.enum(["primary", "intent", "tangentcode"]),
      visible: z.boolean(),
    }),
    response: z.object({
      ok: z.literal(true),
      calendar_visibility: z.object({
        primary: z.boolean(),
        intent: z.boolean(),
        tangentcode: z.boolean(),
      }),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = (await db.select().from(schema.calendarVisibilityPreferences).where(eq(schema.calendarVisibilityPreferences.id, 1)))[0];
      const values = {
        id: 1,
        primaryVisible: args.calendar === "primary" ? args.visible : existing?.primaryVisible ?? true,
        intentVisible: args.calendar === "intent" ? args.visible : existing?.intentVisible ?? true,
        tangentcodeVisible: args.calendar === "tangentcode" ? args.visible : existing?.tangentcodeVisible ?? true,
        updatedAt: new Date().toISOString(),
      };
      await db.insert(schema.calendarVisibilityPreferences).values(values).onConflictDoUpdate({
        target: schema.calendarVisibilityPreferences.id,
        set: values,
      });
      return {
        ok: true as const,
        calendar_visibility: {
          primary: values.primaryVisible,
          intent: values.intentVisible,
          tangentcode: values.tangentcodeVisible,
        },
      };
    },
  }),

  setCalendarEvents: defineAction({
    request: setCalendarEventsRequest,
    response: z.object({ ok: z.boolean(), event_count: z.number().int().nonnegative(), synced_at: z.string().nullable() }),
    privileged: [privileged.verifyCalendarSyncToken],
    async handler(ctx, args) {
      const tokenCheck = await ctx.executePrivileged(privileged.verifyCalendarSyncToken, { token: args.token });
      if (!tokenCheck.matches) {
        return { ok: false, event_count: 0, synced_at: null };
      }
      const db = ctx.db<typeof schema>();
      const syncedAt = new Date().toISOString();
      if (args.sync_error) {
        await db.update(schema.calendarSyncState).set({
          lastSyncAt: syncedAt,
          status: "error",
          errorDetail: args.sync_error,
        }).where(eq(schema.calendarSyncState.id, 1));
        return { ok: false, event_count: (await db.select().from(schema.calendarEvents)).length, synced_at: syncedAt };
      }
      const existing = await db.select({ googleEventId: schema.calendarEvents.googleEventId }).from(schema.calendarEvents);
      const known = new Set(existing.map(row => row.googleEventId));
      const seen = new Set<string>();
      for (const event of args.events) {
        seen.add(event.google_event_id);
        if (known.has(event.google_event_id)) {
          await db.update(schema.calendarEvents).set({
            calendarName: event.calendar_name,
            title: event.title,
            startTime: event.start_time,
            endTime: event.end_time,
            location: event.location,
            isAllDay: event.is_all_day,
            syncedAt,
          }).where(eq(schema.calendarEvents.googleEventId, event.google_event_id));
        } else {
          await db.insert(schema.calendarEvents).values({
            googleEventId: event.google_event_id,
            calendarName: event.calendar_name,
            title: event.title,
            startTime: event.start_time,
            endTime: event.end_time,
            location: event.location,
            isAllDay: event.is_all_day,
            syncedAt,
          });
          known.add(event.google_event_id);
        }
      }
      // Prune events the sync no longer sees (moved/past), since the window
      // is always today through seven days out.
      for (const googleEventId of known) {
        if (!seen.has(googleEventId)) {
          await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.googleEventId, googleEventId));
        }
      }
      await db.update(schema.calendarSyncState).set({
        lastSyncAt: syncedAt,
        status: "ok",
        errorDetail: null,
      }).where(eq(schema.calendarSyncState.id, 1));
      return { ok: true, event_count: seen.size, synced_at: syncedAt };
    },
  }),

  syncCalendarWeek: defineAction({
    request: z.object({ week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    response: z.object({ ok: z.boolean(), event_count: z.number().int().nonnegative(), synced_at: z.string().nullable(), error: z.string().optional() }),
    privileged: [privileged.readCalendarWindow],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const windowStart = shiftDayKey(args.week_start, -1);
      const windowEnd = shiftDayKey(args.week_start, 8);
      const syncedAt = new Date().toISOString();
      const result = await ctx.executePrivileged(privileged.readCalendarWindow, {
        time_min: `${windowStart}T00:00:00Z`,
        time_max: `${windowEnd}T00:00:00Z`,
      });
      if (!result.ok) {
        const values = { id: 1, lastSyncAt: syncedAt, status: "error", errorDetail: result.error ?? "Calendar unavailable." };
        await db.insert(schema.calendarSyncState).values(values).onConflictDoUpdate({ target: schema.calendarSyncState.id, set: values });
        return { ok: false, event_count: 0, synced_at: syncedAt, error: result.error ?? "Calendar unavailable." };
      }
      await db.delete(schema.calendarEvents).where(and(
        gte(schema.calendarEvents.startTime, windowStart),
        lt(schema.calendarEvents.startTime, windowEnd),
      ));
      for (const event of result.events) {
        const values = {
          googleEventId: event.google_event_id,
          calendarName: event.calendar_name,
          title: event.title,
          startTime: event.start_time,
          endTime: event.end_time,
          location: event.location,
          isAllDay: event.is_all_day,
          syncedAt,
        };
        await db.insert(schema.calendarEvents).values(values).onConflictDoUpdate({
          target: schema.calendarEvents.googleEventId,
          set: values,
        });
      }
      const stateValues = { id: 1, lastSyncAt: syncedAt, status: "ok", errorDetail: null };
      await db.insert(schema.calendarSyncState).values(stateValues).onConflictDoUpdate({ target: schema.calendarSyncState.id, set: stateValues });
      return { ok: true, event_count: result.events.length, synced_at: syncedAt };
    },
  }),

  saveIntentCalendarEvent: defineAction({
    request: z.object({
      event_row_id: z.number().int().positive().optional(),
      title: z.string().trim().min(1).max(500),
      start_time: z.string().min(1).max(80),
      end_time: z.string().min(1).max(80),
    }),
    response: z.object({ ok: z.boolean(), event_row_id: z.number().int().positive().optional(), error: z.string().optional() }),
    privileged: [privileged.writeIntentCalendarEvent],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let googleEventId: string | undefined;
      if (args.event_row_id) {
        const rows = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, args.event_row_id));
        const row = rows[0];
        if (!row || calendarKeyFor(row.calendarName) !== "intent") {
          return { ok: false, error: "Only intent blocks can be edited here." };
        }
        googleEventId = row.googleEventId;
      }
      const result = await ctx.executePrivileged(privileged.writeIntentCalendarEvent, {
        operation: googleEventId ? "update" : "create",
        ...(googleEventId ? { event_id: googleEventId } : {}),
        title: args.title,
        start_time: args.start_time,
        end_time: args.end_time,
      });
      if (!result.ok || !result.event) return { ok: false, error: result.error ?? "The intent block could not be saved." };
      const syncedAt = new Date().toISOString();
      const values = {
        googleEventId: result.event.google_event_id,
        calendarName: "intent",
        title: result.event.title,
        startTime: result.event.start_time,
        endTime: result.event.end_time,
        location: result.event.location,
        isAllDay: result.event.is_all_day,
        syncedAt,
      };
      const saved = await db.insert(schema.calendarEvents).values(values).onConflictDoUpdate({
        target: schema.calendarEvents.googleEventId,
        set: values,
      }).returning({ id: schema.calendarEvents.id });
      const eventRowId = saved[0]?.id;
      return eventRowId ? { ok: true, event_row_id: eventRowId } : { ok: false, error: "The intent block was saved but could not be refreshed." };
    },
  }),

  deleteIntentCalendarEvent: defineAction({
    request: z.object({ event_row_id: z.number().int().positive() }),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
    privileged: [privileged.writeIntentCalendarEvent],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, args.event_row_id));
      const row = rows[0];
      if (!row || calendarKeyFor(row.calendarName) !== "intent") {
        return { ok: false, error: "Only intent blocks can be deleted here." };
      }
      const result = await ctx.executePrivileged(privileged.writeIntentCalendarEvent, {
        operation: "delete",
        event_id: row.googleEventId,
      });
      if (!result.ok) return { ok: false, error: result.error ?? "The intent block could not be deleted." };
      await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, args.event_row_id));
      return { ok: true };
    },
  }),

  saveDailyItem: defineAction({
    request: z.object({
      name: z.string().trim().min(1).max(500),
      position: z.number().int().min(0).max(100000).optional(),
      item_id: z.number().int().positive().optional(),
    }),
    response: z.object({ item_id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.dailyItems);
      if (args.item_id) {
        const target = existing.find(item => item.id === args.item_id);
        if (!target) throw new Error("daily item not found");
        const update: Partial<typeof schema.dailyItems.$inferInsert> = {};
        if (target.name !== args.name) update.name = args.name;
        if (args.position !== undefined && target.position !== args.position) update.position = args.position;
        if (Object.keys(update).length > 0) {
          await db.update(schema.dailyItems).set(update).where(eq(schema.dailyItems.id, target.id));
        }
        return { item_id: target.id };
      }
      const position = args.position ?? (existing.length === 0 ? 0 : Math.max(...existing.map(item => item.position)) + 1);
      const inserted = await db.insert(schema.dailyItems).values({ name: args.name, position }).returning({ id: schema.dailyItems.id });
      const itemId = inserted[0]?.id ?? 0;
      if (!itemId) throw new Error("could not save daily item");
      return { item_id: itemId };
    },
  }),

  recordDailyResult: defineAction({
    request: z.object({
      item_id: z.number().int().positive(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      passed: z.boolean(),
      recorded_by: z.string().trim().max(120).default(""),
    }),
    response: z.object({ item_id: z.number(), date: z.string(), passed: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const items = await db.select().from(schema.dailyItems).where(eq(schema.dailyItems.id, args.item_id));
      if (items.length === 0) throw new Error("daily item not found");
      const existing = await db.select().from(schema.dailyResults)
        .where(and(eq(schema.dailyResults.itemId, args.item_id), eq(schema.dailyResults.resultDate, args.date)));
      if (existing.length > 0) {
        await db.update(schema.dailyResults).set({ passed: args.passed, recordedBy: args.recorded_by })
          .where(and(eq(schema.dailyResults.itemId, args.item_id), eq(schema.dailyResults.resultDate, args.date)));
      } else {
        await db.insert(schema.dailyResults).values({
          itemId: args.item_id,
          resultDate: args.date,
          passed: args.passed,
          recordedBy: args.recorded_by,
        });
      }
      return { item_id: args.item_id, date: args.date, passed: args.passed };
    },
  }),

  deleteDailyItem: defineAction({
    request: z.object({ item_id: z.number().int().positive() }),
    response: z.object({ deleted: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.dailyResults).where(eq(schema.dailyResults.itemId, args.item_id));
      const deleted = await db.delete(schema.dailyItems).where(eq(schema.dailyItems.id, args.item_id)).returning({ id: schema.dailyItems.id });
      return { deleted: deleted.length > 0 };
    },
  }),

  saveWeeklyItem: defineAction({
    request: z.object({
      name: z.string().trim().min(1).max(500),
      position: z.number().int().min(0).max(100000).optional(),
      item_id: z.number().int().positive().optional(),
    }),
    response: z.object({ item_id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.weeklyItems);
      if (args.item_id) {
        const target = existing.find(item => item.id === args.item_id);
        if (!target) throw new Error("weekly item not found");
        const update: Partial<typeof schema.weeklyItems.$inferInsert> = {};
        if (target.name !== args.name) update.name = args.name;
        if (args.position !== undefined && target.position !== args.position) update.position = args.position;
        if (Object.keys(update).length > 0) {
          await db.update(schema.weeklyItems).set(update).where(eq(schema.weeklyItems.id, target.id));
        }
        return { item_id: target.id };
      }
      const position = args.position ?? (existing.length === 0 ? 0 : Math.max(...existing.map(item => item.position)) + 1);
      const inserted = await db.insert(schema.weeklyItems).values({ name: args.name, position }).returning({ id: schema.weeklyItems.id });
      const itemId = inserted[0]?.id ?? 0;
      if (!itemId) throw new Error("could not save weekly item");
      return { item_id: itemId };
    },
  }),

  recordWeeklyResult: defineAction({
    request: z.object({
      item_id: z.number().int().positive(),
      week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      passed: z.boolean(),
      recorded_by: z.string().trim().max(120).default(""),
    }),
    response: z.object({ item_id: z.number(), week: z.string(), passed: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const items = await db.select().from(schema.weeklyItems).where(eq(schema.weeklyItems.id, args.item_id));
      if (items.length === 0) throw new Error("weekly item not found");
      const existing = await db.select().from(schema.weeklyResults)
        .where(and(eq(schema.weeklyResults.itemId, args.item_id), eq(schema.weeklyResults.resultWeek, args.week)));
      if (existing.length > 0) {
        await db.update(schema.weeklyResults).set({ passed: args.passed, recordedBy: args.recorded_by })
          .where(and(eq(schema.weeklyResults.itemId, args.item_id), eq(schema.weeklyResults.resultWeek, args.week)));
      } else {
        await db.insert(schema.weeklyResults).values({
          itemId: args.item_id,
          resultWeek: args.week,
          passed: args.passed,
          recordedBy: args.recorded_by,
        });
      }
      return { item_id: args.item_id, week: args.week, passed: args.passed };
    },
  }),

  deleteWeeklyItem: defineAction({
    request: z.object({ item_id: z.number().int().positive() }),
    response: z.object({ deleted: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.weeklyResults).where(eq(schema.weeklyResults.itemId, args.item_id));
      const deleted = await db.delete(schema.weeklyItems).where(eq(schema.weeklyItems.id, args.item_id)).returning({ id: schema.weeklyItems.id });
      return { deleted: deleted.length > 0 };
    },
  }),

  reportClientDiagnostic: defineAction({
    request: z.object({
      kind: z.string().trim().min(1).max(60),
      detail: z.string().max(2000).default(""),
      client_release: z.string().trim().min(1).max(80),
      at: z.string().trim().min(1).max(80),
    }),
    response: z.object({ ok: z.boolean(), id: z.number() }),
    async handler(ctx, args) {
      const rows = await ctx.db<typeof schema>().insert(schema.clientDiagnostics).values({
        kind: args.kind,
        detail: args.detail,
        clientRelease: args.client_release,
        createdAt: args.at,
      }).returning({ id: schema.clientDiagnostics.id });
      const id = rows[0]?.id ?? 0;
      return { ok: id > 0, id };
    },
  }),

  reportRenderMeasurement: defineAction({
    request: renderMeasurementRequest,
    response: healthReportResponse,
    async handler(ctx, args): Promise<z.infer<typeof healthReportResponse>> {
      const checkedAt = new Date().toISOString();
      const { stateCounts } = await readWorkspaceState(ctx);
      const measurement: RenderMeasurement = {
        renderGeneration: args.render_generation,
        requestId: args.render_request_id,
        clientRelease: args.client_release,
        serverRelease: args.server_release,
        tab: args.tab,
        renderedRowCount: args.rendered_row_count,
        hasData: args.has_data,
        renderedAt: args.rendered_at,
      };
      const values = {
        id: 1,
        renderGeneration: measurement.renderGeneration,
        requestId: measurement.requestId,
        clientRelease: measurement.clientRelease,
        serverRelease: measurement.serverRelease,
        tab: measurement.tab,
        renderedRowCount: measurement.renderedRowCount,
        hasData: measurement.hasData,
        renderedAt: measurement.renderedAt,
        recordedAt: checkedAt,
      };
      await ctx.db<typeof schema>().insert(schema.renderHealthMeasurements).values(values).onConflictDoUpdate({
        target: schema.renderHealthMeasurements.id,
        set: values,
      });
      const latestDiagnostic = await readLatestClientDiagnostic(ctx);
      return evaluateWorkspaceHealth(stateCounts, measurement, checkedAt, latestDiagnostic);
    },
  }),

  getHealthReport: defineAction({
    request: z.object({}),
    response: healthReportResponse,
    async handler(ctx): Promise<z.infer<typeof healthReportResponse>> {
      const checkedAt = new Date().toISOString();
      const [{ stateCounts }, latestMeasurement, latestDiagnostic] = await Promise.all([
        readWorkspaceState(ctx),
        readLatestRenderMeasurement(ctx),
        readLatestClientDiagnostic(ctx),
      ]);
      return evaluateWorkspaceHealth(stateCounts, latestMeasurement, checkedAt, latestDiagnostic);
    },
  }),

  saveClient: defineAction({
    request: z.object({ id: z.number().int().positive().optional(), name: z.string().trim().min(1).max(80), notes: z.string().trim().max(4000).default("") }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients);
      const duplicate = existing.find(client => client.name.toLocaleLowerCase() === args.name.toLocaleLowerCase() && client.id !== args.id);
      if (duplicate) return { ok: false, error: "That client is already in the client table." };
      const values = { name: args.name, notes: args.notes, relationship: "current_or_potential", billingRule: "clocked_in_only", updatedAt: new Date() };
      if (args.id) {
        await db.update(schema.clients).set(values).where(eq(schema.clients.id, args.id));
        ctx.invalidateQueries(); return { ok: true, id: args.id };
      }
      const rows = await db.insert(schema.clients).values(values).returning({ id: schema.clients.id });
      ctx.invalidateQueries(); return rows[0] ? { ok: true, id: rows[0].id } : { ok: false, error: "Could not save the client." };
    },
  }),

  saveProject: defineAction({
    request: z.object({ id: z.number().int().positive().optional(), title: z.string().trim().min(1).max(240), url: optionalUrlSchema.default(""), client_id: z.number().int().positive().nullable().default(null), outcome: z.string().trim().max(500).default(""), notes: z.string().trim().max(4000).default("") }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.id) {
        await db.update(schema.projects).set({ title: args.title, url: args.url, clientId: args.client_id, outcome: args.outcome, notes: args.notes, updatedAt: new Date() }).where(eq(schema.projects.id, args.id));
        ctx.invalidateQueries(); return { ok: true, id: args.id };
      }
      const rows = await db.insert(schema.projects).values({ title: args.title, url: args.url, clientId: args.client_id, outcome: args.outcome, notes: args.notes }).returning({ id: schema.projects.id });
      ctx.invalidateQueries(); return rows[0] ? { ok: true, id: rows[0].id } : { ok: false, error: "Could not save the project." };
    },
  }),

  saveNextAction: defineAction({
    request: z.object({ id: z.number().int().positive().optional(), title: z.string().trim().min(1).max(240), url: optionalUrlSchema.default(""), context: z.string().trim().min(1).max(80).default("@anywhere"), project_id: z.number().int().positive().nullable().default(null), notes: z.string().trim().max(4000).default(""), is_next: z.boolean().default(true), priority: prioritySchema.optional().default("unprioritized") }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const context = args.context.startsWith("@") ? args.context : `@${args.context}`;
      const values = { title: args.title, url: args.url, context, projectId: args.project_id, notes: args.notes, isNext: args.project_id ? args.is_next : true, priority: args.priority };
      if (args.id) { await db.update(schema.nextActions).set(values).where(eq(schema.nextActions.id, args.id)); ctx.invalidateQueries(); return { ok: true, id: args.id }; }
      const rows = await db.insert(schema.nextActions).values(values).returning({ id: schema.nextActions.id });
      ctx.invalidateQueries(); return rows[0] ? { ok: true, id: rows[0].id } : { ok: false, error: "Could not save the task." };
    },
  }),

  setPriority: defineAction({
    request: z.object({ kind: priorityItemKindSchema, id: z.number().int().positive(), priority: prioritySchema }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.kind === "action") await db.update(schema.nextActions).set({ priority: args.priority }).where(eq(schema.nextActions.id, args.id));
      if (args.kind === "inbox") await db.update(schema.inboxItems).set({ priority: args.priority }).where(eq(schema.inboxItems.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, id: args.id };
    },
  }),

  setTaskNext: defineAction({
    request: z.object({ id: z.number().int().positive(), is_next: z.boolean() }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.update(schema.nextActions).set({ isNext: args.is_next }).where(eq(schema.nextActions.id, args.id));
      ctx.invalidateQueries(); return { ok: true, id: args.id };
    },
  }),

  saveTickler: defineAction({
    request: z.object({ id: z.number().int().positive().optional(), title: z.string().trim().min(1).max(240), url: optionalUrlSchema.default(""), remind_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), notes: z.string().trim().max(4000).default("") }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const values = { title: args.title, url: args.url, remindOn: args.remind_on, notes: args.notes };
      if (args.id) { await db.update(schema.ticklers).set(values).where(eq(schema.ticklers.id, args.id)); ctx.invalidateQueries(); return { ok: true, id: args.id }; }
      const rows = await db.insert(schema.ticklers).values(values).returning({ id: schema.ticklers.id });
      ctx.invalidateQueries(); return rows[0] ? { ok: true, id: rows[0].id } : { ok: false, error: "Could not save the tickler." };
    },
  }),

  saveInbox: defineAction({
    request: z.object({ id: z.number().int().positive().optional(), title: z.string().trim().min(1).max(240), url: optionalUrlSchema.default(""), notes: z.string().trim().max(4000).default(""), priority: prioritySchema.optional().default("unprioritized") }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.id) { await db.update(schema.inboxItems).set({ title: args.title, url: args.url, notes: args.notes, priority: args.priority }).where(eq(schema.inboxItems.id, args.id)); ctx.invalidateQueries(); return { ok: true, id: args.id }; }
      const rows = await db.insert(schema.inboxItems).values({ title: args.title, url: args.url, notes: args.notes, priority: args.priority }).returning({ id: schema.inboxItems.id });
      ctx.invalidateQueries(); return rows[0] ? { ok: true, id: rows[0].id } : { ok: false, error: "Could not capture that item." };
    },
  }),

  saveReference: defineAction({
    request: z.object({ id: z.number().int().positive().optional(), title: z.string().trim().min(1).max(240), url: optionalUrlSchema.default(""), notes: z.string().trim().max(12000).default("") }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.id) { await db.update(schema.referenceItems).set({ title: args.title, url: args.url, notes: args.notes, updatedAt: new Date() }).where(eq(schema.referenceItems.id, args.id)); ctx.invalidateQueries(); return { ok: true, id: args.id }; }
      const rows = await db.insert(schema.referenceItems).values({ title: args.title, url: args.url, notes: args.notes }).returning({ id: schema.referenceItems.id });
      ctx.invalidateQueries(); return rows[0] ? { ok: true, id: rows[0].id } : { ok: false, error: "Could not save that reference." };
    },
  }),

  saveSomeday: defineAction({
    request: z.object({ id: z.number().int().positive().optional(), title: z.string().trim().min(1).max(240), url: optionalUrlSchema.default(""), notes: z.string().trim().max(12000).default("") }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.id) { await db.update(schema.somedayItems).set({ title: args.title, url: args.url, notes: args.notes, updatedAt: new Date() }).where(eq(schema.somedayItems.id, args.id)); ctx.invalidateQueries(); return { ok: true, id: args.id }; }
      const rows = await db.insert(schema.somedayItems).values({ title: args.title, url: args.url, notes: args.notes }).returning({ id: schema.somedayItems.id });
      ctx.invalidateQueries(); return rows[0] ? { ok: true, id: rows[0].id } : { ok: false, error: "Could not save that someday item." };
    },
  }),

  saveScheduledItem: defineAction({
    request: z.object({
      id: z.number().int().positive().optional(), title: z.string().trim().min(1).max(240), url: optionalUrlSchema.default(""),
      scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), start_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null),
      end_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null), source_label: z.string().trim().max(120).default(""),
      is_blocking: z.boolean().default(true), notes: z.string().trim().max(4000).default(""),
    }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const values = { title: args.title, url: args.url, scheduledDate: args.scheduled_date, startTime: args.start_time, endTime: args.end_time, sourceLabel: args.source_label, isBlocking: args.is_blocking, notes: args.notes, updatedAt: new Date() };
      if (args.id) { await db.update(schema.scheduledItems).set(values).where(eq(schema.scheduledItems.id, args.id)); ctx.invalidateQueries(); return { ok: true, id: args.id }; }
      const rows = await db.insert(schema.scheduledItems).values(values).returning({ id: schema.scheduledItems.id });
      ctx.invalidateQueries(); return rows[0] ? { ok: true, id: rows[0].id } : { ok: false, error: "Could not save that scheduled item." };
    },
  }),

  processInbox: defineAction({
    request: z.object({
      id: z.number().int().positive(), destination: processDestinationSchema,
      title: z.string().trim().min(1).max(240), url: optionalUrlSchema.default(""), notes: z.string().trim().max(12000).default(""),
      context: z.string().trim().max(80).optional(), project_id: z.number().int().positive().nullable().optional(),
      priority: prioritySchema.default("B"),
      outcome: z.string().trim().max(500).optional(), next_action_title: z.string().trim().max(240).optional(),
      delegate_to: z.string().trim().max(120).optional(), remind_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const sourceRows = await db.select({ priority: schema.inboxItems.priority, url: schema.inboxItems.url }).from(schema.inboxItems).where(eq(schema.inboxItems.id, args.id));
      const sourceItem = sourceRows[0];
      if (!sourceItem) return { ok: false, error: "That inbox item no longer exists." };
      let createdId: number | undefined;
      if (args.destination === "action") {
        const context = args.context?.trim() || "@anywhere";
        const rows = await db.insert(schema.nextActions).values({ title: args.title, url: args.url, notes: args.notes, context: context.startsWith("@") ? context : `@${context}`, projectId: args.project_id ?? null, isNext: true, priority: args.priority }).returning({ id: schema.nextActions.id });
        createdId = rows[0]?.id;
      } else if (args.destination === "do_now") {
        const rows = await db.insert(schema.nextActions).values({ title: args.title, url: args.url, notes: args.notes, context: "@anywhere", status: "completed", completedAt: new Date(), isNext: true }).returning({ id: schema.nextActions.id });
        createdId = rows[0]?.id;
      } else if (args.destination === "delegate") {
        if (!args.delegate_to?.trim()) return { ok: false, error: "Choose who will take this." };
        const delegate = args.delegate_to.trim();
        const rows = await db.insert(schema.nextActions).values({ title: `Waiting: ${delegate} — ${args.title}`, url: args.url, notes: args.notes, context: "@waiting", isNext: true }).returning({ id: schema.nextActions.id });
        createdId = rows[0]?.id;
      } else if (args.destination === "project") {
        if (!args.next_action_title?.trim()) return { ok: false, error: "Name the project's next physical action." };
        const rows = await db.insert(schema.projects).values({ title: args.title, url: args.url, notes: args.notes, outcome: args.outcome || "" }).returning({ id: schema.projects.id });
        createdId = rows[0]?.id;
        if (createdId) {
          const context = args.context?.trim() || "@computer";
          await db.insert(schema.nextActions).values({ title: args.next_action_title.trim(), context: context.startsWith("@") ? context : `@${context}`, projectId: createdId, isNext: true });
        }
      } else if (args.destination === "tickler") {
        if (!args.remind_on) return { ok: false, error: "Choose a date for this tickler item." };
        const rows = await db.insert(schema.ticklers).values({ title: args.title, url: args.url, notes: args.notes, remindOn: args.remind_on }).returning({ id: schema.ticklers.id });
        createdId = rows[0]?.id;
      } else if (args.destination === "reference") {
        const rows = await db.insert(schema.referenceItems).values({ title: args.title, url: args.url, notes: args.notes }).returning({ id: schema.referenceItems.id });
        createdId = rows[0]?.id;
      } else if (args.destination === "resolved") {
        createdId = args.id;
      }
      if (!createdId) return { ok: false, error: "Could not file that inbox item." };
      await db.delete(schema.inboxItems).where(eq(schema.inboxItems.id, args.id));
      ctx.invalidateQueries(); return { ok: true, id: createdId };
    },
  }),

  promoteAction: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.nextActions).where(eq(schema.nextActions.id, args.id));
      const item = rows[0];
      if (!item) return { ok: false, error: "That next action no longer exists." };
      const projects = await db.insert(schema.projects).values({ title: item.title, url: item.url, outcome: item.title, notes: item.notes }).returning({ id: schema.projects.id });
      if (!projects[0]) return { ok: false, error: "Could not create the project." };
      await db.delete(schema.nextActions).where(eq(schema.nextActions.id, args.id));
      ctx.invalidateQueries(); return { ok: true, id: projects[0].id };
    },
  }),

  moveItem: defineAction({
    request: z.object({
      kind: itemKindSchema, id: z.number().int().positive(), destination: moveDestinationSchema,
      project_id: z.number().int().positive().nullable().optional(), context: z.string().trim().max(80).optional(),
      remind_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), is_next: z.boolean().optional(),
    }),
    response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let item: { title: string; url: string; notes: string; priority?: "A" | "B" | "C" | "unprioritized" } | undefined;
      if (args.kind === "project") { const row = (await db.select().from(schema.projects).where(eq(schema.projects.id, args.id)))[0]; if (row) item = { title: row.title, url: row.url, notes: row.notes }; }
      if (args.kind === "action") { const row = (await db.select().from(schema.nextActions).where(eq(schema.nextActions.id, args.id)))[0]; if (row) item = { title: row.title, url: row.url, notes: row.notes, priority: row.priority }; }
      if (args.kind === "tickler") { const row = (await db.select().from(schema.ticklers).where(eq(schema.ticklers.id, args.id)))[0]; if (row) item = { title: row.title, url: row.url, notes: row.notes }; }
      if (args.kind === "inbox") { const row = (await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, args.id)))[0]; if (row) item = { title: row.title, url: row.url, notes: row.notes, priority: row.priority }; }
      if (args.kind === "reference") { const row = (await db.select().from(schema.referenceItems).where(eq(schema.referenceItems.id, args.id)))[0]; if (row) item = { title: row.title, url: row.url, notes: row.notes }; }
      if (args.kind === "someday") { const row = (await db.select().from(schema.somedayItems).where(eq(schema.somedayItems.id, args.id)))[0]; if (row) item = { title: row.title, url: row.url, notes: row.notes }; }
      if (args.kind === "scheduled") { const row = (await db.select().from(schema.scheduledItems).where(eq(schema.scheduledItems.id, args.id)))[0]; if (row) item = { title: row.title, url: row.url, notes: row.notes }; }
      if (!item) return { ok: false, error: "That item no longer exists." };

      let createdId: number | undefined;
      if (args.destination === "inbox") createdId = (await db.insert(schema.inboxItems).values(item).returning({ id: schema.inboxItems.id }))[0]?.id;
      if (args.destination === "action") {
        const context = args.context?.trim() || "@anywhere";
        createdId = (await db.insert(schema.nextActions).values({ ...item, context: context.startsWith("@") ? context : `@${context}`, projectId: args.project_id ?? null, isNext: true }).returning({ id: schema.nextActions.id }))[0]?.id;
      }
      if (args.destination === "project_task") {
        if (!args.project_id) return { ok: false, error: "Choose a project for this task." };
        const context = args.context?.trim() || "@computer";
        createdId = (await db.insert(schema.nextActions).values({ ...item, context: context.startsWith("@") ? context : `@${context}`, projectId: args.project_id, isNext: args.is_next ?? false }).returning({ id: schema.nextActions.id }))[0]?.id;
      }
      if (args.destination === "tickler") {
        if (!args.remind_on) return { ok: false, error: "Choose a date for this tickler item." };
        createdId = (await db.insert(schema.ticklers).values({ ...item, remindOn: args.remind_on }).returning({ id: schema.ticklers.id }))[0]?.id;
      }
      if (args.destination === "reference") createdId = (await db.insert(schema.referenceItems).values(item).returning({ id: schema.referenceItems.id }))[0]?.id;
      if (args.destination === "someday") createdId = (await db.insert(schema.somedayItems).values(item).returning({ id: schema.somedayItems.id }))[0]?.id;
      if (!createdId) return { ok: false, error: "Could not move that item." };

      if (args.kind === "project") await db.delete(schema.projects).where(eq(schema.projects.id, args.id));
      if (args.kind === "action") await db.delete(schema.nextActions).where(eq(schema.nextActions.id, args.id));
      if (args.kind === "tickler") await db.delete(schema.ticklers).where(eq(schema.ticklers.id, args.id));
      if (args.kind === "inbox") await db.delete(schema.inboxItems).where(eq(schema.inboxItems.id, args.id));
      if (args.kind === "reference") await db.delete(schema.referenceItems).where(eq(schema.referenceItems.id, args.id));
      if (args.kind === "someday") await db.delete(schema.somedayItems).where(eq(schema.somedayItems.id, args.id));
      if (args.kind === "scheduled") await db.delete(schema.scheduledItems).where(eq(schema.scheduledItems.id, args.id));
      ctx.invalidateQueries(); return { ok: true, id: createdId };
    },
  }),

  setItemStatus: defineAction({
    request: z.object({ kind: z.enum(["project", "action", "tickler"]), id: z.number().int().positive(), done: z.boolean() }), response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const completedAtForTransition = (currentStatus: string, currentCompletedAt: Date | null, doneStatus: string) => (
        args.done ? (currentStatus === doneStatus ? currentCompletedAt : new Date()) : null
      );
      if (args.kind === "project") {
        const item = (await db.select({ status: schema.projects.status, completedAt: schema.projects.completedAt }).from(schema.projects).where(eq(schema.projects.id, args.id)))[0];
        if (!item) return { ok: false, error: "That project no longer exists." };
        await db.update(schema.projects).set({
          status: args.done ? "completed" : "active",
          completedAt: completedAtForTransition(item.status, item.completedAt, "completed"),
          updatedAt: new Date(),
        }).where(eq(schema.projects.id, args.id));
      }
      if (args.kind === "action") {
        const item = (await db.select({ status: schema.nextActions.status, completedAt: schema.nextActions.completedAt }).from(schema.nextActions).where(eq(schema.nextActions.id, args.id)))[0];
        if (!item) return { ok: false, error: "That next action no longer exists." };
        await db.update(schema.nextActions).set({
          status: args.done ? "completed" : "active",
          completedAt: completedAtForTransition(item.status, item.completedAt, "completed"),
        }).where(eq(schema.nextActions.id, args.id));
      }
      if (args.kind === "tickler") {
        const item = (await db.select({ status: schema.ticklers.status, completedAt: schema.ticklers.completedAt }).from(schema.ticklers).where(eq(schema.ticklers.id, args.id)))[0];
        if (!item) return { ok: false, error: "That tickler item no longer exists." };
        await db.update(schema.ticklers).set({
          status: args.done ? "done" : "pending",
          completedAt: completedAtForTransition(item.status, item.completedAt, "done"),
        }).where(eq(schema.ticklers.id, args.id));
      }
      ctx.invalidateQueries(); return { ok: true, id: args.id };
    },
  }),

  deleteItem: defineAction({
    request: z.object({ kind: itemKindSchema, id: z.number().int().positive() }), response: mutationResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.kind === "project") await db.delete(schema.projects).where(eq(schema.projects.id, args.id));
      if (args.kind === "action") await db.delete(schema.nextActions).where(eq(schema.nextActions.id, args.id));
      if (args.kind === "tickler") await db.delete(schema.ticklers).where(eq(schema.ticklers.id, args.id));
      if (args.kind === "inbox") await db.delete(schema.inboxItems).where(eq(schema.inboxItems.id, args.id));
      if (args.kind === "reference") await db.delete(schema.referenceItems).where(eq(schema.referenceItems.id, args.id));
      if (args.kind === "someday") await db.delete(schema.somedayItems).where(eq(schema.somedayItems.id, args.id));
      if (args.kind === "scheduled") await db.delete(schema.scheduledItems).where(eq(schema.scheduledItems.id, args.id));
      ctx.invalidateQueries(); return { ok: true, id: args.id };
    },
  }),
} satisfies ActionsModule;
