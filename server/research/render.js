// Headless rendering for client-side-rendered sites. puppeteer-core is imported lazily so the app still runs
// without it; drives any local Chrome/Edge/Chromium (override with BROWSER_PATH).
import { access } from "node:fs/promises";
import { join } from "node:path";

let lib, exe;
const loadLib = () => (lib ??= import("puppeteer-core").then((m) => m.default ?? m, () => null));
const exists = (p) => access(p).then(() => true, () => false);

function candidates() {
  const env = process.env;
  if (process.platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files", pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
      join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"), join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(pf, "Google\\Chrome\\Application\\chrome.exe"), join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe"),
    ];
  }
  if (process.platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
}

function findBrowser() {
  return (exe ??= (async () => {
    for (const p of [process.env.BROWSER_PATH, ...candidates()]) if (p && (await exists(p))) return p;
    return null;
  })());
}

export async function browserAvailable() {
  return Boolean((await findBrowser()) && (await loadLib()));
}

// Renders each URL in its own tab (sequentially) and returns Map<url, html>; empty Map when no browser.
// Optional `deadline` (epoch ms) stops starting new pages once the caller's time budget is spent.
export async function renderPages(urls, { timeoutMs = 20000, userAgent, deadline } = {}) {
  const out = new Map();
  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) return out;
  const [path, puppeteer] = await Promise.all([findBrowser(), loadLib()]);
  if (!path || !puppeteer) return out;
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: path, headless: true,
      args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
    });
    for (const url of list) {
      const left = deadline ? deadline - Date.now() : Infinity;
      if (left < 2000) break;
      const page = await browser.newPage();
      try {
        if (userAgent) await page.setUserAgent({ userAgent });
        await page.setRequestInterception(true);
        page.on("request", (req) => (/^(image|media|font)$/.test(req.resourceType()) ? req.abort() : req.continue()).catch(() => {}));
        let res = null;
        try { res = await page.goto(url, { waitUntil: "networkidle2", timeout: Math.min(timeoutMs, left) }); }
        catch (e) { if (e?.name !== "TimeoutError") throw e; } // chatty trackers never go idle: keep what has rendered
        if (res && res.status() >= 400) continue;
        // absolutise links so the caller can resolve them without knowing where the browser ended up
        await page.evaluate(() => { for (const el of document.querySelectorAll("a[href], link[href]")) el.setAttribute("href", el.href); }).catch(() => {});
        out.set(url, await page.content());
      } catch {
        // unrenderable page: skip it
      } finally {
        await page.close().catch(() => {});
      }
    }
  } catch {
    // browser failed to launch: return whatever rendered
  } finally {
    await browser?.close().catch(() => {});
  }
  return out;
}
