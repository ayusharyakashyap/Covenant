// Kernel cloud browsers (https://kernel.sh): open a delivered website in a real browser,
// capture desktop + mobile screenshots, page text and console errors, so the verifier can
// *look* at the live site instead of reading raw HTML.
const BASE = (process.env.KERNEL_API_BASE ?? "https://api.onkernel.com").replace(/\/$/, "");
export const kernelLive = () => Boolean(process.env.KERNEL_API_KEY);

export interface SiteInspection {
  status: number | null;
  finalUrl: string;
  title: string;
  text: string;
  desktopPng: Buffer;
  mobilePng: Buffer;
  errors: string[];
  controls: string[];
  ms: number;
}

async function k<T>(method: string, path: string, body?: unknown, timeoutMs = 90_000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${process.env.KERNEL_API_KEY}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Kernel ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(t);
  }
}

// Runs inside Kernel's browser VM via the Playwright execute endpoint.
const script = (url: string) => `
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 240)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 240)); });
await page.setViewportSize({ width: 1280, height: 800 });
let status = null;
try {
  const resp = await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 25000 });
  status = resp ? resp.status() : null;
} catch (e) {
  errors.push('navigation: ' + String(e).slice(0, 200));
}
await page.waitForTimeout(800);
const title = await page.title().catch(() => '');
const text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
const controls = await page.evaluate(() => Array.from(document.querySelectorAll('a,button,[role=button],input[type=submit]'))
  .map((el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 60)).catch(() => []);
const desktop = (await page.screenshot({ type: 'png' })).toString('base64');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
const mobile = (await page.screenshot({ type: 'png' })).toString('base64');
return { status, finalUrl: page.url(), title, text: text.slice(0, 4000), controls, errors: errors.slice(0, 15), desktop, mobile };
`;

export async function inspectSite(url: string): Promise<SiteInspection> {
  const t0 = Date.now();
  const browser = await k<{ session_id: string }>("POST", "/browsers", {
    headless: true,
    timeout_seconds: 60,
    viewport: { width: 1280, height: 800 },
  });
  try {
    const r = await k<{ success: boolean; result?: any; error?: string }>(
      "POST",
      `/browsers/${browser.session_id}/playwright/execute`,
      { code: script(url), timeout_sec: 60 },
      75_000,
    );
    if (!r.success || !r.result) throw new Error(r.error ?? "Kernel script failed");
    const x = r.result;
    return {
      status: x.status,
      finalUrl: x.finalUrl,
      title: x.title,
      text: x.text,
      controls: x.controls ?? [],
      errors: x.errors ?? [],
      desktopPng: Buffer.from(x.desktop, "base64"),
      mobilePng: Buffer.from(x.mobile, "base64"),
      ms: Date.now() - t0,
    };
  } finally {
    // Sessions also expire on their own after the inactivity timeout.
    k("DELETE", `/browsers/${browser.session_id}`).catch(() => undefined);
  }
}
