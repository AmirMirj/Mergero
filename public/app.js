/* Mergero Origination Engine — frontend SPA (vanilla JS, hash router) */
'use strict';

/* ================= constants ================= */
const STAGES = ['new', 'enriched', 'outreach_ready', 'contacted', 'replied', 'warming', 'meeting_booked', 'mandate_signed'];
const ALL_STAGES = STAGES.concat(['disqualified']);
// Stage names follow Mergero's own mandate path: first touch → reply → warm-up → first call with an advisor → engagement letter (= mandate).
const STAGE_LABELS = {
  new: 'New', enriched: 'Enriched', outreach_ready: 'Outreach ready', contacted: 'First touch sent', replied: 'Owner replied',
  warming: 'Warm-up', meeting_booked: 'First call booked', mandate_signed: 'Engagement letter', disqualified: 'Disqualified'
};
// How the owner conversation is framed in outreach. Mergero: owners usually have not considered selling, and growth capital
// or a minority stake is the softer entry point, so the default is an open conversation, not a sale.
const FRAMINGS = { open: 'Open conversation', growth: 'Growth capital', minority: 'Partial / minority stake', exit: 'Full sale' };
// Minutes of analyst time each agent step replaces (mirror of server/playbook.js TIME_SAVED_MINUTES).
const TIME_SAVED_MIN = { research: 30, enrichment: 45, scoring: 15, buyer_matching: 20, outreach_sequence: 40, reply_triage: 10, intake_summary: 30 };
const STAGE_PILL = {
  new: 'pill', enriched: 'pill pill-blue', outreach_ready: 'pill pill-teal', contacted: 'pill pill-navy', replied: 'pill pill-amber',
  warming: 'pill pill-amber', meeting_booked: 'pill pill-green', mandate_signed: 'pill pill-solid-green', disqualified: 'pill pill-red'
};
const FLAGS = { FI: '🇫🇮', SE: '🇸🇪', NO: '🇳🇴', DK: '🇩🇰', DE: '🇩🇪', AT: '🇦🇹', CH: '🇨🇭' };
const COUNTRIES = { FI: 'Finland', SE: 'Sweden', NO: 'Norway', DK: 'Denmark', DE: 'Germany', AT: 'Austria', CH: 'Switzerland' };
const LANGS = { en: 'English', fi: 'Finnish', sv: 'Swedish', de: 'German', no: 'Norwegian', da: 'Danish' };
const CHANNEL_ICON = { email: '✉️', linkedin: '💼', call_script: '📞', phone: '📞' };
const CHANNEL_LABEL = { email: 'Email', linkedin: 'LinkedIn', call_script: 'Call script', phone: 'Phone' };
const OWNERSHIP = ['founder-owned', 'family-owned', 'pe-backed', 'management-owned', 'unknown'];
const BUYER_TYPES = { PE: 'PE fund', family_office: 'Family office', strategic: 'Strategic' };
const BUYER_TYPE_PILL = { PE: 'pill pill-navy', family_office: 'pill pill-purple', strategic: 'pill pill-teal' };
const INTENT_PILL = {
  interested: 'pill pill-green', curious: 'pill pill-teal', info_request: 'pill pill-blue', referral: 'pill pill-purple',
  not_now: 'pill pill-amber', not_interested: 'pill pill-red', other: 'pill'
};
const SENTIMENT_PILL = { warm: 'pill pill-green', neutral: 'pill', cold: 'pill pill-red' };
const STATUS_PILL = { draft: 'pill pill-amber', approved: 'pill pill-blue', sent: 'pill pill-green', rejected: 'pill pill-red' };

/* ================= state ================= */
const state = {
  settings: null,
  stats: null,
  companies: [],
  companyMap: {},
  buyers: [],
  buyersLoaded: false,
  company: null,
  tab: 'profile',
  view: 'dashboard',
  filters: { q: '', stage: '', country: '' },
  running: {},        // company-level actions in flight: { enrich: true }
  msgBusy: {},        // message id -> action name in flight
  editing: {},        // message id -> true when inline editor open
  expanded: {},       // message id -> humanizer details expanded
  outreachLang: 'en',
  outreachFraming: 'open',
  job: null,
  jobTimer: null,
  intakeUrls: {},
  watch: null         // { watched, alerts } from /api/watch/alerts
};

const main = document.getElementById('main');

/* ================= helpers ================= */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function attr(s) { return esc(s); }
function fmtMoney(n) {
  if (n == null || n === '' || isNaN(Number(n))) return '—';
  n = Number(n);
  const a = Math.abs(n);
  if (a >= 1e9) return '€' + (n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return '€' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '€' + Math.round(n / 1e3) + 'k';
  return '€' + Math.round(n);
}
function fmtNum(n) { return (n == null || n === '' || isNaN(Number(n))) ? '—' : Number(n).toLocaleString('en-GB'); }
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return esc(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function fmtShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return esc(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function flag(c) { return FLAGS[c] || '🏳️'; }
function countryName(c) { return COUNTRIES[c] || c || '—'; }
function stageLabel(s) { return STAGE_LABELS[s] || s || '—'; }
function stagePill(s) { return '<span class="' + (STAGE_PILL[s] || 'pill') + '">' + esc(stageLabel(s)) + '</span>'; }
function channelBadge(ch) {
  return '<span class="pill pill-outline" title="' + attr(CHANNEL_LABEL[ch] || ch) + '">' + (CHANNEL_ICON[ch] || '•') + ' ' + esc(CHANNEL_LABEL[ch] || ch || '—') + '</span>';
}
function scoreClass(v) { if (v == null) return 'pill'; if (v >= 70) return 'pill pill-green'; if (v >= 40) return 'pill pill-amber'; return 'pill'; }
function scorePill(score) {
  const v = score && score.readiness != null ? Number(score.readiness) : null;
  if (v == null || isNaN(v)) return '<span class="pill">—</span>';
  return '<span class="' + scoreClass(v) + '" title="Readiness">' + Math.round(v) + '</span>';
}
function scoreColor(v) { return v >= 70 ? '#15803D' : v >= 40 ? '#D97706' : '#94A3B8'; }
function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0].toUpperCase(); }).join('') || '?';
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function toList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return String(v).split(/\n|,/).map(function (s) { return s.trim(); }).filter(Boolean);
}
function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function millions(v) { const n = num(v); return n == null ? null : Math.round(n * 1e6); }
function humanizeKey(k) { return String(k).replace(/_/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); }); }
function formatValue(v) {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.map(function (x) { return typeof x === 'object' ? JSON.stringify(x) : String(x); }).join(', ');
  if (typeof v === 'object') return Object.keys(v).map(function (k) { return humanizeKey(k) + ': ' + formatValue(v[k]); }).join('\n');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

/* ================= API ================= */
async function api(path, method, body) {
  const opts = { method: method || 'GET', headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); }
  catch (e) { throw new Error('Cannot reach the server. Is the backend running on port 3000?'); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : (res.status + ' ' + res.statusText);
    throw new Error(msg);
  }
  return data;
}

/* ================= toasts ================= */
function toast(msg, type, ms) {
  type = type || 'success';
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  const icon = type === 'error' ? '✕' : type === 'info' ? 'i' : '✓';
  el.innerHTML = '<span class="toast-icon">' + icon + '</span><span>' + esc(msg) + '</span>';
  root.appendChild(el);
  requestAnimationFrame(function () { el.classList.add('show'); });
  setTimeout(function () { el.classList.remove('show'); setTimeout(function () { el.remove(); }, 250); }, ms || (type === 'error' ? 6000 : 3500));
}

/* ================= modal ================= */
function openModal(title, bodyHtml, footHtml, opts) {
  opts = opts || {};
  const root = document.getElementById('modal-root');
  root.innerHTML =
    '<div class="modal-backdrop" data-action="close-modal"></div>' +
    '<div class="modal ' + (opts.wide ? 'wide' : '') + '" role="dialog" aria-modal="true">' +
    '<div class="modal-head"><div class="modal-title">' + esc(title) + '</div>' +
    '<button class="modal-close" data-action="close-modal" aria-label="Close">×</button></div>' +
    (opts.form
      ? '<form data-form="' + attr(opts.form) + '"><div class="modal-body">' + bodyHtml + '</div><div class="modal-foot">' + (footHtml || '') + '</div></form>'
      : '<div class="modal-body">' + bodyHtml + '</div>' + (footHtml ? '<div class="modal-foot">' + footHtml + '</div>' : '')) +
    '</div>';
  root.classList.remove('hidden');
  const first = root.querySelector('input:not([type=hidden]), textarea, select');
  if (first) setTimeout(function () { first.focus(); }, 30);
}
function closeModal() {
  const root = document.getElementById('modal-root');
  root.classList.add('hidden');
  root.innerHTML = '';
}

/* ================= busy button helper ================= */
async function withBusy(btn, label, fn) {
  if (!btn) return fn();
  if (btn.disabled) return;
  const prev = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>' + esc(label || 'Working…');
  try { return await fn(); }
  catch (e) { toast(e.message, 'error'); }
  finally { if (document.body.contains(btn)) { btn.disabled = false; btn.innerHTML = prev; } }
}

/* ================= common fragments ================= */
function topbar(title, crumbHtml, ctaHtml) {
  return '<div class="topbar"><div><div class="crumb">' + (crumbHtml || 'Mergero') + '</div><div class="topbar-title">' + esc(title) + '</div></div>' +
    '<div class="topbar-actions">' + (ctaHtml || '') + '</div></div>';
}
function crumb(parts) {
  return parts.map(function (p, i) {
    const html = p.href ? '<a href="' + attr(p.href) + '">' + esc(p.label) + '</a>' : '<span>' + esc(p.label) + '</span>';
    return (i ? '<span class="sep">›</span>' : '') + html;
  }).join('');
}
function pageSkeleton() {
  return topbar('Loading…', crumb([{ label: 'Mergero' }])) + '<div class="content"><div class="skeleton"><div class="sk-line" style="width:220px;height:22px"></div><div class="sk-line" style="width:340px"></div>' +
    '<div class="mt"></div><div class="grid-3"><div class="sk-block"></div><div class="sk-block"></div><div class="sk-block"></div></div>' +
    '<div class="sk-block" style="height:260px"></div></div></div>';
}
function tabSkeleton(label) {
  return '<div class="card"><div class="card-body tab-skeleton"><div class="loading-inline mb"><span class="spinner dark"></span> ' + esc(label || 'Agent working…') + '</div>' +
    '<div class="skeleton"><div class="sk-line" style="width:70%"></div><div class="sk-line" style="width:90%"></div><div class="sk-line" style="width:55%"></div>' +
    '<div class="grid-3 mt"><div class="sk-block" style="height:80px"></div><div class="sk-block" style="height:80px"></div><div class="sk-block" style="height:80px"></div></div></div></div></div>';
}
function errorState(e) {
  return topbar('Something went wrong', crumb([{ label: 'Mergero' }])) + '<div class="content"><div class="error-state"><strong>Could not load data.</strong><div class="mt-sm">' + esc(e && e.message ? e.message : e) + '</div>' +
    '<div class="mt"><button class="btn btn-secondary btn-sm" data-action="reload">Retry</button></div></div></div>';
}
/* small SVG ring gauge */
function ring(value, size, opts) {
  opts = opts || {};
  const v = value == null || isNaN(Number(value)) ? null : Math.max(0, Math.min(100, Number(value)));
  const sw = opts.stroke || Math.max(3, Math.round(size / 10));
  const r = (size - sw) / 2;
  const circ = 2 * Math.PI * r;
  const color = v == null ? '#CBD5E1' : scoreColor(v);
  const font = opts.font || Math.round(size / 3.2);
  return '<span class="ring ' + (v == null ? 'ring-empty' : '') + '" style="width:' + size + 'px;height:' + size + 'px" title="' + attr(opts.title || 'Readiness ' + (v == null ? '—' : Math.round(v))) + '">' +
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '"><circle class="ring-bg" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" stroke-width="' + sw + '"/>' +
    '<circle class="ring-fg" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" stroke-width="' + sw + '" stroke="' + color + '" stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + (circ * (1 - (v || 0) / 100)).toFixed(1) + '"/></svg>' +
    '<span class="ring-num" style="font-size:' + font + 'px">' + (v == null ? '—' : Math.round(v)) + '</span></span>';
}
function emptyState(icon, title, text, buttonHtml) {
  return '<div class="empty"><div class="empty-icon">' + icon + '</div><div class="empty-title">' + esc(title) + '</div>' +
    (text ? '<p>' + esc(text) + '</p>' : '') + (buttonHtml || '') + '</div>';
}
function field(label, inputHtml, hint) {
  return '<div class="field"><label>' + esc(label) + '</label>' + inputHtml + (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
}
function selectHtml(name, options, value, extra) {
  return '<select name="' + attr(name) + '" ' + (extra || '') + '>' + options.map(function (o) {
    const v = Array.isArray(o) ? o[0] : o; const l = Array.isArray(o) ? o[1] : o;
    return '<option value="' + attr(v) + '"' + (String(v) === String(value) ? ' selected' : '') + '>' + esc(l) + '</option>';
  }).join('') + '</select>';
}

/* ================= settings / banner ================= */
async function loadSettings() {
  try { state.settings = await api('/api/settings'); }
  catch (e) { state.settings = null; }
  updateBanner();
}
function updateBanner() {
  const b = document.getElementById('banner');
  const s = state.settings;
  if (s && s.api_key_set === false) {
    b.innerHTML = '⚠️ Add your Anthropic API key in Settings to enable the AI agents <a href="#/settings">Open Settings →</a>';
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
  const user = document.getElementById('sidebar-user');
  if (user && s && s.sender) {
    user.innerHTML = '<div class="avatar">' + esc(initials(s.sender.name)) + '</div><div><div class="sidebar-user-name">' + esc(s.sender.name || 'Advisor') +
      '</div><div class="sidebar-user-sub">' + esc([s.sender.title, s.sender.firm].filter(Boolean).join(' · ') || 'Mergero') + '</div></div>';
  }
}

/* ================= router ================= */
function route() {
  const hash = location.hash || '#/dashboard';
  const parts = hash.replace(/^#\/?/, '').split('/');
  const view = parts[0] || 'dashboard';
  state.view = view;
  $all('.nav a').forEach(function (a) {
    a.classList.toggle('active', a.dataset.nav === view || (view === 'company' && a.dataset.nav === 'prospects'));
  });
  closeModal();
  switch (view) {
    case 'dashboard': renderDashboard(); break;
    case 'prospects': renderProspects(); break;
    case 'company': renderCompany(parts[1]); break;
    case 'buyers': renderBuyers(); break;
    case 'settings': renderSettings(); break;
    default: location.hash = '#/dashboard';
  }
}
function setCompanies(list) {
  state.companies = Array.isArray(list) ? list : [];
  state.companyMap = {};
  state.companies.forEach(function (c) { state.companyMap[c.id] = c; });
}

/* ================= DASHBOARD ================= */
async function renderDashboard() {
  main.innerHTML = pageSkeleton();
  let stats, companies;
  try {
    const res = await Promise.all([api('/api/stats'), api('/api/companies'), api('/api/watch/alerts?limit=12').catch(function () { return null; })]);
    stats = res[0]; companies = res[1]; state.watch = res[2];
  } catch (e) { main.innerHTML = errorState(e); return; }
  if (state.view !== 'dashboard') return;
  state.stats = stats || {};
  setCompanies(companies);
  drawDashboard();
}

function drawDashboard() {
  const s = state.stats || {};
  const byStage = s.by_stage || {};
  const total = s.total != null ? s.total : state.companies.length;
  const newCount = byStage.new || 0;
  const maxCount = Math.max(1, ...STAGES.map(function (st) { return byStage[st] || 0; }));

  const pending = [];
  state.companies.forEach(function (c) {
    (c.messages || []).forEach(function (m) { if (m.status === 'draft') pending.push({ c: c, m: m }); });
  });
  const replied = state.companies.filter(function (c) { return c.stage === 'replied'; });
  const jobRunning = state.job && !state.job.finished;

  const pendingN = s.messages_pending_approval != null ? s.messages_pending_approval : pending.length;
  const repliedN = s.replies_unhandled != null ? s.replies_unhandled : replied.length;
  const avgR = s.avg_readiness != null ? Math.round(s.avg_readiness) : null;
  const hoursSaved = s.hours_saved != null ? Number(s.hours_saved) : hoursSavedFrom(state.companies);
  const kpis =
    kpi('Total prospects', fmtNum(total), 'across ' + Object.keys(byStage).filter(function (k) { return byStage[k]; }).length + ' pipeline stages',
      '', { text: '+' + newCount + ' new', tone: newCount ? 'teal' : '' }) +
    kpi('Avg readiness', avgR != null ? avgR : '—', 'of scored prospects (0–100)', '',
      avgR == null ? null : { text: avgR >= 70 ? 'strong' : avgR >= 40 ? 'moderate' : 'weak', tone: avgR >= 70 ? 'up' : avgR >= 40 ? 'warn' : 'down' }) +
    kpi('Projected mandates', s.projected_mandates != null ? Number(s.projected_mandates).toFixed(1) : '—', 'from funnel assumptions', 'accent', { text: '6–18 mo', tone: 'teal' }) +
    kpi('Pending approval', pendingN, 'outreach drafts awaiting review', pendingN ? 'warn' : '', { text: pendingN ? 'action needed' : 'all clear', tone: pendingN ? 'warn' : 'up' }) +
    kpi('Unhandled replies', repliedN, 'owners waiting for an answer', repliedN ? 'warn' : '', { text: repliedN ? 'triage now' : 'all clear', tone: repliedN ? 'warn' : 'up' }) +
    kpi('Analyst hours saved', hoursSaved.toFixed(1) + ' h', 'research & first-touch work done by agents', '', { text: 'less manual work', tone: 'teal' });

  const funnel = STAGES.map(function (st) {
    const n = byStage[st] || 0;
    const w = Math.max(n ? 3 : 0, Math.round(n / maxCount * 100));
    return '<div class="funnel-row"><div class="funnel-label">' + esc(stageLabel(st)) + '</div>' +
      '<div class="funnel-bar-wrap"><div class="funnel-bar ' + (n ? '' : 'zero') + '" style="width:' + w + '%"></div></div>' +
      '<div class="funnel-count">' + n + '</div></div>';
  }).join('');

  const fa = (state.settings && state.settings.funnel_assumptions) || null;
  const assumptions = fa
    ? '<div class="small muted mt">Assumptions: contact→reply ' + Math.round(fa.contact_to_reply * 100) + '% · reply→meeting ' +
      Math.round(fa.reply_to_meeting * 100) + '% · meeting→mandate ' + Math.round(fa.meeting_to_mandate * 100) + '%</div>'
    : '';

  const runBtn = '<button class="btn btn-primary" data-action="run-pipeline" ' + (jobRunning || !newCount ? 'disabled' : '') + '>' +
    (jobRunning ? '<span class="spinner"></span>Running pipeline…' : '▶ Run pipeline on all NEW prospects (' + newCount + ')') + '</button>';
  main.innerHTML =
    topbar('Dashboard', crumb([{ label: 'Mergero' }, { label: 'Overview' }]), '<button class="btn btn-secondary" data-action="reload">Refresh</button>' + runBtn) +
    '<div class="content">' +
    '<div class="kpis">' + kpis + '</div>' +
    '<div class="run-card"><div><h3>Origination agents</h3><div class="muted small">Research the web presence → enrich → score → match buyers → draft humanized outreach for every prospect at stage <strong>New</strong>. ' +
    (newCount ? plural(newCount, 'prospect') + ' waiting.' : 'No prospects waiting — import more or add one.') + '</div></div>' + runBtn + '</div>' +
    '<div id="job-progress">' + (state.job ? jobProgressHtml(state.job) : '') + '</div>' +
    '<div class="grid-2-1">' +
    '<div class="card"><div class="card-head"><div class="card-title">Funnel by stage</div><span class="small muted">' + plural(byStage.disqualified || 0, 'disqualified') + '</span></div>' +
    '<div class="card-body"><div class="funnel">' + funnel + '</div>' + assumptions + '</div></div>' +
    '<div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Messages pending approval</div><span class="pill pill-amber">' + pending.length + '</span></div>' +
    '<div class="card-body">' + (pending.length ? '<div class="mini-list">' + pending.slice(0, 8).map(function (p) {
      return '<div class="mini-item"><div><a class="t" href="#/company/' + attr(p.c.id) + '">' + flag(p.c.country) + ' ' + esc(p.c.name) + '</a>' +
        '<div class="s">' + (p.m.step === 0 ? 'Reply draft' : 'Step ' + p.m.step) + ' · ' + (CHANNEL_ICON[p.m.channel] || '') + ' ' + esc(CHANNEL_LABEL[p.m.channel] || p.m.channel) +
        (p.m.subject ? ' · ' + esc(p.m.subject) : '') + '</div></div>' +
        '<a class="btn btn-ghost btn-xs" href="#/company/' + attr(p.c.id) + '">Review →</a></div>';
    }).join('') + (pending.length > 8 ? '<div class="small muted mt-sm">+' + (pending.length - 8) + ' more</div>' : '') + '</div>'
      : '<div class="muted small">Nothing waiting. Run the pipeline to draft outreach.</div>') + '</div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Unhandled replies</div><span class="pill ' + (replied.length ? 'pill-amber' : '') + '">' + replied.length + '</span></div>' +
    '<div class="card-body">' + (replied.length ? '<div class="mini-list">' + replied.map(function (c) {
      const last = (c.conversation || []).filter(function (e) { return e.direction === 'inbound'; }).pop();
      return '<div class="mini-item"><div><a class="t" href="#/company/' + attr(c.id) + '">' + flag(c.country) + ' ' + esc(c.name) + '</a>' +
        '<div class="s">' + (last ? esc(String(last.text).slice(0, 90)) + (last.text.length > 90 ? '…' : '') : 'Owner replied') + '</div></div>' +
        '<a class="btn btn-ghost btn-xs" href="#/company/' + attr(c.id) + '">Open →</a></div>';
    }).join('') + '</div>' : '<div class="muted small">No owner replies waiting for triage.</div>') + '</div></div>' +
    watchCardHtml(jobRunning) +
    '</div></div></div>';
}

const SIGNAL_LABELS = { leadership_change: 'Leadership change', acquisition: 'M&A', ownership: 'Ownership', expansion: 'Expansion', financial_report: 'Financials', hiring: 'Hiring' };
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return String(u || ''); } }
function alertLine(a, withCompany) {
  return '<div class="mini-item"><div>' +
    (withCompany ? '<a class="t" href="#/company/' + attr(a.company_id) + '">' + flag(a.country) + ' ' + esc(a.company_name) + '</a>' : '') +
    '<div class="s">' + (a.signal ? '<span class="pill pill-amber">' + esc(SIGNAL_LABELS[a.signal] || a.signal) + '</span> ' : '') + esc(a.title) +
    ' · <a href="' + attr(a.url) + '" target="_blank" rel="noopener">' + esc(hostOf(a.url)) + ' ↗</a> · ' + fmtShortDate(a.at) + '</div></div></div>';
}
function watchCardHtml(jobRunning) {
  const w = state.watch;
  if (!w) return '';
  const alerts = w.alerts || [];
  return '<div class="card"><div class="card-head"><div class="card-title">Watch alerts</div>' +
    '<button class="btn btn-secondary btn-xs" data-action="run-watch" ' + (jobRunning || !w.watched ? 'disabled' : '') + ' title="Re-crawl researched websites and flag what changed">↻ Check ' + plural(w.watched || 0, 'site') + '</button></div>' +
    '<div class="card-body">' + (alerts.length ? '<div class="mini-list">' + alerts.map(function (a) { return alertLine(a, true); }).join('') + '</div>'
      : '<div class="muted small">' + (w.watched ? 'No changes detected yet. New CEO, new sites, acquisitions and hiring spikes on researched companies’ websites show up here.' : 'Research a company first; its website is then watched for changes.') + '</div>') +
    '</div></div>';
}

async function runWatch(btn) {
  await withBusy(btn, 'Starting…', async function () {
    const res = await api('/api/watch/run', 'POST', {});
    state.job = { id: res.job_id, kind: 'watch', total: res.total || 0, done: 0, current_company: null, errors: [], finished: !res.total };
    toast('Checking ' + plural(res.total || 0, 'website') + ' for changes', 'info');
    if (state.view === 'dashboard') drawDashboard();
    pollJob();
  });
}

// Client-side fallback for the hours-saved KPI (the server reports hours_saved in /api/stats when available).
function hoursSavedFrom(companies) {
  let min = 0;
  (companies || []).forEach(function (c) {
    if (c.research) min += TIME_SAVED_MIN.research;
    if (c.enrichment) min += TIME_SAVED_MIN.enrichment;
    if (c.score) min += TIME_SAVED_MIN.scoring;
    if ((c.matches || []).length) min += TIME_SAVED_MIN.buyer_matching;
    if ((c.messages || []).some(function (m) { return m.step > 0; })) min += TIME_SAVED_MIN.outreach_sequence;
    min += (c.conversation || []).filter(function (e) { return e.triage; }).length * TIME_SAVED_MIN.reply_triage;
    if (c.intake && c.intake.status === 'complete') min += TIME_SAVED_MIN.intake_summary;
  });
  return Math.round(min / 6) / 10;
}

function kpi(label, value, sub, cls, chip) {
  return '<div class="kpi ' + (cls || '') + '"><div class="kpi-label">' + esc(label) + '</div><div class="kpi-row"><div class="kpi-value">' + esc(value) + '</div>' +
    (chip ? '<span class="delta ' + (chip.tone || '') + '">' + esc(chip.text) + '</span>' : '') + '</div><div class="kpi-sub">' + esc(sub) + '</div></div>';
}

function jobProgressHtml(job) {
  if (!job) return '';
  const total = job.total || 0;
  const done = job.done || 0;
  const pctDone = total ? Math.round(done / total * 100) : (job.finished ? 100 : 0);
  const errors = job.errors || [];
  const what = job.kind === 'watch' ? 'Website watch' : 'Pipeline';
  return '<div class="card mb"><div class="card-body">' +
    '<div class="flex space-between"><div class="strong">' + (job.finished ? '✅ ' + what + ' finished' : '<span class="loading-inline"><span class="spinner dark"></span> ' + what + ' running</span>') + '</div>' +
    '<div class="small muted">' + done + ' / ' + total + ' prospects</div></div>' +
    '<div class="progress mt-sm"><div class="progress-bar ' + (job.finished ? '' : 'striped') + '" style="width:' + pctDone + '%"></div></div>' +
    '<div class="progress-meta"><span>' + (job.finished ? (errors.length ? plural(errors.length, 'error') : 'All prospects processed') : (job.current_company ? 'Working on <strong>' + esc(job.current_company) + '</strong>…' : 'Starting…')) + '</span><span>' + pctDone + '%</span></div>' +
    (errors.length ? '<ul class="job-errors">' + errors.map(function (er) { return '<li><strong>' + esc(er.name || er.id) + '</strong>: ' + esc(er.error) + '</li>'; }).join('') + '</ul>' : '') +
    '</div></div>';
}

async function runPipeline(btn) {
  const newCount = (state.stats && state.stats.by_stage && state.stats.by_stage.new) || 0;
  await withBusy(btn, 'Starting…', async function () {
    const res = await api('/api/pipeline/run', 'POST', { stage: 'new' });
    state.job = { id: res.job_id, total: newCount, done: 0, current_company: null, errors: [], finished: false };
    toast('Pipeline started for ' + plural(newCount, 'prospect'), 'info');
    if (state.view === 'dashboard') drawDashboard();
    pollJob();
  });
}

function pollJob() {
  clearTimeout(state.jobTimer);
  if (!state.job || state.job.finished) return;
  state.jobTimer = setTimeout(async function () {
    try {
      const j = await api('/api/jobs/' + encodeURIComponent(state.job.id));
      state.job = Object.assign({}, state.job, j);
      const el = document.getElementById('job-progress');
      if (el) el.innerHTML = jobProgressHtml(state.job);
      if (j.finished) {
        const errs = (j.errors || []).length;
        toast((j.kind === 'watch' ? 'Website watch finished: ' : 'Pipeline finished: ') + j.done + ' of ' + j.total + ' processed' + (errs ? ', ' + errs + ' failed' : ''), errs ? 'info' : 'success');
        if (state.view === 'dashboard') renderDashboard();
        else if (state.view === 'prospects') renderProspects();
        else if (state.view === 'company' && state.company) renderCompany(state.company.id, { soft: true });
        return;
      }
    } catch (e) {
      toast('Lost track of the pipeline job: ' + e.message, 'error');
      state.job.finished = true;
      const el = document.getElementById('job-progress');
      if (el) el.innerHTML = jobProgressHtml(state.job);
      return;
    }
    pollJob();
  }, 1500);
}

/* ================= PROSPECTS ================= */
async function renderProspects() {
  main.innerHTML = pageSkeleton();
  try { setCompanies(await api('/api/companies')); }
  catch (e) { main.innerHTML = errorState(e); return; }
  if (state.view !== 'prospects') return;
  drawProspects();
}

function filteredCompanies() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return state.companies.filter(function (c) {
    if (f.stage && c.stage !== f.stage) return false;
    if (f.country && c.country !== f.country) return false;
    if (q) {
      const hay = [c.name, c.industry, c.city, c.website, c.owner && c.owner.name].filter(Boolean).join(' ').toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
}

function drawProspects() {
  const countries = Array.from(new Set(state.companies.map(function (c) { return c.country; }).filter(Boolean))).sort();
  const f = state.filters;
  main.innerHTML =
    topbar('Prospects', crumb([{ label: 'Mergero', href: '#/dashboard' }, { label: 'Prospects' }]),
      '<button class="btn btn-secondary" data-action="registry-open">🔎 Find in registries</button>' +
      '<button class="btn btn-secondary" data-action="open-add-prospect">+ Add prospect</button>' +
      '<button class="btn btn-primary" data-action="open-import">⇪ Import CSV</button>') +
    '<div class="content">' +
    '<div class="filters">' +
    '<input type="text" class="search inline" placeholder="Search name, industry, city, owner…" value="' + attr(f.q) + '" data-input="search">' +
    '<select class="inline" data-change="filter-stage"><option value="">All stages</option>' + ALL_STAGES.map(function (s) {
      return '<option value="' + s + '"' + (f.stage === s ? ' selected' : '') + '>' + esc(stageLabel(s)) + '</option>';
    }).join('') + '</select>' +
    '<select class="inline" data-change="filter-country"><option value="">All countries</option>' + countries.map(function (c) {
      return '<option value="' + attr(c) + '"' + (f.country === c ? ' selected' : '') + '>' + flag(c) + ' ' + esc(countryName(c)) + '</option>';
    }).join('') + '</select>' +
    '<span class="small muted" id="prospect-count">' + plural(state.companies.length, 'company', 'companies') + '</span></div>' +
    '<div class="card"><div class="table-wrap"><table class="table"><thead><tr>' +
    '<th>Company</th><th>Owner</th><th>Country</th><th>Industry</th><th class="num">Revenue</th><th class="num">EBITDA</th><th>Readiness</th><th>Stage</th><th>Channel</th><th></th>' +
    '</tr></thead><tbody id="prospect-rows"></tbody></table></div></div>' +
    '</div>';
  drawProspectRows();
}

function drawProspectRows() {
  const tbody = document.getElementById('prospect-rows');
  if (!tbody) return;
  const rows = filteredCompanies();
  const count = document.getElementById('prospect-count');
  if (count) count.textContent = rows.length === state.companies.length ? plural(rows.length, 'company', 'companies') : rows.length + ' of ' + state.companies.length + ' shown';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10">' + emptyState('🔍', state.companies.length ? 'No prospects match these filters' : 'No prospects yet',
      state.companies.length ? 'Try clearing the search or filters.' : 'Import a CSV or add a prospect to get started.',
      state.companies.length ? '' : '<button class="btn btn-primary btn-sm" data-action="open-import">Import CSV</button>') + '</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function (c) {
    const running = state.running['row:' + c.id];
    const o = c.owner || {};
    const readiness = c.score && c.score.readiness != null ? Number(c.score.readiness) : null;
    return '<tr class="clickable" data-action="open-company" data-id="' + attr(c.id) + '">' +
      '<td class="primary-cell">' + esc(c.name) + '<span class="sub">' + esc([c.city, c.ownership_type].filter(Boolean).join(' · ')) + '</span></td>' +
      '<td>' + (o.name ? '<div class="owner-cell"><span class="avatar-sm">' + esc(initials(o.name)) + '</span><div><div class="n">' + esc(o.name) + '</div><div class="t">' + esc([o.title, o.age ? 'age ' + o.age : ''].filter(Boolean).join(' · ')) + '</div></div></div>' : '<span class="muted">—</span>') + '</td>' +
      '<td class="nowrap" title="' + attr(countryName(c.country)) + '">' + flag(c.country) + ' ' + esc(c.country || '') + '</td>' +
      '<td>' + esc(c.industry || '—') + '</td>' +
      '<td class="num">' + fmtMoney(c.revenue_eur) + '</td>' +
      '<td class="num">' + fmtMoney(c.ebitda_eur) + '</td>' +
      '<td><div class="flex">' + ring(readiness, 30, { stroke: 3, font: 10 }) + (readiness != null ? '<span class="' + scoreClass(readiness) + ' no-dot">' + (readiness >= 70 ? 'High' : readiness >= 40 ? 'Medium' : 'Low') + '</span>' : '<span class="small muted">not scored</span>') + '</div></td>' +
      '<td>' + stagePill(c.stage) + '</td>' +
      '<td><span class="chip-icon" title="' + attr(CHANNEL_LABEL[c.channel] || c.channel || '') + '">' + (CHANNEL_ICON[c.channel] || '—') + '</span></td>' +
      '<td class="right nowrap"><button class="btn btn-secondary btn-xs" data-action="run-row" data-id="' + attr(c.id) + '" ' + (running ? 'disabled' : '') + '>' +
      (running ? '<span class="spinner"></span>Running…' : '▶ Run all') + '</button></td></tr>';
  }).join('');
}

async function runRow(id) {
  if (state.running['row:' + id]) return;
  state.running['row:' + id] = true;
  drawProspectRows();
  try {
    const c = await api('/api/companies/' + encodeURIComponent(id) + '/run', 'POST', { language: state.outreachLang, framing: state.outreachFraming });
    const i = state.companies.findIndex(function (x) { return x.id === id; });
    if (i >= 0) state.companies[i] = c; else state.companies.push(c);
    state.companyMap[c.id] = c;
    toast('Pipeline complete for ' + c.name + ' — readiness ' + (c.score ? c.score.readiness : '—'));
  } catch (e) { toast(e.message, 'error'); }
  finally { delete state.running['row:' + id]; drawProspectRows(); }
}

const CSV_COLUMNS = 'name,country,city,website,industry,revenue_eur,ebitda_eur,employees,founded,ownership_type,owner_name,owner_title,owner_age,owner_email,owner_linkedin';
const CSV_SAMPLE = CSV_COLUMNS + '\nNordic Pump Oy,FI,Tampere,https://nordicpump.fi,Industrial equipment,8400000,1100000,46,1998,founder-owned,Jari Lehtinen,CEO & Owner,61,jari@nordicpump.fi,https://linkedin.com/in/jarilehtinen';

function openImportModal() {
  openModal('Import prospects from CSV',
    field('CSV text (header row required)', '<textarea name="csv" rows="10" placeholder="' + attr(CSV_SAMPLE) + '" style="min-height:200px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px"></textarea>') +
    '<div class="hint small muted">Columns: <span class="mono">' + esc(CSV_COLUMNS) + '</span>. Revenue and EBITDA in whole euros. Country codes: FI SE NO DK DE AT CH.</div>' +
    '<div class="mt-sm"><button type="button" class="btn btn-ghost btn-xs" data-action="fill-sample-csv">Insert sample row</button></div>',
    '<button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Import</button>',
    { form: 'import-csv', wide: true });
}

function prospectFormHtml(c) {
  c = c || {};
  const o = c.owner || {};
  return '<div class="form-grid">' +
    field('Company name *', '<input type="text" name="name" required value="' + attr(c.name) + '" placeholder="Nordic Pump Oy">') +
    field('Country *', selectHtml('country', Object.keys(COUNTRIES).map(function (k) { return [k, flag(k) + ' ' + COUNTRIES[k]]; }), c.country || 'FI')) +
    field('City', '<input type="text" name="city" value="' + attr(c.city) + '">') +
    field('Website', '<input type="url" name="website" value="' + attr(c.website) + '" placeholder="https://">') +
    field('Industry', '<input type="text" name="industry" value="' + attr(c.industry) + '" placeholder="Industrial equipment">') +
    field('Ownership', selectHtml('ownership_type', OWNERSHIP, c.ownership_type || 'founder-owned')) +
    field('Revenue (€M)', '<input type="number" step="0.1" min="0" name="revenue_m" value="' + (c.revenue_eur != null ? attr(c.revenue_eur / 1e6) : '') + '" placeholder="8.4">') +
    field('EBITDA (€M)', '<input type="number" step="0.1" name="ebitda_m" value="' + (c.ebitda_eur != null ? attr(c.ebitda_eur / 1e6) : '') + '" placeholder="1.1">') +
    field('Employees', '<input type="number" min="0" name="employees" value="' + attr(c.employees) + '">') +
    field('Founded', '<input type="number" min="1800" max="2100" name="founded" value="' + attr(c.founded) + '">') +
    '<div class="form-section">Owner</div>' +
    field('Owner name', '<input type="text" name="owner_name" value="' + attr(o.name) + '">') +
    field('Title', '<input type="text" name="owner_title" value="' + attr(o.title) + '" placeholder="CEO & Owner">') +
    field('Age', '<input type="number" min="18" max="100" name="owner_age" value="' + attr(o.age) + '">') +
    field('Tenure (years)', '<input type="number" min="0" name="owner_tenure" value="' + attr(o.tenure_years) + '">') +
    field('Email', '<input type="email" name="owner_email" value="' + attr(o.email) + '">') +
    field('LinkedIn', '<input type="url" name="owner_linkedin" value="' + attr(o.linkedin) + '" placeholder="https://linkedin.com/in/…">') +
    '</div>';
}

function openAddProspectModal() {
  openModal('Add prospect', prospectFormHtml(),
    '<button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Add prospect</button>',
    { form: 'add-prospect', wide: true });
}

function prospectFromForm(fd) {
  const body = {
    name: fd.get('name').trim(), country: fd.get('country'), city: fd.get('city').trim(), website: fd.get('website').trim(),
    industry: fd.get('industry').trim(), ownership_type: fd.get('ownership_type'),
    revenue_eur: millions(fd.get('revenue_m')), ebitda_eur: millions(fd.get('ebitda_m')),
    employees: num(fd.get('employees')), founded: num(fd.get('founded')),
    owner: {
      name: fd.get('owner_name').trim(), title: fd.get('owner_title').trim(), age: num(fd.get('owner_age')),
      tenure_years: num(fd.get('owner_tenure')), email: fd.get('owner_email').trim(), linkedin: fd.get('owner_linkedin').trim()
    }
  };
  Object.keys(body).forEach(function (k) { if (body[k] === '' || body[k] === null) delete body[k]; });
  Object.keys(body.owner).forEach(function (k) { if (body.owner[k] === '' || body.owner[k] === null) delete body.owner[k]; });
  return body;
}

/* ================= COMPANY ================= */
async function renderCompany(id, opts) {
  opts = opts || {};
  if (!id) { location.hash = '#/prospects'; return; }
  if (!opts.soft) main.innerHTML = pageSkeleton();
  try {
    const jobs = [api('/api/companies/' + encodeURIComponent(id))];
    if (!state.buyersLoaded) jobs.push(api('/api/buyers'));
    const res = await Promise.all(jobs);
    if (res[1]) { state.buyers = res[1]; state.buyersLoaded = true; }
    state.company = res[0];
    state.companyMap[res[0].id] = res[0];
  } catch (e) { main.innerHTML = errorState(e); return; }
  if (state.view !== 'company') return;
  drawCompany();
}

function setCompany(c) {
  if (!c || !c.id) return;
  state.company = c;
  state.companyMap[c.id] = c;
  const i = state.companies.findIndex(function (x) { return x.id === c.id; });
  if (i >= 0) state.companies[i] = c;
}

function anyRunning() { return Object.keys(state.running).some(function (k) { return k.indexOf('row:') !== 0; }); }

function actionBtn(name, label, cls, busyLabel) {
  const running = state.running[name];
  return '<button class="btn ' + cls + '" data-action="company-action" data-name="' + name + '" ' + (anyRunning() ? 'disabled' : '') + '>' +
    (running ? '<span class="spinner"></span>' + esc(busyLabel || 'Running…') : label) + '</button>';
}

function drawCompany() {
  const c = state.company;
  if (!c) return;
  const o = c.owner || {};
  const msgs = c.messages || [];
  const seq = msgs.filter(function (m) { return m.step > 0; });
  const conv = c.conversation || [];
  const pendingCount = msgs.filter(function (m) { return m.status === 'draft'; }).length;
  const tabs = [
    ['profile', 'Profile & signals', c.enrichment ? '' : null],
    ['research', 'Web dossier', c.research ? String((c.research.facts || []).length) : null],
    ['score', 'Score & why now', c.score ? String(c.score.readiness) : null],
    ['buyers', 'Buyer demand', (c.matches || []).length ? String(c.matches.length) : null],
    ['outreach', 'Outreach', seq.length ? String(seq.length) : null],
    ['conversation', 'Conversation', conv.length ? String(conv.length) : null],
    ['intake', 'Owner intake', c.intake && c.intake.status ? (c.intake.status === 'complete' ? '✓' : '•') : null]
  ];
  const busyRun = state.running.run;

  main.innerHTML =
    topbar(c.name, crumb([{ label: 'Mergero', href: '#/dashboard' }, { label: 'Prospects', href: '#/prospects' }, { label: c.name }]),
      '<a class="btn btn-ghost" href="#/prospects">← Back</a>' + actionBtn('run', '▶ Run full pipeline', 'btn-primary', 'Running pipeline…')) +
    '<div class="content">' +
    '<div class="card company-header">' +
    '<div class="ch-main"><div class="ch-title"><h1>' + flag(c.country) + ' ' + esc(c.name) + '</h1>' + stagePill(c.stage) + channelBadge(c.channel) +
    (c.ownership_type ? '<span class="pill pill-outline">' + esc(c.ownership_type) + '</span>' : '') + '</div>' +
    '<div class="ch-meta">' +
    (c.website ? '<a href="' + attr(c.website) + '" target="_blank" rel="noopener">🔗 ' + esc(String(c.website).replace(/^https?:\/\//, '')) + '</a>' : '') +
    '<span>📍 ' + esc([c.city, countryName(c.country)].filter(Boolean).join(', ')) + '</span>' +
    (c.industry ? '<span>🏭 ' + esc(c.industry) + '</span>' : '') +
    (c.source ? '<span class="muted">Source: ' + esc(c.source) + '</span>' : '') + '</div>' +
    '<div class="ch-stats">' + stat('Revenue', fmtMoney(c.revenue_eur)) + stat('EBITDA', fmtMoney(c.ebitda_eur)) +
    stat('Margin', c.revenue_eur && c.ebitda_eur != null ? Math.round(c.ebitda_eur / c.revenue_eur * 100) + '%' : '—') +
    stat('Employees', fmtNum(c.employees)) + stat('Founded', c.founded || '—') + '</div></div>' +
    '<div class="ch-side">' +
    '<div class="ring-block">' + ring(c.score ? c.score.readiness : null, 72, { stroke: 7, font: 22 }) + '<div><div class="l">Readiness</div><div class="v">' +
    (c.score ? (c.score.readiness >= 70 ? 'High likelihood' : c.score.readiness >= 40 ? 'Moderate likelihood' : 'Low likelihood') + '<br><span class="small muted">timing: ' + esc(c.score.recommended_timing || '—') + '</span>' : '<span class="muted">Not scored yet</span>') + '</div></div></div>' +
    '<label>Stage</label><select data-change="stage" class="inline">' + ALL_STAGES.map(function (s) {
      return '<option value="' + s + '"' + (c.stage === s ? ' selected' : '') + '>' + esc(stageLabel(s)) + '</option>';
    }).join('') + '</select>' +
    '<div class="small muted">Updated ' + fmtDate(c.updated_at) + '</div></div></div>' +

    '<div class="toolbar">' +
    '<div class="card owner-card"><div class="owner-avatar">' + esc(initials(o.name)) + '</div><div>' +
    '<div class="owner-name">' + esc(o.name || 'Owner unknown') + '</div><div class="owner-title">' + esc(o.title || '') + '</div>' +
    '<div class="owner-facts">' +
    (o.age || o.tenure_years ? '<span>' + [o.age ? 'Age ' + o.age : '', o.tenure_years ? o.tenure_years + ' yrs tenure' : ''].filter(Boolean).join(' · ') + '</span>' : '') +
    (o.email ? '<a href="mailto:' + attr(o.email) + '">' + esc(o.email) + '</a>' : '') +
    (o.linkedin ? '<a href="' + attr(o.linkedin) + '" target="_blank" rel="noopener">LinkedIn profile ↗</a>' : '') +
    '</div></div></div>' +
    '<div class="card actions"><div class="actions-label">Agents</div><div class="actions-row">' +
    actionBtn('run', '▶ Run full pipeline', 'btn-primary', busyRun ? 'Running pipeline…' : '') +
    actionBtn('research', '0 · Research web', 'btn-secondary', 'Researching…') +
    actionBtn('enrich', '1 · Enrich', 'btn-secondary', 'Enriching…') +
    actionBtn('score', '2 · Score', 'btn-secondary', 'Scoring…') +
    actionBtn('match', '3 · Match buyers', 'btn-secondary', 'Matching…') +
    '<span class="lang-group">' + actionBtn('outreach', '4 · Draft outreach', 'btn-secondary', 'Drafting…') +
    '<select data-change="outreach-framing" title="How to frame the conversation" ' + (anyRunning() ? 'disabled' : '') + '>' + Object.keys(FRAMINGS).map(function (k) {
      return '<option value="' + k + '"' + (state.outreachFraming === k ? ' selected' : '') + '>' + esc(FRAMINGS[k]) + '</option>';
    }).join('') + '</select>' +
    '<select data-change="outreach-lang" title="Outreach language" ' + (anyRunning() ? 'disabled' : '') + '>' + Object.keys(LANGS).map(function (k) {
      return '<option value="' + k + '"' + (state.outreachLang === k ? ' selected' : '') + '>' + esc(LANGS[k]) + '</option>';
    }).join('') + '</select></span>' +
    '</div>' + (busyRun ? stepperHtml(state.runStep) : '<div class="small muted">Research → enrich → score → match → draft. Research is reused for 7 days; "Research web" refreshes it.</div>') + '</div></div>' +

    '<div class="tabs">' + tabs.map(function (t) {
      return '<button class="tab ' + (state.tab === t[0] ? 'active' : '') + '" data-action="tab" data-tab="' + t[0] + '">' + esc(t[1]) +
        (t[2] ? '<span class="tab-count">' + esc(t[2]) + '</span>' : '') +
        (t[0] === 'outreach' && pendingCount ? '<span class="tab-dot" title="Drafts pending approval"></span>' : '') + '</button>';
    }).join('') + '</div>' +
    '<div class="tab-panel">' + renderTab(c) + '</div>' +
    '</div>';
}

function stat(label, value) {
  return '<div class="stat"><div class="stat-label">' + esc(label) + '</div><div class="stat-value">' + esc(value) + '</div></div>';
}

const RUN_STEPS = [['Research', 'website, registries, web'], ['Enrich', 'sourced profile'], ['Score', 'readiness & valuation'], ['Match buyers', 'network appetite'], ['Draft outreach', 'humanized sequence']];
function stepperHtml(current) {
  current = current == null ? 0 : current;
  return '<div class="stepper">' + RUN_STEPS.map(function (s, i) {
    const cls = i < current ? 'done' : i === current ? 'active' : '';
    const ic = i < current ? '✓' : i === current ? '<span class="spinner dark"></span>' : String(i + 1);
    return '<div class="step ' + cls + '"><span class="ic">' + ic + '</span><span class="t">' + esc(s[0]) + '<span class="s">' + esc(s[1]) + '</span></span></div>';
  }).join('') + '</div>';
}
function startRunStepper() {
  stopRunStepper();
  state.runStep = 0;
  state.runTimer = setInterval(function () {
    if (state.runStep < RUN_STEPS.length - 1) { state.runStep++; if (state.view === 'company') drawCompany(); }
    else stopRunStepper(true);
  }, 12000);
}
function stopRunStepper(keep) {
  clearInterval(state.runTimer);
  state.runTimer = null;
  if (!keep) state.runStep = 0;
}

function renderTab(c) {
  switch (state.tab) {
    case 'research': return tabResearch(c);
    case 'score': return tabScore(c);
    case 'buyers': return tabBuyers(c);
    case 'outreach': return tabOutreach(c);
    case 'conversation': return tabConversation(c);
    case 'intake': return tabIntake(c);
    default: return tabProfile(c);
  }
}

function listOrDash(items, cls) {
  const arr = toList(items);
  if (!arr.length) return '<div class="muted small">—</div>';
  return '<ul class="list ' + (cls || '') + '">' + arr.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
}
function chips(items, cls) {
  const arr = toList(items);
  if (!arr.length) return '<div class="muted small">None</div>';
  return '<div class="chips">' + arr.map(function (x) { return '<span class="chip ' + (cls || '') + '">' + esc(x) + '</span>'; }).join('') + '</div>';
}

/* ---- Tab: Profile & signals ---- */
function tabProfile(c) {
  const e = c.enrichment;
  if (!e && (state.running.enrich || state.running.run)) return tabSkeleton('Enrichment agent is researching the company…');
  if (!e) {
    return '<div class="card">' + emptyState('🔎', 'Not enriched yet', 'The enrichment agent researches what the company does, who runs it and what succession or growth signals are visible.',
      actionBtn('enrich', 'Enrich now', 'btn-primary', 'Enriching…')) + '</div>';
  }
  const confCls = e.confidence === 'high' ? 'pill-green' : e.confidence === 'medium' ? 'pill-amber' : 'pill-red';
  return '<div class="card"><div class="card-body"><div class="summary-text">' + esc(e.summary || '—') + '</div>' +
    (e.positioning ? '<div class="mt"><div class="section-title">Positioning</div><div>' + esc(e.positioning) + '</div></div>' : '') + '</div>' +
    '<div class="card-foot"><span class="' + 'pill ' + confCls + '">Confidence: ' + esc(e.confidence || 'unknown') + '</span>' +
    (e.research_based ? '<span class="pill pill-teal" title="Built from the Web dossier: every statement links to a sourced fact">Sourced from web dossier</span>' : '') +
    (e.enriched_at ? '<span>Enriched ' + fmtDate(e.enriched_at) + '</span>' : '') + '</div></div>' +
    businessProfileHtml(c, e) +
    '<div class="grid-2 mt">' +
    '<div class="card"><div class="card-head"><div class="card-title">Signals</div></div><div class="card-body">' + chips(e.signals) + '</div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Data gaps</div><span class="small muted">to close in the owner conversation</span></div><div class="card-body">' + chips(e.data_gaps, 'chip-amber') + '</div></div>' +
    '</div>' +
    '<div class="grid-3 mt">' +
    '<div class="card"><div class="card-head"><div class="card-title">Products</div></div><div class="card-body">' + listOrDash(e.products) + '</div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Customers</div></div><div class="card-body">' + listOrDash(e.customers) + '</div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Recent news</div></div><div class="card-body">' + listOrDash(e.recent_news) + '</div></div>' +
    '</div>' +
    '<div class="grid-2 mt">' +
    '<div class="card"><div class="card-head"><div class="card-title">Leadership</div></div><div class="card-body">' + esc(e.leadership || '—') + '</div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Sources</div></div><div class="card-body source-list">' +
    (toList(e.sources).length ? toList(e.sources).map(function (s) {
      const url = /^https?:\/\//i.test(s) ? s : '';
      return url ? '<a href="' + attr(url) + '" target="_blank" rel="noopener">' + esc(s) + '</a>' : '<div>' + esc(s) + '</div>';
    }).join('') : '<div class="muted small">—</div>') + '</div></div>' +
    '</div>';
}

/* ---- Sourced business profile (offering, customers, footprint, direction) ---- */
function evidenceChips(ids, c) {
  const facts = (c.research && c.research.facts) || [];
  return toList(ids).map(function (id) {
    const f = facts.find(function (x) { return x.id === id; });
    return f ? '<a class="evidence" href="' + attr(f.url) + '" target="_blank" rel="noopener" title="' + attr((f.quote ? '“' + f.quote + '” — ' : '') + hostOf(f.url)) + '">' + esc(id) + '</a>' : '';
  }).join('');
}
function businessProfileHtml(c, e) {
  if (!e.offering) return '';
  const o = e.offering || {}, fp = e.footprint || {}, d = e.direction || {};
  const segs = e.customer_segments || [];
  const li = function (items, fn) { return items.length ? '<ul class="list">' + items.map(fn).join('') + '</ul>' : '<div class="muted small">—</div>'; };
  return '<div class="grid-2 mt">' +
    '<div class="card"><div class="card-head"><div class="card-title">What they sell</div>' + evidenceChips(o.evidence, c) + '</div><div class="card-body">' +
    '<div>' + esc(o.summary || '—') + '</div>' + (o.business_model ? '<div class="small muted mt-sm">Model: ' + esc(o.business_model) + '</div>' : '') +
    '<div class="mt-sm">' + li(o.product_lines || [], function (p) { return '<li><strong>' + esc(p.name) + '</strong>' + (p.description ? ': ' + esc(p.description) : '') + evidenceChips(p.evidence, c) + '</li>'; }) + '</div></div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Customer groups</div></div><div class="card-body">' +
    li(segs, function (s) { return '<li><strong>' + esc(s.segment) + '</strong>' + ((s.named_customers || []).length ? ': ' + esc(s.named_customers.join(', ')) : '') + evidenceChips(s.evidence, c) + '</li>'; }) + '</div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Where they operate</div>' + evidenceChips(fp.evidence, c) + '</div><div class="card-body"><div class="kv">' +
    '<div class="k">Headquarters</div><div>' + esc(fp.headquarters || '—') + '</div>' +
    '<div class="k">Sites</div><div>' + esc(toList(fp.sites).join('; ') || '—') + '</div>' +
    '<div class="k">Sells into</div><div>' + esc(toList(fp.sales_markets).join(', ') || '—') + '</div></div></div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Direction, vision & goals</div>' + evidenceChips(d.evidence, c) + '</div><div class="card-body">' +
    (d.vision ? '<div class="why-now">' + esc(d.vision) + '</div>' : '') +
    ((d.stated_goals || []).length ? '<div class="section-title mt-sm">Stated goals</div>' + listOrDash(d.stated_goals) : '') +
    ((d.recent_moves || []).length ? '<div class="section-title mt-sm">Recent moves</div>' + li(d.recent_moves, function (m) { return '<li><span class="pill">' + esc(m.date || '—') + '</span> ' + esc(m.event) + evidenceChips(m.evidence, c) + '</li>'; }) : '') +
    (!d.vision && !(d.stated_goals || []).length && !(d.recent_moves || []).length ? '<div class="muted small">—</div>' : '') + '</div></div>' +
    '</div>' +
    (e.financial_view ? '<div class="card mt"><div class="card-head"><div class="card-title">Financial view</div><a class="small" href="#" data-action="tab" data-tab="research">Filed figures →</a></div><div class="card-body">' + esc(e.financial_view) + '</div></div>' : '');
}

/* ---- Tab: Web dossier (research) ---- */
const FACT_CATS = [['events', 'Recent events'], ['direction', 'Direction & goals'], ['offering', 'What they sell'], ['customers', 'Customers'], ['footprint', 'Where they operate'],
  ['financials', 'Financial mentions'], ['ownership', 'Ownership'], ['people', 'People'], ['other', 'Other']];
function factHtml(f) {
  return '<div class="fact"><div class="fact-claim">' + esc(f.claim) + '</div><div class="fact-meta"><span class="fact-id">' + esc(f.id) + '</span>' +
    (f.as_of ? '<span class="pill">' + esc(f.as_of) + '</span>' : '') +
    '<span class="pill ' + (f.origin === 'site' ? 'pill-blue' : 'pill-teal') + '">' + (f.origin === 'site' ? 'own website' : 'web') + '</span>' +
    (f.verified === 'quote' ? '<span class="pill pill-green" title="The quote was found in the source text">quote verified</span>' : '<span class="pill" title="The URL came from the search results; the quote was not checked">source only</span>') +
    (f.detected_at ? '<span class="pill pill-amber">new ' + esc(fmtShortDate(f.detected_at)) + '</span>' : '') +
    '<a href="' + attr(f.url) + '" target="_blank" rel="noopener">' + esc(hostOf(f.url)) + ' ↗</a></div>' +
    (f.quote ? '<div class="fact-quote">“' + esc(f.quote) + '”</div>' : '') + '</div>';
}
function finTable(rows) {
  if (!rows.length) return '<div class="muted small">No filed or published figures found.</div>';
  return '<div class="table-wrap"><table class="table compact"><thead><tr><th>Year</th><th class="right">Revenue</th><th class="right">EBIT</th><th class="right">EBITDA</th><th class="right">Net income</th><th class="right">Staff</th><th>Source</th></tr></thead><tbody>' +
    rows.map(function (x) {
      return '<tr><td class="strong">' + esc(x.year) + '</td><td class="right">' + fmtMoney(x.revenue_eur) + '</td><td class="right">' + fmtMoney(x.ebit_eur) + '</td>' +
        '<td class="right">' + fmtMoney(x.ebitda_eur) + (x.ebitda_basis === 'derived' ? ' <span class="small muted" title="EBIT + depreciation and amortisation">derived</span>' : '') + '</td>' +
        '<td class="right">' + fmtMoney(x.net_income_eur) + '</td><td class="right">' + fmtNum(x.employees) + '</td>' +
        '<td class="small">' + (x.url ? '<a href="' + attr(x.url) + '" target="_blank" rel="noopener">' + esc(x.source) + ' ↗</a>' : esc(x.source)) +
        (x.currency && x.currency !== 'EUR' ? ' <span class="muted">(' + esc(x.currency) + '→EUR)</span>' : '') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}
function tabResearch(c) {
  const r = c.research;
  if (!r && (state.running.research || state.running.run)) return tabSkeleton('Research agent is crawling the website, checking registries and searching the web…');
  if (!r) {
    return '<div class="card">' + emptyState('🌐', 'No web research yet', 'Crawls the company website (sitemap, product, customer, location and about pages), pulls filed accounts from open registries (NO, FI, DK), searches the wider web for news and published figures, and keeps only facts with a checkable source.',
      actionBtn('research', 'Research now', 'btn-primary', 'Researching…')) + '</div>';
  }
  const s = r.site || {}, fin = r.financials || {}, st = r.stats || {}, w = c.watch || {};
  const facts = r.facts || [];
  const social = Object.keys(s.social || {}).map(function (k) { return '<a href="' + attr(s.social[k]) + '" target="_blank" rel="noopener">' + esc(k) + ' ↗</a>'; }).join(' · ');
  const header = '<div class="card"><div class="card-head"><div class="card-title">Web presence</div><div class="flex">' +
    actionBtn('research', '↻ Re-run research', 'btn-secondary btn-sm', 'Researching…') + actionBtn('watch', '👁 Check for changes', 'btn-secondary btn-sm', 'Checking…') + '</div></div>' +
    '<div class="card-body"><div class="kv">' +
    '<div class="k">Website</div><div>' + (s.root ? '<a href="' + attr(s.root) + '" target="_blank" rel="noopener">' + esc(s.root) + ' ↗</a>' : '—') + (s.ok === false ? ' <span class="pill pill-red">' + esc(s.error || 'not reachable') + '</span>' : '') + '</div>' +
    '<div class="k">Pages</div><div>' + (s.root ? 'read ' + (s.pages_read || 0) + ' of ' + fmtNum(s.pages_found || 0) + ' found' + (s.rendered_with === 'browser' ? ' · <span class="pill pill-purple">rendered in a browser (JS site)</span>' : '') + (s.robots_blocked ? ' · <span class="pill pill-red">robots.txt disallows crawling</span>' : '') : '—') + '</div>' +
    '<div class="k">Languages</div><div>' + esc((s.languages || []).join(', ') || '—') + '</div>' +
    '<div class="k">Business IDs</div><div>' + esc((s.business_ids || []).map(function (b) { return b.type + ' ' + b.value; }).join(' · ') || '—') + '</div>' +
    '<div class="k">Profiles</div><div>' + (social || '—') + '</div>' +
    '<div class="k">Facts</div><div><strong>' + facts.length + '</strong> sourced (' + (st.site_facts || 0) + ' from their site, ' + (st.web_facts || 0) + ' from ' + plural(st.web_sources || 0, 'web source') + ')' +
    (st.dropped_unverified ? ' · <span class="muted" title="Facts whose quote could not be found on the cited page, or whose URL was not among the search results">' + st.dropped_unverified + ' unverifiable dropped</span>' : '') + '</div>' +
    '<div class="k">Researched</div><div>' + fmtDate(r.ran_at) + ' · ' + Math.round((r.duration_ms || 0) / 1000) + 's</div></div>' +
    ((r.warnings || []).length ? '<details class="mt-sm"><summary class="small muted">' + plural(r.warnings.length, 'warning') + '</summary><ul class="list small">' + r.warnings.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></details>' : '') +
    '</div></div>';
  const finCard = '<div class="card mt"><div class="card-head"><div class="card-title">Filed & published financials</div>' +
    (fin.identifier ? '<span class="small muted">' + esc(fin.identifier.country + ' ' + fin.identifier.id) + '</span>' : '') + '</div><div class="card-body">' +
    finTable(fin.rows || []) +
    ((fin.conflicts || []).length ? '<div class="mt-sm">' + fin.conflicts.map(function (x) { return '<span class="chip chip-amber" title="Web/registry figure differs from the prospect database">⚠ ' + esc(x) + '</span>'; }).join(' ') + '</div>' : '') +
    ((r.filled_fields || []).length ? '<div class="small muted mt-sm">Filled blank database fields: ' + esc(r.filled_fields.join(', ')) + '</div>' : '') +
    ((fin.documents || []).length ? '<div class="section-title mt">Reports</div><div class="source-list">' + fin.documents.slice(0, 8).map(function (d) { return '<a href="' + attr(d.url) + '" target="_blank" rel="noopener">' + esc((d.year || '') + ' ' + (d.type || 'report').replace(/_/g, ' ') + ' (' + (d.format || 'file') + ') · ' + (d.source || hostOf(d.url))) + '</a>'; }).join('') + '</div>' : '') +
    ((fin.notes || []).length ? '<ul class="list small muted mt-sm">' + fin.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '') +
    '</div></div>';
  const watchCard = (w.last_run_at || (w.alerts || []).length) ? '<div class="card mt"><div class="card-head"><div class="card-title">Watch</div><span class="small muted">last checked ' + fmtDate(w.last_run_at) +
    (w.last_summary ? ' · ' + w.last_summary.new_urls + ' new pages, ' + w.last_summary.changed_pages + ' changed, ' + w.last_summary.new_facts + ' new facts' : '') + (w.last_error ? ' · ' + esc(w.last_error) : '') + '</span></div>' +
    '<div class="card-body">' + ((w.alerts || []).length ? '<div class="mini-list">' + w.alerts.slice(0, 15).map(function (a) { return alertLine(a, false); }).join('') + '</div>' : '<div class="muted small">No changes since the last snapshot.</div>') + '</div></div>' : '';
  const groups = FACT_CATS.map(function (cat) {
    const list = facts.filter(function (f) { return f.category === cat[0]; });
    if (!list.length) return '';
    return '<div class="card"><div class="card-head"><div class="card-title">' + esc(cat[1]) + '</div><span class="pill">' + list.length + '</span></div><div class="card-body tight-y">' +
      list.slice().sort(function (a, b) { return String(b.as_of || '').localeCompare(String(a.as_of || '')); }).map(factHtml).join('') + '</div></div>';
  }).join('');
  return header + finCard + watchCard + (groups ? '<div class="grid-2 mt">' + groups + '</div>' : '<div class="card mt"><div class="card-body muted small">No sourced facts were found.</div></div>');
}

/* ---- Tab: Score & why now ---- */
function tabScore(c) {
  const s = c.score;
  if (!s && (state.running.score || state.running.run)) return tabSkeleton('Scoring agent is estimating readiness and valuation…');
  if (!s) {
    return '<div class="card">' + emptyState('🎯', 'Not scored yet', 'The scoring agent estimates how likely the owner is to transact in 6–18 months, how attractive the company is to buyers, and a valuation band.',
      actionBtn('score', 'Score now', 'btn-primary', 'Scoring…')) + '</div>';
  }
  const r = Math.max(0, Math.min(100, Number(s.readiness) || 0));
  const circ = 2 * Math.PI * 52;
  const band = s.valuation_band_eur || {};
  const timingCls = s.recommended_timing === 'now' ? 'pill-green' : /3-6/.test(s.recommended_timing || '') ? 'pill-teal' : /6-12/.test(s.recommended_timing || '') ? 'pill-amber' : 'pill';
  return '<div class="score-grid">' +
    '<div class="card"><div class="card-body">' +
    '<div class="gauge-wrap"><svg class="gauge" viewBox="0 0 120 120"><circle class="gauge-bg" cx="60" cy="60" r="52"/>' +
    '<circle class="gauge-fg" cx="60" cy="60" r="52" stroke="' + scoreColor(r) + '" stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + (circ * (1 - r / 100)).toFixed(1) + '"/></svg>' +
    '<div class="gauge-num"><div class="n">' + Math.round(r) + '</div><div class="l">Readiness</div></div></div>' +
    '<div class="score-facts">' +
    '<div><div class="score-fact"><span class="k">Attractiveness to buyers</span><span class="v">' + esc(s.attractiveness != null ? s.attractiveness + ' / 100' : '—') + '</span></div>' +
    '<div class="bar mt-sm"><div class="bar-fill navy" style="width:' + (Number(s.attractiveness) || 0) + '%"></div></div></div>' +
    '<div class="score-fact"><span class="k">Valuation band</span><span class="v">' + fmtMoney(band.low) + ' – ' + fmtMoney(band.high) + '</span></div>' +
    '<div class="score-fact"><span class="k">Deal size floor</span><span class="v">' + (s.meets_minimum ? '<span class="pill pill-green">Above €3–5M floor</span>' : '<span class="pill pill-red">Below floor</span>') + '</span></div>' +
    '<div class="score-fact"><span class="k">Recommended timing</span><span class="v"><span class="pill ' + timingCls + ' pill-lg">' + esc(s.recommended_timing || '—') + '</span></span></div>' +
    (s.scored_at ? '<div class="small muted right">Scored ' + fmtDate(s.scored_at) + '</div>' : '') +
    '</div></div></div>' +
    '<div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Why now</div></div><div class="card-body"><div class="why-now">' + esc(s.why_now || '—') + '</div></div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Signals behind the score</div></div><div class="card-body tight"><div class="table-wrap"><table class="table compact"><thead><tr><th>Signal</th><th>Dir.</th><th>Weight</th><th>Note</th></tr></thead><tbody>' +
    ((s.signals || []).length ? s.signals.map(function (g) {
      const pos = String(g.direction || '').toLowerCase().indexOf('pos') === 0 || g.direction === '+';
      const neg = String(g.direction || '').toLowerCase().indexOf('neg') === 0 || g.direction === '-';
      const wCls = g.weight === 'high' ? 'pill-navy' : g.weight === 'medium' ? 'pill-blue' : '';
      return '<tr><td class="strong">' + esc(g.signal) + '</td><td><span class="dir ' + (pos ? 'pos' : neg ? 'neg' : '') + '">' + (pos ? '+' : neg ? '−' : '·') + '</span></td>' +
        '<td><span class="pill ' + wCls + '">' + esc(g.weight || '—') + '</span></td><td class="muted">' + esc(g.note || '') + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="muted">No signals recorded.</td></tr>') + '</tbody></table></div></div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Risks</div></div><div class="card-body">' + listOrDash(s.risks, 'risk-list') + '</div></div>' +
    '</div></div>';
}

/* ---- Tab: Buyer demand ---- */
function tabBuyers(c) {
  const matches = (c.matches || []).slice().sort(function (a, b) { return (b.fit || 0) - (a.fit || 0); });
  if (!matches.length && (state.running.match || state.running.run)) return tabSkeleton('Matching agent is comparing buyer mandates…');
  if (!matches.length) {
    return '<div class="card">' + emptyState('🤝', 'No buyer matches yet', 'The matching agent compares this company with the active buyer mandates in the Mergero network.',
      actionBtn('match', 'Match buyers now', 'btn-primary', 'Matching…')) + '</div>';
  }
  const buyerById = {};
  state.buyers.forEach(function (b) { buyerById[b.id] = b; });
  return '<div class="card"><div class="card-body"><div class="headline"><span class="n">' + matches.length + '</span> ' + (matches.length === 1 ? 'buyer' : 'buyers') +
    ' in the Mergero network ' + (matches.length === 1 ? 'has' : 'have') + ' appetite for this company</div>' +
    '<div class="small muted mt-sm">Fit reflects sector, geography, size range and thesis alignment with each mandate.</div></div>' +
    '<div class="card-body" style="padding-top:0">' + matches.map(function (m) {
      const b = buyerById[m.buyer_id];
      const type = b ? b.buyer_type : (m.buyer_type || '');
      const fit = Math.max(0, Math.min(100, Number(m.fit) || 0));
      return '<div class="match"><div><div class="match-name">' + esc(m.buyer_name || (b && b.name) || 'Buyer') +
        (type ? '<span class="' + (BUYER_TYPE_PILL[type] || 'pill') + '">' + esc(BUYER_TYPES[type] || type) + '</span>' : '') +
        (b && b.geographies ? '<span class="small muted">' + b.geographies.map(flag).join(' ') + '</span>' : '') + '</div>' +
        '<div class="match-reason">' + esc(m.reason || '') + '</div>' +
        (b && b.thesis ? '<div class="small muted mt-sm">Thesis: ' + esc(b.thesis) + '</div>' : '') + '</div>' +
        '<div class="fit"><div class="fit-num">' + fit + '% fit</div><div class="bar"><div class="bar-fill ' + (fit >= 75 ? 'green' : fit >= 50 ? '' : 'amber') + '" style="width:' + fit + '%"></div></div></div></div>';
    }).join('') + '</div></div>' + teaserHtml(c);
}

/* ---- Blind teaser for matched buyers (only after the mandate is signed) ---- */
function teaserHtml(c) {
  const t = c.teaser;
  if (c.stage !== 'mandate_signed' && !t) {
    return '<div class="card mt"><div class="card-body small muted">🔒 Blind teaser for buyers unlocks at stage <strong>Mandate signed</strong>. Nothing about this company goes to buyers before that.</div></div>';
  }
  if (!t) {
    return '<div class="card mt">' + emptyState('📄', 'Draft the blind teaser', 'An anonymised one-pager for the matched buyers: no company name, no named customers, no city, figures as ranges.',
      actionBtn('teaser', 'Draft teaser', 'btn-primary', 'Drafting…')) + '</div>';
  }
  const text = [t.project_name, t.headline, '', t.blind_profile, '', 'Key figures:', ...(t.key_figures || []).map(function (x) { return '- ' + x; }), '',
    'Investment highlights:', ...(t.investment_highlights || []).map(function (x) { return '- ' + x; }), '', 'Transaction: ' + t.transaction].join('\n');
  return '<div class="card mt"><div class="card-head"><div class="card-title">Blind teaser · ' + esc(t.project_name) + '</div><div class="flex">' +
    '<button class="btn btn-secondary btn-sm" data-action="copy-text" data-text="' + attr(text) + '">⧉ Copy</button>' + actionBtn('teaser', '↻ Redraft', 'btn-secondary btn-sm', 'Drafting…') + '</div></div>' +
    '<div class="card-body"><div class="strong">' + esc(t.headline) + '</div><div class="mt-sm">' + esc(t.blind_profile) + '</div>' +
    '<div class="grid-2 mt"><div><div class="section-title">Key figures</div>' + listOrDash(t.key_figures) + '</div><div><div class="section-title">Investment highlights</div>' + listOrDash(t.investment_highlights) + '</div></div>' +
    '<div class="mt-sm"><span class="section-title">Transaction</span> ' + esc(t.transaction) + '</div>' +
    '<div class="small muted mt">Left out on purpose (check before sending): ' + esc(toList(t.redactions).join('; ') || '—') + '</div></div>' +
    '<div class="card-foot"><span>Drafted ' + fmtDate(t.drafted_at) + '</span></div></div>';
}

/* ---- Message card (shared by Outreach + Conversation) ---- */
function messageCard(m, opts) {
  opts = opts || {};
  const busy = state.msgBusy[m.id];
  const editing = !!state.editing[m.id];
  const expanded = !!state.expanded[m.id];
  const h = m.humanizer;
  const isReply = !m.step;
  const dayLabel = m.send_after_days ? 'Day +' + m.send_after_days : 'Day 0';
  const status = m.status || 'draft';
  const dis = busy ? 'disabled' : '';
  const btn = function (action, label, cls, show) {
    if (!show) return '';
    const isBusy = busy === action;
    return '<button class="btn ' + cls + ' btn-sm" data-action="' + action + '" data-id="' + attr(m.id) + '" ' + dis + '>' +
      (isBusy ? '<span class="spinner"></span>' : '') + label + '</button>';
  };
  const actions = editing
    ? btn('cancel-edit', 'Cancel', 'btn-ghost', true) + btn('save-message', 'Save changes', 'btn-primary', true)
    : btn('copy-message', '⧉', 'btn-ghost btn-icon" title="Copy to clipboard', true) +
      btn('humanize-message', '↻ Re-humanize', 'btn-ghost', status !== 'sent') +
      btn('edit-message', '✎ Edit', 'btn-ghost', status !== 'sent') +
      btn('reject-message', 'Reject', 'btn-danger', status === 'draft' || status === 'approved') +
      btn('approve-message', '✓ Approve', 'btn-secondary', status === 'draft' || status === 'rejected') +
      btn('send-message', (m.channel === 'email' ? '✉ Send' : '➤ Mark as sent'), 'btn-primary', status === 'approved');
  const sender = (state.settings && state.settings.sender) || {};
  const owner = (state.company && state.company.owner) || {};
  const mailHead = m.channel === 'email'
    ? '<div class="mail-head">' +
      '<span class="k">From</span><span class="v">' + esc(sender.name || 'Advisor') + (sender.email ? ' <span class="muted">&lt;' + esc(sender.email) + '&gt;</span>' : '') + '</span>' +
      '<span class="k">To</span><span class="v">' + esc(owner.name || 'Owner') + (owner.email ? ' <span class="muted">&lt;' + esc(owner.email) + '&gt;</span>' : '') + '</span>' +
      (!editing ? '<span class="k">Subject</span><span class="v subject">' + esc(m.subject || '(no subject)') + '</span>' : '') +
      '</div>'
    : '<div class="mail-head"><span class="k">To</span><span class="v">' + esc(owner.name || 'Owner') + (m.channel === 'linkedin' && owner.linkedin ? ' <a href="' + attr(owner.linkedin) + '" target="_blank" rel="noopener" class="small">LinkedIn ↗</a>' : '') + '</span></div>';
  return '<div class="msg-card ' + (isReply ? 'reply-draft' : '') + '" id="msg-' + attr(m.id) + '">' +
    '<div class="msg-head">' +
    (isReply ? '<span class="step-badge" style="background:var(--teal)">Reply draft</span>' : '<span class="step-badge">Step ' + esc(m.step) + '</span><span class="day-label">' + dayLabel + '</span>') +
    channelBadge(m.channel) +
    '<span class="pill pill-outline">' + esc(LANGS[m.language] || (m.language || 'en').toUpperCase()) + '</span>' +
    (!isReply && m.framing ? '<span class="pill pill-teal" title="How the conversation is framed">' + esc(FRAMINGS[m.framing] || m.framing) + '</span>' : '') +
    '<span class="' + (STATUS_PILL[status] || 'pill') + '">' + esc(status) + '</span>' +
    '<span class="spacer"></span>' +
    (h ? '<button class="humanizer-btn" data-action="toggle-humanizer" data-id="' + attr(m.id) + '" title="Humanizer pass: AI-tell score before → after">🧬 AI-tell score ' +
      esc(h.ai_tell_score_before != null ? h.ai_tell_score_before : '?') + ' → ' + esc(h.ai_tell_score_after != null ? h.ai_tell_score_after : '?') + ' ' + (expanded ? '▴' : '▾') + '</button>' : '') +
    '</div>' +
    (h && expanded ? '<div class="humanizer-detail">' +
      '<h5>Flags (' + ((h.flags || []).length) + ')</h5>' + ((h.flags || []).length ? '<ul>' + h.flags.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' : '<div class="muted">No AI tells flagged.</div>') +
      '<h5>Changes (' + ((h.changes || []).length) + ')</h5>' + ((h.changes || []).length ? '<ul>' + h.changes.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' : '<div class="muted">No changes applied.</div>') +
      '</div>' : '') +
    mailHead +
    (editing
      ? '<div class="msg-edit">' + (m.channel === 'email' ? '<input type="text" data-field="subject" value="' + attr(m.subject || '') + '" placeholder="Subject">' : '') +
        '<textarea data-field="body">' + esc(m.body || '') + '</textarea></div>'
      : '<pre class="msg-body">' + esc(m.body || '') + '</pre>') +
    '<div class="msg-actions">' + actions +
    '<span class="meta">' + (m.sent_at ? 'Sent ' + fmtDate(m.sent_at) : (m.created_at ? 'Drafted ' + fmtDate(m.created_at) : '')) + '</span></div>' +
    '</div>';
}

/* ---- Tab: Outreach ---- */
function tabOutreach(c) {
  const seq = (c.messages || []).filter(function (m) { return m.step > 0; }).sort(function (a, b) { return (a.step - b.step) || (a.send_after_days - b.send_after_days); });
  if (!seq.length && (state.running.outreach || state.running.run)) return tabSkeleton('Outreach agent is drafting and humanizing the sequence…');
  if (!seq.length) {
    return '<div class="card">' + emptyState('✍️', 'No outreach drafted yet', 'The outreach agent writes a 3-step sequence in the owner\'s language, then a humanizer pass removes AI tells before you approve.',
      actionBtn('outreach', 'Draft outreach now', 'btn-primary', 'Drafting…')) + '</div>';
  }
  const pending = seq.filter(function (m) { return m.status === 'draft'; }).length;
  return '<div class="flex space-between mb"><div><div class="strong">Outreach sequence · ' + plural(seq.length, 'step') + '</div>' +
    '<div class="small muted">' + (pending ? plural(pending, 'draft') + ' waiting for your approval. Review, edit if needed, approve, then send.' : 'All drafts reviewed.') + '</div></div>' +
    '<div class="flex">' + actionBtn('outreach', '↻ Redraft sequence', 'btn-secondary btn-sm', 'Drafting…') + '</div></div>' +
    seq.map(function (m) { return messageCard(m); }).join('');
}

/* ---- Tab: Conversation ---- */
function tabConversation(c) {
  const entries = (c.conversation || []).slice().sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
  const msgById = {};
  (c.messages || []).forEach(function (m) { msgById[m.id] = m; });
  const linked = {};
  const timeline = entries.map(function (e) {
    const t = e.triage;
    let triageHtml = '';
    if (t) {
      const reply = t.reply_message_id ? msgById[t.reply_message_id] : null;
      if (reply) linked[reply.id] = true;
      triageHtml = '<div class="triage-card"><div class="triage-head"><span class="t">Triage</span>' +
        '<span class="' + (INTENT_PILL[t.intent] || 'pill') + '">' + esc(humanizeKey(t.intent || 'other')) + '</span>' +
        '<span class="' + (SENTIMENT_PILL[t.sentiment] || 'pill') + '">' + esc(t.sentiment || 'neutral') + '</span>' +
        (t.recommended_stage ? '<span class="small muted">→ recommended stage</span>' + stagePill(t.recommended_stage) : '') +
        (reply ? '<a href="#" class="small" style="margin-left:auto" data-action="scroll-to" data-target="msg-' + attr(reply.id) + '">View reply draft ↓</a>' : '') +
        '</div><div class="triage-body">' +
        '<div><h5>Extracted facts</h5>' + ((t.extracted_facts || []).length ?
          '<table class="table compact"><thead><tr><th>Field</th><th>Value</th><th>Conf.</th></tr></thead><tbody>' + t.extracted_facts.map(function (f) {
            const cc = f.confidence === 'high' ? 'pill-green' : f.confidence === 'medium' ? 'pill-amber' : '';
            return '<tr><td class="strong">' + esc(humanizeKey(f.field)) + '</td><td>' + esc(formatValue(f.value)) + '</td><td><span class="pill ' + cc + '">' + esc(f.confidence || '—') + '</span></td></tr>';
          }).join('') + '</tbody></table>' : '<div class="muted small">No new facts extracted.</div>') + '</div>' +
        '<div><h5>Next step</h5><div>' + esc(t.next_step || '—') + '</div></div>' +
        '</div></div>' +
        (reply ? '<div class="reply-draft-wrap">' + messageCard(reply) + '</div>' : '');
    }
    return '<div class="tl-entry ' + (e.direction === 'inbound' ? 'inbound' : 'outbound') + '">' +
      '<div class="bubble">' + esc(e.text || '') + '</div>' +
      '<div class="tl-meta">' + (e.direction === 'inbound' ? '⬅ Inbound from owner' : '➡ Outbound') + ' · ' + (CHANNEL_ICON[e.channel] || '') + ' ' + esc(CHANNEL_LABEL[e.channel] || e.channel || '') + ' · ' + fmtDate(e.at) + '</div>' +
      triageHtml + '</div>';
  }).join('');
  const orphanReplies = (c.messages || []).filter(function (m) { return !m.step && !linked[m.id]; });
  const channelDefault = c.channel === 'linkedin' ? 'linkedin' : 'email';
  return '<div class="card"><div class="card-head"><div class="card-title">Conversation with ' + esc((c.owner && c.owner.name) || 'the owner') + '</div><span class="small muted">' + plural(entries.length, 'entry', 'entries') + '</span></div>' +
    '<div class="card-body">' + (entries.length ? '<div class="timeline">' + timeline + '</div>' :
      emptyState('💬', 'No conversation yet', 'Send an approved outreach message, or paste an owner reply below to run triage.')) +
    (orphanReplies.length ? '<div class="mt"><div class="section-title">Reply drafts</div>' + orphanReplies.map(function (m) { return messageCard(m); }).join('') + '</div>' : '') +
    '</div></div>' +
    '<div class="card reply-form"><div class="card-head"><div class="card-title">Paste an owner reply</div><span class="small muted">Triage agent extracts intent, facts and drafts a reply</span></div>' +
    '<form data-form="paste-reply"><div class="card-body">' +
    '<textarea name="text" placeholder="Paste the owner\'s email or LinkedIn reply here…" required></textarea>' +
    '<div class="flex space-between mt-sm"><select name="channel" class="inline">' + [['email', '✉️ Email'], ['linkedin', '💼 LinkedIn'], ['phone', '📞 Phone note']].map(function (o) {
      return '<option value="' + o[0] + '"' + (o[0] === channelDefault ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('') + '</select>' +
    '<button type="submit" class="btn btn-primary" ' + (state.running.reply ? 'disabled' : '') + '>' + (state.running.reply ? '<span class="spinner"></span>Triaging…' : 'Triage reply') + '</button></div>' +
    '</div></form></div>';
}

/* ---- Tab: Owner intake ---- */
function tabIntake(c) {
  const it = c.intake;
  const url = it && it.token ? (state.intakeUrls[c.id] || (location.origin + '/intake/' + it.token)) : '';
  const statusCls = it && it.status === 'complete' ? 'pill-green' : it && it.status === 'in_progress' ? 'pill-amber' : 'pill';
  const summary = it && it.summary && typeof it.summary === 'object' ? it.summary : null;
  const transcript = (it && it.transcript) || [];
  return '<div class="card"><div class="card-head"><div class="card-title">Confidential owner intake</div>' +
    (it && it.status ? '<span class="pill ' + statusCls + '">' + esc(humanizeKey(it.status)) + '</span>' : '') + '</div>' +
    '<div class="card-body">' +
    '<p class="muted">Generate a private link for the owner. A Mergero intake agent has a structured conversation with them — ownership, revenue mix, customer concentration, timing — and sends you a summary that fills the data gaps.</p>' +
    '<div class="flex mt">' + actionBtn('intake-link', it && it.token ? '↻ Regenerate intake link' : '🔗 Generate intake link', it && it.token ? 'btn-secondary' : 'btn-primary', 'Generating…') + '</div>' +
    (url ? '<div class="link-box mt"><code>' + esc(url) + '</code>' +
      '<button class="btn btn-secondary btn-sm" data-action="copy-text" data-text="' + attr(url) + '">⧉ Copy</button>' +
      '<a class="btn btn-primary btn-sm" href="' + attr(url) + '" target="_blank" rel="noopener">Open ↗</a></div>' : '') +
    '</div></div>' +
    (summary ? '<div class="card"><div class="card-head"><div class="card-title">Intake summary</div><span class="small muted">' + Object.keys(summary).length + ' fields</span></div><div class="card-body"><div class="kv">' +
      Object.keys(summary).map(function (k) { return '<div class="kv-item"><div class="kv-key">' + esc(humanizeKey(k)) + '</div><div class="kv-val">' + esc(formatValue(summary[k])) + '</div></div>'; }).join('') +
      '</div></div></div>' : (it && it.status === 'complete' ? '' : (it && it.token ? '<div class="card"><div class="card-body muted small">Summary appears here once the owner completes the conversation.</div></div>' : ''))) +
    (transcript.length ? '<div class="card"><div class="card-body"><details class="transcript"><summary>Transcript (' + plural(transcript.length, 'message') + ')</summary><div class="tl">' +
      transcript.map(function (t) { return '<div class="tl-line ' + (t.role === 'owner' ? 'owner' : '') + '"><span class="who">' + (t.role === 'owner' ? 'Owner' : 'Mergero') + (t.at ? ' · ' + fmtDate(t.at) : '') + '</span>' + esc(t.text) + '</div>'; }).join('') +
      '</div></details></div></div>' : '');
}

/* ================= BUYERS ================= */
async function renderBuyers() {
  main.innerHTML = pageSkeleton();
  try { state.buyers = await api('/api/buyers'); state.buyersLoaded = true; }
  catch (e) { main.innerHTML = errorState(e); return; }
  if (state.view !== 'buyers') return;
  drawBuyers();
}

function drawBuyers() {
  const buyers = state.buyers || [];
  const active = buyers.filter(function (b) { return b.active !== false; }).length;
  main.innerHTML =
    topbar('Buyer mandates', crumb([{ label: 'Mergero', href: '#/dashboard' }, { label: 'Buyers' }]), '<button class="btn btn-primary" data-action="open-add-buyer">+ Add buyer</button>') +
    '<div class="content">' +
    '<div class="flex space-between mb"><div class="muted">' + plural(buyers.length, 'mandate') + ' in the Mergero network · <span class="strong text-green">' + active + ' active</span></div></div>' +
    (buyers.length ? '<div class="buyer-grid">' + buyers.map(buyerCard).join('') + '</div>'
      : '<div class="card">' + emptyState('🏦', 'No buyer mandates yet', 'Add PE funds, family offices and strategics with their sector, geography and size appetite.',
        '<button class="btn btn-primary btn-sm" data-action="open-add-buyer">Add buyer</button>') + '</div>') +
    '</div>';
}

function buyerCard(b) {
  const isActive = b.active !== false;
  return '<div class="card buyer-card ' + (isActive ? '' : 'inactive') + '">' +
    '<div class="buyer-head"><div><div class="buyer-name">' + esc(b.name) + '</div>' +
    '<div class="flex mt-sm flex-wrap"><span class="' + (BUYER_TYPE_PILL[b.buyer_type] || 'pill') + '">' + esc(BUYER_TYPES[b.buyer_type] || b.buyer_type || 'Buyer') + '</span>' +
    (toList(b.deal_types).length ? '<span class="small muted">' + esc(toList(b.deal_types).join(' · ')) + '</span>' : '') + '</div></div>' +
    '<span class="geo" title="' + attr(toList(b.geographies).map(countryName).join(', ')) + '">' + toList(b.geographies).map(flag).join('') + '</span></div>' +
    '<div>' + chips(b.sectors, 'chip-grey') + '</div>' +
    '<div class="buyer-range">' +
    '<div class="kv-item"><div class="kv-key">Revenue</div><div class="kv-val">' + fmtMoney(b.revenue_min_eur) + ' – ' + fmtMoney(b.revenue_max_eur) + '</div></div>' +
    '<div class="kv-item"><div class="kv-key">EBITDA</div><div class="kv-val">' + fmtMoney(b.ebitda_min_eur) + ' – ' + fmtMoney(b.ebitda_max_eur) + '</div></div></div>' +
    (b.thesis ? '<div class="buyer-thesis">' + esc(b.thesis) + '</div>' : '') +
    '<div class="buyer-foot"><label class="switch"><input type="checkbox" data-change="buyer-active" data-id="' + attr(b.id) + '" ' + (isActive ? 'checked' : '') + '><span class="track"></span>' + (isActive ? 'Active' : 'Inactive') + '</label>' +
    '<div class="flex"><button class="btn btn-ghost btn-xs" data-action="open-edit-buyer" data-id="' + attr(b.id) + '">Edit</button>' +
    '<button class="btn btn-danger btn-xs" data-action="delete-buyer" data-id="' + attr(b.id) + '">Delete</button></div></div>' +
    '</div>';
}

function buyerFormHtml(b) {
  b = b || {};
  const geos = toList(b.geographies);
  return '<div class="form-grid">' +
    field('Buyer name *', '<input type="text" name="name" required value="' + attr(b.name) + '" placeholder="Nordic industrial PE fund">') +
    field('Type', selectHtml('buyer_type', Object.keys(BUYER_TYPES).map(function (k) { return [k, BUYER_TYPES[k]]; }), b.buyer_type || 'PE')) +
    '<div class="full">' + field('Sectors', '<input type="text" name="sectors" value="' + attr(toList(b.sectors).join(', ')) + '" placeholder="Industrial equipment, Manufacturing">', 'Comma separated') + '</div>' +
    '<div class="full"><div class="field"><label>Geographies</label><div class="checks">' + Object.keys(COUNTRIES).map(function (k) {
      return '<label><input type="checkbox" name="geographies" value="' + k + '" ' + (geos.indexOf(k) >= 0 ? 'checked' : '') + '>' + flag(k) + ' ' + esc(COUNTRIES[k]) + '</label>';
    }).join('') + '</div></div></div>' +
    field('Revenue min (€M)', '<input type="number" step="0.1" min="0" name="revenue_min_m" value="' + (b.revenue_min_eur != null ? attr(b.revenue_min_eur / 1e6) : '') + '">') +
    field('Revenue max (€M)', '<input type="number" step="0.1" min="0" name="revenue_max_m" value="' + (b.revenue_max_eur != null ? attr(b.revenue_max_eur / 1e6) : '') + '">') +
    field('EBITDA min (€M)', '<input type="number" step="0.1" name="ebitda_min_m" value="' + (b.ebitda_min_eur != null ? attr(b.ebitda_min_eur / 1e6) : '') + '">') +
    field('EBITDA max (€M)', '<input type="number" step="0.1" name="ebitda_max_m" value="' + (b.ebitda_max_eur != null ? attr(b.ebitda_max_eur / 1e6) : '') + '">') +
    '<div class="full">' + field('Deal types', '<input type="text" name="deal_types" value="' + attr(toList(b.deal_types).join(', ')) + '" placeholder="majority, buyout">', 'Comma separated') + '</div>' +
    '<div class="full">' + field('Investment thesis', '<textarea name="thesis" rows="3">' + esc(b.thesis || '') + '</textarea>') + '</div>' +
    '<div class="full"><label class="switch"><input type="checkbox" name="active" ' + (b.active === false ? '' : 'checked') + '><span class="track"></span>Active mandate</label></div>' +
    '</div>';
}

function buyerFromForm(fd) {
  const body = {
    name: fd.get('name').trim(), buyer_type: fd.get('buyer_type'),
    sectors: toList(fd.get('sectors')), geographies: fd.getAll('geographies'),
    revenue_min_eur: millions(fd.get('revenue_min_m')), revenue_max_eur: millions(fd.get('revenue_max_m')),
    ebitda_min_eur: millions(fd.get('ebitda_min_m')), ebitda_max_eur: millions(fd.get('ebitda_max_m')),
    deal_types: toList(fd.get('deal_types')), thesis: fd.get('thesis').trim(), active: fd.get('active') === 'on'
  };
  Object.keys(body).forEach(function (k) { if (body[k] === null) delete body[k]; });
  return body;
}

/* ================= SETTINGS ================= */
async function renderSettings() {
  main.innerHTML = pageSkeleton();
  try { state.settings = await api('/api/settings'); updateBanner(); }
  catch (e) { main.innerHTML = errorState(e); return; }
  if (state.view !== 'settings') return;
  drawSettings();
}

function drawSettings() {
  const s = state.settings || {};
  const sender = s.sender || {};
  const fa = s.funnel_assumptions || {};
  main.innerHTML =
    topbar('Settings', crumb([{ label: 'Mergero', href: '#/dashboard' }, { label: 'Settings' }]), '<span class="small muted">AI configuration · sender identity · style · funnel</span>') +
    '<div class="content">' +
    '<form data-form="settings"><div class="settings-grid">' +
    '<div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Anthropic API</div>' +
    (s.api_key_set ? '<span class="pill pill-green">Key set · ' + esc(s.api_key_masked || '••••') + '</span>' : '<span class="pill pill-red">No API key</span>') + '</div>' +
    '<div class="card-body">' +
    field('API key', '<input type="password" name="api_key" autocomplete="off" placeholder="' + (s.api_key_set ? 'Leave blank to keep the current key' : 'sk-ant-…') + '">',
      'Stored server-side only. The agents (research, enrich, score, match, outreach, humanizer, triage, intake) all use this key.') +
    field('Workspace ID', '<input type="text" name="workspace_id" autocomplete="off" value="' + attr(s.workspace_id || '') + '" placeholder="wrkspc_… (only for org-level keys)">',
      'Needed only if Anthropic asks for an anthropic-workspace-id (org-level API keys). Console → Settings → Workspaces.') +
    field('Model', '<input type="text" name="model" value="' + attr(s.model || '') + '" placeholder="claude-opus-5">') +
    '</div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Sender identity</div></div><div class="card-body"><div class="form-grid">' +
    field('Name', '<input type="text" name="sender_name" value="' + attr(sender.name) + '">') +
    field('Title', '<input type="text" name="sender_title" value="' + attr(sender.title) + '">') +
    field('Firm', '<input type="text" name="sender_firm" value="' + attr(sender.firm) + '">') +
    field('Phone', '<input type="text" name="sender_phone" value="' + attr(sender.phone) + '">') +
    '<div class="full">' + field('Email', '<input type="email" name="sender_email" value="' + attr(sender.email) + '">') + '</div>' +
    '</div></div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Funnel assumptions</div><span class="small muted">used for projected mandates</span></div><div class="card-body"><div class="form-grid-3">' +
    field('Contact → reply', '<input type="number" step="0.01" min="0" max="1" name="contact_to_reply" value="' + attr(fa.contact_to_reply != null ? fa.contact_to_reply : '') + '">', 'e.g. 0.18') +
    field('Reply → meeting', '<input type="number" step="0.01" min="0" max="1" name="reply_to_meeting" value="' + attr(fa.reply_to_meeting != null ? fa.reply_to_meeting : '') + '">', 'e.g. 0.45') +
    field('Meeting → mandate', '<input type="number" step="0.01" min="0" max="1" name="meeting_to_mandate" value="' + attr(fa.meeting_to_mandate != null ? fa.meeting_to_mandate : '') + '">', 'e.g. 0.30') +
    '</div></div></div>' +
    '</div>' +
    '<div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Writing style rules</div></div><div class="card-body">' +
    field('Rules the outreach agent must follow', '<textarea name="style_rules" rows="7" style="min-height:150px">' + esc(s.style_rules || '') + '</textarea>') +
    '</div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Value propositions</div></div><div class="card-body">' +
    field('One per line', '<textarea name="value_props" rows="5" style="min-height:110px">' + esc(toList(s.value_props).join('\n')) + '</textarea>', 'Used sparingly in outreach — one concrete reason per message.') +
    '</div></div>' +
    '<div class="card"><div class="card-body"><div class="form-actions" style="justify-content:space-between;margin:0">' +
    '<span class="small muted" id="settings-status"></span><button type="submit" class="btn btn-primary">Save settings</button></div></div></div>' +
    '<div class="card danger-zone"><div class="card-head"><div class="card-title">Demo data</div></div><div class="card-body flex space-between">' +
    '<div class="small muted">Reload the seed prospects, buyers and settings. All enrichment, drafts and conversations are discarded.</div>' +
    '<button type="button" class="btn btn-danger" data-action="reset-demo">Reset demo data</button></div></div>' +
    '</div></div></form>' +
    '</div>';
}

function settingsFromForm(fd) {
  const body = {
    model: fd.get('model').trim(),
    sender: {
      name: fd.get('sender_name').trim(), title: fd.get('sender_title').trim(), firm: fd.get('sender_firm').trim(),
      email: fd.get('sender_email').trim(), phone: fd.get('sender_phone').trim()
    },
    style_rules: fd.get('style_rules'),
    value_props: String(fd.get('value_props') || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
    funnel_assumptions: {
      contact_to_reply: num(fd.get('contact_to_reply')), reply_to_meeting: num(fd.get('reply_to_meeting')), meeting_to_mandate: num(fd.get('meeting_to_mandate'))
    }
  };
  const key = String(fd.get('api_key') || '').trim();
  if (key) body.api_key = key;
  body.workspace_id = String(fd.get('workspace_id') || '').trim();
  Object.keys(body.funnel_assumptions).forEach(function (k) { if (body.funnel_assumptions[k] == null) delete body.funnel_assumptions[k]; });
  return body;
}

/* ================= company-level actions ================= */
async function companyAction(name, fn, successMsg) {
  if (state.running[name]) return;
  state.running[name] = true;
  drawCompany();
  try {
    const result = await fn();
    if (result && result.id) setCompany(result);
    if (successMsg) toast(typeof successMsg === 'function' ? successMsg(result) : successMsg);
  } catch (e) { toast(e.message, 'error'); }
  finally { delete state.running[name]; drawCompany(); }
}

function replaceMessage(msg) {
  const c = state.company;
  if (!c || !msg || !msg.id) return;
  c.messages = c.messages || [];
  const i = c.messages.findIndex(function (m) { return m.id === msg.id; });
  if (i >= 0) c.messages[i] = msg; else c.messages.push(msg);
}

async function messageAction(id, name, fn, successMsg) {
  if (state.msgBusy[id]) return;
  state.msgBusy[id] = name;
  drawCompany();
  try {
    const res = await fn();
    if (res && res.id) replaceMessage(res);
    if (successMsg) toast(successMsg);
    return res;
  } catch (e) { toast(e.message, 'error'); }
  finally { delete state.msgBusy[id]; drawCompany(); }
}

function findMessage(id) {
  const c = state.company;
  return c && (c.messages || []).find(function (m) { return m.id === id; });
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); }
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast('Copied to clipboard');
  } catch (e) { toast('Could not copy: ' + e.message, 'error'); }
}

const COMPANY_ACTIONS = {
  run: function (c) {
    startRunStepper();
    return companyAction('run', async function () {
      try {
        const r = await api('/api/companies/' + encodeURIComponent(c.id) + '/run', 'POST', { language: state.outreachLang, framing: state.outreachFraming });
        state.runStep = RUN_STEPS.length; drawCompany();
        await new Promise(function (res) { setTimeout(res, 600); });
        return r;
      } finally { stopRunStepper(); }
    }, function (r) { return 'Pipeline complete' + (r && r.score ? ' — readiness ' + r.score.readiness + ', ' + ((r.matches || []).length) + ' buyer matches' : ''); });
  },
  research: function (c) {
    state.tab = 'research';
    return companyAction('research', function () { return api('/api/companies/' + encodeURIComponent(c.id) + '/research', 'POST'); },
      function (r) { const x = r && r.research; return x ? 'Research done: ' + plural((x.facts || []).length, 'sourced fact') + ', ' + plural(((x.financials || {}).rows || []).length, 'year') + ' of financials' : 'Research done'; });
  },
  watch: function (c) {
    state.tab = 'research';
    return companyAction('watch', function () { return api('/api/companies/' + encodeURIComponent(c.id) + '/watch', 'POST'); },
      function (r) { const s = r && r.watch && r.watch.last_summary; return s ? 'Checked: ' + s.new_urls + ' new pages, ' + s.changed_pages + ' changed, ' + s.new_facts + ' new facts' : 'Check finished'; });
  },
  teaser: function (c) {
    state.tab = 'buyers';
    return companyAction('teaser', function () { return api('/api/companies/' + encodeURIComponent(c.id) + '/teaser', 'POST'); }, 'Blind teaser drafted: review the redactions before sending');
  },
  enrich: function (c) {
    state.tab = 'profile';
    return companyAction('enrich', function () { return api('/api/companies/' + encodeURIComponent(c.id) + '/enrich', 'POST'); }, 'Enrichment complete');
  },
  score: function (c) {
    state.tab = 'score';
    return companyAction('score', function () { return api('/api/companies/' + encodeURIComponent(c.id) + '/score', 'POST'); },
      function (r) { return 'Scored — readiness ' + (r && r.score ? r.score.readiness : '—'); });
  },
  match: function (c) {
    state.tab = 'buyers';
    return companyAction('match', function () { return api('/api/companies/' + encodeURIComponent(c.id) + '/match', 'POST'); },
      function (r) { return plural((r && r.matches || []).length, 'buyer match', 'buyer matches') + ' found'; });
  },
  outreach: function (c) {
    state.tab = 'outreach';
    return companyAction('outreach', function () { return api('/api/companies/' + encodeURIComponent(c.id) + '/outreach', 'POST', { language: state.outreachLang, framing: state.outreachFraming, channel: c.channel || 'email' }); },
      'Outreach sequence drafted and humanized');
  },
  'intake-link': function (c) {
    state.tab = 'intake';
    return companyAction('intake-link', async function () {
      const res = await api('/api/companies/' + encodeURIComponent(c.id) + '/intake-link', 'POST');
      if (res && res.url) state.intakeUrls[c.id] = res.url;
      return api('/api/companies/' + encodeURIComponent(c.id));
    }, 'Intake link ready — share it with the owner');
  }
};

/* ================= click actions ================= */
const ACTIONS = {
  'close-modal': function () { closeModal(); },
  'reload': function () { route(); },
  'registry-open': function () {
    if (window.MergeroRegistry && typeof window.MergeroRegistry.open === 'function') window.MergeroRegistry.open();
    else toast('Registry lookup module is not loaded', 'error');
  },
  'tab': function (el) { state.tab = el.dataset.tab; drawCompany(); },
  'open-company': function (el) { location.hash = '#/company/' + el.dataset.id; },
  'run-pipeline': function (el) { runPipeline(el); },
  'run-watch': function (el) { runWatch(el); },
  'run-row': function (el) { runRow(el.dataset.id); },
  'open-import': function () { openImportModal(); },
  'open-add-prospect': function () { openAddProspectModal(); },
  'fill-sample-csv': function () { const ta = $('#modal-root textarea[name=csv]'); if (ta) { ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, '\n') : CSV_COLUMNS + '\n') + CSV_SAMPLE.split('\n')[1]; ta.focus(); } },
  'company-action': function (el) { const c = state.company; const fn = COMPANY_ACTIONS[el.dataset.name]; if (c && fn) fn(c); },
  'toggle-humanizer': function (el) { state.expanded[el.dataset.id] = !state.expanded[el.dataset.id]; drawCompany(); },
  'edit-message': function (el) { state.editing[el.dataset.id] = true; drawCompany(); },
  'cancel-edit': function (el) { delete state.editing[el.dataset.id]; drawCompany(); },
  'save-message': function (el) {
    const id = el.dataset.id;
    const card = document.getElementById('msg-' + id);
    const body = card ? card.querySelector('[data-field=body]') : null;
    const subject = card ? card.querySelector('[data-field=subject]') : null;
    const payload = { body: body ? body.value : '' };
    if (subject) payload.subject = subject.value;
    messageAction(id, 'save-message', async function () {
      const m = await api('/api/messages/' + encodeURIComponent(id), 'PUT', payload);
      delete state.editing[id];
      return m;
    }, 'Message saved');
  },
  'approve-message': function (el) {
    const id = el.dataset.id;
    messageAction(id, 'approve-message', function () { return api('/api/messages/' + encodeURIComponent(id) + '/approve', 'POST'); }, 'Approved — ready to send');
  },
  'reject-message': function (el) {
    const id = el.dataset.id;
    messageAction(id, 'reject-message', function () { return api('/api/messages/' + encodeURIComponent(id) + '/reject', 'POST'); }, 'Message rejected');
  },
  'humanize-message': function (el) {
    const id = el.dataset.id;
    messageAction(id, 'humanize-message', function () { return api('/api/messages/' + encodeURIComponent(id) + '/humanize', 'POST'); }, 'Humanizer pass complete');
  },
  'send-message': function (el) {
    const id = el.dataset.id;
    const c = state.company;
    messageAction(id, 'send-message', async function () {
      const res = await api('/api/messages/' + encodeURIComponent(id) + '/send', 'POST');
      if (res && res.message) replaceMessage(res.message);
      if (res && res.mailto) { try { window.open(res.mailto, '_blank'); } catch (e) { /* popup blocked */ } }
      if (c) {
        const fresh = await api('/api/companies/' + encodeURIComponent(c.id));
        setCompany(fresh);
      }
      return null;
    }, 'Marked as sent — logged in the conversation');
  },
  'copy-message': function (el) {
    const m = findMessage(el.dataset.id);
    if (!m) return;
    copyText((m.channel === 'email' && m.subject ? 'Subject: ' + m.subject + '\n\n' : '') + (m.body || ''));
  },
  'copy-text': function (el) { copyText(el.dataset.text || ''); },
  'scroll-to': function (el) {
    const target = document.getElementById(el.dataset.target);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('target');
    setTimeout(function () { target.classList.remove('target'); }, 1800);
  },
  'open-add-buyer': function () {
    openModal('Add buyer mandate', buyerFormHtml(),
      '<button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Add buyer</button>',
      { form: 'add-buyer', wide: true });
  },
  'open-edit-buyer': function (el) {
    const b = state.buyers.find(function (x) { return x.id === el.dataset.id; });
    if (!b) return;
    openModal('Edit buyer mandate', '<input type="hidden" name="id" value="' + attr(b.id) + '">' + buyerFormHtml(b),
      '<button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Save changes</button>',
      { form: 'edit-buyer', wide: true });
  },
  'delete-buyer': async function (el) {
    const b = state.buyers.find(function (x) { return x.id === el.dataset.id; });
    if (!b || !confirm('Delete buyer mandate "' + b.name + '"?')) return;
    await withBusy(el, 'Deleting…', async function () {
      await api('/api/buyers/' + encodeURIComponent(b.id), 'DELETE');
      state.buyers = state.buyers.filter(function (x) { return x.id !== b.id; });
      toast('Buyer deleted');
      drawBuyers();
    });
  },
  'reset-demo': async function (el) {
    if (!confirm('Reset all demo data? Enrichment, drafts and conversations will be lost.')) return;
    await withBusy(el, 'Resetting…', async function () {
      await api('/api/reset-demo', 'POST');
      state.job = null; state.buyersLoaded = false; state.company = null;
      toast('Demo data reset');
      await loadSettings();
      location.hash = '#/dashboard';
      if (state.view === 'dashboard') renderDashboard();
    });
  }
};

/* ================= form submits ================= */
const FORMS = {
  'import-csv': async function (form, fd, submitBtn) {
    const csv = String(fd.get('csv') || '').trim();
    if (!csv) { toast('Paste CSV text first', 'error'); return; }
    await withBusy(submitBtn, 'Importing…', async function () {
      const res = await api('/api/companies/import', 'POST', { csv: csv });
      closeModal();
      toast('Imported ' + plural(res.imported != null ? res.imported : (res.companies || []).length, 'prospect'));
      renderProspects();
    });
  },
  'add-prospect': async function (form, fd, submitBtn) {
    const body = prospectFromForm(fd);
    if (!body.name) { toast('Company name is required', 'error'); return; }
    await withBusy(submitBtn, 'Adding…', async function () {
      const c = await api('/api/companies', 'POST', body);
      closeModal();
      toast('Added ' + c.name);
      location.hash = '#/company/' + c.id;
    });
  },
  'paste-reply': async function (form, fd, submitBtn) {
    const c = state.company;
    const text = String(fd.get('text') || '').trim();
    if (!c || !text) { toast('Paste the owner reply first', 'error'); return; }
    state.tab = 'conversation';
    await companyAction('reply', function () { return api('/api/companies/' + encodeURIComponent(c.id) + '/replies', 'POST', { text: text, channel: fd.get('channel') || 'email' }); },
      function (r) {
        const last = r && (r.conversation || []).filter(function (e) { return e.direction === 'inbound' && e.triage; }).pop();
        return 'Reply triaged' + (last ? ' — intent: ' + humanizeKey(last.triage.intent) + ', stage → ' + stageLabel(r.stage) : '');
      });
  },
  'add-buyer': async function (form, fd, submitBtn) {
    const body = buyerFromForm(fd);
    if (!body.name) { toast('Buyer name is required', 'error'); return; }
    await withBusy(submitBtn, 'Adding…', async function () {
      const b = await api('/api/buyers', 'POST', body);
      state.buyers.push(b);
      closeModal();
      toast('Buyer added');
      drawBuyers();
    });
  },
  'edit-buyer': async function (form, fd, submitBtn) {
    const id = fd.get('id');
    const body = buyerFromForm(fd);
    await withBusy(submitBtn, 'Saving…', async function () {
      const b = await api('/api/buyers/' + encodeURIComponent(id), 'PUT', body);
      const i = state.buyers.findIndex(function (x) { return x.id === id; });
      if (i >= 0) state.buyers[i] = b;
      closeModal();
      toast('Buyer updated');
      drawBuyers();
    });
  },
  'settings': async function (form, fd, submitBtn) {
    const body = settingsFromForm(fd);
    await withBusy(submitBtn, 'Saving…', async function () {
      state.settings = await api('/api/settings', 'PUT', body);
      updateBanner();
      toast('Settings saved');
      drawSettings();
    });
  }
};

/* ================= change handlers ================= */
const CHANGES = {
  'filter-stage': function (el) { state.filters.stage = el.value; drawProspectRows(); },
  'filter-country': function (el) { state.filters.country = el.value; drawProspectRows(); },
  'outreach-lang': function (el) { state.outreachLang = el.value; },
  'outreach-framing': function (el) { state.outreachFraming = el.value; },
  'stage': async function (el) {
    const c = state.company;
    if (!c) return;
    const stage = el.value;
    el.disabled = true;
    try {
      const updated = await api('/api/companies/' + encodeURIComponent(c.id) + '/stage', 'POST', { stage: stage });
      setCompany(updated);
      toast('Stage set to ' + stageLabel(updated.stage || stage));
    } catch (e) { toast(e.message, 'error'); }
    drawCompany();
  },
  'buyer-active': async function (el) {
    const id = el.dataset.id;
    const active = el.checked;
    try {
      const b = await api('/api/buyers/' + encodeURIComponent(id), 'PUT', { active: active });
      const i = state.buyers.findIndex(function (x) { return x.id === id; });
      if (i >= 0) state.buyers[i] = b;
      toast(b.name + (b.active !== false ? ' activated' : ' deactivated'));
    } catch (e) { toast(e.message, 'error'); }
    drawBuyers();
  }
};

/* ================= global event wiring ================= */
document.addEventListener('click', function (e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const handler = ACTIONS[el.dataset.action];
  if (!handler) return;
  if (el.tagName === 'A') e.preventDefault();
  if (el.tagName === 'BUTTON' && !el.getAttribute('type')) e.preventDefault();
  handler(el, e);
});
document.addEventListener('submit', function (e) {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const handler = FORMS[form.dataset.form];
  if (!handler) return;
  const submitBtn = form.querySelector('button[type=submit]');
  handler(form, new FormData(form), submitBtn);
});
document.addEventListener('change', function (e) {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const handler = CHANGES[el.dataset.change];
  if (handler) handler(el, e);
});
document.addEventListener('input', function (e) {
  const el = e.target.closest('[data-input]');
  if (!el) return;
  if (el.dataset.input === 'search') { state.filters.q = el.value; drawProspectRows(); }
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeModal();
});
window.addEventListener('hashchange', route);

/* ================= init ================= */
(async function init() {
  await loadSettings();
  route();
})();
