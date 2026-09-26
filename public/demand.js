/* Mergero — public buyer-demand page for business owners (served at /demand) */
'use strict';

(function () {
  // Revenue bands shown to the owner, each mapped to a representative revenue the API matches against (±30%).
  const BANDS = [
    { label: 'Under €2M', value: 1500000 },
    { label: '€2–5M', value: 3500000 },
    { label: '€5–10M', value: 7500000 },
    { label: '€10–25M', value: 17500000 },
    { label: '€25–50M', value: 37500000 },
    { label: '€50M+', value: 65000000 },
  ];
  const FALLBACK_COUNTRIES = [
    { code: 'FI', name: 'Finland' }, { code: 'SE', name: 'Sweden' }, { code: 'NO', name: 'Norway' }, { code: 'DK', name: 'Denmark' },
    { code: 'DE', name: 'Germany' }, { code: 'AT', name: 'Austria' }, { code: 'CH', name: 'Switzerland' },
  ];
  const TYPE_LABELS = {
    PE: ['Private equity fund', 'Private equity funds'],
    family_office: ['Family office', 'Family offices'],
    strategic: ['Strategic buyer', 'Strategic buyers'],
  };
  const DEAL_LABELS = { majority: 'Majority sale', minority: 'Minority stake', growth: 'Growth capital', buyout: 'Buyout', 'add-on': 'Add-on to a platform' };
  const DEAL_ORDER = ['majority', 'minority', 'growth', 'buyout', 'add-on'];

  const $ = function (id) { return document.getElementById(id); };
  const countrySel = $('country');
  const sectorSel = $('sector');
  const revenueSel = $('revenue');
  const showBtn = $('show-btn');
  const criteriaError = $('criteria-error');
  const step2 = $('step-2');
  const step3 = $('step-3');
  const resultEl = $('result');
  const leadForm = $('lead-form');
  const leadBtn = $('lead-btn');
  const leadError = $('lead-error');
  const leadWrap = $('lead-wrap');

  let countries = FALLBACK_COUNTRIES;
  const criteria = { country: '', sector: '', revenue_eur: null, band: '' };
  let busy = false;

  // ---- helpers ----
  function h(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }
  function option(value, label) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  }
  function showError(el, msg) { el.textContent = msg || ''; el.classList.toggle('show', Boolean(msg)); }
  function setBusy(btn, b, label) {
    btn.disabled = b;
    btn.innerHTML = '';
    if (b) btn.appendChild(h('span', 'spinner'));
    btn.appendChild(document.createTextNode(b ? 'One moment…' : label));
  }
  function countryName(code) {
    const c = countries.filter(function (x) { return x.code === code; })[0];
    return c ? c.name : code;
  }
  function plural(n, one, many) { return n === 1 ? one : many; }

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

  // ---- step 1: options ----
  function fillSelects(sectors) {
    countrySel.innerHTML = '';
    countrySel.appendChild(option('', 'Select country'));
    countries.forEach(function (c) { countrySel.appendChild(option(c.code, c.name)); });

    sectorSel.innerHTML = '';
    sectorSel.appendChild(option('', 'Select sector'));
    (sectors || []).forEach(function (s) { sectorSel.appendChild(option(s, s)); });
    sectorSel.appendChild(option('', 'Other / not listed'));

    revenueSel.innerHTML = '';
    revenueSel.appendChild(option('', 'Select revenue'));
    BANDS.forEach(function (b, i) { revenueSel.appendChild(option(String(i), b.label)); });
  }

  async function loadOptions() {
    try {
      const data = await api('/api/public/options');
      if (data && Array.isArray(data.countries) && data.countries.length) countries = data.countries;
      fillSelects(data && data.sectors);
    } catch (e) {
      fillSelects([]); // the page still works: country + revenue alone give a picture
    }
  }

  // ---- step 2: result ----
  function renderResult(d) {
    resultEl.innerHTML = '';
    const n = Number(d.matched_mandates) || 0;
    const where = criteria.country ? ' in ' + countryName(criteria.country) : '';
    const what = criteria.sector ? criteria.sector + ' companies' : 'companies';

    if (n === 0) {
      resultEl.appendChild(h('p', 'empty-title', 'No active mandate matches this exact profile today.'));
      resultEl.appendChild(h('p', 'lead', 'Mandates change every month, and buyers often widen their range for the right company. Tell us about yours and we will let you know the moment the picture changes.'));
      const total = Number(d.total_owners_in_conversation) || 0;
      if (total > 0) {
        const own = h('div', 'owners');
        own.appendChild(h('span', 'dot'));
        own.appendChild(h('span', null, total + ' ' + plural(total, 'owner is', 'owners are') + ' already in confidential conversations with us'));
        resultEl.appendChild(own);
      }
      resultEl.appendChild(confidentialityNote());
      return;
    }

    const head = h('div', 'headline');
    head.appendChild(h('div', 'big', n));
    head.appendChild(h('p', null, plural(n, 'buyer', 'buyers') + ' in the Mergero network ' + plural(n, 'is', 'are') + ' looking for companies like yours'));
    resultEl.appendChild(head);
    resultEl.appendChild(h('div', 'band', 'Active mandates for ' + what + where + (d.size_band ? ', ' + d.size_band : '') + '. Counted once per buyer, names withheld.'));

    // buyer types
    const types = d.buyer_types || {};
    const tiles = h('div', 'tiles');
    ['PE', 'family_office', 'strategic'].forEach(function (t) {
      const count = Number(types[t]) || 0;
      const tile = h('div', 'tile');
      tile.appendChild(h('div', 'n', count));
      tile.appendChild(h('div', 'l', TYPE_LABELS[t][count === 1 ? 0 : 1]));
      tiles.appendChild(tile);
    });
    resultEl.appendChild(tiles);

    // deal types
    const deals = d.deal_types || {};
    const keys = DEAL_ORDER.concat(Object.keys(deals).filter(function (k) { return DEAL_ORDER.indexOf(k) < 0; }));
    const chips = h('div', 'chips');
    keys.forEach(function (k) {
      const count = Number(deals[k]) || 0;
      if (!count) return;
      chips.appendChild(h('span', 'chip' + (k === 'minority' || k === 'growth' ? '' : ' quiet'), (DEAL_LABELS[k] || k) + ' · ' + count));
    });
    if (chips.childNodes.length) {
      resultEl.appendChild(h('div', 'subhead', 'What kind of deal they have in mind'));
      resultEl.appendChild(chips);
    }
    if (d.soft_entry_available) {
      resultEl.appendChild(h('div', 'soft', 'Several would consider growth capital or a minority stake — you would keep control.'));
    }

    // sample theses
    const theses = Array.isArray(d.sample_theses) ? d.sample_theses.filter(Boolean) : [];
    if (theses.length) {
      resultEl.appendChild(h('div', 'subhead', 'In their own words'));
      const ul = h('ul', 'quotes');
      theses.forEach(function (t) { ul.appendChild(h('li', null, '“' + t + '”')); });
      resultEl.appendChild(ul);
    }

    // owners already talking
    const owners = Number(d.owners_in_conversation) || 0;
    if (owners > 0) {
      const own = h('div', 'owners');
      own.appendChild(h('span', 'dot'));
      own.appendChild(h('span', null, owners + ' ' + plural(owners, 'owner', 'owners') + ' in your sector ' + plural(owners, 'is', 'are') + ' already in confidential conversations with us'));
      resultEl.appendChild(own);
    }

    resultEl.appendChild(confidentialityNote());
  }

  function confidentialityNote() {
    const note = h('div', 'note');
    note.appendChild(h('strong', null, 'How this works. '));
    note.appendChild(document.createTextNode('Off-market only: no auction, no public process, no leak. Buyers hear about a company only after its owner has decided to talk, and the owner sets the pace at every step.'));
    return note;
  }

  async function showDemand(e) {
    e.preventDefault();
    if (busy) return;
    showError(criteriaError, '');
    const country = countrySel.value;
    const bandIdx = revenueSel.value;
    if (!country) { showError(criteriaError, 'Please select your country.'); countrySel.focus(); return; }
    if (bandIdx === '') { showError(criteriaError, 'Please select your revenue band.'); revenueSel.focus(); return; }
    const band = BANDS[Number(bandIdx)];
    criteria.country = country;
    criteria.sector = sectorSel.value || '';
    criteria.revenue_eur = band.value;
    criteria.band = band.label;

    const params = new URLSearchParams({ country: country, revenue_eur: String(band.value) });
    if (criteria.sector) params.set('sector', criteria.sector);

    busy = true;
    setBusy(showBtn, true, 'Show buyer demand');
    try {
      const data = await api('/api/public/demand?' + params.toString());
      renderResult(data || {});
      step2.classList.remove('hidden');
      step3.classList.remove('hidden');
      step2.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      showError(criteriaError, err.message || 'Could not load buyer demand right now.');
    } finally {
      busy = false;
      setBusy(showBtn, false, 'Show buyer demand');
    }
  }

  // ---- step 3: lead ----
  async function sendLead(e) {
    e.preventDefault();
    if (busy) return;
    showError(leadError, '');
    const name = $('lead-name').value.trim();
    const company = $('lead-company').value.trim();
    const email = $('lead-email').value.trim();
    const message = $('lead-message').value.trim();
    if (!company) { showError(leadError, 'Please enter your company name.'); $('lead-company').focus(); return; }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { showError(leadError, 'Please enter a valid email address so we can reach you.'); $('lead-email').focus(); return; }

    busy = true;
    setBusy(leadBtn, true, 'Request a conversation');
    try {
      await api('/api/public/leads', 'POST', {
        name: name, company: company, email: email, message: message,
        country: criteria.country, sector: criteria.sector, revenue_eur: criteria.revenue_eur,
      });
      leadWrap.innerHTML = '';
      const ok = h('div', 'thanks', '✓ Thank you — a Mergero advisor will be in touch');
      ok.appendChild(h('small', null, 'We reach out personally, never through a mailing list. Nothing about your company is shared with anyone until you say so.'));
      leadWrap.appendChild(ok);
    } catch (err) {
      showError(leadError, err.message || 'Could not send your request right now.');
    } finally {
      busy = false;
      if (leadBtn.isConnected) setBusy(leadBtn, false, 'Request a conversation');
    }
  }

  $('criteria-form').addEventListener('submit', showDemand);
  leadForm.addEventListener('submit', sendLead);
  fillSelects([]);
  loadOptions();
})();
