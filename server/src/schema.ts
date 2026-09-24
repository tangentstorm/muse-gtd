import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const clients = sqliteTable("clients", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  relationship: text("relationship").notNull().default("current_or_potential"),
  billingRule: text("billing_rule").notNull().default("clocked_in_only"),
  notes: text("notes").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  url: text("url").notNull().default(""),
  clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
  outcome: text("outcome").notNull().default(""),
  notes: text("notes").notNull().default(""),
  status: text("status").notNull().default("active"),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const nextActions = sqliteTable("next_actions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  url: text("url").notNull().default(""),
  context: text("context").notNull().default("@anywhere"),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  notes: text("notes").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  isNext: integer("is_next", { mode: "boolean" }).notNull().default(true),
  priority: text("priority", { enum: ["A", "B", "C", "unprioritized"] }).notNull().default("unprioritized"),
});

export const ticklers = sqliteTable("ticklers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  url: text("url").notNull().default(""),
  remindOn: text("remind_on").notNull(),
  notes: text("notes").notNull().default(""),
  status: text("status").notNull().default("pending"),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const inboxItems = sqliteTable("inbox_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  url: text("url").notNull().default(""),
  notes: text("notes").notNull().default(""),
  priority: text("priority", { enum: ["A", "B", "C", "unprioritized"] }).notNull().default("unprioritized"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const referenceItems = sqliteTable("reference_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  url: text("url").notNull().default(""),
  notes: text("notes").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const somedayItems = sqliteTable("someday_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  url: text("url").notNull().default(""),
  notes: text("notes").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const scheduledItems = sqliteTable("scheduled_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  url: text("url").notNull().default(""),
  scheduledDate: text("scheduled_date").notNull(),
  startTime: text("start_time"),
  endTime: text("end_time"),
  sourceLabel: text("source_label").notNull().default(""),
  isBlocking: integer("is_blocking", { mode: "boolean" }).notNull().default(true),
  notes: text("notes").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const calendarEvents = sqliteTable("calendar_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  googleEventId: text("google_event_id").notNull().unique(),
  calendarName: text("calendar_name").notNull().default("primary"),
  title: text("title").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time"),
  location: text("location"),
  isAllDay: integer("is_all_day", { mode: "boolean" }).notNull().default(false),
  syncedAt: text("synced_at").notNull(),
});

export const calendarSyncState = sqliteTable("calendar_sync_state", {
  id: integer("id").primaryKey(),
  lastSyncAt: text("last_sync_at"),
  status: text("status").notNull().default("unknown"),
  errorDetail: text("error_detail"),
});

export const calendarVisibilityPreferences = sqliteTable("calendar_visibility_preferences", {
  id: integer("id").primaryKey(),
  primaryVisible: integer("primary_visible", { mode: "boolean" }).notNull().default(true),
  intentVisible: integer("intent_visible", { mode: "boolean" }).notNull().default(true),
  tangentcodeVisible: integer("tangentcode_visible", { mode: "boolean" }).notNull().default(true),
  updatedAt: text("updated_at").notNull(),
});

export const dailyItems = sqliteTable("daily_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  archivedAt: text("archived_at"),
});

export const dailyResults = sqliteTable("daily_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  itemId: integer("item_id").notNull().references(() => dailyItems.id, { onDelete: "cascade" }),
  resultDate: text("result_date").notNull(),
  passed: integer("passed", { mode: "boolean" }).notNull(),
  recordedBy: text("recorded_by").notNull().default(""),
});

export const weeklyItems = sqliteTable("weekly_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  archivedAt: text("archived_at"),
});

export const weeklyResults = sqliteTable("weekly_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  itemId: integer("item_id").notNull().references(() => weeklyItems.id, { onDelete: "cascade" }),
  resultWeek: text("result_week").notNull(),
  passed: integer("passed", { mode: "boolean" }).notNull(),
  recordedBy: text("recorded_by").notNull().default(""),
});

export const clientDiagnostics = sqliteTable("client_diagnostics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  detail: text("detail").notNull().default(""),
  clientRelease: text("client_release").notNull(),
  createdAt: text("created_at").notNull(),
});

export const renderHealthMeasurements = sqliteTable("render_health_measurements", {
  id: integer("id").primaryKey(),
  renderGeneration: text("render_generation").notNull(),
  requestId: text("request_id"),
  clientRelease: text("client_release").notNull(),
  serverRelease: text("server_release").notNull(),
  tab: text("tab").notNull(),
  renderedRowCount: integer("rendered_row_count").notNull(),
  hasData: integer("has_data", { mode: "boolean" }).notNull(),
  renderedAt: text("rendered_at").notNull(),
  recordedAt: text("recorded_at").notNull(),
});
