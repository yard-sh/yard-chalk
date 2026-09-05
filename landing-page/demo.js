// The hero board is a real whiteboard: draw on it with the pen, drop and
// drag sticky notes, and a scripted second cursor called Sam keeps working
// alongside you. Nothing persists, and Sam stops when the board is off
// screen or the visitor prefers reduced motion.
(function () {
  "use strict";

  var svg = document.getElementById("wb-svg");
  if (!svg) return;

  var NS = "http://www.w3.org/2000/svg";
  var notes = document.getElementById("wb-notes");
  var strokes = document.getElementById("wb-strokes");
  var cursor = document.getElementById("wb-cursor");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  var W = 800;
  var H = 440;
  var NOTE_W = 132;
  var NOTE_H = 96;
  var MAX_STROKES = 200;
  var NOTE_TEXT = ["Ship it Friday", "Ask Sam", "Kickoff at 10", "Needs a name", "Fix the copy", "Try the blue one"];
  var nextText = 0;

  function el(name, attrs, parent) {
    var node = document.createElementNS(NS, name);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    if (parent) parent.appendChild(node);
    return node;
  }

  function boardPoint(event) {
    var p = svg.createSVGPoint();
    p.x = event.clientX;
    p.y = event.clientY;
    var m = svg.getScreenCTM();
    return m ? p.matrixTransform(m.inverse()) : p;
  }

  function pathD(points) {
    var d = "";
    for (var i = 0; i < points.length; i++) {
      d += (i ? " L" : "M") + points[i][0].toFixed(1) + " " + points[i][1].toFixed(1);
    }
    return d;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /* ---------------------------------------------------------------- notes */

  function wrap(text) {
    var words = text.split(" ");
    var lines = [""];
    words.forEach(function (word) {
      var line = lines[lines.length - 1];
      if (line && (line + " " + word).length > 14) lines.push(word);
      else lines[lines.length - 1] = line ? line + " " + word : word;
    });
    return lines.slice(0, 3);
  }

  function addNote(x, y, text) {
    var g = el("g", { class: "wb-note", transform: "translate(" + x + "," + y + ")" }, notes);
    el("rect", { class: "wb-note__paper", width: NOTE_W, height: NOTE_H, rx: 3 }, g);
    var label = el("text", { class: "wb-note__text", x: 12, y: 26 }, g);
    wrap(text).forEach(function (line, i) {
      var span = el("tspan", { x: 12, dy: i ? 20 : 0 }, label);
      span.textContent = line;
    });
    g._x = x;
    g._y = y;
    return g;
  }

  function moveNote(g, x, y) {
    g._x = x;
    g._y = y;
    g.setAttribute("transform", "translate(" + x.toFixed(1) + "," + y.toFixed(1) + ")");
  }

  function dropNote(x, y) {
    var text = NOTE_TEXT[nextText++ % NOTE_TEXT.length];
    if (x === undefined) {
      x = 40 + Math.random() * (W - NOTE_W - 80);
      y = 40 + Math.random() * (H - NOTE_H - 80);
    }
    return addNote(clamp(x - NOTE_W / 2, 0, W - NOTE_W), clamp(y - NOTE_H / 2, 0, H - NOTE_H), text);
  }

  /* -------------------------------------------------------------- strokes */

  function startStroke(className) {
    while (strokes.childElementCount >= MAX_STROKES) strokes.removeChild(strokes.firstChild);
    var path = el("path", { class: "wb-stroke" + (className ? " " + className : "") }, strokes);
    path._points = [];
    return path;
  }

  function extendStroke(path, x, y) {
    var pts = path._points;
    var last = pts[pts.length - 1];
    if (last && Math.hypot(last[0] - x, last[1] - y) < 1.5) return;
    pts.push([x, y]);
    path.setAttribute("d", pathD(pts.length === 1 ? [pts[0], pts[0]] : pts));
  }

  /* -------------------------------------------------------- the visitor */

  var hand = null; // { kind: "pen" | "note", pointerId, path | note, dx, dy }

  svg.addEventListener("pointerdown", function (event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (hand) return;
    var p = boardPoint(event);
    var note = event.target.closest && event.target.closest(".wb-note");
    if (note) {
      note.classList.add("is-dragging");
      notes.appendChild(note);
      hand = { kind: "note", pointerId: event.pointerId, note: note, dx: p.x - note._x, dy: p.y - note._y };
    } else {
      var path = startStroke("wb-stroke--ink");
      extendStroke(path, p.x, p.y);
      hand = { kind: "pen", pointerId: event.pointerId, path: path };
    }
    svg.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  svg.addEventListener("pointermove", function (event) {
    if (!hand || event.pointerId !== hand.pointerId) return;
    var p = boardPoint(event);
    if (hand.kind === "pen") {
      extendStroke(hand.path, clamp(p.x, 0, W), clamp(p.y, 0, H));
    } else {
      moveNote(hand.note, clamp(p.x - hand.dx, 0, W - NOTE_W), clamp(p.y - hand.dy, 0, H - NOTE_H));
    }
  });

  function release(event) {
    if (!hand || event.pointerId !== hand.pointerId) return;
    if (hand.kind === "note") hand.note.classList.remove("is-dragging");
    else if (hand.path._points.length < 2) strokes.removeChild(hand.path);
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    hand = null;
  }

  svg.addEventListener("pointerup", release);
  svg.addEventListener("pointercancel", release);

  svg.addEventListener("dblclick", function (event) {
    if (event.target.closest && event.target.closest(".wb-note")) return;
    var p = boardPoint(event);
    dropNote(p.x, p.y);
  });

  document.getElementById("wb-note").addEventListener("click", function () {
    dropNote();
  });

  document.getElementById("wb-clear").addEventListener("click", function () {
    while (notes.firstChild) notes.removeChild(notes.firstChild);
    while (strokes.firstChild) strokes.removeChild(strokes.firstChild);
  });

  /* ------------------------------------------------------------------ Sam */
  //
  // Sam's gestures are polylines relative to a centre point. Each one is
  // drawn at marker speed with the cursor riding the pen tip, and between
  // gestures the cursor glides to where the next one starts.

  var sam = { x: W * 0.7, y: H * 0.3, running: false, timer: null, frame: null, visible: false };

  function ring(rx, ry) {
    var pts = [];
    for (var a = -0.6; a < Math.PI * 2 + 0.2; a += 0.22) {
      pts.push([Math.cos(a) * rx + (Math.random() - 0.5) * 3, Math.sin(a) * ry + (Math.random() - 0.5) * 3]);
    }
    return [pts];
  }

  var GESTURES = [
    function () { return ring(NOTE_W * 0.66, NOTE_H * 0.78); },
    function () { return [[[-22, 2], [-8, 16], [24, -18]]]; },
    function () { return [[[-40, 10], [40, -10]], [[40, -10], [26, -14]], [[40, -10], [34, 2]]]; },
    function () { return [[[-46, 0], [-20, 4], [10, -3], [46, 2]]]; },
    function () { return [[[0, -22], [7, -6], [22, -5], [10, 5], [14, 21], [0, 12], [-14, 21], [-10, 5], [-22, -5], [-7, -6], [0, -22]]]; },
  ];

  function sample(points, step) {
    var out = [points[0]];
    for (var i = 1; i < points.length; i++) {
      var a = points[i - 1];
      var b = points[i];
      var len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      var n = Math.max(1, Math.round(len / step));
      for (var k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
    return out;
  }

  function placeCursor(x, y) {
    sam.x = x;
    sam.y = y;
    cursor.setAttribute("transform", "translate(" + x.toFixed(1) + "," + y.toFixed(1) + ")");
  }

  function ease(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  // Runs step(progress) every frame for `ms`, then done(). Stops cold if Sam
  // is paused, and the loop restarts from scratch on resume.
  function animate(ms, step, done) {
    var start = null;
    function tick(now) {
      if (!sam.running) return;
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / ms);
      step(t);
      if (t < 1) sam.frame = requestAnimationFrame(tick);
      else done();
    }
    sam.frame = requestAnimationFrame(tick);
  }

  function glide(x, y, done) {
    var fx = sam.x;
    var fy = sam.y;
    var ms = clamp(Math.hypot(x - fx, y - fy) * 1.6, 260, 900);
    animate(ms, function (t) {
      var e = ease(t);
      placeCursor(fx + (x - fx) * e, fy + (y - fy) * e);
    }, done);
  }

  function drawSegments(segments, cx, cy, done) {
    if (!segments.length) return done();
    var pts = sample(segments[0], 3).map(function (p) { return [cx + p[0], cy + p[1]]; });
    glide(pts[0][0], pts[0][1], function () {
      var path = startStroke("");
      animate(pts.length * 14, function (t) {
        var upto = Math.max(1, Math.round(t * pts.length));
        while (path._points.length < upto) {
          var p = pts[path._points.length];
          extendStroke(path, p[0], p[1]);
          placeCursor(p[0], p[1]);
        }
      }, function () {
        drawSegments(segments.slice(1), cx, cy, done);
      });
    });
  }

  function samDraws(done) {
    var gesture = GESTURES[Math.floor(Math.random() * GESTURES.length)]();
    var target = notes.children[Math.floor(Math.random() * notes.childElementCount)];
    var cx;
    var cy;
    if (target && Math.random() < 0.6) {
      cx = target._x + NOTE_W / 2;
      cy = target._y + NOTE_H / 2;
    } else {
      cx = 80 + Math.random() * (W - 160);
      cy = 70 + Math.random() * (H - 140);
    }
    drawSegments(gesture, cx, cy, done);
  }

  function samMovesNote(done) {
    var note = notes.children[Math.floor(Math.random() * notes.childElementCount)];
    if (!note) return samDraws(done);
    var gx = note._x + NOTE_W * 0.55;
    var gy = note._y + NOTE_H * 0.4;
    glide(gx, gy, function () {
      var fx = note._x;
      var fy = note._y;
      var tx = clamp(fx + (Math.random() - 0.5) * 260, 0, W - NOTE_W);
      var ty = clamp(fy + (Math.random() - 0.5) * 160, 0, H - NOTE_H);
      notes.appendChild(note);
      animate(700, function (t) {
        var e = ease(t);
        moveNote(note, fx + (tx - fx) * e, fy + (ty - fy) * e);
        placeCursor(note._x + NOTE_W * 0.55, note._y + NOTE_H * 0.4);
      }, done);
    });
  }

  function samLoop() {
    if (!sam.running) return;
    var act = notes.childElementCount && Math.random() < 0.4 ? samMovesNote : samDraws;
    act(function () {
      sam.timer = setTimeout(samLoop, 1800 + Math.random() * 2600);
    });
  }

  function shouldRun() {
    return sam.visible && !reduced.matches && !document.hidden;
  }

  function syncSam() {
    var want = shouldRun();
    if (want === sam.running) return;
    sam.running = want;
    cursor.style.opacity = want ? "1" : "0";
    clearTimeout(sam.timer);
    if (sam.frame) cancelAnimationFrame(sam.frame);
    if (want) sam.timer = setTimeout(samLoop, 600);
  }

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      sam.visible = entries[0].isIntersecting;
      syncSam();
    }, { threshold: 0.25 }).observe(svg);
  } else {
    sam.visible = true;
  }
  document.addEventListener("visibilitychange", syncSam);
  if (reduced.addEventListener) reduced.addEventListener("change", syncSam);

  /* ----------------------------------------------------------------- seed */

  addNote(96, 78, "Kickoff at 10");
  addNote(316, 210, "Sam: bring the sketches");
  var seedArrow = startStroke("");
  [[248, 128], [290, 170], [318, 206]].forEach(function (p) { extendStroke(seedArrow, p[0], p[1]); });
  placeCursor(W * 0.7, H * 0.3);
  cursor.style.opacity = "0";
  syncSam();
})();
