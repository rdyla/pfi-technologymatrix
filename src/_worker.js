// src/_worker.js — Technology Matrix (Worker + restdb.io) — iFrame-friendly for Dynamics

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // ---------- Routes ----------
    if (url.pathname === "/") {
      return new Response(htmlPage(env), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          // Allow ONLY your Dynamics org to embed this page in an iFrame
          "content-security-policy":
            "frame-ancestors https://packetfusioncrm.crm.dynamics.com;",
          "referrer-policy": "strict-origin-when-cross-origin",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (url.pathname.startsWith("/api/items")) {
      // Optional simple token gate for MVP
      // If you put this behind Cloudflare Access, you can remove this entirely.
      if (env.APP_SHARED_TOKEN) {
        const token = req.headers.get("x-app-token") || "";
        if (token !== env.APP_SHARED_TOKEN) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }
      }
      return handleItems(req, env, url);
    }

    return new Response("Not Found", { status: 404 });
  },
};

/* ----------------------------- Helpers ----------------------------- */
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function computeTIME(technicalFit, functionalFit) {
  // High = 4–5, Low = 1–3
  const techHigh = Number(technicalFit) >= 4;
  const funcHigh = Number(functionalFit) >= 4;

  if (techHigh && funcHigh) return { code: "I", label: "Invest" };
  if (!techHigh && funcHigh) return { code: "M", label: "Migrate" };
  if (techHigh && !funcHigh) return { code: "T", label: "Tolerate" };
  return { code: "E", label: "Eliminate" };
}

function requireEnv(env, keys = []) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ----------------------------- RESTDB API ----------------------------- */
async function handleItems(req, env, url) {
  try {
    requireEnv(env, ["RESTDB_BASE", "RESTDB_COLLECTION", "RESTDB_API_KEY"]);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }

  const base = String(env.RESTDB_BASE).replace(/\/$/, "");
  const col = String(env.RESTDB_COLLECTION);
  const apiKey = String(env.RESTDB_API_KEY);

  const parts = url.pathname.split("/").filter(Boolean); // ["api","items",":id?"]
  const id = parts[2] || null;

  const restUrl = id
    ? `${base}/rest/${encodeURIComponent(col)}/${encodeURIComponent(id)}`
    : `${base}/rest/${encodeURIComponent(col)}`;

  const headers = {
    "Content-Type": "application/json",
    "x-apikey": apiKey,
  };

  // GET /api/items?customerId=...&category=...
  if (req.method === "GET" && !id) {
    const customerId = (url.searchParams.get("customerId") || "").trim();
    const category = (url.searchParams.get("category") || "").trim();

    const q = {};
    if (customerId) q.customerId = customerId;
    if (category) q.category = category;

    const qParam =
      Object.keys(q).length > 0
        ? `?q=${encodeURIComponent(JSON.stringify(q))}&sort=${encodeURIComponent(
            JSON.stringify({ createdAt: -1 })
          )}`
        : `?sort=${encodeURIComponent(JSON.stringify({ createdAt: -1 }))}`;

    const r = await fetch(restUrl + qParam, { headers });
    const data = await r.json().catch(() => null);
    if (!r.ok) return json({ ok: false, error: data || (await r.text()) }, r.status);
    return json({ ok: true, items: data || [] });
  }

  // POST /api/items
  if (req.method === "POST" && !id) {
    const body = await req.json().catch(() => null);
    if (!body) return json({ ok: false, error: "Invalid JSON body" }, 400);

    const S = (v) => (v == null ? "" : String(v).trim());

    const technicalFit = Number(body.technicalFit);
    const functionalFit = Number(body.functionalFit);

    if (!(technicalFit >= 1 && technicalFit <= 5)) {
      return json({ ok: false, error: "technicalFit must be 1-5" }, 400);
    }
    if (!(functionalFit >= 1 && functionalFit <= 5)) {
      return json({ ok: false, error: "functionalFit must be 1-5" }, 400);
    }

    const customerId = S(body.customerId);
    const category = S(body.category);
    const solution = S(body.solution);
    const vendor = S(body.vendor);
    const notes = S(body.notes);

    // New date fields (date-only strings like "2026-01-06")
    const dateImplemented = S(body.dateImplemented);
    const contractExpiration = S(body.contractExpiration);

    if (!customerId || !category || !solution) {
      return json(
        { ok: false, error: "customerId, category, and solution are required" },
        400
      );
    }

    const time = computeTIME(technicalFit, functionalFit);
    const now = new Date().toISOString();

    const doc = {
      customerId,
      category,
      solution,
      vendor,
      notes,
      technicalFit,
      functionalFit,
      timeCode: time.code,
      timeLabel: time.label,
      dateImplemented: dateImplemented || null,
      contractExpiration: contractExpiration || null,
      createdAt: now,
      updatedAt: now,
    };

    const r = await fetch(restUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(doc),
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) return json({ ok: false, error: data || (await r.text()) }, r.status);
    return json({ ok: true, item: data });
  }

  // DELETE /api/items/:id
  if (req.method === "DELETE" && id) {
    const r = await fetch(restUrl, { method: "DELETE", headers });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return json({ ok: false, error: t || "Delete failed" }, r.status);
    }
    return json({ ok: true });
  }

  return json({ ok: false, error: "Method not allowed" }, 405);
}

/* ----------------------------- UI (single-page) ----------------------------- */
function htmlPage(env) {
  const categories = [
    "UC/UCaaS",
    "AI",
    "PSTN/POTS",
    "Physical Infrastructure/IaaS",
    "Backup/BaaS",
    "DR/DRaaS",
    "MSP",
    "Physical Security",
    "Cyber Security",
    "WAN/SD-WAN/SASE",
    "TEM (technology expense management)",
    "Miscellaneous Projects",
  ];

  const categoriesOptions = categories
    .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
    .join("");

  const fitOptions = [
    [5, "5 (Excellent)"],
    [4, "4 (Good)"],
    [3, "3 (Fair)"],
    [2, "2 (Poor)"],
    [1, "1 (Bad)"],
  ]
    .map(([v, t]) => `<option value="${v}">${t}</option>`)
    .join("");

  const tokenGateEnabled = !!env.APP_SHARED_TOKEN;

  // NOTE: Do NOT use backticks in the browser script section below.
  // This avoids breaking the Worker’s outer template literal and causing build errors.
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Technology Matrix</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 18px; }
    .wrap { max-width: 1100px; margin: 0 auto; }
    h1 { margin: 0 0 8px; }
    .sub { color: #555; margin: 0 0 16px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    label { font-size: 12px; color: #333; display:block; margin-bottom: 6px; }
    input, select, textarea { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 10px; font-size: 14px; }
    textarea { min-height: 84px; resize: vertical; }
    .row { display:flex; gap: 12px; align-items:center; }
    .row > * { flex: 1; }
    .card { border: 1px solid #e5e5e5; border-radius: 16px; padding: 16px; box-shadow: 0 2px 10px rgba(0,0,0,.04); }
    .actions { display:flex; gap: 10px; margin-top: 12px; }
    button { padding: 10px 14px; border-radius: 12px; border: 1px solid #ccc; background: #fff; cursor: pointer; font-weight: 600; }
    button.primary { border-color: #111; }
    .pill { display:inline-flex; align-items:center; gap: 8px; padding: 6px 10px; border-radius: 999px; font-size: 12px; border: 1px solid #ddd; }
    .seg { display:flex; border: 1px solid #ccc; border-radius: 999px; overflow:hidden; }
    .seg button { flex: 1; padding: 10px 0; border: 0; background: #fff; cursor: pointer; font-weight: 700; }
    .seg button + button { border-left: 1px solid #eee; }
    .seg button.active { background: #111; color: #fff; }
    .time { font-weight: 800; width: 22px; height: 22px; border-radius: 8px; display:inline-flex; align-items:center; justify-content:center; color:#fff; }
    .I { background: #1f9d55; }
    .M { background: #d97706; }
    .T { background: #64748b; }
    .E { background: #dc2626; }
    table { width:100%; border-collapse: collapse; }
    th, td { padding: 10px; border-bottom: 1px solid #eee; vertical-align: top; }
    th { text-align:left; font-size: 12px; color:#444; }
    .muted { color:#666; font-size: 12px; }
    .topbar { display:flex; gap: 12px; align-items:flex-end; justify-content: space-between; }
    .topbar .filters { display:flex; gap: 12px; }
    .small { max-width: 260px; }
    .error { color:#b91c1c; font-size: 13px; margin-top: 8px; }
    .hidden { display:none; }
    #copyCrmLink { max-width: 120px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1 id="title">Technology Matrix</h1>
    <p class="sub" id="subtitle">Capture current-state solutions by category and score them using TIME (Technical vs Functional fit).</p>

    <div class="grid">
      <div class="card">
        <div class="row" id="customerRow">
          <div>
            <label>Customer ID (Dynamics Account GUID)</label>
            <input id="customerId" placeholder="00000000-0000-0000-0000-000000000000" />
            <div class="muted">Tip: embed with ?customerId=&lt;guid&gt;&embed=1</div>
          </div>
          <div>
            <label>Category</label>
            <select id="category">
              ${categoriesOptions}
            </select>
          </div>
        </div>

        <div class="row" style="margin-top:12px;">
          <div>
            <label>Current Solution</label>
            <input id="solution" placeholder="Zoom Phone, RingCentral, Mitel, Teams, etc." />
          </div>
          <div>
            <label>Vendor (optional)</label>
            <input id="vendor" placeholder="Zoom / Microsoft / Cisco / Fortinet..." />
          </div>
        </div>

        <div class="row" style="margin-top:12px;">
          <div>
            <label>Technical Fit (1-5)</label>
            <div class="seg" id="techSeg" data-target="technicalFit">
              <button type="button" data-v="1">1</button>
              <button type="button" data-v="2">2</button>
              <button type="button" data-v="3">3</button>
              <button type="button" data-v="4">4</button>
              <button type="button" data-v="5">5</button>
            </div>
            <input id="technicalFit" type="hidden" value="5" />
          </div>
        
          <div>
            <label>Functional Fit (1-5)</label>
            <div class="seg" id="funcSeg" data-target="functionalFit">
              <button type="button" data-v="1">1</button>
              <button type="button" data-v="2">2</button>
              <button type="button" data-v="3">3</button>
              <button type="button" data-v="4">4</button>
              <button type="button" data-v="5">5</button>
            </div>
            <input id="functionalFit" type="hidden" value="5" />
          </div>
        </div>

        <div class="row" style="margin-top:12px;">
          <div>
            <label>Date Implemented</label>
            <input id="dateImplemented" type="date" />
          </div>
          <div>
            <label>Contract Expiration</label>
            <input id="contractExpiration" type="date" />
          </div>
        </div>

        <div style="margin-top:12px;">
          <label>Notes / Customer Feedback</label>
          <textarea id="notes" placeholder="What did the customer say? Pain points? Support issues? Contract pressure?"></textarea>
        </div>

        <div style="margin-top:12px;">
          <span class="pill" id="timePill">
            <span class="time I" id="timeCode">I</span>
            <span id="timeLabel">Invest</span>
            <span class="muted" id="timeHint">(4-5 = High)</span>
          </span>
        </div>

        <div class="actions">
          <button class="primary" id="saveBtn">Save</button>
          <button id="resetBtn">Reset</button>
        </div>

        <div class="error" id="err"></div>
      </div>

      <div class="card">
        <div class="topbar">
          <div class="filters">
            <div class="small">
              <label>Filter Category</label>
              <select id="filterCategory">
                <option value="">All</option>
                ${categoriesOptions}
              </select>
            </div>
          </div>
          <div>
            <button id="refreshBtn">Refresh</button>
          </div>
        </div>

        <div id="tokenGate" class="muted" style="margin-top:10px;">
          ${tokenGateEnabled
            ? "This app is token-gated (MVP). Enter your token below (or protect with Cloudflare Access and remove the token gate)."
            : "Token gate is disabled. If this is internal-only, consider Cloudflare Access."}
        </div>

        <div id="tokenRow" style="margin-top:10px;" class="${tokenGateEnabled ? "" : "hidden"}">
          <label>X-App-Token</label>
          <input id="appToken" placeholder="paste APP_SHARED_TOKEN here" />
        </div>

        <div style="margin-top: 14px; overflow:auto;">
          <table>
            <thead>
              <tr>
                <th>TIME</th>
                <th>Category</th>
                <th>Solution</th>
                <th>Fit</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="tbody">
              <tr><td colspan="6" class="muted">No data yet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:12px;">
      <label>Dynamics iFrame Link (paste into CRM link field)</label>
      <div class="row">
        <input id="crmLink" readonly />
        <button type="button" id="copyCrmLink">Copy</button>
      </div>
      <div class="muted">This link includes <b>customerId</b> and <b>embed=1</b>.</div>
    </div>
  </div>

<script>
(function(){
  function computeTIME(tech, func) {
    var techHigh = Number(tech) >= 4;
    var funcHigh = Number(func) >= 4;
    if (techHigh && funcHigh) return { code:"I", label:"Invest" };
    if (!techHigh && funcHigh) return { code:"M", label:"Migrate" };
    if (techHigh && !funcHigh) return { code:"T", label:"Tolerate" };
    return { code:"E", label:"Eliminate" };
  }

  function el(id){ return document.getElementById(id); }

  function val(id){
    var n = el(id);
    return n ? (n.value || "") : "";
  }

  function setVal(id, v){
    var n = el(id);
    if (n) n.value = v;
  }

  function esc(s){
    return String(s||"")
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;");
  }

  function setError(msg){
    var e = el("err");
    if (e) e.textContent = msg || "";
  }

  function updateTimePreview(){
    var tech = val("technicalFit");
    var func = val("functionalFit");
    var t = computeTIME(tech, func);
    el("timeCode").textContent = t.code;
    el("timeLabel").textContent = t.label;
    el("timeCode").className = "time " + t.code;
  }

  function buildCrmLink() {
    var base = location.origin + "/";
    var cid = String(val("customerId") || "").trim();
    if (!cid) return base;
    return base + "?customerId=" + encodeURIComponent(cid) + "&embed=1";
  }

  function updateCrmLink() {
    var linkEl = el("crmLink");
    if (!linkEl) return;
    linkEl.value = buildCrmLink();
  }

  function initSeg(segId, hiddenId) {
    var seg = el(segId);
    if (!seg) return;

    function setActive(v) {
      setVal(hiddenId, String(v));
      var btns = seg.querySelectorAll("button[data-v]");
      for (var i=0; i<btns.length; i++) {
        var b = btns[i];
        var bv = b.getAttribute("data-v");
        if (String(bv) === String(v)) b.classList.add("active");
        else b.classList.remove("active");
      }
      updateTimePreview();
    }

    seg.addEventListener("click", function(e) {
      var t = e.target;
      if (!t) return;
      if (t.tagName && t.tagName.toLowerCase() === "button") {
        var v = t.getAttribute("data-v");
        if (v) setActive(v);
      }
    });

    setActive(val(hiddenId) || "5");
  }

  async function api(path, opts){
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    var tokenRow = el("tokenRow");
    var tokenRowVisible = tokenRow && !tokenRow.classList.contains("hidden");
    if (tokenRowVisible) {
      headers["x-app-token"] = String(val("appToken") || "").trim();
    }
    var res = await fetch(path, Object.assign({}, opts, { headers: headers }));
    var data = null;
    try { data = await res.json(); } catch(_e) { data = null; }
    if (!res.ok) {
      var msg = (data && (data.error || data.message)) ? (data.error || data.message) : ("HTTP " + res.status);
      if (typeof msg === "object") {
        try { msg = JSON.stringify(msg); } catch(_e2) { msg = String(msg); }
      }
      throw new Error(String(msg));
    }
    return data;
  }

  async function refresh(){
    setError("");
    var customerId = String(val("customerId") || "").trim();
    if (!customerId) {
      renderRows([]);
      return;
    }
    var category = val("filterCategory");
    var q = new URLSearchParams({ customerId: customerId });
    if (category) q.set("category", category);
    var out = await api("/api/items?" + q.toString(), { method: "GET" });
    renderRows((out && out.items) ? out.items : []);
  }

  function renderRows(items){
    var tbody = el("tbody");
    if (!tbody) return;

    if (!items || !items.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">No data yet.</td></tr>';
      return;
    }

    var html = "";
    for (var i=0; i<items.length; i++){
      var it = items[i] || {};
      var id = it._id || it.id || "";
      var code = it.timeCode || "T";
      var label = it.timeLabel || "";
      var fit = (it.technicalFit ?? "?") + "/" + (it.functionalFit ?? "?");

      var sol = esc(it.solution);
      var ven = esc(it.vendor);
      var cat = esc(it.category);
      var notes = esc(it.notes);

      var di = it.dateImplemented ? esc(it.dateImplemented) : "";
      var ce = it.contractExpiration ? esc(it.contractExpiration) : "";

      var datesLine = "";
      if (di || ce) {
        datesLine = '<div class="muted">Impl: ' + (di || "—") + ' · Exp: ' + (ce || "—") + '</div>';
      }

      html += '<tr>'
        + '<td><span class="pill"><span class="time ' + code + '">' + code + '</span> ' + esc(label) + '</span></td>'
        + '<td>' + cat + '</td>'
        + '<td><b>' + sol + '</b><div class="muted">' + ven + '</div>' + datesLine + '</td>'
        + '<td>' + esc(fit) + '</td>'
        + '<td style="max-width:360px; white-space:pre-wrap;">' + notes + '</td>'
        + '<td><button data-del="' + esc(id) + '">Delete</button></td>'
        + '</tr>';
    }
    tbody.innerHTML = html;

    var btns = tbody.querySelectorAll("button[data-del]");
    for (var j=0; j<btns.length; j++){
      (function(btn){
        btn.addEventListener("click", async function(){
          try {
            var did = btn.getAttribute("data-del");
            await api("/api/items/" + did, { method: "DELETE" });
            await refresh();
          } catch(e) {
            setError(e.message || String(e));
          }
        });
      })(btns[j]);
    }
  }

  // --- Embed mode for Dynamics iFrame ---
  (function initFromQuery(){
    var qs = new URLSearchParams(location.search);
    var customerIdQS = String(qs.get("customerId") || "").trim();
    var embed = qs.get("embed") === "1";

    if (embed) {
      document.body.style.margin = "10px";
      var t = el("title");
      var s = el("subtitle");
      if (t) t.style.display = "none";
      if (s) s.style.display = "none";
    }

    if (customerIdQS) {
      setVal("customerId", customerIdQS);
      el("customerId").setAttribute("readonly","readonly");
      el("customerId").style.opacity = "0.75";
    }
    updateCrmLink();
  })();

  // init segmented controls
  initSeg("techSeg", "technicalFit");
  initSeg("funcSeg", "functionalFit");

  el("resetBtn").addEventListener("click", function(){
    setVal("solution", "");
    setVal("vendor", "");
    setVal("notes", "");
    setVal("technicalFit", "5");
    setVal("functionalFit", "5");
    setVal("dateImplemented", "");
    setVal("contractExpiration", "");
    initSeg("techSeg", "technicalFit");
    initSeg("funcSeg", "functionalFit");
    updateCrmLink();
    updateTimePreview();
    setError("");
  });

  el("saveBtn").addEventListener("click", async function(){
    try {
      setError("");
      var customerId = String(val("customerId") || "").trim();
      var category = val("category");
      var solution = String(val("solution") || "").trim();
      var vendor = String(val("vendor") || "").trim();
      var notes = String(val("notes") || "").trim();
      var technicalFit = Number(val("technicalFit"));
      var functionalFit = Number(val("functionalFit"));
      var dateImplemented = val("dateImplemented");
      var contractExpiration = val("contractExpiration");

      if (!customerId) throw new Error("Customer ID is required.");
      if (!category) throw new Error("Category is required.");
      if (!solution) throw new Error("Current solution is required.");

      var payload = {
        customerId: customerId,
        category: category,
        solution: solution,
        vendor: vendor,
        notes: notes,
        technicalFit: technicalFit,
        functionalFit: functionalFit,
        dateImplemented: dateImplemented,
        contractExpiration: contractExpiration
      };

      await api("/api/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

      setVal("solution", "");
      setVal("vendor", "");
      setVal("notes", "");
      setVal("dateImplemented", "");
      setVal("contractExpiration", "");
      updateCrmLink();
      await refresh();
    } catch(e) {
      setError(e.message || String(e));
    }
  });

  var copyBtn = el("copyCrmLink");
  if (copyBtn) {
    copyBtn.addEventListener("click", async function() {
      try {
        updateCrmLink();
        var text = val("crmLink");
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = "Copied!";
        setTimeout(function(){ copyBtn.textContent = "Copy"; }, 1200);
      } catch (e) {
        var inp = el("crmLink");
        if (inp) { inp.focus(); inp.select(); }
        setError("Copy failed — select and copy manually.");
      }
    });
  }

  el("refreshBtn").addEventListener("click", function(){ refresh().catch(function(){}); });
  el("filterCategory").addEventListener("change", function(){ refresh().catch(function(){}); });

  el("customerId").addEventListener("change", function(){
    updateCrmLink();
    refresh().catch(function(){});
  });

  updateTimePreview();
  updateCrmLink();
  refresh().catch(function(){});
})();
</script>

</body>
</html>`;
}
