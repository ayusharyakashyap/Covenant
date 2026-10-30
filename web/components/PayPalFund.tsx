import { useContext, useEffect, useRef, useState } from "react";
import { api, loadScript, money, type ContractView } from "../api.ts";
import { ConfigCtx, useToast } from "../app.tsx";

declare global {
  interface Window {
    paypal?: any;
  }
}

/**
 * Funds a contract with a PayPal authorization (Orders v2, intent=AUTHORIZE).
 * The buyer approves in the PayPal sandbox; the server authorizes, which places a hold
 * that Covenant later captures milestone by milestone.
 */
export function PayPalFund({ c, payerKey, onFunded }: { c: ContractView; payerKey: string; onFunded: (c: ContractView) => void }) {
  const cfg = useContext(ConfigCtx);
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "busy">("loading");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!cfg || cfg.paypal.mode !== "sandbox" || !cfg.paypal.clientId) {
      setState("ready");
      return;
    }
    let cancelled = false;
    const src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.paypal.clientId)}&currency=${cfg.paypal.currency}&intent=authorize&components=buttons&disable-funding=paylater,venmo,card`;
    loadScript(src, { "data-namespace": "paypal" })
      .then(() => {
        if (cancelled || !ref.current || !window.paypal) return;
        ref.current.innerHTML = "";
        window.paypal
          .Buttons({
            style: { layout: "vertical", shape: "rect", label: "pay", height: 44 },
            createOrder: async () => (await api.order(c.id, payerKey)).orderId,
            onApprove: async (data: { orderID: string }) => {
              setState("busy");
              try {
                const next = await api.act(c.id, payerKey, "/paypal/authorize", { orderId: data.orderID }, `authorize-${data.orderID}`);
                onFunded(next);
                toast(`${money(c.totalCents, c.currency)} is now held by PayPal.`);
              } catch (e) {
                toast(e instanceof Error ? e.message : "Authorization failed.", true);
                setState("ready");
              }
            },
            onCancel: () => toast("PayPal window closed. Nothing was charged."),
            onError: (e: unknown) => {
              console.error(e);
              toast("PayPal reported an error. Check the sandbox buyer account and try again.", true);
            },
          })
          .render(ref.current);
        setState("ready");
      })
      .catch((e) => {
        setErr(e.message);
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [cfg?.paypal.mode, cfg?.paypal.clientId, c.id]);

  async function simulate() {
    setState("busy");
    try {
      const { orderId } = await api.order(c.id, payerKey);
      const next = await api.act(c.id, payerKey, "/paypal/authorize", { orderId }, `authorize-${orderId}`);
      onFunded(next);
      toast(`${money(c.totalCents, c.currency)} is now held (simulated).`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't fund the contract.", true);
      setState("ready");
    }
  }

  if (!cfg) return null;
  if (cfg.paypal.mode !== "sandbox") {
    return (
      <div className="paypal-box">
        <div className="sim-pay">
          <p>Test mode: this server has no PayPal sandbox keys yet, so the hold is simulated with the same order and authorization steps PayPal uses.</p>
          <button className="btn held" onClick={simulate} disabled={state === "busy"}>
            {state === "busy" ? "Placing hold…" : `Hold ${money(c.totalCents, c.currency)}`}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="paypal-box">
      {state === "error" && <p className="faint">Couldn't load PayPal ({err}). Check your network and refresh.</p>}
      {state === "busy" && <p className="faint">Authorizing with PayPal…</p>}
      <div ref={ref} />
      <p className="faint">You'll approve in a PayPal sandbox window. This creates an authorization: the money is held on your account and only captured as milestones are verified.</p>
    </div>
  );
}
