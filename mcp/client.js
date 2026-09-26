// Thin HTTP client for the Mergero Origination Engine REST API (server/index.js, contract in API.md).
// The engine is an internal tool without authentication, so this is a plain fetch wrapper with clear errors.
export class MergeroClient {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl || "http://localhost:3000").replace(/\/+$/, "");
  }

  async request(method, path, body) {
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
    if (!res.ok) throw new Error((data && typeof data === "object" && data.error) || `${res.status} ${res.statusText}`);
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
