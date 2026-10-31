import { useEffect, useRef, useState } from "react";
import { money, when, type ContractView } from "../api.ts";
import { loadAgGrid } from "./grid.ts";

declare global {
  interface Window {
    agGrid?: any;
  }
}


const TYPE_LABEL: Record<string, string> = {
  authorization: "Hold placed",
  capture: "Captured",
  payout: "Paid out",
  refund: "Refunded",
  void: "Hold released",
  penalty: "Late penalty",
  reauthorization: "Re-authorized",
};

/** Money ledger rendered with AG Grid (community), with a plain table fallback. */
export function Ledger({ c }: { c: ContractView }) {
  const el = useRef<HTMLDivElement>(null);
  const grid = useRef<any>(null);
  const [fallback, setFallback] = useState(false);

  const milestoneName = (id?: string) => (id ? c.milestones.find((m) => m.id === id)?.title ?? "" : "Contract");
  const rows = c.ledger
    .slice()
    .reverse()
    .map((l) => ({
      at: l.at,
      type: TYPE_LABEL[l.type] ?? l.type,
      milestone: milestoneName(l.milestoneId),
      amount: l.amountCents / 100,
      status: l.status,
      reference: l.reference,
      note: l.note,
      simulated: l.simulated,
    }));

  useEffect(() => {
    let alive = true;
    loadAgGrid()
      .then(() => {
        if (!alive || !el.current || !window.agGrid) throw new Error("AG Grid unavailable");
        const ag = window.agGrid;
        const dark = matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light";
        const theme = ag.themeQuartz?.withParams?.({
          fontFamily: "Archivo, system-ui, sans-serif",
          headerFontWeight: 600,
          accentColor: dark ? "#e0ad4f" : "#a8761b",
          backgroundColor: dark ? "#16203a" : "#f7f8f5",
          foregroundColor: dark ? "#e6eaf2" : "#16233f",
          borderColor: dark ? "#2b3754" : "#c3cdc6",
          headerBackgroundColor: dark ? "#0b1222" : "#e2e7e1",
          oddRowBackgroundColor: dark ? "#131c33" : "#f2f4f0",
          wrapperBorderRadius: 12,
          fontSize: 13.5,
        });
        grid.current = ag.createGrid(el.current, {
          ...(theme ? { theme } : {}),
          rowData: rows,
          animateRows: true,
          domLayout: "normal",
          defaultColDef: { sortable: true, resizable: true, filter: true },
          columnDefs: [
            { field: "at", headerName: "Time", width: 150, valueFormatter: (p: any) => when(p.value), sort: "desc" },
            { field: "type", headerName: "Event", width: 140 },
            { field: "milestone", headerName: "Milestone", flex: 1, minWidth: 140 },
            {
              field: "amount",
              headerName: "Amount",
              width: 120,
              type: "rightAligned",
              valueFormatter: (p: any) => money(Math.round(p.value * 100), c.currency),
              cellStyle: (p: any) => (p.data.type === "Paid out" || p.data.type === "Captured" ? { fontWeight: 650 } : null),
            },
            { field: "status", headerName: "PayPal status", width: 140 },
            { field: "reference", headerName: "PayPal reference", width: 210, cellStyle: { fontSize: "12px" } },
            { field: "note", headerName: "Note", flex: 1.4, minWidth: 200 },
          ],
        });
      })
      .catch(() => alive && setFallback(true));
    return () => {
      alive = false;
      grid.current?.destroy?.();
      grid.current = null;
    };
  }, []);

  useEffect(() => {
    grid.current?.setGridOption?.("rowData", rows);
  }, [c.ledger.length, c.ledger.map((l) => l.status).join()]);

  return (
    <section className="ledger-wrap" aria-label="PayPal ledger">
      <div className="panel">
        <h2>PayPal ledger</h2>
        <p className="faint" style={{ marginTop: -4 }}>
          Every hold, capture and payout, with the PayPal reference you can look up in the sandbox dashboard.
          {c.ledger.some((l) => l.simulated) && " Rows from the simulator are marked with SIM- references."}
        </p>
        {rows.length === 0 ? (
          <p className="muted">Nothing has moved yet. The first row appears when the client funds the contract.</p>
        ) : fallback ? (
          <div style={{ overflowX: "auto" }}>
            <table className="fallback">
              <thead>
                <tr><th>Time</th><th>Event</th><th>Milestone</th><th>Amount</th><th>Status</th><th>Reference</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{when(r.at)}</td><td>{r.type}</td><td>{r.milestone}</td>
                    <td className="num">{money(Math.round(r.amount * 100), c.currency)}</td><td>{r.status}</td><td style={{ fontSize: 12 }}>{r.reference}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <div ref={el} className="ledger-grid" style={{ display: rows.length && !fallback ? "block" : "none" }} />
      </div>
    </section>
  );
}
