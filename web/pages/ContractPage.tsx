import { useEffect, useMemo, useState } from "react";
import { api, keyring, money, day, inviteLink, type ContractView } from "../api.ts";
import { Link, navigate, useToast } from "../app.tsx";
import { Guilloche } from "../components/Guilloche.tsx";
import { MilestoneCard } from "../components/Milestone.tsx";
import { PayPalFund } from "../components/PayPalFund.tsx";
import { Ledger } from "../components/Ledger.tsx";
import { Activity } from "../components/Activity.tsx";
import type { Role } from "../../shared/types.ts";

export function ContractPage({ id }: { id: string }) {
  const toast = useToast();
  const [c, setC] = useState<ContractView | null>(null);
  const [error, setError] = useState("");
  const [keys, setKeys] = useState(keyring.get(id));
  const params = new URLSearchParams(location.search);
  const fresh = params.get("fresh") === "1";
  // One browser normally holds one side's key. Both only exist for sample data.
  const [role, setRole] = useState<Role>(keys.payer ? "payer" : "payee");

  useEffect(() => {
    const k = keys[role] || keys.payer || keys.payee;
    if (!k) {
      setError("You don't have access to this contract in this browser. Open the link you were sent, or ask the other party to send a new invite.");
      return;
    }
    api.get(id, k).then(({ contract }) => setC(contract)).catch((e) => setError(e.message));
  }, [id]);

  // Live updates over SSE, authorized by a short-lived signed ticket (keys never go in URLs).
  useEffect(() => {
    const k = keys.payer || keys.payee;
    if (!k || !c) return;
    let es: EventSource | null = null;
    let closed = false;
    let retry: number | undefined;
    const open = async () => {
      try {
        const { ticket } = await api.ticket(id, k);
        if (closed) return;
        es = new EventSource(`/api/contracts/${id}/stream?ticket=${encodeURIComponent(ticket)}`);
        es.onmessage = (e) => {
          try {
            const next = JSON.parse(e.data) as ContractView;
            setC((prev) => (!prev || next.updatedAt >= prev.updatedAt ? next : prev));
          } catch {
            /* ignore malformed frame */
          }
        };
        es.onerror = () => {
          es?.close();
          if (!closed) retry = window.setTimeout(open, 3000); // fresh ticket on reconnect
        };
      } catch {
        if (!closed) retry = window.setTimeout(open, 5000);
      }
    };
    open();
    return () => {
      closed = true;
      es?.close();
      window.clearTimeout(retry);
    };
  }, [id, !!c, keys.payer, keys.payee]);

  const keyFor = (r: Role) => keys[r] ?? "";
  const meter = useMemo(() => {
    if (!c) return null;
    const released = c.milestones.reduce((a, m) => a + (m.settlement?.netCents ?? 0), 0);
    const returned = c.milestones.reduce((a, m) => a + (m.settlement ? m.settlement.grossCents - m.settlement.netCents : 0), 0);
    const funded = c.funding && ["authorized", "partially_captured", "captured", "voided"].includes(c.funding.status);
    const held = funded && c.status !== "cancelled" ? c.totalCents - released - returned : 0;
    const pending = c.totalCents - released - returned - held;
    return { released, returned, held, pending };
  }, [c]);

  if (error)
    return (
      <div className="panel action warn" style={{ marginTop: 24 }}>
        <h2>Can't open this contract</h2>
        <p className="muted">{error}</p>
        <Link to="/" className="btn ghost">Write a new contract</Link>
      </div>
    );
  if (!c || !meter) return <p className="muted" style={{ marginTop: 40 }}>Loading contract…</p>;

  const pct = (n: number) => `${(n / c.totalCents) * 100}%`;
  const stepIndex = { draft: 0, awaiting_funding: 1, active: 2, completed: 4, cancelled: 4 }[c.status] + (c.status === "active" && c.milestones.every((m) => ["released", "refunded"].includes(m.status)) ? 1 : 0);
  const steps = ["Both parties sign", "Client funds on PayPal", "Work is delivered and verified", "Milestones paid out", "Complete"];
  const both = Boolean(keys.payer && keys.payee);

  // Responses and live updates can arrive in either order; never replace newer state with older.
  const update = (next: ContractView) => setC((prev) => (!prev || next.updatedAt >= prev.updatedAt ? next : prev));
  async function act(path: string, body: unknown, done: string, asRole: Role = role) {
    try {
      update(await api.act(c!.id, keyFor(asRole), path, body));
      toast(done);
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.", true);
    }
  }

  return (
    <main className={fresh ? "reveal" : ""}>
      <div className="subbar">
        <Link to="/" className="linkbtn">All contracts</Link>
        {both && (
          <div className="seg" role="group" aria-label="Viewing as">
            {(["payer", "payee"] as Role[]).map((r) => (
              <button key={r} aria-pressed={role === r} onClick={() => setRole(r)}>
                {r === "payer" ? (c.payer.name === "Client" ? "Client" : `Client: ${c.payer.name}`) : c.payee.name === "Freelancer" ? "Freelancer" : `Freelancer: ${c.payee.name}`}
              </button>
            ))}
          </div>
        )}
      </div>

      <section className="note" aria-label="Contract">
        <Guilloche seed={c.id} />
        <div className="row">
          <div>
            <div className="serial">Covenant {c.id.replace("cov_", "").toUpperCase()}</div>
            <h1>{c.title}</h1>
            <div className="parties">
              <b>{c.payer.name}</b> pays <b>{c.payee.name}</b>
              {c.payee.email && <> at {c.payee.email}</>}
            </div>
          </div>
          <div className="denomination">
            <div className="amt">{money(c.totalCents, c.currency)}</div>
            <div className="cur">{c.milestones.length} milestone{c.milestones.length > 1 ? "s" : ""}, settled in {c.currency} through PayPal</div>
          </div>
        </div>
        <div className="meter">
          <div className="track" role="img" aria-label={`${money(meter.released)} paid, ${money(meter.held)} held, ${money(meter.returned)} returned, ${money(meter.pending)} not yet funded`}>
            <span className="bg-released" style={{ width: pct(meter.released) }} />
            <span className="bg-held" style={{ width: pct(meter.held) }} />
            <span className="bg-returned" style={{ width: pct(meter.returned) }} />
          </div>
          <div className="legend">
            <span><i className="sw bg-released" />Paid <b>{money(meter.released, c.currency)}</b></span>
            <span><i className="sw bg-held" />Held by PayPal <b>{money(meter.held, c.currency)}</b></span>
            {meter.returned > 0 && <span><i className="sw bg-returned" />Returned to client <b>{money(meter.returned, c.currency)}</b></span>}
            {meter.pending > 0 && <span><i className="sw bg-pending" />Not funded yet <b>{money(meter.pending, c.currency)}</b></span>}
          </div>
        </div>
      </section>

      {c.status !== "cancelled" && (
        <ol className="stepper" aria-label="Progress">
          {steps.map((s, i) => (
            <li key={s} className={i < stepIndex || c.status === "completed" ? "done" : i === stepIndex ? "now" : ""}>
              {s}
            </li>
          ))}
        </ol>
      )}

      <div className="layout">
        <div>
          <NextStep c={c} role={role} keyFor={keyFor} onChange={update} act={act} />

          <div className="panel" style={{ marginTop: 16 }}>
            <h2>The agreement</h2>
            <div className="prose">
              <p>{c.summary}</p>
            </div>
            <details className="source">
              <summary>Original words</summary>
              <blockquote>{c.sourceText}</blockquote>
            </details>
            {c.ambiguities.length > 0 && c.status === "draft" && (
              <>
                <h3>Worth settling before you sign</h3>
                <ul className="flags">{c.ambiguities.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </>
            )}
            {c.risks.length > 0 && c.status === "draft" && (
              <>
                <h3>Could cause a dispute</h3>
                <ul className="flags risk">{c.risks.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </>
            )}
            <p className="faint" style={{ marginTop: 12 }}>
              Compiled by {c.compiledBy.engine === "claude" ? `Claude (${c.compiledBy.model})` : "the offline rules engine"}. Money math, deadlines and penalties are enforced by code, not by the model.
            </p>
          </div>

          <h2 className="section-title" style={{ marginTop: 28 }}>Milestones</h2>
          {c.milestones.map((m) => (
            <MilestoneCard key={m.id} c={c} m={m} role={role} keyFor={keyFor} onChange={update} />
          ))}
        </div>

        <aside>
          {role === "payer" && c.status === "draft" && <InvitePanel c={c} payerKey={keyFor("payer")} onChange={update} />}
          <Activity c={c} />
        </aside>
      </div>

      <Ledger c={c} />

      {c.status !== "completed" && c.status !== "cancelled" && (role === "payee" || c.status !== "active") && (
        <p style={{ marginTop: 18 }}>
          <button
            className="linkbtn"
            onClick={() => {
              if (confirm(c.status === "active" ? "Cancel and release the client's PayPal hold? This can't be undone." : "Cancel this contract?")) act("/cancel", {}, "Contract cancelled.").then(() => navigate(`/c/${c.id}`));
            }}
          >
            {c.status === "active" ? "Walk away and release the client's hold" : "Cancel this contract"}
          </button>
        </p>
      )}
    </main>
  );
}

function NextStep({ c, role, keyFor, onChange, act }: { c: ContractView; role: Role; keyFor: (r: Role) => string; onChange: (c: ContractView) => void; act: (p: string, b: unknown, d: string, r?: Role) => Promise<void> }) {
  const me = role === "payer" ? c.payer : c.payee;
  const [name, setName] = useState(me.name);
  const [email, setEmail] = useState(me.email);
  const [threshold, setThreshold] = useState(Math.round(c.autoReleaseThreshold * 100));
  useEffect(() => {
    setName(me.name);
    setEmail(me.email);
  }, [role, c.status]);

  if (c.status === "draft") {
    const signed = Boolean(c.signatures[role]);
    const other = role === "payer" ? "payee" : "payer";
    const dirty = name !== me.name || email !== me.email || (role === "payer" && threshold !== Math.round(c.autoReleaseThreshold * 100));
    return (
      <div className="panel action">
        <h2>{signed ? `Waiting for ${role === "payer" ? c.payee.name : c.payer.name} to sign` : "Check the terms and sign"}</h2>
        <p className="muted" style={{ marginTop: -4 }}>
          {signed
            ? "You've signed. Editing anything below clears both signatures."
            : role === "payee"
              ? "Add the PayPal email you want to be paid at, then sign."
              : "Review the plain-English terms and milestones, confirm your details, then sign."}
        </p>
        <div className="two">
          <div className="field">
            <label htmlFor="nm">Your name</label>
            <input id="nm" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="em">{role === "payee" ? "PayPal email for payouts" : "Your email"}</label>
            <input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={role === "payee" ? "sb-xxxx@personal.example.com" : "you@example.com"} />
          </div>
        </div>
        {role === "payer" && (
          <div className="field">
            <label htmlFor="th">Release automatically when the verifier is at least {threshold}% sure. Below that, you decide.</label>
            <input id="th" type="range" min={50} max={99} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          </div>
        )}
        <div className="buttons">
          {dirty && (
            <button className="btn ghost" onClick={() => act("/draft", { [role]: { name, email }, ...(role === "payer" ? { autoReleaseThreshold: threshold / 100 } : {}) }, "Saved.")}>
              Save details
            </button>
          )}
          {!signed && (
            <button className="btn" disabled={dirty} onClick={() => act("/sign", {}, "Signed.")}>
              Sign as {role === "payer" ? "client" : "freelancer"}
            </button>
          )}
          {c.signatures[other] && <span className="faint">{other === "payer" ? c.payer.name : c.payee.name} signed {day(c.signatures[other]!)}</span>}
        </div>
      </div>
    );
  }

  if (c.status === "awaiting_funding") {
    if (role === "payee")
      return (
        <div className="panel action">
          <h2>Waiting for {c.payer.name} to fund</h2>
          <p className="muted">Once they approve on PayPal, {money(c.totalCents, c.currency)} is held for you and you can start submitting work.</p>
        </div>
      );
    return (
      <div className="panel action">
        <h2>Fund {money(c.totalCents, c.currency)} with PayPal</h2>
        <p className="muted" style={{ marginTop: -4 }}>
          PayPal holds the full amount. Each milestone is captured only when its conditions are verified, and whatever isn't earned is released back to you.
        </p>
        <PayPalFund c={c} payerKey={keyFor("payer")} onFunded={onChange} />
      </div>
    );
  }

  if (c.status === "active") {
    const waiting = c.milestones.filter((m) => m.status === "needs_review").length;
    const f = c.funding!;
    return (
      <div className={`panel action ${waiting && role === "payer" ? "warn" : ""}`}>
        <h2>
          {role === "payer"
            ? waiting
              ? `${waiting} milestone${waiting > 1 ? "s need" : " needs"} your review`
              : "Your money is held, not spent"
            : "Deliver the work below to get paid"}
        </h2>
        <p className="muted" style={{ marginTop: -4 }}>
          PayPal authorization {f.authorizationId} holds {money(c.milestones.filter((m) => !m.settlement).reduce((a, m) => a + m.amountCents, 0), c.currency)} for the remaining milestones
          {f.expiresAt ? `, valid until ${day(f.expiresAt)}` : ""}.{" "}
          {role === "payer" ? "Nothing leaves your account until a milestone is verified or you approve it." : "Each milestone pays out to your PayPal as soon as it's verified."}
        </p>
      </div>
    );
  }

  if (c.status === "completed") {
    const paid = c.milestones.reduce((a, m) => a + (m.settlement?.netCents ?? 0), 0);
    return (
      <div className="panel action ok">
        <h2>Complete</h2>
        <p className="muted">
          {c.payee.name} was paid {money(paid, c.currency)}; {money(c.totalCents - paid, c.currency)} stayed with {c.payer.name}. Every movement is in the PayPal ledger below.
        </p>
      </div>
    );
  }

  return (
    <div className="panel action warn">
      <h2>Cancelled</h2>
      <p className="muted">This contract was cancelled{c.funding?.status === "voided" ? " and the PayPal hold was released" : ""}.</p>
    </div>
  );
}


/** The client shares a one-time invite. Claiming it gives the freelancer their own key. */
function InvitePanel({ c, payerKey, onChange }: { c: ContractView; payerKey: string; onChange: (c: ContractView) => void }) {
  const toast = useToast();
  const [code, setCode] = useState(keyring.get(c.id).invite ?? "");
  const [busy, setBusy] = useState(false);
  const link = code ? inviteLink(c.id, code) : "";

  async function reissue() {
    if (c.access.joined && !confirm(`${c.payee.name} has already joined. A new invite removes their access until they open the new link. Continue?`)) return;
    setBusy(true);
    try {
      const r = await api.invite(c.id, payerKey);
      keyring.set(c.id, "invite", r.inviteCode);
      setCode(r.inviteCode);
      onChange(r.contract);
      toast("New invite link created. Earlier links no longer work.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't create an invite.", true);
    } finally {
      setBusy(false);
    }
  }

  if (c.access.joined) {
    return (
      <div className="panel">
        <h2>{c.payee.name} has joined</h2>
        <p className="faint" style={{ marginTop: -4 }}>They have their own access to this contract. Their invite link can't be used again.</p>
        {!c.signatures.payee && <button className="linkbtn" onClick={reissue} disabled={busy}>Invited the wrong person? Create a new invite</button>}
      </div>
    );
  }
  return (
    <div className="panel">
      <h2>Invite {c.payee.name === "Freelancer" ? "the freelancer" : c.payee.name}</h2>
      <p className="faint" style={{ marginTop: -4 }}>
        Send this one-time link. Opening it gives them their own access to sign, deliver work and get paid. To try both sides yourself, open it in a different browser or a private window.
      </p>
      {link ? (
        <div className="share">
          <input readOnly value={link} aria-label="Invite link" onFocus={(e) => e.target.select()} />
          <button className="btn ghost small" onClick={() => navigator.clipboard?.writeText(link).then(() => toast("Invite link copied."))}>Copy</button>
        </div>
      ) : (
        <button className="btn ghost small" onClick={reissue} disabled={busy}>Create invite link</button>
      )}
    </div>
  );
}
