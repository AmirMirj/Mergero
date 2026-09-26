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
// Where a prospect came from — the channel report on the dashboard groups by this.
const SOURCE_OPTIONS = ['Manual', 'Prospect database import', 'Referral: accountant / auditor', 'Referral: bank SME advisor', 'Referral: succession programme', 'Referral: other partner', 'Inbound enquiry', 'Event / trade fair'];
function sourceKind(s) {
  s = String(s || '').toLowerCase();
  if (s.indexOf('registry') === 0) return 'registry';
  if (s.indexOf('referral') >= 0 || s.indexOf('partner') >= 0) return 'referral';
  if (s.indexOf('inbound') >= 0) return 'inbound';
  if (s.indexOf('scraper') >= 0) return 'scraper';
  if (s.indexOf('database') >= 0) return 'prospect database';
  if (s.indexOf('event') >= 0) return 'event';
  return s ? 'other' : 'manual';
}
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
// Message lifecycle: draft → approved → (scheduled) → sent → replied | bounced; rejected and cancelled end a message.
const STATUS_PILL = {
  draft: 'pill pill-amber', approved: 'pill pill-blue', scheduled: 'pill pill-teal', sent: 'pill pill-green',
  replied: 'pill pill-solid-green', bounced: 'pill pill-red', cancelled: 'pill', rejected: 'pill pill-red'
};

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
  filters: { q: '', stage: '', country: '', source: '' },
  learning: null,     // from /api/learning
  reach: null,        // from /api/registry/reach
  running: {},        // company-level actions in flight: { enrich: true }
  msgBusy: {},        // message id -> action name in flight
  editing: {},        // message id -> true when inline editor open
  expanded: {},       // message id -> humanizer details expanded
  outreachLang: 'en',
  outreachFraming: 'open',
  suggest: null,      // { sellers, buyers, counts } from /api/suggestions
  pairings: [],       // from /api/pairings
  job: null,
  jobTimer: null,
  intakeUrls: {},
  watch: null,        // { watched, alerts } from /api/watch/alerts
  inbox: null,        // { items, counts, unmatched, mail } from /api/inbox
  inboxFilter: 'needs_reply',
  inboxTimer: null,
  mailStatus: null    // /api/mail/status, shown on the settings page
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
  try { state.settings = await api('/api/engine/settings'); }
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

function updateNavBadge(n) {
  const el = document.getElementById('nav-inbox-count');
  if (!el) return;
  if (n) { el.textContent = n; el.classList.remove('hidden'); } else el.classList.add('hidden');
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
    case 'buyside': renderBuyside(parts[1]); break;
    case 'inbox': renderInbox(parts[1]); break;
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
    const res = await Promise.all([api('/api/engine/stats'), api('/api/engine/companies'), api('/api/engine/watch/alerts?limit=12').catch(function () { return null; }),
      api('/api/engine/suggestions').catch(function () { return null; }), api('/api/engine/pairings').catch(function () { return []; }),
      api('/api/engine/learning').catch(function () { return null; }), api('/api/engine/registry/reach').catch(function () { return null; }),
      api('/api/engine/advisors/capacity').catch(function () { return null; })]);
    stats = res[0]; companies = res[1]; state.watch = res[2]; state.suggest = res[3]; state.pairings = res[4] || []; state.learning = res[5]; state.reach = res[6]; state.capacity = res[7];
  } catch (e) { main.innerHTML = errorState(e); return; }
  if (state.view !== 'dashboard') return;
  state.stats = stats || {};
  setCompanies(companies);
  updateNavBadge(state.stats.replies_unhandled || 0);
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
  const replied = state.companies.filter(function (c) { return inboxStatusOf(c) === 'needs_reply'; });
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
    ? '<div class="small muted mt">Assumptions: contact→reply ' + Math.round(fa.contact_to_reply * 100) + '% (Mergero benchmark: 1,000 contacts → 450–500 conversations) · reply→meeting ' +
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
    capacityCardHtml(state.capacity) +
    suggestCardHtml() +
    '<div class="grid-2 mb">' + scaleCardHtml(s.scale) + learningCardHtml() + '</div>' +
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
    '<div class="card"><div class="card-head"><div class="card-title">Owners waiting for an answer</div><span class="flex" style="gap:8px;align-items:center"><span class="pill ' + (replied.length ? 'pill-amber' : '') + '">' + replied.length + '</span><a class="small" href="#/inbox">Open inbox →</a></span></div>' +
    '<div class="card-body">' + (replied.length ? '<div class="mini-list">' + replied.slice(0, 8).map(function (c) {
      const last = (c.conversation || []).filter(function (e) { return e.direction === 'inbound'; }).pop();
      const t = last && last.triage;
      return '<div class="mini-item"><div><a class="t" href="#/inbox/' + attr(c.id) + '">' + flag(c.country) + ' ' + esc(c.name) + '</a>' +
        '<div class="s">' + (t ? '<span class="' + (INTENT_PILL[t.intent] || 'pill') + '">' + esc(humanizeKey(t.intent)) + '</span> ' : '') +
        (last ? esc(String(last.text).slice(0, 90)) + (last.text.length > 90 ? '…' : '') : 'Reply drafted, not sent') + '</div></div>' +
        '<a class="btn btn-ghost btn-xs" href="#/inbox/' + attr(c.id) + '">Reply →</a></div>';
    }).join('') + (replied.length > 8 ? '<div class="small muted mt-sm">+' + (replied.length - 8) + ' more in the inbox</div>' : '') + '</div>'
      : '<div class="muted small">No owner is waiting. Replies arrive by email (Resend) or are pasted on the prospect.</div>') + '</div></div>' +
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
/* ---- Suggested outreach: owners to contact next, and buyers to tell about warm opportunities ---- */
const NEXT_LABEL = { approve_first_touch: 'Approve first touch', send_first_touch: 'Send first touch', draft_outreach: 'Draft outreach', run_pipeline: 'Run pipeline', draft_buyer_note: 'Draft note' };
const WARM_STAGES = ['replied', 'warming', 'meeting_booked', 'mandate_signed'];
function suggestCardHtml() {
  const sg = state.suggest;
  if (!sg) return '';
  const sellers = sg.sellers || [], buyers = sg.buyers || [];
  const sellerHtml = sellers.length ? '<div class="mini-list">' + sellers.slice(0, 6).map(function (x) {
    return '<div class="mini-item"><div><a class="t" href="#/company/' + attr(x.company_id) + '">' + flag(x.country) + ' ' + esc(x.company_name) + '</a>' +
      '<div class="s">' + esc(x.why) + '</div></div>' +
      '<div class="flex" style="gap:6px"><button class="btn btn-secondary btn-xs" data-action="pair" data-company="' + attr(x.company_id) + '" title="Pair with the best-fitting buyer and see why">⚡ Pair</button>' +
      '<a class="btn btn-ghost btn-xs" href="#/company/' + attr(x.company_id) + '">' + esc(NEXT_LABEL[x.next] || 'Open') + ' →</a></div></div>';
  }).join('') + '</div>' : '<div class="muted small">Every prospect has been contacted. Import more from the registries.</div>';
  const buyerHtml = buyers.length ? '<div class="mini-list">' + buyers.slice(0, 6).map(function (x) {
    return '<div class="mini-item"><div><a class="t" href="#/buyers">' + esc(x.buyer_name) + '</a> <span class="' + (BUYER_TYPE_PILL[x.buyer_type] || 'pill') + '">' + esc(BUYER_TYPES[x.buyer_type] || x.buyer_type) + '</span>' +
      '<div class="s">' + esc(x.opportunity) + ' · <a href="#/company/' + attr(x.company_id) + '">' + esc(x.company_name) + '</a> · ' + esc(stageLabel(x.stage)) + ' · <strong>' + x.fit + '% fit</strong></div></div>' +
      '<button class="btn btn-secondary btn-xs" data-action="pair" data-buyer="' + attr(x.buyer_id) + '" data-company="' + attr(x.company_id) + '" title="Pair and see why">⚡ Pair</button></div>';
  }).join('') + '</div>' : '<div class="muted small">No warm owner conversation to share yet. Buyers are told only once an owner has replied.</div>';
  return '<div class="card mb"><div class="card-head"><div class="card-title">Suggested outreach · both sides</div>' +
    '<span class="small muted">' + plural((sg.counts || {}).sellers || 0, 'owner') + ' to contact · ' + plural((sg.counts || {}).buyers || 0, 'buyer') + ' to tell</span></div>' +
    '<div class="card-body suggest-grid">' +
    '<div><div class="section-title">Owners to contact next</div>' + sellerHtml + '</div>' +
    '<div><div class="section-title">Buyers to contact next (anonymised)</div>' + buyerHtml + '</div>' +
    '</div></div>' + pairingsCardHtml();
}

/* ---- Advisor capacity: first touches come from each advisor, capped per day for deliverability ---- */
function capacityCardHtml(cap) {
  if (!cap || !cap.advisors) return '';
  const queued = cap.advisors.reduce(function (n, a) { return n + a.first_touches_queued; }, 0);
  const rows = cap.advisors.map(function (a) {
    const pctUsed = Math.min(100, Math.round(a.sent_today / Math.max(1, a.daily_cap) * 100));
    return '<div class="mini-item"><div style="flex:1"><div class="t">' + esc(a.name) + ' <span class="small muted">' + esc((a.markets || []).join(' · ') || 'all markets') + '</span></div>' +
      '<div class="funnel-bar-wrap mt-sm"><div class="funnel-bar ' + (a.sent_today ? '' : 'zero') + '" style="width:' + Math.max(a.sent_today ? 3 : 0, pctUsed) + '%"></div></div>' +
      '<div class="s">' + a.sent_today + ' / ' + a.daily_cap + ' emails sent today · ' + plural(a.prospects, 'prospect') + ' · ' + plural(a.first_touches_queued, 'first touch', 'first touches') + ' approved or queued</div></div></div>';
  }).join('');
  const row = function (label, value, sub) { return '<div class="kv-item"><div class="kv-key">' + esc(label) + '</div><div class="kv-val">' + esc(value) + '</div>' + (sub ? '<div class="small muted">' + esc(sub) + '</div>' : '') + '</div>'; };
  return '<div class="card mb"><div class="card-head"><div class="card-title">Outreach capacity · from each advisor</div>' +
    '<button class="btn btn-primary btn-sm" data-action="queue-first-touches" title="Spread every approved first-touch email over each advisor\'s working day, best prospects first, within the daily cap">⏱ Queue approved first touches' + (queued ? ' (' + queued + ')' : '') + '</button></div>' +
    '<div class="card-body"><div class="grid-2"><div class="mini-list">' + rows + '</div>' +
    '<div><div class="buyer-range" style="grid-template-columns:repeat(3,1fr)">' +
    row('Emails per day', fmtNum(cap.emails_per_day), 'sum of the advisors\' daily caps') +
    row('New owners / month', fmtNum(cap.new_owners_per_month), 'first touch + 2 follow-ups share the cap') +
    row('Conversations / month', fmtNum(cap.conversations_per_month), 'at the contact → reply rate') +
    '</div><div class="small muted mt">' + esc(cap.benchmark) + '. Each advisor sends under their own name; over the cap, emails wait for the next morning. Add advisors or change caps in Settings.</div></div></div></div></div>';
}

/* ---- Scale numbers: measured cost and speed, and how many companies the open registers reach ---- */
function scaleCardHtml(sc) {
  sc = sc || {};
  const reach = state.reach && state.reach.countries ? state.reach.countries : [];
  const live = reach.filter(function (r) { return r.live && r.companies != null; });
  const row = function (label, value, sub) { return '<div class="kv-item"><div class="kv-key">' + esc(label) + '</div><div class="kv-val">' + esc(value) + '</div>' + (sub ? '<div class="small muted">' + esc(sub) + '</div>' : '') + '</div>'; };
  return '<div class="card"><div class="card-head"><div class="card-title">Scale numbers</div><span class="small muted">' + (sc.prospects_measured ? 'measured on ' + plural(sc.prospects_measured, 'full pipeline run') : 'run the pipeline to measure') + '</span></div>' +
    '<div class="card-body"><div class="buyer-range" style="grid-template-columns:repeat(3,1fr)">' +
    row('API cost per prospect', sc.cost_per_prospect_usd != null ? '$' + sc.cost_per_prospect_usd.toFixed(2) : '—', 'research → outreach, all agents') +
    row('Minutes per prospect', sc.minutes_per_prospect != null ? String(sc.minutes_per_prospect) : '—', 'wall time, one prospect') +
    row('Prospects per hour', sc.prospects_per_hour_at_3 != null ? fmtNum(sc.prospects_per_hour_at_3) : '—', 'at 3 in parallel; scales with concurrency') +
    '</div>' +
    '<div class="small muted mt">Total API spend so far: $' + (sc.api_spend_usd != null ? sc.api_spend_usd.toFixed(2) : '0.00') + '</div>' +
    (reach.length ? '<div class="section-title mt">Registry reach (companies the engine can pull directly)</div><div class="small">' +
      reach.map(function (r) { return '<div class="flex space-between" style="gap:8px;padding:3px 0"><span>' + flag(r.country.slice(0, 2)) + ' ' + esc(r.country) + '</span><span class="' + (r.live ? 'strong' : 'muted') + '">' + (r.companies != null ? fmtNum(r.companies) + ' · ' + esc(r.basis) : esc(r.basis)) + '</span></div>'; }).join('') +
      '</div>' : '') +
    '</div></div>';
}

/* ---- Learning loop: what gets replies, meetings and mandates ---- */
function learningCardHtml() {
  const L = state.learning;
  if (!L) return '';
  const pct = function (x) { return Math.round((x || 0) * 100) + '%'; };
  const table = function (title, rows, label) {
    rows = (rows || []).filter(function (r) { return r.n >= 3; }).slice(0, 6);
    if (!rows.length) return '';
    return '<div class="section-title mt-sm">' + esc(title) + '</div><table class="table compact"><thead><tr><th>' + esc(label) + '</th><th class="right">n</th><th class="right">Reply</th><th class="right">Meeting</th><th class="right">Mandate</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr><td>' + esc(label === 'Framing' ? (FRAMINGS[r.key] || r.key) : label === 'Country' ? flag(r.key) + ' ' + esc(countryName(r.key)) : humanizeKey(r.key)) + '</td><td class="right">' + r.n + '</td><td class="right strong">' + pct(r.reply_rate) + '</td><td class="right">' + pct(r.meeting_rate) + '</td><td class="right">' + pct(r.mandate_rate) + '</td></tr>'; }).join('') + '</tbody></table>';
  };
  return '<div class="card"><div class="card-head"><div class="card-title">What’s working</div><span class="small muted">' + L.overall.n + ' first touches' + (L.sample_included ? ' · includes labelled sample history' : '') + '</span></div>' +
    '<div class="card-body">' +
    '<div class="small">Reply ' + pct(L.overall.reply_rate) + ' · meeting ' + pct(L.overall.meeting_rate) + ' · mandate ' + pct(L.overall.mandate_rate) + '. Fed back into the scoring agent and the framing suggestion on each prospect.</div>' +
    table('By framing', L.by_framing, 'Framing') + table('By source', L.by_source, 'Source') + table('By country', L.by_country, 'Country') +
    '</div></div>';
}
function framingHint(c) {
  const L = state.learning;
  if (!L || !c) return '';
  const bf = L.best_framing_by_country && L.best_framing_by_country[c.country];
  if (!bf) return '';
  return ' Best-performing framing in ' + esc(countryName(c.country)) + ' so far: <strong>' + esc(FRAMINGS[bf.framing] || bf.framing) + '</strong> (' + Math.round(bf.reply_rate * 100) + '% replies, n=' + bf.n + ').';
}

/* ---- Pairings: one click pairs a seller with a buyer, with the reasoning spelled out ---- */
const PAIR_STATUS_PILL = { proposed: 'pill pill-amber', active: 'pill pill-green', dismissed: 'pill' };
function pairingsCardHtml() {
  const list = (state.pairings || []).filter(function (p) { return p.status !== 'dismissed'; });
  if (!list.length) return '';
  return '<div class="card mb"><div class="card-head"><div class="card-title">Pairings</div><span class="small muted">' + plural(list.length, 'pairing') + '</span></div>' +
    '<div class="card-body"><div class="mini-list">' + list.slice(0, 8).map(function (p) {
      return '<div class="mini-item"><div><a class="t" href="#/company/' + attr(p.company_id) + '">' + flag(p.country) + ' ' + esc(p.company_name) + '</a> <span class="muted">↔</span> <a class="t" href="#/buyers">' + esc(p.buyer_name) + '</a>' +
        '<div class="s"><strong>' + p.fit + '% fit</strong> · ' + p.rationale.passed + '/' + p.rationale.total + ' checks · ' + esc(FRAMINGS[p.framing] || p.framing) + ' · <span class="' + (PAIR_STATUS_PILL[p.status] || 'pill') + '">' + esc(p.status) + '</span>' +
        (p.buyer_message_id ? ' · <a href="#/buyers">buyer note drafted →</a>' : '') + '</div></div>' +
        '<div class="flex" style="gap:6px"><button class="btn btn-ghost btn-xs" data-action="pairing-why" data-id="' + attr(p.id) + '">Why</button>' +
        (p.status === 'proposed' ? '<button class="btn btn-primary btn-xs" data-action="pairing-accept" data-id="' + attr(p.id) + '">✓ Accept</button>' : '') +
        '<button class="btn btn-ghost btn-xs" data-action="pairing-dismiss" data-id="' + attr(p.id) + '" title="Dismiss">×</button></div></div>';
    }).join('') + '</div></div></div>';
}
function pairingModal(p) {
  const r = p.rationale || {};
  const body = '<div class="pair-head"><div><div class="strong">' + flag(p.country) + ' ' + esc(p.company_name) + '</div><div class="small muted">' + esc(stageLabel(p.stage)) + '</div></div>' +
    '<div class="pair-arrow">↔</div><div><div class="strong">' + esc(p.buyer_name) + '</div><div class="small muted">' + esc(BUYER_TYPES[p.buyer_type] || p.buyer_type || '') + '</div></div>' +
    '<div class="pair-fit">' + p.fit + '%<div class="small muted">fit</div></div></div>' +
    '<p class="mt">' + esc(r.summary || '') + '</p>' +
    '<div class="check-list">' + (r.checks || []).map(function (c) {
      return '<div class="check ' + (c.ok ? 'ok' : 'no') + '"><span class="mark">' + (c.ok ? '✔' : '✘') + '</span><div><div class="strong small">' + esc(c.label) + '</div><div class="small">' + esc(c.note) + '</div></div></div>';
    }).join('') + '</div>' +
    '<div class="small muted mt">Buyer thesis: ' + esc(r.thesis || '') + '</div>' +
    '<div class="mt-sm"><span class="section-title">Next</span> ' + esc((p.next_steps || [])[0] || '') + '</div>';
  const foot = '<button type="button" class="btn btn-ghost" data-action="pairing-dismiss" data-id="' + attr(p.id) + '">Dismiss</button>' +
    (p.status === 'proposed' ? '<button type="button" class="btn btn-primary" data-action="pairing-accept" data-id="' + attr(p.id) + '">✓ Accept pairing' + (WARM_STAGES.indexOf(p.stage) >= 0 ? ' & draft buyer note' : '') + '</button>'
      : '<button type="button" class="btn btn-secondary" data-action="close-modal">Close</button>');
  openModal('Pairing · ' + (r.passed != null ? r.passed + ' of ' + r.total + ' checks pass' : ''), body, foot, { wide: true });
}
async function refreshPairings() { state.pairings = await api('/api/engine/pairings').catch(function () { return state.pairings; }); if (state.view === 'dashboard') drawDashboard(); }

/* ---- Buyer-side notes and contacts (shown on the Buyers page) ---- */
function buyerOppsHtml(b) {
  const opps = ((state.suggest && state.suggest.buyers) || []).filter(function (x) { return x.buyer_id === b.id; });
  if (!opps.length) return '';
  return '<div class="buyer-opps"><div class="kv-key">Opportunities to share</div>' + opps.slice(0, 3).map(function (x) {
    return '<div class="opp"><div><a href="#/company/' + attr(x.company_id) + '">' + esc(x.company_name) + '</a> <span class="small muted">' + esc(x.opportunity) + ' · ' + esc(stageLabel(x.stage)) + ' · ' + x.fit + '% fit</span></div>' +
      '<button class="btn btn-secondary btn-xs" data-action="draft-buyer-note" data-buyer="' + attr(b.id) + '" data-company="' + attr(x.company_id) + '">✉ Draft note</button></div>';
  }).join('') + '</div>';
}
function buyerMessagesHtml(b) {
  const msgs = b.messages || [];
  if (!msgs.length) return '';
  return '<div class="buyer-msgs">' + msgs.slice(0, 4).map(function (m) {
    const status = m.status || 'draft';
    const c = state.companyMap[m.company_id];
    return '<div class="buyer-msg" id="bmsg-' + attr(m.id) + '"><div class="flex space-between flex-wrap" style="gap:6px">' +
      '<div class="small"><strong>To</strong> ' + esc(m.to_name || '') + ' <span class="muted">&lt;' + esc(m.to || '') + '&gt;</span>' + (c ? ' · about <a href="#/company/' + attr(c.id) + '">' + esc(c.name) + '</a>' : '') + '</div>' +
      '<span class="' + (STATUS_PILL[status] || 'pill') + '">' + esc(status) + '</span></div>' +
      '<div class="strong mt-sm">' + esc(m.subject || '') + '</div><div class="msg-body small">' + esc(m.body || '') + '</div>' +
      '<div class="flex mt-sm" style="gap:6px;justify-content:flex-end">' +
      '<button class="btn btn-ghost btn-xs" data-action="copy-text" data-text="' + attr((m.subject ? 'Subject: ' + m.subject + '\n\n' : '') + (m.body || '')) + '">⧉ Copy</button>' +
      (status === 'draft' || status === 'approved' ? '<button class="btn btn-danger btn-xs" data-action="buyer-msg-reject" data-id="' + attr(m.id) + '">Reject</button>' : '') +
      (status === 'draft' ? '<button class="btn btn-secondary btn-xs" data-action="buyer-msg-approve" data-id="' + attr(m.id) + '">✓ Approve</button>' : '') +
      (status === 'approved' ? '<button class="btn btn-primary btn-xs" data-action="buyer-msg-send" data-id="' + attr(m.id) + '">✉ Send</button>' : '') +
      '</div></div>';
  }).join('') + '</div>';
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
    const res = await api('/api/engine/watch/run', 'POST', {});
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
    const res = await api('/api/engine/pipeline/run', 'POST', { stage: 'new' });
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
      const j = await api('/api/engine/jobs/' + encodeURIComponent(state.job.id));
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
  try { setCompanies(await api('/api/engine/companies')); }
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
    if (f.source && sourceKind(c.source) !== f.source) return false;
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
    '<select class="inline" data-change="filter-source"><option value="">All sources</option>' + Object.keys(state.companies.reduce(function (acc, c) { acc[sourceKind(c.source)] = 1; return acc; }, {})).sort().map(function (k) {
      return '<option value="' + attr(k) + '"' + (f.source === k ? ' selected' : '') + '>' + esc(humanizeKey(k)) + '</option>';
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
      '<td class="primary-cell">' + esc(c.name) + '<span class="sub">' + esc([c.city, c.ownership_type].filter(Boolean).join(' · ')) + '</span>' +
      (c.website ? '<span class="sub"><a href="' + attr(c.website) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(c.website.replace(/^https?:\/\//, '').replace(/\/$/, '')) + ' ↗</a></span>' : '') + '</td>' +
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
    const c = await api('/api/engine/companies/' + encodeURIComponent(id) + '/run', 'POST', { language: state.outreachLang, framing: state.outreachFraming });
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
    field('Source', selectHtml('source', SOURCE_OPTIONS.map(function (s) { return [s, s]; }), c.source || 'Manual')) +
    field('Referred by (partner)', '<input type="text" name="referrer" value="' + attr(c.referrer) + '" placeholder="e.g. accountant, bank SME advisor, Omistajanvaihdos">') +
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
    source: fd.get('source') || 'Manual', referrer: String(fd.get('referrer') || '').trim(),
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
    const jobs = [api('/api/engine/companies/' + encodeURIComponent(id))];
    if (!state.learning) api('/api/engine/learning').then(function (L) { state.learning = L; if (state.view === 'company') drawCompany(); }).catch(function () { /* optional */ });
    if (!state.buyersLoaded) jobs.push(api('/api/engine/buyers'));
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

function advisorPicker(c) {
  const list = (state.settings && state.settings.advisors) || [];
  if (list.length < 2) return '';
  const cur = advisorOf(c);
  return '<label>Advisor (sends and signs)</label><select data-change="advisor" class="inline">' + list.map(function (a) {
    return '<option value="' + attr(a.id) + '"' + (cur && cur.id === a.id ? ' selected' : '') + '>' + esc(a.name) + (c.advisor_id ? '' : cur && cur.id === a.id ? ' (by market)' : '') + '</option>';
  }).join('') + '</select>';
}
function drawCompany() {
  if (state.view === 'inbox') { drawInbox(); return; } // message and reply actions redraw whichever view owns the company
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
    advisorPicker(c) +
    '<div class="small muted">Updated ' + fmtDate(c.updated_at) + '</div></div></div>' +

    '<div class="toolbar">' +
    '<div class="card owner-card"><div class="owner-avatar">' + esc(initials(o.name)) + '</div><div>' +
    '<div class="owner-name">' + esc(o.name || 'Owner unknown') + '</div><div class="owner-title">' + esc(o.title || '') + '</div>' +
    '<div class="owner-facts">' +
    (o.age || o.tenure_years ? '<span>' + [o.age ? 'Age ' + o.age + (o.age_source ? ' <span class="pill pill-outline" title="' + attr(o.age_source) + '">register</span>' : '') : '', o.tenure_years ? o.tenure_years + ' yrs tenure' : ''].filter(Boolean).join(' · ') + '</span>' : '') +
    (c.country === 'NO' && c.registry_id ? '<span><button class="btn btn-ghost btn-xs" data-action="company-action" data-name="people" title="Read CEO and chair with birth dates from Brønnøysund">' + (state.running.people ? '<span class="spinner dark"></span>' : '') + (c.people && c.people.length ? '↻ Register roles (' + c.people.length + ')' : 'Owner age from register') + '</button></span>' : '') +
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
    '</div>' + (busyRun ? stepperHtml(state.runStep) : '<div class="small muted">Research → enrich → score → match → draft. Research is reused for 7 days; "Research web" refreshes it.' + framingHint(c) + '</div>') + '</div></div>' +

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
    (s.scored_at ? '<div class="small muted right">Scored ' + fmtDate(s.scored_at) + (s.rescored_at ? ' · updated from a reply ' + fmtDate(s.rescored_at) : '') + '</div>' : '') +
    '</div></div></div>' +
    '<div>' +
    scoreHistoryHtml(s) +
    '<div class="card"><div class="card-head"><div class="card-title">Why now</div></div><div class="card-body"><div class="why-now">' + esc(s.why_now || '—') + '</div></div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Signals behind the score</div></div><div class="card-body tight"><div class="table-wrap"><table class="table compact"><thead><tr><th>Signal</th><th>Dir.</th><th>Weight</th><th>Note</th></tr></thead><tbody>' +
    ((s.signals || []).length ? s.signals.map(function (g) {
      const pos = String(g.direction || '').toLowerCase().indexOf('pos') === 0 || g.direction === '+';
      const neg = String(g.direction || '').toLowerCase().indexOf('neg') === 0 || g.direction === '-';
      const wCls = g.weight === 'high' ? 'pill-navy' : g.weight === 'medium' ? 'pill-blue' : '';
      return '<tr><td class="strong">' + esc(g.signal) + (g.source === 'reply' ? ' <span class="pill pill-teal" title="Learned from the owner\'s reply">reply</span>' : '') + '</td><td><span class="dir ' + (pos ? 'pos' : neg ? 'neg' : '') + '">' + (pos ? '+' : neg ? '−' : '·') + '</span></td>' +
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
  return '<div class="card"><div class="card-body"><div class="flex space-between flex-wrap" style="gap:8px"><div class="headline"><span class="n">' + matches.length + '</span> ' + (matches.length === 1 ? 'buyer' : 'buyers') +
    ' in the Mergero network ' + (matches.length === 1 ? 'has' : 'have') + ' appetite for this company</div>' +
    '<button class="btn btn-primary btn-sm" data-action="pair" data-company="' + attr(c.id) + '">⚡ Pair with best buyer</button></div>' +
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
        '<div class="fit"><div class="fit-num">' + fit + '% fit</div><div class="bar"><div class="bar-fill ' + (fit >= 75 ? 'green' : fit >= 50 ? '' : 'amber') + '" style="width:' + fit + '%"></div></div>' +
        (WARM_STAGES.indexOf(c.stage) >= 0 ? '<button class="btn btn-secondary btn-xs mt-sm" data-action="draft-buyer-note" data-buyer="' + attr(m.buyer_id) + '" data-company="' + attr(c.id) + '">✉ Tell this buyer</button>' : '') +
        '</div></div>';
    }).join('') + '</div>' +
    (WARM_STAGES.indexOf(c.stage) >= 0 ? '' : '<div class="card-body small muted" style="padding-top:0">Anonymised buyer notes unlock once the owner has replied; until then nothing about this company goes to buyers.</div>') +
    '</div>' + teaserHtml(c);
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

/* ---- Human-language check: deterministic linter + humanizer, shown on every draft ---- */
function humanBadge(m, expanded) {
  const L = m.lint && m.lint.after, h = m.humanizer;
  if (!L && !h) return '';
  const score = L ? L.score : (h && h.ai_tell_score_after != null ? h.ai_tell_score_after : null);
  const before = m.lint && m.lint.before ? m.lint.before.score : (h && h.ai_tell_score_before != null ? h.ai_tell_score_before : null);
  const grade = L ? L.grade : (score == null ? '' : score <= 15 ? 'human' : score <= 35 ? 'acceptable' : 'robotic');
  const blocked = L && L.blocks_send && !m.lint_override;
  const cls = blocked ? 'blocked' : grade === 'human' ? 'good' : grade === 'acceptable' ? 'ok' : 'bad';
  return '<button class="humanizer-btn ' + cls + '" data-action="toggle-humanizer" data-id="' + attr(m.id) + '" title="Human-language check: lower is more human. Click for details">' +
    (blocked ? '⛔ ' : grade === 'human' ? '🧬 ' : '🧬 ') + 'Human check ' + (before != null && before !== score ? esc(before) + ' → ' : '') + esc(score != null ? score : '?') +
    (grade ? ' · ' + esc(grade) : '') + (L && L.personalization ? ' · ' + L.personalization.count + ' specific ' + (L.personalization.count === 1 ? 'fact' : 'facts') : '') +
    (m.lint_override ? ' · override' : '') + ' ' + (expanded ? '▴' : '▾') + '</button>';
}
function humanDetail(m) {
  const L = m.lint && m.lint.after, h = m.humanizer || {};
  const sev = { high: 'pill pill-red', medium: 'pill pill-amber', low: 'pill' };
  let html = '<div class="humanizer-detail">';
  if (L) {
    html += '<h5>Linter · ' + plural((L.flags || []).length, 'finding') + (L.metrics ? ' · ' + L.metrics.words + ' words, ' + L.metrics.sentences + ' sentences, avg ' + L.metrics.avg_sentence + ' · rhythm σ ' + L.metrics.rhythm_sd : '') + '</h5>' +
      ((L.flags || []).length ? '<ul>' + L.flags.map(function (f) { return '<li><span class="' + (sev[f.severity] || 'pill') + '">' + esc(f.rule) + '</span> ' + (f.excerpt ? '<em>“' + esc(f.excerpt) + '”</em> · ' : '') + esc(f.fix || '') + '</li>'; }).join('') + '</ul>' : '<div class="muted">No machine or template tells found.</div>') +
      '<h5>Personalisation · ' + plural((L.personalization && L.personalization.count) || 0, 'specific fact') + ' used</h5>' +
      (L.personalization && L.personalization.points && L.personalization.points.length ? '<ul>' + L.personalization.points.map(function (p) { return '<li>' + esc(p.fact) + '</li>'; }).join('') + '</ul>' : '<div class="muted">No sourced fact about this company appears in the text.</div>') +
      (L.similarity && L.similarity.max >= 0.12 ? '<h5>Reuse</h5><div>' + Math.round(L.similarity.max * 100) + '% of the wording also appears in the email to ' + esc(L.similarity.with) + (L.similarity.shared && L.similarity.shared[0] ? ': <em>“' + esc(L.similarity.shared[0]) + '…”</em>' : '') + '</div>' : '') +
      (L.blocks_send ? '<div class="mt-sm ' + (m.lint_override ? 'muted' : 'text-red') + '">' + (m.lint_override ? 'Send gate overridden by the advisor.' : '⛔ Sending is blocked until this is fixed.') + ' ' +
        (m.status !== 'sent' ? '<button class="btn btn-ghost btn-xs" data-action="humanize-message" data-id="' + attr(m.id) + '">↻ Fix with humanizer</button> <button class="btn btn-ghost btn-xs" data-action="lint-override" data-id="' + attr(m.id) + '" data-value="' + (m.lint_override ? '0' : '1') + '">' + (m.lint_override ? 'Remove override' : 'Override and allow sending') + '</button>' : '') + '</div>' : '');
  }
  if (h && ((h.flags || []).length || (h.changes || []).length)) {
    html += '<h5>Humanizer · what it changed (' + ((h.changes || []).length) + ')</h5>' + ((h.changes || []).length ? '<ul>' + h.changes.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' : '<div class="muted">No changes applied.</div>');
  }
  return html + '</div>';
}

/* ---- Message card (shared by Outreach + Conversation) ---- */
function advisorOf(c) {
  const list = (state.settings && state.settings.advisors) || [];
  if (!c) return list[0] || null;
  return list.find(function (a) { return a.id === c.advisor_id; }) || list.find(function (a) { return (a.markets || []).indexOf(c.country) >= 0; }) || list[0] || null;
}
function messageMeta(m) {
  const d = m.delivery || null;
  const via = !d ? '' : d.provider === 'resend' ? ' · by email' + (d.status && d.status !== 'sent' ? ' · ' + humanizeKey(d.status).toLowerCase() : '') + (d.via === 'scheduler' ? ' · scheduler' : '')
    : d.provider === 'mailto' ? ' · via your mail client' : '';
  const err = d && d.error ? ' · ⚠ ' + d.error : '';
  if (m.status === 'scheduled') return (m.due ? 'Due now' : 'Scheduled for ' + fmtDate(m.send_at)) + (m.deferred_reason === 'daily cap' ? ' · held by the advisor\'s daily cap' : '') + err;
  if (m.status === 'cancelled') return 'Cancelled' + (m.cancel_reason ? ' · ' + m.cancel_reason : '');
  if (m.sent_at) return 'Sent ' + fmtDate(m.sent_at) + via + err;
  return m.created_at ? 'Drafted ' + fmtDate(m.created_at) : '';
}
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
  const done = status === 'sent' || status === 'replied' || status === 'bounced';
  const seqMsgs = (state.company && state.company.messages) || [];
  const firstSentAt = seqMsgs.filter(function (x) { return x.step > 0 && x.sent_at; }).map(function (x) { return x.sent_at; }).sort()[0];
  const ownerReplied = !!firstSentAt && ((state.company && state.company.conversation) || []).some(function (e) { return e.direction === 'inbound' && e.channel !== 'intake' && String(e.at) > String(firstSentAt); });
  // A seeded or re-approved follow-up whose first touch already went out can still be put on the clock, unless the owner has answered.
  const canSchedule = status === 'approved' && m.step > 1 && !!firstSentAt && !ownerReplied && m.channel === 'email';
  const mailOn = !!(state.settings && state.settings.mail && state.settings.mail.configured);
  const sendLabel = m.channel !== 'email' ? '➤ Mark as sent' : status === 'scheduled' ? '✉ Send now' : mailOn ? '✉ Send' : '✉ Send via mail client';
  const actions = editing
    ? btn('cancel-edit', 'Cancel', 'btn-ghost', true) + btn('save-message', 'Save changes', 'btn-primary', true)
    : btn('copy-message', '⧉', 'btn-ghost btn-icon" title="Copy to clipboard', true) +
      btn('humanize-message', '↻ Re-humanize', 'btn-ghost', !done && status !== 'cancelled') +
      btn('edit-message', '✎ Edit', 'btn-ghost', !done && status !== 'cancelled') +
      btn('reject-message', 'Reject', 'btn-danger', status === 'draft' || status === 'approved' || status === 'scheduled') +
      btn('approve-message', '✓ Approve', 'btn-secondary', status === 'draft' || status === 'rejected' || status === 'cancelled') +
      btn('schedule-message', '⏱ Schedule', 'btn-secondary', canSchedule) +
      btn('unschedule-message', 'Cancel schedule', 'btn-ghost', status === 'scheduled') +
      btn('send-message', sendLabel, 'btn-primary', status === 'approved' || status === 'scheduled');
  const sender = advisorOf(state.company) || (state.settings && state.settings.sender) || {};
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
    (status === 'scheduled' && m.due ? '<span class="pill pill-amber" title="The scheduler could not send this itself; send it by hand">due now</span>' : '') +
    '<span class="spacer"></span>' +
    humanBadge(m, expanded) +
    '</div>' +
    ((h || (m.lint && m.lint.after)) && expanded ? humanDetail(m) : '') +
    mailHead +
    (editing
      ? '<div class="msg-edit">' + (m.channel === 'email' ? '<input type="text" data-field="subject" value="' + attr(m.subject || '') + '" placeholder="Subject">' : '') +
        '<textarea data-field="body">' + esc(m.body || '') + '</textarea></div>'
      : '<pre class="msg-body">' + esc(m.body || '') + '</pre>') +
    '<div class="msg-actions">' + actions +
    '<span class="meta">' + esc(messageMeta(m)) + '</span></div>' +
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
  const scheduled = seq.filter(function (m) { return m.status === 'scheduled'; }).length;
  const due = seq.filter(function (m) { return m.status === 'scheduled' && m.due; }).length;
  return '<div class="flex space-between mb"><div><div class="strong">Outreach sequence · ' + plural(seq.length, 'step') + '</div>' +
    '<div class="small muted">' + (pending ? plural(pending, 'draft') + ' waiting for your approval. Review, edit if needed, approve, then send. ' : 'All drafts reviewed. ') +
    (scheduled ? plural(scheduled, 'follow-up') + ' on the clock' + (due ? ', ' + due + ' due now' : '') + '. Approved follow-ups go out on their day once the first touch is sent; an owner reply stops them.' : 'Approved follow-ups go out on their day once the first touch is sent; an owner reply stops them.') + '</div></div>' +
    '<div class="flex">' + actionBtn('outreach', '↻ Redraft sequence', 'btn-secondary btn-sm', 'Drafting…') + '</div></div>' +
    seq.map(function (m) { return messageCard(m); }).join('');
}

/* ---- Tab: Conversation ---- */
/* ---- Reply understanding: how an owner's reply moved the score ---- */
function scoreMoveHtml(from, to) {
  if (!to) return '';
  const d = from && from.readiness != null ? to.readiness - from.readiness : null;
  const cls = d == null || d === 0 ? '' : d > 0 ? 'pos' : 'neg';
  return '<span class="score-move ' + cls + '"><span class="muted">Readiness</span> ' + (from && from.readiness != null ? from.readiness + ' → ' : '') + '<strong>' + to.readiness + '</strong>' +
    (d ? ' <span class="delta">(' + (d > 0 ? '+' : '') + d + ')</span>' : '') + '</span>' +
    (from && from.recommended_timing && from.recommended_timing !== to.recommended_timing
      ? '<span class="score-move"><span class="muted">Timing</span> ' + esc(from.recommended_timing) + ' → <strong>' + esc(to.recommended_timing) + '</strong></span>'
      : '<span class="score-move"><span class="muted">Timing</span> <strong>' + esc(to.recommended_timing || '—') + '</strong></span>');
}
function evidenceHtml(list) {
  if (!list || !list.length) return '';
  return '<ul class="evidence">' + list.map(function (ev) {
    return '<li class="' + (ev.effect === 'raises' ? 'pos' : ev.effect === 'lowers' ? 'neg' : '') + '"><span class="q">“' + esc(ev.quote) + '”</span> <span class="muted">' + esc(ev.reading) + '</span></li>';
  }).join('') + '</ul>';
}
function scoreUpdateHtml(e, c) {
  const u = e.score_update;
  if (u) {
    return '<div class="score-update"><div class="score-update-head"><span class="t">Score update</span>' + scoreMoveHtml(u.from, u.to) +
      '<span class="pill pill-outline" title="How sure the reply agent is">' + esc(u.confidence || '') + ' confidence</span>' +
      '<button class="btn btn-ghost btn-xs" style="margin-left:auto" data-action="retry-triage" data-company="' + attr(c.id) + '" data-entry="' + attr(e.id) + '" title="Triage and re-score this reply again">↻ Re-analyse</button></div>' +
      '<div class="small">' + esc(u.reason || '') + '</div>' + evidenceHtml(u.evidence) + '</div>';
  }
  if (e.score_update_error) return '<div class="score-update failed"><div class="score-update-head"><span class="t">Score update failed</span><span class="small">' + esc(e.score_update_error) + '</span>' +
    '<button class="btn btn-secondary btn-xs" style="margin-left:auto" data-action="retry-triage" data-company="' + attr(c.id) + '" data-entry="' + attr(e.id) + '">↻ Retry</button></div></div>';
  return '';
}
function scoreHistoryHtml(s) {
  const h = (s.history || []).slice().reverse();
  if (!h.length) return '';
  return '<div class="card"><div class="card-head"><div class="card-title">Score changes from owner replies</div><span class="small muted">' + plural(h.length, 'reply', 'replies') + ' analysed</span></div><div class="card-body">' +
    h.map(function (x) {
      return '<div class="score-hist"><div class="flex flex-wrap" style="gap:10px;align-items:center">' + scoreMoveHtml(x.from, x.to) + '<span class="small muted">' + fmtDate(x.at) + '</span></div>' +
        '<div class="small mt-sm">' + esc(x.reason || '') + '</div>' + evidenceHtml(x.evidence) + '</div>';
    }).join('') + '</div></div>';
}
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
        '<span class="' + (SENTIMENT_PILL[t.sentiment] || 'pill') + '" title="Sentiment, and how it moved since the previous reply">' + esc(t.sentiment || 'neutral') + (t.sentiment_trend === 'up' ? ' ↑' : t.sentiment_trend === 'down' ? ' ↓' : '') + '</span>' +
        (t.recommended_stage ? '<span class="small muted">→ recommended stage</span>' + stagePill(t.recommended_stage) : '') +
        (reply ? '<a href="#" class="small" style="margin-left:auto" data-action="scroll-to" data-target="msg-' + attr(reply.id) + '">View reply draft ↓</a>' : '') +
        '</div><div class="triage-body">' +
        '<div><h5>Extracted facts</h5>' + ((t.extracted_facts || []).length ?
          '<table class="table compact"><thead><tr><th>Field</th><th>Value</th><th>Conf.</th></tr></thead><tbody>' + t.extracted_facts.map(function (f) {
            const cc = f.confidence === 'high' ? 'pill-green' : f.confidence === 'medium' ? 'pill-amber' : '';
            return '<tr><td class="strong">' + esc(humanizeKey(f.field)) + '</td><td>' + esc(formatValue(f.value)) + '</td><td><span class="pill ' + cc + '">' + esc(f.confidence || '—') + '</span></td></tr>';
          }).join('') + '</tbody></table>' : '<div class="muted small">No new facts extracted.</div>') + '</div>' +
        '<div><h5>Next step</h5><div>' + esc(t.next_step || '—') + '</div>' +
        ((t.open_questions || []).length ? '<h5 class="mt-sm">Owner\'s questions</h5><ul class="open-q">' + t.open_questions.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>' : '') + '</div>' +
        '</div>' + scoreUpdateHtml(e, c) + '</div>' +
        (reply ? '<div class="reply-draft-wrap">' + messageCard(reply) + '</div>' : '');
    } else if (e.direction === 'inbound' && e.triage_error) {
      triageHtml = '<div class="triage-card failed"><div class="triage-head"><span class="t">Triage failed</span><span class="small">' + esc(e.triage_error) + '</span>' +
        '<button class="btn btn-secondary btn-xs" style="margin-left:auto" data-action="retry-triage" data-company="' + attr(c.id) + '" data-entry="' + attr(e.id) + '" ' + (state.running.reply ? 'disabled' : '') + '>' +
        (state.running.reply ? '<span class="spinner"></span>' : '↻ Retry triage') + '</button></div></div>';
    } else if (e.direction === 'inbound' && e.channel !== 'intake' && e.source === 'resend') {
      triageHtml = '<div class="small muted mt-sm"><span class="spinner dark" style="width:10px;height:10px"></span> Triage agent is reading this reply…</div>';
    }
    const who = e.direction === 'inbound' ? '⬅ ' + (e.from ? esc(e.from) : 'Inbound from owner') : '➡ Outbound';
    const via = e.direction === 'inbound' ? (e.source === 'resend' ? ' · received by email' : e.source === 'paste' ? ' · pasted' : '')
      : (e.source === 'resend' ? ' · sent by email' : e.source === 'mailto' ? ' · via mail client' : '');
    return '<div class="tl-entry ' + (e.direction === 'inbound' ? 'inbound' : 'outbound') + '">' +
      '<div class="bubble">' + (e.direction === 'inbound' && e.subject ? '<div class="strong small" style="margin-bottom:6px">' + esc(e.subject) + '</div>' : '') + esc(e.text || '') + '</div>' +
      '<div class="tl-meta">' + who + ' · ' + (CHANNEL_ICON[e.channel] || '') + ' ' + esc(CHANNEL_LABEL[e.channel] || e.channel || '') + ' · ' + fmtDate(e.at) + via + '</div>' +
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

/* ================= INBOX ================= */
// One thread per prospect. Owner replies arrive here by email (Resend webhook) already triaged, with a reply drafted.
// Mirror of server/db.js inboxStatus: who spoke last decides whether the owner is waiting on us.
function inboxStatusOf(c) {
  const conv = c.conversation || [], msgs = c.messages || [];
  if (!conv.length && !msgs.some(function (m) { return m.status === 'scheduled'; })) return null;
  if (c.stage === 'disqualified' || c.stage === 'mandate_signed') return 'done';
  if (msgs.some(function (m) { return !m.step && (m.status === 'draft' || m.status === 'approved'); })) return 'needs_reply';
  const last = conv.slice().sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); }).pop();
  if (last && last.direction === 'inbound' && last.channel !== 'intake') return 'needs_reply';
  return 'waiting';
}

async function renderInbox(selectedId) {
  if (!state.inbox) main.innerHTML = pageSkeleton();
  try {
    const jobs = [api('/api/engine/inbox'), api('/api/engine/companies')];
    if (selectedId) jobs.push(api('/api/engine/companies/' + encodeURIComponent(selectedId)));
    const res = await Promise.all(jobs);
    state.inbox = res[0];
    setCompanies(res[1]);
    if (res[2]) { state.company = res[2]; state.companyMap[res[2].id] = res[2]; }
    else state.company = null;
  } catch (e) { main.innerHTML = errorState(e); return; }
  if (state.view !== 'inbox') return;
  if (!state.company && state.inbox.items.length) {
    const first = inboxVisibleItems()[0] || state.inbox.items[0];
    if (first) { location.hash = '#/inbox/' + first.company_id; return; }
  }
  updateNavBadge(state.inbox.counts.needs_reply);
  drawInbox();
  scheduleInboxPoll();
}

// The inbox stays live: a reply that lands through the webhook shows up without a manual refresh.
function scheduleInboxPoll() {
  clearTimeout(state.inboxTimer);
  const pending = state.inbox && state.inbox.items.some(function (i) { return i.triage_pending; });
  state.inboxTimer = setTimeout(async function () {
    if (state.view !== 'inbox') return;
    await refreshInbox();
    scheduleInboxPoll();
  }, pending ? 4000 : 20000);
}
async function refreshInbox() {
  try {
    const jobs = [api('/api/engine/inbox')];
    if (state.company) jobs.push(api('/api/engine/companies/' + encodeURIComponent(state.company.id)));
    const res = await Promise.all(jobs);
    if (state.view !== 'inbox') return;
    state.inbox = res[0];
    const idle = !Object.keys(state.editing).length && !Object.keys(state.msgBusy).length && !Object.keys(state.running).length;
    if (res[1] && idle && state.company && res[1].id === state.company.id) setCompany(res[1]);
    updateNavBadge(state.inbox.counts.needs_reply);
    // Never redraw under the advisor's cursor: a half-written reply would be lost.
    const a = document.activeElement;
    if (a && main.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT')) return;
    drawInbox();
  } catch (e) { /* keep the current view; the next poll retries */ }
}

function inboxVisibleItems() {
  const items = (state.inbox && state.inbox.items) || [];
  return state.inboxFilter === 'all' ? items : items.filter(function (i) { return i.status === state.inboxFilter; });
}

function drawInbox() {
  const inbox = state.inbox || { items: [], counts: {}, unmatched: [], mail: {} };
  const counts = inbox.counts || {};
  const items = inboxVisibleItems();
  const sel = state.company;
  const mailS = inbox.mail || {};
  const filters = [['needs_reply', 'Needs reply', counts.needs_reply], ['waiting', 'Waiting', counts.waiting], ['done', 'Done', counts.done], ['all', 'All', (inbox.items || []).length]];
  const list = items.length ? items.map(inboxItemHtml).join('')
    : '<div class="empty" style="padding:28px 14px"><div class="empty-icon">📭</div><div class="empty-title">Nothing here</div><p>' +
      (state.inboxFilter === 'needs_reply' ? 'No owner is waiting for an answer.' : 'No conversations in this view.') + '</p></div>';
  const mailLine = '<span class="mail-status"><span class="dot ' + (mailS.configured ? 'on' : '') + '"></span>' +
    (mailS.configured
      ? 'Real email on · from ' + esc(mailS.from || '') + (mailS.inbound_domain ? ' · replies to owners+&lt;id&gt;@' + esc(mailS.inbound_domain) : '') + (mailS.scheduled ? ' · ' + plural(mailS.scheduled, 'follow-up') + ' on the clock' : '')
      : 'Real email off · Send opens your mail client · <a href="#/settings">configure Resend →</a>') + '</span>';
  main.innerHTML =
    topbar('Inbox', crumb([{ label: 'Mergero', href: '#/dashboard' }, { label: 'Inbox' }]), mailLine + '<button class="btn btn-secondary" data-action="inbox-refresh">Refresh</button>') +
    '<div class="content"><div class="inbox-layout">' +
    '<div class="card"><div class="inbox-filters">' + filters.map(function (f) {
      return '<button class="tab ' + (state.inboxFilter === f[0] ? 'active' : '') + '" data-action="inbox-filter" data-filter="' + f[0] + '">' + esc(f[1]) + (f[2] ? '<span class="tab-count">' + f[2] + '</span>' : '') + '</button>';
    }).join('') + '</div><div class="inbox-list">' + list + '</div>' + unmatchedHtml(inbox.unmatched || []) + '</div>' +
    '<div class="inbox-pane">' + (sel ? inboxPaneHtml(sel, inbox)
      : '<div class="card">' + emptyState('💬', 'Select a conversation', 'Owner replies land here the moment they arrive, already triaged, with a reply drafted for your approval.') + '</div>') + '</div>' +
    '</div></div>';
}

function inboxItemHtml(i) {
  const active = state.company && state.company.id === i.company_id;
  const t = i.triage;
  const trend = t && t.sentiment_trend === 'up' ? ' ↑' : t && t.sentiment_trend === 'down' ? ' ↓' : '';
  return '<a class="inbox-item ' + (active ? 'active' : '') + '" href="#/inbox/' + attr(i.company_id) + '">' +
    '<div class="row"><span class="who">' + flag(i.country) + ' ' + esc(i.name) + '</span><span class="when">' + esc(fmtShortDate(i.last_at)) + '</span></div>' +
    '<div class="snippet">' + (i.last_direction === 'inbound' ? '⬅ ' : i.last_direction === 'outbound' ? '➡ ' : '') + esc(i.last_text || '') + '</div>' +
    '<div class="tags">' + stagePill(i.stage) +
    (t ? '<span class="' + (INTENT_PILL[t.intent] || 'pill') + '">' + esc(humanizeKey(t.intent)) + '</span><span class="' + (SENTIMENT_PILL[t.sentiment] || 'pill') + '">' + esc(t.sentiment) + trend + '</span>' : '') +
    (i.triage_pending ? '<span class="pill pill-amber">triaging…</span>' : '') +
    (i.triage_error ? '<span class="pill pill-red" title="' + attr(i.triage_error) + '">triage failed</span>' : '') +
    (i.reply_draft ? '<span class="pill pill-teal">reply drafted</span>' : '') +
    (i.due ? '<span class="pill pill-amber">' + plural(i.due, 'follow-up') + ' due</span>' : i.scheduled ? '<span class="pill pill-outline">' + plural(i.scheduled, 'follow-up') + ' on the clock</span>' : '') +
    (i.owner && i.owner.email_status === 'bounced' ? '<span class="pill pill-red">email bounced</span>' : '') +
    '</div></a>';
}

function unmatchedHtml(list) {
  if (!list.length) return '';
  const all = state.companies.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  return '<div class="card-head" style="border-top:1px solid var(--border)"><div class="card-title">Unmatched inbound</div><span class="pill pill-amber">' + list.length + '</span></div><div class="card-body">' +
    '<div class="small muted mb">Emails no rule could place: not sent to a prospect\'s reply address and not from a known owner address. Pick the prospect; the address is remembered.</div>' +
    list.map(function (u) {
      const sugg = u.suggestions || [];
      return '<div class="unmatched-item"><div class="from">' + esc(u.from || 'Unknown sender') + '</div>' +
        '<div class="small muted">' + esc(u.subject || '(no subject)') + ' · ' + fmtDate(u.at) + '</div>' +
        '<div class="snippet">' + esc(String(u.text || '').slice(0, 160)) + '</div>' +
        '<div class="assign"><select data-unmatched="' + attr(u.id) + '">' +
        (sugg.length ? '<optgroup label="Suggested">' + sugg.map(function (s) { return '<option value="' + attr(s.company_id) + '">' + esc(s.name) + '</option>'; }).join('') + '</optgroup>' : '') +
        '<optgroup label="All prospects">' + all.map(function (c) { return '<option value="' + attr(c.id) + '">' + esc(c.name) + '</option>'; }).join('') + '</optgroup></select>' +
        '<button class="btn btn-primary btn-sm" data-action="assign-unmatched" data-id="' + attr(u.id) + '">Assign & triage</button>' +
        '<button class="btn btn-ghost btn-sm" data-action="discard-unmatched" data-id="' + attr(u.id) + '">Discard</button></div></div>';
    }).join('') + '</div>';
}

function inboxPaneHtml(c, inbox) {
  const o = c.owner || {};
  const item = (inbox.items || []).find(function (i) { return i.company_id === c.id; }) || {};
  const t = item.triage;
  const statusPill = item.status === 'needs_reply' ? 'pill pill-amber' : item.status === 'waiting' ? 'pill pill-blue' : 'pill';
  return '<div class="card"><div class="card-body"><div class="inbox-head"><h2>' + flag(c.country) + ' ' + esc(c.name) + '</h2>' + stagePill(c.stage) + channelBadge(c.channel) +
    (item.status ? '<span class="' + statusPill + '">' + esc(humanizeKey(item.status)) + '</span>' : '') +
    '<span class="spacer"></span>' +
    '<a class="btn btn-ghost btn-sm" href="#/company/' + attr(c.id) + '">Open prospect →</a>' +
    (c.stage !== 'disqualified' && c.stage !== 'mandate_signed' ? '<button class="btn btn-danger btn-sm" data-action="inbox-disqualify" data-id="' + attr(c.id) + '">Disqualify</button>' : '') + '</div>' +
    '<div class="small muted mt-sm">' + esc(o.name || 'Owner unknown') + (o.title ? ' · ' + esc(o.title) : '') + (o.email ? ' · ' + esc(o.email) : '') +
    (o.email_status === 'bounced' ? ' · <span class="text-red">email bounced</span>' : '') + (c.score ? ' · readiness ' + esc(c.score.readiness) : '') + '</div>' +
    (t && t.next_step ? '<div class="mt-sm"><strong>Next step:</strong> ' + esc(t.next_step) + '</div>' : '') +
    '</div></div>' +
    tabConversation(c);
}

/* ================= BUYERS ================= */
async function renderBuyers() {
  main.innerHTML = pageSkeleton();
  try {
    const res = await Promise.all([api('/api/engine/buyers'), api('/api/engine/suggestions').catch(function () { return null; }), state.companies.length ? null : api('/api/engine/companies').catch(function () { return null; })]);
    state.buyers = res[0]; state.buyersLoaded = true; state.suggest = res[1] || state.suggest;
    if (res[2]) setCompanies(res[2]);
  }
  catch (e) { main.innerHTML = errorState(e); return; }
  if (state.view !== 'buyers') return;
  drawBuyers();
}

function drawBuyers() {
  const buyers = state.buyers || [];
  const active = buyers.filter(function (b) { return b.active !== false; }).length;
  main.innerHTML =
    topbar('Buyer mandates', crumb([{ label: 'Mergero', href: '#/dashboard' }, { label: 'Buyers' }]),
      '<button class="btn btn-secondary" data-action="mgx-sync" title="Query live buyer mandates from the MGX Deal Engine (sector, size, deal type, geography)">⟳ Sync from MGX</button>' +
      '<button class="btn btn-primary" data-action="open-add-buyer">+ Add buyer</button>') +
    '<div class="content">' +
    '<div class="flex space-between mb"><div class="muted">' + plural(buyers.length, 'mandate') + ' in the Mergero network · <span class="strong text-green">' + active + ' active</span>' +
    (buyers.some(function (b) { return b.mgx_id; }) ? ' · ' + buyers.filter(function (b) { return b.mgx_id; }).length + ' from MGX' : '') + '</div></div>' +
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
    (b.mgx_id ? '<span class="pill pill-outline" title="' + attr((b.source === 'mgx' ? 'Live from MGX' : 'MGX sample data') + (b.synced_at ? ', synced ' + fmtDate(b.synced_at) : '')) + '">MGX ' + esc(b.mgx_id) + '</span>' : '') +
    (toList(b.deal_types).length ? '<span class="small muted">' + esc(toList(b.deal_types).join(' · ')) + '</span>' : '') + '</div></div>' +
    '<span class="geo" title="' + attr(toList(b.geographies).map(countryName).join(', ')) + '">' + toList(b.geographies).map(flag).join('') + '</span></div>' +
    '<div>' + chips(b.sectors, 'chip-grey') + '</div>' +
    '<div class="buyer-range">' +
    '<div class="kv-item"><div class="kv-key">Revenue</div><div class="kv-val">' + fmtMoney(b.revenue_min_eur) + ' – ' + fmtMoney(b.revenue_max_eur) + '</div></div>' +
    '<div class="kv-item"><div class="kv-key">EBITDA</div><div class="kv-val">' + fmtMoney(b.ebitda_min_eur) + ' – ' + fmtMoney(b.ebitda_max_eur) + '</div></div></div>' +
    (b.thesis ? '<div class="buyer-thesis">' + esc(b.thesis) + '</div>' : '') +
    (toList(b.contacts).length ? '<div class="small muted">Contact: ' + esc(b.contacts[0].name) + ', ' + esc(b.contacts[0].role) + ' · ' + esc(b.contacts[0].email) + (b.contacts[0].mock ? ' <span class="pill pill-outline">mock</span>' : '') + '</div>' : '') +
    buyerOppsHtml(b) + buyerMessagesHtml(b) +
    '<div class="buyer-foot"><label class="switch"><input type="checkbox" data-change="buyer-active" data-id="' + attr(b.id) + '" ' + (isActive ? 'checked' : '') + '><span class="track"></span>' + (isActive ? 'Active' : 'Inactive') + '</label>' +
    '<div class="flex"><button class="btn btn-secondary btn-xs" data-action="pair" data-buyer="' + attr(b.id) + '" title="Pair with the best-fitting seller and see why">⚡ Pair</button>' +
    '<button class="btn btn-ghost btn-xs" data-action="open-edit-buyer" data-id="' + attr(b.id) + '">Edit</button>' +
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

/* ================= BUY-SIDE MANDATES ================= */
const BS_STEPS = [['Read thesis', 'criteria & NACE codes'], ['Scan registers', 'FI PRH · NO Brønnøysund'], ['Owner ages', 'roles register'], ['Score targets', 'against the thesis']];
const THESIS_EXAMPLE = 'We back founder-owned industrial and industrial-service companies in the Nordics with €5–30M revenue, EBITDA margins above 10% and a recurring service or spare-parts book. We prefer situations where the owner is approaching succession and stays for a two to three year handover. Majority or significant minority, add-ons welcome.';
function bsState() { if (!state.buyside) state.buyside = { list: [], current: null, running: false, step: 0, timer: null }; return state.buyside; }
async function renderBuyside(id) {
  const bs = bsState();
  main.innerHTML = pageSkeleton();
  try {
    bs.list = await api('/api/engine/buyside/mandates');
    if (id) bs.current = await api('/api/engine/buyside/mandates/' + encodeURIComponent(id));
    else if (bs.current) bs.current = await api('/api/engine/buyside/mandates/' + encodeURIComponent(bs.current.id)).catch(function () { return null; });
  } catch (e) { main.innerHTML = errorState(e); return; }
  if (state.view !== 'buyside') return;
  drawBuyside();
}
function bsStepperHtml(step) {
  return '<div class="stepper">' + BS_STEPS.map(function (s, i) {
    const cls = i < step ? 'done' : i === step ? 'active' : '';
    return '<div class="step ' + cls + '"><div class="step-icon">' + (i < step ? '✓' : i === step ? '<span class="spinner dark"></span>' : (i + 1)) + '</div><div><div class="step-title">' + esc(s[0]) + '</div><div class="step-sub">' + esc(s[1]) + '</div></div></div>';
  }).join('') + '</div>';
}
function drawBuyside() {
  const bs = bsState();
  const m = bs.current;
  const formCard = '<div class="card"><div class="card-head"><div class="card-title">New buy-side mandate</div><span class="small muted">thesis in, targets and pitch out</span></div>' +
    '<div class="card-body"><form data-form="buyside-new">' +
    field('Paste the buyer’s investment thesis', '<textarea name="thesis_text" rows="6" style="min-height:130px" placeholder="' + attr(THESIS_EXAMPLE) + '"></textarea>', 'Or leave empty to use the example thesis.') +
    '<div class="form-grid">' +
    field('Buyer name (optional)', '<input type="text" name="buyer_name" placeholder="Nordic industrial buyout fund">') +
    field('Buyer type', selectHtml('buyer_type', Object.keys(BUYER_TYPES).map(function (k) { return [k, BUYER_TYPES[k]]; }), 'PE')) +
    '</div>' +
    '<div class="field"><label>Registers to scan</label><div class="checks">' +
    '<label><input type="checkbox" name="countries" value="FI" checked>🇫🇮 Finland (PRH)</label>' +
    '<label><input type="checkbox" name="countries" value="NO" checked>🇳🇴 Norway (Brønnøysund + owner ages)</label>' +
    '</div><div class="small muted">Sweden and DACH have no free register API: targets there come from prospect-database imports.</div></div>' +
    '<div class="form-actions"><button type="submit" class="btn btn-primary" ' + (bs.running ? 'disabled' : '') + '>' + (bs.running ? '<span class="spinner"></span>Working…' : '⚡ Find and score targets') + '</button></div>' +
    (bs.running ? bsStepperHtml(bs.step) : '') +
    '</form></div></div>';
  const listCard = '<div class="card"><div class="card-head"><div class="card-title">Mandates</div><span class="small muted">' + plural(bs.list.length, 'mandate') + '</span></div>' +
    '<div class="card-body">' + (bs.list.length ? '<div class="mini-list">' + bs.list.map(function (x) {
      const st = x.stats || {};
      return '<div class="mini-item"><div><a class="t" href="#/buyside/' + attr(x.id) + '">' + esc((x.criteria && x.criteria.buyer_name) || 'Mandate') + '</a> <span class="' + (BUYER_TYPE_PILL[x.criteria && x.criteria.buyer_type] || 'pill') + '">' + esc(BUYER_TYPES[x.criteria && x.criteria.buyer_type] || '') + '</span>' +
        '<div class="s">' + (x.target_count || 0) + ' targets · ' + (st.scored_70 || 0) + ' score 70+ · ' + (st.in_conversation || 0) + ' owners in conversation · <span class="pill">' + esc(x.status) + '</span></div></div>' +
        '<a class="btn btn-ghost btn-xs" href="#/buyside/' + attr(x.id) + '">Open →</a></div>';
    }).join('') + '</div>' : '<div class="muted small">No mandates yet. Paste a thesis on the left.</div>') + '</div></div>';
  main.innerHTML =
    topbar('Buy-side mandates', crumb([{ label: 'Mergero', href: '#/dashboard' }, { label: 'Buy-side' }]), '<span class="small muted">thesis → off-market targets → scored list → pitch that wins the mandate</span>') +
    '<div class="content">' + (m ? bsDetailHtml(m) : '') + '<div class="grid-2">' + formCard + listCard + '</div></div>';
}
function bsDetailHtml(m) {
  const c = m.criteria || {};
  const st = m.stats || {};
  const buyer = (state.buyers || []).find(function (b) { return b.id === m.buyer_id; });
  const pitchMsg = buyer && (buyer.messages || []).find(function (x) { return x.id === m.buyer_message_id; });
  const targets = (m.targets || []).slice(0, 40);
  const critHtml = '<div class="card"><div class="card-head"><div class="card-title">' + esc(c.buyer_name || 'Mandate') + ' <span class="' + (BUYER_TYPE_PILL[c.buyer_type] || 'pill') + '">' + esc(BUYER_TYPES[c.buyer_type] || '') + '</span></div>' +
    '<div class="flex" style="gap:6px"><button class="btn btn-danger btn-xs" data-action="bs-delete" data-id="' + attr(m.id) + '">Delete</button></div></div>' +
    '<div class="card-body"><p style="margin-top:0">' + esc(c.thesis_summary || '') + '</p>' +
    '<div class="grid-2"><div>' + '<div class="section-title">Criteria</div>' + chips(c.sectors, 'chip-grey') +
    '<div class="small mt-sm">NACE: ' + esc((c.industry_codes || []).map(function (x) { return x.code + ' ' + x.label; }).join(' · ')) + '</div>' +
    '<div class="small">Geography: ' + esc((c.geographies || []).join(', ')) + ' · Revenue ' + fmtMoney(c.revenue_min_eur) + ' – ' + fmtMoney(c.revenue_max_eur) + ' · Staff ' + (c.employees_min != null ? c.employees_min : '?') + '–' + (c.employees_max != null ? c.employees_max : '?') + '</div>' +
    '<div class="small">Deal types: ' + esc((c.deal_types || []).join(', ')) + ' · Owner situation: ' + esc(c.owner_situation || '') + '</div></div>' +
    '<div><div class="section-title">Scan</div><div class="buyer-range" style="grid-template-columns:repeat(4,1fr)">' +
    '<div class="kv-item"><div class="kv-key">Targets</div><div class="kv-val">' + (st.targets || 0) + '</div></div>' +
    '<div class="kv-item"><div class="kv-key">Score 70+</div><div class="kv-val">' + (st.scored_70 || 0) + '</div></div>' +
    '<div class="kv-item"><div class="kv-key">In conversation</div><div class="kv-val">' + (st.in_conversation || 0) + '</div></div>' +
    '<div class="kv-item"><div class="kv-key">Owner age known</div><div class="kv-val">' + (st.with_owner_age || 0) + '</div></div></div>' +
    '<div class="small muted mt-sm">' + esc((st.log || []).map(function (l) { return l.error ? l.country + ' NACE ' + l.code + ': ' + l.error : l.country + ' NACE ' + l.code + ': ' + fmtNum(l.total || 0) + ' in register, ' + l.taken + ' taken'; }).join(' · ')) + '</div></div></div>' +
    '</div></div>';
  const rows = targets.map(function (t) {
    const fit = Math.max(0, Math.min(100, Number(t.fit) || 0));
    return '<tr><td><strong>' + esc(t.name) + '</strong><div class="small muted">' + esc(t.industry || '') + (t.industry_code ? ' · ' + esc(t.industry_code) : '') + '</div></td>' +
      '<td>' + flag(t.country) + ' ' + esc(t.city || '') + '</td><td class="right">' + (t.employees != null ? t.employees : '—') + '</td><td class="right">' + (t.founded || '—') + '</td>' +
      '<td>' + (t.owner_age ? esc(t.owner_name || 'Owner') + ', ' + t.owner_age + ' <span class="pill pill-outline">register</span>' : (t.owner_signal ? esc(t.owner_signal) : '<span class="muted">—</span>')) + '</td>' +
      '<td><div class="fit"><div class="fit-num">' + fit + '%</div><div class="bar"><div class="bar-fill ' + (fit >= 75 ? 'green' : fit >= 50 ? '' : 'amber') + '" style="width:' + fit + '%"></div></div></div><div class="small muted">' + esc(t.reason || '') + '</div></td>' +
      '<td>' + (t.in_pipeline ? '<a href="#/company/' + attr(t.company_id) + '"><span class="' + (STAGE_PILL[t.stage] || 'pill') + '">' + esc(stageLabel(t.stage)) + '</span></a>' : '<span class="muted small">not yet</span>') + '</td></tr>';
  }).join('');
  const targetsHtml = '<div class="card mt"><div class="card-head"><div class="card-title">Off-market targets · ' + (m.targets || []).length + '</div>' +
    '<div class="flex" style="gap:6px"><button class="btn btn-secondary btn-sm" data-action="bs-import" data-id="' + attr(m.id) + '" data-top="10">＋ Add top 10 to pipeline</button>' +
    '<button class="btn btn-primary btn-sm" data-action="bs-pitch" data-id="' + attr(m.id) + '">' + (m.pitch ? '↻ Redraft pitch' : '✍ Draft the pitch') + '</button></div></div>' +
    (targets.length ? '<div class="table-wrap"><table class="table compact"><thead><tr><th>Company</th><th>Where</th><th class="right">Staff</th><th class="right">Founded</th><th>Owner</th><th>Fit against thesis</th><th>Pipeline</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<div class="card-body muted small">No targets found in the scanned registers for these codes. Widen the thesis or add countries.</div>') + '</div>';
  let pitchHtml = '';
  if (m.pitch) {
    const p = m.pitch, o = p.one_pager || {};
    const status = pitchMsg ? pitchMsg.status : 'draft';
    const demo = state.settings && state.settings.demo_email;
    pitchHtml = '<div class="card mt"><div class="card-head"><div class="card-title">Pitch · ' + esc(p.subject) + '</div><div class="flex" style="gap:6px;align-items:center">' +
      (pitchMsg ? '<span class="' + (STATUS_PILL[status] || 'pill') + '">' + esc(status) + '</span>' : '') +
      '<button class="btn btn-ghost btn-xs" data-action="copy-text" data-text="' + attr('Subject: ' + p.subject + '\n\n' + p.email_body) + '">⧉ Copy email</button>' +
      (pitchMsg && status !== 'sent' ? '<button class="btn btn-primary btn-sm" data-action="bs-send" data-id="' + attr(m.id) + '" data-msg="' + attr(pitchMsg.id) + '">✉ ' + (demo ? 'Send to my inbox (demo)' : 'Approve & send') + '</button>' : '') +
      (pitchMsg && status === 'sent' ? '<span class="small muted">sent ' + fmtDate(pitchMsg.sent_at) + (pitchMsg.delivery === 'email' ? ' by email' : '') + '</span>' : '') +
      '</div></div>' +
      '<div class="card-body"><div class="grid-2">' +
      '<div><div class="section-title">Email to ' + esc(pitchMsg ? pitchMsg.to_name + ' <' + pitchMsg.to + '>' : 'the buyer') + '</div><div class="msg-body" style="white-space:pre-wrap">' + esc(p.email_body) + '</div></div>' +
      '<div><div class="section-title">One-pager</div><div class="strong">' + esc(o.headline || '') + '</div>' +
      '<div class="small mt-sm"><strong>Market scan.</strong> ' + esc(o.market_scan || '') + '</div>' +
      '<div class="small mt-sm"><strong>How we found them.</strong> ' + esc(o.how_we_found_them || '') + '</div>' +
      '<div class="small mt-sm"><strong>Highlights.</strong>' + listOrDash(o.highlights) + '</div>' +
      '<div class="small mt-sm"><strong>Already in conversation.</strong> ' + esc(o.already_in_conversation || '') + '</div>' +
      '<div class="small mt-sm"><strong>Proposed mandate.</strong> ' + esc(o.proposed_mandate || '') + '</div>' +
      '<div class="small mt-sm"><strong>Next step.</strong> ' + esc(o.next_step || '') + '</div></div>' +
      '</div></div></div>';
  }
  return critHtml + targetsHtml + pitchHtml + '<div class="mb"></div>';
}
function bsStartStepper() { const bs = bsState(); bs.running = true; bs.step = 0; clearInterval(bs.timer); bs.timer = setInterval(function () { if (bs.step < BS_STEPS.length - 1) { bs.step++; if (state.view === 'buyside') drawBuyside(); } }, 9000); }
function bsStopStepper() { const bs = bsState(); bs.running = false; clearInterval(bs.timer); bs.timer = null; }

/* ================= SETTINGS ================= */
async function renderSettings() {
  main.innerHTML = pageSkeleton();
  try {
    const res = await Promise.all([api('/api/engine/settings'), api('/api/engine/mail/status').catch(function () { return null; })]);
    state.settings = res[0]; state.mailStatus = res[1]; updateBanner();
  } catch (e) { main.innerHTML = errorState(e); return; }
  if (state.view !== 'settings') return;
  drawSettings();
  // Provider status is fetched after the form renders (it pings the Verda endpoint, which can take a few seconds).
  api('/api/engine/llm/status').then(function (st) {
    const el = document.getElementById('llm-status'); if (!el) return;
    const v = st.verda || {};
    el.innerHTML = 'Active: <strong>' + esc(st.provider) + '</strong> · model ' + esc(st.model || '') +
      (st.provider === 'verda' ? (v.ok ? ' · <span class="text-green">Verda endpoint answered in ' + v.ms + ' ms</span>' : ' · <span class="text-red">Verda endpoint not answering: ' + esc(v.reason || 'unknown') + '</span>') : '') +
      (st.fallback ? ' · fallback to Claude on' : ' · strict, no fallback') + (st.web_tools ? '' : ' · web search off');
  }).catch(function () { const el = document.getElementById('llm-status'); if (el) el.textContent = ''; });
}

function drawSettings() {
  const s = state.settings || {};
  const sender = s.sender || {};
  const fa = s.funnel_assumptions || {};
  const mailS = s.mail || {};
  const webhookUrl = (state.mailStatus && state.mailStatus.webhook_url) || (location.origin + '/api/mail/inbound/resend');
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
    advisorsCardHtml(s.advisors || []) +
    '<div class="card"><div class="card-head"><div class="card-title">Email delivery (Resend)</div>' +
    (mailS.configured ? '<span class="pill pill-green">On · ' + esc(mailS.api_key_masked || '') + '</span>' : '<span class="pill">Off · Send opens your mail client</span>') + '</div>' +
    '<div class="card-body">' +
    '<p class="small muted" style="margin-top:0">With Resend configured, <strong>Send</strong> delivers the email itself, approved follow-ups go out on their day, and owner replies come back into the Inbox already triaged. Without it, Send opens your mail client and replies are pasted by hand.</p>' +
    field('Resend API key', '<input type="password" name="mail_api_key" autocomplete="off" placeholder="' + (mailS.api_key_set ? 'Leave blank to keep the current key' : 're_…') + '">') +
    field('From', '<input type="text" name="mail_from" value="' + attr(mailS.from || '') + '" placeholder="Timo Tontti <timo@mail.mergero.com>">', 'A sender on a domain verified in Resend (or onboarding@resend.dev for tests).') +
    field('Demo mode: send everything to', '<input type="email" name="demo_email" value="' + attr(s.demo_email || '') + '" placeholder="you@example.com">',
      (s.demo_email ? '⚠ Demo mode is ON: every real email (owner sequences, follow-ups, buyer notes, pitches) is redirected to this address with the intended recipient in the subject. One email per action, never bulk.' : 'Leave empty to send to real recipients. Set it for demos so nothing reaches owners or buyers.')) +
    field('Inbound domain', '<input type="text" name="mail_inbound_domain" value="' + attr(mailS.inbound_domain || '') + '" placeholder="inbound.mergero.com">',
      'Replies go to owners+<prospect id>@this domain and route themselves to the prospect. Enable receiving for the domain in Resend.') +
    field('Webhook signing secret', '<input type="password" name="mail_webhook_secret" autocomplete="off" placeholder="' + (mailS.webhook_secret_set ? 'Leave blank to keep the current secret' : 'whsec_…') + '">',
      'Resend → Webhooks → add ' + webhookUrl + ' with the events email.received, email.delivered, email.bounced and email.complained, then paste its signing secret here.') +
    '</div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Funnel assumptions</div><span class="small muted">used for projected mandates</span></div><div class="card-body"><div class="form-grid-3">' +
    field('Contact → reply', '<input type="number" step="0.01" min="0" max="1" name="contact_to_reply" value="' + attr(fa.contact_to_reply != null ? fa.contact_to_reply : '') + '">', 'Mergero benchmark: 0.45–0.50') +
    field('Reply → meeting', '<input type="number" step="0.01" min="0" max="1" name="reply_to_meeting" value="' + attr(fa.reply_to_meeting != null ? fa.reply_to_meeting : '') + '">', 'e.g. 0.45') +
    field('Meeting → mandate', '<input type="number" step="0.01" min="0" max="1" name="meeting_to_mandate" value="' + attr(fa.meeting_to_mandate != null ? fa.meeting_to_mandate : '') + '">', 'e.g. 0.30') +
    '</div></div></div>' +
    '</div>' +
    '<div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Model provider</div>' +
    (s.llm_provider === 'verda' ? '<span class="pill pill-teal">Verda · Mistral Large 3 (EU)</span>' : '<span class="pill">Claude (Anthropic)</span>') + '</div><div class="card-body">' +
    field('Provider', selectHtml('llm_provider', [['', 'Claude (Anthropic) — default'], ['anthropic', 'Claude (Anthropic)'], ['verda', 'Mistral Large 3 on Verda / DataCrunch (EU-hosted)']], s.llm_provider || ''),
      'Verda is an OpenAI-compatible chat-completions endpoint. All agents (enrich, score, match, outreach, humanizer, triage, intake, buyer notes) use the selected provider; web search stays a Claude tool.') +
    field('Verda endpoint (…/v1)', '<input type="text" name="verda_base_url" value="' + attr(s.verda_base_url || '') + '" placeholder="https://containers.datacrunch.io/<deployment>/v1">') +
    field('Verda API key', '<input type="password" name="verda_api_key" autocomplete="off" placeholder="' + (s.verda_api_key_set ? 'Leave blank to keep the current key (' + esc(s.verda_api_key_masked || '') + ')' : 'dc_…') + '">') +
    field('Verda model name', '<input type="text" name="verda_model" value="' + attr(s.verda_model || '') + '" placeholder="mistral-large-3">') +
    '<label class="switch"><input type="checkbox" name="llm_fallback" ' + (s.llm_fallback === false ? '' : 'checked') + '><span class="track"></span>Fall back to Claude when Verda fails (untick for strict EU-only processing)</label>' +
    '<div class="small muted mt-sm" id="llm-status">Checking provider status…</div>' +
    '</div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Your voice</div><span class="small muted">the strongest anti-AI signal</span></div><div class="card-body">' +
    field('Paste two or three emails you actually wrote to owners', '<textarea name="voice_samples" rows="7" style="min-height:150px" placeholder="Paste real past emails (greeting, rhythm, sign-off). The writer and the humanizer imitate this voice without copying sentences.">' + esc(s.voice_samples || '') + '</textarea>',
      'Kept server-side. Owners’ names in the samples are fine; they are never reused.') +
    field('Human-language gate (0 = strict, 100 = off)', '<input type="number" min="0" max="100" step="1" name="lint_threshold" value="' + attr(s.lint_threshold != null ? s.lint_threshold : 35) + '">',
      'Drafts scoring above this cannot be sent without an explicit override. Hard stops (placeholders, quoted financials, reused wording, AI mentions) always block.') +
    '</div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Writing style rules</div></div><div class="card-body">' +
    field('Rules the outreach agent must follow', '<textarea name="style_rules" rows="7" style="min-height:150px">' + esc(s.style_rules || '') + '</textarea>') +
    '</div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Value propositions</div></div><div class="card-body">' +
    field('One per line', '<textarea name="value_props" rows="5" style="min-height:110px">' + esc(toList(s.value_props).join('\n')) + '</textarea>', 'Used sparingly in outreach — one concrete reason per message.') +
    '</div></div>' +
    '<div class="card"><div class="card-body"><div class="form-actions" style="justify-content:space-between;margin:0">' +
    '<span class="small muted" id="settings-status"></span><button type="submit" class="btn btn-primary">Save settings</button></div></div></div>' +
    '<div class="card"><div class="card-head"><div class="card-title">Integrations</div><span class="small muted">scraper · matcher · mailer</span></div><div class="card-body">' +
    '<div class="small muted">External components plug in through JSON endpoints (see <code>docs/integration.md</code>): scraper output → <code>/api/integrations/profiles</code>, matcher output → <code>/api/integrations/matches</code>, approved emails for a mailer ← <code>/api/integrations/outbox</code>, replies → <code>/api/integrations/inbound</code>. Demo the merge with mock payloads:</div>' +
    '<div class="flex mt flex-wrap" style="gap:8px">' +
    '<button type="button" class="btn btn-secondary btn-sm" data-action="mock-profiles">Import mock scraper profiles</button>' +
    '<button type="button" class="btn btn-secondary btn-sm" data-action="mock-matches">Import mock matcher results</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-action="open-outbox">Open approved outbox (JSON) ↗</button>' +
    '</div></div></div>' +
    '<div class="card danger-zone"><div class="card-head"><div class="card-title">Demo data</div></div><div class="card-body flex space-between">' +
    '<div class="small muted">Reload the seed prospects, buyers and settings. All enrichment, drafts and conversations are discarded.</div>' +
    '<button type="button" class="btn btn-danger" data-action="reset-demo">Reset demo data</button></div></div>' +
    '</div></div></form>' +
    '</div>';
}

function advisorsCardHtml(list) {
  const rows = list.concat([{ id: '', name: '', title: '', email: '', phone: '', markets: [], daily_cap: 75 }]);
  return '<div class="card"><div class="card-head"><div class="card-title">Advisors</div><span class="small muted">who sends first touches, and how many per day</span></div><div class="card-body">' +
    '<p class="small muted" style="margin-top:0">Each prospect is owned by the advisor whose markets include its country (the first advisor takes the rest). Outreach is written and signed by that advisor and sent under their name. The daily cap protects deliverability (Mergero: 50–100 per sender); over it, emails wait for the next morning. Clear a name to remove an advisor; fill the last row to add one.</p>' +
    rows.map(function (a) {
      return '<div class="form-grid-3 mb" style="align-items:end">' +
        '<input type="hidden" name="adv_id" value="' + attr(a.id) + '"><input type="hidden" name="adv_phone" value="' + attr(a.phone || '') + '">' +
        field('Name', '<input type="text" name="adv_name" value="' + attr(a.name) + '" placeholder="' + (a.id ? '' : 'Add an advisor') + '">') +
        field('Title', '<input type="text" name="adv_title" value="' + attr(a.title || '') + '">') +
        field('Email', '<input type="email" name="adv_email" value="' + attr(a.email || '') + '">') +
        field('Markets', '<input type="text" name="adv_markets" value="' + attr((a.markets || []).join(', ')) + '" placeholder="FI, SE">') +
        field('Emails per day', '<input type="number" min="1" max="200" step="1" name="adv_cap" value="' + attr(a.daily_cap || 75) + '">') +
        '<div></div></div>';
    }).join('') + '</div></div>';
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
  body.voice_samples = String(fd.get('voice_samples') || '');
  body.lint_threshold = num(fd.get('lint_threshold'));
  if (body.lint_threshold == null) delete body.lint_threshold;
  body.mail = { from: String(fd.get('mail_from') || '').trim(), inbound_domain: String(fd.get('mail_inbound_domain') || '').trim() };
  body.demo_email = String(fd.get('demo_email') || '').trim();
  body.llm_provider = String(fd.get('llm_provider') || '');
  body.verda_base_url = String(fd.get('verda_base_url') || '').trim();
  body.verda_model = String(fd.get('verda_model') || '').trim();
  const vk = String(fd.get('verda_api_key') || '').trim();
  if (vk) body.verda_api_key = vk;
  body.llm_fallback = fd.get('llm_fallback') === 'on';
  const mailKey = String(fd.get('mail_api_key') || '').trim();
  if (mailKey) body.mail.resend_api_key = mailKey;
  const secret = String(fd.get('mail_webhook_secret') || '').trim();
  if (secret) body.mail.webhook_secret = secret;
  Object.keys(body.funnel_assumptions).forEach(function (k) { if (body.funnel_assumptions[k] == null) delete body.funnel_assumptions[k]; });
  const ids = fd.getAll('adv_id');
  if (ids.length) {
    const g = function (k, i) { return String(fd.getAll(k)[i] || '').trim(); };
    body.advisors = ids.map(function (id, i) {
      return { id: id || undefined, name: g('adv_name', i), title: g('adv_title', i), email: g('adv_email', i), phone: g('adv_phone', i), markets: g('adv_markets', i), daily_cap: num(g('adv_cap', i)) };
    }).filter(function (a) { return a.name; });
  }
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
  finally { delete state.running[name]; drawCompany(); if (state.view === 'inbox') refreshInbox(); }
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
  finally { delete state.msgBusy[id]; drawCompany(); if (state.view === 'inbox') refreshInbox(); }
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
  people: function (c) {
    return companyAction('people', function () { return api('/api/engine/companies/' + encodeURIComponent(c.id) + '/people', 'POST'); },
      function (r) { const lead = (r && r.people || []).find(function (p) { return p.role_code === 'DAGL'; }) || (r && r.people || [])[0]; return lead ? 'Register: ' + lead.name + ', ' + lead.role + (lead.age ? ', age ' + lead.age : '') : 'No people found in the register'; });
  },
  run: function (c) {
    startRunStepper();
    return companyAction('run', async function () {
      try {
        const r = await api('/api/engine/companies/' + encodeURIComponent(c.id) + '/run', 'POST', { language: state.outreachLang, framing: state.outreachFraming });
        state.runStep = RUN_STEPS.length; drawCompany();
        await new Promise(function (res) { setTimeout(res, 600); });
        return r;
      } finally { stopRunStepper(); }
    }, function (r) { return 'Pipeline complete' + (r && r.score ? ' — readiness ' + r.score.readiness + ', ' + ((r.matches || []).length) + ' buyer matches' : ''); });
  },
  research: function (c) {
    state.tab = 'research';
    return companyAction('research', function () { return api('/api/engine/companies/' + encodeURIComponent(c.id) + '/research', 'POST'); },
      function (r) { const x = r && r.research; return x ? 'Research done: ' + plural((x.facts || []).length, 'sourced fact') + ', ' + plural(((x.financials || {}).rows || []).length, 'year') + ' of financials' : 'Research done'; });
  },
  watch: function (c) {
    state.tab = 'research';
    return companyAction('watch', function () { return api('/api/engine/companies/' + encodeURIComponent(c.id) + '/watch', 'POST'); },
      function (r) { const s = r && r.watch && r.watch.last_summary; return s ? 'Checked: ' + s.new_urls + ' new pages, ' + s.changed_pages + ' changed, ' + s.new_facts + ' new facts' : 'Check finished'; });
  },
  teaser: function (c) {
    state.tab = 'buyers';
    return companyAction('teaser', function () { return api('/api/engine/companies/' + encodeURIComponent(c.id) + '/teaser', 'POST'); }, 'Blind teaser drafted: review the redactions before sending');
  },
  enrich: function (c) {
    state.tab = 'profile';
    return companyAction('enrich', function () { return api('/api/engine/companies/' + encodeURIComponent(c.id) + '/enrich', 'POST'); }, 'Enrichment complete');
  },
  score: function (c) {
    state.tab = 'score';
    return companyAction('score', function () { return api('/api/engine/companies/' + encodeURIComponent(c.id) + '/score', 'POST'); },
      function (r) { return 'Scored — readiness ' + (r && r.score ? r.score.readiness : '—'); });
  },
  match: function (c) {
    state.tab = 'buyers';
    return companyAction('match', function () { return api('/api/engine/companies/' + encodeURIComponent(c.id) + '/match', 'POST'); },
      function (r) { return plural((r && r.matches || []).length, 'buyer match', 'buyer matches') + ' found'; });
  },
  outreach: function (c) {
    state.tab = 'outreach';
    return companyAction('outreach', function () { return api('/api/engine/companies/' + encodeURIComponent(c.id) + '/outreach', 'POST', { language: state.outreachLang, framing: state.outreachFraming, channel: c.channel || 'email' }); },
      'Outreach sequence drafted and humanized');
  },
  'intake-link': function (c) {
    state.tab = 'intake';
    return companyAction('intake-link', async function () {
      const res = await api('/api/engine/companies/' + encodeURIComponent(c.id) + '/intake-link', 'POST');
      if (res && res.url) state.intakeUrls[c.id] = res.url;
      return api('/api/engine/companies/' + encodeURIComponent(c.id));
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
  'queue-first-touches': async function (el) {
    el.disabled = true;
    try {
      const r = await api('/api/engine/outreach/queue', 'POST', {});
      if (!r.queued) toast('No approved first-touch email to queue. Approve step 1 on a few prospects first.');
      else toast('Queued ' + plural(r.queued, 'first touch', 'first touches') + ': ' + r.advisors.map(function (a) {
        return a.advisor + ' ' + a.queued + ' over ' + plural(a.days, 'working day') + ' (cap ' + a.daily_cap + '/day), from ' + fmtDate(a.first_at);
      }).join(' · '), 'success', 8000);
    } catch (e) { toast(e.message, 'error'); }
    route();
  },
  'mgx-sync': async function (el) {
    el.disabled = true;
    const label = el.innerHTML;
    el.innerHTML = '<span class="spinner"></span>Syncing…';
    try {
      const r = await api('/api/engine/mgx/sync', 'POST', {});
      toast('MGX ' + (r.source === 'mgx' ? 'API' : 'sample') + ': ' + plural(r.mandates, 'mandate') + ' · ' + r.added + ' new · ' + r.updated + ' updated' + (r.deactivated ? ' · ' + r.deactivated + ' closed' : ''), 'success', 6000);
      state.buyers = await api('/api/engine/buyers');
    } catch (e) { toast(e.message, 'error'); }
    el.disabled = false; el.innerHTML = label;
    if (state.view === 'buyers') drawBuyers();
  },
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
      const m = await api('/api/engine/messages/' + encodeURIComponent(id), 'PUT', payload);
      delete state.editing[id];
      return m;
    }, 'Message saved');
  },
  'approve-message': function (el) {
    const id = el.dataset.id;
    messageAction(id, 'approve-message', async function () {
      const m = await api('/api/engine/messages/' + encodeURIComponent(id) + '/approve', 'POST');
      toast(m && m.status === 'scheduled' ? 'Approved — goes out ' + fmtDate(m.send_at) : 'Approved — ready to send');
      return m;
    });
  },
  'schedule-message': function (el) {
    const id = el.dataset.id;
    messageAction(id, 'schedule-message', async function () {
      const m = await api('/api/engine/messages/' + encodeURIComponent(id) + '/approve', 'POST');
      toast(m && m.status === 'scheduled' ? 'Scheduled for ' + fmtDate(m.send_at) : 'Kept as approved — send it by hand');
      return m;
    });
  },
  'unschedule-message': function (el) {
    const id = el.dataset.id;
    messageAction(id, 'unschedule-message', function () { return api('/api/engine/messages/' + encodeURIComponent(id) + '/unschedule', 'POST'); }, 'Taken off the clock — stays approved');
  },
  'retry-triage': function (el) {
    const cid = el.dataset.company, eid = el.dataset.entry;
    companyAction('reply', function () { return api('/api/engine/companies/' + encodeURIComponent(cid) + '/replies/' + encodeURIComponent(eid) + '/triage', 'POST'); }, 'Reply triaged');
  },
  'inbox-filter': function (el) { state.inboxFilter = el.dataset.filter; drawInbox(); },
  'inbox-refresh': function () { refreshInbox(); },
  'inbox-disqualify': async function (el) {
    if (!confirm('Disqualify this prospect? Scheduled follow-ups are cancelled.')) return;
    try {
      const c = await api('/api/engine/companies/' + encodeURIComponent(el.dataset.id) + '/stage', 'POST', { stage: 'disqualified' });
      setCompany(c); toast('Disqualified'); await refreshInbox();
    } catch (e) { toast(e.message, 'error'); }
  },
  'assign-unmatched': async function (el) {
    const id = el.dataset.id;
    const sel = document.querySelector('select[data-unmatched="' + id + '"]');
    const companyId = sel && sel.value;
    if (!companyId) { toast('Pick a prospect first', 'error'); return; }
    await withBusy(el, 'Triaging…', async function () {
      const c = await api('/api/engine/mail/unmatched/' + encodeURIComponent(id) + '/assign', 'POST', { company_id: companyId });
      toast('Assigned to ' + c.name + ' and triaged');
      setCompany(c);
      location.hash = '#/inbox/' + c.id;
      await refreshInbox();
    });
  },
  'discard-unmatched': async function (el) {
    try { await api('/api/engine/mail/unmatched/' + encodeURIComponent(el.dataset.id), 'DELETE'); toast('Discarded'); await refreshInbox(); }
    catch (e) { toast(e.message, 'error'); }
  },
  'reject-message': function (el) {
    const id = el.dataset.id;
    messageAction(id, 'reject-message', function () { return api('/api/engine/messages/' + encodeURIComponent(id) + '/reject', 'POST'); }, 'Message rejected');
  },
  'humanize-message': function (el) {
    const id = el.dataset.id;
    messageAction(id, 'humanize-message', function () { return api('/api/engine/messages/' + encodeURIComponent(id) + '/humanize', 'POST'); }, 'Humanizer pass complete');
  },
  'send-message': function (el) {
    const id = el.dataset.id;
    const c = state.company;
    messageAction(id, 'send-message', async function () {
      const res = await api('/api/engine/messages/' + encodeURIComponent(id) + '/send', 'POST');
      if (res && res.message) replaceMessage(res.message);
      if (res && res.mailto) { try { window.open(res.mailto, '_blank'); } catch (e) { /* popup blocked */ } }
      if (c) {
        const fresh = await api('/api/engine/companies/' + encodeURIComponent(c.id));
        setCompany(fresh);
      }
      const scheduled = ((state.company && state.company.messages) || []).filter(function (m) { return m.status === 'scheduled'; }).length;
      if (res && res.deferred) { toast(res.note, 'info', 6000); return null; }
      toast(res && res.delivered ? 'Sent by email' + (scheduled ? ' — ' + plural(scheduled, 'follow-up') + ' on the clock' : '')
        : res && res.mailto ? 'Opened in your mail client — logged as sent' : 'Marked as sent — logged in the conversation');
      return null;
    });
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
      await api('/api/engine/buyers/' + encodeURIComponent(b.id), 'DELETE');
      state.buyers = state.buyers.filter(function (x) { return x.id !== b.id; });
      toast('Buyer deleted');
      drawBuyers();
    });
  },
  /* ---- buy-side notes ---- */
  'draft-buyer-note': async function (el) {
    const buyerId = el.dataset.buyer, companyId = el.dataset.company;
    await withBusy(el, 'Drafting…', async function () {
      const r = await api('/api/engine/buyers/' + encodeURIComponent(buyerId) + '/notes', 'POST', { company_id: companyId });
      const i = (state.buyers || []).findIndex(function (b) { return b.id === buyerId; });
      if (i >= 0) state.buyers[i] = r.buyer;
      toast('Anonymised buyer note drafted — review it on the Buyers page');
      state.suggest = await api('/api/engine/suggestions').catch(function () { return state.suggest; });
      if (state.view === 'buyers') drawBuyers(); else if (state.view === 'dashboard') drawDashboard(); else location.hash = '#/buyers';
    });
  },
  /* ---- one-click pairing ---- */
  'pair': async function (el) {
    const body = {};
    if (el.dataset.company) body.company_id = el.dataset.company;
    if (el.dataset.buyer) body.buyer_id = el.dataset.buyer;
    await withBusy(el, 'Pairing…', async function () {
      const p = await api('/api/engine/pairings', 'POST', body);
      state.pairings = [p].concat((state.pairings || []).filter(function (x) { return x.id !== p.id; }));
      pairingModal(p);
      if (state.view === 'dashboard') drawDashboard();
    });
  },
  'pairing-why': function (el) { const p = (state.pairings || []).find(function (x) { return x.id === el.dataset.id; }); if (p) pairingModal(p); },
  'pairing-accept': async function (el) {
    const id = el.dataset.id;
    await withBusy(el, 'Accepting…', async function () {
      const r = await api('/api/engine/pairings/' + encodeURIComponent(id) + '/accept', 'POST');
      closeModal();
      toast(r.buyer_message_id ? 'Pairing accepted — anonymised buyer note drafted, review it on the Buyers page' : 'Pairing accepted — open the owner conversation first; the buyer is told once the owner replies');
      state.buyersLoaded = false; state.companies = [];
      await refreshPairings();
    });
  },
  'pairing-dismiss': async function (el) {
    const id = el.dataset.id;
    await api('/api/engine/pairings/' + encodeURIComponent(id) + '/dismiss', 'POST').catch(function (e) { toast(e.message, 'error'); });
    closeModal();
    await refreshPairings();
  },
  /* ---- buy-side mandates ---- */
  'bs-pitch': async function (el) {
    const id = el.dataset.id;
    await withBusy(el, 'Writing pitch…', async function () {
      const r = await api('/api/engine/buyside/mandates/' + encodeURIComponent(id) + '/pitch', 'POST');
      bsState().current = r.mandate; state.buyersLoaded = false;
      state.buyers = await api('/api/engine/buyers').catch(function () { return state.buyers; }); state.buyersLoaded = true;
      toast('Pitch drafted — review it, then send to your inbox');
      drawBuyside();
    });
  },
  'bs-import': async function (el) {
    const id = el.dataset.id;
    await withBusy(el, 'Adding…', async function () {
      const r = await api('/api/engine/buyside/mandates/' + encodeURIComponent(id) + '/import', 'POST', { top: Number(el.dataset.top) || 10 });
      bsState().current = r.mandate; state.companies = [];
      toast(plural(r.imported, 'target') + ' added to the sell-side pipeline as New');
      drawBuyside();
    });
  },
  'bs-send': async function (el) {
    const msgId = el.dataset.msg, id = el.dataset.id;
    await withBusy(el, 'Sending…', async function () {
      await api('/api/engine/buyer-messages/' + encodeURIComponent(msgId) + '/approve', 'POST').catch(function () { /* may already be approved */ });
      const r = await api('/api/engine/buyer-messages/' + encodeURIComponent(msgId) + '/send', 'POST');
      if (r && r.mailto) { try { window.open(r.mailto, '_blank'); } catch (e) { /* popup blocked */ } }
      state.buyers = await api('/api/engine/buyers').catch(function () { return state.buyers; });
      bsState().current = await api('/api/engine/buyside/mandates/' + encodeURIComponent(id));
      toast(r && r.message && r.message.delivery === 'email' ? 'Pitch sent by email' + (state.settings && state.settings.demo_email ? ' to ' + state.settings.demo_email + ' (demo mode)' : '') : 'Pitch opened in your mail client');
      drawBuyside();
    });
  },
  'bs-delete': async function (el) {
    if (!confirm('Delete this mandate and its target list?')) return;
    await api('/api/engine/buyside/mandates/' + encodeURIComponent(el.dataset.id), 'DELETE');
    bsState().current = null; location.hash = '#/buyside'; renderBuyside();
  },
  'lint-override': function (el) {
    const id = el.dataset.id, on = el.dataset.value === '1';
    if (on && !confirm('Send this draft even though the human-language check failed?')) return;
    messageAction(id, 'lint-override', async function () { const m = await api('/api/engine/messages/' + encodeURIComponent(id), 'PUT', { lint_override: on }); toast(on ? 'Override set — sending allowed' : 'Override removed'); return m; });
  },
  'buyer-msg-approve': function (el) { buyerMessageAction(el, 'approve', 'Buyer note approved'); },
  'buyer-msg-reject': function (el) { buyerMessageAction(el, 'reject', 'Buyer note rejected'); },
  'buyer-msg-send': function (el) { buyerMessageAction(el, 'send', 'Buyer note sent'); },
  /* ---- integrations (mock adapters for the teammate's scraper / matcher / mailer) ---- */
  'mock-profiles': async function (el) {
    await withBusy(el, 'Importing…', async function () {
      const r = await api('/api/engine/integrations/mock/profiles', 'POST');
      toast('Imported ' + plural((r.imported || []).length, 'scraper profile') + ' (' + (r.imported || []).reduce(function (n, x) { return n + (x.facts || 0); }, 0) + ' sourced facts)');
      state.companies = [];
    });
  },
  'mock-matches': async function (el) {
    await withBusy(el, 'Importing…', async function () {
      const r = await api('/api/engine/integrations/mock/matches', 'POST');
      toast('Matcher results applied to ' + plural(r.companies_updated || 0, 'company', 'companies'));
      state.companies = [];
    });
  },
  'open-outbox': function () { window.open('/api/engine/integrations/outbox?status=approved', '_blank'); },
  'reset-demo': async function (el) {
    if (!confirm('Reset all demo data? Enrichment, drafts and conversations will be lost.')) return;
    await withBusy(el, 'Resetting…', async function () {
      await api('/api/engine/reset-demo', 'POST');
      state.job = null; state.buyersLoaded = false; state.company = null;
      toast('Demo data reset');
      await loadSettings();
      location.hash = '#/dashboard';
      if (state.view === 'dashboard') renderDashboard();
    });
  }
};

async function buyerMessageAction(el, action, okMsg) {
  const id = el.dataset.id;
  await withBusy(el, '…', async function () {
    const r = await api('/api/engine/buyer-messages/' + encodeURIComponent(id) + '/' + action, 'POST');
    const m = r && r.message ? r.message : r;
    (state.buyers || []).forEach(function (b) { const i = (b.messages || []).findIndex(function (x) { return x.id === id; }); if (i >= 0) b.messages[i] = m; });
    if (r && r.mailto) window.open(r.mailto, '_blank');
    toast(okMsg + (r && r.mailto ? ' — your mail client opened with the note' : ''));
    if (state.view === 'buyers') drawBuyers();
  });
}

/* ================= form submits ================= */
const FORMS = {
  'buyside-new': async function (form, fd, submitBtn) {
    const bs = bsState();
    const body = { thesis_text: String(fd.get('thesis_text') || '').trim() || THESIS_EXAMPLE, buyer_name: String(fd.get('buyer_name') || '').trim(), buyer_type: fd.get('buyer_type'), countries: fd.getAll('countries') };
    bsStartStepper(); drawBuyside();
    try {
      const m = await api('/api/engine/buyside/mandates', 'POST', body);
      bs.current = m; bs.list = await api('/api/engine/buyside/mandates').catch(function () { return bs.list; });
      toast((m.stats ? m.stats.targets : 0) + ' targets found, ' + (m.stats ? m.stats.scored_70 : 0) + ' score 70+');
    } catch (e) { toast(e.message, 'error'); }
    finally { bsStopStepper(); if (state.view === 'buyside') drawBuyside(); }
  },
  'import-csv': async function (form, fd, submitBtn) {
    const csv = String(fd.get('csv') || '').trim();
    if (!csv) { toast('Paste CSV text first', 'error'); return; }
    await withBusy(submitBtn, 'Importing…', async function () {
      const res = await api('/api/engine/companies/import', 'POST', { csv: csv });
      closeModal();
      toast('Imported ' + plural(res.imported != null ? res.imported : (res.companies || []).length, 'prospect'));
      renderProspects();
    });
  },
  'add-prospect': async function (form, fd, submitBtn) {
    const body = prospectFromForm(fd);
    if (!body.name) { toast('Company name is required', 'error'); return; }
    await withBusy(submitBtn, 'Adding…', async function () {
      const c = await api('/api/engine/companies', 'POST', body);
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
    await companyAction('reply', function () { return api('/api/engine/companies/' + encodeURIComponent(c.id) + '/replies', 'POST', { text: text, channel: fd.get('channel') || 'email' }); },
      function (r) {
        const last = r && (r.conversation || []).filter(function (e) { return e.direction === 'inbound' && e.triage; }).pop();
        return 'Reply triaged' + (last ? ' — intent: ' + humanizeKey(last.triage.intent) + ', stage → ' + stageLabel(r.stage) : '');
      });
  },
  'add-buyer': async function (form, fd, submitBtn) {
    const body = buyerFromForm(fd);
    if (!body.name) { toast('Buyer name is required', 'error'); return; }
    await withBusy(submitBtn, 'Adding…', async function () {
      const b = await api('/api/engine/buyers', 'POST', body);
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
      const b = await api('/api/engine/buyers/' + encodeURIComponent(id), 'PUT', body);
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
      state.settings = await api('/api/engine/settings', 'PUT', body);
      updateBanner();
      toast('Settings saved');
      drawSettings();
    });
  }
};

/* ================= change handlers ================= */
const CHANGES = {
  'advisor': async function (el) {
    const c = state.company;
    if (!c) return;
    el.disabled = true;
    try {
      const updated = await api('/api/engine/companies/' + encodeURIComponent(c.id), 'PUT', { advisor_id: el.value });
      setCompany(updated);
      const a = advisorOf(updated);
      toast((a ? a.name : 'The advisor') + ' now owns this prospect. Redraft the outreach to have it signed by them.');
    } catch (e) { toast(e.message, 'error'); }
    drawCompany();
  },
  'filter-stage': function (el) { state.filters.stage = el.value; drawProspectRows(); },
  'filter-country': function (el) { state.filters.country = el.value; drawProspectRows(); },
  'filter-source': function (el) { state.filters.source = el.value; drawProspectRows(); },
  'outreach-lang': function (el) { state.outreachLang = el.value; },
  'outreach-framing': function (el) { state.outreachFraming = el.value; },
  'stage': async function (el) {
    const c = state.company;
    if (!c) return;
    const stage = el.value;
    el.disabled = true;
    try {
      const updated = await api('/api/engine/companies/' + encodeURIComponent(c.id) + '/stage', 'POST', { stage: stage });
      setCompany(updated);
      toast('Stage set to ' + stageLabel(updated.stage || stage));
    } catch (e) { toast(e.message, 'error'); }
    drawCompany();
  },
  'buyer-active': async function (el) {
    const id = el.dataset.id;
    const active = el.checked;
    try {
      const b = await api('/api/engine/buyers/' + encodeURIComponent(id), 'PUT', { active: active });
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
