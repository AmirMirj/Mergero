// Lawful "scraper": official open-data company registries, normalised to our Company shape.
// FI: PRH/YTJ open data v3 · NO: Brønnøysundregistrene · DK: cvrapi.dk (name lookup only).
const UA = "MergeroOriginationEngine/0.1 (hackathon demo)";

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": UA, ...headers }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Registry responded ${res.status} for ${new URL(url).host}`);
  return res.json();
}
const yearOf = (d) => (d ? Number(String(d).slice(0, 4)) || null : null);

async function searchFI({ q, industry_code, city, founded_before, page = 1 }) {
  const p = new URLSearchParams({ page: String(page) });
  if (q) p.set("name", q);
  if (city) p.set("location", city);
  if (industry_code) p.set("mainBusinessLine", industry_code);
  if (founded_before) p.set("registrationDateEnd", `${founded_before}-12-31`);
  const data = await getJson(`https://avoindata.prh.fi/opendata-ytj-api/v3/companies?${p}`);
  const results = (data.companies || []).map((c) => {
    const name = (c.names || []).find((n) => n.type === "1" && !n.endDate)?.name || c.names?.[0]?.name;
    const desc = c.mainBusinessLine?.descriptions || [];
    const industry = (desc.find((d) => d.languageCode === "3") || desc[0])?.description || "";
    const addr = (c.addresses || []).find((a) => !a.endDate) || c.addresses?.[0];
    const cityName = addr?.postOffices?.find((o) => o.languageCode === "1")?.city || addr?.postOffices?.[0]?.city || "";
    return {
      name, country: "FI", city: cityName, website: c.website?.url || "", industry, industry_code: c.mainBusinessLine?.type || "",
      // PRH's register starts in 1979: an earlier registration date means "older than the register", not a founding year.
      employees: null, founded: (() => { const y = yearOf(c.businessId?.registrationDate || c.registrationDate); return y && y > 1978 ? y : null; })(),
      founded_note: (() => { const y = yearOf(c.businessId?.registrationDate || c.registrationDate); return y && y <= 1978 ? "registered before 1979" : null; })(),
      registry_id: c.businessId?.value || "", source: "Registry: PRH/YTJ (FI)",
    };
  }).filter((r) => r.name);
  return { total: data.totalResults ?? results.length, results };
}

async function searchNO({ q, industry_code, employees_min, founded_before, page = 1 }) {
  const p = new URLSearchParams({ size: "50", page: String(Math.max(0, page - 1)) });
  if (q) p.set("navn", q);
  if (industry_code) p.set("naeringskode", industry_code);
  if (employees_min) p.set("fraAntallAnsatte", String(employees_min));
  if (founded_before) p.set("tilStiftelsesdato", `${founded_before}-12-31`);
  const data = await getJson(`https://data.brreg.no/enhetsregisteret/api/enheter?${p}`);
  const results = (data._embedded?.enheter || []).map((e) => ({
    name: e.navn, country: "NO", city: e.forretningsadresse?.poststed || e.forretningsadresse?.kommune || "",
    website: e.hjemmeside ? (e.hjemmeside.startsWith("http") ? e.hjemmeside : `https://${e.hjemmeside}`) : "",
    industry: e.naeringskode1?.beskrivelse || "", industry_code: e.naeringskode1?.kode || "",
    employees: e.antallAnsatte ?? null, founded: yearOf(e.stiftelsesdato), registry_id: e.organisasjonsnummer,
    source: "Registry: Brønnøysund (NO)",
  }));
  return { total: data.page?.totalElements ?? results.length, results };
}

async function searchDK({ q }) {
  if (!q) return { total: 0, results: [], note: "Danish CVR lookup needs a company name." };
  const data = await getJson(`https://cvrapi.dk/api?search=${encodeURIComponent(q)}&country=dk`);
  if (!data || data.error) return { total: 0, results: [] };
  return {
    total: 1,
    results: [{
      name: data.name, country: "DK", city: data.city || "", website: "", industry: data.industrydesc || "", industry_code: String(data.industrycode || ""),
      employees: data.employees ?? null, founded: data.startdate ? Number(String(data.startdate).slice(-4)) || null : null,
      registry_id: String(data.vat || ""), source: "Registry: CVR (DK)",
    }],
  };
}

// Real owner age: Brønnøysund lists the CEO (daglig leder), chair and board with birth dates — free, no key.
const ROLE_LABEL = { DAGL: "CEO (daglig leder)", LEDE: "Chair of the board", NEST: "Deputy chair", MEDL: "Board member", VARA: "Deputy board member", KONT: "Contact person", INNH: "Owner (sole proprietor)" };
export async function rolesNO(orgnr) {
  const id = String(orgnr || "").replace(/\D/g, "");
  if (id.length !== 9) throw Object.assign(new Error("A Norwegian organisation number (9 digits) is required"), { status: 400 });
  const data = await getJson(`https://data.brreg.no/enhetsregisteret/api/enheter/${id}/roller`);
  const year = new Date().getFullYear();
  const people = [];
  for (const g of data.rollegrupper || []) for (const r of g.roller || []) {
    if (!r.person || r.avregistrert) continue;
    const code = r.type?.kode || g.type?.kode;
    const born = r.person.fodselsdato ? Number(String(r.person.fodselsdato).slice(0, 4)) : null;
    people.push({ name: [r.person.navn?.fornavn, r.person.navn?.etternavn].filter(Boolean).join(" "), role: ROLE_LABEL[code] || r.type?.beskrivelse || code, role_code: code, birth_year: born, age: born ? year - born : null, since: g.sistEndret || null });
  }
  const ceo = people.find((p) => p.role_code === "DAGL") || null;
  const chair = people.find((p) => p.role_code === "LEDE") || null;
  return { people, ceo, chair, source: "Brønnøysund roles register", fetched_at: new Date().toISOString() };
}

// Reach of the open registers for the €2–50M band, using headcount as the proxy the registers can filter on.
export async function reach() {
  const out = { as_of: new Date().toISOString(), countries: [] };
  try {
    const no = await getJson("https://data.brreg.no/enhetsregisteret/api/enheter?fraAntallAnsatte=10&tilAntallAnsatte=250&organisasjonsform=AS&size=1");
    out.countries.push({ country: "NO", companies: no.page?.totalElements ?? null, basis: "AS with 10–250 employees (Brønnøysund, live)", live: true });
  } catch (e) { out.countries.push({ country: "NO", companies: null, basis: `Brønnøysund unavailable: ${e.message}`, live: false }); }
  out.countries.push({ country: "FI", companies: null, basis: "PRH open data has no size filter; filter by industry code and registration year, size from iXBRL accounts", live: false });
  out.countries.push({ country: "DK", companies: null, basis: "CVR name lookup only in this build; size from Virk XBRL accounts", live: false });
  out.countries.push({ country: "SE", companies: null, basis: "No free API (Bolagsverket); import from a prospect database", live: false });
  out.countries.push({ country: "DE/AT/CH", companies: null, basis: "No free registry API; LinkedIn + calls channel, import from a prospect database", live: false });
  return out;
}

export async function search(params) {
  const country = (params.country || "FI").toUpperCase();
  if (country === "FI") return searchFI(params);
  if (country === "NO") return searchNO(params);
  if (country === "DK") return searchDK(params);
  throw Object.assign(new Error(`No open registry connector for ${country} yet (FI, NO, DK available)`), { status: 400 });
}
