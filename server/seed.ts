// Sample portfolio for the dashboard: realistic contracts in every state, generated through the
// real engine but with the PayPal simulator and rules engine, so it costs nothing and is labelled SIM-.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { simulation } from "./config.ts";
import { store } from "./store.ts";
import * as e from "./engine.ts";
import { drain } from "./jobs.ts";

const DEMO = resolve(process.cwd(), "public/demo");
const file = (name: string, mime: string) => ({ name, mime, dataBase64: readFileSync(resolve(DEMO, name)).toString("base64") });
const daysAgo = (d: number) => new Date(Date.now() - d * 864e5).toISOString();

const keys = new Map<string, { payer: string; payee: string }>();

async function created(text: string, payeeEmail: string, payerName: string) {
  const r = await e.createContract(text, { payee: { email: payeeEmail }, payer: { name: payerName } });
  const j = await e.claimInvite(r.contract.id, r.inviteCode);
  keys.set(r.contract.id, { payer: r.payerKey, payee: j.payeeKey });
  return j.contract;
}

async function funded(text: string, payeeEmail: string, payerName: string) {
  let c = await created(text, payeeEmail, payerName);
  c = await e.sign(c.id, "payer");
  c = await e.sign(c.id, "payee");
  const { orderId } = await e.createOrder(c.id, "payer");
  return e.authorizeOrder(c.id, "payer", orderId);
}

function backdate(id: string, mutate: (c: ReturnType<typeof store.get> & object) => void) {
  const c = store.get(id)!;
  mutate(c);
  store.save(c);
}

export async function seedDemo() {
  return simulation.run(true, async () => {
    const out: { id: string; keys: { payer: string; payee: string } }[] = [];
    const keep = (c: { id: string }) => out.push({ id: c.id, keys: keys.get(c.id)! });

    // 1. Logo: concepts paid, final files delivered two days late → penalty
    let c = await funded("Pay Maya $600 for a bakery logo: $200 when she shows 3 distinct concepts, $400 when the final logo is delivered as SVG and PNG files by Dec 20. 10% off per day late, up to 50%.", "maya@example.com", "Brightside Bakery");
    c = await e.submitEvidence(c.id, "payee", c.milestones[0].id, { files: ["concept-1.png", "concept-2.png", "concept-3.png"].map((n) => file(n, "image/png")) });
    await drain();
    c = await e.review(c.id, "payer", c.milestones[0].id, "approve");
    backdate(c.id, (x) => (x.milestones[1].deadline = daysAgo(1.9)));
    c = await e.submitEvidence(c.id, "payee", c.milestones[1].id, { files: [file("brightside-final.svg", "image/svg+xml"), file("brightside-final.png", "image/png")] });
    await drain();
    c = await e.review(c.id, "payer", c.milestones[1].id, "approve");
    keep(c);

    // 2. Website: design approved, site milestone still held, PR milestone open
    c = await funded("Hire Priya to build the Brightside website for $1,200: $300 when the homepage design is approved, $600 when the site is live at a public URL, and $300 when the GitHub pull request adding online ordering is merged by November 30.", "priya@example.com", "Brightside Bakery");
    c = await e.submitEvidence(c.id, "payee", c.milestones[0].id, { files: [file("concept-3.png", "image/png")], note: "Homepage design attached." });
    await drain();
    c = await e.review(c.id, "payer", c.milestones[0].id, "approve");
    keep(c);

    // 3. Translation: disputed, split by the arbiter
    c = await funded("Pay Tomás $180 to translate our 4-page onboarding guide into Spanish, delivered as a PDF by Nov 15.", "tomas@example.com", "Northwind Staffing");
    c = await e.submitEvidence(c.id, "payee", c.milestones[0].id, { files: [file("concept-1.png", "image/png")], note: "Sent the guide earlier by email." });
    await drain();
    c = await e.openDispute(c.id, "payee", c.milestones[0].id, "I translated the whole guide but uploaded the wrong file before the deadline.");
    c = await e.addStatement(c.id, "payer", c.milestones[0].id, "No PDF was ever delivered through Covenant.");
    c = await e.resolveDispute(c.id, "payer", c.milestones[0].id);
    keep(c);

    // 4. Agent-to-agent data job: paid
    c = await funded("Our research agent pays the data-cleaning agent $40 once it delivers a CSV file with the cleaned rows and a short written report of what was removed.", "data-agent@example.com", "Research Agent");
    c = await e.submitEvidence(c.id, "payee", c.milestones[0].id, {
      files: [{ name: "customers-clean.csv", mime: "text/csv", dataBase64: Buffer.from("id,email\n" + Array.from({ length: 520 }, (_, i) => `${i},c${i}@example.com`).join("\n")).toString("base64") }],
      note: "Removed 612 exact duplicates and 41 invalid emails; 520 unique customers remain.",
    });
    await drain();
    c = await e.review(c.id, "payer", c.milestones[0].id, "approve");
    keep(c);

    // 5. Photography: funded, nothing delivered yet, deadline passed → reclaimed
    c = await funded("Pay Lena $250 for 10 edited product photos delivered as images by Nov 3.", "lena@example.com", "Brightside Bakery");
    backdate(c.id, (x) => (x.milestones[0].deadline = daysAgo(3.9)));
    c = await e.reclaim(c.id, "payer", c.milestones[0].id);
    keep(c);

    // 6. Copywriting: waiting for the freelancer to sign
    c = await created("Pay Sam $320 to write 4 blog posts of at least 800 words about sourdough, $80 per post, delivered as text.", "sam@example.com", "Brightside Bakery");
    c = await e.sign(c.id, "payer");
    keep(c);

    return out;
  });
}
