// Turns raw uploads and links into evidence items, including machine-verified facts.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { nanoid } from "./id.ts";
import { store } from "./store.ts";
import { fileFacts } from "./facts.ts";
import { inspectSite, kernelLive } from "./kernel.ts";
import type { EvidenceItem } from "../shared/types.ts";

export interface UploadInput { name: string; mime: string; dataBase64: string }

const TEXTY = /^(text\/|application\/(json|xml|javascript))|image\/svg\+xml/;
const MAX_FILE = 15 * 1024 * 1024;

const safeName = (n: string) => n.replace(/[^\w.\-]+/g, "_").slice(-80) || "file";

export function storeUpload(contractId: string, u: UploadInput): EvidenceItem {
  const buf = Buffer.from(u.dataBase64.replace(/^data:[^,]*,/, ""), "base64");
  if (buf.length > MAX_FILE) throw Object.assign(new Error(`${u.name} is larger than 15 MB.`), { status: 413 });
  const id = `ev_${nanoid(8)}`;
  const dir = join(store.uploadsDir, contractId);
  mkdirSync(dir, { recursive: true });
  const fileName = `${id}-${safeName(u.name)}`;
  const storedPath = join(dir, fileName);
  writeFileSync(storedPath, buf);
  const facts = fileFacts(buf, u.name);
  // Trust the bytes, not the browser's label: a JPEG renamed .png is still a JPEG.
  const sniffed: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", svg: "image/svg+xml", csv: "text/csv", text: "text/plain" };
  const mime = sniffed[facts.detectedType] ?? (u.mime || guessMime(u.name));
  const isImage = /^image\/(png|jpeg|gif|webp)$/.test(mime);
  return {
    id,
    kind: isImage ? "image" : "file",
    name: u.name,
    mime,
    size: buf.length,
    url: `/uploads/${contractId}/${fileName}`,
    storedPath,
    excerpt: TEXTY.test(mime) ? buf.toString("utf8").slice(0, 6000) : undefined,
    facts: { source: "file inspection", ...facts },
  };
}

export function guessMime(name: string) {
  const map: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown",
    ".json": "application/json", ".csv": "text/csv", ".html": "text/html", ".zip": "application/zip",
  };
  return map[extname(name).toLowerCase()] ?? "application/octet-stream";
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(t);
  }
}

// Refuse obviously internal addresses so evidence links can't be used to probe the server's network.
function isPublicHttpUrl(raw: string) {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === "[::1]") return false;
    return true;
  } catch {
    return false;
  }
}

export async function linkEvidence(raw: string, contractId?: string): Promise<EvidenceItem[]> {
  const r = await linkEvidenceInner(raw, contractId);
  return Array.isArray(r) ? r : [r];
}

async function linkEvidenceInner(raw: string, contractId?: string): Promise<EvidenceItem | EvidenceItem[]> {
  const url = raw.trim();
  const id = `ev_${nanoid(8)}`;
  const base: EvidenceItem = { id, kind: "link", name: url.replace(/^https?:\/\//, "").slice(0, 80), url };
  if (!isPublicHttpUrl(url)) return { ...base, facts: { reachable: false, reason: "Not a public http(s) URL" } };

  const pr = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
  if (pr) {
    try {
      const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "covenant-verifier" };
      if (process.env.GITHUB_TOKEN && !process.env.GITHUB_TOKEN.includes("proxy")) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const res = await fetchWithTimeout(`https://api.github.com/repos/${pr[1]}/${pr[2]}/pulls/${pr[3]}`, { headers });
      if (res.ok) {
        const j = (await res.json()) as Record<string, any>;
        return {
          ...base,
          name: `${pr[1]}/${pr[2]}#${pr[3]}`,
          excerpt: `${j.title}\n\n${String(j.body ?? "").slice(0, 1500)}`,
          facts: {
            source: "GitHub API",
            reachable: true,
            title: j.title,
            state: j.state,
            merged: Boolean(j.merged),
            merged_at: j.merged_at,
            author: j.user?.login,
            changed_files: j.changed_files,
            additions: j.additions,
            deletions: j.deletions,
          },
        };
      }
      return { ...base, facts: { source: "GitHub API", reachable: false, status: res.status } };
    } catch (e) {
      return { ...base, facts: { source: "GitHub API", reachable: false, error: String(e) } };
    }
  }

  // Real browser via Kernel: screenshots the verifier can look at, plus console errors.
  if (kernelLive() && contractId) {
    try {
      const site = await inspectSite(url);
      const shots = (["desktop", "mobile"] as const).map((v) => {
        const item = storeUpload(contractId, { name: `${v}-${new URL(url).hostname}.png`, mime: "image/png", dataBase64: (v === "desktop" ? site.desktopPng : site.mobilePng).toString("base64") });
        item.facts = { ...item.facts, source: "Kernel cloud browser", screenshotOf: url, viewport: v === "desktop" ? "1280x800" : "390x844" };
        return item;
      });
      const link: EvidenceItem = {
        ...base,
        excerpt: `Title: ${site.title}\n${site.text}`,
        facts: {
          source: "Kernel cloud browser",
          reachable: site.status !== null && site.status < 400,
          status: site.status,
          finalUrl: site.finalUrl,
          title: site.title,
          consoleErrors: site.errors,
          interactiveControls: site.controls.slice(0, 30),
          screenshots: shots.map((x) => x.id),
          inspectedInMs: site.ms,
        },
      };
      return [link, ...shots];
    } catch (e) {
      console.warn(`[kernel] falling back to plain fetch: ${e instanceof Error ? e.message : e}`);
    }
  }

  try {
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": "covenant-verifier" } });
    const type = res.headers.get("content-type") ?? "";
    let excerpt = "";
    let title = "";
    if (type.includes("text/html") || type.includes("text/plain")) {
      const html = (await res.text()).slice(0, 300_000);
      title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim();
      excerpt = html
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2500);
    }
    return { ...base, excerpt: title ? `Title: ${title}\n${excerpt}` : excerpt, facts: { reachable: res.ok, status: res.status, contentType: type.split(";")[0], title } };
  } catch (e) {
    return { ...base, facts: { reachable: false, error: e instanceof Error ? e.message : String(e) } };
  }
}

export function textEvidence(text: string): EvidenceItem {
  return { id: `ev_${nanoid(8)}`, kind: "text", name: "Written note", excerpt: text.slice(0, 8000) };
}
