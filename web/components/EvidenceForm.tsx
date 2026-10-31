import { useRef, useState } from "react";
import { readFile } from "../api.ts";

type Picked = { name: string; mime: string; dataBase64: string; size: number };

export function EvidenceForm({ onSubmit, busy, linkHint = "https://…" }: { onSubmit: (input: { files: Picked[]; links: string[]; note: string }) => void; busy: boolean; linkHint?: string }) {
  const [files, setFiles] = useState<Picked[]>([]);
  const [links, setLinks] = useState("");
  const [note, setNote] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function add(list: FileList | File[]) {
    const read = await Promise.all(Array.from(list).slice(0, 12).map(async (f) => ({ ...(await readFile(f)), size: f.size })));
    setFiles((prev) => [...prev, ...read].slice(0, 12));
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
          <textarea id="links" value={links} onChange={(e) => setLinks(e.target.value)} placeholder={linkHint} style={{ minHeight: 64 }} />
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
          <a className="faint" href="/samples" target="_blank" rel="noreferrer">Need test files?</a>
        </div>
        <button className="btn held" disabled={!ready || busy} onClick={() => onSubmit({ files, links: linkList, note })}>
          {busy ? "Verifying…" : "Submit for verification"}
        </button>
      </div>
    </div>
  );
}
