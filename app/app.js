// Chalk frontend.
//
// Zero dependencies, three modules. Every URL is RELATIVE ("api/boards", not
// "/api/boards"): the app is mounted at /<slug>/app/, so a root-absolute URL
// would resolve against the domain root. The open board lives in the hash
// for the same reason. board.js draws, live.js talks; this file decides.

import { connect } from "./live.js";
import { createBoard } from "./board.js";

const $ = (id) => document.getElementById(id);

const workspaceEl = $("workspace");
const boardsEl = $("boards");
const boardListEl = $("board-list");
const boardNameEl = $("board-name");
const statusEl = $("status");
const presenceEl = $("presence");
const accountEl = $("account");
const accountButton = $("account-button");
const accountMenu = $("account-menu");
const nameInput = $("name-input");
const planBadge = $("plan-badge");
const shareEl = $("share");
const shareToggle = $("share-toggle");
const shareLink = $("share-link");
const shareNote = $("share-note");
const planEl = $("plan");
const toastEl = $("toast");
const zoomEl = $("zoom");

const HISTORY_MAX = 100;

const state = {
  me: null,
  meCheckedAt: 0,
  boards: [],
  boardId: null,
  meta: null,
  you: null,
  limits: null,
  peers: new Map(),
  conn: null,
  history: [],
  future: [],
  viewRestored: false,
};

/* --------------------------------------------------------------------- api */

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const err = new Error((payload && payload.error) || "that didn't work");
    err.status = res.status;
    err.code = payload && payload.code;
    err.limit = payload && payload.limit;
    throw err;
  }
  return payload;
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    toastEl.hidden = true;
  }, 3200);
}

async function guard(fn) {
  try {
    await fn();
  } catch (err) {
    if (err.status === 401) {
      location.reload();
      return;
    }
    if (err.code === "boards_limit" || err.code === "pro_required") {
      showPlan(err.code, err.limit);
      return;
    }
    toast(err.message);
  }
}

/* ------------------------------------------------------------------ canvas */

const board = createBoard($("canvas"), $("editor"), {
  onChange(change) {
    if (!state.conn) return;
    if (change.kind === "put") {
      const isNew = change.prev === null && !change.transient;
      if (isNew && state.limits && board.shapeCount() > state.limits.shapes) {
        board.applyDel([change.shape.id]);
        showPlan("shapes_limit", state.limits.shapes);
        return;
      }
      state.conn.send({ t: "put", shape: change.shape });
      if (change.transient) return;
      remember({
        undo: change.prev ? { kind: "put", shapes: [change.prev] } : { kind: "del", ids: [change.shape.id] },
        redo: { kind: "put", shapes: [change.shape] },
      });
    } else {
      state.conn.send({ t: "del", ids: change.ids });
      remember({
        undo: { kind: "put", shapes: change.prev },
        redo: { kind: "del", ids: change.ids },
      });
    }
  },
  onCursor(x, y) {
    if (state.conn) state.conn.sendCursor(x, y);
  },
  onInk(id, point, color, width) {
    if (!state.conn) return;
    if (point === "start") state.conn.inkStart(id, color, width);
    else if (point === "end") state.conn.inkEnd();
    else state.conn.inkAdd(point);
  },
  onTool(tool) {
    for (const button of document.querySelectorAll("[data-tool]")) {
      button.setAttribute("aria-pressed", String(button.dataset.tool === tool));
    }
  },
  onColor(color) {
    for (const button of document.querySelectorAll("[data-color]")) {
      button.setAttribute("aria-pressed", String(button.dataset.color === color));
    }
  },
  onView(scale) {
    zoomEl.textContent = Math.round(scale * 100) + "%";
    saveViewSoon();
  },
});

for (const button of document.querySelectorAll("[data-tool]")) {
  button.addEventListener("click", () => board.setTool(button.dataset.tool));
}
for (const button of document.querySelectorAll("[data-color]")) {
  button.addEventListener("click", () => board.setColor(button.dataset.color));
}
$("zoom-in").addEventListener("click", () => board.zoomIn());
$("zoom-out").addEventListener("click", () => board.zoomOut());
zoomEl.addEventListener("click", () => board.zoomToFit());
$("delete-button").addEventListener("click", () => board.deleteSelection());
$("undo-button").addEventListener("click", undo);
$("redo-button").addEventListener("click", redo);
board.setColor("yellow");
board.setTool("select");

/* ------------------------------------------------------------------- undo */
//
// Every edit is an op the board understands, so undo is just the inverse op
// sent down the same path. Only this person's edits are on the stack; an
// undo that lands on a shape someone else has since changed still wins,
// because the board keeps whatever arrives last.

function remember(entry) {
  state.history.push(entry);
  if (state.history.length > HISTORY_MAX) state.history.shift();
  state.future = [];
  renderUndo();
}

function applyOp(op) {
  if (op.kind === "put") {
    for (const shape of op.shapes) {
      board.applyPut(structuredClone(shape));
      state.conn.send({ t: "put", shape });
    }
  } else {
    board.applyDel(op.ids);
    state.conn.send({ t: "del", ids: op.ids });
  }
}

function undo() {
  const entry = state.history.pop();
  if (!entry || !state.conn) return;
  applyOp(entry.undo);
  state.future.push(entry);
  renderUndo();
}

function redo() {
  const entry = state.future.pop();
  if (!entry || !state.conn) return;
  applyOp(entry.redo);
  state.history.push(entry);
  renderUndo();
}

function renderUndo() {
  $("undo-button").disabled = !state.history.length;
  $("redo-button").disabled = !state.future.length;
}

/* ----------------------------------------------------------------- socket */

function openBoard(id) {
  if (state.boardId === id) return;
  closeBoard();
  guard(async () => {
    let meta;
    try {
      meta = await api("api/boards/" + id + "/join", { method: "POST" });
    } catch (err) {
      if (err.code === "not_shared") toast("This board is not shared");
      else if (err.status === 404) toast("That board is gone");
      else throw err;
      location.hash = "";
      return;
    }
    state.boardId = id;
    state.meta = meta;
    state.viewRestored = restoreView(id);
    boardsEl.hidden = true;
    workspaceEl.hidden = false;
    document.body.dataset.view = "board";
    renderBoardHead();
    setStatus("connecting");
    state.conn = connect(id, { onMessage, onStatus: setStatus, onStop });
    board.setTool("select");
  });
}

function closeBoard() {
  if (state.boardId) saveView();
  if (state.conn) state.conn.close();
  state.conn = null;
  state.boardId = null;
  state.meta = null;
  state.you = null;
  state.limits = null;
  state.peers.clear();
  state.history = [];
  state.future = [];
  board.clear();
  closeDialogs();
  renderPresence();
  renderUndo();
  boardNameEl.hidden = true;
  boardNameEl.value = "";
  document.body.dataset.view = "list";
  document.title = "Chalk";
}

function onMessage(msg) {
  switch (msg.t) {
    case "snapshot":
      state.you = msg.you;
      state.limits = msg.board.limits;
      state.meta.name = msg.board.name;
      state.meta.link_access = msg.board.link_access;
      state.meta.owner_plan = msg.board.plan;
      state.peers = new Map(msg.peers.map((p) => [p.cid, p]));
      board.setShapes(msg.shapes, !state.viewRestored);
      state.viewRestored = true;
      board.setPeers(msg.peers);
      renderBoardHead();
      renderPresence();
      break;
    case "put":
      board.applyPut(msg.shape);
      break;
    case "del":
      board.applyDel(msg.ids);
      break;
    case "cursor":
      board.setCursor(msg.cid, msg.x, msg.y);
      break;
    case "ink":
      board.setInk(msg.cid, msg.id, msg.points, msg.color, msg.width);
      break;
    case "join":
      state.peers.set(msg.peer.cid, msg.peer);
      board.addPeer(msg.peer);
      renderPresence();
      break;
    case "leave":
      state.peers.delete(msg.cid);
      board.removePeer(msg.cid);
      renderPresence();
      break;
    case "peer": {
      const peer = state.peers.get(msg.cid);
      if (peer) peer.name = msg.name;
      board.renamePeer(msg.cid, msg.name);
      renderPresence();
      break;
    }
    case "board":
      state.meta.name = msg.name;
      state.meta.link_access = msg.link_access;
      renderBoardHead();
      renderShare();
      break;
    case "error":
      if (msg.code === "full" || msg.code === "shapes_limit") showPlan(msg.code, msg.limit);
      else toast(msg.message || "the board refused that");
      break;
  }
}

function setStatus(status) {
  const label = {
    connecting: "Connecting",
    connected: "Live",
    reconnecting: "Reconnecting",
    offline: "Offline",
    stopped: "Disconnected",
  }[status];
  statusEl.textContent = label || status;
  statusEl.dataset.status = status;
}

function onStop(reason) {
  if (reason === "full") {
    showPlan("full", state.limits ? state.limits.live : 5);
    return;
  }
  toast(reason === "deleted" ? "This board was deleted" : "You no longer have access to this board");
  location.hash = "";
}

/* ------------------------------------------------------------------- head */

function renderBoardHead() {
  if (!state.meta) return;
  boardNameEl.hidden = false;
  boardNameEl.value = state.meta.name;
  boardNameEl.readOnly = state.meta.role !== "owner";
  boardNameEl.title = state.meta.role === "owner" ? "Rename this board" : state.meta.name;
  document.title = state.meta.name + " · Chalk";
}

boardNameEl.addEventListener("focus", () => {
  if (boardNameEl.readOnly) boardNameEl.blur();
});
boardNameEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    boardNameEl.blur();
  } else if (event.key === "Escape") {
    boardNameEl.value = state.meta ? state.meta.name : "";
    boardNameEl.blur();
  }
});
boardNameEl.addEventListener("blur", () => {
  if (!state.meta || state.meta.role !== "owner") return;
  const name = boardNameEl.value.trim().slice(0, 80);
  if (!name || name === state.meta.name) {
    boardNameEl.value = state.meta.name;
    return;
  }
  state.meta.name = name;
  renderBoardHead();
  guard(() => api("api/boards/" + state.boardId, { method: "PATCH", body: JSON.stringify({ name }) }));
});

function renderPresence() {
  presenceEl.textContent = "";
  if (!state.you) return;
  const people = [state.you, ...state.peers.values()];
  const shown = people.slice(0, 6);
  for (const person of shown) {
    const dot = el("span", "avatar", initials(person.name));
    dot.dataset.color = String(person.color);
    dot.title = person === state.you ? person.name + " (you)" : person.name;
    presenceEl.append(dot);
  }
  if (people.length > shown.length) {
    presenceEl.append(el("span", "avatar avatar--more mono", "+" + (people.length - shown.length)));
  }
  presenceEl.setAttribute("aria-label", people.length + " on this board");
}

/* ------------------------------------------------------------------ share */

$("share-button").addEventListener("click", () => {
  if (!state.meta) return;
  renderShare();
  openDialog(shareEl);
});

function renderShare() {
  if (!state.meta) return;
  const owner = state.meta.role === "owner";
  shareToggle.checked = Boolean(state.meta.link_access);
  shareToggle.disabled = !owner;
  shareLink.value = location.href;
  shareNote.textContent = owner
    ? state.meta.link_access
      ? "Anyone signed in to Yard with this link can edit."
      : "Only you can open this board."
    : state.meta.link_access
      ? "Anyone signed in to Yard with this link can edit."
      : "The owner turned link sharing off.";
  $("share-copy").disabled = !state.meta.link_access && !owner;
}

shareToggle.addEventListener("change", () => {
  if (!state.meta || state.meta.role !== "owner") return;
  const link_access = shareToggle.checked;
  state.meta.link_access = link_access;
  renderShare();
  guard(() =>
    api("api/boards/" + state.boardId, { method: "PATCH", body: JSON.stringify({ link_access }) }),
  );
});

$("share-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareLink.value);
    toast("Link copied");
  } catch {
    shareLink.select();
    toast("Copy the link from the field");
  }
});

/* ----------------------------------------------------------------- export */

$("export-button").addEventListener("click", () => {
  if (!state.boardId) return;
  if (state.me && state.me.plan !== "pro") {
    showPlan("pro_required");
    return;
  }
  guard(async () => {
    const res = await fetch("api/boards/" + state.boardId + "/export.svg");
    if (!res.ok) {
      let payload = null;
      try {
        payload = await res.json();
      } catch {}
      const err = new Error((payload && payload.error) || "export failed");
      err.status = res.status;
      err.code = payload && payload.code;
      throw err;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (state.meta.name || "board").replace(/[^\w-]+/g, "-") + ".svg";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
});

/* ------------------------------------------------------------------- plan */
//
// Board limits follow the owner's plan; export follows yours. The copy says
// which, and the upgrade buttons only appear when upgrading would help.

const PLAN_COPY = {
  boards_limit: (limit) => [
    "That is every board on Free",
    "Free plans hold " + limit + " boards. Pro holds as many as you like.",
    true,
  ],
  full: (limit) => [
    "This board is full",
    limit +
      " people are on it already. Free boards hold 5 people at once and Pro boards hold 50. The board's owner sets its plan.",
    false,
  ],
  shapes_limit: (limit) => [
    "This board is full of shapes",
    "It holds " +
      limit +
      " shapes. Free boards hold 500 and Pro boards hold 5,000. The board's owner sets its plan.",
    false,
  ],
  pro_required: () => [
    "Export is a Pro feature",
    "Pro saves any board as an SVG you can open anywhere.",
    true,
  ],
};

function showPlan(code, limit) {
  if (limit === undefined || limit === null) {
    const l = state.limits || { live: 5, shapes: 500 };
    limit = code === "full" ? l.live : code === "shapes_limit" ? l.shapes : 3;
  }
  const [title, body, yours] = PLAN_COPY[code](limit);
  $("plan-title").textContent = title;
  $("plan-copy").textContent = body;
  const free = state.me && state.me.plan !== "pro";
  const ownerFree = state.meta && state.meta.owner_plan !== "pro" && state.meta.role === "owner";
  $("plan-actions").hidden = !(free && (yours || ownerFree));
  openDialog(planEl);
}

/* ---------------------------------------------------------------- account */

function renderAccount() {
  const me = state.me;
  if (!me) return;
  accountButton.textContent = "";
  const dot = el("span", "avatar", initials(me.name));
  dot.dataset.color = "self";
  accountButton.append(dot, el("span", "account__name", me.name));
  nameInput.value = me.name;
  planBadge.textContent = me.plan === "pro" ? "Pro" : "Free";
  planBadge.dataset.plan = me.plan;
  $("account-email").textContent = me.email || "";
  $("account-upgrade").hidden = me.plan === "pro";
}

accountButton.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = accountMenu.hidden;
  accountMenu.hidden = !open;
  accountButton.setAttribute("aria-expanded", String(open));
  if (open) nameInput.focus();
});

document.addEventListener("click", (event) => {
  if (!accountMenu.hidden && !accountEl.contains(event.target)) closeAccount();
});

function closeAccount() {
  accountMenu.hidden = true;
  accountButton.setAttribute("aria-expanded", "false");
}

nameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    nameInput.blur();
  } else if (event.key === "Escape") {
    nameInput.value = state.me.name;
    closeAccount();
  }
});

nameInput.addEventListener("blur", () => {
  const name = nameInput.value.trim().slice(0, 40);
  if (!name || name === state.me.name) {
    nameInput.value = state.me.name;
    return;
  }
  guard(async () => {
    state.me = await api("api/me", { method: "PATCH", body: JSON.stringify({ name }) });
    renderAccount();
    if (state.conn) state.conn.send({ t: "me", name: state.me.name });
    if (state.you) {
      state.you.name = state.me.name;
      renderPresence();
    }
  });
});

// A purchase in another tab shows up here within the edge's short cache.
async function refreshMe() {
  if (Date.now() - state.meCheckedAt < 10000) return;
  state.meCheckedAt = Date.now();
  const before = state.me ? state.me.plan : null;
  try {
    state.me = await api("api/me");
  } catch {
    return;
  }
  renderAccount();
  if (before && before !== state.me.plan) {
    toast(state.me.plan === "pro" ? "You are on Pro now" : "Your plan changed");
  }
}

window.addEventListener("focus", refreshMe);

/* ------------------------------------------------------------------- list */

async function showList() {
  closeBoard();
  workspaceEl.hidden = true;
  boardsEl.hidden = false;
  document.title = "Chalk";
  state.boards = await api("api/boards");
  renderList();
}

function renderList() {
  boardListEl.textContent = "";
  if (!state.boards.length) {
    boardListEl.append(el("p", "boards__empty", "No boards yet. Make one."));
    return;
  }
  for (const b of state.boards) {
    const card = el("article", "bcard");
    const open = document.createElement("a");
    open.className = "bcard__open";
    open.href = "#" + b.id;
    open.append(el("span", "bcard__name", b.name));
    const shapes = b.shape_count === 1 ? "1 shape" : b.shape_count + " shapes";
    open.append(el("span", "bcard__meta mono", b.role + " · " + shapes + " · " + ago(b.updated_at)));
    card.append(open);

    const actions = el("div", "bcard__actions");
    if (b.role === "owner") {
      const rename = el("button", "button button--sm", "Rename");
      rename.addEventListener("click", () => renameBoard(b));
      const remove = el("button", "button button--sm button--danger", "Delete");
      remove.addEventListener("click", () => deleteBoard(b));
      actions.append(rename, remove);
    } else {
      const leave = el("button", "button button--sm", "Leave");
      leave.addEventListener("click", () => leaveBoard(b));
      actions.append(leave);
    }
    card.append(actions);
    boardListEl.append(card);
  }
}

$("new-board").addEventListener("click", () => {
  const name = prompt("Name your board", "Untitled board");
  if (!name || !name.trim()) return;
  guard(async () => {
    const created = await api("api/boards", {
      method: "POST",
      body: JSON.stringify({ name: name.trim().slice(0, 80) }),
    });
    location.hash = created.id;
  });
});

function renameBoard(b) {
  const name = prompt("Rename board", b.name);
  if (!name || !name.trim() || name.trim() === b.name) return;
  guard(async () => {
    await api("api/boards/" + b.id, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim().slice(0, 80) }),
    });
    state.boards = await api("api/boards");
    renderList();
  });
}

function deleteBoard(b) {
  if (!confirm('Delete "' + b.name + '" and everything on it? This cannot be undone.')) return;
  guard(async () => {
    await api("api/boards/" + b.id, { method: "DELETE" });
    state.boards = await api("api/boards");
    renderList();
  });
}

function leaveBoard(b) {
  if (!confirm('Leave "' + b.name + '"? You can come back with the link.')) return;
  guard(async () => {
    await api("api/boards/" + b.id + "/leave", { method: "POST" });
    state.boards = await api("api/boards");
    renderList();
  });
}

/* ---------------------------------------------------------------- dialogs */

function openDialog(node) {
  node.hidden = false;
  const first = node.querySelector("input:not([disabled]), button:not([disabled])");
  if (first) queueMicrotask(() => first.focus());
}

function closeDialogs() {
  shareEl.hidden = true;
  planEl.hidden = true;
  closeAccount();
}

for (const node of [shareEl, planEl]) {
  node.addEventListener("click", (event) => {
    if (event.target.closest("[data-close]")) {
      node.hidden = true;
      $("canvas").focus({ preventScroll: true });
    }
  });
}

/* --------------------------------------------------------------- keyboard */

document.addEventListener("keydown", (event) => {
  const inField = event.target.matches("input, textarea");
  if (event.key === "Escape" && !inField) {
    if (!shareEl.hidden || !planEl.hidden || !accountMenu.hidden) {
      closeDialogs();
      return;
    }
  }
  if (inField || workspaceEl.hidden || board.isEditing()) return;
  // A focused rail button keeps its own Space and Enter.
  if (event.target.closest && event.target.closest("button, a")) return;
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (meta && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redo();
    return;
  }
  if (board.handleKey(event)) event.preventDefault();
});

document.addEventListener("keyup", (event) => {
  if (board.handleKeyUp(event)) event.preventDefault();
});

/* -------------------------------------------------------------------- view */

function restoreView(id) {
  try {
    const saved = JSON.parse(localStorage.getItem("chalk.view." + id));
    if (saved) {
      board.setView(saved);
      return true;
    }
  } catch {}
  return false;
}

function saveView() {
  if (!state.boardId) return;
  try {
    localStorage.setItem("chalk.view." + state.boardId, JSON.stringify(board.getView()));
  } catch {}
}

function saveViewSoon() {
  clearTimeout(saveViewSoon.timer);
  saveViewSoon.timer = setTimeout(saveView, 400);
}

/* ------------------------------------------------------------------ chrome */

$("theme-toggle").addEventListener("click", () => {
  const dark =
    document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("chalk.theme", next);
  } catch {}
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function initials(name) {
  const parts = String(name || "?").trim().split(/[\s._-]+/).filter(Boolean);
  const first = parts[0] ? parts[0][0] : "?";
  const second = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + second).toUpperCase();
}

function ago(stamp) {
  if (!stamp) return "";
  const iso = /[TZ]/.test(stamp) ? stamp : stamp.replace(" ", "T") + "Z";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + "h ago";
  return Math.round(hours / 24) + "d ago";
}

/* ------------------------------------------------------------------- route */

function route() {
  const id = location.hash.replace(/^#/, "");
  if (id) openBoard(id);
  else guard(showList);
}

window.addEventListener("hashchange", route);
window.addEventListener("pagehide", saveView);

async function main() {
  try {
    state.me = await api("api/me");
  } catch (err) {
    boardsEl.hidden = false;
    boardListEl.textContent = "";
    boardListEl.append(
      el("p", "boards__empty", err.status === 401 ? "Sign in to use Chalk" : "Could not load your account"),
    );
    return;
  }
  state.meCheckedAt = Date.now();
  renderAccount();
  route();
}

main();
