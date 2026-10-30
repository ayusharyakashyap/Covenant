import { inflateSync } from "node:zlib";
// Machine-verified facts about uploaded files. The model judges meaning; code measures.
// Detects the real file type from magic bytes (catches a JPEG renamed to .png),
// image dimensions, PDF page counts, CSV row/duplicate counts and SVG validity.

export interface FileFacts {
  detectedType: string; // png | jpeg | gif | webp | pdf | svg | csv | text | zip | unknown
  extension: string;
  extensionMatchesContent: boolean;
  width?: number;
  height?: number;
  pages?: number;
  rows?: number; // CSV data rows (excluding header)
  uniqueRows?: number;
  duplicateRows?: number;
  columns?: string[];
  svgValid?: boolean;
  words?: number;
}

const EXT_TYPES: Record<string, string[]> = {
  png: ["png"], jpg: ["jpeg"], jpeg: ["jpeg"], gif: ["gif"], webp: ["webp"], pdf: ["pdf"], svg: ["svg"],
  csv: ["csv", "text"], txt: ["text", "csv"], md: ["text"], json: ["text"], zip: ["zip"],
};

function sniff(buf: Buffer, ext: string): string {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 4).toString("ascii") === "GIF8") return "gif";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buf.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x504b0304) return "zip";
  const head = buf.subarray(0, 2048).toString("utf8");
  if (/<svg[\s>]/i.test(head)) return "svg";
  // Mostly printable → text
  const sample = buf.subarray(0, 4096);
  let printable = 0;
  for (const b of sample) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128) printable++;
  if (sample.length && printable / sample.length > 0.95) return ext === "csv" ? "csv" : "text";
  return "unknown";
}

function imageSize(buf: Buffer, type: string): { width: number; height: number } | undefined {
  try {
    if (type === "png") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (type === "gif") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (type === "webp") {
      const chunk = buf.subarray(12, 16).toString("ascii");
      if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (type === "jpeg") {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) return undefined;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* malformed */
  }
  return undefined;
}

function svgSize(text: string) {
  const w = text.match(/<svg[^>]*\swidth="([\d.]+)/i)?.[1];
  const h = text.match(/<svg[^>]*\sheight="([\d.]+)/i)?.[1];
  const vb = text.match(/viewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/i);
  if (w && h) return { width: Math.round(+w), height: Math.round(+h) };
  if (vb) return { width: Math.round(+vb[1]), height: Math.round(+vb[2]) };
  return undefined;
}

function csvFacts(text: string) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { rows: 0, uniqueRows: 0, duplicateRows: 0, columns: [] as string[] };
  const columns = lines[0].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const body = lines.slice(1).map((l) => l.trim().toLowerCase());
  const unique = new Set(body).size;
  return { rows: body.length, uniqueRows: unique, duplicateRows: body.length - unique, columns: columns.slice(0, 30) };
}

export function fileFacts(buf: Buffer, name: string): FileFacts {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  const detectedType = sniff(buf, ext);
  const facts: FileFacts = {
    detectedType,
    extension: ext,
    extensionMatchesContent: (EXT_TYPES[ext] ?? [ext]).includes(detectedType),
  };
  const size = imageSize(buf, detectedType);
  if (size) Object.assign(facts, size);
  if (detectedType === "pdf") {
    const pages = pdfPageCount(buf);
    if (pages) facts.pages = pages;
  }
  if (detectedType === "svg") {
    const t = buf.toString("utf8");
    facts.svgValid = /<svg[\s>][\s\S]*<\/svg>\s*$/i.test(t.trim());
    const s = svgSize(t);
    if (s) Object.assign(facts, s);
  }
  if (detectedType === "csv" || (detectedType === "text" && ext === "csv")) Object.assign(facts, csvFacts(buf.toString("utf8")));
  if (detectedType === "text") facts.words = buf.toString("utf8").split(/\s+/).filter(Boolean).length;
  return facts;
}

/** Count pages, including PDFs that keep their page objects inside compressed object streams. */
function pdfPageCount(buf: Buffer): number | undefined {
  let text = buf.toString("latin1");
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  let budget = 40;
  while ((m = re.exec(text)) && budget-- > 0) {
    const dictStart = text.lastIndexOf("<<", m.index);
    if (!/FlateDecode/.test(text.slice(dictStart, m.index))) continue;
    const end = text.indexOf("endstream", m.index);
    if (end < 0) break;
    try {
      const raw = buf.subarray(m.index + m[0].length, end);
      text += "\n" + inflateSync(raw).toString("latin1");
    } catch {
      /* not a decodable stream */
    }
  }
  const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)].map((x) => Number(x[1] ?? x[2]));
  if (counts.length) return Math.max(...counts);
  const pages = text.match(/\/Type\s*\/Page(?!s)\b/g)?.length;
  return pages || undefined;
}
