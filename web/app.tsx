import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api.ts";
import { Mark } from "./components/Guilloche.tsx";
import { Home } from "./pages/Home.tsx";
import { ContractPage } from "./pages/ContractPage.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Join } from "./pages/Join.tsx";
import { Status, Samples } from "./pages/Status.tsx";
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
    api.config().then(setCfg).catch(() => setCfg({ paypal: { mode: "simulated", currency: "USD" }, ai: { engine: "offline" }, kernel: false, demoTools: false, webhooks: false }));
  }, []);

  const show = useCallback((text: string, err = false) => {
    setToast({ text, err });
    window.clearTimeout((show as any)._t);
    (show as any)._t = window.setTimeout(() => setToast(null), err ? 7000 : 3800);
  }, []);

  const m = path.match(/^\/c\/([^/?#]+)/);
  const join = path.match(/^\/join\/([^/?#]+)/);
  const page = m ? (
    <ContractPage id={m[1]} key={m[1]} />
  ) : join ? (
    <Join id={join[1]} key={join[1]} />
  ) : path.startsWith("/money") ? (
    <Dashboard />
  ) : path.startsWith("/status") ? (
    <Status />
  ) : path.startsWith("/samples") ? (
    <Samples />
  ) : (
    <Home />
  );
  return (
    <ConfigCtx.Provider value={cfg}>
      <ToastCtx.Provider value={show}>
        <div className="shell">
          <header className="topbar">
            <Link to="/" className="wordmark">
              <Mark />
              Covenant
            </Link>
            <nav className="nav" aria-label="Main">
              <Link to="/" className={path === "/" ? "on" : ""}>New contract</Link>
              <Link to="/money" className={path.startsWith("/money") ? "on" : ""}>Money</Link>
            </nav>
          </header>
          {page}
          <footer className="foot">
            <span>Covenant holds money with PayPal authorizations and releases it when the work is verified.</span>
            <span className="foot-links">
              {cfg && cfg.paypal.mode === "simulated" && <span className="testmode">Test mode: payments are simulated until PayPal sandbox keys are added.</span>}
              <Link to="/samples">Sample files</Link>
              <Link to="/status">System status</Link>
            </span>
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
