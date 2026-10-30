import { useEffect, useState } from "react";
import { api, keyring } from "../api.ts";
import { Link, navigate } from "../app.tsx";

/** /join/:id#code — the freelancer claims their one-time invite. */
export function Join({ id }: { id: string }) {
  const [state, setState] = useState<"joining" | "client" | "error">("joining");
  const [error, setError] = useState("");

  useEffect(() => {
    const code = location.hash.slice(1);
    // Remove the code from the address bar and history straight away.
    history.replaceState(null, "", `/join/${id}`);
    const mine = keyring.get(id);
    if (mine.payee) return navigate(`/c/${id}`);
    if (mine.payer) return setState("client");
    if (!code) {
      setError("This invite link is incomplete. Copy the whole link from the message you were sent.");
      return setState("error");
    }
    api
      .join(id, code)
      .then(({ payeeKey }) => {
        keyring.set(id, "payee", payeeKey);
        navigate(`/c/${id}?fresh=1`);
      })
      .catch((e) => {
        setError(e.message);
        setState("error");
      });
  }, [id]);

  if (state === "client")
    return (
      <div className="panel action" style={{ marginTop: 24, maxWidth: 640 }}>
        <h2>This is your own invite link</h2>
        <p className="muted">
          You're the client on this contract, so this browser already has your access. Send the link to the freelancer. To try the freelancer's side yourself, open the link in a different browser or a private window.
        </p>
        <Link to={`/c/${id}`} className="btn ghost">Back to the contract</Link>
      </div>
    );
  if (state === "error")
    return (
      <div className="panel action warn" style={{ marginTop: 24, maxWidth: 640 }}>
        <h2>Can't open this invite</h2>
        <p className="muted">{error}</p>
      </div>
    );
  return <p className="muted" style={{ marginTop: 40 }}>Opening your invite…</p>;
}
