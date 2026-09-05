// Chalk backend.
//
// No ports, no listen(): Yard runs this as a fetch handler. Requests arrive
// with the app path rooted at "/" and, for signed-in visitors, trusted
// identity headers the edge verified:
//   X-Yard-User-Id, X-Yard-Email, X-Yard-Entitlement, X-Yard-Tier, X-Yard-Sandbox
// Clients can never spoof these: the edge strips inbound X-Yard-* first, and
// `yard dev` stamps the same headers locally from the persona you pick.
//
// Two things live in this file. The default export is the fetch handler: the
// board list, membership, sharing, export, and the one route that hands a
// WebSocket to a board. The Board class is an object: one instance per board,
// declared under "objects" in .yard/settings.json and reached through
// env.BOARDS. It holds every open connection to that board and the board's
// shapes, so it is the single place where edits are ordered.

const PRO_TIER = "Pro";

// Board limits follow the board owner's plan. Export follows the exporter's.
const LIMITS = {
  free: { boards: 3, live: 5, shapes: 500 },
  pro: { boards: Infinity, live: 50, shapes: 5000 },
};

const PALETTE = ["yellow", "pink", "blue", "green", "orange", "purple", "grey", "ink"];
const PEER_COLORS = 8;

const MAX_NAME = 40;
const MAX_BOARD_NAME = 80;
const MAX_TEXT = 2000;
const MAX_POINTS = 2000;
const MAX_PROPS_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_DEL = 200;
const FLUSH_MS = 5000;

const KINDS = new Set(["note", "rect", "ellipse", "line", "pen", "text"]);
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Never serve the backend as an asset. Yard excludes it server-side; this
    // guard keeps any other host honest.
    if (url.pathname === "/_service.js") {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname.startsWith("/api/")) {
      const started = Date.now();
      try {
        const response = await handleAPI(request, env, url);
        log("request", {
          method: request.method,
          path: redactPath(url.pathname),
          status: response.status,
          user: shortId(request.headers.get("X-Yard-User-Id")),
          ms: Date.now() - started,
        });
        return response;
      } catch (err) {
        console.error(
          `[chalk] request.failed ${request.method} ${redactPath(url.pathname)}`,
          err && err.stack,
        );
        return json({ error: "something went wrong on our end" }, 500);
      }
    }

    // Everything else: the static frontend (env.ASSETS is this directory).
    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------------------------------------------- api */

async function handleAPI(request, env, url) {
  // The access gate normally guarantees the header; this is the backstop.
  const user = request.headers.get("X-Yard-User-Id");
  const method = request.method;
  if (!user) {
    log("auth.rejected", { method, path: url.pathname });
    return json({ error: "sign in to use Chalk" }, 401);
  }

  // ["api", "boards", "<id>", "ws"]: the leading "api" is dropped.
  const [, ...seg] = url.pathname.split("/").filter(Boolean);

  if (seg[0] === "me" && seg.length === 1) {
    if (method === "GET") return getMe(request, env, user);
    if (method === "PATCH") return renameMe(request, env, user);
    return methodNotAllowed();
  }

  if (seg[0] === "boards" && seg.length === 1) {
    if (method === "GET") return listBoards(request, env, user);
    if (method === "POST") return createBoard(request, env, user);
    return methodNotAllowed();
  }

  if (seg[0] === "boards" && seg.length >= 2) {
    const access = await boardAccess(env, user, seg[1]);
    if (!access) return json({ error: "board not found" }, 404);

    if (seg.length === 2) {
      if (method === "PATCH") return updateBoard(request, env, access);
      if (method === "DELETE") return deleteBoard(env, access);
      return methodNotAllowed();
    }
    if (seg.length === 3) {
      const action = seg[2];
      if (action === "join" && method === "POST") return joinBoard(env, user, access);
      if (action === "leave" && method === "POST") return leaveBoard(env, user, access);
      if (action === "export.svg" && method === "GET") return exportBoard(request, env, access);
      if (action === "ws" && method === "GET") return connectBoard(request, env, user, access);
    }
    return json({ error: "not found" }, 404);
  }

  return json({ error: "not found" }, 404);
}

/* -------------------------------------------------------------- identity */

// pro for the project owner, a trial, or a Pro purchase. X-Yard-Tier is the
// purchased tier's name and is absent on Free, so a missing header is Free.
function planOf(headers) {
  const entitlement = headers.get("X-Yard-Entitlement") || "none";
  if (entitlement === "owner" || entitlement === "trial") return "pro";
  return headers.get("X-Yard-Tier") === PRO_TIER ? "pro" : "free";
}

// There is no display-name header, so the first visit derives one from the
// email and the app lets people change it. The plan is re-snapshotted on
// every visit: that snapshot is what a board reads for its owner's limits.
async function ensureUser(env, headers, user) {
  const email = headers.get("X-Yard-Email") || "";
  const plan = planOf(headers);
  await env.DB.prepare(
    "INSERT INTO users (id, name, email, plan, seen_at) VALUES (?1, ?2, ?3, ?4, datetime('now'))" +
      " ON CONFLICT(id) DO UPDATE SET email = excluded.email, plan = excluded.plan, seen_at = excluded.seen_at",
  )
    .bind(user, defaultName(user, email), email, plan)
    .run();
  const row = await env.DB.prepare("SELECT name FROM users WHERE id = ?1").bind(user).first();
  return {
    user_id: user,
    name: row ? row.name : defaultName(user, email),
    email,
    plan,
    entitlement: headers.get("X-Yard-Entitlement") || "none",
    tier: headers.get("X-Yard-Tier") || "",
  };
}

function defaultName(user, email) {
  const local = (email.split("@")[0] || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, MAX_NAME);
  return local || "user-" + shortId(user);
}

async function getMe(request, env, user) {
  const me = await ensureUser(env, request.headers, user);
  log("me.update", { user: shortId(user), plan: me.plan, entitlement: me.entitlement });
  return json(me);
}

async function renameMe(request, env, user) {
  const { name } = await readJSON(request);
  const clean = text(name, MAX_NAME);
  if (!clean) return json({ error: "pick a name" }, 400);
  const me = await ensureUser(env, request.headers, user);
  await env.DB.prepare("UPDATE users SET name = ?1 WHERE id = ?2").bind(clean, user).run();
  log("me.rename", { user: shortId(user), nameLen: clean.length });
  return json({ ...me, name: clean });
}

/* ---------------------------------------------------------------- boards */

const BOARD_COLUMNS =
  "b.id, b.owner_id, b.name, b.link_access, b.shape_count, b.created_at, b.updated_at";

async function listBoards(request, env, user) {
  let boards = await allBoards(env, user);
  if (boards.length === 0) {
    await seedBoard(request, env, user);
    boards = await allBoards(env, user);
  }
  return json(boards);
}

async function allBoards(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT ${BOARD_COLUMNS}, CASE WHEN b.owner_id = ?1 THEN 'owner' ELSE 'editor' END AS role` +
      " FROM boards b" +
      " WHERE b.owner_id = ?1 OR b.id IN (SELECT board_id FROM board_members WHERE user_id = ?1)" +
      " ORDER BY b.updated_at DESC, b.created_at DESC",
  )
    .bind(user)
    .all();
  return (results || []).map((row) => boardMeta(row, row.role));
}

// First visit: a board with two notes, so nobody lands on an empty canvas.
// The row goes to the database; the notes go to the board's object.
async function seedBoard(request, env, user) {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO boards (id, owner_id, name) VALUES (?1, ?2, ?3)")
    .bind(id, user, "My first board")
    .run();
  const shapes = [
    note("seed-welcome", 120, 120, "yellow", "Welcome to your first board. Drag this note around: everyone here sees it move."),
    note("seed-share", 400, 180, "pink", "Share the board from the top bar. Anyone with the link can draw with you."),
  ];
  const res = await internal(env, id, "POST", "/__seed", { shapes, plan: planOf(request.headers) });
  log("board.seed", { user: shortId(user), board: shortId(id), notes: shapes.length, ok: res.ok });
  return id;
}

function note(id, x, y, color, body) {
  return { id, kind: "note", x, y, w: 220, h: 220, z: 1, props: { text: body, color } };
}

async function createBoard(request, env, user) {
  const { name } = await readJSON(request);
  const clean = text(name, MAX_BOARD_NAME);
  if (!clean) return json({ error: "name your board" }, 400);

  const plan = planOf(request.headers);
  const owned = await env.DB.prepare("SELECT COUNT(*) AS n FROM boards WHERE owner_id = ?1")
    .bind(user)
    .first();
  if (owned.n >= LIMITS[plan].boards) {
    log("boards.limit", { user: shortId(user), plan, owned: owned.n });
    return json(
      { error: `Free holds ${LIMITS.free.boards} boards. Pro has no limit.`, code: "boards_limit", limit: LIMITS[plan].boards },
      400,
    );
  }

  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO boards (id, owner_id, name) VALUES (?1, ?2, ?3)")
    .bind(id, user, clean)
    .run();
  log("board.create", { user: shortId(user), board: shortId(id), plan, nameLen: clean.length, boardsNow: owned.n + 1 });
  const row = await env.DB.prepare(`SELECT ${BOARD_COLUMNS} FROM boards b WHERE b.id = ?1`).bind(id).first();
  return json(boardMeta(row, "owner"), 201);
}

// Every board route starts here. role is "" for a signed-in visitor who is
// neither the owner nor a member, which only join (via the link) may change.
async function boardAccess(env, user, boardId) {
  const row = await env.DB.prepare(
    `SELECT ${BOARD_COLUMNS},` +
      " CASE WHEN b.owner_id = ?2 THEN 'owner' WHEN m.user_id IS NOT NULL THEN 'editor' ELSE '' END AS role" +
      " FROM boards b LEFT JOIN board_members m ON m.board_id = b.id AND m.user_id = ?2" +
      " WHERE b.id = ?1",
  )
    .bind(boardId, user)
    .first();
  return row ? { board: row, role: row.role } : null;
}

async function joinBoard(env, user, access) {
  const { board } = access;
  let role = access.role;
  if (!role) {
    if (!board.link_access) {
      log("board.join.rejected", { user: shortId(user), board: shortId(board.id), reason: "not-shared" });
      return json({ error: "this board is not shared", code: "not_shared" }, 403);
    }
    await env.DB.prepare("INSERT OR IGNORE INTO board_members (board_id, user_id) VALUES (?1, ?2)")
      .bind(board.id, user)
      .run();
    role = "editor";
    log("board.join", { user: shortId(user), board: shortId(board.id) });
  }
  return json(boardMeta(board, role));
}

async function updateBoard(request, env, access) {
  const { board, role } = access;
  if (role !== "owner") return ownerOnly();
  const patch = await readJSON(request);

  let name = board.name;
  if (patch.name !== undefined) {
    name = text(patch.name, MAX_BOARD_NAME);
    if (!name) return json({ error: "name your board" }, 400);
  }
  const link = patch.link_access === undefined ? !!board.link_access : !!patch.link_access;

  await env.DB.prepare("UPDATE boards SET name = ?1, link_access = ?2 WHERE id = ?3")
    .bind(name, link ? 1 : 0, board.id)
    .run();
  // Whoever is on the board right now hears about it through the object.
  await internal(env, board.id, "POST", "/__board", { name, link_access: link });

  if (patch.name !== undefined) log("board.rename", { board: shortId(board.id), nameLen: name.length });
  if (patch.link_access !== undefined) log("board.share", { board: shortId(board.id), link });
  return json(boardMeta({ ...board, name, link_access: link ? 1 : 0 }, role));
}

async function deleteBoard(env, access) {
  const { board, role } = access;
  if (role !== "owner") return ownerOnly();
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM board_members WHERE board_id = ?1").bind(board.id),
    env.DB.prepare("DELETE FROM boards WHERE id = ?1").bind(board.id),
  ]);
  // The object closes every connection and drops its storage. If this call
  // fails the row is already gone, so the orphaned shapes are unreachable.
  const res = await internal(env, board.id, "POST", "/__delete");
  log("board.delete", { board: shortId(board.id), membersRemoved: changed(results[0]), objectCleared: res.ok });
  return json({ ok: true });
}

async function leaveBoard(env, user, access) {
  const { board, role } = access;
  if (role === "owner") return json({ error: "owners delete boards instead of leaving them" }, 400);
  if (!role) return json({ error: "you are not on this board" }, 400);
  await env.DB.prepare("DELETE FROM board_members WHERE board_id = ?1 AND user_id = ?2")
    .bind(board.id, user)
    .run();
  log("board.leave", { user: shortId(user), board: shortId(board.id) });
  return json({ ok: true });
}

async function exportBoard(request, env, access) {
  const { board, role } = access;
  if (!role) return json({ error: "this board is not shared", code: "not_shared" }, 403);
  const plan = planOf(request.headers);
  if (plan !== "pro") {
    log("export.denied", { board: shortId(board.id), plan });
    return json({ error: "Export is part of Pro.", code: "pro_required" }, 403);
  }
  const res = await internal(env, board.id, "GET", "/__shapes");
  const shapes = res.ok ? await res.json() : [];
  const svg = shapesToSVG(shapes);
  log("export", { board: shortId(board.id), shapes: shapes.length, bytes: svg.length });
  const filename = (board.name.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "board") + ".svg";
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

// The realtime route. The handler's whole job is to decide whether this
// person may enter, look up what the board needs to know, and forward the
// upgrade to the board's object. The X-Chalk-* headers are set here, after
// stripping anything a client sent, so the object can trust them the way it
// trusts X-Yard-*.
async function connectBoard(request, env, user, access) {
  const { board, role } = access;
  if (!role) {
    log("ws.rejected", { user: shortId(user), board: shortId(board.id), reason: "not-shared" });
    return json({ error: "this board is not shared", code: "not_shared" }, 403);
  }
  if (request.headers.get("Upgrade") !== "websocket") {
    return json({ error: "expected a WebSocket" }, 426);
  }

  const [owner, me] = await Promise.all([
    env.DB.prepare("SELECT plan FROM users WHERE id = ?1").bind(board.owner_id).first(),
    env.DB.prepare("SELECT name FROM users WHERE id = ?1").bind(user).first(),
  ]);
  const ownerPlan = owner && owner.plan === "pro" ? "pro" : "free";
  const name = me ? me.name : defaultName(user, request.headers.get("X-Yard-Email") || "");

  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) {
    if (key.toLowerCase().startsWith("x-chalk-")) headers.delete(key);
  }
  headers.set("X-Chalk-Board", board.id);
  headers.set("X-Chalk-Board-Name", encodeURIComponent(board.name));
  headers.set("X-Chalk-Link", board.link_access ? "1" : "0");
  headers.set("X-Chalk-Plan", ownerPlan);
  headers.set("X-Chalk-Name", encodeURIComponent(name));
  headers.set("X-Chalk-Role", role);

  log("ws.forward", { user: shortId(user), board: shortId(board.id), role, ownerPlan });
  return objectFor(env, board.id).fetch(new Request(request, { headers }));
}

function objectFor(env, boardId) {
  return env.BOARDS.get(env.BOARDS.idFromName(boardId));
}

// Handler-to-object calls that are not upgrades. Clients cannot reach the
// object directly, so paths under /__ are private by construction.
async function internal(env, boardId, method, path, body) {
  try {
    return await objectFor(env, boardId).fetch("https://chalk.internal" + path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[chalk] internal.failed path=${path} board=${shortId(boardId)}`, err && err.stack);
    return new Response(null, { status: 502 });
  }
}

function boardMeta(row, role) {
  return {
    id: row.id,
    name: row.name,
    role,
    link_access: !!row.link_access,
    shape_count: row.shape_count || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function ownerOnly() {
  return json({ error: "only the board's owner can do that", code: "owner_only" }, 403);
}

/* ----------------------------------------------------------------- Board */

// One instance per board. The runtime creates it when the first request for
// that board arrives and may retire it when the board goes quiet, so
// instance fields are a cache at best: everything that matters is in
// ctx.storage (shapes, meta) or attached to a connection.
export class Board {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.meta = null;
    this.ctx.blockConcurrencyWhile(async () => {
      this.createTables();
      this.meta = (await this.ctx.storage.get("meta")) || freshMeta();
      log("board.wake", { board: shortId(this.meta.board), shapes: this.count(), live: this.ctx.getWebSockets().length });
    });
  }

  createTables() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS shapes (" +
        " id TEXT PRIMARY KEY, kind TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL," +
        " w REAL NOT NULL, h REAL NOT NULL, z INTEGER NOT NULL DEFAULT 0," +
        " props TEXT NOT NULL, updated_by TEXT NOT NULL, seq INTEGER NOT NULL)",
    );
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") return this.join(request);

    const url = new URL(request.url);
    if (url.pathname === "/__seed" && request.method === "POST") return this.seed(request);
    if (url.pathname === "/__board" && request.method === "POST") return this.updateBoard(request);
    if (url.pathname === "/__shapes" && request.method === "GET") return json(this.allShapes());
    if (url.pathname === "/__delete" && request.method === "POST") return this.destroy();
    return new Response("Not found", { status: 404 });
  }

  /* connections */

  async join(request) {
    const userId = request.headers.get("X-Yard-User-Id") || "";
    if (!userId) return new Response("sign in", { status: 401 });
    const h = request.headers;
    const boardId = h.get("X-Chalk-Board") || "";
    const plan = h.get("X-Chalk-Plan") === "pro" ? "pro" : "free";
    const role = h.get("X-Chalk-Role") === "owner" ? "owner" : "editor";
    const name = text(decodeURIComponent(h.get("X-Chalk-Name") || ""), MAX_NAME) || "Someone";

    // The handler just read the board row, so this is the freshest copy.
    this.meta.board = boardId || this.meta.board;
    this.meta.name = decodeURIComponent(h.get("X-Chalk-Board-Name") || "") || this.meta.name;
    this.meta.link = h.get("X-Chalk-Link") === "1";
    this.meta.plan = plan;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const limits = LIMITS[plan];

    const live = this.ctx.getWebSockets().length;
    if (live >= limits.live) {
      // Accept, explain, close: a refused upgrade would reach the browser as
      // a bare failure with nothing to show.
      this.ctx.acceptWebSocket(server);
      send(server, {
        t: "error",
        code: "full",
        message: `This board has ${live} people on it. ${plan === "pro" ? "Pro" : "Free"} boards hold ${limits.live}.`,
        limit: limits.live,
      });
      server.close(4001, "Board is full");
      log("board.full", { board: shortId(boardId), plan, live });
      return new Response(null, { status: 101, webSocket: client });
    }

    const peer = {
      cid: crypto.randomUUID().slice(0, 8),
      user_id: userId,
      name,
      color: this.meta.nextColor % PEER_COLORS,
      role,
    };
    this.meta.nextColor = (this.meta.nextColor + 1) % PEER_COLORS;
    await this.saveMeta();

    // The attachment is the only thing a message can be traced back to: a
    // WebSocket frame carries no headers. The tag lets a rename find every
    // connection this person has open.
    server.serializeAttachment({ ...peer, plan });
    this.ctx.acceptWebSocket(server, [userId]);

    send(server, {
      t: "snapshot",
      board: {
        id: this.meta.board,
        name: this.meta.name,
        link_access: this.meta.link,
        owner_id: role === "owner" ? userId : this.meta.owner || "",
        plan,
        limits: { live: limits.live, shapes: limits.shapes },
      },
      you: peer,
      peers: this.peers(peer.cid),
      shapes: this.allShapes(),
      seq: this.meta.seq,
    });
    if (role === "owner" && this.meta.owner !== userId) {
      this.meta.owner = userId;
      await this.saveMeta();
    }
    this.broadcast({ t: "join", peer }, server);
    log("peer.join", { board: shortId(boardId), cid: peer.cid, user: shortId(userId), role, plan, peers: live + 1 });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string") return;
    const me = attachment(ws);
    if (!me) return;
    if (raw.length > MAX_MESSAGE_BYTES) {
      send(ws, { t: "error", code: "too_big", message: "that message is too large" });
      log("shape.rejected", { board: shortId(this.meta.board), cid: me.cid, reason: "too-big", bytes: raw.length });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    switch (msg.t) {
      case "cursor": {
        // Ephemeral: relayed, never stored, never echoed to the sender.
        const x = num(msg.x);
        const y = num(msg.y);
        if (x === null || y === null) return;
        this.broadcast({ t: "cursor", cid: me.cid, x, y }, ws);
        return;
      }
      case "ink": {
        const ink = sanitizeInk(msg);
        if (!ink) return;
        this.broadcast({ t: "ink", cid: me.cid, ...ink }, ws);
        return;
      }
      case "put":
        return this.put(ws, me, msg.shape);
      case "del":
        return this.del(ws, me, msg.ids);
      case "me":
        return this.rename(me, msg.name);
      default:
        return;
    }
  }

  async webSocketClose(ws, code, reason) {
    const me = attachment(ws);
    if (me) {
      this.broadcast({ t: "leave", cid: me.cid }, ws);
      log("peer.leave", { board: shortId(this.meta.board), cid: me.cid, code, reason: reason || "-", peers: this.ctx.getWebSockets().length - 1 });
    }
    try {
      ws.close(1000, "bye");
    } catch {
      // Already closed from this side.
    }
  }

  async webSocketError(ws, err) {
    const me = attachment(ws);
    if (me) {
      this.broadcast({ t: "leave", cid: me.cid }, ws);
      log("peer.error", { board: shortId(this.meta.board), cid: me.cid, error: err && err.message });
    }
  }

  /* edits */

  async put(ws, me, raw) {
    const shape = sanitizeShape(raw);
    if (!shape) {
      send(ws, { t: "error", code: "invalid", message: "that shape could not be saved" });
      log("shape.rejected", { board: shortId(this.meta.board), cid: me.cid, reason: "invalid" });
      return;
    }
    const limits = LIMITS[me.plan] || LIMITS.free;
    const exists = this.has(shape.id);
    if (!exists && this.count() >= limits.shapes) {
      send(ws, {
        t: "error",
        code: "shapes_limit",
        message: `This board holds ${limits.shapes} shapes. ${me.plan === "pro" ? "" : "Pro boards hold " + LIMITS.pro.shapes + "."}`.trim(),
        limit: limits.shapes,
      });
      log("shape.rejected", { board: shortId(this.meta.board), cid: me.cid, reason: "shapes-limit", limit: limits.shapes });
      return;
    }

    const seq = ++this.meta.seq;
    this.ctx.storage.sql.exec(
      "INSERT INTO shapes (id, kind, x, y, w, h, z, props, updated_by, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)" +
        " ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, x = excluded.x, y = excluded.y, w = excluded.w," +
        " h = excluded.h, z = excluded.z, props = excluded.props, updated_by = excluded.updated_by, seq = excluded.seq",
      shape.id, shape.kind, shape.x, shape.y, shape.w, shape.h, shape.z,
      JSON.stringify(shape.props), me.user_id, seq,
    );
    await this.touched();
    // Echoed to everyone, the sender included: the object's order is the
    // board's order, and each client applies it the same way.
    this.broadcast({ t: "put", shape, by: me.cid, seq });
    if (!exists) log("shape.put", { board: shortId(this.meta.board), cid: me.cid, kind: shape.kind, shapes: this.count() });
  }

  async del(ws, me, rawIds) {
    if (!Array.isArray(rawIds)) return;
    const ids = [...new Set(rawIds.filter((id) => typeof id === "string" && ID_RE.test(id)))].slice(0, MAX_DEL);
    if (ids.length === 0) return;
    const seq = ++this.meta.seq;
    this.ctx.storage.sql.exec(
      `DELETE FROM shapes WHERE id IN (${ids.map(() => "?").join(", ")})`,
      ...ids,
    );
    await this.touched();
    this.broadcast({ t: "del", ids, by: me.cid, seq });
    log("shape.del", { board: shortId(this.meta.board), cid: me.cid, n: ids.length, shapes: this.count() });
  }

  rename(me, rawName) {
    const name = text(rawName, MAX_NAME);
    if (!name) return;
    for (const socket of this.ctx.getWebSockets(me.user_id)) {
      const peer = attachment(socket);
      if (!peer) continue;
      socket.serializeAttachment({ ...peer, name });
      this.broadcast({ t: "peer", cid: peer.cid, name });
    }
    log("peer.rename", { board: shortId(this.meta.board), cid: me.cid, nameLen: name.length });
  }

  // Edits mark the board dirty and arm one alarm; the alarm writes a summary
  // row to the database. One write per burst instead of one per message.
  async touched() {
    this.meta.dirty = true;
    await this.saveMeta();
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
    }
  }

  async alarm() {
    const started = Date.now();
    const shapes = this.count();
    if (this.meta.board && this.env.DB) {
      await this.env.DB.prepare(
        "UPDATE boards SET shape_count = ?1, updated_at = datetime('now') WHERE id = ?2",
      )
        .bind(shapes, this.meta.board)
        .run();
    }
    this.meta.dirty = false;
    await this.saveMeta();
    log("flush", { board: shortId(this.meta.board), shapes, ms: Date.now() - started });
  }

  /* handler-only routes */

  async seed(request) {
    const body = await readJSON(request);
    if (this.count() > 0) return json({ ok: true, seeded: 0 });
    const shapes = Array.isArray(body.shapes) ? body.shapes.map(sanitizeShape).filter(Boolean) : [];
    for (const shape of shapes) {
      const seq = ++this.meta.seq;
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO shapes (id, kind, x, y, w, h, z, props, updated_by, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        shape.id, shape.kind, shape.x, shape.y, shape.w, shape.h, shape.z,
        JSON.stringify(shape.props), "seed", seq,
      );
    }
    await this.saveMeta();
    return json({ ok: true, seeded: shapes.length });
  }

  async updateBoard(request) {
    const body = await readJSON(request);
    if (typeof body.name === "string") this.meta.name = text(body.name, MAX_BOARD_NAME) || this.meta.name;
    if (body.link_access !== undefined) this.meta.link = !!body.link_access;
    await this.saveMeta();
    this.broadcast({ t: "board", name: this.meta.name, link_access: this.meta.link });
    return json({ ok: true });
  }

  async destroy() {
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) {
      try {
        socket.close(4002, "Board deleted");
      } catch {
        // Already gone.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.createTables();
    log("board.deleted", { board: shortId(this.meta.board), closed: sockets.length });
    this.meta = freshMeta();
    return json({ ok: true });
  }

  /* storage */

  allShapes() {
    return this.ctx.storage.sql
      .exec("SELECT id, kind, x, y, w, h, z, props, seq FROM shapes ORDER BY z, seq")
      .toArray()
      .map((row) => ({ ...row, props: JSON.parse(row.props) }));
  }

  has(id) {
    return this.ctx.storage.sql.exec("SELECT 1 FROM shapes WHERE id = ?", id).toArray().length > 0;
  }

  count() {
    return this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM shapes").one().n;
  }

  saveMeta() {
    return this.ctx.storage.put("meta", this.meta);
  }

  peers(exceptCid) {
    const out = [];
    for (const socket of this.ctx.getWebSockets()) {
      const peer = attachment(socket);
      if (!peer || peer.cid === exceptCid) continue;
      const { cid, user_id, name, color, role } = peer;
      out.push({ cid, user_id, name, color, role });
    }
    return out;
  }

  broadcast(event, except) {
    const data = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try {
        socket.send(data);
      } catch {
        // A socket mid-close is dropped by the runtime; nothing to do here.
      }
    }
  }
}

function freshMeta() {
  return { board: "", name: "", link: false, plan: "free", owner: "", seq: 0, dirty: false, nextColor: 0 };
}

function attachment(ws) {
  try {
    return ws.deserializeAttachment();
  } catch {
    return null;
  }
}

function send(ws, event) {
  try {
    ws.send(JSON.stringify(event));
  } catch {
    // Closed between the check and the send.
  }
}

/* ------------------------------------------------------------ validation */

// Every shape that reaches storage went through here. Unknown props are
// dropped, so a newer client cannot smuggle fields an older one would trip on.
function sanitizeShape(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) return null;
  if (!KINDS.has(raw.kind)) return null;
  const x = num(raw.x);
  const y = num(raw.y);
  const w = size(raw.w);
  const h = size(raw.h);
  if (x === null || y === null || w === null || h === null) return null;
  const z = Number.isInteger(raw.z) ? clamp(raw.z, -1e9, 1e9) : 0;
  const p = raw.props && typeof raw.props === "object" ? raw.props : {};
  let props;

  switch (raw.kind) {
    case "note":
    case "rect":
    case "ellipse":
      props = { text: text(p.text, MAX_TEXT), color: color(p.color, "yellow") };
      break;
    case "text":
      props = { text: text(p.text, MAX_TEXT), color: color(p.color, "ink"), size: clamp(num(p.size) ?? 20, 12, 96) };
      break;
    case "line": {
      const x2 = num(p.x2);
      const y2 = num(p.y2);
      if (x2 === null || y2 === null) return null;
      props = { x2, y2, arrow: !!p.arrow, color: color(p.color, "ink") };
      break;
    }
    case "pen": {
      if (!Array.isArray(p.points) || p.points.length === 0 || p.points.length > MAX_POINTS) return null;
      const points = [];
      for (const pt of p.points) {
        if (!Array.isArray(pt)) return null;
        const px = num(pt[0]);
        const py = num(pt[1]);
        if (px === null || py === null) return null;
        points.push([round(px), round(py)]);
      }
      props = { points, color: color(p.color, "ink"), width: clamp(num(p.width) ?? 3, 1, 40) };
      break;
    }
    default:
      return null;
  }
  if (JSON.stringify(props).length > MAX_PROPS_BYTES) return null;
  return { id: raw.id, kind: raw.kind, x: round(x), y: round(y), w: round(w), h: round(h), z, props };
}

function sanitizeInk(msg) {
  if (typeof msg.id !== "string" || !ID_RE.test(msg.id)) return null;
  if (!Array.isArray(msg.points) || msg.points.length === 0 || msg.points.length > MAX_POINTS) return null;
  const points = [];
  for (const pt of msg.points) {
    if (!Array.isArray(pt)) return null;
    const px = num(pt[0]);
    const py = num(pt[1]);
    if (px === null || py === null) return null;
    points.push([round(px), round(py)]);
  }
  return { id: msg.id, points, color: color(msg.color, "ink"), width: clamp(num(msg.width) ?? 3, 1, 40) };
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e6 ? value : null;
}

function size(value) {
  const n = num(value);
  return n === null ? null : clamp(n, 1, 1e5);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function color(value, fallback) {
  return PALETTE.includes(value) ? value : fallback;
}

/* ---------------------------------------------------------------- export */

// A plain SVG of the board, drawn server-side from the same shape records the
// canvas renders. Colours are the light theme's.
const FILL = {
  yellow: "#fde68a", pink: "#fbcfe8", blue: "#bfdbfe", green: "#bbf7d0",
  orange: "#fed7aa", purple: "#ddd6fe", grey: "#e5e7eb", ink: "#1f2937",
};
const STROKE = {
  yellow: "#ca8a04", pink: "#db2777", blue: "#2563eb", green: "#16a34a",
  orange: "#ea580c", purple: "#7c3aed", grey: "#6b7280", ink: "#1f2937",
};

function shapesToSVG(shapes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.w);
    maxY = Math.max(maxY, s.y + s.h);
  }
  if (!Number.isFinite(minX)) {
    minX = 0; minY = 0; maxX = 800; maxY = 600;
  }
  const pad = 40;
  const vb = [minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2].map((n) => Math.round(n));
  const parts = shapes.map(shapeToSVG).filter(Boolean);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(" ")}" width="${vb[2]}" height="${vb[3]}" font-family="ui-sans-serif, system-ui, sans-serif">\n` +
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>\n` +
    `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="#fcfcfb"/>\n` +
    parts.join("\n") +
    "\n</svg>\n"
  );
}

function shapeToSVG(s) {
  const p = s.props || {};
  const fill = FILL[p.color] || FILL.yellow;
  const stroke = STROKE[p.color] || STROKE.ink;
  switch (s.kind) {
    case "note":
      return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="6" fill="${fill}"/>` + wrappedText(p.text, s.x + 14, s.y + 14, s.w - 28, 18, "#1f2937", "start");
    case "rect":
      return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="4" fill="${fill}" fill-opacity="0.35" stroke="${stroke}" stroke-width="2"/>` + wrappedText(p.text, s.x + s.w / 2, s.y + s.h / 2, s.w - 20, 18, "#1f2937", "middle");
    case "ellipse":
      return `<ellipse cx="${s.x + s.w / 2}" cy="${s.y + s.h / 2}" rx="${s.w / 2}" ry="${s.h / 2}" fill="${fill}" fill-opacity="0.35" stroke="${stroke}" stroke-width="2"/>` + wrappedText(p.text, s.x + s.w / 2, s.y + s.h / 2, s.w * 0.7, 18, "#1f2937", "middle");
    case "line":
      return `<line x1="${s.x}" y1="${s.y}" x2="${p.x2}" y2="${p.y2}" stroke="${stroke}" stroke-width="2" stroke-linecap="round"${p.arrow ? ' marker-end="url(#arrow)"' : ""}/>`;
    case "pen": {
      const pts = p.points || [];
      if (pts.length === 0) return "";
      const d = pts.map((pt, i) => `${i === 0 ? "M" : "L"}${s.x + pt[0]} ${s.y + pt[1]}`).join("");
      return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${p.width || 3}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    case "text":
      return wrappedText(p.text, s.x, s.y, s.w, (p.size || 20) * 1.25, stroke, "start", p.size || 20);
    default:
      return "";
  }
}

// Naive wrapping by character count; SVG text has no layout of its own.
function wrappedText(value, x, y, width, lineHeight, colour, anchor, size = 15) {
  const body = typeof value === "string" ? value.trim() : "";
  if (!body) return "";
  const perLine = Math.max(4, Math.floor(width / (size * 0.55)));
  const lines = [];
  for (const para of body.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (line && (line + " " + word).length > perLine) {
        lines.push(line);
        line = word;
      } else {
        line = line ? line + " " + word : word;
      }
    }
    lines.push(line);
  }
  const startY = anchor === "middle" ? y - ((lines.length - 1) * lineHeight) / 2 : y + size;
  const spans = lines
    .slice(0, 200)
    .map((l, i) => `<tspan x="${x}" y="${startY + i * lineHeight}">${escapeXML(l)}</tspan>`)
    .join("");
  return `<text font-size="${size}" fill="${colour}" text-anchor="${anchor}"${anchor === "middle" ? ' dominant-baseline="middle"' : ""}>${spans}</text>`;
}

function escapeXML(s) {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* ----------------------------------------------------------------- utils */

async function readJSON(request) {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function text(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function methodNotAllowed() {
  return json({ error: "method not allowed" }, 405);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/* --------------------------------------------------------------- logging */
//
// Read these back with `yard service logs` (add --since 2h). Every line
// starts with [chalk] and is one event, so it greps cleanly:
//   yard service logs | grep 'shape.put'
//
// Not logged: shape text, board names, display names, emails. Ids are cut to
// 8 characters: enough to correlate lines within a session, not a lasting
// identifier sitting in a log store.

function log(event, fields) {
  const parts = ["[chalk] " + event];
  for (const key in fields) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    parts.push(key + "=" + value);
  }
  console.log(parts.join(" "));
}

function shortId(id) {
  return typeof id === "string" && id ? id.slice(0, 8) : "-";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function redactPath(pathname) {
  return pathname
    .split("/")
    .map((segment) => (UUID.test(segment) ? shortId(segment) : segment))
    .join("/");
}

function changed(result) {
  return (result && result.meta && result.meta.changes) || 0;
}
