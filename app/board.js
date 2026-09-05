// Chalk canvas engine.
//
// One SVG, one world group, shapes keyed by id. The board's object is the
// only source of order: this module applies its own edits at once and then
// applies every echo it receives, skipping only the shapes under the pointer
// while a drag is in progress. Nothing here touches the network; app.js
// wires onChange to the socket and records undo entries from it.

const SVG = "http://www.w3.org/2000/svg";

export const TOOLS = ["select", "hand", "note", "rect", "ellipse", "line", "pen", "text"];
export const COLORS = ["yellow", "pink", "blue", "green", "orange", "purple", "grey", "ink"];

const DEFAULT_SIZE = { note: [180, 180], rect: [160, 100], ellipse: [160, 100] };
const MIN_SIZE = 20;
const MAX_TEXT = 2000;
const MAX_POINTS = 2000;
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const NOTE_FONT = 16;
const NOTE_PAD = 14;
const LINE_HEIGHT = 1.3;
const HANDLE = 8; // screen px
const PEN_WIDTH = 3;
const TEXT_SIZE = 20;
const LIVE_PUT_INTERVAL = 100; // ms between puts while dragging
const INK_STALE_MS = 10000;

// createBoard(svg, editor, options)
//   options.onChange({ kind: "put", shape, prev, transient } | { kind: "del", ids, prev })
//   options.onCursor(x, y)                    pointer moved, board coordinates
//   options.onInk(id, point, color, width)    pen stroke in progress ("start" | point | "end")
//   options.onTool(tool), options.onColor(color), options.onView(scale), options.onSelection(ids)
export function createBoard(svg, editor, options) {
  const shapes = new Map();
  const nodes = new Map();
  const selected = new Set();
  const peers = new Map(); // cid -> { peer, node }
  const inks = new Map(); // id -> { node, points, cid, at }
  const pointers = new Map();
  const activeIds = new Set(); // shapes being dragged; echoes for them wait
  const view = { x: 0, y: 0, scale: 1 };

  let tool = "select";
  let color = "yellow";
  let drag = null;
  let pinch = null;
  let editing = null;
  let spaceHeld = false;
  let maxZ = 0;

  /* ------------------------------------------------------------- layers */

  svg.textContent = "";
  const world = g("world");
  const shapesLayer = g("shapes");
  const inksLayer = g("inks");
  const cursorsLayer = g("cursors");
  const selectionLayer = g("selection");
  const previewLayer = g("preview");
  world.append(shapesLayer, inksLayer, selectionLayer, previewLayer, cursorsLayer);
  svg.append(world);

  function g(id) {
    const node = document.createElementNS(SVG, "g");
    node.id = id;
    return node;
  }

  const measure = document.createElement("canvas").getContext("2d");
  const family = getComputedStyle(svg).fontFamily || "sans-serif";

  /* -------------------------------------------------------------- view */

  function applyView() {
    world.setAttribute(
      "transform",
      "translate(" + view.x + " " + view.y + ") scale(" + view.scale + ")",
    );
    for (const entry of peers.values()) placeCursor(entry);
    renderSelection();
    if (options.onView) options.onView(view.scale);
  }

  function toBoard(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    return {
      x: (clientX - r.left - view.x) / view.scale,
      y: (clientY - r.top - view.y) / view.scale,
    };
  }

  function zoomAt(clientX, clientY, factor) {
    const r = svg.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const next = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
    const ratio = next / view.scale;
    view.x = px - (px - view.x) * ratio;
    view.y = py - (py - view.y) * ratio;
    view.scale = next;
    applyView();
  }

  function zoomCenter(factor) {
    const r = svg.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }

  function resetView() {
    const r = svg.getBoundingClientRect();
    view.scale = 1;
    view.x = r.width / 2;
    view.y = r.height / 2;
    applyView();
  }

  function zoomToFit() {
    if (!shapes.size) {
      resetView();
      return;
    }
    const box = unionBox([...shapes.values()]);
    const r = svg.getBoundingClientRect();
    const pad = 80;
    const scale = clamp(
      Math.min((r.width - pad * 2) / box.w, (r.height - pad * 2) / box.h, 1.5),
      MIN_SCALE,
      MAX_SCALE,
    );
    view.scale = scale;
    view.x = r.width / 2 - (box.x + box.w / 2) * scale;
    view.y = r.height / 2 - (box.y + box.h / 2) * scale;
    applyView();
  }

  /* ------------------------------------------------------------ shapes */

  function bbox(shape) {
    return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  }

  function unionBox(list) {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const s of list) {
      x1 = Math.min(x1, s.x);
      y1 = Math.min(y1, s.y);
      x2 = Math.max(x2, s.x + s.w);
      y2 = Math.max(y2, s.y + s.h);
    }
    return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
  }

  function nextZ() {
    maxZ += 1;
    return maxZ;
  }

  function insertByZ(node, z) {
    let ref = null;
    for (const child of shapesLayer.children) {
      if (Number(child.dataset.z) > z) {
        ref = child;
        break;
      }
    }
    shapesLayer.insertBefore(node, ref);
  }

  function renderShape(shape, append) {
    let node = nodes.get(shape.id);
    if (!node) {
      node = document.createElementNS(SVG, "g");
      node.classList.add("shape", "shape--" + shape.kind);
      node.dataset.id = shape.id;
      node.dataset.z = String(shape.z);
      nodes.set(shape.id, node);
      if (append) shapesLayer.append(node);
      else insertByZ(node, shape.z);
    } else if (Number(node.dataset.z) !== shape.z) {
      node.dataset.z = String(shape.z);
      node.remove();
      insertByZ(node, shape.z);
    }
    maxZ = Math.max(maxZ, shape.z);
    node.dataset.color = shape.props.color || "ink";
    node.setAttribute("transform", "translate(" + shape.x + " " + shape.y + ")");
    node.classList.toggle("is-editing", editing !== null && editing.id === shape.id);
    node.textContent = "";
    RENDER[shape.kind](node, shape);
    return node;
  }

  const RENDER = {
    note(node, s) {
      const rect = el("rect", { class: "fill", width: s.w, height: s.h, rx: 6 });
      node.append(rect, label(s, "start"));
    },
    rect(node, s) {
      const rect = el("rect", { class: "fill outlined", width: s.w, height: s.h, rx: 4 });
      node.append(rect, label(s, "middle"));
    },
    ellipse(node, s) {
      const shape = el("ellipse", {
        class: "fill outlined",
        cx: s.w / 2,
        cy: s.h / 2,
        rx: s.w / 2,
        ry: s.h / 2,
      });
      node.append(shape, label(s, "middle"));
    },
    line(node, s) {
      const dx = s.props.x2 - s.x;
      const dy = s.props.y2 - s.y;
      node.append(el("line", { class: "stroke", x1: 0, y1: 0, x2: dx, y2: dy }));
      if (s.props.arrow) node.append(el("path", { class: "arrowhead", d: arrowhead(dx, dy) }));
      node.append(el("line", { class: "hit", x1: 0, y1: 0, x2: dx, y2: dy }));
    },
    pen(node, s) {
      const d = smoothPath(s.props.points);
      const width = s.props.width || PEN_WIDTH;
      const stroke = el("path", { class: "stroke", d });
      stroke.style.strokeWidth = width + "px";
      node.append(stroke, el("path", { class: "hit", d }));
    },
    text(node, s) {
      node.append(el("rect", { class: "hit", width: s.w, height: s.h }));
      const size = s.props.size || TEXT_SIZE;
      const text = el("text", { class: "label", "font-size": size, x: 4, y: size * 0.95 });
      const lines = String(s.props.text || "").split("\n");
      lines.forEach((line, i) => {
        const span = el("tspan", { x: 4, dy: i === 0 ? 0 : size * 1.25 });
        span.textContent = line || " ";
        text.append(span);
      });
      node.append(text);
    },
  };

  // Wrapped text inside a note or a box. SVG has no wrapping of its own, so
  // lines are measured with a canvas context in the same font.
  function label(s, anchor) {
    const text = el("text", { class: "label", "font-size": NOTE_FONT, "text-anchor": anchor });
    const inner = Math.max(10, s.w - NOTE_PAD * 2);
    const lineH = NOTE_FONT * LINE_HEIGHT;
    const maxLines = Math.max(1, Math.floor((s.h - NOTE_PAD * 2) / lineH));
    const lines = wrap(s.props.text || "", inner, NOTE_FONT).slice(0, maxLines);
    const x = anchor === "middle" ? s.w / 2 : NOTE_PAD;
    const startY =
      anchor === "middle"
        ? s.h / 2 - ((lines.length - 1) * lineH) / 2 + NOTE_FONT * 0.35
        : NOTE_PAD + NOTE_FONT * 0.9;
    lines.forEach((line, i) => {
      const span = el("tspan", { x, y: startY + i * lineH });
      span.textContent = line || " ";
      text.append(span);
    });
    return text;
  }

  function wrap(text, width, size) {
    measure.font = size + "px " + family;
    const out = [];
    for (const para of String(text).split("\n")) {
      let line = "";
      for (const word of para.split(/(\s+)/)) {
        if (!word) continue;
        const candidate = line + word;
        if (measure.measureText(candidate).width <= width || !line.trim()) {
          line = candidate;
          if (measure.measureText(line).width > width) {
            // A single word wider than the box breaks by character.
            let chunk = "";
            for (const ch of line) {
              if (measure.measureText(chunk + ch).width > width && chunk) {
                out.push(chunk);
                chunk = ch;
              } else chunk += ch;
            }
            line = chunk;
          }
        } else {
          out.push(line.trimEnd());
          line = word.trimStart();
        }
      }
      out.push(line.trimEnd());
    }
    return out;
  }

  function textSize(s) {
    const size = s.props.size || TEXT_SIZE;
    measure.font = size + "px " + family;
    const lines = String(s.props.text || "").split("\n");
    let w = 0;
    for (const line of lines) w = Math.max(w, measure.measureText(line || " ").width);
    s.w = Math.max(MIN_SIZE, Math.ceil(w) + 8);
    s.h = Math.max(size * 1.25, Math.ceil(lines.length * size * 1.25));
  }

  function arrowhead(dx, dy) {
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const size = 12;
    const bx = dx - ux * size;
    const by = dy - uy * size;
    const px = -uy * size * 0.5;
    const py = ux * size * 0.5;
    return (
      "M" + dx + " " + dy + "L" + (bx + px) + " " + (by + py) + "L" + (bx - px) + " " + (by - py) + "Z"
    );
  }

  function smoothPath(points) {
    if (!points || !points.length) return "";
    if (points.length === 1) {
      const [x, y] = points[0];
      return "M" + x + " " + y + "l0.01 0";
    }
    let d = "M" + points[0][0] + " " + points[0][1];
    for (let i = 1; i < points.length - 1; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      d += "Q" + x1 + " " + y1 + " " + (x1 + x2) / 2 + " " + (y1 + y2) / 2;
    }
    const last = points[points.length - 1];
    d += "L" + last[0] + " " + last[1];
    return d;
  }

  function el(tag, attrs) {
    const node = document.createElementNS(SVG, tag);
    for (const key in attrs) node.setAttribute(key, String(attrs[key]));
    return node;
  }

  /* ---------------------------------------------------------- selection */

  function renderSelection() {
    selectionLayer.textContent = "";
    if (options.onSelection) options.onSelection([...selected]);
    if (!selected.size) return;
    const list = [...selected].map((id) => shapes.get(id)).filter(Boolean);
    const k = 1 / view.scale;
    for (const s of list) {
      if (s.kind === "line") continue;
      selectionLayer.append(
        el("rect", {
          class: "sel",
          x: s.x,
          y: s.y,
          width: s.w,
          height: s.h,
          "vector-effect": "non-scaling-stroke",
        }),
      );
    }
    if (list.length !== 1) return;
    const s = list[0];
    const size = HANDLE * k;
    const handle = (name, x, y) =>
      el("rect", {
        class: "handle",
        "data-handle": name,
        x: x - size / 2,
        y: y - size / 2,
        width: size,
        height: size,
        "vector-effect": "non-scaling-stroke",
      });
    if (s.kind === "line") {
      selectionLayer.append(
        el("line", {
          class: "sel",
          x1: s.x,
          y1: s.y,
          x2: s.props.x2,
          y2: s.props.y2,
          "vector-effect": "non-scaling-stroke",
        }),
        handle("a", s.x, s.y),
        handle("b", s.props.x2, s.props.y2),
      );
    } else if (s.kind !== "text") {
      selectionLayer.append(
        handle("nw", s.x, s.y),
        handle("ne", s.x + s.w, s.y),
        handle("sw", s.x, s.y + s.h),
        handle("se", s.x + s.w, s.y + s.h),
      );
    }
  }

  function select(ids) {
    selected.clear();
    for (const id of ids) if (shapes.has(id)) selected.add(id);
    renderSelection();
  }

  function clearSelection() {
    if (!selected.size) return;
    selected.clear();
    renderSelection();
  }

  /* ------------------------------------------------------------- edits */

  function emitPut(shape, prev, transient) {
    options.onChange({ kind: "put", shape: clone(shape), prev, transient: Boolean(transient) });
  }

  function addShape(shape) {
    shapes.set(shape.id, shape);
    renderShape(shape);
    return shape;
  }

  function newShape(kind, x, y, w, h, props) {
    return {
      id: crypto.randomUUID(),
      kind,
      x: round(x),
      y: round(y),
      w: round(w),
      h: round(h),
      z: nextZ(),
      props,
    };
  }

  function deleteShapes(ids) {
    const prev = [];
    for (const id of ids) {
      const s = shapes.get(id);
      if (!s) continue;
      prev.push(clone(s));
      removeNode(id);
    }
    if (!prev.length) return;
    renderSelection();
    options.onChange({ kind: "del", ids: prev.map((s) => s.id), prev });
  }

  function removeNode(id) {
    const node = nodes.get(id);
    if (node) node.remove();
    nodes.delete(id);
    shapes.delete(id);
    selected.delete(id);
    if (editing && editing.id === id) stopEditing(false);
  }

  /* ----------------------------------------------------------- editing */

  function startEditing(shape, fresh) {
    if (editing) stopEditing(true);
    editing = { id: shape.id, original: clone(shape), fresh: Boolean(fresh) };
    const node = nodes.get(shape.id);
    if (node) node.classList.add("is-editing");
    editor.value = shape.props.text || "";
    editor.dataset.kind = shape.kind;
    editor.dataset.color = shape.props.color || "ink";
    editor.hidden = false;
    placeEditor();
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  function placeEditor() {
    if (!editing) return;
    const s = shapes.get(editing.id);
    if (!s) return;
    const k = view.scale;
    const size = s.kind === "text" ? s.props.size || TEXT_SIZE : NOTE_FONT;
    const pad = s.kind === "text" ? 4 : NOTE_PAD;
    editor.style.left = view.x + s.x * k + "px";
    editor.style.top = view.y + s.y * k + "px";
    editor.style.width = Math.max(s.w * k, 40) + "px";
    editor.style.height = Math.max(s.h * k, size * 1.25 * k) + "px";
    editor.style.fontSize = size * k + "px";
    editor.style.lineHeight = String(s.kind === "text" ? 1.25 : LINE_HEIGHT);
    editor.style.padding = pad * k + "px";
    editor.style.textAlign = s.kind === "rect" || s.kind === "ellipse" ? "center" : "left";
  }

  function stopEditing(commit) {
    if (!editing) return;
    const { id, original, fresh } = editing;
    editing = null;
    editor.hidden = true;
    const s = shapes.get(id);
    const node = nodes.get(id);
    if (node) node.classList.remove("is-editing");
    if (!s) return;
    const text = commit ? editor.value.slice(0, MAX_TEXT).replace(/\s+$/, "") : original.props.text;
    if (s.kind === "text" && !text.trim()) {
      // An empty text label has nothing to show: it goes away.
      if (fresh) removeNode(id);
      else deleteShapes([id]);
      renderSelection();
      svg.focus({ preventScroll: true });
      return;
    }
    s.props.text = text;
    if (s.kind === "text") textSize(s);
    renderShape(s);
    renderSelection();
    if (fresh) emitPut(s, null);
    else if (text !== original.props.text) emitPut(s, original);
    svg.focus({ preventScroll: true });
  }

  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      stopEditing(false);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      stopEditing(true);
    }
  });
  editor.addEventListener("blur", () => stopEditing(true));
  editor.addEventListener("input", () => {
    if (!editing) return;
    const s = shapes.get(editing.id);
    if (!s || s.kind !== "text") return;
    s.props.text = editor.value.slice(0, MAX_TEXT);
    textSize(s);
    placeEditor();
  });

  /* ------------------------------------------------------------ pointer */

  svg.addEventListener("pointerdown", onDown);
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerup", onUp);
  svg.addEventListener("pointercancel", onUp);
  svg.addEventListener("dblclick", onDoubleClick);
  svg.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("contextmenu", (event) => event.preventDefault());

  function onDown(event) {
    if (event.pointerType === "mouse" && event.button > 1) return;
    if (editing) stopEditing(true);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (event.pointerType === "touch" && pointers.size === 2) {
      cancelDrag();
      startPinch();
      return;
    }
    if (pointers.size > 1) return;

    svg.setPointerCapture(event.pointerId);
    svg.focus({ preventScroll: true });
    const p = toBoard(event.clientX, event.clientY);
    const panning = tool === "hand" || event.button === 1 || spaceHeld;
    if (panning) {
      drag = { type: "pan", sx: event.clientX, sy: event.clientY, vx: view.x, vy: view.y };
      svg.classList.add("is-panning");
      return;
    }

    const handle = event.target.closest("[data-handle]");
    const shapeNode = event.target.closest(".shape");

    if (tool === "select") {
      if (handle && selected.size === 1) {
        const s = shapes.get([...selected][0]);
        drag = { type: "resize", handle: handle.dataset.handle, start: p, origin: clone(s), id: s.id };
        activeIds.add(s.id);
      } else if (shapeNode) {
        const id = shapeNode.dataset.id;
        if (event.shiftKey) {
          if (selected.has(id)) selected.delete(id);
          else selected.add(id);
          renderSelection();
        } else if (!selected.has(id)) {
          select([id]);
        }
        const origin = new Map();
        for (const sid of selected) origin.set(sid, clone(shapes.get(sid)));
        drag = { type: "move", start: p, origin, moved: false, lastPut: 0 };
        for (const sid of selected) activeIds.add(sid);
      } else {
        if (!event.shiftKey) clearSelection();
        drag = { type: "marquee", start: p, additive: event.shiftKey };
      }
      return;
    }

    if (tool === "note" || tool === "rect" || tool === "ellipse") {
      drag = { type: "create", kind: tool, start: p };
    } else if (tool === "line") {
      drag = { type: "line", start: p, arrow: event.shiftKey };
    } else if (tool === "pen") {
      const id = crypto.randomUUID();
      drag = { type: "pen", id, points: [[round(p.x), round(p.y)]], last: p };
      showInk(null, id, drag.points, color, PEN_WIDTH);
      if (options.onInk) options.onInk(id, "start", color, PEN_WIDTH);
      if (options.onInk) options.onInk(id, p, color, PEN_WIDTH);
    } else if (tool === "text") {
      // Created on pointer up: focusing the editor during pointer down would
      // lose to the browser moving focus to the canvas a moment later.
      drag = { type: "text", start: p };
    }
  }

  function onMove(event) {
    if (pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (pinch) {
      movePinch();
      return;
    }
    const p = toBoard(event.clientX, event.clientY);
    if (options.onCursor) options.onCursor(p.x, p.y);
    if (!drag) return;

    switch (drag.type) {
      case "pan":
        view.x = drag.vx + (event.clientX - drag.sx);
        view.y = drag.vy + (event.clientY - drag.sy);
        applyView();
        break;
      case "move": {
        const dx = p.x - drag.start.x;
        const dy = p.y - drag.start.y;
        if (!drag.moved && Math.hypot(dx, dy) * view.scale < 3) return;
        drag.moved = true;
        for (const [id, o] of drag.origin) {
          const s = shapes.get(id);
          if (!s) continue;
          s.x = round(o.x + dx);
          s.y = round(o.y + dy);
          if (s.kind === "line") {
            s.props.x2 = round(o.props.x2 + dx);
            s.props.y2 = round(o.props.y2 + dy);
          }
          renderShape(s);
        }
        renderSelection();
        livePuts(drag, [...drag.origin.keys()]);
        break;
      }
      case "resize": {
        const s = shapes.get(drag.id);
        if (!s) return;
        resizeTo(s, drag.origin, drag.handle, p, event.shiftKey);
        renderShape(s);
        renderSelection();
        livePuts(drag, [s.id]);
        break;
      }
      case "marquee":
      case "create":
        showPreviewRect(drag.start, p, drag.type === "create" ? drag.kind : "marquee");
        break;
      case "line":
        showPreviewLine(drag.start, p);
        break;
      case "pen": {
        const last = drag.last;
        if (Math.hypot(p.x - last.x, p.y - last.y) * view.scale < 1.5) return;
        if (drag.points.length >= MAX_POINTS) return;
        drag.last = p;
        drag.points.push([round(p.x), round(p.y)]);
        showInk(null, drag.id, drag.points, color, PEN_WIDTH);
        if (options.onInk) options.onInk(drag.id, p, color, PEN_WIDTH);
        break;
      }
    }
  }

  function livePuts(d, ids) {
    const now = performance.now();
    if (now - (d.lastPut || 0) < LIVE_PUT_INTERVAL) return;
    d.lastPut = now;
    for (const id of ids) {
      const s = shapes.get(id);
      if (s) emitPut(s, null, true);
    }
  }

  function onUp(event) {
    pointers.delete(event.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    if (!drag) return;
    const d = drag;
    drag = null;
    svg.classList.remove("is-panning");
    previewLayer.textContent = "";
    const p = toBoard(event.clientX, event.clientY);

    switch (d.type) {
      case "move":
        for (const [id, o] of d.origin) {
          activeIds.delete(id);
          const s = shapes.get(id);
          if (s && d.moved) emitPut(s, o);
        }
        break;
      case "resize": {
        activeIds.delete(d.id);
        const s = shapes.get(d.id);
        if (s) emitPut(s, d.origin);
        break;
      }
      case "marquee": {
        const box = normalize(d.start, p);
        const hits = [...shapes.values()]
          .filter((s) => intersects(box, bbox(s)))
          .map((s) => s.id);
        if (d.additive) for (const id of hits) selected.add(id);
        else select(hits);
        renderSelection();
        break;
      }
      case "create": {
        let box = normalize(d.start, p);
        if (box.w * view.scale < 8 || box.h * view.scale < 8) {
          const [w, h] = DEFAULT_SIZE[d.kind];
          box = { x: d.start.x - w / 2, y: d.start.y - h / 2, w, h };
        }
        const s = newShape(d.kind, box.x, box.y, box.w, box.h, { text: "", color });
        addShape(s);
        emitPut(s, null);
        setTool("select");
        select([s.id]);
        if (d.kind === "note") startEditing(s, false);
        break;
      }
      case "line": {
        if (Math.hypot(p.x - d.start.x, p.y - d.start.y) * view.scale < 4) break;
        const s = newShape(
          "line",
          d.start.x,
          d.start.y,
          Math.max(1, Math.abs(p.x - d.start.x)),
          Math.max(1, Math.abs(p.y - d.start.y)),
          { x2: round(p.x), y2: round(p.y), arrow: d.arrow, color },
        );
        addShape(s);
        emitPut(s, null);
        setTool("select");
        select([s.id]);
        break;
      }
      case "text": {
        const s = newShape("text", d.start.x, d.start.y - TEXT_SIZE * 0.6, 40, TEXT_SIZE * 1.25, {
          text: "",
          color,
          size: TEXT_SIZE,
        });
        addShape(s);
        select([s.id]);
        startEditing(s, true);
        break;
      }
      case "pen": {
        clearInk(d.id);
        if (options.onInk) options.onInk(d.id, "end", color, PEN_WIDTH);
        const pts = d.points;
        if (pts.length === 1) pts.push([pts[0][0] + 0.5, pts[0][1]]);
        let x1 = Infinity;
        let y1 = Infinity;
        let x2 = -Infinity;
        let y2 = -Infinity;
        for (const [x, y] of pts) {
          x1 = Math.min(x1, x);
          y1 = Math.min(y1, y);
          x2 = Math.max(x2, x);
          y2 = Math.max(y2, y);
        }
        const s = newShape("pen", x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1), {
          points: pts.map(([x, y]) => [round(x - x1), round(y - y1)]),
          color,
          width: PEN_WIDTH,
        });
        s.id = d.id;
        addShape(s);
        emitPut(s, null);
        break;
      }
    }
  }

  function cancelDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    previewLayer.textContent = "";
    svg.classList.remove("is-panning");
    if (d.type === "move" || d.type === "resize") {
      const origins = d.type === "move" ? d.origin : new Map([[d.id, d.origin]]);
      for (const [id, o] of origins) {
        activeIds.delete(id);
        if (shapes.has(id)) {
          shapes.set(id, clone(o));
          renderShape(shapes.get(id));
        }
      }
      renderSelection();
    } else if (d.type === "pen") {
      clearInk(d.id);
      if (options.onInk) options.onInk(d.id, "end", color, PEN_WIDTH);
    }
  }

  function resizeTo(s, o, handle, p, keepAspect) {
    if (s.kind === "line") {
      if (handle === "a") {
        s.x = round(p.x);
        s.y = round(p.y);
      } else {
        s.props.x2 = round(p.x);
        s.props.y2 = round(p.y);
      }
      s.w = Math.max(1, Math.abs(s.props.x2 - s.x));
      s.h = Math.max(1, Math.abs(s.props.y2 - s.y));
      return;
    }
    let x1 = o.x;
    let y1 = o.y;
    let x2 = o.x + o.w;
    let y2 = o.y + o.h;
    if (handle.includes("w")) x1 = Math.min(p.x, x2 - MIN_SIZE);
    if (handle.includes("e")) x2 = Math.max(p.x, x1 + MIN_SIZE);
    if (handle.includes("n")) y1 = Math.min(p.y, y2 - MIN_SIZE);
    if (handle.includes("s")) y2 = Math.max(p.y, y1 + MIN_SIZE);
    if (keepAspect) {
      const ratio = o.w / o.h;
      const w = x2 - x1;
      const h = w / ratio;
      if (handle.includes("n")) y1 = y2 - h;
      else y2 = y1 + h;
    }
    s.x = round(x1);
    s.y = round(y1);
    s.w = round(x2 - x1);
    s.h = round(y2 - y1);
    if (s.kind === "pen") {
      const kx = s.w / o.w;
      const ky = s.h / o.h;
      s.props.points = o.props.points.map(([x, y]) => [round(x * kx), round(y * ky)]);
    }
  }

  function showPreviewRect(a, b, kind) {
    previewLayer.textContent = "";
    const box = normalize(a, b);
    const attrs = {
      class: "preview preview--" + kind,
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      "vector-effect": "non-scaling-stroke",
    };
    if (kind === "ellipse") {
      previewLayer.append(
        el("ellipse", {
          class: attrs.class,
          cx: box.x + box.w / 2,
          cy: box.y + box.h / 2,
          rx: box.w / 2,
          ry: box.h / 2,
          "vector-effect": "non-scaling-stroke",
        }),
      );
    } else previewLayer.append(el("rect", attrs));
  }

  function showPreviewLine(a, b) {
    previewLayer.textContent = "";
    previewLayer.append(
      el("line", {
        class: "preview preview--line",
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        "vector-effect": "non-scaling-stroke",
      }),
    );
  }

  function onDoubleClick(event) {
    if (tool !== "select") return;
    const node = event.target.closest(".shape");
    if (!node) return;
    const s = shapes.get(node.dataset.id);
    if (!s || s.kind === "line" || s.kind === "pen") return;
    select([s.id]);
    startEditing(s, false);
  }

  function onWheel(event) {
    event.preventDefault();
    if (editing) stopEditing(true);
    if (event.ctrlKey || event.metaKey) {
      zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.01));
    } else {
      view.x -= event.deltaX;
      view.y -= event.deltaY;
      applyView();
    }
  }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      view: { ...view },
    };
  }

  function movePinch() {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const factor = clamp(dist / pinch.dist, MIN_SCALE / pinch.view.scale, MAX_SCALE / pinch.view.scale);
    const r = svg.getBoundingClientRect();
    const ox = pinch.cx - r.left;
    const oy = pinch.cy - r.top;
    view.scale = pinch.view.scale * factor;
    view.x = ox - (ox - pinch.view.x) * factor + (cx - pinch.cx);
    view.y = oy - (oy - pinch.view.y) * factor + (cy - pinch.cy);
    applyView();
  }

  /* ------------------------------------------------------------ peers */

  function placeCursor(entry) {
    if (!entry.node) return;
    const k = 1 / view.scale;
    entry.node.style.transform =
      "translate(" + entry.x + "px, " + entry.y + "px) scale(" + k + ")";
  }

  function cursorNode(entry) {
    const node = document.createElementNS(SVG, "g");
    node.classList.add("cursor");
    node.dataset.color = String(entry.peer.color);
    node.append(
      el("path", { class: "cursor__arrow", d: "M0 0L0 15L4.2 11.6L7 17.5L9.4 16.4L6.6 10.6L12 10.4Z" }),
    );
    const tag = document.createElementNS(SVG, "g");
    tag.setAttribute("transform", "translate(13 15)");
    measure.font = "11px " + family;
    const width = Math.ceil(measure.measureText(entry.peer.name).width) + 12;
    tag.append(
      el("rect", { class: "cursor__tag", width, height: 18, rx: 5 }),
      el("text", { class: "cursor__name", x: 6, y: 12.5 }),
    );
    tag.lastChild.textContent = entry.peer.name;
    node.append(tag);
    cursorsLayer.append(node);
    return node;
  }

  function setPeers(list) {
    for (const entry of peers.values()) if (entry.node) entry.node.remove();
    peers.clear();
    for (const peer of list) addPeer(peer);
  }

  function addPeer(peer) {
    removePeer(peer.cid);
    peers.set(peer.cid, { peer, node: null, x: 0, y: 0 });
  }

  function removePeer(cid) {
    const entry = peers.get(cid);
    if (!entry) return;
    if (entry.node) entry.node.remove();
    peers.delete(cid);
    for (const [id, ink] of inks) if (ink.cid === cid) clearInk(id);
  }

  function renamePeer(cid, name) {
    const entry = peers.get(cid);
    if (!entry) return;
    entry.peer.name = name;
    if (entry.node) {
      entry.node.remove();
      entry.node = cursorNode(entry);
      placeCursor(entry);
    }
  }

  function setCursor(cid, x, y) {
    const entry = peers.get(cid);
    if (!entry) return;
    entry.x = x;
    entry.y = y;
    if (!entry.node) entry.node = cursorNode(entry);
    placeCursor(entry);
  }

  /* -------------------------------------------------------------- ink */

  function showInk(cid, id, points, inkColor, width) {
    let entry = inks.get(id);
    if (!entry) {
      entry = {
        cid,
        points: [],
        at: 0,
        node: el("path", { class: "ink", "data-color": inkColor }),
      };
      entry.node.style.strokeWidth = width + "px";
      inksLayer.append(entry.node);
      inks.set(id, entry);
    }
    entry.at = performance.now();
    entry.points = points;
    entry.node.setAttribute("d", smoothPath(points));
  }

  function setInk(cid, id, points, inkColor, width) {
    const entry = inks.get(id);
    const all = entry ? entry.points.concat(points) : points;
    showInk(cid, id, all.slice(-MAX_POINTS), inkColor, width);
  }

  function clearInk(id) {
    const entry = inks.get(id);
    if (!entry) return;
    entry.node.remove();
    inks.delete(id);
  }

  const inkSweep = setInterval(() => {
    const now = performance.now();
    for (const [id, entry] of inks) {
      if (entry.cid !== null && now - entry.at > INK_STALE_MS) clearInk(id);
    }
  }, 5000);

  /* ----------------------------------------------------------- keyboard */

  const TOOL_KEYS = { v: "select", h: "hand", n: "note", r: "rect", o: "ellipse", l: "line", p: "pen", t: "text" };

  function handleKey(event) {
    if (editing) return false;
    const meta = event.metaKey || event.ctrlKey;
    const key = event.key;

    if (key === " ") {
      if (!spaceHeld) {
        spaceHeld = true;
        svg.classList.add("is-space");
      }
      return true;
    }
    if (meta && key.toLowerCase() === "a") {
      select([...shapes.keys()]);
      return true;
    }
    if (meta && key === "]") {
      bringToFront();
      return true;
    }
    if (meta) return false;

    if (key === "Delete" || key === "Backspace") {
      deleteSelection();
      return true;
    }
    if (key === "Escape") {
      if (drag) cancelDrag();
      else if (selected.size) clearSelection();
      else setTool("select");
      return true;
    }
    if (key === "Enter" && selected.size === 1) {
      const s = shapes.get([...selected][0]);
      if (s && s.kind !== "line" && s.kind !== "pen") {
        startEditing(s, false);
        return true;
      }
    }
    if (key === "=" || key === "+") {
      zoomCenter(1.25);
      return true;
    }
    if (key === "-" || key === "_") {
      zoomCenter(0.8);
      return true;
    }
    if (key === "0") {
      resetView();
      return true;
    }
    if (key === "1") {
      zoomToFit();
      return true;
    }
    if (key.startsWith("Arrow") && selected.size) {
      const step = event.shiftKey ? 10 : 1;
      const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
      const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
      nudge(dx, dy);
      return true;
    }
    const next = TOOL_KEYS[key.toLowerCase()];
    if (next && !event.shiftKey && !event.altKey) {
      setTool(next);
      return true;
    }
    return false;
  }

  function handleKeyUp(event) {
    if (event.key === " ") {
      spaceHeld = false;
      svg.classList.remove("is-space");
      return true;
    }
    return false;
  }

  function nudge(dx, dy) {
    for (const id of selected) {
      const s = shapes.get(id);
      if (!s) continue;
      const prev = clone(s);
      s.x = round(s.x + dx);
      s.y = round(s.y + dy);
      if (s.kind === "line") {
        s.props.x2 = round(s.props.x2 + dx);
        s.props.y2 = round(s.props.y2 + dy);
      }
      renderShape(s);
      emitPut(s, prev);
    }
    renderSelection();
  }

  /* ------------------------------------------------------------- api */

  function setTool(next) {
    if (!TOOLS.includes(next) || next === tool) return;
    if (drag) cancelDrag();
    tool = next;
    svg.dataset.tool = tool;
    if (tool !== "select") clearSelection();
    if (options.onTool) options.onTool(tool);
  }

  function setColor(next) {
    if (!COLORS.includes(next)) return;
    color = next;
    if (options.onColor) options.onColor(color);
    for (const id of selected) {
      const s = shapes.get(id);
      if (!s || s.props.color === next) continue;
      const prev = clone(s);
      s.props.color = next;
      renderShape(s);
      emitPut(s, prev);
    }
  }

  function deleteSelection() {
    if (!selected.size) return;
    deleteShapes([...selected]);
  }

  function bringToFront() {
    for (const id of selected) {
      const s = shapes.get(id);
      if (!s) continue;
      const prev = clone(s);
      s.z = nextZ();
      renderShape(s);
      emitPut(s, prev);
    }
  }

  function setShapes(list, fit) {
    if (editing) stopEditing(false);
    for (const node of nodes.values()) node.remove();
    nodes.clear();
    shapes.clear();
    maxZ = 0;
    for (const s of list) shapes.set(s.id, s);
    for (const s of [...shapes.values()].sort((a, b) => a.z - b.z)) renderShape(s, true);
    for (const id of [...selected]) if (!shapes.has(id)) selected.delete(id);
    renderSelection();
    if (fit) zoomToFit();
  }

  // An echo for a shape under the pointer is skipped; the drag's final put
  // reaches the board after it and settles the matter for everyone.
  function applyPut(shape) {
    if (activeIds.has(shape.id)) return;
    if (editing && editing.id === shape.id) return;
    shapes.set(shape.id, shape);
    renderShape(shape);
    clearInk(shape.id);
    if (selected.has(shape.id)) renderSelection();
  }

  function applyDel(ids) {
    let touched = false;
    for (const id of ids) {
      if (!shapes.has(id)) continue;
      removeNode(id);
      touched = true;
    }
    if (touched) renderSelection();
  }

  function clear() {
    if (editing) stopEditing(false);
    cancelDrag();
    setShapes([], false);
    setPeers([]);
    for (const id of [...inks.keys()]) clearInk(id);
    clearSelection();
  }

  function getView() {
    return { ...view };
  }

  function setView(next) {
    if (!next || !Number.isFinite(next.scale)) return;
    view.x = next.x;
    view.y = next.y;
    view.scale = clamp(next.scale, MIN_SCALE, MAX_SCALE);
    applyView();
  }

  function destroy() {
    clearInterval(inkSweep);
    clear();
  }

  svg.dataset.tool = tool;
  resetView();

  return {
    setShapes,
    applyPut,
    applyDel,
    clear,
    setPeers,
    addPeer,
    removePeer,
    renamePeer,
    setCursor,
    setInk,
    clearInk,
    setTool,
    setColor,
    deleteSelection,
    bringToFront,
    zoomIn: () => zoomCenter(1.25),
    zoomOut: () => zoomCenter(0.8),
    zoomToFit,
    resetView,
    getView,
    setView,
    handleKey,
    handleKeyUp,
    isEditing: () => editing !== null,
    stopEditing,
    shapeCount: () => shapes.size,
    getTool: () => tool,
    getColor: () => color,
    destroy,
  };
}

/* ------------------------------------------------------------------ utils */

function clone(value) {
  return structuredClone(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function normalize(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
