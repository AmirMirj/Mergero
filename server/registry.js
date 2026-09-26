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
      employees: null, founded: yearOf(c.businessId?.registrationDate || c.registrationDate),
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

export async function search(params) {
  const country = (params.country || "FI").toUpperCase();
  if (country === "FI") return searchFI(params);
  if (country === "NO") return searchNO(params);
  if (country === "DK") return searchDK(params);
  throw Object.assign(new Error(`No open registry connector for ${country} yet (FI, NO, DK available)`), { status: 400 });
}
