import { useEffect, useState } from "react";
import { api, keyring, money, type ContractView } from "../api.ts";
import { Link, navigate, useToast } from "../app.tsx";
import { Guilloche } from "../components/Guilloche.tsx";

const EXAMPLES: { label: string; text: string }[] = [
  {
    label: "Logo design",
    text: "Pay Maya (maya.designs@example.com) $600 for a bakery logo: $200 when she shows 3 distinct concepts, $400 when the final logo is delivered as SVG and PNG files by Dec 20. If the final files are late, take 10% off per day, up to 50%.",
  },
  {
    label: "Website build",
    text: "Hire Priya to build our bakery website for $1,200: $300 when the homepage design is approved, $600 when the site is live at a public URL, and $300 when the GitHub pull request adding online ordering is merged by November 30.",
  },
  {
    label: "Translation",
    text: "Pay Tomás $180 to translate our 4-page onboarding guide from English to Spanish, delivered as a PDF by Nov 15. 5% off per day late.",
  },
  {
    label: "AI agent job",
    text: "Our research agent pays the data-cleaning agent $40 once it delivers a CSV with at least 500 deduplicated rows and a short written report of what was removed.",
  },
];

const STEPS = ["Reading the deal", "Finding milestones, conditions and deadlines", "Checking that the amounts add up", "Writing the plain-English version for both parties"];

export function Home() {
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<ContractView[]>([]);

  useEffect(() => {
    const all = keyring.all();
    Promise.all(
      Object.entries(all).map(([id, k]) =>
        api
          .get(id, (k.payer || k.payee)!)
          .then((r) => r.contract)
          .catch(() => null),
      ),
    ).then((list) => setMine(list.filter(Boolean).sort((a, b) => b!.createdAt.localeCompare(a!.createdAt)) as ContractView[]));
  }, []);

  async function compile() {
    if (busy) return;
    setBusy(true);
    try {
      const { contract, payerKey, inviteCode } = await api.compile(text);
      keyring.set(contract.id, "payer", payerKey);
      keyring.set(contract.id, "invite", inviteCode);
      navigate(`/c/${contract.id}?fresh=1`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't compile that deal.", true);
      setBusy(false);
    }
  }

  return (
    <main>
      <section className="hero">
        <h1>Write the deal in a sentence. PayPal holds the money. Claude checks the work.</h1>
        <p>
          Covenant turns a plain-English agreement into a contract that pays itself: funds are held on PayPal, the freelancer uploads proof, and each milestone releases the moment the evidence
          meets the terms you both signed.
        </p>
      </section>

      <div className="composer">
                <label htmlFor="deal" className="sr-only" style={{ position: "absolute", left: -9999 }}>
          Describe the deal
        </label>
        <textarea
          id="deal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) compile();
          }}
          placeholder="Pay Maya $600 for a logo: $200 when she shows 3 concepts, $400 when the final SVG and PNG files arrive by Dec 20…"
          disabled={busy}
        />
        <div className="bar">
          <div className="examples" aria-label="Examples">
            {EXAMPLES.map((ex) => (
              <button key={ex.label} className="chip" type="button" onClick={() => setText(ex.text)} disabled={busy}>
                {ex.label}
              </button>
            ))}
          </div>
          <button className="btn" onClick={compile} disabled={busy || text.trim().length < 12}>
            {busy ? "Compiling…" : "Compile contract"}
          </button>
        </div>
      </div>

      {busy && (
        <div className="compiling" aria-live="polite">
          {STEPS.map((s) => (
            <div key={s}>{s}…</div>
          ))}
        </div>
      )}

      <section className="how" aria-label="How it works">
        <div>
          <b><i>1</i>Describe</b>
          <span>Write the deal the way you'd text it. Claude turns it into milestones with checkable conditions.</span>
        </div>
        <div>
          <b><i>2</i>Sign and fund</b>
          <span>Both sides sign. The client approves a PayPal authorization, so the money is held, not sent.</span>
        </div>
        <div>
          <b><i>3</i>Deliver</b>
          <span>The freelancer uploads files, links or a GitHub PR. Claude checks each condition and explains why.</span>
        </div>
        <div>
          <b><i>4</i>Get paid</b>
          <span>Verified milestones are captured and paid out via PayPal Payouts. Disputes go to an AI arbiter.</span>
        </div>
      </section>

      {mine.length > 0 && (
        <>
          <h2 className="section-title">Your contracts</h2>
          <div className="mini-notes">
            {mine.map((c) => (
              <Link key={c.id} to={`/c/${c.id}`} className="mini">
                <Guilloche seed={c.id} width={520} height={160} opacity={0.4} dense={false} />
                <div className="t">{c.title}</div>
                <div className="a">{money(c.totalCents, c.currency)}</div>
                <div className="s">{c.payer.name} pays {c.payee.name}</div>
                <div className="s">{statusLabel(c.status)}</div>
              </Link>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

export function statusLabel(s: ContractView["status"]) {
  return { draft: "Waiting for signatures", awaiting_funding: "Waiting for funding", active: "In progress", completed: "Complete", cancelled: "Cancelled" }[s];
}
