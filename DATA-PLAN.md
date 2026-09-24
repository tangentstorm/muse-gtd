# GTD data plan

## Sources

- The artifact's own SQLite database remains the durable source for GTD lists, checklist results, and the bounded calendar cache.
- Google Calendar is the source for the Week view. The application uses three neutral calendar keys: `primary`, `intent`, and `tangentcode`.
- The real Google Calendar identifiers live only in git-ignored `server/src/local-config.ts`. `server/src/local-config.example.ts` documents the required keys with placeholders. The build checks for the real file first, and server startup validates that every key is configured.
- No public-web sources are used.

## Calendar read path

Opening a week invokes the privileged Google Workspace CLI from the server. Each read is bounded to the visible Monday–Sunday range plus one day on either side. The three configured calendars are fetched separately, normalized to neutral keys, and cached in `calendar_events`; rows outside the requested window are preserved. Google event identifiers remain server-side and are never returned to the client.

Existing cached rows are also normalized to neutral keys before any response reaches the client. If Google Calendar is disconnected or temporarily unavailable, the Week grid stays usable and displays cached rows for the requested range with a clear availability message. The global GTD Scope control never filters calendar events.

## Intent write path

The Week UI creates, edits, and deletes events only on the calendar represented by the `intent` key. The client sends an internal cached-row ID for edits and deletes; the server checks that row resolves to `intent` before using its server-side Google event identifier. Create and update operations send explicit RFC3339 date-times with Eastern time offsets, `transparency: "transparent"`, and `reminders: { "useDefault": true }`. The primary and tangentcode calendars remain read-only.

Successful writes update the local cache with the neutral `intent` key. Failed writes return user-safe messages to the inline editor.
