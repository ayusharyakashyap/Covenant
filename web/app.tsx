import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api.ts";
import { Mark } from "./components/Guilloche.tsx";
import { Home } from "./pages/Home.tsx";
import { ContractPage } from "./pages/ContractPage.tsx";
import type { PublicConfig } from "../shared/types.ts";

// ---- tiny router
export function navigate(to: string) {
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0 });
}
export function Link({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
function usePath() {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const on = () => setPath(location.pathname + location.search);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}

// ---- toasts
type Toast = { text: string; err?: boolean } | null;
const ToastCtx = createContext<(text: string, err?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export const ConfigCtx = createContext<PublicConfig | null>(null);

export function App() {
  const path = usePath();
  const [toast, setToast] = useState<Toast>(null);
  const [cfg, setCfg] = useState<PublicConfig | null>(null);

  useEffect(() => {
    api.config().then(setCfg).catch(() => setCfg({ paypal: { mode: "simulated", currency: "USD" }, ai: { engine: "offline" } }));
  }, []);

  const show = useCallback((text: string, err = false) => {
    setToast({ text, err });
    window.clearTimeout((show as any)._t);
    (show as any)._t = window.setTimeout(() => setToast(null), err ? 7000 : 3800);
  }, []);

  const m = path.match(/^\/c\/([^/?]+)/);
  return (
    <ConfigCtx.Provider value={cfg}>
      <ToastCtx.Provider value={show}>
        <div className="shell">
          <header className="topbar">
            <Link to="/" className="wordmark">
              <Mark />
              Covenant
            </Link>
            {cfg && (
              <div className="modes" aria-label="Integration status">
                <span className={`mode ${cfg.paypal.mode === "simulated" ? "sim" : ""}`} title={cfg.paypal.mode === "simulated" ? "No PayPal keys configured; money movements are simulated" : "Connected to the PayPal sandbox"}>
                  PayPal <b>{cfg.paypal.mode === "sandbox" ? "sandbox" : "simulated"}</b>
                </span>
                <span className={`mode ${cfg.ai.engine === "offline" ? "sim" : ""}`} title={cfg.ai.engine === "offline" ? "No Anthropic key configured; using transparent rules" : `Using ${cfg.ai.model}`}>
                  {cfg.ai.engine === "claude" ? (
                    <>
                      Claude <b>{cfg.ai.model?.replace(/^claude-/, "")}</b>
                    </>
                  ) : (
                    <>
                      AI <b>offline rules</b>
                    </>
                  )}
                </span>
              </div>
            )}
          </header>
          {m ? <ContractPage id={m[1]} key={m[1]} /> : <Home />}
          <footer className="foot">
            <span>Covenant holds money with PayPal authorizations and releases it when Claude verifies the work.</span>
            <span>Sandbox prototype. No real money moves.</span>
          </footer>
        </div>
        {toast && (
          <div className={`toast ${toast.err ? "err" : ""}`} role="status" aria-live="polite">
            {toast.text}
          </div>
        )}
      </ToastCtx.Provider>
    </ConfigCtx.Provider>
  );
}
