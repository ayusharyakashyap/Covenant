// Generates postman/Covenant.postman_collection.json — the full lifecycle as a runnable API test suite.
import { writeFileSync } from "node:fs";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const json = (o) => ({ mode: "raw", raw: JSON.stringify(o, null, 2), options: { raw: { language: "json" } } });
const key = (v) => [{ key: "Content-Type", value: "application/json" }, ...(v ? [{ key: "x-covenant-key", value: `{{${v}}}` }] : [])];
const test = (lines) => [{ listen: "test", script: { type: "text/javascript", exec: ["pm.test('responds 200', () => pm.response.to.have.status(200));", "const r = pm.response.json();", ...lines] } }];
const req = (name, method, path, { k, body, tests = [], description } = {}) => ({
  name,
  event: test(tests),
  request: { method, header: key(k), url: { raw: `{{baseUrl}}${path}`, host: ["{{baseUrl}}"], path: path.split("/").filter(Boolean) }, ...(body ? { body: json(body) } : {}), description },
});
const collection = {
  info: {
    name: "Covenant — PayPal escrow contracts API",
    description:
      "Runs a whole Covenant contract end to end: compile a plain-English deal, sign, fund with a PayPal authorization, submit evidence, verify, capture and pay out.\n\nRun the folder with the Collection Runner. With PayPal keys configured on the server, open the `approveUrl` logged by **Create PayPal order** in a browser and approve as your sandbox buyer before **Authorize** runs (add a delay, or run step by step). Without keys the server's simulator authorizes immediately.",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [{ key: "baseUrl", value: "http://localhost:8787" }, { key: "contractId", value: "" }, { key: "payerKey", value: "" }, { key: "payeeKey", value: "" }, { key: "milestoneId", value: "" }, { key: "orderId", value: "" }],
  item: [
    req("Health", "GET", "/api/health", { tests: ["pm.test('reports integrations', () => pm.expect(r).to.have.keys('ok','paypal','ai'));"] }),
    req("Compile a deal", "POST", "/api/compile", {
      body: { text: "Pay Maya (maya.designs@example.com) $600 for a bakery logo: $200 when she shows 3 distinct concepts, $400 when the final logo is delivered as SVG and PNG files by Dec 20. 10% off per day late, up to 50%." },
      tests: [
        "pm.collectionVariables.set('contractId', r.contract.id);",
        "pm.collectionVariables.set('payerKey', r.keys.payer);",
        "pm.collectionVariables.set('payeeKey', r.keys.payee);",
        "pm.collectionVariables.set('milestoneId', r.contract.milestones[0].id);",
        "pm.test('compiled milestones add up to the total', () => pm.expect(r.contract.milestones.reduce((a, m) => a + m.amountCents, 0)).to.eql(r.contract.totalCents));",
      ],
      description: "Claude (or the offline rules engine) compiles the sentence into milestones, conditions, deadlines and penalties.",
    }),
    req("Sign as client", "POST", "/api/contracts/{{contractId}}/sign", { k: "payerKey", body: {}, tests: ["pm.test('client signed', () => pm.expect(r.contract.signatures).to.have.property('payer'));"] }),
    req("Freelancer adds payout email", "POST", "/api/contracts/{{contractId}}/draft", { k: "payeeKey", body: { payee: { email: "maya.designs@example.com" } } }),
    req("Sign as client again (edits reset signatures)", "POST", "/api/contracts/{{contractId}}/sign", { k: "payerKey", body: {} }),
    req("Sign as freelancer", "POST", "/api/contracts/{{contractId}}/sign", { k: "payeeKey", body: {}, tests: ["pm.test('ready to fund', () => pm.expect(r.contract.status).to.eql('awaiting_funding'));"] }),
    req("Create PayPal order (intent AUTHORIZE)", "POST", "/api/contracts/{{contractId}}/paypal/order", {
      k: "payerKey",
      body: {},
      tests: ["pm.collectionVariables.set('orderId', r.orderId);", "if (r.approveUrl) console.log('Approve as the sandbox buyer:', r.approveUrl);"],
    }),
    req("Authorize order (hold funds)", "POST", "/api/contracts/{{contractId}}/paypal/authorize", {
      k: "payerKey",
      body: { orderId: "{{orderId}}" },
      tests: ["pm.test('funds held', () => pm.expect(r.contract.status).to.eql('active'));", "pm.test('ledger has the authorization', () => pm.expect(r.contract.ledger[0].type).to.eql('authorization'));"],
    }),
    req("Freelancer submits evidence", "POST", "/api/contracts/{{contractId}}/milestones/{{milestoneId}}/evidence", {
      k: "payeeKey",
      body: { note: "Three concepts attached.", files: [1, 2, 3].map((i) => ({ name: `concept-${i}.png`, mime: "image/png", dataBase64: PNG })) },
      tests: ["const m = r.contract.milestones.find((x) => x.id === pm.collectionVariables.get('milestoneId'));", "pm.test('verifier produced a verdict', () => pm.expect(m.verdict).to.be.an('object'));", "console.log('Verdict:', m.verdict.outcome, '-', m.verdict.summary);"],
    }),
    req("Client approves (if held for review)", "POST", "/api/contracts/{{contractId}}/milestones/{{milestoneId}}/review", {
      k: "payerKey",
      body: { decision: "approve" },
      tests: ["const m = r.contract.milestones.find((x) => x.id === pm.collectionVariables.get('milestoneId'));", "pm.test('milestone paid', () => pm.expect(m.status).to.eql('released'));", "pm.test('capture and payout recorded', () => pm.expect(r.contract.ledger.map((l) => l.type)).to.include.members(['capture', 'payout']));"],
    }),
    req("Read contract", "GET", "/api/contracts/{{contractId}}", { k: "payeeKey", tests: ["pm.test('tokens never leak', () => pm.expect(r.contract).to.not.have.property('tokens'));"] }),
    req("Ask about your money", "POST", "/api/portfolio/ask", { body: { question: "How much has been paid and how much is still held?", pairs: [{ id: "{{contractId}}", key: "{{payerKey}}" }] }, tests: ["pm.test('answers with a grid view', () => pm.expect(r.view.columns).to.be.an('array'));", "console.log(r.answer);"] }),
    req("Permission check: freelancer can't fund", "POST", "/api/contracts/{{contractId}}/paypal/order", { k: "payeeKey", body: {} }),
  ],
};
// With Claude, good work is paid automatically, so approval may correctly answer 409 (nothing to review).
const approve = collection.item.find((i) => i.name.startsWith("Client approves"));
approve.event[0].script.exec = [
  "pm.test('approved, or already paid automatically', () => pm.expect(pm.response.code).to.be.oneOf([200, 409]));",
  "if (pm.response.code === 200) { const r = pm.response.json(); const m = r.contract.milestones.find((x) => x.id === pm.collectionVariables.get('milestoneId')); pm.test('milestone paid', () => pm.expect(m.status).to.eql('released')); }",
];
// The last request is expected to fail with 403/409.
collection.item.at(-1).event[0].script.exec = ["pm.test('refused', () => pm.expect(pm.response.code).to.be.oneOf([403, 409]));"];
writeFileSync("postman/Covenant.postman_collection.json", JSON.stringify(collection, null, 2));
console.log(`wrote ${collection.item.length} requests`);
