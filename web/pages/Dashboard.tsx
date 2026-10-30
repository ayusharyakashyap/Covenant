import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { day, keyring, loadScript, money, when } from "../api.ts";
import { ConfigCtx, Link, useToast } from "../app.tsx";
import { covenantTheme, loadAgGrid, toFilterModel } from "../components/grid.ts";
import { Timeline } from "../components/Timeline.tsx";

type View = { columns: string[]; filters: { field: string; op: string; value?: string | number }[]; sort?: { field: string; dir: "asc" | "desc" } };
type Portfolio = {
  kpis: { contracts: number; held: number; paid: number; returned: number; penalties: number; verifications: number; autoPaidShare: number; disputes: number };
  contracts: Record<string, any>[];
  milestones: Record<string, any>[];
  ledger: Record<string, any>[];
};

const usd = (n: number) => money(Math.round(n * 100));
const LABEL: Record<string, string> = {
  contract: "Contract", role: "You are", counterparty: "With", milestone: "Milestone", amount: "Amount", status: "Status", deadline: "Deadline",
  daysLate: "Days late", penalty: "Penalty", paid: "Paid", returned: "Returned", held: "Held", verifier: "Checked by", outcome: "Verdict",
  confidence: "Confidence", decidedBy: "Decided by", disputed: "Disputed", rulingPercent: "Ruling %", submissions: "Submissions",
};
const MONEY = new Set(["amount", "penalty", "paid", "returned", "held", "total"]);
const DEFAULT_VIEW: View = { columns: ["contract", "milestone", "counterparty", "amount", "status", "held", "paid", "decidedBy"], filters: [] };
const SUGGESTIONS = ["Which milestones are late?", "How much is still held, and for whom?", "Where was the verifier least sure?", "Show every dispute and how it was ruled"];

function pairs() {
  return Object.entries(keyring.all()).flatMap(([id, k]) => (k.payer ? [{ id, key: k.payer }] : k.payee ? [{ id, key: k.payee }] : []));
}

export function Dashboard() {
  const toast = useToast();
  const cfg = useContext(ConfigCtx);
  const [data, setData] = useState<Portfolio | null>(null);
  const [tab, setTab] = useState<"milestones" | "ledger" | "contracts" | "timeline">("milestones");
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ text: string; engine: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [gridFailed, setGridFailed] = useState(false);
  const [studio, setStudio] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  const grid = useRef<any>(null);

  async function load() {
    const res = await fetch("/api/portfolio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pairs: pairs() }) });
    setData(await res.json());
  }
  useEffect(() => {
    load();
  }, []);

  const rows = data && tab !== "timeline" ? data[tab] : [];
  const columns = useMemo(() => {
    if (tab === "milestones") return view.columns;
    if (tab === "ledger") return ["at", "contract", "milestone", "type", "amount", "status", "reference"];
    return ["contract", "role", "status", "total", "held", "paid", "returned", "milestones"];
  }, [tab, view]);

  // (Re)build the grid when the data, tab or AI view changes.
  useEffect(() => {
    if (!data || !el.current || tab === "timeline") return;
    let alive = true;
    loadAgGrid()
      .then((ag) => {
        if (!alive || !el.current) return;
        grid.current?.destroy?.();
        const theme = covenantTheme(ag);
        grid.current = ag.createGrid(el.current, {
          ...(theme ? { theme } : {}),
          rowData: rows,
          animateRows: true,
          pagination: rows.length > 50,
          paginationPageSize: 50,
          defaultColDef: { sortable: true, resizable: true, filter: true, floatingFilter: false, minWidth: 90, flex: 1 },
          columnDefs: columns.map((f) => ({
            field: f,
            headerName: LABEL[f] ?? (f === "at" ? "Time" : f === "total" ? "Total" : f === "type" ? "Event" : f === "reference" ? "PayPal reference" : f === "milestones" ? "Milestones" : f),
            ...(MONEY.has(f) ? { type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p: any) => (p.value ? usd(p.value) : "—") } : {}),
            ...(["daysLate", "confidence", "rulingPercent", "submissions"].includes(f) ? { filter: "agNumberColumnFilter", type: "rightAligned" } : {}),
            ...(f === "disputed" ? { filterValueGetter: (p: any) => String(p.data.disputed), valueFormatter: (p: any) => (p.value ? "Yes" : "") } : {}),
            ...(f === "at" ? { valueFormatter: (p: any) => (p.value ? when(p.value) : "—") } : {}),
            ...(f === "deadline" ? { valueFormatter: (p: any) => (p.value ? day(p.value, true) : "—") } : {}),
            ...(f === "confidence" ? { valueFormatter: (p: any) => (p.value == null ? "—" : `${p.value}%`) } : {}),
            ...(f === "contract" || f === "milestone" ? { minWidth: 170, flex: 1.6 } : {}),
            ...(view.sort?.field === f && tab === "milestones" ? { sort: view.sort.dir } : {}),
            ...(f === "at" && tab === "ledger" ? { sort: "desc" } : {}),
          })),
        });
        if (tab === "milestones" && view.filters.length) grid.current.setFilterModel(toFilterModel(view.filters));
      })
      .catch(() => alive && setGridFailed(true));
    return () => {
      alive = false;
    };
  }, [data, tab, view]);

  useEffect(() => () => grid.current?.destroy?.(), []);

  async function ask(q = question) {
    if (!q.trim() || asking) return;
    setQuestion(q);
    setAsking(true);
    try {
      const res = await fetch("/api/portfolio/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pairs: pairs(), question: q }) });
      const r = await res.json();
      setTab("milestones");
      setView(r.view);
      setAnswer({ text: r.answer, engine: r.engine === "claude" ? `Claude (${r.model})` : "rules engine" });
    } catch {
      toast("Couldn't answer that right now.", true);
    } finally {
      setAsking(false);
    }
  }

  async function seed() {
    setSeeding(true);
    try {
      const res = await fetch("/api/demo/seed", { method: "POST" });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error);
      for (const c of r.contracts as { id: string; keys: { payer: string; payee: string } }[]) {
        keyring.set(c.id, "payer", c.keys.payer);
        keyring.set(c.id, "payee", c.keys.payee);
      }
      await load();
      toast(`Added ${r.contracts.length} sample contracts.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't add samples.", true);
    } finally {
      setSeeding(false);
    }
  }

  if (!data) return <p className="muted" style={{ marginTop: 40 }}>Loading your contracts…</p>;
  const k = data.kpis;

  return (
    <main>
      <section className="dash-head">
        <div>
          <h1 className="page-title">Your money, across every contract</h1>
          <p className="muted">Everything Covenant holds, pays and returns for you on PayPal, in one place.</p>
        </div>
        <div className="dash-actions">
          <button className="btn ghost small" onClick={seed} disabled={seeding}>{seeding ? "Adding…" : "Add sample contracts"}</button>
          <button className="btn ghost small" onClick={() => setStudio(true)} disabled={!data.milestones.length}>Build a report in AG Studio</button>
        </div>
      </section>

      <section className="kpis" aria-label="Totals">
        <div className="kpi held"><span>Held by PayPal</span><b>{usd(k.held)}</b></div>
        <div className="kpi released"><span>Paid out</span><b>{usd(k.paid)}</b></div>
        <div className="kpi"><span>Returned to clients</span><b>{usd(k.returned)}</b></div>
        <div className="kpi"><span>Late penalties withheld</span><b>{usd(k.penalties)}</b></div>
        <div className="kpi"><span>Settled without a human</span><b>{k.autoPaidShare}%</b></div>
        <div className="kpi"><span>Disputes</span><b>{k.disputes}</b></div>
      </section>

      <section className="ask panel" aria-label="Ask about your money">
        <form
          className="ask-row"
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
        >
          <label htmlFor="ask" style={{ position: "absolute", left: -9999 }}>Ask a question about your contracts</label>
          <input id="ask" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask anything about your contracts, e.g. which milestones are late?" />
          <button className="btn" disabled={asking || !question.trim()}>{asking ? "Thinking…" : "Ask"}</button>
        </form>
        <div className="examples" style={{ marginTop: 10 }}>
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" type="button" onClick={() => ask(s)} disabled={asking}>{s}</button>
          ))}
        </div>
        {answer && (
          <div className="answer" role="status">
            <p>{answer.text}</p>
            <span className="faint">Answered by {answer.engine}. The grid below now shows the rows behind this answer.</span>{" "}
            <button className="linkbtn" onClick={() => { setView(DEFAULT_VIEW); setAnswer(null); }}>Reset view</button>
          </div>
        )}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="seg" role="tablist" aria-label="Data">
          {(["milestones", "timeline", "ledger", "contracts"] as const).map((t) => (
            <button key={t} role="tab" aria-pressed={tab === t} aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === "milestones" ? `Milestones (${data.milestones.length})` : t === "timeline" ? "Timeline" : t === "ledger" ? `PayPal ledger (${data.ledger.length})` : `Contracts (${data.contracts.length})`}
            </button>
          ))}
        </div>
        {data.milestones.length === 0 ? (
          <p className="muted" style={{ marginTop: 16 }}>
            No contracts on this device yet. <Link to="/">Write one</Link>, or add sample contracts to explore the dashboard.
          </p>
        ) : tab === "timeline" ? (
          <Timeline contracts={data.contracts as any} milestones={data.milestones as any} />
        ) : gridFailed ? (
          <FallbackTable rows={tab === "milestones" ? applyView(rows, view) : rows} columns={columns} />
        ) : (
          <div ref={el} className="dash-grid" />
        )}
      </section>

      {studio && <StudioPanel data={data} licence={cfg?.agStudioLicense} onClose={() => setStudio(false)} />}
    </main>
  );
}

/** Same filtering/sorting the grid applies, for the no-CDN fallback table. */
function applyView(rows: Record<string, any>[], v: View) {
  const pass = (r: Record<string, any>) =>
    v.filters.every((f) => {
      const x = r[f.field];
      switch (f.op) {
        case "isTrue": return x === true;
        case "isFalse": return x === false;
        case "greaterThan": return Number(x) > Number(f.value);
        case "lessThan": return Number(x) < Number(f.value);
        case "notEqual": return String(x ?? "") !== String(f.value ?? "");
        case "contains": return String(x ?? "").toLowerCase().includes(String(f.value ?? "").toLowerCase());
        default: return String(x ?? "") === String(f.value ?? "");
      }
    });
  const out = rows.filter(pass);
  if (v.sort) {
    const { field, dir } = v.sort;
    out.sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (dir === "asc" ? 1 : -1));
  }
  return out;
}

function FallbackTable({ rows, columns }: { rows: Record<string, any>[]; columns: string[] }) {
  return (
    <div style={{ overflowX: "auto", marginTop: 12 }}>
      <table className="fallback">
        <thead><tr>{columns.map((c) => <th key={c}>{LABEL[c] ?? c}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, 200).map((r, i) => (
            <tr key={i}>{columns.map((c) => <td key={c} className={MONEY.has(c) ? "num" : ""}>{MONEY.has(c) ? usd(r[c] ?? 0) : c === "at" ? (r[c] ? when(r[c]) : "—") : c === "deadline" ? (r[c] ? day(r[c], true) : "—") : c === "disputed" ? (r[c] ? "Yes" : "") : String(r[c] ?? "")}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STUDIO_SRC = "https://cdn.jsdelivr.net/npm/ag-studio@3.0.0/dist/ag-studio.min.js";

/** AG Studio: drag-and-drop reports over the same three data sources. */
function StudioPanel({ data, licence, onClose }: { data: Portfolio; licence?: string; onClose: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let api: any;
    loadScript(STUDIO_SRC)
      .then(() => {
        const s = (window as any).agStudio;
        if (!s?.createStudio || !el.current) throw new Error("AG Studio didn't load");
        if (licence) s.AgStudioLicenseManager?.setLicenseKey?.(licence);
        api = s.createStudio(el.current, {
          data: {
            sources: [
              { id: "milestones", data: data.milestones.map(({ contractId, ...r }) => (void contractId, r)) },
              { id: "ledger", data: data.ledger },
              { id: "contracts", data: data.contracts.map(({ contractId, ...r }) => (void contractId, r)) },
            ],
          },
          mode: "edit",
        });
      })
      .catch((e) => setErr(e.message));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      api?.destroy?.();
    };
  }, []);
  return (
    <div className="studio-overlay" role="dialog" aria-modal="true" aria-label="AG Studio report builder">
      <div className="studio-bar">
        <b>Report builder</b>
        <span className="faint">Drag fields from milestones, ledger or contracts to build charts and tables. Powered by AG Studio.</span>
        <button className="btn ghost small" onClick={onClose}>Close</button>
      </div>
      {err ? <p className="muted" style={{ padding: 24 }}>Couldn't load AG Studio ({err}). Check your connection and try again.</p> : <div ref={el} className="studio-host" />}
    </div>
  );
}
