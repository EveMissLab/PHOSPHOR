"use strict";

/**
 * phosphor_ui/app.js -- minimal, no-build-step viewer for the PHOSPHOR MCCP
 * API (phosphor_api/app.py). Two views, side by side:
 *
 *   1. The raw viztracer trace, embedded via Perfetto's documented
 *      postMessage embedding protocol (https://ui.perfetto.dev, "Embedding
 *      Perfetto UI"): PING/PONG handshake, then
 *      `{perfetto: {buffer: ArrayBuffer, title, fileName, keepApiOpen}}`.
 *   2. A plain SVG render of GET /api/projection (macro|meso): nodes as
 *      circles, edges as arrowed curves labelled with count/avg latency.
 *      Clicking a node calls POST /api/explain and renders the returned
 *      Explanation's claims in a panel anchored near that node, each claim
 *      tagged with a colored evidence_level badge (Hallucination Control:
 *      observed/verified are the trustworthy end, inferred/hypothesized are
 *      the "this was not actually witnessed" end -- see index.html's CSS
 *      variables for the exact colors).
 *
 * A third and fourth view, switched via tabs in the graph pane's header
 * (the Perfetto pane always stays visible):
 *   3. Complexity Lens (GET /api/complexity) -- per-node cost, top-K most
 *      expensive edges, relation breakdown. Plain HTML tables, no charting
 *      library -- this does not need to be beautiful, it needs to show real
 *      numbers from real data.
 *   4. Bug Lens (GET /api/bugs) -- real captured error events (with their
 *      real exception detail, linked to a calling function where
 *      resolvable) and traffic-explosion hotspot edges. Explicitly does NOT
 *      claim to detect retry/timeout/wait/lock -- see
 *      phosphor_projector/project.py's own module docstring for why; this
 *      UI only ever renders what the backend actually returns.
 *
 * No dependencies, no build step -- this file is served as-is by
 * phosphor_api's StaticFiles mount.
 */

const PERFETTO_ORIGIN = "https://ui.perfetto.dev";

const NODE_COLORS = {
  function: "var(--node-function)",
  file: "var(--node-file)",
  process: "var(--node-process)",
  thread: "var(--node-thread)",
  host: "var(--node-host)",
  database: "var(--node-database)",
};

// -- DOM handles -------------------------------------------------------

const traceInput = document.getElementById("trace-input");
const traceListEl = document.getElementById("trace-list");
const loadBtn = document.getElementById("load-btn");
const refreshBtn = document.getElementById("refresh-btn");
const statusEl = document.getElementById("status");
const scaleRadios = document.querySelectorAll('input[name="scale"]');
const graphMetaEl = document.getElementById("graph-meta");
const graphWrap = document.getElementById("graph-wrap");
const svg = document.getElementById("graph-svg");
const edgesLayer = document.getElementById("edges-layer");
const nodesLayer = document.getElementById("nodes-layer");
const emptyGraphMsg = document.getElementById("empty-graph-msg");
const perfettoIframe = document.getElementById("perfetto-iframe");
const explainPanel = document.getElementById("explain-panel");
const explainContent = document.getElementById("explain-content");
const explainClose = document.getElementById("explain-close");
const nodeLegendEl = document.getElementById("node-legend");
const viewTabsEl = document.getElementById("view-tabs");
const complexityViewEl = document.getElementById("complexity-view");
const bugsViewEl = document.getElementById("bugs-view");

// -- State ---------------------------------------------------------------

let currentTraceId = null;
let currentScale = "meso";
let perfettoReady = false;
let pingTimer = null;
let selectedNodeEl = null;
let currentView = "graph"; // "graph" | "complexity" | "bugs"

// -- Small helpers ---------------------------------------------------------

function setStatus(message, isError) {
  statusEl.textContent = message || "";
  statusEl.classList.toggle("error", Boolean(isError));
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    el.setAttribute(key, value);
  }
  return el;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON body (or empty) -- fall through, response.ok still governs
  }
  if (!res.ok) {
    const detail = body && body.detail ? body.detail : `${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  return body;
}

// -- Trace list (GET /api/traces, new endpoint added for this UI) --------

async function refreshTraceList() {
  try {
    const traces = await fetchJson("/api/traces");
    traceListEl.innerHTML = "";
    for (const t of traces) {
      const opt = document.createElement("option");
      opt.value = t.trace_id;
      const nodeCount = t.node_count == null ? "?" : t.node_count;
      const edgeCount = t.edge_count == null ? "?" : t.edge_count;
      opt.label = `${t.trace_id} (${nodeCount} nodes, ${edgeCount} edges)`;
      traceListEl.appendChild(opt);
    }
    if (traces.length === 0) {
      setStatus('no traces on disk yet -- run "phosphor run <script>" first');
    }
  } catch (err) {
    setStatus(`could not list traces: ${err.message}`, true);
  }
}

// -- Perfetto embed (postMessage protocol per ui.perfetto.dev docs) ------

function waitForPerfettoReady() {
  if (perfettoReady) return Promise.resolve();
  return new Promise((resolve) => {
    pingTimer = setInterval(() => {
      perfettoIframe.contentWindow.postMessage("PING", PERFETTO_ORIGIN);
    }, 100);
    window.addEventListener("message", function onMsg(evt) {
      if (evt.origin === PERFETTO_ORIGIN && evt.source === perfettoIframe.contentWindow && evt.data === "PONG") {
        clearInterval(pingTimer);
        window.removeEventListener("message", onMsg);
        perfettoReady = true;
        resolve();
      }
    });
  });
}

async function loadPerfettoTrace(traceId) {
  const res = await fetch(`/api/traces/${encodeURIComponent(traceId)}/viztracer`);
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && body.detail) detail = body.detail;
    } catch {
      // ignore
    }
    throw new Error(`raw trace fetch failed: ${detail}`);
  }
  const buffer = await res.arrayBuffer();
  await waitForPerfettoReady();
  perfettoIframe.contentWindow.postMessage(
    {
      perfetto: {
        buffer,
        title: `PHOSPHOR trace ${traceId}`,
        fileName: `${traceId}.viztracer.json`,
        keepApiOpen: true,
      },
    },
    PERFETTO_ORIGIN
  );
}

// -- Graph rendering (plain SVG, no charting library) ---------------------

function nodeRadiusFor(count) {
  if (count > 40) return 9;
  if (count > 20) return 12;
  if (count > 10) return 16;
  return 20;
}

function layoutCircular(nodes, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.max(60, Math.min(width, height) / 2 - 90);
  const n = nodes.length;
  const positions = new Map();
  nodes.forEach((node, i) => {
    const angle = n === 1 ? -Math.PI / 2 : (2 * Math.PI * i) / n - Math.PI / 2;
    positions.set(node.node_id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  });
  return positions;
}

function groupEdgesByPair(edges) {
  const groups = new Map();
  for (const edge of edges) {
    const key = [edge.source, edge.target].sort().join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  }
  return groups;
}

function renderLegend(nodes) {
  const typesPresent = [...new Set(nodes.map((n) => n.node_type))].sort();
  nodeLegendEl.innerHTML = typesPresent
    .map(
      (t) =>
        `<span class="legend-item"><span class="legend-swatch" style="background:${
          NODE_COLORS[t] || "var(--node-process)"
        }"></span>${escapeHtml(t)}</span>`
    )
    .join("");
}

function renderGraph(graph) {
  closeExplainPanel();
  edgesLayer.innerHTML = "";
  nodesLayer.innerHTML = "";
  selectedNodeEl = null;

  const { nodes, edges } = graph;
  graphMetaEl.textContent = `${currentTraceId} · ${currentScale} · ${nodes.length} nodes / ${edges.length} edges`;

  if (nodes.length === 0) {
    emptyGraphMsg.style.display = "flex";
    emptyGraphMsg.textContent = "This trace's graph has no nodes.";
    renderLegend([]);
    return;
  }
  emptyGraphMsg.style.display = "none";

  const viewBox = svg.viewBox.baseVal;
  const width = viewBox.width || 900;
  const height = viewBox.height || 620;
  const positions = layoutCircular(nodes, width, height);
  const radius = nodeRadiusFor(nodes.length);

  // Edges first (so node circles paint on top of edge lines).
  const pairGroups = groupEdgesByPair(edges);
  for (const groupEdges of pairGroups.values()) {
    groupEdges.forEach((edge, idx) => {
      drawEdge(edge, positions, radius, idx, groupEdges.length);
    });
  }

  // Nodes.
  for (const node of nodes) {
    drawNode(node, positions.get(node.node_id), radius);
  }

  renderLegend(nodes);
}

function drawEdge(edge, positions, nodeRadius, indexInGroup, groupSize) {
  const s = positions.get(edge.source);
  const t = positions.get(edge.target);
  if (!s || !t) return; // defensive: an edge endpoint missing from this projection

  const label = `×${edge.dynamic.count} · ${edge.dynamic.avg_latency_ms.toFixed(2)}ms avg`;

  if (edge.source === edge.target) {
    // Self-loop: small arc above the node.
    const loopR = nodeRadius * 1.6;
    const x0 = s.x - nodeRadius * 0.6;
    const y0 = s.y - nodeRadius * 0.85;
    const x1 = s.x + nodeRadius * 0.6;
    const y1 = s.y - nodeRadius * 0.85;
    const path = svgEl("path", {
      d: `M${x0},${y0} C${x0 - loopR},${y0 - loopR} ${x1 + loopR},${y1 - loopR} ${x1},${y1}`,
      class: "edge-line",
      "marker-end": "url(#arrow)",
    });
    edgesLayer.appendChild(path);
    addEdgeLabel(label, (x0 + x1) / 2, y0 - loopR * 0.6);
    return;
  }

  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;

  // Offset curve control point perpendicular to the source->target line so
  // multiple edges between the same pair (or opposite-direction pairs)
  // don't render as one indistinguishable line.
  const centered = indexInGroup - (groupSize - 1) / 2;
  const curveOffset = centered * 28;
  const px = -uy;
  const py = ux;
  const midX = (s.x + t.x) / 2 + px * curveOffset;
  const midY = (s.y + t.y) / 2 + py * curveOffset;

  const startX = s.x + ux * nodeRadius;
  const startY = s.y + uy * nodeRadius;
  const endX = t.x - ux * (nodeRadius + 6);
  const endY = t.y - uy * (nodeRadius + 6);

  const path = svgEl("path", {
    d: `M${startX},${startY} Q${midX},${midY} ${endX},${endY}`,
    class: "edge-line",
    "marker-end": "url(#arrow)",
  });
  edgesLayer.appendChild(path);

  // Actual point on the quadratic bezier at t=0.5.
  const labelX = 0.25 * startX + 0.5 * midX + 0.25 * endX;
  const labelY = 0.25 * startY + 0.5 * midY + 0.25 * endY;
  addEdgeLabel(label, labelX, labelY);
}

function addEdgeLabel(text, x, y) {
  const approxWidth = Math.max(28, text.length * 4.6);
  const bg = svgEl("rect", {
    x: x - approxWidth / 2,
    y: y - 7,
    width: approxWidth,
    height: 12,
    rx: 3,
    class: "edge-label-bg",
  });
  const label = svgEl("text", { x, y: y + 2.5, class: "edge-label", "text-anchor": "middle" });
  label.textContent = text;
  edgesLayer.appendChild(bg);
  edgesLayer.appendChild(label);
}

function drawNode(node, pos, radius) {
  const g = svgEl("g", { transform: `translate(${pos.x},${pos.y})`, "data-node-id": node.node_id });

  const circle = svgEl("circle", {
    r: radius,
    class: "node-circle",
    fill: NODE_COLORS[node.node_type] || "var(--node-process)",
    stroke: "var(--panel-bg)",
  });
  const title = svgEl("title", {});
  const attrText = Object.entries(node.attributes || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  title.textContent = `${node.label} [${node.node_type}]${attrText ? " " + attrText : ""}`;
  circle.appendChild(title);

  const label = svgEl("text", {
    class: "node-label",
    y: radius + 12,
    "text-anchor": "middle",
  });
  label.textContent = truncateLabel(node.label, 16);

  g.appendChild(circle);
  g.appendChild(label);
  g.addEventListener("click", () => onNodeClick(node, g, circle));
  nodesLayer.appendChild(g);
}

function truncateLabel(text, maxLen) {
  if (!text) return "";
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

// -- Explain panel (POST /api/explain) ------------------------------------

function closeExplainPanel() {
  explainPanel.classList.add("hidden");
  if (selectedNodeEl) {
    selectedNodeEl.classList.remove("selected");
    selectedNodeEl = null;
  }
}

function positionExplainPanel(nodeGroupEl) {
  // Translate the node's SVG-space center into pixel coordinates relative
  // to #graph-wrap (the positioned ancestor), so the panel visually anchors
  // next to the clicked node regardless of current viewBox scaling/scroll.
  const circle = nodeGroupEl.querySelector("circle");
  const ctm = circle.getScreenCTM();
  const wrapRect = graphWrap.getBoundingClientRect();
  const pt = svg.createSVGPoint();
  pt.x = 0;
  pt.y = 0;
  const screenPt = pt.matrixTransform(ctm);

  const panelWidth = 300;
  const panelMaxHeight = 320;
  let left = screenPt.x - wrapRect.left + graphWrap.scrollLeft + 16;
  let top = screenPt.y - wrapRect.top + graphWrap.scrollTop - 20;

  const maxLeft = graphWrap.scrollWidth - panelWidth - 8;
  const maxTop = graphWrap.scrollHeight - panelMaxHeight - 8;
  left = Math.max(8, Math.min(left, Math.max(8, maxLeft)));
  top = Math.max(8, Math.min(top, Math.max(8, maxTop)));

  explainPanel.style.left = `${left}px`;
  explainPanel.style.top = `${top}px`;
}

function renderExplainLoading(node, nodeGroupEl) {
  explainContent.innerHTML = `
    <div class="explain-title">${escapeHtml(node.label)}<span class="explain-node-type">${escapeHtml(
    node.node_type
  )}</span></div>
    <p class="explain-loading">asking phosphor_explain for grounded claims…</p>
  `;
  positionExplainPanel(nodeGroupEl);
  explainPanel.classList.remove("hidden");
}

function renderExplainError(node, nodeGroupEl, message) {
  explainContent.innerHTML = `
    <div class="explain-title">${escapeHtml(node.label)}<span class="explain-node-type">${escapeHtml(
    node.node_type
  )}</span></div>
    <p class="explain-error">${escapeHtml(message)}</p>
  `;
  positionExplainPanel(nodeGroupEl);
  explainPanel.classList.remove("hidden");
}

function renderExplanation(node, nodeGroupEl, explanation) {
  const claimSections = [
    ["Local", explanation.local],
    ["Function role", explanation.function_role],
    ["Runtime effect", explanation.runtime_effect],
    ["Risk", explanation.risk],
  ].filter(([, claim]) => claim);

  const rows = claimSections
    .map(([label, claim]) => {
      const refCount = claim.evidence_refs ? claim.evidence_refs.length : 0;
      const refsText = refCount > 0 ? `grounded in ${refCount} event${refCount === 1 ? "" : "s"}` : "no cited events";
      return `
        <div class="claim-row">
          <div class="claim-head">
            <span class="claim-label">${escapeHtml(label)}</span>
            <span class="evidence-badge evidence-${escapeHtml(claim.evidence_level)}">${escapeHtml(
        claim.evidence_level
      )}</span>
          </div>
          <p class="claim-text">${escapeHtml(claim.text)}</p>
          <p class="claim-refs">${escapeHtml(refsText)}</p>
        </div>`;
    })
    .join("");

  explainContent.innerHTML = `
    <div class="explain-title">${escapeHtml(node.label)}<span class="explain-node-type">${escapeHtml(
    node.node_type
  )}</span></div>
    ${rows || '<p class="claim-refs">no claims returned</p>'}
  `;
  positionExplainPanel(nodeGroupEl);
  explainPanel.classList.remove("hidden");
}

async function onNodeClick(node, nodeGroupEl, circleEl) {
  if (!currentTraceId) return;

  if (selectedNodeEl && selectedNodeEl !== circleEl) {
    selectedNodeEl.classList.remove("selected");
  }
  circleEl.classList.add("selected");
  selectedNodeEl = circleEl;

  renderExplainLoading(node, nodeGroupEl);

  try {
    const explanation = await fetchJson("/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trace_id: currentTraceId, target_node_id: node.node_id }),
    });
    renderExplanation(node, nodeGroupEl, explanation);
  } catch (err) {
    renderExplainError(node, nodeGroupEl, err.message);
  }
}

explainClose.addEventListener("click", closeExplainPanel);

// -- Complexity Lens (GET /api/complexity) --------------------------------

function renderComplexity(report) {
  const nodeRows = report.node_costs
    .slice(0, 25)
    .map(
      (n) => `
        <tr>
          <td class="wrap">${escapeHtml(n.label)}</td>
          <td>${escapeHtml(n.node_type)}</td>
          <td>${n.total_duration_ms.toFixed(3)}</td>
          <td>${n.incoming_duration_ms.toFixed(3)}</td>
          <td>${n.outgoing_duration_ms.toFixed(3)}</td>
          <td>${n.edge_count}</td>
        </tr>`
    )
    .join("");
  const nodeOmittedNote =
    report.node_costs.length > 25
      ? `<p class="lens-note">showing top 25 of ${report.node_costs.length} nodes by total cost</p>`
      : "";

  const edgeRows = report.top_edges
    .map(
      (e) => `
        <tr>
          <td class="wrap">${escapeHtml(e.source)} → ${escapeHtml(e.target)}</td>
          <td>${escapeHtml(e.relation)}</td>
          <td>${e.count}</td>
          <td>${e.total_duration_ms.toFixed(3)}</td>
          <td>${e.avg_latency_ms.toFixed(3)}</td>
        </tr>`
    )
    .join("");
  const edgeOmittedNote =
    report.omitted_edge_count > 0
      ? `<p class="lens-note">+ ${report.omitted_edge_count} more edge(s) omitted from this top-${
          report.top_k
        } view, totaling ${report.omitted_total_duration_ms.toFixed(3)}ms (never silently dropped -- see phosphor_projector.project.ComplexityReport)</p>`
      : "";

  const relationRows = report.relation_breakdown
    .map(
      (r) => `
        <tr>
          <td>${escapeHtml(r.relation)}</td>
          <td>${r.edge_count}</td>
          <td>${r.call_count}</td>
          <td>${r.total_duration_ms.toFixed(3)}</td>
          <td>${r.avg_latency_ms.toFixed(3)}</td>
        </tr>`
    )
    .join("");

  complexityViewEl.innerHTML = `
    <div class="lens-section">
      <h3>By relation (${report.total_edge_count} edges, ${report.total_duration_ms.toFixed(3)}ms total)</h3>
      <table class="lens-table">
        <thead><tr><th>relation</th><th>edges</th><th>calls</th><th>total ms</th><th>avg ms</th></tr></thead>
        <tbody>${relationRows || '<tr><td colspan="5">no edges</td></tr>'}</tbody>
      </table>
    </div>
    <div class="lens-section">
      <h3>Top edges by cost</h3>
      <table class="lens-table">
        <thead><tr><th>edge</th><th>relation</th><th>count</th><th>total ms</th><th>avg ms</th></tr></thead>
        <tbody>${edgeRows || '<tr><td colspan="5">no edges</td></tr>'}</tbody>
      </table>
      ${edgeOmittedNote}
    </div>
    <div class="lens-section">
      <h3>Node cost (highest first)</h3>
      <table class="lens-table">
        <thead><tr><th>node</th><th>type</th><th>total ms</th><th>incoming ms</th><th>outgoing ms</th><th>edges</th></tr></thead>
        <tbody>${nodeRows || '<tr><td colspan="6">no nodes</td></tr>'}</tbody>
      </table>
      ${nodeOmittedNote}
    </div>
  `;
}

// -- Bug Lens (GET /api/bugs) ----------------------------------------------

function renderBugs(report) {
  const errorRows = report.errors
    .map(
      (e) => `
        <tr>
          <td>${new Date(e.timestamp * 1000).toLocaleTimeString()}</td>
          <td class="exc-type">${escapeHtml(e.exception_type || "?")}</td>
          <td class="wrap">${escapeHtml(e.exception_message || "")}</td>
          <td class="wrap">${escapeHtml(e.caller_label || "(unresolvable -- see phosphor_projector docs)")}</td>
          <td>${escapeHtml(e.source_file)}</td>
        </tr>`
    )
    .join("");

  const hotspotRows = report.traffic_hotspots
    .map(
      (h) => `
        <tr>
          <td class="wrap">${escapeHtml(h.source_node_id)} → ${escapeHtml(h.target_node_id)}</td>
          <td>${escapeHtml(h.relation)}</td>
          <td><span class="hotspot-badge">${h.count}×</span></td>
          <td>${h.mean_count.toFixed(1)} ± ${h.stdev_count.toFixed(1)}</td>
          <td>${h.threshold.toFixed(1)}</td>
        </tr>`
    )
    .join("");

  bugsViewEl.innerHTML = `
    <div class="lens-section">
      <h3>Errors (${report.errors.length})</h3>
      <table class="lens-table">
        <thead><tr><th>time</th><th>type</th><th>message</th><th>caller</th><th>source</th></tr></thead>
        <tbody>${errorRows || '<tr><td colspan="5">no type="error" events in this trace</td></tr>'}</tbody>
      </table>
      <p class="lens-note">caller is "(unresolvable)" when the failing call's own function_call frame had already
        closed by the time the error was captured -- common for a whole-script uncaught exception, see
        phosphor_projector.project.ErrorFinding's docstring.</p>
    </div>
    <div class="lens-section">
      <h3>Traffic-explosion hotspots (${report.traffic_hotspots.length})</h3>
      <table class="lens-table">
        <thead><tr><th>edge</th><th>relation</th><th>count</th><th>mean ± stdev</th><th>threshold</th></tr></thead>
        <tbody>${hotspotRows || '<tr><td colspan="5">no edge exceeded its relation\'s traffic threshold</td></tr>'}</tbody>
      </table>
      <p class="lens-note">heuristic, not a verdict: a high call count is consistent with an N+1-style pattern,
        not proof of one. Does not detect retry/timeout/wait/lock -- nothing in the current data model
        distinguishes those from an ordinary repeated or slow call (see phosphor_projector/project.py).</p>
    </div>
  `;
}

// -- View switching (Graph / Complexity / Bugs tabs) -----------------------

async function loadLensView(view) {
  if (!currentTraceId) return;
  const targetEl = view === "complexity" ? complexityViewEl : bugsViewEl;
  targetEl.innerHTML = `<p class="lens-note">loading…</p>`;
  try {
    if (view === "complexity") {
      const report = await fetchJson(`/api/complexity?trace_id=${encodeURIComponent(currentTraceId)}&top_k=10`);
      renderComplexity(report);
    } else {
      const report = await fetchJson(`/api/bugs?trace_id=${encodeURIComponent(currentTraceId)}`);
      renderBugs(report);
    }
  } catch (err) {
    targetEl.innerHTML = `<p class="explain-error">${escapeHtml(err.message)}</p>`;
  }
}

function setView(view) {
  currentView = view;
  [...viewTabsEl.querySelectorAll(".view-tab")].forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  graphWrap.style.display = view === "graph" ? "" : "none";
  document.getElementById("node-legend").style.display = view === "graph" ? "" : "none";
  complexityViewEl.classList.toggle("hidden", view !== "complexity");
  bugsViewEl.classList.toggle("hidden", view !== "bugs");

  if (view !== "graph") loadLensView(view);
}

viewTabsEl.addEventListener("click", (evt) => {
  const btn = evt.target.closest(".view-tab");
  if (!btn) return;
  setView(btn.dataset.view);
});

// -- Load flow -------------------------------------------------------------

async function loadGraph(traceId, scale) {
  const graph = await fetchJson(`/api/projection?trace_id=${encodeURIComponent(traceId)}&scale=${scale}`);
  renderGraph(graph);
}

async function loadTrace(traceId) {
  currentTraceId = traceId;
  closeExplainPanel();
  setStatus(`loading ${traceId}…`);

  const results = await Promise.allSettled([loadGraph(traceId, currentScale), loadPerfettoTrace(traceId)]);
  const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason.message);

  if (errors.length > 0) {
    setStatus(`${traceId}: ${errors.join(" | ")}`, true);
  } else {
    setStatus(`loaded ${traceId}`);
  }

  // Refresh whichever lens tab is currently active for the newly loaded
  // trace -- otherwise switching traces while on the Complexity/Bugs tab
  // would silently keep showing the PREVIOUS trace_id's report.
  if (currentView !== "graph") loadLensView(currentView);
}

loadBtn.addEventListener("click", () => {
  const traceId = traceInput.value.trim();
  if (!traceId) {
    setStatus("enter a trace_id first", true);
    return;
  }
  loadTrace(traceId);
});

traceInput.addEventListener("keydown", (evt) => {
  if (evt.key === "Enter") loadBtn.click();
});

refreshBtn.addEventListener("click", () => refreshTraceList());

scaleRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    currentScale = radio.value;
    if (currentTraceId) {
      loadGraph(currentTraceId, currentScale).catch((err) => setStatus(err.message, true));
    }
  });
});

// -- Init --------------------------------------------------------------

refreshTraceList();
