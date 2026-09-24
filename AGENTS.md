# Building this web artifact

This directory is a web artifact — a TypeScript space: a React client in
`client/`, server actions in `server/src/actions.ts`, the schema in
`server/src/schema.ts`, and Drizzle SQL migrations in `drizzle/` (see
`space.json` for its runtime and slug).

Build, audit, and ship it only through the web-artifact builder interface your
session provides — the exact plan → build → audit → submit flow, how to edit or
inspect an existing artifact, and the schema/migration commands are all in your
builder instructions and the artifacts skill, which stay current if that
interface ever changes. Do not hand-edit the
built bundle under `.space-build/`, and do not `bun run build`: neither
publishes the artifact.

If you are not the builder subagent (for example, the main assistant landed
here), do not build from this directory. List the existing artifacts and
request a change by describing the edit — that spawns a builder to do the
work.

## This artifact's data

This artifact's data lives in `app.db`, managed by the app: read it with the
artifact inspect data operations and change it through the app's own actions
(`artifact.invoke_action`) or an artifact edit, never by running sqlite or
scripts against the file.

## Lessons

### 2026-09-17: never keep render state in a generic `data` field (release 2026.09.17.7)
Release .17.6 validated a 221-row workspace response and then committed it as
`row_count: 0` — the desktop log showed "workspace response selected" with
`state_row_count: 221` followed immediately by "workspace state updated" with
`row_count: 0`, so nothing rendered. The workspace had been assigned to the
generic `data` field on the custom element, which did not survive the
custom-element boundary intact. The fix commits the loaded collections through
a dedicated `workspaceState` field and recounts all eight collections
immediately after the commit; an empty or mismatched recount is never logged
as a successful commit. Rule: render-critical state lives in a dedicated,
explicitly-named field, and every commit is followed by an immediate recount
that must match before the commit is reported as successful.

### 2026-09-17: the mounted test fixture tracks CURRENT_RELEASE (release 2026.09.17.8)
The mounted suite's `RELEASE` constant and its mock workspace fixtures must
match `CURRENT_RELEASE` exactly: the client asserts the server echoed the
release it submitted (`workspace.client_release !== CURRENT_RELEASE` throws),
so bumping the version without updating the test fixture turns the whole
suite red with "workspace response did not echo the submitted release". Rule:
every release bump updates the test fixture's `RELEASE` in the same commit.
(Related: when prepending a new `RELEASE_NOTES` entry that uses
`version: CURRENT_RELEASE`, pin the previous top entry to its literal version
string, or the version log shows two entries under the new number.)

### 2026-09-17: client and server CURRENT_RELEASE move in lockstep (release 2026.09.17.9)
The client (`client/src/GtdWorkspace.ts`) and the server
(`server/src/actions.ts`) each have their own `CURRENT_RELEASE`, and the
health check only passes when a render measurement's `serverRelease` AND
`clientRelease` both equal the SERVER's constant. The .17.8 deploy shipped a
stale server constant (2026.09.17.6): every health report failed permanently,
and every client saw a bogus "newer GTD release (2026.09.17.6) is available"
notice because `server_release !==` the client release. Rule: every release
bumps BOTH constants to the same new version in the same commit — grep for
`CURRENT_RELEASE` across `client/src` and `server/src` before shipping, and
treat any mismatch as a red build.
