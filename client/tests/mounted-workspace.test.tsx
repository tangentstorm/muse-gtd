import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Workspace } from "../src/GtdWorkspace";

const RELEASE = "2026.09.24.15";
const ROWS_PER_COLLECTION = 30;

// One DOM per test FILE: the workspace module registers its custom element on
// the active window's registry at import time, so every test in this file
// shares the window created here.
const installDom = () => {
  const window = new Window({ url: "https://gtd.test/" });
  const globals = {
    window,
    document: window.document,
    customElements: window.customElements,
    HTMLElement: window.HTMLElement,
    HTMLDialogElement: window.HTMLDialogElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    ErrorEvent: window.ErrorEvent,
    MouseEvent: window.MouseEvent,
    PromiseRejectionEvent: window.PromiseRejectionEvent,
    navigator: window.navigator,
    location: window.location,
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return window;
};

const window = installDom();

const makeWorkspace = (): Workspace => {
  const iso = "2026-09-16T16:00:00.000Z";
  const clients = Array.from({ length: ROWS_PER_COLLECTION }, (_, index) => ({
    id: index + 1,
    name: `Test client ${index + 1}`,
    relationship: "current_or_potential",
    billing_rule: "clocked_in_only",
    notes: `Client note ${index + 1}`,
    updated_at: iso,
  }));
  const projects = Array.from({ length: ROWS_PER_COLLECTION }, (_, index) => ({
    id: index + 1,
    title: `Test project ${index + 1}`,
    url: "",
    client_id: clients[index]?.id ?? null,
    client_name: clients[index]?.name ?? null,
    billing_rule: clients[index]?.billing_rule ?? null,
    outcome: `Project outcome ${index + 1}`,
    notes: `Project note ${index + 1}`,
    status: "active",
    completed_at: null,
    updated_at: iso,
  }));
  const actions = Array.from({ length: ROWS_PER_COLLECTION }, (_, index) => ({
    id: index + 1,
    title: `Test next action ${index + 1}`,
    url: "",
    context: index % 2 === 0 ? "@computer" : "@anywhere",
    project_id: projects[index]?.id ?? null,
    project_title: projects[index]?.title ?? null,
    client_name: clients[index]?.name ?? null,
    billing_rule: clients[index]?.billing_rule ?? null,
    notes: `Action note ${index + 1}`,
    status: "active",
    completed_at: null,
    is_next: true,
    priority: index % 4 === 0 ? "A" as const : index % 4 === 1 ? "B" as const : index % 4 === 2 ? "C" as const : "unprioritized" as const,
    created_at: iso,
  }));
  // 221 rows total (6 collections x 30 + inbox x 41): the storage-blocked
  // regression below must feed exactly the production row count.
  const inbox = Array.from({ length: ROWS_PER_COLLECTION + 11 }, (_, index) => ({
    id: index + 1,
    title: `Test inbox item ${index + 1}`,
    url: "",
    notes: `Inbox note ${index + 1}`,
    priority: "unprioritized" as const,
    created_at: iso,
  }));
  const ticklers = Array.from({ length: ROWS_PER_COLLECTION }, (_, index) => ({
    id: index + 1,
    title: `Test tickler ${index + 1}`,
    url: "",
    remind_on: "2030-01-01",
    notes: `Tickler note ${index + 1}`,
    status: "pending",
    completed_at: null,
    created_at: iso,
  }));
  const references = Array.from({ length: ROWS_PER_COLLECTION }, (_, index) => ({
    id: index + 1,
    title: `Test reference ${index + 1}`,
    url: "",
    notes: `Reference note ${index + 1}`,
    updated_at: iso,
  }));
  const someday = Array.from({ length: ROWS_PER_COLLECTION }, (_, index) => ({
    id: index + 1,
    title: `Test someday item ${index + 1}`,
    url: "",
    notes: `Someday note ${index + 1}`,
    updated_at: iso,
  }));
  const counts = {
    clients: clients.length,
    projects: projects.length,
    actions: actions.length,
    ticklers: ticklers.length,
    inbox: inbox.length,
    references: references.length,
    someday: someday.length,
    scheduled: 0,
  };
  const rowCount = Object.values(counts).reduce((sum, count) => sum + count, 0);

  return {
    clients,
    projects,
    actions,
    ticklers,
    inbox,
    references,
    someday,
    scheduled: [],
    calendar_events: [],
    calendar_sync: { last_sync_at: null, status: "unknown", error_detail: null },
    calendar_visibility: { primary: true, intent: true, tangentcode: true },
    daily_items: [],
    daily_month: [],
    weekly_items: [],
    loaded_at: iso,
    row_count: rowCount,
    request_id: "mounted-regression-test",
    server_release: RELEASE,
    client_release: RELEASE,
    health_report: {
      release_version: RELEASE,
      state_row_counts: counts,
      state_row_count: rowCount,
      rendered_row_count: null,
      has_data: false,
      passed: false,
      status: "unknown",
      checked_at: iso,
      render_generation: null,
      render_request_id: null,
      rendered_at: null,
      latest_diagnostic: null,
    },
  };
};

const makeEmptyWorkspace = (): Workspace => {
  const iso = new Date().toISOString();
  const counts = { clients: 0, projects: 0, actions: 0, ticklers: 0, inbox: 0, references: 0, someday: 0, scheduled: 0 };
  return {
    clients: [], projects: [], actions: [], ticklers: [], inbox: [], references: [], someday: [], scheduled: [],
    calendar_events: [], calendar_sync: { last_sync_at: null, status: "unknown", error_detail: null },
    calendar_visibility: { primary: true, intent: true, tangentcode: true },
    daily_items: [], daily_month: [], weekly_items: [],
    loaded_at: iso, row_count: 0, request_id: "diag-test",
    server_release: RELEASE, client_release: RELEASE,
    health_report: {
      release_version: RELEASE, state_row_counts: counts, state_row_count: 0,
      rendered_row_count: null, has_data: false, passed: false, status: "unknown",
      checked_at: iso, render_generation: null, render_request_id: null, rendered_at: null,
      latest_diagnostic: null,
    },
  };
};

type FetchMode = "populated" | "stale" | "diag" | "daily";
let fetchMode: FetchMode = "populated";
let diagnosticsShouldFail = true;
let diagnosticRejectStatus: number | null = null;
const actionCalls: Array<{ action?: string; args?: Record<string, unknown> }> = [];
const jsonResponse = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
// Fixture for the 2026.09.18.3 Today/Daily/Weekly UI smoke test: calendar events,
// a manual scheduled block, due and upcoming ticklers, A/B/C/unprioritized
// actions, and daily habits with month history.
const makeDailyWorkspace = (): Workspace => {
  const iso = new Date().toISOString();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrowKey = `${next.getFullYear()}-${pad2(next.getMonth() + 1)}-${pad2(next.getDate())}`;
  const monthKey = todayKey.slice(0, 7);
  const counts = { clients: 0, projects: 0, actions: 4, ticklers: 2, inbox: 1, references: 0, someday: 0, scheduled: 1 };
  const rowCount = 8;
  return {
    clients: [], projects: [],
    actions: [
      { id: 1, title: "A-item", url: "https://example.com/action-a", context: "@computer", project_id: null, project_title: null, client_name: null, billing_rule: null, notes: "", status: "active", completed_at: null, is_next: true, priority: "A", created_at: iso },
      { id: 2, title: "B-item", url: "", context: "@computer", project_id: null, project_title: null, client_name: null, billing_rule: null, notes: "Owned by minavobot", status: "active", completed_at: null, is_next: true, priority: "B", created_at: iso },
      { id: 3, title: "C-item", url: "", context: "@computer", project_id: null, project_title: null, client_name: null, billing_rule: null, notes: "", status: "active", completed_at: null, is_next: true, priority: "C", created_at: iso },
      { id: 4, title: "plain-item", url: "", context: "@computer", project_id: null, project_title: null, client_name: null, billing_rule: null, notes: "", status: "active", completed_at: null, is_next: true, priority: "unprioritized", created_at: iso },
    ],
    ticklers: [
      { id: 1, title: "Tickler today", url: "", remind_on: todayKey, notes: "", status: "pending", completed_at: null, created_at: iso },
      { id: 2, title: "Tickler tomorrow", url: "", remind_on: tomorrowKey, notes: "", status: "pending", completed_at: null, created_at: iso },
    ],
    inbox: [
      { id: 1, title: "Fresh inbox capture", url: "", notes: "Clarify this first", priority: "unprioritized", created_at: iso },
    ], references: [], someday: [],
    scheduled: [
      { id: 1, title: "Manual block", url: "", scheduled_date: todayKey, start_time: "14:00", end_time: "15:00", source_label: "", is_blocking: true, notes: "", updated_at: iso },
    ],
    calendar_events: [
      { id: 1, title: "Morning sync", start_time: `${todayKey}T09:30:00-04:00`, end_time: `${todayKey}T10:00:00-04:00`, location: "Meet", is_all_day: false, calendar_name: "primary" },
      { id: 2, title: "Holiday", start_time: todayKey, end_time: null, location: null, is_all_day: true, calendar_name: "primary" },
      { id: 3, title: "Dentist", start_time: `${tomorrowKey}T10:00:00-04:00`, end_time: `${tomorrowKey}T11:00:00-04:00`, location: null, is_all_day: false, calendar_name: "primary" },
      { id: 4, title: "Write launch outline", start_time: `${todayKey}T11:00:00-04:00`, end_time: `${todayKey}T12:00:00-04:00`, location: null, is_all_day: false, calendar_name: "intent" },
      { id: 5, title: "Tangentcode planning", start_time: `${todayKey}T13:00:00-04:00`, end_time: `${todayKey}T13:30:00-04:00`, location: "Online", is_all_day: false, calendar_name: "tangentcode" },
    ],
    calendar_sync: { last_sync_at: `${todayKey}T12:00:00.000Z`, status: "ok", error_detail: null },
    calendar_visibility: { primary: true, intent: true, tangentcode: true },
    daily_items: [
      { id: 1, name: "Reached inbox zero in GTD", position: 1, archived_at: null, today_passed: true, streak: 3 },
      { id: 2, name: "Daily speaking practice", position: 2, archived_at: null, today_passed: null, streak: 1 },
    ],
    daily_month: [
      { date: `${monthKey}-01`, passed: 2, total: 2 },
      { date: `${monthKey}-02`, passed: 1, total: 3 },
      { date: `${monthKey}-03`, passed: 0, total: 2 },
    ],
    weekly_items: [
      { id: 1, name: "Example weekly activity", position: 0, archived_at: null, this_week_passed: null, streak: 0 },
    ],
    loaded_at: iso,
    row_count: rowCount,
    request_id: "daily-calendar-ui-test",
    server_release: RELEASE,
    client_release: RELEASE,
    health_report: {
      release_version: RELEASE, state_row_counts: counts, state_row_count: rowCount,
      rendered_row_count: null, has_data: false, passed: false, status: "unknown",
      checked_at: iso, render_generation: null, render_request_id: null, rendered_at: null,
      latest_diagnostic: null,
    },
  } as unknown as Workspace;
};
const fixture = makeWorkspace();
const dailyFixture = makeDailyWorkspace();
// A workspace whose server release is older than the client: exercises the
// release-mismatch branch. The server still echoes the client's release.
const staleWorkspace: Workspace = {
  ...fixture,
  server_release: "2026.09.17.5",
  health_report: { ...fixture.health_report, release_version: "2026.09.17.5" },
};

const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
  const request = JSON.parse(String(init?.body ?? "{}")) as { action?: string; args?: Record<string, unknown> };
  actionCalls.push(request);
  if (fetchMode === "diag") {
    if (request.action === "reportClientDiagnostic") {
      if (diagnosticRejectStatus !== null) {
        const status = diagnosticRejectStatus;
        diagnosticRejectStatus = null; // one-shot
        throw { status, message: `simulated HTTP ${status}` };
      }
      if (diagnosticsShouldFail) throw new Error("simulated diagnostic post failure");
      return jsonResponse({ ok: true, id: 7 });
    }
    return jsonResponse(makeEmptyWorkspace());
  }
  if (request.action === "syncCalendarWeek") {
    const activeFixture = fetchMode === "daily" ? dailyFixture : fixture;
    return jsonResponse({ ok: true, event_count: activeFixture.calendar_events.length, synced_at: new Date().toISOString() });
  }
  if (request.action === "setCalendarVisibility") {
    const calendar = request.args?.calendar;
    if (fetchMode === "daily" && (calendar === "primary" || calendar === "intent" || calendar === "tangentcode")) {
      dailyFixture.calendar_visibility[calendar] = request.args?.visible === true;
    }
    return jsonResponse({ ok: true, calendar_visibility: fetchMode === "daily" ? dailyFixture.calendar_visibility : fixture.calendar_visibility });
  }
  if (request.action === "saveIntentCalendarEvent") return jsonResponse({ ok: true, event_row_id: 4 });
  if (request.action === "deleteIntentCalendarEvent") return jsonResponse({ ok: true });
  if (request.action === "reportRenderMeasurement") {
    const activeFixture = fetchMode === "daily" ? dailyFixture : fixture;
    const renderedRowCount = Number(request.args?.rendered_row_count ?? 0);
    const stateRowCount = Number(request.args?.state_row_count ?? 0);
    const hasData = request.args?.has_data === true;
    const passed = renderedRowCount > 0 && stateRowCount === activeFixture.row_count && renderedRowCount === stateRowCount && hasData === true;
    return jsonResponse({
      release_version: RELEASE,
      state_row_counts: activeFixture.health_report.state_row_counts,
      state_row_count: activeFixture.row_count,
      rendered_row_count: renderedRowCount,
      has_data: hasData,
      passed,
      status: passed ? "pass" : "fail",
      checked_at: activeFixture.loaded_at,
      render_generation: request.args?.render_generation,
      render_request_id: request.args?.render_request_id ?? null,
      rendered_at: request.args?.rendered_at,
      latest_diagnostic: null,
    });
  }
  if (fetchMode === "daily") return jsonResponse(dailyFixture);
  if (fetchMode === "stale") return jsonResponse(staleWorkspace);
  return jsonResponse(fixture);
};
Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: fetchMock });
Object.defineProperty(window, "fetch", { configurable: true, writable: true, value: fetchMock });

await import("../src/GtdWorkspace");

const waitFor = async (predicate: () => boolean, message: string) => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

const mountWorkspace = () => {
  const host = window.document.createElement("div");
  const workspace = window.document.createElement("gtd-workspace");
  host.append(workspace);
  window.document.body.append(host);
  return workspace;
};

// Simulates a strict host (desktop Chrome in a blob: iframe) that denies
// every storage access with a SecurityError. Returns a restore function.
const installThrowingStorage = () => {
  const realLocalStorage = window.localStorage;
  const realSessionStorage = window.sessionStorage;
  const denied = (name: string) => () => {
    const error = new Error(`Failed to read the '${name}' property from 'Window': Access is denied for this document.`);
    error.name = "SecurityError";
    throw error;
  };
  const throwingStore = (name: string) => ({
    getItem: denied(name),
    setItem: denied(name),
    removeItem: denied(name),
    clear: denied(name),
  });
  Object.defineProperty(window, "localStorage", { configurable: true, writable: true, value: throwingStore("localStorage") });
  Object.defineProperty(window, "sessionStorage", { configurable: true, writable: true, value: throwingStore("sessionStorage") });
  return () => {
    Object.defineProperty(window, "localStorage", { configurable: true, writable: true, value: realLocalStorage });
    Object.defineProperty(window, "sessionStorage", { configurable: true, writable: true, value: realSessionStorage });
  };
};

test("the shell mounts exactly one permanent workspace without a React lifecycle", async () => {
  const mainSource = await Bun.file(new URL("../src/main.tsx", import.meta.url)).text();
  expect(mainSource).toContain('document.createElement("gtd-workspace")');
  expect(mainSource).toContain("rootEl.replaceChildren(shell)");
  expect(mainSource).not.toContain("react-dom");
  expect(mainSource).not.toContain("createRoot");
  expect(mainSource).not.toContain("StrictMode");
  expect(mainSource).not.toContain("QueryClientProvider");
});

test("workspace state commits through the dedicated workspaceState field with a recount guard", async () => {
  // Regression for the 2026.09.17.6 desktop signature: a validated 221-row
  // response was committed as row_count 0 because the workspace lived in the
  // generic `data` field, which did not survive the custom-element boundary.
  // Render-critical state must stay in the dedicated field, and the commit
  // must recount all eight collections before it counts as successful.
  const workspaceSource = await Bun.file(new URL("../src/GtdWorkspace.ts", import.meta.url)).text();
  expect(workspaceSource).toContain("private workspaceState: Workspace");
  expect(workspaceSource).toContain("commitWorkspaceState(");
  expect(workspaceSource).toContain("workspace commit changed");
  expect(workspaceSource).not.toContain("this.data");
});

test("the mounted app renders and exactly measures a populated 221-row workspace", async () => {
  fetchMode = "populated";
  actionCalls.length = 0;
  window.localStorage.clear();
  const workspace = mountWorkspace();

  await waitFor(
    () => workspace.textContent?.includes(`${fixture.row_count} items loaded`) === true,
    "The mounted GTD app never finished its normal workspace load.",
  );
  expect(fixture.row_count).toBeGreaterThanOrEqual(200);
  expect(actionCalls[0]?.action).toBe("loadWorkspaceRelease2026091803");
  expect(actionCalls[0]?.args?.client_release).toBe(RELEASE);

  const authoritativeStateLog = workspace.querySelector("[data-event-log-content]")?.textContent ?? "";
  const commitAndRender = authoritativeStateLog.match(
    /workspace state updated[\s\S]*?"row_count":\s*(\d+)[\s\S]*?render complete[\s\S]*?"rendered_row_count":\s*(\d+)[\s\S]*?"state_row_count":\s*(\d+)/,
  );
  expect(commitAndRender).not.toBeNull();
  expect(Number(commitAndRender?.[1])).toBe(fixture.row_count);
  expect(Number(commitAndRender?.[2])).toBe(fixture.row_count);
  expect(Number(commitAndRender?.[3])).toBe(fixture.row_count);

  await waitFor(
    () => actionCalls.some(call => call.action === "reportRenderMeasurement"),
    "The post-render self-check never reported its DOM measurement.",
  );
  const initialRenderReport = actionCalls.find(call => call.action === "reportRenderMeasurement");
  expect(initialRenderReport?.args?.rendered_row_count).toBe(fixture.row_count);
  expect(initialRenderReport?.args?.state_row_count).toBe(fixture.row_count);
  expect(initialRenderReport?.args?.render_request_id).toBe(fixture.request_id);
  expect(initialRenderReport?.args?.has_data).toBe(true);
  expect(typeof initialRenderReport?.args?.render_generation).toBe("string");
  await waitFor(
    () => workspace.querySelector("[data-event-log-content]")?.textContent?.includes("workspace self-check passed") === true,
    "The exact populated state/render measurement did not pass its self-check.",
  );
  const passedLog = workspace.querySelector("[data-event-log-content]")?.textContent ?? "";
  expect(passedLog).toContain(`\"state_row_count\": ${fixture.row_count}`);
  expect(passedLog).toContain(`\"rendered_row_count\": ${fixture.row_count}`);
  expect(passedLog).toContain("\"has_data\": true");
  expect(passedLog).toContain("\"status\": \"pass\"");

  const folderTabs = Array.from(workspace.querySelectorAll<HTMLElement>(".folder-tab"));
  expect(folderTabs.map(tab => tab.dataset.tab)).toEqual([
    "today", "week", "schedule", "inbox", "project", "someday", "done", "reference",
  ]);
  const referenceTab = folderTabs[folderTabs.length - 1];
  expect(referenceTab?.querySelector("strong")?.textContent).toBe("Reference");
  expect(referenceTab?.querySelector("b")?.textContent).toBe(String(fixture.references.length));

  const views = [
    { tab: "project", selector: ".project-card", titles: fixture.projects.map(item => item.title) },
    { tab: "today", selector: ".task-item", titles: fixture.actions.map(item => item.title) },
    { tab: "inbox", selector: ".inbox-item", titles: fixture.inbox.map(item => item.title) },
    { tab: "schedule", selector: ".tickler", titles: fixture.ticklers.map(item => item.title) },
    { tab: "reference", selector: ".reference-item", titles: fixture.references.map(item => item.title) },
    { tab: "someday", selector: ".someday-item", titles: fixture.someday.map(item => item.title) },
  ] as const;

  let renderedRowCount = 0;
  for (const view of views) {
    const tab = workspace.querySelector<HTMLElement>(`[data-tab="${view.tab}"]`);
    expect(tab).not.toBeNull();
    tab?.click();

    const renderedRows = workspace.querySelectorAll(view.selector);
    renderedRowCount += renderedRows.length;
    expect(renderedRows.length).toBe(view.titles.length);

    const visibleText = workspace.textContent ?? "";
    for (const title of view.titles) expect(visibleText).toContain(title);
  }

  if (fixture.row_count >= 200 && renderedRowCount === 0) {
    throw new Error("REGRESSION: populated workspace state rendered zero GTD rows (.4/.6/.8 empty-workspace signature).");
  }
  expect(renderedRowCount).toBe(fixture.row_count - fixture.clients.length);

  await waitFor(
    () => actionCalls.some(call => call.action === "reportRenderMeasurement" && call.args?.tab === "someday" && call.args?.rendered_row_count === fixture.row_count),
    "The populated folder render was not measured after its DOM update.",
  );
  const populatedReport = [...actionCalls].reverse().find(call => call.action === "reportRenderMeasurement" && call.args?.tab === "someday");
  expect(populatedReport?.args?.has_data).toBe(true);
  expect(populatedReport?.args?.rendered_row_count).toBe(fixture.row_count);
  expect(populatedReport?.args?.state_row_count).toBe(fixture.row_count);
  expect(workspace.querySelectorAll("[data-workspace-row]").length).toBe(fixture.row_count);

  workspace.remove();
});

test("2026.09.24.15 keeps Today and Week badge-free in every state", async () => {
  fetchMode = "daily";
  actionCalls.length = 0;
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
  const workspace = mountWorkspace() as any;

  const tab = (name: string) => workspace.querySelector<HTMLElement>(`[data-tab="${name}"]`);
  const expectNoBadge = (name: "today" | "week") => {
    expect(tab(name)).not.toBeNull();
    expect(tab(name)?.querySelector("b")).toBeNull();
  };
  const expectBadge = (name: string, count: number | string) => {
    expect(tab(name)?.querySelector("b")?.textContent).toBe(String(count));
  };

  // Loading/narrow state: the two badge-free tabs must not substitute an
  // ellipsis badge while every count-bearing folder retains its placeholder.
  expectNoBadge("today");
  expectNoBadge("week");
  for (const name of ["schedule", "inbox", "project", "someday", "done", "reference"]) {
    expectBadge(name, "…");
  }

  await waitFor(
    () => workspace.textContent?.includes(`${dailyFixture.row_count} items loaded`) === true,
    "The daily fixture never loaded for folder badge verification.",
  );

  // Populated state: Today and Week stay badge-free; all remaining tabs keep
  // the exact counts produced by their existing activeCount behavior.
  expectNoBadge("today");
  expectNoBadge("week");
  expectBadge("schedule", 5);
  expectBadge("inbox", 1);
  expectBadge("project", 0);
  expectBadge("someday", 0);
  expectBadge("done", 0);
  expectBadge("reference", 0);

  // Switching tabs and collapsing a populated Today group must not recreate a
  // badge on either folder tab. The Week Calendars control remains available.
  tab("today")?.click();
  const inboxSection = workspace.querySelector<HTMLElement>('[data-today-section="inbox"]');
  expect(inboxSection?.getAttribute("aria-expanded")).toBe("true");
  inboxSection?.click();
  expect(workspace.querySelector('[data-today-section="inbox"]')?.getAttribute("aria-expanded")).toBe("false");
  expectNoBadge("today");
  expectNoBadge("week");
  tab("week")?.click();
  await waitFor(() => workspace.querySelector("[data-calendar-config]") !== null, "Week did not render its Calendars control.");
  expect(workspace.querySelector("[data-calendar-config]")?.textContent).toBe("Calendars");
  expectNoBadge("today");
  expectNoBadge("week");

  // Empty state: the same tabs remain structurally badge-free, while every
  // other folder still renders its existing zero badge.
  workspace.workspaceState = makeEmptyWorkspace();
  workspace.loading = false;
  workspace.render();
  expectNoBadge("today");
  expectNoBadge("week");
  for (const name of ["schedule", "inbox", "project", "someday", "done", "reference"]) {
    expectBadge(name, 0);
  }

  workspace.remove();
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
  fetchMode = "populated";
});

test("storage-blocked client still commits and renders a validated workspace", async () => {
  // Desktop Chrome inside a strict blob: host denies every storage access
  // with a SecurityError. The validated workspace must still reach in-memory
  // state and render with data: the .17.5 desktop signature was
  // "workspace state updated" with row_count 0 and a permanently empty view.
  fetchMode = "populated";
  actionCalls.length = 0;
  const restoreStorage = installThrowingStorage();
  try {
    const workspace = mountWorkspace();

    await waitFor(
      () => workspace.textContent?.includes(`${fixture.row_count} items loaded`) === true,
      "A storage-blocked client never finished its workspace load.",
    );
    expect(actionCalls[0]?.action).toBe("loadWorkspaceRelease2026091803");

    // The commit must carry the validated rows, not an empty default.
    const eventLog = workspace.querySelector("[data-event-log-content]")?.textContent ?? "";
    const committed = eventLog.match(/workspace state updated[\s\S]*?"row_count":\s*(\d+)/);
    expect(committed).not.toBeNull();
    expect(Number(committed?.[1])).toBe(fixture.row_count);

    // The render must complete with data instead of stalling on an empty view.
    const rendered = eventLog.match(/render complete[\s\S]*?"rendered_row_count":\s*(\d+)[\s\S]*?"has_data":\s*(true|false)/);
    expect(rendered).not.toBeNull();
    expect(Number(rendered?.[1])).toBe(fixture.row_count);
    expect(rendered?.[2]).toBe("true");

    await waitFor(
      () => actionCalls.some(call => call.action === "reportRenderMeasurement"),
      "The storage-blocked client never reported its render measurement.",
    );
    const report = actionCalls.find(call => call.action === "reportRenderMeasurement");
    expect(report?.args?.rendered_row_count).toBe(fixture.row_count);
    expect(report?.args?.state_row_count).toBe(fixture.row_count);
    expect(report?.args?.has_data).toBe(true);

    workspace.remove();
  } finally {
    restoreStorage();
  }
});

test("storage-blocked client on a stale release warns instead of reload-looping", async () => {
  // Without a durable reload-once marker an automatic reload could loop
  // forever (an in-memory flag cannot survive the navigation it gates), so a
  // storage-blocked client must never auto-reload: it keeps working and shows
  // a notice that a newer release is available.
  fetchMode = "stale";
  actionCalls.length = 0;
  const restoreStorage = installThrowingStorage();
  try {
    const workspace = mountWorkspace();

    // The sync line shows the update notice instead of the item count while
    // the warning is set, so wait for the warning itself.
    await waitFor(
      () => workspace.textContent?.includes("A newer GTD release (2026.09.17.5) is available") === true,
      "A storage-blocked client on a stale release never showed the update notice.",
    );

    const eventLog = workspace.querySelector("[data-event-log-content]")?.textContent ?? "";
    expect(eventLog).toContain("release mismatch detected");

    // The validated lists still commit and render with data.
    const committed = eventLog.match(/workspace state updated[\s\S]*?"row_count":\s*(\d+)/);
    expect(committed).not.toBeNull();
    expect(Number(committed?.[1])).toBe(fixture.row_count);
    expect(workspace.querySelectorAll("[data-workspace-row]").length).toBe(fixture.row_count);

    // The mismatch path must not render twice: exactly one self-check report
    // per load, not two (a second same-tick render would double the
    // reportRenderMeasurement traffic for the whole mismatch window).
    await waitFor(
      () => actionCalls.some(call => call.action === "reportRenderMeasurement"),
      "The stale-release client never reported its render measurement.",
    );
    const measurements = actionCalls.filter(call => call.action === "reportRenderMeasurement");
    expect(measurements.length).toBe(1);
    expect(measurements[0]?.args?.rendered_row_count).toBe(fixture.row_count);
    expect(measurements[0]?.args?.has_data).toBe(true);

    workspace.remove();
  } finally {
    restoreStorage();
    fetchMode = "populated";
  }
});

test("Done view groups every completed row once under newest-first completion dates", async () => {
  fetchMode = "populated";
  actionCalls.length = 0;
  const workspace = mountWorkspace() as any;
  await waitFor(
    () => workspace.textContent?.includes(`${fixture.row_count} items loaded`) === true,
    "The GTD app never loaded before the Done view test.",
  );

  const completedWorkspace: Workspace = {
    ...fixture,
    actions: fixture.actions.map((item, index) => index === 0
      ? { ...item, status: "completed", completed_at: "2026-09-18T18:30:00.000Z" }
      : index === 1
        ? { ...item, status: "completed", completed_at: "2026-09-18T12:00:00.000Z" }
        : item),
    projects: fixture.projects.map((item, index) => index === 0
      ? { ...item, status: "completed", completed_at: "2026-09-17T20:15:00.000Z" }
      : item),
    ticklers: fixture.ticklers.map((item, index) => index === 0
      ? { ...item, status: "done", completed_at: "2026-09-16T09:45:00.000Z" }
      : item),
  };
  workspace.workspaceState = completedWorkspace;
  workspace.loading = false;
  workspace.render();
  workspace.querySelector<HTMLElement>('[data-tab="done"]')?.click();

  const groups = [...workspace.querySelectorAll<HTMLElement>("[data-done-date]")];
  const rows = workspace.querySelectorAll<HTMLElement>(".done-item");
  expect(rows.length).toBe(4);
  expect(groups.map(group => group.dataset.doneDate)).toEqual(["2026-09-18", "2026-09-17", "2026-09-16"]);
  expect(groups[0]?.querySelectorAll(".done-item").length).toBe(2);
  expect(groups[1]?.querySelectorAll(".done-item").length).toBe(1);
  expect(groups[2]?.querySelectorAll(".done-item").length).toBe(1);
  expect([...rows].every(row => row.closest("[data-done-date]") !== null)).toBe(true);
  expect(new Set([...rows].map(row => row.textContent)).size).toBe(4);
  expect(workspace.textContent).not.toContain("Date unavailable");
  expect(workspace.textContent).toMatch(/4\s*completed items/);
  expect(workspace.querySelector('[data-tab="done"]')?.getAttribute("aria-current")).toBe("page");

  workspace.remove();
});

test("2026.09.24.9 compact header, headline-free folders, and working folder controls", async () => {
  fetchMode = "daily";
  actionCalls.length = 0;
  window.localStorage.clear();
  const workspace = mountWorkspace();

  await waitFor(
    () => workspace.textContent?.includes(`${dailyFixture.row_count} items loaded`) === true,
    "The mounted GTD app never finished its daily-fixture load.",
  );
  expect(actionCalls[0]?.action).toBe("loadWorkspaceRelease2026091803");

  // Daily, recurring, and ticklers live in one compact Future tab; Clients is now a scope.
  const tabs = workspace.querySelectorAll(".folder-tab");
  expect(tabs.length).toBe(8);
  expect(workspace.querySelector('[data-tab="action"]')).toBeNull();
  expect(workspace.querySelector('[data-tab="today"]')?.textContent).toContain("Work");
  expect(workspace.querySelector('[data-tab="today"]')?.textContent).not.toContain("Plan");
  expect(workspace.querySelector('[data-tab="daily"]')).toBeNull();
  expect(workspace.querySelector('[data-tab="weekly"]')).toBeNull();
  expect(workspace.querySelector('[data-tab="tickler"]')).toBeNull();
  expect(workspace.querySelector('[data-tab="client"]')).toBeNull();
  const scheduleTab = workspace.querySelector('[data-tab="schedule"]');
  expect(scheduleTab?.textContent).toContain("SCHEDULE");
  expect(scheduleTab?.textContent).toContain("Future");
  expect(workspace.querySelector('[data-scope-filter]')).not.toBeNull();
  expect(workspace.querySelector('[data-scope-filter] option[value="add-client"]')?.textContent).toContain("Add client");

  // Every visible folder begins with its content or functional controls, never
  // the former small-caps kicker plus large headline block.
  for (const tabName of ["today", "week", "schedule", "inbox", "project", "someday", "reference", "done"]) {
    workspace.querySelector<HTMLElement>(`[data-tab="${tabName}"]`)?.click();
    expect(workspace.querySelector("main .section-head")).toBeNull();
    expect(workspace.querySelector("main > h2")).toBeNull();
  }

  // The retired Next route still retains its functional controls: filtering
  // changes the rendered set, and Show done survives its change-driven render.
  const internalWorkspace = workspace as any;
  internalWorkspace.tab = "action";
  internalWorkspace.render();
  const priorityFilter = workspace.querySelector<HTMLSelectElement>("[data-priority-filter]");
  expect(priorityFilter).not.toBeNull();
  if (priorityFilter) {
    priorityFilter.value = "B";
    priorityFilter.dispatchEvent(new window.Event("change"));
  }
  expect(workspace.textContent).toContain("B-item");
  expect(workspace.textContent).not.toContain("A-item");
  expect(workspace.textContent).not.toContain("plain-item");
  const showDone = workspace.querySelector<HTMLInputElement>("[data-show-done]");
  expect(showDone).not.toBeNull();
  if (showDone) {
    showDone.checked = true;
    showDone.dispatchEvent(new window.Event("change"));
  }
  expect(workspace.querySelector<HTMLInputElement>("[data-show-done]")?.checked).toBe(true);
  expect(workspace.querySelector("main .section-head")).toBeNull();

  workspace.querySelector<HTMLElement>('[data-tab="today"]')?.click();

  // Today is a two-lane working board: checklist/schedule on the left;
  // Inbox, unprioritized next actions, then A/B/C on the right.
  const page = workspace.innerHTML;
  expect(workspace.querySelector(".mast")).toBeNull();
  expect(page).not.toContain("Do today’s work.");
  expect(workspace.querySelector("header time")).toBeNull();
  expect(page).not.toContain("<h2>Today’s working view</h2>");
  expect(page).toContain('class="today-left"');
  expect(page).toContain('class="today-right"');
  expect(page).toContain("Daily checklist");
  expect(page).toContain("Scheduled");
  expect(page).toContain("Inbox");
  expect(page).toContain("Unprioritized next actions");
  expect(page).toContain("Priority A");
  expect(page).toContain("Priority B");
  expect(page).toContain("Priority C");

  // A URL gets its own small external link, while empty URL fields render no link.
  const itemLink = workspace.querySelector<HTMLAnchorElement>('[data-item-link][href="https://example.com/action-a"]');
  expect(itemLink).not.toBeNull();
  expect(itemLink?.target).toBe("_blank");
  expect(itemLink?.rel).toContain("noopener");
  expect(workspace.querySelectorAll("[data-item-link]").length).toBe(1);
  let editorOpens = 0;
  const editableWorkspace = workspace as any;
  const originalOpenForm = editableWorkspace.openForm.bind(editableWorkspace);
  editableWorkspace.openForm = () => { editorOpens += 1; };
  itemLink?.onclick?.(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(editorOpens).toBe(0);
  editableWorkspace.openForm = originalOpenForm;

  const calendarPos = page.indexOf("compact-calendar");
  const dailyPos = page.indexOf("Daily checklist");
  const scheduledPos = page.indexOf("<span>Scheduled</span>");
  const inboxPos = page.indexOf("<span>Inbox</span>");
  const plainPos = page.indexOf("plain-item");
  const aPos = page.indexOf("A-item");
  const bPos = page.indexOf("B-item");
  const cPos = page.indexOf("C-item");
  expect(calendarPos).toBeGreaterThan(-1);
  expect(dailyPos).toBeGreaterThan(calendarPos);
  expect(scheduledPos).toBeGreaterThan(dailyPos);
  expect(inboxPos).toBeGreaterThan(scheduledPos);
  expect(plainPos).toBeGreaterThan(inboxPos);
  expect(aPos).toBeGreaterThan(plainPos);
  expect(bPos).toBeGreaterThan(aPos);
  expect(cPos).toBeGreaterThan(bPos);

  // Inbox and A start open; unprioritized, B, and C start collapsed. Toggling
  // a section survives the render triggered by the interaction.
  expect(workspace.querySelector('[data-today-section="inbox"]')?.getAttribute("aria-expanded")).toBe("true");
  expect(workspace.querySelector('[data-today-section="A"]')?.getAttribute("aria-expanded")).toBe("true");
  expect(workspace.querySelector('[data-today-section="unprioritized"]')?.getAttribute("aria-expanded")).toBe("false");
  expect(workspace.querySelector('[data-today-section="B"]')?.getAttribute("aria-expanded")).toBe("false");
  expect(workspace.querySelector('[data-today-section="C"]')?.getAttribute("aria-expanded")).toBe("false");
  expect(workspace.querySelector<HTMLElement>("#today-section-unprioritized")?.hidden).toBe(true);
  workspace.querySelector<HTMLElement>('[data-today-section="unprioritized"]')?.click();
  expect(workspace.querySelector('[data-today-section="unprioritized"]')?.getAttribute("aria-expanded")).toBe("true");
  expect(workspace.querySelector<HTMLElement>("#today-section-unprioritized")?.hidden).toBe(false);

  expect(page).toContain("Fresh inbox capture");
  expect(page).toContain("Reached inbox zero in GTD");
  expect(page).toContain("3-day streak");
  expect(page).toContain("Morning sync");
  expect(page).toContain("Manual block");
  expect(page).toContain("Tickler today");
  expect(page).not.toContain("Upcoming · next 7 days");

  // Future keeps routines in the left lane and every tickler in a soonest-first right lane.
  workspace.querySelector<HTMLElement>('[data-tab="schedule"]')?.click();
  await waitFor(() => workspace.innerHTML.includes("schedule-board"), "Future tab never rendered its two-lane layout.");
  const schedule = workspace.innerHTML;
  expect(schedule).toContain("Daily checklist");
  expect(schedule).not.toContain("month-grid");
  expect(schedule).toContain("RECURRING");
  expect(schedule).toContain("Weekly rhythm");
  expect(schedule).toContain("Example weekly activity");
  expect(schedule).toContain('data-weekly-toggle="1"');
  expect(schedule).toContain("New weekly activity…");
  expect(schedule).toContain("Dated reminders");
  expect(schedule).toContain("soonest first");
  expect(schedule).toContain("Tickler today");
  expect(schedule).toContain("Tickler tomorrow");
  expect(schedule.indexOf("Tickler today")).toBeLessThan(schedule.indexOf("Tickler tomorrow"));
  expect(schedule).toContain('data-open="tickler"');

  // Scope is global: choosing an individual agent filters Today’s integrated next actions too.
  workspace.querySelector<HTMLElement>('[data-tab="today"]')?.click();
  const scope = workspace.querySelector<HTMLSelectElement>('[data-scope-filter]');
  expect(scope?.querySelector('option[value="agent:minavobot"]')).not.toBeNull();
  if (scope) {
    scope.value = "agent:minavobot";
    scope.dispatchEvent(new window.Event("change"));
  }
  expect(workspace.textContent).toContain("B-item");
  expect(workspace.textContent).not.toContain("A-item");
  expect(workspace.textContent).not.toContain("C-item");
  expect((workspace as any).matchesScopeText("minavobotany")).toBe(false);
  expect((workspace as any).matchesScopeText("Waiting: minavobot — review")).toBe(true);

  // Ticklers can be added from a scoped Future view and inherit that scope in
  // the editable notes field, keeping the new item visible after it is saved.
  workspace.querySelector<HTMLElement>('[data-tab="schedule"]')?.click();
  const scopedAddTickler = workspace.querySelector<HTMLElement>('[data-open="tickler"]');
  expect(scopedAddTickler).not.toBeNull();
  scopedAddTickler?.click();
  expect(workspace.querySelector<HTMLTextAreaElement>('dialog textarea[name="notes"]')?.value).toBe("minavobot");
  workspace.querySelector<HTMLElement>('dialog [data-close]')?.click();

  // Client creation remains available from the scope menu itself.
  const refreshedScope = workspace.querySelector<HTMLSelectElement>('[data-scope-filter]');
  if (refreshedScope) {
    refreshedScope.value = "add-client";
    refreshedScope.dispatchEvent(new window.Event("change"));
  }
  expect(workspace.querySelector("dialog")?.textContent).toContain("Add client");
  workspace.querySelector<HTMLElement>('dialog [data-close]')?.click();
  workspace.remove();

  fetchMode = "populated";
});

test("Week calendar sources can be hidden persistently without changing intent write access", async () => {
  fetchMode = "daily";
  actionCalls.length = 0;
  dailyFixture.calendar_visibility = { primary: true, intent: true, tangentcode: true };
  const workspace = mountWorkspace();
  await waitFor(() => workspace.textContent?.includes(`${dailyFixture.row_count} items loaded`) === true, "Week fixture never loaded.");
  workspace.querySelector<HTMLElement>('[data-tab="week"]')?.click();
  await waitFor(() => workspace.textContent?.includes("Tangentcode planning") === true, "The Tangentcode event never appeared in Week.");

  expect(workspace.textContent).toContain("Morning sync");
  expect(workspace.textContent).toContain("Write launch outline");
  expect(workspace.textContent).toContain("Tangentcode planning");
  expect(workspace.querySelector('[aria-label^="Primary, read-only: Morning sync"]')).not.toBeNull();
  expect(workspace.querySelector('[aria-label^="Tangentcode, read-only: Tangentcode planning"]')).not.toBeNull();
  expect(workspace.querySelector('[data-intent-edit="4"]')).not.toBeNull();
  expect(workspace.querySelector('[data-intent-edit="5"]')).toBeNull();

  workspace.querySelector<HTMLButtonElement>("[data-calendar-config]")?.click();
  const tangentcodeToggle = workspace.querySelector<HTMLInputElement>('[data-calendar-visibility="tangentcode"]');
  expect(tangentcodeToggle?.checked).toBe(true);
  if (tangentcodeToggle) {
    tangentcodeToggle.checked = false;
    tangentcodeToggle.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  await waitFor(
    () => actionCalls.some(call => call.action === "setCalendarVisibility" && call.args?.calendar === "tangentcode" && call.args?.visible === false),
    "Hiding Tangentcode never reached the server action.",
  );
  expect(workspace.textContent).not.toContain("Tangentcode planning");

  workspace.remove();
  const reloaded = mountWorkspace();
  await waitFor(() => reloaded.textContent?.includes(`${dailyFixture.row_count} items loaded`) === true, "Reloaded Week fixture never loaded.");
  reloaded.querySelector<HTMLElement>('[data-tab="week"]')?.click();
  await waitFor(() => reloaded.querySelector("[data-calendar-config]") !== null, "Reloaded Week toolbar never appeared.");
  expect(reloaded.textContent).not.toContain("Tangentcode planning");
  reloaded.querySelector<HTMLButtonElement>("[data-calendar-config]")?.click();
  const persistedToggle = reloaded.querySelector<HTMLInputElement>('[data-calendar-visibility="tangentcode"]');
  expect(persistedToggle?.checked).toBe(false);
  if (persistedToggle) {
    persistedToggle.checked = true;
    persistedToggle.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  await waitFor(() => reloaded.textContent?.includes("Tangentcode planning") === true, "Re-enabled Tangentcode events did not return.");

  reloaded.querySelector<HTMLButtonElement>('[data-intent-edit="4"]')?.click();
  const editForm = reloaded.querySelector<HTMLFormElement>("[data-intent-form]");
  expect(editForm?.dataset.intentId).toBe("4");
  expect(editForm?.querySelector('[type="submit"]')?.textContent).toContain("Update");
  expect(editForm?.querySelector('[data-intent-delete="4"]')).not.toBeNull();
  expect(reloaded.querySelector('[aria-label^="Tangentcode, read-only:"] [data-intent-delete]')).toBeNull();

  reloaded.remove();
  dailyFixture.calendar_visibility = { primary: true, intent: true, tangentcode: true };
  fetchMode = "populated";
}, 15_000);

test("diagnostics: failed posts queue locally and flush later; retries are bounded", async () => {
  fetchMode = "diag";
  diagnosticsShouldFail = true;
  actionCalls.length = 0;
  window.localStorage.clear();
  const workspace = mountWorkspace() as any;
  await waitFor(() => workspace.textContent?.includes("Release") === true, "workspace never mounted");

  // 1. A diagnostic whose POST fails must land in the localStorage outbox.
  workspace.queueDiagnostic("watchdog-fired", { generation: 1 });
  await waitFor(() => {
    try {
      const raw = window.localStorage.getItem("gtd:diagnostic-outbox");
      return raw !== null && JSON.parse(raw).length === 1;
    } catch { return false; }
  }, "failed diagnostic never reached the local outbox");
  const outbox = JSON.parse(window.localStorage.getItem("gtd:diagnostic-outbox")!);
  expect(outbox[0].kind).toBe("watchdog-fired");
  expect(outbox[0].client_release).toBe(RELEASE);

  // 2. Once posts succeed, flushing drains the outbox and the server receives the queued entry.
  diagnosticsShouldFail = false;
  const diagnosticCallsBefore = actionCalls.filter(c => c.action === "reportClientDiagnostic").length;
  await workspace.flushDiagnosticOutbox();
  await waitFor(() => window.localStorage.getItem("gtd:diagnostic-outbox") === "[]", "outbox did not drain after successful flush");
  const flushed = actionCalls.filter(c => c.action === "reportClientDiagnostic").slice(diagnosticCallsBefore);
  expect(flushed.length).toBe(1);
  expect(flushed[0]?.args?.kind).toBe("watchdog-fired");

  // 3. Automatic retries are bounded: past the limit the app gives up with a diagnostic.
  const queued: string[] = [];
  const realQueueDiagnostic = workspace.queueDiagnostic.bind(workspace);
  workspace.queueDiagnostic = (kind: string, detail?: unknown) => { queued.push(kind); return realQueueDiagnostic(kind, detail); };
  for (let i = 0; i < 6; i++) workspace.scheduleLoadRetry("test reason");
  expect(workspace.loadAttemptCount).toBe(6);
  expect(queued).toContain("load-gave-up");
  expect(String(workspace.error)).toContain("several tries");

  // 4. A malformed outbox entry (missing fields) is dropped, not wedged at the head.
  window.localStorage.setItem("gtd:diagnostic-outbox", JSON.stringify([{ kind: "bogus", at: "2026-09-17T00:00:00.000Z" }]));
  await workspace.flushDiagnosticOutbox();
  expect(window.localStorage.getItem("gtd:diagnostic-outbox")).toBe("[]");
  expect(workspace.querySelector("[data-event-log-content]")?.textContent ?? "").toContain("dropped invalid entries");

  // 5. A 400-rejected entry is dropped and the queue keeps draining afterward.
  const validEntry = { kind: "load-timeout", detail: "{}", client_release: RELEASE, at: "2026-09-17T00:00:01.000Z" };
  window.localStorage.setItem("gtd:diagnostic-outbox", JSON.stringify([validEntry]));
  diagnosticRejectStatus = 400;
  await workspace.flushDiagnosticOutbox();
  expect(window.localStorage.getItem("gtd:diagnostic-outbox")).toBe("[]");
  expect(workspace.querySelector("[data-event-log-content]")?.textContent ?? "").toContain("dropping malformed diagnostic from outbox");
  // The queue is not wedged: a later diagnostic posts normally.
  workspace.queueDiagnostic("watchdog-fired", { generation: 9 });
  await waitFor(() => actionCalls.some(c => c.action === "reportClientDiagnostic" && (c.args as any)?.kind === "watchdog-fired"),
    "diagnostic posting stayed wedged after a 400 drop");

  workspace.remove(); // disconnectedCallback clears the pending retry timer
  await window.happyDOM.abort();
  await window.happyDOM.close();
});
