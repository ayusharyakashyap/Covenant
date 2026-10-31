import { useEffect, useRef } from "react";
import { when, type ContractView } from "../api.ts";
import { engineLabel } from "../../shared/types.ts";

const INITIAL: Record<string, string> = { payer: "C", payee: "F", ai: "AI", paypal: "PP", system: "·" };

export function Activity({ c }: { c: ContractView }) {
  const seen = useRef(new Set(c.events.map((e) => e.id)));
  const items = c.events.slice().reverse();
  useEffect(() => {
    const t = setTimeout(() => items.forEach((e) => seen.current.add(e.id)), 1800);
    return () => clearTimeout(t);
  });
  const label = (a: string) => (a === "payer" ? c.payer.name : a === "payee" ? c.payee.name : a === "ai" ? engineLabel(c.compiledBy.engine) : a === "paypal" ? "PayPal" : "Covenant");
  return (
    <div className="panel">
      <h2>Activity</h2>
      <ul className="feed" aria-live="polite">
        {items.map((e) => (
          <li key={e.id} className={seen.current.has(e.id) ? "" : "fresh"}>
            <span className={`avatar ${e.actor}`} aria-hidden="true">
              {INITIAL[e.actor]}
            </span>
            <div>
              <b style={{ fontSize: 13 }}>{label(e.actor)}</b>
              <div>{e.message}</div>
              <time dateTime={e.at}>{when(e.at)}</time>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
