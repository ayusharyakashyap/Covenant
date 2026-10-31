// AG Grid Community loaded from its official CDN, themed to Covenant's palette.
import { loadFirst, vendorUrls } from "../api.ts";

export const AG_GRID_SRC = vendorUrls("ag-grid-community", "34.3.1", "dist/ag-grid-community.min.js");

declare global {
  interface Window {
    agGrid?: any;
  }
}

export async function loadAgGrid(): Promise<any> {
  await loadFirst(AG_GRID_SRC);
  if (!window.agGrid?.createGrid) throw new Error("AG Grid unavailable");
  return window.agGrid;
}

export function covenantTheme(ag: any) {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light";
  return ag.themeQuartz?.withParams?.({
    fontFamily: "Archivo, system-ui, sans-serif",
    headerFontWeight: 600,
    accentColor: dark ? "#e0ad4f" : "#a8761b",
    backgroundColor: dark ? "#16203a" : "#f7f8f5",
    foregroundColor: dark ? "#e6eaf2" : "#16233f",
    borderColor: dark ? "#2b3754" : "#c3cdc6",
    headerBackgroundColor: dark ? "#0b1222" : "#e2e7e1",
    oddRowBackgroundColor: dark ? "#131c33" : "#f2f4f0",
    wrapperBorderRadius: 12,
    fontSize: 13.5,
  });
}

/** Convert the Ask assistant's filter list into an AG Grid filter model. */
export function toFilterModel(filters: { field: string; op: string; value?: string | number }[]) {
  const model: Record<string, unknown> = {};
  for (const f of filters) {
    const numeric = typeof f.value === "number" || ["greaterThan", "lessThan"].includes(f.op);
    if (f.op === "isTrue" || f.op === "isFalse") {
      model[f.field] = { filterType: "text", type: "equals", filter: f.op === "isTrue" ? "true" : "false" };
    } else if (numeric) {
      model[f.field] = { filterType: "number", type: f.op === "notEqual" ? "notEqual" : f.op, filter: Number(f.value) };
    } else if (f.op === "notEqual" && (f.value === "" || f.value === undefined)) {
      model[f.field] = { filterType: "text", type: "notBlank" };
    } else {
      model[f.field] = { filterType: "text", type: f.op, filter: String(f.value ?? "") };
    }
  }
  return model;
}
