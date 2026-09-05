# Chalk

<p align="center">
<a href="https://dash.yard.sh/projects?action=create&repo=https%3A%2F%2Fgithub.com%2Fyard-sh%2Fyard-chalk"><img src="https://yard.sh/create-in-yard.png" width="200" alt="Create in Yard" /></a>
</p>

A shared whiteboard hosted end to end on Yard: sticky notes, shapes, a pen,
and everyone's cursor on the same board at the same time. A static frontend,
a fetch-handler backend, one realtime object per board, a per-project SQLite
database, and buyer sign-in. Free for three boards; Pro is a subscription.

- Product page: https://tatelax.yard.sh/chalk
- App: https://tatelax.yard.sh/chalk/app/

Use the link above, or paste this repository's URL into the Create from GitHub
URL field of the Yard dashboard's Create Project dialog. Chalk declares
objects (realtime rooms inside a service), which are part of Yard Pro, so
creating it needs a Pro plan.

## Layout

    .yard/
      settings.json       every project setting: service, objects, landing page, pricing
      migrations/         applied in filename order at deploy, and by yard dev
      dev/                local state written by yard dev; ignored by git
    app/                  the deployable bundle (the services[] entry with dir: app)
      _service.js         the entire backend: the fetch handler and the Board object
      index.html          app shell
      app.js              boot, board list, sharing, account, undo, plan cards
      live.js             the socket client: reconnect, queue, cursor throttle
      board.js            the canvas: viewport, tools, rendering, cursors, ink
      styles.css          design tokens, light + dark
    landing-page/         the marketing page, with a live demo and pricing built from the tiers

The service entry declares its mount path, access mode, database access, and
the object class it exports:

    "services": [
      { "dir": "app", "name": "app", "url": "/app",
        "access": "authenticated", "database_access": true,
        "objects": [{ "class": "Board", "binding": "BOARDS" }] }
    ]

`yard push` sends that file along with the bundles, so changing how the
service deploys is an edit there followed by a push.

The marketing page is declared on the same file:

    "landing_page": { "type": "custom", "dir": "landing-page" }

`"type": "custom"` is what serves the files in that directory. Set it to
`"builtin"` and the project shows the pre-built page you edit in the
dashboard instead; the files still upload, they are just not served.

## How it fits together

**One board is one object.** `_service.js` exports a class called `Board`.
Yard keeps one instance of it per board name, reachable through
`env.BOARDS`, and every connection to that board lands on the same instance.
The instance holds the open sockets and the board's shapes, in its own SQL
storage, so it is the single place where edits happen in order.

**The handler decides who gets in.** `GET api/boards/:id/ws` checks
membership in the database, looks up the board owner's plan and the
visitor's display name, stamps them on the upgrade request as `X-Chalk-*`
headers, and forwards it:

    return env.BOARDS.get(env.BOARDS.idFromName(board.id)).fetch(request);

That is the whole realtime route. The object trusts `X-Chalk-*` the way it
trusts `X-Yard-*`: clients cannot reach the object directly, and the handler
strips anything a client sent under that prefix first.

**The object is the order.** Every edit (`put`, `del`) is stored, stamped
with a sequence number, and echoed to everyone, the sender included. Clients
apply their own edits optimistically and then apply the echoes in sequence,
ignoring echoes only for the shape they are dragging at that moment, so two
people moving the same note end up seeing the same thing. Cursors and
in-progress pen strokes (`cursor`, `ink`) are relayed to the others and never
stored.

**One database write per burst.** The object never touches `env.DB` while
handling a message. Edits mark it dirty and arm an alarm; five seconds later
the alarm writes `shape_count` and `updated_at` to the `boards` row, which is
what the board list shows. Everything else about a board (owner, members,
link sharing) lives in the database; the shapes never leave the object.

**Whose plan counts.** A service only ever sees the visitor's `X-Yard-Tier`,
so a board cannot ask the edge about its owner. `GET api/me` snapshots the
visitor's plan into `users.plan` on every visit, and the handler reads the
owner's snapshot when someone connects. Board limits (boards owned, people
at once, shapes) follow the owner; export follows the person exporting.
`owner` and `trial` entitlements count as Pro.

**Sign in first, then connect.** The service is `authenticated`, and the
edge answers an anonymous upgrade with a redirect a browser socket cannot
follow. The app loads as a page, which is where sign-in happens, and only
opens the socket after `api/me` succeeds.

Two details worth knowing before editing:

- **Relative URLs only.** The app is mounted at `/chalk/app/`, so
  `fetch("api/boards")`, never `/api/boards`, and the socket URL is built
  from `location.href`. Board selection lives in `location.hash` for the same
  reason. `yard service check` lints fetches and links, not socket URLs.
- **The class name is the identity.** Renaming `Board` in `settings.json`
  deletes every board and its shapes on the next deploy; `yard push` warns
  before it does. Change the `binding` if only the name in `env` should
  change.

## Free and Pro

| | Free | Pro |
| --- | --- | --- |
| Boards you own | 3 | unlimited |
| People on a board at once | 5 | 50 |
| Shapes per board | 500 | 5,000 |
| Export a board as SVG | no | yes |

Pro is $6 a month, 20% less paid yearly, with a 14-day trial that needs no
card. The landing page builds both columns from `window.yard.project.tiers`
at runtime, so it never carries a tier id; the app's plan cards link back to
it. After a purchase the edge may report the old plan for up to a minute, so
the app re-reads `api/me` whenever the window regains focus.

## Local development

    yard dev

serves the landing page at `http://localhost:9875/chalk/` and the app at
`http://localhost:9875/chalk/app/`, with the migration applied to a local
database and the boards' objects stored under `.yard/dev/objects/app/`. The
`authenticated` gate sends you to a persona picker instead of real sign-in;
pick one up front with `yard dev --as signed-in` (Free), `--as user:pro`,
`--as trial`, or `--as member` (the project owner).

To see the realtime part, open the same board in two browser windows (a
private window gets its own persona), draw in one, and watch the other.

Every save restarts the local runtime, which drops every open socket; the
client reconnects on its own, which is the same path it takes when a hosted
session reaches its 24-hour limit. `yard dev --reset-db` starts from an
empty database, `--reset-objects` deletes every stored board, and the two
are independent: a board row without its object shows up empty.

## Logging

The service logs one line per event. Read them back with:

    yard service logs --since 2h
    yard service logs --since 2h | grep 'shape.put'

Every line starts with `[chalk]` and is a single event, so it greps cleanly:

    [chalk] peer.join board=5b1c37d7 cid=c91853ac user=5b1c37d7 role=owner plan=pro peers=2
    [chalk] shape.put board=5b1c37d7 cid=c91853ac kind=note shapes=14
    [chalk] flush board=5b1c37d7 shapes=14 ms=3
    [chalk] request method=POST path=/api/boards/5b1c37d7/join status=200 user=05c444a7 ms=4

Handler events: `request`, `auth.rejected`, `me.update`, `me.rename`,
`board.seed|create|join|rename|share|delete|leave`, `board.join.rejected`,
`boards.limit`, `export`, `export.denied`, `ws.forward`, `ws.rejected`.
Object events: `board.wake`, `peer.join|leave|error|rename`, `board.full`,
`shape.put|del|rejected`, `flush`, `board.deleted`. Failures go to
`console.error` as `request.failed` and `internal.failed`.

**Not logged:** shape text, board names, display names, emails. Lengths are
logged instead, and ids are cut to 8 characters everywhere, including inside
request paths.

`ms=` is a rough floor, not a latency measurement: the hosted runtime only
advances the clock at I/O boundaries.

## Usage and cost

Objects are metered: requests, compute time while a message is being
handled, and stored bytes, with a monthly allowance on Pro and overage past
it. An inbound socket message counts as one twentieth of a request, and a
board that is holding sockets but doing nothing costs no compute. Two habits
in the client follow from that: cursor positions are sent at most once every
50 ms, and pen strokes go out in batches while drawing and as one stored
shape at pen-up. The Usage page in the dashboard shows the month so far.

## Shipping

    yard service check                        validate bundle + lint, no network
    yard status                               what a push would change
    yard push                                 upload service, page, and settings into the draft
    yard releases publish <tag>               publish the draft, which makes it live
    yard service open                         print/open the live app URL
    yard db query "select name, shape_count from boards"
    yard service logs --since 2h

Nothing serves a draft release, so pushing is safe to repeat as often as you
like; the app only changes for users at `yard releases publish`.
Migrations apply themselves at deploy; you never run them by hand.

The project follows the `Production` channel and starts with no sandboxes. To
publish somewhere users can't see, create one, hold the storefront where
it is, and ship when it looks right:

    yard sandbox create preview
    yard sandbox pin                            hold the project on what it serves
    yard releases publish <tag>
    yard sandbox pin <tag> --sandbox preview
    yard service open --sandbox preview         team-only URL
    yard sandbox unpin                          go live

Data never moves between the project and its sandboxes: a sandbox has its
own database and its own boards.

## Data lifecycle

- Deleting a board removes its rows and tells the object to drop its storage.
- Removing the `Board` class from `settings.json` deletes every board's
  shapes at the next deploy. `yard push` prints a warning first.
- Removing the whole service keeps the boards for 30 days, in case the
  service comes back under the same name.
