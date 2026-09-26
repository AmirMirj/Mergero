/* Mergero — public owner intake chat (served at /intake/:token) */
'use strict';

(function () {
  const token = (function () {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts.length ? decodeURIComponent(parts[parts.length - 1]) : '';
  })();

  const chat = document.getElementById('chat');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-text');
  const sendBtn = document.getElementById('chat-send');
  const sub = document.getElementById('intake-sub');
  const statusEl = document.getElementById('intake-status');
  const completeEl = document.getElementById('complete-state');
  const demandEl = document.getElementById('demand-snapshot');

  let status = 'pending';
  let busy = false;
  let demandLoaded = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg, type) {
    const root = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'error');
    el.innerHTML = '<span class="toast-icon">' + (type === 'error' || !type ? '✕' : '✓') + '</span><span>' + esc(msg) + '</span>';
    root.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () { el.classList.remove('show'); setTimeout(function () { el.remove(); }, 250); }, 5000);
  }

  async function api(path, method, body) {
    const opts = { method: method || 'GET', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, opts); }
    catch (e) { throw new Error('Connection problem. Please check your internet and try again.'); }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    return data;
  }

  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = 'chat-msg ' + (role === 'owner' ? 'owner' : role === 'system' ? 'system' : 'assistant');
    el.textContent = text;
    chat.appendChild(el);
    scrollDown();
    return el;
  }

  let typingEl = null;
  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement('div');
    typingEl.className = 'typing';
    typingEl.innerHTML = '<span></span><span></span><span></span>';
    chat.appendChild(typingEl);
    scrollDown();
  }
  function hideTyping() {
    if (typingEl) { typingEl.remove(); typingEl = null; }
  }
  function scrollDown() { chat.scrollTop = chat.scrollHeight; }

  function setStatus(s) {
    status = s || 'pending';
    statusEl.textContent = status === 'complete' ? 'Complete' : status === 'in_progress' ? 'In progress' : 'Started';
    statusEl.className = 'pill ' + (status === 'complete' ? 'pill-green' : status === 'in_progress' ? 'pill-teal' : '');
    if (status === 'complete') {
      completeEl.classList.remove('hidden');
      form.classList.add('hidden');
      input.disabled = true;
      sendBtn.disabled = true;
      loadDemand();
    }
  }

  // Value at first contact: once the conversation is complete, show the owner an anonymised view of buyer demand
  // for companies like theirs. Purely additive — any failure leaves the page exactly as it was.
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function renderDemand(d) {
    const n = Number(d.matched_mandates) || 0;
    demandEl.innerHTML = '';
    demandEl.appendChild(el('div', 'ds-title', 'What buyers are looking for in companies like yours'));

    const head = el('div', 'ds-head');
    head.appendChild(el('div', 'ds-n', n));
    head.appendChild(el('div', 'ds-text', (n === 1 ? 'buyer' : 'buyers') + ' in the Mergero network ' + (n === 1 ? 'has' : 'have') + ' an active mandate matching your profile'));
    demandEl.appendChild(head);

    const t = d.buyer_types || {};
    const parts = [
      [Number(t.PE) || 0, 'private equity fund', 'private equity funds'],
      [Number(t.family_office) || 0, 'family office', 'family offices'],
      [Number(t.strategic) || 0, 'strategic buyer', 'strategic buyers'],
    ].filter(function (p) { return p[0] > 0; }).map(function (p) { return p[0] + ' ' + (p[0] === 1 ? p[1] : p[2]); });
    if (parts.length) demandEl.appendChild(el('div', 'ds-types', parts.join(' · ')));

    if (d.soft_entry_available) {
      demandEl.appendChild(el('div', 'ds-soft', 'Several would consider growth capital or a minority stake — you would keep control.'));
    }

    const theses = Array.isArray(d.sample_theses) ? d.sample_theses.filter(Boolean) : [];
    if (theses.length) {
      const ul = el('ul', 'ds-quotes');
      theses.forEach(function (q) { ul.appendChild(el('li', null, '“' + q + '”')); });
      demandEl.appendChild(ul);
    }

    demandEl.appendChild(el('div', 'ds-foot', 'Anonymised and counted once per buyer. Your advisor can tell you more about who is behind these mandates.'));
  }

  async function loadDemand() {
    if (demandLoaded || !demandEl || !token) return;
    demandLoaded = true;
    try {
      const d = await api('/api/public/demand?token=' + encodeURIComponent(token));
      if (!d || !(Number(d.matched_mandates) > 0)) return;
      renderDemand(d);
      demandEl.classList.remove('hidden');
    } catch (e) {
      // nothing to show; the thank-you state stands on its own
    }
  }

  function setBusy(b) {
    busy = b;
    input.disabled = b || status === 'complete';
    sendBtn.disabled = b || status === 'complete';
    sendBtn.innerHTML = b ? '<span class="spinner"></span>' : 'Send';
    if (b) showTyping(); else hideTyping();
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(140, input.scrollHeight) + 'px';
  }

  async function load() {
    if (!token) {
      sub.textContent = 'Invalid link';
      addMessage('assistant', 'This intake link is not valid. Please ask your Mergero advisor for a new one.');
      setBusy(false); input.disabled = true; sendBtn.disabled = true;
      return;
    }
    showTyping();
    try {
      const data = await api('/api/intake/' + encodeURIComponent(token));
      hideTyping();
      sub.textContent = [data.company_name, data.advisor_name ? 'with ' + data.advisor_name : '', data.firm || ''].filter(Boolean).join(' · ');
      document.title = 'Mergero · ' + (data.company_name || 'Owner conversation');
      chat.innerHTML = '';
      (data.transcript || []).forEach(function (t) { addMessage(t.role === 'owner' ? 'owner' : 'assistant', t.text); });
      setStatus(data.status);
      if (status !== 'complete') input.focus();
    } catch (e) {
      hideTyping();
      sub.textContent = 'Link unavailable';
      addMessage('assistant', e.message || 'This link could not be opened.');
      input.disabled = true; sendBtn.disabled = true;
    }
  }

  async function send() {
    const text = input.value.trim();
    if (!text || busy || status === 'complete') return;
    addMessage('owner', text);
    input.value = '';
    autoGrow();
    setBusy(true);
    try {
      const res = await api('/api/intake/' + encodeURIComponent(token) + '/message', 'POST', { text: text });
      setBusy(false);
      if (res && res.reply) addMessage('assistant', res.reply);
      setStatus(res && res.status ? res.status : 'in_progress');
      if (status === 'complete') {
        addMessage('system', 'Thank you — summary sent to your advisor');
      } else {
        input.focus();
      }
    } catch (e) {
      setBusy(false);
      toast(e.message, 'error');
      input.value = text;
      autoGrow();
      input.focus();
    }
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', autoGrow);

  load();
})();
