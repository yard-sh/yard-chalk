// Chalk socket client.
//
// One connection per open board. The board's object echoes every stored edit
// back to everyone in order, so this module only moves messages; ordering and
// state live in board.js. Reconnecting is routine, not an error: Yard closes
// every session after 24 hours with code 1000 and "Session limit reached",
// and under yard dev each save restarts the runtime and drops the socket.

const CURSOR_INTERVAL = 50; // ms between cursor messages
const INK_INTERVAL = 80; // ms between live pen batches
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 8000;
const QUEUE_MAX = 500;
const SESSION_LIMIT = "Session limit reached";

// Close codes the board sends when there is nothing to reconnect to.
const STOP_CODES = { 4001: "full", 4002: "deleted", 4003: "forbidden" };

// connect(boardId, { onMessage(msg), onStatus(status), onStop(reason, detail) })
//
// status: "connecting" | "connected" | "reconnecting" | "offline" | "stopped"
// reason: "full" | "deleted" | "forbidden"
export function connect(boardId, handlers) {
  // Relative on purpose: the app serves under /<slug>/app/, and in a sandbox
  // under /<slug>/@<sandbox>/app/. Replacing the scheme keeps https as wss.
  const url = new URL("api/boards/" + boardId + "/ws", location.href).href.replace(
    /^http/,
    "ws",
  );

  let ws = null;
  let status = "connecting";
  let attempt = 0;
  let timer = null;
  let closedByUs = false;
  const queue = [];
  const cursor = { x: 0, y: 0, last: 0, timer: null };
  const ink = { id: null, points: [], color: "ink", width: 3, timer: null };
  const windowEvents = new AbortController();

  function setStatus(next) {
    if (status === next) return;
    status = next;
    if (handlers.onStatus) handlers.onStatus(next);
  }

  function open() {
    timer = null;
    ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      attempt = 0;
      setStatus("connected");
      flushQueue();
    });
    ws.addEventListener("message", (event) => {
      let msg = null;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg && typeof msg.t === "string") handlers.onMessage(msg);
    });
    // An error is always followed by close, which is where the decision lives.
    ws.addEventListener("close", (event) => {
      ws = null;
      onClose(event);
    });
  }

  function onClose(event) {
    if (closedByUs) {
      setStatus("offline");
      return;
    }
    const stop = STOP_CODES[event.code];
    if (stop) {
      setStatus("stopped");
      if (handlers.onStop) handlers.onStop(stop, event.reason);
      return;
    }
    setStatus("reconnecting");
    if (event.code === 1000 && event.reason === SESSION_LIMIT) {
      open();
      return;
    }
    const delay = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** attempt) + Math.random() * 250;
    attempt += 1;
    timer = setTimeout(open, delay);
  }

  function isOpen() {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  }

  // Stored edits wait for the next connection; cursors and ink are only
  // worth sending live, so they are dropped while offline.
  function send(msg) {
    if (isOpen()) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    if (msg.t === "put" || msg.t === "del" || msg.t === "me") {
      if (msg.t === "put") {
        const stale = queue.findIndex((m) => m.t === "put" && m.shape.id === msg.shape.id);
        if (stale >= 0) queue.splice(stale, 1);
      }
      queue.push(msg);
      if (queue.length > QUEUE_MAX) queue.shift();
    }
    return false;
  }

  function flushQueue() {
    while (queue.length && isOpen()) ws.send(JSON.stringify(queue.shift()));
  }

  function sendCursor(x, y) {
    cursor.x = x;
    cursor.y = y;
    if (cursor.timer) return;
    const wait = Math.max(0, CURSOR_INTERVAL - (performance.now() - cursor.last));
    cursor.timer = setTimeout(() => {
      cursor.timer = null;
      cursor.last = performance.now();
      if (!isOpen()) return;
      send({ t: "cursor", x: round(cursor.x), y: round(cursor.y) });
    }, wait);
  }

  // A stroke in progress goes out as batches of new points under one id;
  // receivers append. The finished stroke follows as an ordinary put.
  function inkStart(id, color, width) {
    inkFlush();
    ink.id = id;
    ink.points = [];
    ink.color = color;
    ink.width = width;
  }

  function inkAdd(point) {
    if (!ink.id) return;
    ink.points.push([round(point.x), round(point.y)]);
    if (!ink.timer) ink.timer = setTimeout(inkFlush, INK_INTERVAL);
  }

  function inkFlush() {
    clearTimeout(ink.timer);
    ink.timer = null;
    if (!ink.id || !ink.points.length) return;
    const points = ink.points;
    ink.points = [];
    if (isOpen()) {
      send({ t: "ink", id: ink.id, points, color: ink.color, width: ink.width });
    }
  }

  function inkEnd() {
    inkFlush();
    ink.id = null;
  }

  function close() {
    if (closedByUs) return;
    closedByUs = true;
    clearTimeout(timer);
    clearTimeout(cursor.timer);
    clearTimeout(ink.timer);
    windowEvents.abort();
    if (ws) ws.close(1000, "leaving");
    else setStatus("offline");
  }

  window.addEventListener("beforeunload", close, { signal: windowEvents.signal });
  window.addEventListener(
    "online",
    () => {
      if (timer) {
        clearTimeout(timer);
        open();
      }
    },
    { signal: windowEvents.signal },
  );

  open();

  return {
    send,
    sendCursor,
    inkStart,
    inkAdd,
    inkEnd,
    close,
    get status() {
      return status;
    },
  };
}

function round(n) {
  return Math.round(n * 10) / 10;
}
