import { useEffect, useRef, useState } from "react";
import { day, loadFirst, money } from "../api.ts";

// Bryntum Gantt (trial build, public npm) loaded by script tag. Namespace: bryntum.gantt
const BRYNTUM_SOURCES = ["/vendor/@bryntum/gantt-trial", "https://cdn.jsdelivr.net/npm/@bryntum/gantt-trial@7.2.2", "https://unpkg.com/@bryntum/gantt-trial@7.2.2"];
const THEMES = ["gantt.stockholm.css", "gantt.css", "stockholm-light.css"];

type MRow = { contractId: string; contract: string; milestone: string; amount: number; status: string; deadline: string | null; paid: number; held: number };
type CRow = { contractId: string; contract: string; createdAt: string; status: string };

const COLOR: Record<string, string> = { released: "green", refunded: "gray", disputed: "red", needs_review: "orange", rejected: "red", open: "yellow", verifying: "orange" };
const DAY = 864e5;

function buildTasks(contracts: CRow[], milestones: MRow[]) {
  return contracts.map((c, ci) => {
    const ms = milestones.filter((m) => m.contractId === c.contractId);
    let cursor = new Date(c.createdAt).getTime();
    const children = ms.map((m, i) => {
      const end = m.deadline ? Math.max(new Date(m.deadline).getTime(), cursor + DAY) : cursor + 7 * DAY;
      const t = {
        id: `${ci}-${i}`,
        name: `${m.milestone} · ${money(Math.round(m.amount * 100))}`,
        startDate: new Date(cursor),
        endDate: new Date(end),
        manuallyScheduled: true,
        percentDone: m.status === "released" || m.status === "refunded" ? 100 : m.status === "open" ? 0 : 60,
        eventColor: COLOR[m.status] ?? "blue",
        status: m.status,
        held: m.held,
        paid: m.paid,
      };
      cursor = end;
      return t;
    });
    return { id: `c${ci}`, name: c.contract, expanded: true, manuallyScheduled: true, children };
  });
}

export function Timeline({ contracts, milestones }: { contracts: CRow[]; milestones: MRow[] }) {
  const el = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const tasks = buildTasks(contracts, milestones);

  useEffect(() => {
    let gantt: any;
    let alive = true;
    (async () => {
      try {
        // Script first (local npm copy, then CDNs); then a theme from the same source.
        const used = await loadFirst(BRYNTUM_SOURCES.map((b) => `${b}/gantt.umd.js`));
        const base = used.replace(/\/gantt\.umd\.js$/, "");
        for (const css of THEMES) {
          const ok = await new Promise<boolean>((res) => {
            const l = document.createElement("link");
            l.rel = "stylesheet";
            l.href = `${base}/${css}`;
            l.setAttribute("data-bryntum-theme", "");
            l.onload = () => res(true);
            l.onerror = () => (l.remove(), res(false));
            document.head.appendChild(l);
          });
          if (ok) break;
        }
        const B = (window as any).bryntum?.gantt;
        if (!alive || !B?.Gantt || !el.current) throw new Error("Bryntum unavailable");
        gantt = new B.Gantt({
          appendTo: el.current,
          height: 460,
          readOnly: true,
          viewPreset: "weekAndDayLetter",
          barMargin: 8,
          columns: [
            { type: "name", text: "Contract / milestone", width: 300 },
            { type: "enddate", text: "Deadline" },
            { text: "Status", field: "status", width: 110 },
          ],
          project: { tasksData: tasks },
          features: { taskMenu: false, taskEdit: false, cellEdit: false },
        });
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      gantt?.destroy?.();
    };
  }, [contracts.length, milestones.length]);

  if (failed) return <FallbackTimeline tasks={tasks} />;
  return <div ref={el} className="gantt-host" aria-label="Milestone timeline" />;
}

/** Plain timeline used when Bryntum can't load. */
function FallbackTimeline({ tasks }: { tasks: ReturnType<typeof buildTasks> }) {
  const all = tasks.flatMap((t) => t.children);
  if (!all.length) return null;
  const min = Math.min(...all.map((t) => t.startDate.getTime()));
  const max = Math.max(...all.map((t) => t.endDate.getTime()), Date.now() + DAY);
  const pos = (d: number) => `${((d - min) / (max - min)) * 100}%`;
  return (
    <div className="tl">
      {tasks.map((c) => (
        <div key={c.id} className="tl-group">
          <div className="tl-name">{c.name}</div>
          {c.children.map((t) => (
            <div key={t.id} className="tl-row">
              <span className="tl-label">{t.name}</span>
              <div className="tl-track">
                <span className="tl-now" style={{ left: pos(Date.now()) }} aria-hidden="true" />
                <span className={`tl-bar ${t.status}`} style={{ left: pos(t.startDate.getTime()), width: `calc(${pos(t.endDate.getTime())} - ${pos(t.startDate.getTime())})` }} title={`Due ${day(t.endDate.toISOString(), true)}`} />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
