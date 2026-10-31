// Shared domain model for Covenant. All money is stored in integer cents.

export type Role = "payer" | "payee";

export type ContractStatus =
  | "draft" // compiled, not yet signed by both parties
  | "awaiting_funding" // both signed, waiting for the payer's PayPal authorization
  | "active" // funds held on PayPal, milestones in progress
  | "completed" // every milestone settled
  | "cancelled";

export type MilestoneStatus =
  | "open" // waiting for evidence
  | "verifying" // AI verifier running
  | "needs_review" // verifier unsure, payer must decide
  | "rejected" // verifier says conditions not met, payee may resubmit or dispute
  | "disputed" // arbiter case open
  | "released" // money captured and paid out (fully or partially)
  | "refunded"; // money returned to payer (released hold)

export type ConditionKind = "image" | "file" | "link" | "github_pr" | "text" | "approval";

export interface Party {
  name: string;
  email: string; // PayPal email used for payouts (payee) or contact (payer)
}

export interface Condition {
  id: string;
  text: string; // human readable condition, e.g. "At least 3 distinct logo concepts"
  kind: ConditionKind; // what kind of evidence satisfies it
}

export interface LatePenalty {
  percentPerDay: number; // e.g. 10 = 10% per day late
  maxPercent: number; // cap, e.g. 50
}

export interface EvidenceItem {
  id: string;
  kind: "image" | "file" | "link" | "text";
  name: string;
  mime?: string;
  size?: number;
  url?: string; // link evidence, or /uploads/... for stored files
  storedPath?: string; // server-side path for uploaded files
  excerpt?: string; // extracted text or fetched page summary
  facts?: Record<string, unknown>; // machine-verified facts (e.g. GitHub PR merged=true)
}

export interface Submission {
  id: string;
  at: string;
  note: string;
  items: EvidenceItem[];
  pendingLinks?: string[]; // fetched by the background verifier
}

export type Engine = "claude" | "gemini" | "offline";

export interface ConditionFinding {
  conditionId: string;
  met: boolean;
  confidence: number; // 0..1
  reasoning: string;
  evidenceIds: string[];
}

export interface Verdict {
  at: string;
  engine: Engine;
  model?: string;
  outcome: "pass" | "fail" | "uncertain";
  confidence: number;
  findings: ConditionFinding[];
  summary: string;
}

export interface Ruling {
  at: string;
  engine: Engine;
  model?: string;
  payeePercent: number; // 0..100 share of the milestone released to the payee
  reasoning: string;
  citations: string[]; // clauses / evidence relied on
}

export interface Dispute {
  openedBy: Role;
  openedAt: string;
  reason: string;
  statements: { role: Role; text: string; at: string }[];
  ruling?: Ruling;
}

export interface Settlement {
  grossCents: number; // milestone amount
  penaltyCents: number; // withheld due to lateness
  arbiterAdjustCents: number; // withheld due to a ruling
  netCents: number; // paid to the payee
  daysLate: number;
  captureId?: string;
  payoutBatchId?: string;
  payoutStatus?: string;
}

export interface Milestone {
  id: string;
  index: number;
  title: string;
  amountCents: number;
  deadline?: string; // ISO date-time
  conditions: Condition[];
  latePenalty?: LatePenalty;
  status: MilestoneStatus;
  submissions: Submission[];
  verdict?: Verdict;
  dispute?: Dispute;
  settlement?: Settlement;
}

export type Actor = "payer" | "payee" | "ai" | "paypal" | "system";

export interface ContractEvent {
  id: string;
  at: string;
  actor: Actor;
  type: string;
  message: string;
  milestoneId?: string;
}

export type LedgerType = "authorization" | "capture" | "payout" | "refund" | "void" | "penalty" | "reauthorization";

export interface LedgerEntry {
  id: string;
  at: string;
  type: LedgerType;
  amountCents: number;
  currency: string;
  status: string;
  reference: string; // PayPal object id
  milestoneId?: string;
  note: string;
  simulated: boolean;
}

export interface Funding {
  orderId: string;
  authorizationId?: string;
  authorizedCents: number;
  capturedCents: number;
  status: "created" | "authorized" | "partially_captured" | "captured" | "voided";
  authorizedAt?: string;
  honorUntil?: string; // PayPal guarantees funds for 3 days
  expiresAt?: string; // authorization valid for 29 days
  payerPaypalEmail?: string;
  simulated: boolean;
}

export interface Contract {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  sourceText: string;
  summary: string; // plain-English restatement both parties sign
  currency: string;
  totalCents: number;
  payer: Party;
  payee: Party;
  milestones: Milestone[];
  ambiguities: string[]; // things the compiler could not pin down
  risks: string[];
  status: ContractStatus;
  signatures: Partial<Record<Role, string>>;
  funding?: Funding;
  events: ContractEvent[];
  ledger: LedgerEntry[];
  compiledBy: { engine: Engine; model?: string };
  autoReleaseThreshold: number; // verifier confidence required to release without a human
  // Hashes only. Raw keys are shown once to their owner and never stored.
  access: { payerHash: string; payeeHash?: string; inviteHash?: string; inviteCreatedAt?: string; joinedAt?: string };
  origin?: "web" | "mcp";
}

export interface PublicConfig {
  paypal: { mode: "sandbox" | "simulated"; clientId?: string; currency: string };
  ai: { engine: Engine; model?: string };
  kernel: boolean;
  agStudioLicense?: string;
  demoTools: boolean;
  webhooks: boolean;
}

/** Human-readable name of the engine that made a decision. */
export const engineLabel = (e: Engine | undefined) => (e === "gemini" ? "Gemini" : e === "claude" ? "Claude" : "Rules engine");
