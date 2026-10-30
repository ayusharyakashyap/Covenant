import { useEffect, useState } from "react";
import { api } from "../api.ts";

const Row = ({ name, ok, detail }: { name: string; ok: boolean; detail: string }) => (
  <li className="status-row">
    <span className={`dot ${ok ? "on" : "off"}`} aria-hidden="true" />
    <b>{name}</b>
    <span className="muted">{detail}</span>
  </li>
);

/** Plain-language view of which integrations this deployment is using. */
export function Status() {
  const [s, setS] = useState<Record<string, any> | null>(null);
  useEffect(() => {
    api.status().then(setS).catch(() => setS({ error: true }));
  }, []);
  if (!s) return <p className="muted" style={{ marginTop: 40 }}>Checking…</p>;
  if (s.error) return <p className="muted" style={{ marginTop: 40 }}>Couldn't reach the server.</p>;
  return (
    <main style={{ maxWidth: 760 }}>
      <h1 className="page-title" style={{ marginTop: 18 }}>System status</h1>
      <p className="muted">What this deployment is connected to right now.</p>
      <ul className="status-list panel">
        <Row name="Payments" ok={s.paypal.mode === "sandbox"} detail={s.paypal.mode === "sandbox" ? `PayPal sandbox${s.paypal.webhooks ? ", webhooks verified" : ""}` : "Test mode: PayPal is simulated until sandbox keys are configured"} />
        <Row name="Verification" ok={s.ai.engine === "claude"} detail={s.ai.engine === "claude" ? `Claude (${s.ai.model})` : `Rules engine. ${s.ai.reason}. It never pays out on its own.`} />
        <Row name="Website checks" ok={s.kernel} detail={s.kernel ? "Delivered websites open in Kernel cloud browsers" : "Links are fetched directly (no screenshots)"} />
        <Row name="Report builder" ok={s.agStudioLicensed} detail={s.agStudioLicensed ? "AG Studio licensed" : "AG Studio runs with a trial watermark"} />
        <Row name="Notifications" ok={s.notifications} detail={s.notifications ? "Webhook notifications on (e.g. Zapier)" : "No notification webhook configured"} />
        <Row name="Background jobs" ok detail={`${s.queueDepth} job${s.queueDepth === 1 ? "" : "s"} waiting`} />
      </ul>
    </main>
  );
}

const SAMPLES = [
  { file: "concept-1.png", what: "Logo concept: wheat sheaf" },
  { file: "concept-2.png", what: "Logo concept: rolling-pin monogram" },
  { file: "concept-3.png", what: "Logo concept: sunrise loaf" },
  { file: "brightside-final.svg", what: "Final logo, vector" },
  { file: "brightside-final.png", what: "Final logo, 1600px PNG" },
  { file: "handoff-notes.txt", what: "Handoff notes with a hidden instruction aimed at the AI" },
  { file: "onboarding-guide-es.pdf", what: "4-page onboarding guide, translated into Spanish" },
];

/** Downloadable files for trying the freelancer side with realistic deliverables. */
export function Samples() {
  return (
    <main style={{ maxWidth: 760 }}>
      <h1 className="page-title" style={{ marginTop: 18 }}>Sample files</h1>
      <p className="muted">Download these and upload them as the freelancer to see how verification behaves, including what happens when a file tries to instruct the AI.</p>
      <ul className="status-list panel">
        {SAMPLES.map((s) => (
          <li key={s.file} className="status-row">
            <a href={`/demo/${s.file}`} download>{s.file}</a>
            <span className="muted">{s.what}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
