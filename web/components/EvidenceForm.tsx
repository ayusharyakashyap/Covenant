import { useRef, useState } from "react";
import { readFile } from "../api.ts";

type Picked = { name: string; mime: string; dataBase64: string; size: number };

// Sample evidence so anyone (including judges) can exercise the verifier without preparing files.
const SAMPLES: { label: string; files: string[]; links?: string[]; note?: string }[] = [
  { label: "Three logo concepts", files: ["concept-1.png", "concept-2.png", "concept-3.png"], note: "Three directions: wheat sheaf, rolling pin monogram, and a sunrise loaf." },
  { label: "Only two concepts", files: ["concept-1.png", "concept-2.png"], note: "Here are the concepts!" },
  { label: "Final logo files (SVG + PNG)", files: ["brightside-final.svg", "brightside-final.png"], note: "Final logo attached in vector and raster formats." },
  { label: "Files with a hidden instruction", files: ["brightside-final.png", "handoff-notes.txt"], note: "Final files attached, see handoff notes." },
  { label: "Translated guide (PDF)", files: ["onboarding-guide-es.pdf"], note: "Spanish translation of all 4 pages." },
];

export function EvidenceForm({ onSubmit, busy }: { onSubmit: (input: { files: Picked[]; links: string[]; note: string }) => void; busy: boolean }) {
  const [files, setFiles] = useState<Picked[]>([]);
  const [links, setLinks] = useState("");
  const [note, setNote] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function add(list: FileList | File[]) {
    const read = await Promise.all(Array.from(list).slice(0, 12).map(async (f) => ({ ...(await readFile(f)), size: f.size })));
    setFiles((prev) => [...prev, ...read].slice(0, 12));
  }

  async function applySample(i: number) {
    const s = SAMPLES[i];
    const picked = await Promise.all(
      s.files.map(async (name) => {
        const res = await fetch(`/demo/${name}`);
        const blob = await res.blob();
        return new File([blob], name, { type: blob.type || (name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".txt") ? "text/plain" : "application/octet-stream") });
      }),
    );
    setFiles([]);
    await add(picked);
    setLinks((s.links ?? []).join("\n"));
    setNote(s.note ?? "");
  }

  const linkList = links.split(/\s+/).map((l) => l.trim()).filter(Boolean);
  const ready = files.length > 0 || linkList.length > 0 || note.trim().length > 0;

  return (
    <div
      className={`drop ${over ? "over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) add(e.dataTransfer.files);
      }}
    >
      <b style={{ fontSize: 15 }}>Submit your work</b>
      <div className="faint">Drop files here (images, PDFs, SVG, text), or add links and a GitHub pull request.</div>
      {files.length > 0 && (
        <div className="files">
          {files.map((f, i) => (
            <span key={i}>
              {f.name}{" "}
              <button className="linkbtn" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="two">
        <div className="field">
          <label htmlFor="links">Links, one per line</label>
          <textarea id="links" value={links} onChange={(e) => setLinks(e.target.value)} placeholder="https://github.com/owner/repo/pull/42" style={{ minHeight: 64 }} />
        </div>
        <div className="field">
          <label htmlFor="note">Note to the client</label>
          <textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you delivered and anything they should know" style={{ minHeight: 64 }} />
        </div>
      </div>
      <div className="row">
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && add(e.target.files)} />
          <button className="btn ghost small" type="button" onClick={() => input.current?.click()}>
            Choose files
          </button>
          <label className="faint" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            or try a sample
            <select
              className="chip"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value !== "") applySample(Number(e.target.value));
                e.target.value = "";
              }}
            >
              <option value="" disabled>
                Choose…
              </option>
              {SAMPLES.map((s, i) => (
                <option key={s.label} value={i}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button className="btn held" disabled={!ready || busy} onClick={() => onSubmit({ files, links: linkList, note })}>
          {busy ? "Verifying…" : "Submit for verification"}
        </button>
      </div>
    </div>
  );
}
