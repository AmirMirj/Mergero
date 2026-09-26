// Thin HTTP client for the Mergero Origination Engine REST API (server/index.js, contract in API.md).
// The engine is an internal tool without authentication, so this is a plain fetch wrapper with clear errors.
export class MergeroClient {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl || "http://localhost:3000").replace(/\/+$/, "");
  }

  // Since the desk merge, /api/companies, /api/buyers and a few others belong to Amir's desk UI; the engine's own versions
  // are reached under /api/engine/… (rewritten server-side). An engine from before the merge has no such route (Express's
  // plain-text 404), and then the original path is used.
  async request(method, path, body) {
    if (path.startsWith("/api/") && !path.startsWith("/api/engine/")) {
      try { return await this.send(method, `/api/engine/${path.slice(5)}`, body); }
      catch (err) { if (!err.noRoute) throw err; }
    }
    return this.send(method, path, body);
  }

  async send(method, path, body) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Cannot reach the Mergero engine at ${this.baseUrl} (${err.message}). Start it with "npm start" in the mergero folder, or set MERGERO_API_URL.`);
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw Object.assign(new Error((data && typeof data === "object" && data.error) || `${res.status} ${res.statusText}`), { status: res.status, noRoute: res.status === 404 && typeof data !== "object" });
    return data;
  }

  get(path) { return this.request("GET", path); }
  post(path, body) { return this.request("POST", path, body ?? {}); }
  put(path, body) { return this.request("PUT", path, body ?? {}); }
  del(path) { return this.request("DELETE", path); }
}

// Query string from a record; empty values are dropped.
export function qs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}
