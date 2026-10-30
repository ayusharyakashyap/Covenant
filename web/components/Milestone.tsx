import { useState } from "react";
import { api, day, money, type ContractView } from "../api.ts";
import { useToast } from "../app.tsx";
import { EvidenceForm } from "./EvidenceForm.tsx";
import type { Milestone as M, Role } from "../../shared/types.ts";

const STATUS: Record<M["status"], string> = {
  open: "Waiting for work",
  verifying: "Claude is checking",
  needs_review: "Needs the client's review",
  rejected: "Conditions not met",
  disputed: "In dispute",
  released: "Paid",
  refunded: "Returned to client",
};

const KIND: Record<string, string> = { image: "image", file: "file", link: "link", github_pr: "GitHub PR", text: "written note", approval: "client approval" };

function deadlineText(m: M) {
  if (!m.deadline) return null;
  const ms = new Date(m.deadline).getTime() - Date.now();
  const days = Math.ceil(Math.abs(ms) / 864e5);
  if (["released", "refunded"].includes(m.status)) return `Due ${day(m.deadline, true)}`;
  return ms >= 0 ? `Due ${day(m.deadline, true)} (${days} day${days === 1 ? "" : "s"} left)` : `Was due ${day(m.deadline, true)} (${days} day${days === 1 ? "" : "s"} ago)`;
}

export function MilestoneCard({ c, m, role, keyFor, onChange }: { c: ContractView; m: M; role: Role; keyFor: (r: Role) => string; onChange: (c: ContractView) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [showDispute, setShowDispute] = useState(false);
  const key = keyFor(role);
  const funded = c.status === "active";
  const verdict = m.verdict;
  const last = m.submissions.at(-1);
  const engineName = verdict?.engine === "claude" ? "Claude" : "Rules engine";

  async function act(label: string, path: string, body: unknown = {}, done?: string) {
    setBusy(label);
    try {
      const next = await api.act(c.id, key, `/milestones/${m.id}${path}`, body);
      onChange(next);
      if (done) toast(done);
      setText("");
      setShowDispute(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.", true);
    } finally {
      setBusy(null);
    }
  }

  const tone = m.status === "released" ? "released" : ["needs_review", "rejected", "disputed"].includes(m.status) ? "alert" : funded ? "held" : "";
  const pastDue = m.deadline && new Date(m.deadline).getTime() < Date.now();

  return (
    <article className={`milestone ${tone}`} aria-labelledby={`ms-${m.id}`}>
      <span className="idx" aria-hidden="true">{m.index + 1}</span>
      <div className="head">
        <div>
          <div className="title" id={`ms-${m.id}`}>{m.title}</div>
          <div className="sub">
            {deadlineText(m) && <span>{deadlineText(m)}</span>}
            {m.latePenalty && <span>{m.latePenalty.percentPerDay}% off per day late, up to {m.latePenalty.maxPercent}%</span>}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="amount">{money(m.amountCents, c.currency)}</div>
          <span className={`status ${m.status}`}>{busy === "submit" ? STATUS.verifying : STATUS[m.status]}</span>
        </div>
      </div>

      <ul className="conds">
        {m.conditions.map((cond) => {
          const f = verdict?.findings.find((x) => x.conditionId === cond.id);
          return (
            <li key={cond.id}>
              <span className={`tick ${f ? (f.met ? "yes" : "no") : ""}`} aria-label={f ? (f.met ? "Met" : "Not met") : "Not checked yet"}>
                {f ? (f.met ? "✓" : "×") : ""}
              </span>
              <div>
                {cond.text}
                <span className="kind">{KIND[cond.kind]}</span>
                {f && <span className="conf">{Math.round(f.confidence * 100)}% sure</span>}
                {f && <span className="reason">{f.reasoning}</span>}
              </div>
            </li>
          );
        })}
      </ul>

      {last && last.items.length > 0 && (
        <div className="evidence" aria-label="Submitted evidence">
          {last.items.map((i) =>
            i.kind === "image" && i.url ? (
              <a key={i.id} href={i.url} target="_blank" rel="noreferrer">
                <img src={i.url} alt="" />
                <span className="nm">{i.name}</span>
              </a>
            ) : i.kind === "link" ? (
              <a key={i.id} href={i.url} target="_blank" rel="noreferrer noopener">
                <span className="ico">{(i.facts as any)?.source === "GitHub API" ? "PR" : (i.facts as any)?.source === "Kernel cloud browser" ? "LIVE" : "URL"}</span>
                <span className="nm">
                  {i.name}
                  {(i.facts as any)?.merged !== undefined && <span className="reason">{(i.facts as any).merged ? "merged" : "not merged"}</span>}
                  {(i.facts as any)?.source === "Kernel cloud browser" && (
                    <span className="reason">
                      Opened in a cloud browser{(i.facts as any).consoleErrors?.length ? `, ${(i.facts as any).consoleErrors.length} page error${(i.facts as any).consoleErrors.length > 1 ? "s" : ""}` : ""}
                    </span>
                  )}
                </span>
              </a>
            ) : i.url ? (
              <a key={i.id} href={i.url} target="_blank" rel="noreferrer">
                <span className="ico">{i.name.split(".").pop()?.toUpperCase().slice(0, 4)}</span>
                <span className="nm">{i.name}</span>
              </a>
            ) : (
              <span key={i.id} className="item" title={i.excerpt}>
                <span className="ico">TXT</span>
                <span className="nm">{i.excerpt?.slice(0, 60)}</span>
              </span>
            ),
          )}
        </div>
      )}

      {(busy === "submit" || m.status === "verifying") && (
        <div className="thinking" role="status">
          <span className="dots" aria-hidden="true"><i /><i /><i /></span>
          {c.compiledBy.engine === "claude" ? "Claude is checking each condition against the evidence" : "Checking each condition against the evidence"}
        </div>
      )}

      {verdict && m.status !== "verifying" && (
        <div className={`verdict ${verdict.outcome}`}>
          <div className="who">
            {engineName}
            {verdict.model ? ` (${verdict.model})` : ""} · lowest confidence {Math.round(verdict.confidence * 100)}% · release threshold {Math.round(c.autoReleaseThreshold * 100)}%
          </div>
          {verdict.summary}
          {c.events.some((e) => e.type === "injection_blocked" && e.milestoneId === m.id && new Date(e.at) >= new Date(verdict.at)) && (
            <div className="shield">
              The evidence contained instructions aimed at the verifier. They were ignored, and the milestone was held for a human decision instead of paying out automatically.
            </div>
          )}
        </div>
      )}

      {m.settlement && (
        <>
          <div className="settle">
            <div><span>Milestone</span><b>{money(m.settlement.grossCents, c.currency)}</b></div>
            {m.settlement.penaltyCents > 0 && <div><span>Late penalty ({m.settlement.daysLate}d)</span><b>−{money(m.settlement.penaltyCents, c.currency)}</b></div>}
            {m.settlement.arbiterAdjustCents > 0 && <div><span>Returned by ruling</span><b>−{money(m.settlement.arbiterAdjustCents, c.currency)}</b></div>}
            <div className="net"><span>Paid to {c.payee.name}</span><b>{money(m.settlement.netCents, c.currency)}</b></div>
          </div>
          {(m.settlement.captureId || m.settlement.payoutBatchId) && (
            <div className="refs">
              {m.settlement.captureId && <>Capture {m.settlement.captureId} </>}
              {m.settlement.payoutBatchId && <>· Payout batch {m.settlement.payoutBatchId} ({m.settlement.payoutStatus})</>}
            </div>
          )}
          {m.settlement.payoutStatus === "FAILED" && (
            <button className="btn ghost small" style={{ marginTop: 10 }} disabled={!!busy} onClick={() => act("retry", "/retry-payout", {}, "Payout sent again.")}>
              Retry payout
            </button>
          )}
        </>
      )}

      {m.dispute && (
        <div className="dispute">
          <b>Dispute opened by {m.dispute.openedBy === "payer" ? c.payer.name : c.payee.name}</b>
          {m.dispute.statements.map((s, i) => (
            <div key={i} className="stmt">
              <b>{s.role === "payer" ? c.payer.name : c.payee.name}</b>
              <div>{s.text}</div>
            </div>
          ))}
          {m.dispute.ruling ? (
            <div className="ruling">
              <div className="pct">{m.dispute.ruling.payeePercent}% to {c.payee.name}</div>
              <div>{m.dispute.ruling.reasoning}</div>
              {m.dispute.ruling.citations.length > 0 && (
                <ul className="faint" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  {m.dispute.ruling.citations.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              )}
            </div>
          ) : (
            m.status === "disputed" && (
              <>
                {!m.dispute.statements.some((s) => s.role === role) && (
                  <div className="field">
                    <label htmlFor={`st-${m.id}`}>Your side</label>
                    <textarea id={`st-${m.id}`} value={text} onChange={(e) => setText(e.target.value)} />
                  </div>
                )}
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                  {!m.dispute.statements.some((s) => s.role === role) && (
                    <button className="btn ghost small" disabled={!text.trim() || !!busy} onClick={() => act("stmt", "/statement", { text }, "Statement added.")}>
                      Add statement
                    </button>
                  )}
                  <button className="btn small" disabled={!!busy} onClick={() => act("resolve", "/resolve", {}, "The arbiter has ruled.")}>
                    {busy === "resolve" ? "Weighing both sides…" : "Ask the arbiter to rule"}
                  </button>
                </div>
                <p className="faint">The ruling is binding and moves money immediately. It's best to wait until both sides have written a statement.</p>
              </>
            )
          )}
        </div>
      )}

      {/* ---- role-specific actions */}
      {funded && role === "payee" && ["open", "rejected"].includes(m.status) && busy !== "submit" && (
        <EvidenceForm busy={busy === "submit"} onSubmit={(input) => act("submit", "/evidence", input)} />
      )}

      {funded && role === "payer" && ["needs_review", "rejected"].includes(m.status) && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
          <button className="btn go" disabled={!!busy} onClick={() => act("approve", "/review", { decision: "approve" }, "Approved. Payment is on its way.")}>
            Approve and pay {money(m.amountCents, c.currency)}
          </button>
          {m.status === "needs_review" && (
            <button className="btn ghost" disabled={!!busy} onClick={() => act("reject", "/review", { decision: "reject" }, "Sent back to the freelancer.")}>
              Send back
            </button>
          )}
          <button className="btn danger" disabled={!!busy} onClick={() => setShowDispute(!showDispute)}>
            Open a dispute
          </button>
        </div>
      )}

      {funded && role === "payee" && m.status === "rejected" && busy !== "submit" && (
        <div style={{ marginTop: 10 }}>
          <button className="linkbtn" onClick={() => setShowDispute(!showDispute)}>
            Disagree with this result? Open a dispute
          </button>
        </div>
      )}

      {funded && role === "payee" && m.status === "needs_review" && <p className="faint" style={{ marginTop: 12 }}>Waiting for {c.payer.name} to review.</p>}

      {funded && role === "payer" && m.status === "open" && !m.submissions.length && pastDue && (
        <div style={{ marginTop: 14 }}>
          <button className="btn ghost small" disabled={!!busy} onClick={() => act("reclaim", "/reclaim", {}, "Milestone reclaimed.")}>
            Reclaim {money(m.amountCents, c.currency)}. The deadline passed with no delivery
          </button>
        </div>
      )}

      {showDispute && (
        <div className="dispute">
          <div className="field">
            <label htmlFor={`d-${m.id}`}>What do you disagree with?</label>
            <textarea id={`d-${m.id}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Be specific: which condition, and why the evidence does or doesn't meet it." />
          </div>
          <button className="btn danger small" disabled={!text.trim() || !!busy} onClick={() => act("dispute", "/dispute", { reason: text }, "Dispute opened.")}>
            Open dispute
          </button>
        </div>
      )}
    </article>
  );
}
