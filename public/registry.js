// Registry lookup: self-contained module. Pulls candidate companies from official open registers
// (FI PRH/YTJ, NO Brønnøysund, DK CVR) into the pipeline. Included from index.html; no dependency on app.js.
(function () {
  const css = `
  .rg-fab{position:fixed;right:24px;bottom:24px;z-index:900;background:#0B1F3A;color:#fff;border:0;border-radius:999px;padding:12px 18px;font:600 14px Inter,system-ui,sans-serif;box-shadow:0 6px 20px rgba(11,31,58,.25);cursor:pointer}
  .rg-fab:hover{background:#0FA3B1}
  .rg-overlay{position:fixed;inset:0;background:rgba(11,31,58,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px}
  .rg-modal{background:#fff;border-radius:12px;width:min(980px,100%);max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.25);font:14px Inter,system-ui,sans-serif;color:#1f2937}
  .rg-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid #e5e7eb}
  .rg-head h2{margin:0;font-size:17px;color:#0B1F3A}.rg-head p{margin:4px 0 0;color:#6b7280;font-size:13px}
  .rg-close{border:0;background:transparent;font-size:22px;cursor:pointer;color:#6b7280}
  .rg-form{display:grid;grid-template-columns:110px 1.4fr 1fr 1fr 110px 110px auto;gap:10px;padding:16px 22px;border-bottom:1px solid #e5e7eb;align-items:end}
  .rg-form label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#6b7280;font-weight:600}
  .rg-form input,.rg-form select{border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font:14px inherit;color:#1f2937}
  .rg-btn{border:0;border-radius:8px;padding:9px 14px;font:600 14px inherit;cursor:pointer;background:#0B1F3A;color:#fff}
  .rg-btn.sec{background:#eef2f7;color:#0B1F3A}.rg-btn:disabled{opacity:.5;cursor:default}
  .rg-body{overflow:auto;padding:0 22px}
  .rg-table{width:100%;border-collapse:collapse;font-size:13px}.rg-table th{position:sticky;top:0;background:#f8fafc;text-align:left;padding:10px 8px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb}
  .rg-table td{padding:9px 8px;border-bottom:1px solid #f1f5f9;vertical-align:top}.rg-table tr.done td{color:#9ca3af}
  .rg-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 22px;border-top:1px solid #e5e7eb;color:#6b7280}
  .rg-hint{padding:10px 22px;color:#6b7280;font-size:12px;background:#f8fafc;border-bottom:1px solid #e5e7eb}
  .rg-empty{padding:40px;text-align:center;color:#6b7280}
  .rg-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#0B1F3A;color:#fff;padding:10px 16px;border-radius:8px;z-index:1100;font:14px Inter,system-ui,sans-serif}`;
  const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toast = (msg) => { const t = document.createElement("div"); t.className = "rg-toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3500); };
  const HINTS = {
    FI: "PRH/YTJ open data. Industry = TOL code prefix: 28 machinery · 25 metal products · 62 IT services · 10 food · 71 engineering · 86 health. City filter supported. Founded-before uses registration date.",
    NO: "Brønnøysundregistrene. Industry = NACE code: 28 machinery · 62.01 software · 49.41 road freight · 71.12 engineering. Min. employees supported.",
    DK: "CVR (cvrapi.dk): name lookup only, returns the best match with employees and industry.",
  };

  let results = [];
  function open() {
    const ov = document.createElement("div"); ov.className = "rg-overlay";
    ov.innerHTML = `
      <div class="rg-modal" role="dialog" aria-label="Registry lookup">
        <div class="rg-head"><div><h2>Find companies in official registries</h2><p>Pull candidates straight from public company registers into the pipeline, then let the agents do the rest.</p></div><button class="rg-close" aria-label="Close">×</button></div>
        <form class="rg-form">
          <label>Country<select name="country"><option value="FI">🇫🇮 Finland</option><option value="NO">🇳🇴 Norway</option><option value="DK">🇩🇰 Denmark</option></select></label>
          <label>Company name<input name="q" placeholder="optional"></label>
          <label>Industry code<input name="industry_code" placeholder="e.g. 28"></label>
          <label>City (FI)<input name="city" placeholder="e.g. Tampere"></label>
          <label>Founded before<input name="founded_before" type="number" placeholder="2005"></label>
          <label>Min staff (NO)<input name="employees_min" type="number" placeholder="20"></label>
          <button class="rg-btn" type="submit">Search</button>
        </form>
        <div class="rg-hint">${esc(HINTS.FI)}</div>
        <div class="rg-body"><div class="rg-empty">Search a registry to see candidates.</div></div>
        <div class="rg-foot"><span class="rg-status"></span><div><button class="rg-btn sec" data-act="all" disabled>Select all</button> <button class="rg-btn" data-act="import" disabled>Import selected</button></div></div>
      </div>`;
    document.body.appendChild(ov);
    const $ = (s) => ov.querySelector(s);
    const close = () => ov.remove();
    $(".rg-close").onclick = close;
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    $("select[name=country]").onchange = (e) => { $(".rg-hint").textContent = HINTS[e.target.value]; };

    $("form").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const p = new URLSearchParams();
      for (const [k, v] of fd.entries()) if (String(v).trim()) p.set(k, String(v).trim());
      $(".rg-body").innerHTML = `<div class="rg-empty">Searching…</div>`;
      $(".rg-status").textContent = "";
      try {
        const r = await fetch(`/api/registry/search?${p}`);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || r.statusText);
        results = data.results || [];
        render(data);
      } catch (err) { $(".rg-body").innerHTML = `<div class="rg-empty">${esc(err.message)}</div>`; }
    };

    function render(data) {
      if (!results.length) { $(".rg-body").innerHTML = `<div class="rg-empty">No companies found. Try a broader industry code.</div>`; return; }
      $(".rg-body").innerHTML = `<table class="rg-table"><thead><tr><th></th><th>Company</th><th>City</th><th>Industry</th><th>Founded</th><th>Staff</th><th>Reg. id</th></tr></thead><tbody>
        ${results.map((r, i) => `<tr class="${r.already_imported ? "done" : ""}"><td><input type="checkbox" data-i="${i}" ${r.already_imported ? "disabled" : ""}></td>
          <td><strong>${esc(r.name)}</strong>${r.already_imported ? ' <span style="font-size:11px;color:#0FA3B1">in pipeline</span>' : ""}</td><td>${esc(r.city)}</td><td>${esc(r.industry)}<div style="color:#9ca3af">${esc(r.industry_code)}</div></td><td>${r.founded ?? "—"}</td><td>${r.employees ?? "—"}</td><td style="color:#9ca3af">${esc(r.registry_id)}</td></tr>`).join("")}
      </tbody></table>`;
      $(".rg-status").textContent = `${data.total.toLocaleString()} companies match in the register · showing ${results.length}`;
      $("[data-act=all]").disabled = false;
      const update = () => { const n = ov.querySelectorAll("tbody input:checked").length; const b = $("[data-act=import]"); b.disabled = !n; b.textContent = n ? `Import ${n} into pipeline` : "Import selected"; };
      ov.querySelectorAll("tbody input").forEach((cb) => cb.addEventListener("change", update));
      $("[data-act=all]").onclick = () => { ov.querySelectorAll("tbody input:not(:disabled)").forEach((cb) => (cb.checked = true)); update(); };
      $("[data-act=import]").onclick = async () => {
        const picked = [...ov.querySelectorAll("tbody input:checked")].map((cb) => results[Number(cb.dataset.i)]);
        const b = $("[data-act=import]"); b.disabled = true; b.textContent = "Importing…";
        try {
          const r = await fetch("/api/companies/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ companies: picked }) });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || r.statusText);
          toast(`Imported ${data.imported} companies as new prospects`);
          close();
          if (location.hash === "#/prospects") window.dispatchEvent(new HashChangeEvent("hashchange")); else location.hash = "#/prospects";
        } catch (err) { toast(err.message); b.disabled = false; b.textContent = "Import selected"; }
      };
    }
  }

  function mount() {
    if (document.querySelector(".rg-fab")) return;
    const b = document.createElement("button"); b.className = "rg-fab"; b.type = "button"; b.textContent = "🔎 Registry lookup"; b.onclick = open;
    document.body.appendChild(b);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  window.MergeroRegistry = { open };
})();
